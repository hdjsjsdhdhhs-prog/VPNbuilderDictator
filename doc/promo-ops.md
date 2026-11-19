# Промокоды, бесплатные тарифы и операционные уведомления

Две связанные возможности, добавленные миграцией `053_promo_ops`:

* **Промокоды и скидки** — админ создаёт коды в браузерной админке (раздел
  «Промокоды»), клиент активирует код в боте, скидка снижает сумму следующей
  покупки. Тариф с ценой 0 или покупка со скидкой 100 % выдаются без платёжного
  провайдера.
* **Операционные уведомления** — лента событий инфраструктуры (серверы, страны,
  сборки, источники) и ежедневный отчёт: раздел «События» в админке и
  сообщения в Telegram.

Документ описывает только то, что реализовано в коде. Источник истины — код,
ссылки на него даны в каждом разделе.

## 1. Архитектура

```
Бот: «🎟 Промокод» / /promo CODE / кнопка прогрева apply_discount
   ──► bot/promo.go ──► OrderService.ActivatePromo / ActivateCoupon ──► user_discounts
Покупка в боте
   ──► OrderService.RequestPayment: цена каталога − лучшая скидка клиента
         ├─ сумма > 0 ──► pending-заказ на сниженную сумму (+ order_discounts) ──► Platega
         └─ сумма = 0 ──► ErrNothingToPay ──► OrderService.ActivateFree (provider = free)
Подтверждение оплаты ──► ConfirmOrderPaidCAS ──► redeemOrderDiscount (скидка погашена)

netmon (outages, Overview), provider_sources (только чтение)
   ──► scheduler.OpsWorker (тик 1 мин + пробуждение после каждого круга монитора) ──► service.OpsService.Tick
         outages → builders → sources → report → deliver → prune
   ──► ops_events / ops_states ──► OpsTelegramSender ──► Telegram Bot API

Admin UI (frontend/admin/src/ops-ui.ts, ops.ts)
   ──► /admin/api/promos…, /admin/api/ops… (internal/web/admin_promo_ops_api.go, adminauth)
   ──► service.PromoService / service.OpsService ──► database (promo.go, ops.go)
```

| Слой | Файлы |
| --- | --- |
| Схема и seed | `internal/database/migrations/053_promo_ops.{up,down}.sql` |
| БД | `internal/database/promo.go`, `ops.go` |
| Сервис | `internal/service/promo.go`, `ops.go`, `ops_sender.go`; правки в `order.go` |
| Воркер | `internal/scheduler/ops_worker.go` |
| Бот | `internal/bot/promo.go`; маршруты в `handler.go`, `callback.go`, `keyboard_builder.go` |
| Admin API | `internal/web/admin_promo_ops_api.go` |
| Admin UI | `frontend/admin/src/ops-ui.ts`, `ops.ts`, стили в `style.css` |
| Подключение | `cmd/bot/lifecycle.go`: `NewOpsService`, `NewOpsTelegramSender`; `cmd/bot/main.go`: `SetPromoService`, `SetOpsService`, `NewOpsWorker` |

## 2. Таблицы (миграция 053)

| Таблица | Назначение |
| --- | --- |
| `promo_codes` | коды админа: `percent` 1–100, `max_activations` (0 = без лимита), `valid_hours` (сколько живёт активированная скидка, 1–8760), `expires_at` (до какого момента код можно активировать), `enabled`, `version`; `code` уникален |
| `user_discounts` | скидка, активированная пользователем: `source` = `promo` или `warmup`; промокод активируется не более одного раза на пользователя, купон прогрева — не более одного раза |
| `order_discounts` | скидка, с которой создан заказ (одна строка на заказ): процент и цена каталога до скидки. Отдельная таблица, чтобы схема `orders` не менялась |
| `ops_settings` | одна строка (`id = 1`): куда и какие уведомления отправлять, час отчёта, `baseline_at`, `version` |
| `ops_events` | append-only лента событий; `dedup_key` уникален; `notify_status` = `pending` / `sent` / `failed` / `skipped` |
| `ops_states` | последнее известное состояние объекта — чтобы сообщать только о переходах |

Миграция также добавляет сценарий прогрева `trial_ended_discount` («Скидка после
пробника») — **выключенным**. Его кнопка использует действие `apply_discount`.

`orders.amount_cents` остаётся суммой к оплате. Заказ без оплаты имеет сумму 0
и `payment_provider = 'free'` (`database.FreeProvider`).

## 3. Промокоды и скидки

### Активация (бот)

* Код вводится после кнопки «🎟 Промокод» (бот ждёт код 10 минут,
  `promoPromptTTL`) или командой `/promo CODE`. Код нормализуется: обрезка
  пробелов и верхний регистр (`NormalizePromoCode`).
* Тем же вводом активируется личный купон прогрева; кнопка сообщения прогрева
  (`apply_discount`) активирует его одним нажатием (`ActivateCoupon`).
* Отказы — sentinel-ошибки `database.ErrPromo*` (`NotFound`, `Disabled`,
  `Expired`, `Exhausted`, `AlreadyUsed`); текст для клиента подбирает
  `promoErrorText`.

### Цена для клиента

* Действует лучшая непогашенная и непросроченная скидка: наибольший процент,
  при равенстве — истекающая раньше (`ActiveUserDiscount`).
* `DiscountedAmount` округляет скидку вниз. Если на маленькой цене скидка
  округлилась до нуля, она не применяется и не расходуется.
* Сбой чтения скидки не блокирует покупку: клиенту называется цена каталога,
  сбой логируется (`payableAmount`).

### Заказ и оплата (`OrderService.requestPayment`)

* Pending-заказ создаётся на сниженную сумму, скидка записывается в
  `order_discounts` (`SetOrderDiscount`, идемпотентно).
* Pending-заказ на другую сумму (скидка появилась или израсходована)
  переводится в `expired` и заменяется новым (`ExpirePendingPaymentOrder`).
  Срок жизни ссылки провайдера не меняется; заказ с неопределённым исходом
  создания платежа не освобождается.
* Скидка гасится в той же транзакции, что подтверждает оплату
  (`ConfirmOrderPaidCAS` → `redeemOrderDiscount`).

### Выдача без оплаты (`OrderService.ActivateFree`)

Когда платить нечего, `RequestPayment` возвращает `ErrNothingToPay`, а тариф
выдаёт `ActivateFree` → `ActivateFreeOrder` (одна транзакция, тот же CAS, что и
у платного заказа):

* **бесплатный тариф** (цена 0) — скидка не расходуется. Отказ, пока тот же
  тариф ещё действует (`ErrFreeTariffActive`) и пока активен платный срок
  (`ErrFreeTariffHasPaid`);
* **платный тариф со скидкой 100 %** — скидка гасится;
* всё остальное — `ErrFreeActivationUnavailable`.

Это пользовательская операция: любая ошибка возвращается вызывающему. Если у
клиента нет активной подписки, она создаётся, как при оплате. После выдачи
сбрасываются кэши карточки и `/sub`, админ получает то же уведомление, что и
при покупке.

### Админка: «Промокоды»

| Метод | Маршрут | Действие |
| --- | --- | --- |
| `GET` | `/admin/api/promos` | список; `state` = `active` / `disabled` / `expired` / `exhausted` |
| `POST` | `/admin/api/promos` | создать (`request_key`) |
| `PATCH` | `/admin/api/promos/{id}` | лимиты, срок, заметка, `enabled` (`request_key`, `version`) |
| `DELETE` | `/admin/api/promos/{id}` | удалить код без активаций (`request_key`, `version`) |

Код и процент после создания не меняются. Ошибки: `400 invalid_promo` (с именем
поля), `404 not_found`, `409 promo_code_taken`, `409 version_conflict`,
`409 promo_in_use`, `409 request_key_conflict`. Все изменения проходят аудит
(`promo_created`, `promo_updated`, `promo_deleted`) и идемпотентны по
`(actor, request_key)`.

## 4. Операционные уведомления

### Проход воркера (`OpsService.Tick`)

`scheduler.OpsWorker` запускает проход раз в минуту (первый — через 45 секунд
после старта, бюджет прохода 50 секунд) и сразу после каждого завершённого круга
сетевого монитора: монитор вызывает `OpsService.RequestTick`
(`netmon.SetAfterRound` в `cmd/bot/lifecycle.go`), поэтому сообщение о
недоступном сервере уходит, как только монитор подтвердил сбой, а не по таймеру.
Запросы на пробуждение склеиваются. Шаги независимы: сбой одного попадает
в общую ошибку и не останавливает остальные.

1. **outages** — сбои сетевого монитора превращаются в события: одно при
   открытии, одно при завершении. Глубина — 48 часов, но не раньше
   `baseline_at`, поэтому история до миграции не порождает уведомлений.
2. **builders** — сборка (Subscription Builder; в текстах уведомлений и в
   админке — «сборка») полностью недоступна, восстановлена, отключена; её
   источники не загружаются; монитор не делал проверок 10 интервалов подряд.
3. **sources** — источник истекает в ближайшие 72 часа, истёк, отключён, снова
   в работе. Первое наблюдение источника молчит, если он не требует внимания.
4. **report** — после `daily_report_hour` (московское время) записывается отчёт
   за предыдущий день; `last_report_day` гарантирует не более одного отчёта.
5. **deliver** — отправка событий `pending`: инфраструктурные группируются до
   15 в одном сообщении, отчёт — отдельным сообщением. После 5 неудачных
   попыток событие получает `failed`.
6. **prune** — раз в час удаляются события старше 90 дней.

Всё это — best-effort фоновая работа: сбой логируется (`Warn`), следующий проход
повторяет. На подписки, платежи и `/sub` она не влияет.

### Виды событий (`ops_events.kind`)

| Группа | Виды | Выключатель |
| --- | --- | --- |
| Серверы | `server_down`, `server_up`, `server_removed`, `monitor_stalled`, `monitor_recovered` | `notify_servers` |
| Страны и сборки | `country_down`, `country_degraded`, `country_up`, `country_removed`, `builder_down`, `builder_up`, `builder_disabled` | `notify_countries` |
| Источники | `source_failing`, `source_recovered`, `source_expiring`, `source_expired`, `source_disabled` | `notify_sources` |
| Ежедневный отчёт | `daily_report` | `daily_report` |
| Проверка из панели | `test` | — (отправляется сразу) |

Вид `builder_degraded` объявлен в `database/ops.go`, но сервис его не создаёт:
частичные сбои сборки сообщаются по странам.

Важность: `ok`, `info`, `warning`, `critical`. Событие выключенной группы всё
равно попадает в ленту, но со статусом `skipped`. Если уведомления выключены
целиком или адресата нет, ожидающие события снимаются с отправки и остаются в
ленте.

### Доставка

* Адресат — `ops_settings.chat_id`; `0` означает `TELEGRAM_ADMIN_ID`.
* Пустой `bot_token` — отправка через основного бота. С токеном отдельного бота
  сообщение уходит прямым вызовом Bot API (`OpsTelegramSender.sendDirect`).
* Токен хранится в `ops_settings.bot_token`, API его никогда не возвращает
  (только признак `own_bot`), в журнал аудита он не попадает (в хэше запроса
  участвует только его дайджест), из текста ошибок отправки он вырезается.
* События не содержат URL и учётных данных провайдера — только имена, страны,
  протокол и `host:port`.

### Админка: «События»

| Метод | Маршрут | Действие |
| --- | --- | --- |
| `GET` | `/admin/api/ops` | настройки |
| `PUT` | `/admin/api/ops` | сохранить (`request_key`, `version`); `bot_token: null` сохраняет токен, `""` возвращает основного бота |
| `GET` | `/admin/api/ops/events` | лента: `severity`, `kind`, `limit`, `offset` |
| `GET` | `/admin/api/ops/report` | предпросмотр отчёта: `day=today` или `yesterday` |
| `POST` | `/admin/api/ops/test` | отправить тестовое сообщение сейчас |

Ошибки: `400 invalid_ops_settings`, `400 invalid_request`,
`409 version_conflict`, `409 request_key_conflict`, `409 ops_not_configured`
(нет адресата), `502 ops_send_failed` (Telegram отклонил тестовое сообщение).
Без подключённого сервиса маршруты отвечают `503 service_unavailable`.

## 5. Тесты

| Область | Файлы |
| --- | --- |
| БД | `internal/database/promo_test.go`, `ops_test.go`, `migration_test.go` |
| Сервис | `internal/service/promo_test.go`, `ops_test.go` |
| Бот | `internal/bot/payment_handler_test.go` |
| Admin API | `internal/web/admin_promo_ops_api_test.go` |
| Admin UI | `frontend/tests/admin-ops.test.ts`, `frontend/admin/browser/ops.spec.ts` |

У `internal/scheduler/ops_worker.go` отдельного теста нет.
