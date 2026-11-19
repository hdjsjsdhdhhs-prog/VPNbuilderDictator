import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// The real admin UI against the real Go API and a temporary SQLite database
// (internal/web/admin_live_smoke_test.go). Nothing here is mocked: auth, CSRF,
// the atomic configuration save, the price of a сборка (a tariff sold on the
// builder and the sale plan behind it), the server check, /sub, the network
// monitor and the notifications worker are the production code paths. Only
// Telegram is a recorder (telegram.jsonl in the state directory).
//
// ADMIN_LIVE_REAL_URL (optional) is a real provider subscription link: the
// last test then walks the whole owner's path with it — add the source, build
// a narrow сборка, price it, read the real /sub and probe the real servers.

const STATE_DIR = process.env.ADMIN_LIVE_STATE_DIR ?? '';
const PASSWORD = process.env.ADMIN_LIVE_PASSWORD ?? '';
const REAL_URL = process.env.ADMIN_LIVE_REAL_URL ?? '';

interface State {
  source_a: number; source_b: number; other_builder: number; other_rule: number; subscription_id: number; sub_token: string;
  admin_chat: number;
}
interface StoredItem {
  id: number; kind: string; source_id: number; country_code?: string; fingerprint?: string; original_name?: string;
  custom_name?: string | null; enabled: boolean;
}
interface StoredBuilder {
  id: number; name: string; version: number; sources: { source_id: number }[]; items: StoredItem[];
  sales: { plan_id: number | null; clients: number };
}
interface StoredTariff {
  id: number; name: string; builder_id: number | null; builder_name: string; plan_id: number; plan_name: string;
  duration_days: number; price_cents: number; currency: string; is_active: boolean;
}

const state = (): State => JSON.parse(readFileSync(join(STATE_DIR, 'state.json'), 'utf8')) as State;

async function login(page: Page) {
  await page.goto('/admin-ui/');
  await page.getByLabel('Логин').fill('admin');
  await page.getByLabel('Пароль', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page.locator('.auth-screen')).toHaveCount(0);
}

/** Same-origin API call with the session cookie and CSRF token, like the UI. */
async function api(page: Page, method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  return page.evaluate(async ({ method, path, body }) => {
    const session = await (await fetch('/admin/session')).json() as { csrf_token: string };
    const resp = await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrf_token },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await resp.text();
    return { status: resp.status, json: text ? JSON.parse(text) : null };
  }, { method, path, body });
}

const stored = async (page: Page, id: number) => (await api(page, 'GET', `/admin/api/builders/${id}`)).json as StoredBuilder;

/** The tariffs sold on a сборка, as the server stores them. */
const tariffsOf = async (page: Page, builderId: number) =>
  ((await api(page, 'GET', '/admin/api/tariffs')).json as { tariffs: StoredTariff[] }).tariffs.filter(t => t.builder_id === builderId);

/** Server names in the real /sub answer, in order. */
async function subNames(page: Page, token: string): Promise<string[]> {
  const resp = await page.request.get(`/sub/${token}`);
  expect(resp.status()).toBe(200);
  return Buffer.from(await resp.text(), 'base64').toString('utf8').split('\n')
    .map(line => decodeURIComponent(line.slice(line.indexOf('#') + 1)));
}

const heading = (page: Page, name: string) => page.getByRole('heading', { level: 1, name });
const region = (page: Page, name: string) => page.getByRole('region', { name, exact: true });
const buildForm = (page: Page) => page.getByRole('form', { name: 'Параметры сборки' });
const save = (page: Page) => buildForm(page).getByRole('button', { name: 'Сохранить', exact: true });
const status = (page: Page) => buildForm(page).locator('.editor-status');
/** The live preview of the constructor: what a client gets. */
const previewTotal = (page: Page) => region(page, 'Подписка клиента').locator('.bd-preview-total');
const sourcePick = (page: Page, name: string) =>
  page.getByRole('group', { name: 'Источники сборки' }).getByRole('checkbox', { name: new RegExp(`^${name}`) });
/** A country card of one source; its tick is the whole country. */
const country = (page: Page, sourceId: number, code: string) =>
  page.locator(`.bd-source-block[data-source-id="${sourceId}"] .bd-country[data-country="${code}"]`);
const countryTick = (page: Page, sourceId: number, code: string) => country(page, sourceId, code).locator('.bd-country-head input');

// --- Network monitor and notifications ---------------------------------------

const monitorRow = (page: Page, name: string) =>
  page.getByRole('table', { name: 'Состояние сети по сборкам' }).locator(':scope > tbody > tr').filter({ hasText: name });
const monitorCell = (page: Page, name: string, column: string) => monitorRow(page, name).locator(`td[data-label="${column}"]`);

/** «Проверить сейчас»: one real check round; resolves when its result is painted. */
async function checkNow(page: Page) {
  const button = page.getByRole('button', { name: 'Проверить сейчас' });
  await button.click();
  await expect(button).toBeEnabled({ timeout: 40_000 });
  await expect(page.locator('.toast-region')).toContainText('Проверка завершена');
}

/** Takes a smoke server down or brings it back; the stand removes the file when done. */
async function control(action: 'down' | 'up', key: string) {
  const file = join(STATE_DIR, `${action}-${key}`);
  writeFileSync(file, '');
  await expect.poll(() => existsSync(file), { timeout: 15_000 }).toBe(false);
}

interface TelegramMessage { chat_id: number; html: string }

/** Everything the notifications worker has "sent to Telegram" so far. */
function telegram(): TelegramMessage[] {
  const file = join(STATE_DIR, 'telegram.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as TelegramMessage);
}

/** Waits for a Telegram message that contains every part; answers it. */
async function telegramMessage(parts: readonly string[], timeout: number): Promise<TelegramMessage> {
  const find = () => telegram().find(m => parts.every(part => m.html.includes(part)));
  await expect.poll(() => find() !== undefined, { timeout, message: `Telegram message with ${parts.join(' + ')}` }).toBe(true);
  return find()!;
}

test.afterAll(() => { if (STATE_DIR) writeFileSync(join(STATE_DIR, 'stop'), 'done'); });

test('сборка through the real API: create with a price, reload, server check, /sub, ownership, stale tab, rename', async ({ page, context }) => {
  test.skip(!STATE_DIR || !PASSWORD, 'ADMIN_LIVE_STATE_DIR and ADMIN_LIVE_PASSWORD are required');
  const s = state();
  await login(page);

  // 1. One page: two sources, two countries of A and one server of B, a name
  // for the clients, the name of the сборка and its price.
  await page.goto('/admin-ui/#/builders/new');
  await expect(heading(page, 'Новая сборка')).toBeVisible();
  await sourcePick(page, 'Smoke A').check();
  await sourcePick(page, 'Smoke B').check();
  // Everything the sources have is the default: a wide subscription.
  await expect(previewTotal(page)).toHaveText('6 серверов · 4 страны');

  await page.getByRole('radio', { name: /Выбрать страны и серверы/ }).check();
  await countryTick(page, s.source_a, 'DE').check();
  await countryTick(page, s.source_a, 'NL').check();
  const us = country(page, s.source_b, 'US');
  await us.getByRole('button', { name: /^Показать серверы/ }).click();
  await us.getByRole('checkbox', { name: '🇺🇸 Dallas' }).check();
  await expect(previewTotal(page)).toHaveText('4 сервера · 3 страны');

  const name = page.getByLabel('Название сборки');
  await expect(name).toHaveValue('3 страны');
  await name.fill('Smoke builder');
  await page.getByLabel('Своё название: Германия').fill('DE Fast');
  await expect(region(page, 'Подписка клиента').locator('.bd-preview-name')).toHaveText(['DE Fast', 'DE Fast', '🇳🇱 Amsterdam', '🇺🇸 Dallas']);

  await page.getByRole('button', { name: '+ 1 месяц' }).click();
  await page.getByLabel('Цена, ₽').fill('199');
  await buildForm(page).getByRole('button', { name: 'Создать сборку' }).click();

  await expect(heading(page, 'Smoke builder')).toBeVisible();
  await expect(page).toHaveURL(/#\/builders\/\d+$/);
  const builderId = Number(/#\/builders\/(\d+)$/.exec(page.url())?.[1]);
  expect(builderId).toBeGreaterThan(0);
  await expect(status(page)).toContainText('Сборка «Smoke builder» создана и выставлена на продажу: 1 цена.');
  const price = page.locator('.bd-price');
  await expect(price).toHaveCount(1);
  await expect(price).toContainText('1 месяц');
  await expect(price).toContainText('30 дней · 199 ₽');
  await expect(price).toContainText('В продаже');
  // The plan a сборка is sold on is internal: the screen never mentions one.
  await expect(page.getByRole('main')).not.toContainText(/план/i);

  const first = await stored(page, builderId);
  expect(first.version).toBe(2);
  expect(first.sources.map(x => x.source_id)).toEqual([s.source_a, s.source_b]);
  expect(first.items.map(i => [i.kind, i.source_id, i.country_code ?? '', i.original_name ?? '', i.custom_name ?? ''])).toEqual([
    ['country', s.source_a, 'DE', '', 'DE Fast'], ['country', s.source_a, 'NL', '', ''], ['node', s.source_b, '', '🇺🇸 Dallas', ''],
  ]);
  // The tariff is sold on the сборка; its sale plan was created by the server
  // and is named after the сборка — nobody had to pick a plan.
  const [tariff, ...rest] = await tariffsOf(page, builderId);
  expect(rest).toEqual([]);
  expect(tariff).toMatchObject({
    name: '1 месяц', builder_id: builderId, builder_name: 'Smoke builder', plan_name: 'Smoke builder',
    duration_days: 30, price_cents: 19900, currency: 'RUB', is_active: true,
  });
  expect(first.sales.plan_id).toBe(tariff.plan_id);

  // 2. The server assembles the saved сборка exactly like for a client.
  const check = region(page, 'Проверка на сервере');
  await check.getByRole('button', { name: 'Проверить на сервере' }).click();
  await expect(check).toContainText('Клиент получит: 4 сервера · 3 страны.');

  // 3. Full reload: the stored composition is what is ticked.
  await page.reload();
  await expect(heading(page, 'Smoke builder')).toBeVisible();
  await expect(previewTotal(page)).toHaveText('4 сервера · 3 страны');
  await expect(countryTick(page, s.source_a, 'DE')).toBeChecked();
  await expect(countryTick(page, s.source_a, 'NL')).toBeChecked();
  await expect(countryTick(page, s.source_a, 'FI')).not.toBeChecked();
  await expect(page.getByLabel('Своё название: Германия')).toHaveValue('DE Fast');
  await expect(buildForm(page).getByText('Все изменения сохранены')).toBeVisible();
  await expect(save(page)).toBeDisabled();
  expect(await stored(page, builderId)).toEqual(first);

  // 4. The real /sub of a subscription that uses the сборка.
  const assigned = await api(page, 'POST', `/admin/api/subscriptions/${s.subscription_id}/builder`, { request_key: 'live-assign-1', builder_id: builderId });
  expect(assigned.status).toBe(200);
  expect(await subNames(page, s.sub_token)).toEqual(['DE Fast', 'DE Fast', '🇳🇱 Amsterdam', '🇺🇸 Dallas']);

  // 5. A rule of another сборка: refused by every rule endpoint, unchanged.
  const otherBefore = await stored(page, s.other_builder);
  const mineBefore = await stored(page, builderId);
  const refused = [
    await api(page, 'DELETE', `/admin/api/builders/${builderId}/items/${s.other_rule}`),
    await api(page, 'POST', `/admin/api/builders/${builderId}/items`, { id: s.other_rule, kind: 'country', source_id: s.source_a, country_code: 'FI', position: 0, enabled: true }),
    await api(page, 'POST', `/admin/api/builders/${builderId}/reorder`, { item_ids: [s.other_rule] }),
    await api(page, 'PUT', `/admin/api/builders/${builderId}/configuration`, {
      request_key: 'live-steal', version: mineBefore.version, name: mineBefore.name, description: '', enabled: true, profile_title: '', support_url: '', announce: '',
      source_ids: [s.source_a], items: [{ id: s.other_rule, kind: 'country', source_id: s.source_a, country_code: 'FI', fingerprint: '', original_name: '', custom_name: null, description: '', enabled: true }],
    }),
  ];
  expect(refused).toEqual(refused.map(() => ({ status: 404, json: { error: 'not_found' } })));
  expect(await stored(page, s.other_builder)).toEqual(otherBefore);
  expect(await stored(page, builderId)).toEqual(mineBefore);

  // 6. Two tabs load the same version; the later save is refused, not merged.
  const tab2 = await context.newPage();
  await tab2.goto(`/admin-ui/#/builders/${builderId}`);
  await expect(heading(tab2, 'Smoke builder')).toBeVisible();
  await expect(previewTotal(tab2)).toHaveText('4 сервера · 3 страны');

  await countryTick(page, s.source_a, 'NL').uncheck();
  await expect(buildForm(page).getByText('Есть несохранённые изменения')).toBeVisible();
  await save(page).click();
  await expect(status(page)).toContainText('Сборка сохранена. Клиенты получат изменения при следующем обновлении подписки.');
  const afterTab1 = await stored(page, builderId);
  expect(afterTab1.items.map(i => (i.kind === 'node' ? i.original_name : i.country_code))).toEqual(['DE', '🇺🇸 Dallas']);
  expect(afterTab1.version).toBe(mineBefore.version + 1);

  await countryTick(tab2, s.source_a, 'FI').check();
  await save(tab2).click();
  await expect(status(tab2)).toContainText('Изменения не сохранены. Сборку изменили в другом окне или другим администратором. Сохранённая версия не затронута.');
  expect(await stored(page, builderId)).toEqual(afterTab1);
  expect(await subNames(page, s.sub_token)).toEqual(['DE Fast', 'DE Fast', '🇺🇸 Dallas']);
  await tab2.close();

  // 7. Renaming the сборка renames its sale plan: the name clients and the
  // users list see follows the сборка, the tariff stays on the same plan.
  await page.getByLabel('Название сборки').fill('Smoke Europe');
  await save(page).click();
  await expect(heading(page, 'Smoke Europe')).toBeVisible();
  await expect(status(page)).toContainText('Сборка сохранена.');
  const [renamed] = await tariffsOf(page, builderId);
  expect(renamed).toMatchObject({ id: tariff.id, plan_id: tariff.plan_id, builder_name: 'Smoke Europe', plan_name: 'Smoke Europe' });

  // 8. The list: what the сборка gives, its price and who gets it.
  await page.goto('/admin-ui/#/builders');
  await expect(heading(page, 'Сборки')).toBeVisible();
  const card = page.locator(`.bd-card[data-build-id="${builderId}"]`);
  await expect(card.locator('.bd-card-title')).toHaveText('Smoke Europe');
  await expect(card).toContainText('В продаже');
  await expect(card.locator('.bd-card-facts')).toHaveText('3 сервера · 1 страна · выбранные страны и серверы');
  await expect(card.locator('.bd-card-prices')).toHaveText('30 дней · 199 ₽');
  await expect(card.locator('.bd-card-meta')).toHaveText('1 клиент · источник: Smoke A, Smoke B');
  await expect(page.getByRole('main')).not.toContainText(/план/i);

  // A sold сборка cannot be deleted: the server lists what depends on it.
  await card.getByRole('button', { name: 'Удалить «Smoke Europe»' }).click();
  await expect(page.locator('.toast-region')).toContainText(
    'Сборку «Smoke Europe» нельзя удалить: у неё есть тарифы или клиенты, которые её купили; она назначена лично 1 клиенту. Её можно отключить.');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect((await stored(page, builderId)).name).toBe('Smoke Europe');
});

test('monitoring through the real monitor: a server goes down, Telegram learns right after the check, then recovery', async ({ page }) => {
  test.skip(!STATE_DIR || !PASSWORD, 'ADMIN_LIVE_STATE_DIR and ADMIN_LIVE_PASSWORD are required');
  test.setTimeout(300_000);
  const s = state();
  await login(page);
  await page.goto('/admin-ui/#/monitoring');
  await expect(heading(page, 'Мониторинг')).toBeVisible();

  // 1. The first round: every smoke server completes a real TLS handshake.
  await checkNow(page);
  await expect(page.getByRole('heading', { name: 'Всё работает' })).toBeVisible();
  await expect(monitorCell(page, 'Чужой', 'Статус')).toHaveText('Работает');
  await expect(monitorCell(page, 'Чужой', 'Серверы')).toContainText('1 из 1');

  // 2. Dallas stops answering. A server is down after two failed checks in a
  // row (the page says so); a manual check repeats the failed probe right
  // away, so one press ends with the verdict: «Чужой» has no other server.
  await expect(page.getByText('Сервер становится недоступным после 2 неудачных проверок подряд.')).toBeVisible();
  expect(telegram().filter(m => m.html.includes('Dallas'))).toEqual([]);
  await control('down', 'us');
  await checkNow(page);
  await expect(monitorCell(page, 'Чужой', 'Статус')).toHaveText('Недоступен');
  await expect(monitorCell(page, 'Чужой', 'Серверы')).toContainText('0 из 1');
  await expect(page.getByRole('heading', { name: /^Недоступно: 1 сборка$/ })).toBeVisible();

  // 3. Telegram: the notifications worker is woken by the round, so the
  // message does not wait for its minute timer. (The very first delivery may
  // wait for the start delay of the worker, hence the long timeout here.)
  const down = await telegramMessage(['Сервер недоступен', 'Dallas'], 120_000);
  expect(down.chat_id).toBe(s.admin_chat);
  // Who is affected and where: every сборка that hands the server out, its country, the reason.
  expect(down.html).toContain('«Чужой»');
  expect(down.html).toContain(' · US · причина: соединение отклонено');
  const builderDown = await telegramMessage(['Сборка недоступна', '«Чужой»'], 120_000);
  expect(builderDown.html).toContain('Клиенты этой сборки остались без VPN.');
  // Nothing a provider would consider secret reaches the chat.
  for (const m of telegram()) expect(m.html).not.toMatch(/vless:\/\/|sni=/);

  // 4. The events feed of the panel shows the same incident.
  await page.goto('/admin-ui/#/events');
  await expect(heading(page, 'События')).toBeVisible();
  const events = page.locator('.ops-event');
  await expect(events.filter({ hasText: 'Сервер недоступен' }).filter({ hasText: 'Dallas' })).toHaveCount(1);
  await expect(events.filter({ hasText: 'Сборка недоступна' }).filter({ hasText: '«Чужой»' })).toHaveCount(1);

  // 5. Dallas is back: one successful check ends the outage, and Telegram
  // hears about it within seconds of that check (the worker is already
  // running; without the wake-up it would wait for its next minute tick).
  await control('up', 'us');
  await page.goto('/admin-ui/#/monitoring');
  await expect(heading(page, 'Мониторинг')).toBeVisible();
  await checkNow(page);
  await expect(monitorCell(page, 'Чужой', 'Статус')).toHaveText('Работает');
  await expect(page.getByRole('heading', { name: 'Всё работает' })).toBeVisible();
  const up = await telegramMessage(['Сервер восстановлен', 'Dallas'], 15_000);
  expect(up.html).toContain('простой');
  await telegramMessage(['Сборка восстановлена', '«Чужой»'], 15_000);

  // 6. The page of the сборка keeps the outage in its history.
  await monitorRow(page, 'Чужой').getByRole('link', { name: 'Чужой' }).click();
  await expect(page).toHaveURL(new RegExp(`#/monitoring/${s.other_builder}$`));
  await expect(heading(page, 'Чужой')).toBeVisible();
  const outages = page.getByRole('table', { name: 'Сбои за период, от новых к старым' }).locator('tbody tr');
  await expect(outages.filter({ hasText: 'Восстановлено' }).first()).toBeVisible();
  await expect(outages.filter({ hasText: 'Соединение отклонено' }).first()).toBeVisible();
});

test('a real provider subscription: add the source, build a narrow сборка, price it, read /sub, probe the servers', async ({ page }) => {
  test.skip(!STATE_DIR || !PASSWORD, 'ADMIN_LIVE_STATE_DIR and ADMIN_LIVE_PASSWORD are required');
  test.skip(!REAL_URL, 'ADMIN_LIVE_REAL_URL is not set');
  test.setTimeout(300_000);
  const s = state();
  await login(page);

  // 1. The source: one field — the link. The name is optional.
  await page.goto('/admin-ui/#/sources');
  await page.getByRole('button', { name: 'Добавить источник' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Новый источник' });
  await dialog.getByLabel('Ссылка на подписку провайдера').fill(REAL_URL);
  await dialog.getByLabel('Название').fill('Real provider');
  await dialog.getByRole('button', { name: 'Создать и синхронизировать' }).click();
  await expect(heading(page, 'Real provider')).toBeVisible({ timeout: 90_000 });
  await expect(page.locator('.source-sync-status')).toContainText('Синхронизировано');
  // The link is write-only: no part of it comes back to the page.
  const secret = new URL(REAL_URL).pathname.split('/').filter(Boolean).at(-1) ?? '';
  expect(secret.length).toBeGreaterThan(8);
  await expect(page.locator('body')).not.toContainText(secret);

  const sourceId = Number(/#\/sources\/(\d+)$/.exec(page.url())?.[1]);
  expect(sourceId).toBeGreaterThan(0);
  interface Source { catalogue: { entries: number; countries: number; no_country: number; by_country: { code: string; count: number }[]; protocols: Record<string, number> } }
  const source = (await api(page, 'GET', `/admin/api/sources/${sourceId}`)).json as Source;
  const byCountry = source.catalogue.by_country.filter(c => c.code !== '');
  console.log(`[real] catalogue: ${source.catalogue.entries} servers, ${source.catalogue.countries} countries, ` +
    `${source.catalogue.no_country} without a country; protocols ${JSON.stringify(source.catalogue.protocols)}`);
  console.log(`[real] countries: ${byCountry.map(c => `${c.code}×${c.count}`).join(' ')}`);
  expect(source.catalogue.entries).toBeGreaterThanOrEqual(10);
  expect(byCountry.length).toBeGreaterThanOrEqual(5);

  // 2. A narrow сборка from two countries of the source, with a price.
  const picked = ['DE', 'NL'].every(code => byCountry.some(c => c.code === code)) ? ['DE', 'NL'] : byCountry.slice(0, 2).map(c => c.code);
  const expected = picked.reduce((sum, code) => sum + (byCountry.find(c => c.code === code)?.count ?? 0), 0);
  await page.goto(`/admin-ui/#/builders/new/from/${sourceId}`);
  await expect(heading(page, 'Новая сборка')).toBeVisible();
  await expect(sourcePick(page, 'Real provider')).toBeChecked();
  // A wide subscription is the default: everything the provider has.
  await expect(previewTotal(page)).toContainText(new RegExp(`^${source.catalogue.entries} сервер`));
  await page.getByRole('radio', { name: /Выбрать страны и серверы/ }).check();
  for (const code of picked) await countryTick(page, sourceId, code).check();
  await expect(previewTotal(page)).toContainText(new RegExp(`^${expected} сервер[а-я]* · 2 страны$`));
  await page.getByLabel('Название сборки').fill('Real narrow');
  await page.getByRole('button', { name: '+ 1 месяц' }).click();
  await page.getByLabel('Цена, ₽').fill('149');
  await buildForm(page).getByRole('button', { name: 'Создать сборку' }).click();
  await expect(heading(page, 'Real narrow')).toBeVisible();
  const builderId = Number(/#\/builders\/(\d+)$/.exec(page.url())?.[1]);
  expect(builderId).toBeGreaterThan(0);
  await expect(page.locator('.bd-price')).toContainText('30 дней · 149 ₽');
  expect(await tariffsOf(page, builderId)).toMatchObject([{ name: '1 месяц', builder_name: 'Real narrow', price_cents: 14900, is_active: true }]);

  // 3. The server assembles it from the live provider answer.
  const check = region(page, 'Проверка на сервере');
  await check.getByRole('button', { name: 'Проверить на сервере' }).click();
  await expect(check).toContainText(new RegExp(`Клиент получит: ${expected} сервер[а-я]* · 2 страны\\.`), { timeout: 60_000 });

  // 4. The real /sub of a client on this сборка: only the picked countries.
  const assigned = await api(page, 'POST', `/admin/api/subscriptions/${s.subscription_id}/builder`, { request_key: 'live-assign-real', builder_id: builderId });
  expect(assigned.status).toBe(200);
  const resp = await page.request.get(`/sub/${s.sub_token}`);
  expect(resp.status()).toBe(200);
  const body = (await resp.text()).trim();
  const names = body.startsWith('[')
    ? (JSON.parse(body) as { remarks?: string }[]).map(config => config.remarks ?? '')
    : Buffer.from(body, 'base64').toString('utf8').split('\n').filter(Boolean).map(line => decodeURIComponent(line.slice(line.indexOf('#') + 1)));
  console.log(`[real] /sub (${body.startsWith('[') ? 'JSON configs' : 'share links'}): ${names.join(' | ')}`);
  expect(names).toHaveLength(expected);
  expect(body).not.toContain(secret);

  // 5. The monitor probes the real servers of the сборка (handshake level).
  await page.goto('/admin-ui/#/monitoring');
  await expect(heading(page, 'Мониторинг')).toBeVisible();
  await checkNow(page);
  await expect(monitorRow(page, 'Real narrow')).toHaveCount(1);
  const servers = (await monitorCell(page, 'Real narrow', 'Серверы').innerText()).replace(/\s+/g, ' ');
  const verdict = (await monitorCell(page, 'Real narrow', 'Статус').innerText()).trim();
  console.log(`[real] monitor: ${verdict}; servers ${servers}`);
  await expect(monitorCell(page, 'Real narrow', 'Серверы')).toContainText(new RegExp(`из ${expected}`));

  // 6. The opposite case, a wide сборка: everything the provider has, which
  // is the default of the constructor — a source, a name, «Создать».
  await page.goto(`/admin-ui/#/builders/new/from/${sourceId}`);
  await expect(heading(page, 'Новая сборка')).toBeVisible();
  await expect(page.getByLabel('Название сборки')).toHaveValue('Все серверы · Real provider');
  await page.getByLabel('Название сборки').fill('Real wide');
  await buildForm(page).getByRole('button', { name: 'Создать сборку' }).click();
  await expect(heading(page, 'Real wide')).toBeVisible();
  const wideId = Number(/#\/builders\/(\d+)$/.exec(page.url())?.[1]);
  expect((await stored(page, wideId)).items).toEqual([]);
  const reassigned = await api(page, 'POST', `/admin/api/subscriptions/${s.subscription_id}/builder`, { request_key: 'live-assign-real-wide', builder_id: wideId });
  expect(reassigned.status).toBe(200);
  const wide = await page.request.get(`/sub/${s.sub_token}`);
  expect(wide.status()).toBe(200);
  const wideBody = (await wide.text()).trim();
  expect(wideBody.startsWith('[')).toBe(true);
  expect(JSON.parse(wideBody) as unknown[]).toHaveLength(source.catalogue.entries);

  // One manual check gives every server a verdict (a failed probe is repeated
  // right away). What the real servers answer is reported, not asserted: it
  // depends on the network this stand runs in.
  await page.goto('/admin-ui/#/monitoring');
  await expect(heading(page, 'Мониторинг')).toBeVisible();
  await checkNow(page);
  interface Node { target_id: number; name: string; protocol: string; transport: string; security: string; probe: string; status: string; last_error: string; latency_ms: number | null }
  interface Detail { builder: { nodes_total: number; nodes_up: number; nodes_down: number; nodes_unknown: number; unresolved: number; source_errors: number }; countries: { country_code: string; nodes: Node[] }[] }
  const detail = (await api(page, 'GET', `/admin/api/monitoring/builders/${wideId}`)).json as Detail;
  const b = detail.builder;
  console.log(`[real] wide monitor: ${b.nodes_total} checked servers — up ${b.nodes_up}, down ${b.nodes_down}, no verdict ${b.nodes_unknown}; ` +
    `without a checkable address ${b.unresolved}; source errors ${b.source_errors}`);
  for (const c of detail.countries) {
    for (const n of c.nodes) {
      if (n.status !== 'up') console.log(`[real]   ${n.status.toUpperCase()} ${c.country_code || '--'} ${n.name} · ${n.protocol}/${n.transport}/${n.security} · probe ${n.probe} · ${n.last_error || 'no error'}`);
    }
  }
  expect(b.source_errors).toBe(0);
  expect(b.nodes_total).toBeGreaterThan(0);
  await expect(monitorRow(page, 'Real wide')).toHaveCount(1);

  // A provider may answer every request differently (a random Reality name
  // per server, another decoy inside its balancing configs). The servers must
  // stay the same monitor targets through another re-read of the source —
  // otherwise their statuses, history and open outages would start over (and
  // an outage would be reported again and again).
  const targetsOf = (d: Detail) => Object.fromEntries(d.countries.flatMap(c => c.nodes.map(n => [n.name, n.target_id] as const)));
  const statusesOf = (d: Detail) => Object.fromEntries(d.countries.flatMap(c => c.nodes.map(n => [n.name, n.status] as const)));
  await checkNow(page);
  const again = (await api(page, 'GET', `/admin/api/monitoring/builders/${wideId}`)).json as Detail;
  expect(targetsOf(again)).toEqual(targetsOf(detail));
  const changed = Object.entries(statusesOf(again)).filter(([name, status]) => statusesOf(detail)[name] !== status);
  console.log(`[real] after another re-read: ${Object.keys(targetsOf(again)).length} targets kept; statuses changed: ${changed.map(([n, st]) => `${n} → ${st}`).join(', ') || 'none'}`);
  const removed = telegram().filter(m => m.html.includes('снят с выдачи') || m.html.includes('снята с выдачи'));
  expect(removed).toEqual([]);
});
