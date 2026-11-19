import { test, expect } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

// Promo codes ("Промокоды") and events ("События") in a real browser against
// a mock backend that follows the contract of web.adminAPI.routePromos /
// routeOps (internal/web/admin_promo_ops_api.go):
//   GET/POST /admin/api/promos, PATCH/DELETE /admin/api/promos/{id}
//   GET/PUT  /admin/api/ops, GET /ops/events, GET /ops/report, POST /ops/test
// Every write must carry the CSRF token and a request_key; the bot token is
// write-only and must never come back to the page.

const CSRF = 'c'.repeat(43);
const T0 = '2026-11-10T09:00:00Z';
const TOKEN = '123456789:AAEabcdefghijklmnopqrstuvwxyz0123456';

type Json = Record<string, unknown>;

const promo = (over: Json): Json => ({
  id: 1, code: 'WELCOME20', percent: 20, max_activations: 100, activations: 30, valid_hours: 72, expires_at: null, enabled: true,
  note: 'Канал', version: 1, created_at: T0, updated_at: T0, redeemed: 12, state: 'active', ...over,
});

const STATS: Json = {
  from: '2026-11-11T21:00:00Z', to: '2026-11-12T21:00:00Z', users_total: 94, users_new: 0, active_subscriptions: 4,
  paid_active_subscriptions: 4, trials_started: 0, trials_bound: 0, purchases: 0, renewals: 0, free_activations: 0, expired: 0,
  refunds: 0, promo_activations: 0, promo_redemptions: 0, connected: 3, incidents_country: 0, incidents_server: 0,
  open_incidents: 0, expiring_in_3_days: 0, sources_total: 2, sources_unusable: 0, builders_enabled: 1, warmup_sent: 0,
  pending_orders: 0, period_revenue: [], total_revenue: [{ currency: 'RUB', amount_cents: 361_800, orders: 9 }],
};

const REPORT = '📊 <b>Итоги дня — 12.11.2026</b>\n\n👥 Пользователей: <b>94</b> (+0)\n✅ Активных подписок: <b>4</b> (платных: 4)\n💼 Оборот за всё время: 3 618 ₽';

// The browser clock is fixed (page.clock), so "Сегодня" in the feed is deterministic.
const NOW = '2026-11-12T15:00:00Z';

function events(): Json[] {
  const at = (minutesAgo: number) => new Date(Date.parse(NOW) - minutesAgo * 60_000).toISOString();
  const base = {
    builder_id: 1, source_id: null, target_id: 7, country_code: 'NL', notify_status: 'sent', notified_at: at(1), notify_error: '', details: {},
  };
  return [
    { ...base, id: 3, created_at: at(5), kind: 'server_down', severity: 'critical', title: 'Сервер недоступен', message: 'NL-1 (vless 203.0.113.7:443) · сборка «Основной» · NL' },
    { ...base, id: 2, created_at: at(20), kind: 'source_expiring', severity: 'warning', title: 'Источник скоро закончится', message: 'Источник «Provider A» действует до 14.11.2026 12:00 (МСК).', target_id: null, source_id: 4, country_code: '' },
    { ...base, id: 1, created_at: at(40), kind: 'server_up', severity: 'ok', title: 'Сервер восстановлен', message: 'NL-2 · простой 12 мин' },
  ];
}

async function json(route: Route, status: number, body: unknown) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function backend(page: Page) {
  const writes: { method: string; path: string; body: Json; csrf: string | null }[] = [];
  const problems: string[] = [];
  const promos: Json[] = [promo({})];
  let nextId = 10;
  let settings: Json = {
    enabled: true, chat_id: 0, notify_servers: true, notify_countries: true, notify_sources: true, daily_report: true,
    daily_report_hour: 9, last_report_day: '', baseline_at: T0, version: 1, updated_at: T0, own_bot: false, effective_chat_id: 777,
  };
  await page.clock.setFixedTime(new Date(NOW));
  await page.route('**/admin/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const path = url.pathname;
    if ((path === '/admin/login' || path === '/admin/session') && method === 'GET') {
      return json(route, 200, { authenticated: true, csrf_token: CSRF });
    }
    let body: Json = {};
    if (method !== 'GET') {
      body = JSON.parse(request.postData() ?? '{}') as Json;
      const csrf = await request.headerValue('x-csrf-token');
      writes.push({ method, path, body, csrf });
      if (csrf !== CSRF) problems.push(`${method} ${path} without the CSRF token`);
    }
    // The overview page, where the menu navigation starts.
    if (path === '/admin/api/dashboard' && method === 'GET') {
      return json(route, 200, {
        total_subscriptions: 4, users: 4, trials: 0, active: 4, paused: 0, revoked: 0, expired: 0, canceled: 0,
        active_expired: 0, paid: 4, expiring_in_7d: 0, audit_last_24h: 0,
      });
    }
    // The overview also asks for the network verdict (best effort): this stand
    // runs without the monitor, like a server with NETMON_ENABLED off.
    if (path === '/admin/api/monitoring' && method === 'GET') return json(route, 503, { error: 'service_unavailable' });
    const promoMatch = /^\/admin\/api\/promos\/(\d+)$/.exec(path);
    if (path === '/admin/api/promos' && method === 'GET') return json(route, 200, { promos });
    if (path === '/admin/api/promos' && method === 'POST') {
      if (typeof body.request_key !== 'string') problems.push('create without request_key');
      const { request_key: _key, ...input } = body;
      void _key;
      const created = promo({ ...input, id: nextId++, activations: 0, redeemed: 0, expires_at: input.expires_at || null, note: input.note ?? '' });
      promos.unshift(created);
      return json(route, 201, { promo: created, replayed: false, audit: { id: 1 } });
    }
    if (promoMatch && method === 'PATCH') {
      const row = promos.find(p => p.id === Number(promoMatch[1]));
      if (!row) return json(route, 404, { error: 'not_found' });
      Object.assign(row, { enabled: body.enabled, max_activations: body.max_activations, valid_hours: body.valid_hours, note: body.note,
        version: Number(row.version) + 1, state: body.enabled ? 'active' : 'disabled' });
      return json(route, 200, { promo: { ...row, redeemed: 0 }, replayed: false, audit: { id: 2 } });
    }
    if (path === '/admin/api/ops' && method === 'GET') return json(route, 200, settings);
    if (path === '/admin/api/ops' && method === 'PUT') {
      const { request_key: _key, bot_token: token, ...rest } = body;
      void _key;
      settings = { ...settings, ...rest, version: Number(settings.version) + 1, own_bot: token === undefined ? settings.own_bot : token !== '' };
      return json(route, 200, { settings, replayed: false, audit: { id: 3 } });
    }
    if (path === '/admin/api/ops/events' && method === 'GET') {
      const severity = url.searchParams.get('severity');
      const list = events().filter(e => !severity || e.severity === severity);
      return json(route, 200, { events: list, total: list.length, limit: 50, offset: 0 });
    }
    if (path === '/admin/api/ops/report' && method === 'GET') {
      return json(route, 200, { day: url.searchParams.get('day') === 'yesterday' ? '2026-11-11' : '2026-11-12', stats: STATS, text: REPORT });
    }
    if (path === '/admin/api/ops/test' && method === 'POST') return json(route, 200, { sent: true });
    problems.push(`unexpected ${method} ${path}`);
    return json(route, 404, { error: 'not_found' });
  });
  return { writes, problems, promos, settings: () => settings };
}

async function noHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

test('promo codes: the section opens from the menu, a code is created and switched off', async ({ page }) => {
  const api = await backend(page);
  await page.goto('/#/overview');
  await page.getByRole('navigation', { name: 'Разделы панели' }).getByRole('link', { name: 'Промокоды' }).click();
  await expect(page).toHaveURL(/#\/promos$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Промокоды' })).toBeVisible();
  await expect(page.locator('.ops-kpis .kpi-value')).toHaveText(['1', '1', '30', '12']);
  await expect(page.locator('.ops-promo-table tbody tr')).toHaveCount(1);
  await expect(page.getByText('кнопка «🎟 Промокод» рядом с «Купить Premium»')).toBeVisible();

  await page.getByRole('button', { name: 'Новый промокод' }).click();
  await expect(page.locator('#promo-code')).toBeFocused();
  await page.locator('#promo-code').fill('autumn');
  await expect(page.locator('#promo-code')).toHaveValue('AUTUMN');
  await page.getByRole('group', { name: 'Размер скидки' }).getByRole('button', { name: '30 %' }).click();
  await expect(page.locator('#promo-example')).toHaveText('Пример: тариф за 199 ₽ со скидкой 30 % будет стоить 139,30 ₽.');
  await page.locator('#promo-max').fill('50');
  await page.locator('#promo-note').fill('Телеграм-канал');
  await page.getByRole('button', { name: 'Создать промокод' }).click();

  await expect(page.locator('#promo-status')).toContainText('Промокод AUTUMN создан');
  await expect(page.locator('.ops-promo-table tbody tr')).toHaveCount(2);
  const created = api.writes.find(w => w.method === 'POST');
  expect(created?.body).toMatchObject({ code: 'AUTUMN', percent: 30, max_activations: 50, valid_hours: 72, enabled: true, note: 'Телеграм-канал' });
  expect(String(created?.body.request_key)).toMatch(/^ui-[0-9a-f]{32}$/);

  await page.getByRole('button', { name: 'Отключить промокод WELCOME20' }).click();
  await expect(page.locator('.ops-promo-table tbody tr').nth(1).locator('.badge')).toHaveText('Отключён');
  expect(api.writes.find(w => w.method === 'PATCH')?.body).toMatchObject({ version: 1, enabled: false });
  expect(api.problems).toEqual([]);
});

test('promo codes: unsaved editor changes guard the navigation', async ({ page }) => {
  const api = await backend(page);
  await page.goto('/#/promos');
  await page.getByRole('button', { name: 'Новый промокод' }).click();
  await page.locator('#promo-note').fill('черновик');
  page.once('dialog', dialog => void dialog.dismiss());
  await page.getByRole('navigation', { name: 'Разделы панели' }).getByRole('link', { name: 'Тарифы' }).click();
  await expect(page).toHaveURL(/#\/promos$/);
  await expect(page.locator('#promo-note')).toHaveValue('черновик');
  expect(api.writes).toEqual([]);
});

test('events: the feed marks severity by colour and text, filters and tabs work', async ({ page }) => {
  const api = await backend(page);
  await page.goto('/#/overview');
  await page.getByRole('navigation', { name: 'Разделы панели' }).getByRole('link', { name: 'События' }).click();
  await expect(page).toHaveURL(/#\/events$/);
  await expect(page.getByRole('heading', { level: 1, name: 'События' })).toBeVisible();
  await expect(page.locator('.ops-day')).toHaveText(['Сегодня']);
  await expect(page.locator('.ops-event')).toHaveCount(3);
  await expect(page.locator('.ops-sev')).toHaveText(['Критично', 'Внимание', 'Восстановлено']);

  // The coloured edge repeats the severity for a quick scan: red, yellow, green.
  const edge = (index: number) => page.locator('.ops-event').nth(index).evaluate(node => getComputedStyle(node).boxShadow);
  const [down, warn, ok] = [await edge(0), await edge(1), await edge(2)];
  expect(new Set([down, warn, ok]).size).toBe(3);
  const channels = (shadow: string) => (/rgba?\((\d+), (\d+), (\d+)/.exec(shadow) ?? []).slice(1).map(Number);
  expect(channels(down)[0]).toBeGreaterThan(channels(down)[1]); // red
  expect(channels(ok)[1]).toBeGreaterThan(channels(ok)[0]); // green

  await page.getByRole('group', { name: 'Важность' }).getByRole('button', { name: 'Критично' }).click();
  await expect(page.locator('.ops-event')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Критично' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Сбросить' }).click();
  await expect(page.locator('.ops-event')).toHaveCount(3);

  await page.getByRole('navigation', { name: 'Разделы событий' }).getByRole('link', { name: 'Итоги дня' }).click();
  await expect(page).toHaveURL(/#\/events\/report$/);
  await expect(page.locator('.ops-figure')).toHaveCount(16);
  await expect(page.locator('.ops-figure', { hasText: 'Открытых инцидентов' })).toHaveClass(/is-ok/);
  await expect(page.locator('.ops-telegram')).toContainText('Итоги дня — 12.11.2026');
  await expect(page.locator('.ops-telegram b')).toHaveCount(0);
  await page.getByRole('button', { name: 'Вчера' }).click();
  await expect(page.locator('.toolbar-meta')).toContainText('11.11.2026');

  // The events section stays selected in the menu on every tab.
  await expect(page.getByRole('navigation', { name: 'Разделы панели' }).getByRole('link', { name: 'События' })).toHaveAttribute('aria-current', 'page');
  expect(api.writes).toEqual([]);
  expect(api.problems).toEqual([]);
});

test('events: Telegram settings are saved, the token is write-only, a test is sent', async ({ page }) => {
  const api = await backend(page);
  await page.goto('/#/events/telegram');
  await expect(page.locator('#ops-set-state')).toHaveText('События и отчёт приходят в чат 777 (администратор) от основного бота.');
  await expect(page.locator('#ops-set-token')).toBeHidden();

  await page.getByLabel('Отдельный бот для уведомлений').check();
  await expect(page.locator('#ops-set-token')).toBeVisible();
  await expect(page.locator('#ops-set-token')).toHaveAttribute('type', 'password');
  await page.locator('#ops-set-token').fill(TOKEN);
  await page.locator('#ops-set-chat').fill('-1001234567890');
  await page.locator('#ops-set-hour').selectOption('21');
  await page.getByRole('button', { name: 'Сохранить' }).click();

  await expect(page.getByText('Настройки сохранены.')).toBeVisible();
  const saved = api.writes.find(w => w.method === 'PUT');
  expect(saved?.body).toMatchObject({ version: 1, chat_id: -1001234567890, bot_token: TOKEN, daily_report_hour: 21 });
  // The token never comes back: the field is empty and the page does not hold it.
  await expect(page.locator('#ops-set-token')).toHaveValue('');
  expect(await page.content()).not.toContain(TOKEN);
  expect(JSON.stringify(api.settings())).not.toContain(TOKEN);

  await page.getByRole('button', { name: 'Отправить тестовое сообщение' }).click();
  await expect(page.getByText('Тестовое сообщение отправлено.')).toBeVisible();
  expect(api.writes.filter(w => w.path === '/admin/api/ops/test')).toHaveLength(1);
  expect(api.problems).toEqual([]);
});

test('promo codes and events fit a phone screen', async ({ page }) => {
  await backend(page);
  await page.setViewportSize({ width: 375, height: 800 });
  for (const hash of ['#/promos', '#/events', '#/events/report', '#/events/telegram']) {
    await page.goto(`/${hash}`);
    await expect(page.locator('.ops')).not.toHaveAttribute('aria-busy', 'true');
    await noHorizontalOverflow(page);
  }
  await page.goto('/#/promos');
  await page.getByRole('button', { name: 'Создать промокод' }).or(page.getByRole('button', { name: 'Новый промокод' })).first().click();
  await expect(page.locator('#promo-code')).toBeVisible();
  await noHorizontalOverflow(page);
});
