import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../admin/src/api';
import {
  BOT_TOKEN_PATTERN, NEW_PROMO_FORM, OpsApi, activationsShare, activationsText, conversionText, discountedCents, eventsHash,
  eventsPath, formFromPromo, formatMoney, groupByDay, kindLabel, kindSubject, opsErrorText, opsForm, opsHash, opsSave,
  parseDailyStats, parseEventsTab, parseOpsEvent, parseOpsRoute, parseOpsSettings, parsePromo, parseReport, promoPatch,
  promoTotals, reportDayText, reportFigures, suggestPromoCode, telegramPlainText, validHoursText, validatePromoForm,
  type OpsRoute, type OpsSettings,
} from '../admin/src/ops';
import { OpsScreen, resetOpsMemory, type OpsHost } from '../admin/src/ops-ui';

// Promo codes and events (admin/src/ops-ui.ts over admin/src/ops.ts) rendered
// in jsdom against an in-memory backend that follows the contract of
// internal/web/admin_promo_ops_api.go → service.PromoService / OpsService:
//   - a mutation outcome carries the promo without its redemption count;
//   - PATCH/DELETE/PUT are optimistic-locked by version (409 version_conflict);
//   - the bot token is write-only: GET /ops answers own_bot, never the token;
//   - POST /ops/test answers 502 ops_send_failed when Telegram rejects.
// No real Telegram chat is involved.

const T0 = '2026-11-10T09:00:00Z';
const NOW = '2026-11-12T15:00:00Z';
const TOKEN = '123456789:AAEabcdefghijklmnopqrstuvwxyz0123456';

type Json = Record<string, unknown>;
interface Call { method: string; path: string; body: Json | null }

const promo = (over: Json): Json => ({
  id: 1, code: 'WELCOME20', percent: 20, max_activations: 100, activations: 30, valid_hours: 72, expires_at: null, enabled: true,
  note: '', version: 1, created_at: T0, updated_at: T0, redeemed: 0, state: 'active', ...over,
});

const STATS: Json = {
  from: '2026-11-11T21:00:00Z', to: '2026-11-12T21:00:00Z', users_total: 94, users_new: 2, active_subscriptions: 4,
  paid_active_subscriptions: 3, trials_started: 5, trials_bound: 2, purchases: 3, renewals: 1, free_activations: 1, expired: 1,
  refunds: 0, promo_activations: 4, promo_redemptions: 2, connected: 17, incidents_country: 1, incidents_server: 2,
  open_incidents: 1, expiring_in_3_days: 2, sources_total: 3, sources_unusable: 0, builders_enabled: 2, warmup_sent: 6,
  pending_orders: 1, period_revenue: [{ currency: 'RUB', amount_cents: 361_800, orders: 3 }],
  total_revenue: [{ currency: 'RUB', amount_cents: 1_268_500, orders: 40 }, { currency: 'XTR', amount_cents: 250, orders: 2 }],
};

const REPORT_HTML = '📊 <b>Итоги дня — 12.11.2026</b>\n\n👥 Пользователей: <b>94</b> (+2)\n💰 Продаж за день: <b>3 618 ₽</b>\nИсточник &lt;A&amp;B&gt;';

const event = (over: Json): Json => ({
  id: 1, created_at: '2026-11-12T12:00:00Z', kind: 'server_down', severity: 'critical', title: 'Сервер недоступен',
  message: 'NL-1 (vless 203.0.113.7:443) · сборка «Основной» · NL · причина: нет ответа (таймаут)', builder_id: 1, source_id: null,
  target_id: 7, country_code: 'NL', notify_status: 'sent', notified_at: '2026-11-12T12:01:00Z', notify_error: '', details: {}, ...over,
});

interface Options {
  events?: Json[];
  ownBot?: boolean;
  /** POST /promos answers this error. */
  createFailure?: ApiError;
  /** PUT /ops answers 409 version_conflict. */
  staleSettings?: boolean;
  /** POST /ops/test answers 502 ops_send_failed. */
  testFails?: boolean;
}

function backend(options: Options = {}) {
  const calls: Call[] = [];
  let nextId = 10;
  const promos: Json[] = [
    promo({ id: 1, redeemed: 12, note: 'Канал' }),
    promo({ id: 2, code: 'FRIENDS', percent: 100, max_activations: 0, activations: 0, enabled: false, state: 'disabled' }),
  ];
  let settings: Json = {
    enabled: true, chat_id: 0, notify_servers: true, notify_countries: true, notify_sources: true, daily_report: true,
    daily_report_hour: 9, last_report_day: '2026-11-11', baseline_at: T0, version: 3, updated_at: T0, own_bot: options.ownBot ?? false,
    effective_chat_id: 777,
  };
  const events = options.events ?? [
    event({}),
    event({ id: 2, created_at: '2026-11-12T11:00:00Z', kind: 'server_up', severity: 'ok', title: 'Сервер восстановлен', message: 'NL-1 · простой 12 мин', notify_status: 'skipped', notified_at: null }),
    event({ id: 3, created_at: '2026-11-11T12:00:00Z', kind: 'daily_report', severity: 'info', title: 'Итоги дня 10.11.2026', message: REPORT_HTML, builder_id: null, target_id: null, country_code: '', notify_status: 'failed', notified_at: null, notify_error: 'telegram answered 403: bot was blocked by the user' }),
  ];
  const fail = (code: string, status: number, field = ''): never => { throw new ApiError(code, status, 0, field); };
  const state = (p: Json) => (!p.enabled ? 'disabled' : 'active');
  const audit = { id: 1 };

  const request = vi.fn(async (method: string, path: string, body?: string): Promise<unknown> => {
    const parsed = body ? JSON.parse(body) as Json : null;
    calls.push({ method, path, body: parsed });
    const promoMatch = /^\/admin\/api\/promos\/(\d+)$/.exec(path);
    if (method === 'GET' && path === '/admin/api/promos') return { promos };
    if (method === 'POST' && path === '/admin/api/promos') {
      if (options.createFailure) throw options.createFailure;
      const created = promo({ ...parsed, request_key: undefined, id: nextId++, activations: 0, expires_at: parsed?.expires_at || null, state: 'active' });
      delete created.request_key;
      created.state = state(created);
      promos.unshift({ ...created });
      return { promo: created, replayed: false, audit };
    }
    if (promoMatch && method === 'PATCH') {
      const row = promos.find(p => p.id === Number(promoMatch[1])) ?? fail('not_found', 404);
      if (parsed?.version !== row.version) fail('version_conflict', 409);
      Object.assign(row, {
        max_activations: parsed?.max_activations, valid_hours: parsed?.valid_hours, expires_at: parsed?.expires_at || null,
        enabled: parsed?.enabled, note: parsed?.note, version: Number(row.version) + 1,
      });
      row.state = state(row);
      // service.PromoOutcome: the redemption count is not part of a mutation outcome.
      return { promo: { ...row, redeemed: 0 }, replayed: false, audit };
    }
    if (promoMatch && method === 'DELETE') {
      const index = promos.findIndex(p => p.id === Number(promoMatch[1]));
      if (index < 0) fail('not_found', 404);
      if (Number(promos[index].activations) > 0) fail('promo_in_use', 409);
      promos.splice(index, 1);
      return { deleted: Number(promoMatch[1]), promo: null, replayed: false, audit };
    }
    if (method === 'GET' && path === '/admin/api/ops') return settings;
    if (method === 'PUT' && path === '/admin/api/ops') {
      if (options.staleSettings) fail('version_conflict', 409);
      const { request_key: _key, bot_token: token, ...rest } = parsed ?? {};
      void _key;
      settings = {
        ...settings, ...rest, version: Number(settings.version) + 1,
        own_bot: token === undefined ? settings.own_bot : token !== '',
        effective_chat_id: Number(rest.chat_id) || 777,
      };
      return { settings, replayed: false, audit };
    }
    if (method === 'GET' && path.startsWith('/admin/api/ops/events')) {
      const q = new URL(path, 'http://x').searchParams;
      const list = events.filter(e => (!q.get('severity') || e.severity === q.get('severity')) && (!q.get('kind') || e.kind === q.get('kind')));
      const offset = Number(q.get('offset') ?? 0);
      const limit = Number(q.get('limit') ?? 50);
      return { events: list.slice(offset, offset + limit), total: list.length, limit, offset };
    }
    if (method === 'GET' && path.startsWith('/admin/api/ops/report')) {
      const yesterday = path.endsWith('day=yesterday');
      return { day: yesterday ? '2026-11-11' : '2026-11-12', stats: STATS, text: REPORT_HTML };
    }
    if (method === 'POST' && path === '/admin/api/ops/test') {
      if (options.testFails) fail('ops_send_failed', 502);
      return { sent: true };
    }
    return fail('not_found', 404);
  });

  return { request, calls, promos, settings: () => settings };
}

// ---------------------------------------------------------------------------
// Harness

const flush = async (rounds = 6) => { for (let i = 0; i < rounds; i++) await new Promise(r => setTimeout(r, 0)); };

/** Mounts a screen. wait=false returns while the first request is still in flight. */
async function mount(server: ReturnType<typeof backend>, route: OpsRoute, confirm = true, wait = true) {
  const toasts: string[] = [];
  let check: (() => boolean) | null = null;
  const host: OpsHost & { unsaved: () => boolean; toasts: string[] } = {
    api: new OpsApi({ request: (method, path, body) => server.request(method, path, body) }),
    icon: () => document.createElement('i'),
    toast: (text: string) => { toasts.push(text); },
    confirm: vi.fn(() => Promise.resolve(confirm)),
    setUnsaved: (c: (() => boolean) | null) => { check = c; },
    signedOut: () => Promise.resolve(false),
    sessionUsed: () => undefined,
    unsaved: () => check?.() ?? false,
    toasts,
  };
  const page = { header: document.createElement('header'), title: document.createElement('h1'), desc: document.createElement('p') };
  const screen = new OpsScreen(host, route, page);
  const root = document.createElement('main');
  root.append(page.header, screen.body);
  document.body.replaceChildren(root);
  const loading = screen.load();
  if (wait) await loading;
  await flush();
  return { screen, host, page, root };
}

const $ = <T extends HTMLElement = HTMLElement>(selector: string): T => {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`missing ${selector}`);
  return node;
};
const all = (selector: string) => Array.from(document.querySelectorAll<HTMLElement>(selector));
const type = (selector: string, value: string) => {
  const node = $<HTMLInputElement>(selector);
  node.value = value;
  node.dispatchEvent(new Event('input', { bubbles: true }));
};
const choose = (selector: string, value: string) => {
  const node = $<HTMLSelectElement | HTMLInputElement>(selector);
  if (node instanceof HTMLInputElement && (node.type === 'checkbox' || node.type === 'radio')) node.checked = value === 'on';
  else node.value = value;
  node.dispatchEvent(new Event('change', { bubbles: true }));
};
const click = async (selector: string) => { $(selector).click(); await flush(); };
const text = (selector: string) => ($(selector).textContent ?? '').replace(/\s/g, ' ');
const pageText = () => (document.body.textContent ?? '').replace(/\s/g, ' ');
const chip = (label: string, scope = document.body) => {
  const node = Array.from(scope.querySelectorAll<HTMLButtonElement>('button.chip')).find(b => b.textContent?.replace(/\s/g, ' ').trim() === label);
  if (!node) throw new Error(`missing chip ${label}`);
  return node;
};
const submit = async (selector: string) => { $<HTMLFormElement>(selector).requestSubmit(); await flush(); };
const lastCall = (server: ReturnType<typeof backend>, method: string, fragment: string) =>
  [...server.calls].reverse().find(c => c.method === method && c.path.includes(fragment));
const countCalls = (server: ReturnType<typeof backend>, method: string, fragment: string) =>
  server.calls.filter(c => c.method === method && c.path.includes(fragment)).length;

beforeEach(() => {
  resetOpsMemory();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
});
afterEach(() => { document.body.replaceChildren(); vi.useRealTimers(); vi.restoreAllMocks(); });

// ---------------------------------------------------------------------------

describe('routes', () => {
  it('parses and builds the promo and events routes', () => {
    const routes: [string, OpsRoute][] = [
      ['promos', { view: 'promos' }], ['events', { view: 'events', tab: 'feed' }],
      ['events/report', { view: 'events', tab: 'report' }], ['events/telegram', { view: 'events', tab: 'telegram' }],
    ];
    for (const [path, route] of routes) {
      expect(parseOpsRoute(path)).toEqual(route);
      expect(opsHash(route)).toBe(`#/${path}`);
    }
    // An unknown path inside a section opens its first screen.
    expect(parseOpsRoute('events/unknown')).toEqual({ view: 'events', tab: 'feed' });
    expect(parseOpsRoute('promos/7')).toEqual({ view: 'promos' });
    for (const other of ['eventsx', 'promo', 'monitoring', 'audit', '']) expect(parseOpsRoute(other)).toBeNull();
    expect(parseEventsTab('events/report')).toBe('report');
    expect(eventsHash('feed')).toBe('#/events');
  });

  it('builds the events query without empty filters', () => {
    expect(eventsPath({ severity: '', kind: '', offset: 0 })).toBe('/admin/api/ops/events?limit=50');
    expect(eventsPath({ severity: 'critical', kind: 'server_down', offset: 50 }))
      .toBe('/admin/api/ops/events?severity=critical&kind=server_down&limit=50&offset=50');
  });
});

describe('wire contract', () => {
  it('parses a promo code and rejects a malformed one', () => {
    expect(parsePromo(promo({ expires_at: '2026-12-01T00:00:00Z' }))).toMatchObject({ code: 'WELCOME20', percent: 20, state: 'active', redeemed: 0 });
    // service.PromoOutcome omits nothing, but a view without `redeemed` still reads as 0.
    const { redeemed: _redeemed, ...bare } = promo({});
    void _redeemed;
    expect(parsePromo(bare).redeemed).toBe(0);
    for (const bad of [null, promo({ percent: 0 }), promo({ percent: 101 }), promo({ state: 'paused' }), promo({ id: 0 }), promo({ code: 5 })]) {
      expect(() => parsePromo(bad)).toThrowError(ApiError);
    }
  });

  it('never exposes a bot token in the parsed settings', () => {
    const parsed = parseOpsSettings({ ...backend().settings(), bot_token: TOKEN });
    expect(parsed).not.toHaveProperty('bot_token');
    expect(JSON.stringify(parsed)).not.toContain(TOKEN);
    expect(parsed.own_bot).toBe(false);
    expect(() => parseOpsSettings({ ...backend().settings(), daily_report_hour: 24 })).toThrowError(ApiError);
  });

  it('parses events, the report and its figures', () => {
    expect(parseOpsEvent(event({}))).toMatchObject({ kind: 'server_down', severity: 'critical', target_id: 7, details: {} });
    expect(() => parseOpsEvent(event({ severity: 'fatal' }))).toThrowError(ApiError);
    const report = parseReport({ day: '2026-11-12', stats: STATS, text: REPORT_HTML });
    expect(report.stats.users_total).toBe(94);
    expect(report.stats.period_revenue).toEqual([{ currency: 'RUB', amount_cents: 361_800, orders: 3 }]);
    expect(parseDailyStats({ ...STATS, period_revenue: null, total_revenue: null }).period_revenue).toEqual([]);
    expect(() => parseReport({ day: '12.11.2026', stats: STATS, text: '' })).toThrowError(ApiError);
    const { users_total: _users, ...partial } = STATS;
    void _users;
    expect(() => parseDailyStats(partial)).toThrowError(ApiError);
  });
});

describe('promo helpers', () => {
  it('validates the form with the server bounds', () => {
    const now = Date.parse(NOW);
    const ok = validatePromoForm({ ...NEW_PROMO_FORM, code: ' summer20 ', percent: '20', maxActivations: '', validHours: '72' }, false, now);
    expect(ok.errors).toEqual({});
    expect(ok.input).toEqual({ code: 'SUMMER20', percent: 20, max_activations: 0, valid_hours: 72, expires_at: '', enabled: true, note: '' });

    const bad = validatePromoForm({ code: 'a', percent: '0', maxActivations: '1000001', validHours: '0', expiresAt: '2020-01-01T00:00', enabled: true, note: 'x'.repeat(201) }, false, now);
    expect(bad.input).toBeNull();
    expect(Object.keys(bad.errors).sort()).toEqual(['code', 'expiresAt', 'maxActivations', 'note', 'percent', 'validHours']);

    // Editing: the code and the percent are fixed and not validated.
    const edit = validatePromoForm({ code: '', percent: '', maxActivations: '5', validHours: '24', expiresAt: '', enabled: false, note: '' }, true, now);
    expect(edit.errors).toEqual({});
    expect(promoPatch(edit.input!)).toEqual({ max_activations: 5, valid_hours: 24, expires_at: '', enabled: false, note: '' });
  });

  it('rounds a discount like database.DiscountedAmount', () => {
    expect(discountedCents(19_900, 20)).toBe(15_920);
    expect(discountedCents(19_900, 15)).toBe(16_915);
    expect(discountedCents(999, 33)).toBe(999 - 329); // the discount is rounded down
    expect(discountedCents(19_900, 100)).toBe(0);
    expect(discountedCents(19_900, 0)).toBe(19_900);
    expect(discountedCents(0, 50)).toBe(0);
  });

  it('labels usage, validity and conversion', () => {
    expect(activationsText({ activations: 3, max_activations: 100 })).toBe('3 из 100');
    expect(activationsText({ activations: 3, max_activations: 0 })).toBe('3 · без лимита');
    expect(activationsShare({ activations: 30, max_activations: 100 })).toBe(30);
    expect(activationsShare({ activations: 500, max_activations: 100 })).toBe(100);
    expect(activationsShare({ activations: 3, max_activations: 0 })).toBeNull();
    expect([24, 72, 168, 720, 5].map(validHoursText)).toEqual(['1 день', '3 дня', '1 неделя', '30 дней', '5 часов']);
    expect(conversionText(10, 4)).toBe('40 %');
    expect(conversionText(0, 0)).toBe('—');
    expect(promoTotals([parsePromo(promo({ redeemed: 12 })), parsePromo(promo({ id: 2, state: 'disabled', activations: 0 }))]))
      .toEqual({ total: 2, active: 1, activations: 30, redeemed: 12 });
    expect(formFromPromo(parsePromo(promo({ max_activations: 0 }))).maxActivations).toBe('');
  });

  it('suggests a readable code the server accepts', () => {
    const code = suggestPromoCode('summer', () => 0);
    expect(code).toBe('SUMMER-AAAAAA');
    expect(suggestPromoCode('', () => 0.999)).toBe('PROMO-999999');
    for (let i = 0; i < 20; i++) expect(suggestPromoCode()).toMatch(/^PROMO-[A-HJ-NP-Z2-9]{6}$/);
  });
});

describe('events helpers', () => {
  it('groups the feed by day in the browser time zone', () => {
    const now = Date.parse(NOW);
    const groups = groupByDay([
      { created_at: '2026-11-12T12:00:00Z' }, { created_at: '2026-11-12T11:00:00Z' }, { created_at: '2026-11-11T12:00:00Z' },
      { created_at: '2026-11-01T12:00:00Z' },
    ], now);
    expect(groups.map(g => [g.label, g.events.length])).toEqual([['Сегодня', 2], ['Вчера', 1], ['1 ноября 2026 г.', 1]]);
  });

  it('names kinds and their subjects', () => {
    expect(kindLabel('source_expiring')).toBe('Источник скоро закончится');
    expect(kindLabel('something_new')).toBe('something_new');
    expect(['server_down', 'country_up', 'builder_disabled', 'source_expired', 'monitor_stalled', 'daily_report', 'test'].map(kindSubject))
      .toEqual(['server', 'country', 'builder', 'source', 'monitor', 'report', 'report']);
  });

  it('shows Telegram HTML as plain text', () => {
    expect(telegramPlainText('<b>Итоги</b> &lt;A&amp;B&gt; <a href="https://x">ссылка</a>')).toBe('Итоги <A&B> ссылка');
  });

  it('formats money and the report figures', () => {
    expect(formatMoney([]).replace(/\s/g, ' ')).toBe('0 ₽');
    expect(formatMoney([{ currency: 'RUB', amount_cents: 361_800, orders: 3 }, { currency: 'XTR', amount_cents: 250, orders: 2 }]).replace(/\s/g, ' '))
      .toBe('3 618 ₽ · 250 ★');
    expect(formatMoney([{ currency: 'RUB', amount_cents: 126_850, orders: 1 }]).replace(/\s/g, ' ')).toBe('1 268,50 ₽');
    expect(reportDayText('2026-11-12')).toBe('12.11.2026');

    const { business, infra } = reportFigures(parseDailyStats(STATS));
    const figure = (label: string) => [...business, ...infra].find(f => f.label === label);
    expect(figure('Пользователей')).toMatchObject({ value: '94', note: 'за день +2', tone: 'ok' });
    expect(figure('Продаж за день')?.value.replace(/\s/g, ' ')).toBe('3 618 ₽');
    expect(figure('Открытых инцидентов')).toMatchObject({ value: '1', tone: 'down' });
    expect(figure('Источников')).toMatchObject({ value: '3', tone: 'ok' });
    expect(figure('Платных истекает за 3 дня')?.tone).toBe('warn');
  });
});

describe('telegram settings helpers', () => {
  const settings = (over: Partial<OpsSettings> = {}): OpsSettings => ({ ...parseOpsSettings(backend().settings()), ...over });

  it('sends the token only when it changes', () => {
    const s = settings();
    expect(opsSave(opsForm(s), s).save).toEqual({
      version: 3, enabled: true, chat_id: 0, notify_servers: true, notify_countries: true, notify_sources: true,
      daily_report: true, daily_report_hour: 9,
    });
    expect(opsSave({ ...opsForm(s), useMainBot: false, botToken: TOKEN }, s).save?.bot_token).toBe(TOKEN);
    // A separate bot is configured: keeping it sends no token, the main bot clears it.
    const own = settings({ own_bot: true });
    expect(opsSave(opsForm(own), own).save).not.toHaveProperty('bot_token');
    expect(opsSave({ ...opsForm(own), useMainBot: true }, own).save?.bot_token).toBe('');
  });

  it('rejects a bad chat, token and hour', () => {
    const s = settings();
    expect(opsSave({ ...opsForm(s), chatId: 'abc' }, s).errors.chatId).toBeDefined();
    expect(opsSave({ ...opsForm(s), chatId: '-1001234567890' }, s).save?.chat_id).toBe(-1001234567890);
    expect(opsSave({ ...opsForm(s), useMainBot: false, botToken: 'nope' }, s).errors.botToken).toBeDefined();
    expect(opsSave({ ...opsForm(s), useMainBot: false, botToken: '' }, s).errors.botToken).toBeDefined();
    expect(opsSave({ ...opsForm(s), dailyReportHour: '24' }, s).errors.dailyReportHour).toBeDefined();
    expect(BOT_TOKEN_PATTERN.test(TOKEN)).toBe(true);
  });

  it('explains the rejections of the API', () => {
    expect(opsErrorText(new ApiError('promo_code_taken', 409))).toContain('Такой код уже есть');
    expect(opsErrorText(new ApiError('ops_send_failed', 502))).toContain('Telegram не доставил');
    expect(opsErrorText(new ApiError('invalid_promo', 400, 0, 'percent'))).toContain('от 1 до 100');
    expect(opsErrorText(new ApiError('not_found', 404))).toContain('уже удалили');
  });
});

// ---------------------------------------------------------------------------
// Screens

describe('promo codes screen', () => {
  it('lists the codes with usage, state and a summary', async () => {
    const { page } = await mount(backend(), { view: 'promos' });
    expect(all('.ops-kpis .kpi-value').map(n => n.textContent)).toEqual(['2', '1', '30', '12']);
    expect(all('.ops-promo-table thead th').map(n => n.textContent))
      .toEqual(['Код', 'Скидка', 'Активации', 'Оплачено', 'Скидка действует', 'Код действует до', 'Статус', 'Действия']);
    const rows = all('.ops-promo-table tbody tr');
    expect(rows).toHaveLength(2);
    const cells = Array.from(rows[0].querySelectorAll('td')).map(td => (td.textContent ?? '').replace(/\s/g, ' '));
    expect(cells[0]).toBe('WELCOME20Канал');
    expect(cells.slice(1, 3)).toEqual(['20 %', '30 из 100']);
    expect(cells[3]).toBe('12конверсия 40 %');
    expect(cells.slice(4, 7)).toEqual(['3 дня', 'Без срока', 'Действует']);
    expect($('.ops-meter').getAttribute('aria-label')).toBe('Использовано 30 % лимита');
    expect(rows[1].querySelector('.badge')?.textContent).toBe('Отключён');
    expect(pageText()).toContain('кнопка «🎟 Промокод» рядом с «Купить Premium»');
    expect(page.header.querySelector('#promo-create')).not.toBeNull();
  });

  it('offers to create the first code when the list is empty', async () => {
    const server = backend();
    server.promos.length = 0;
    await mount(server, { view: 'promos' });
    expect(text('.empty-title')).toBe('Промокодов пока нет');
    $<HTMLButtonElement>('.empty .btn').click();
    await flush();
    expect(document.activeElement).toBe($('#promo-code'));
  });

  it('creates a code: upper case, presets, price example, request key', async () => {
    const server = backend();
    const { host } = await mount(server, { view: 'promos' });
    await click('#promo-create');
    type('#promo-code', 'summer');
    expect($<HTMLInputElement>('#promo-code').value).toBe('SUMMER');
    chip('20 %').click();
    expect($<HTMLInputElement>('#promo-percent').value).toBe('20');
    expect(chip('20 %').getAttribute('aria-pressed')).toBe('true');
    expect(text('#promo-example')).toBe('Пример: тариф за 199 ₽ со скидкой 20 % будет стоить 159,20 ₽.');
    chip('1 неделя').click();
    expect(text('#promo-hours-hint')).toContain('= 1 неделя.');
    expect(host.unsaved()).toBe(true);
    await submit('.ops-form');

    const sent = lastCall(server, 'POST', '/admin/api/promos')?.body;
    expect(sent).toMatchObject({ code: 'SUMMER', percent: 20, max_activations: 0, valid_hours: 168, expires_at: '', enabled: true, note: '' });
    expect(String(sent?.request_key)).toMatch(/^ui-[0-9a-f]{32}$/);
    expect(all('.ops-promo-table tbody tr')).toHaveLength(3);
    expect(text('#promo-status')).toContain('Промокод SUMMER создан');
    expect($('#promo-editor-slot').childElementCount).toBe(0);
    expect(host.unsaved()).toBe(false);
  });

  it('explains a 100 % discount and marks invalid fields without a request', async () => {
    const server = backend();
    await mount(server, { view: 'promos' });
    await click('#promo-create');
    chip('100 %').click();
    expect(text('#promo-example')).toContain('получает любой тариф бесплатно');
    await submit('.ops-form');
    expect(text('#promo-code-error')).toContain('3–32 символа');
    expect($('#promo-code').getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe($('#promo-code'));
    expect(countCalls(server, 'POST', '/admin/api/promos')).toBe(0);
  });

  it('shows a taken code on its field and keeps the form', async () => {
    const server = backend({ createFailure: new ApiError('promo_code_taken', 409) });
    await mount(server, { view: 'promos' });
    await click('#promo-create');
    type('#promo-code', 'WELCOME20');
    await submit('.ops-form');
    expect(text('#promo-code-error')).toContain('Такой код уже есть');
    expect($<HTMLInputElement>('#promo-code').value).toBe('WELCOME20');
    expect($<HTMLButtonElement>('#promo-save').disabled).toBe(false);
  });

  it('retries an uncertain create with the same request key', async () => {
    const server = backend({ createFailure: new ApiError('network') });
    await mount(server, { view: 'promos' });
    await click('#promo-create');
    type('#promo-code', 'RETRY10');
    await submit('.ops-form');
    expect(pageText()).toContain('запрос уйдёт с тем же ключом');
    await submit('.ops-form');
    const keys = server.calls.filter(c => c.method === 'POST').map(c => c.body?.request_key);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it('edits only the mutable part of a code', async () => {
    const server = backend();
    await mount(server, { view: 'promos' });
    await click('#promo-edit-1');
    expect($<HTMLInputElement>('#promo-code').disabled).toBe(true);
    expect($<HTMLInputElement>('#promo-percent').disabled).toBe(true);
    expect(text('#promo-max-hint')).toContain('Уже активировано: 30.');
    await submit('.ops-form');
    expect(pageText()).toContain('Нет изменений для сохранения.');
    type('#promo-max', '200');
    await submit('.ops-form');
    const sent = lastCall(server, 'PATCH', '/admin/api/promos/1')?.body;
    expect(sent).toMatchObject({ version: 1, max_activations: 200, valid_hours: 72, expires_at: '', enabled: true, note: 'Канал' });
    expect(sent).not.toHaveProperty('code');
    expect(sent).not.toHaveProperty('percent');
    // The redemption count of the list survives the mutation outcome.
    const cells = Array.from(all('.ops-promo-table tbody tr')[0].querySelectorAll('td')).map(td => td.textContent);
    expect(cells[2]).toBe('30 из 200');
    expect(cells[3]).toContain('12');
  });

  it('switches a code off and on with its version', async () => {
    const server = backend();
    await mount(server, { view: 'promos' });
    await click('#promo-toggle-1');
    expect(lastCall(server, 'PATCH', '/admin/api/promos/1')?.body).toMatchObject({ version: 1, enabled: false, max_activations: 100 });
    expect(all('.ops-promo-table tbody tr')[0].querySelector('.badge')?.textContent).toBe('Отключён');
    expect(text('#promo-status')).toContain('уже выданные скидки действуют до своего срока');
    expect(document.activeElement).toBe($('#promo-toggle-1'));
    await click('#promo-toggle-1');
    expect(lastCall(server, 'PATCH', '/admin/api/promos/1')?.body).toMatchObject({ version: 2, enabled: true });
  });

  it('reloads the list when a code was changed in another session', async () => {
    const server = backend();
    await mount(server, { view: 'promos' });
    server.promos[0].version = 5;
    await click('#promo-toggle-1');
    expect(text('#promo-status')).toContain('изменили в другой сессии');
    expect(countCalls(server, 'GET', '/admin/api/promos')).toBe(2);
  });

  it('never deletes an activated code and deletes an unused one after confirmation', async () => {
    const server = backend();
    const { host } = await mount(server, { view: 'promos' });
    await click('#promo-delete-1');
    expect(text('#promo-status')).toContain('удалить его нельзя');
    expect(host.confirm).not.toHaveBeenCalled();
    expect(countCalls(server, 'DELETE', '/admin/api/promos')).toBe(0);

    await click('#promo-delete-2');
    expect(host.confirm).toHaveBeenCalledTimes(1);
    expect(lastCall(server, 'DELETE', '/admin/api/promos/2')?.body).toMatchObject({ version: 1 });
    expect(all('.ops-promo-table tbody tr')).toHaveLength(1);
    expect(text('#promo-status')).toContain('Промокод FRIENDS удалён.');
  });

  it('keeps the list when the deletion is not confirmed', async () => {
    const server = backend();
    await mount(server, { view: 'promos' }, false);
    await click('#promo-delete-2');
    expect(countCalls(server, 'DELETE', '/admin/api/promos')).toBe(0);
    expect(all('.ops-promo-table tbody tr')).toHaveLength(2);
  });

  it('asks before dropping unsaved editor changes', async () => {
    const server = backend();
    const { host } = await mount(server, { view: 'promos' }, false);
    await click('#promo-create');
    await click('#promo-cancel'); // nothing typed: closes without a question
    expect(host.confirm).not.toHaveBeenCalled();
    expect($('#promo-editor-slot').childElementCount).toBe(0);

    await click('#promo-create');
    type('#promo-note', 'черновик');
    await click('#promo-cancel');
    expect(host.confirm).toHaveBeenCalledTimes(1);
    expect($('#promo-editor-slot').childElementCount).toBe(1);
    expect(host.unsaved()).toBe(true);
  });

  it('shows a retry panel when the list fails to load', async () => {
    const server = backend();
    server.request.mockRejectedValueOnce(new ApiError('network'));
    await mount(server, { view: 'promos' });
    expect(text('.empty-title')).toBe('Не удалось загрузить промокоды');
    $<HTMLButtonElement>('.empty .btn').click();
    await flush();
    expect(all('.ops-promo-table tbody tr')).toHaveLength(2);
  });
});

describe('event feed', () => {
  it('groups events by day with a severity marker and a text label', async () => {
    await mount(backend(), { view: 'events', tab: 'feed' });
    expect(all('.wu-tab').map(a => [a.textContent, a.getAttribute('href')]))
      .toEqual([['Лента событий', '#/events'], ['Итоги дня', '#/events/report'], ['Уведомления в Telegram', '#/events/telegram']]);
    expect($('.wu-tab[aria-current="page"]').textContent).toBe('Лента событий');
    expect(all('.ops-day').map(n => n.textContent)).toEqual(['Сегодня', 'Вчера']);
    const items = all('.ops-event');
    expect(items.map(n => n.className)).toEqual(['ops-event is-down', 'ops-event is-ok', 'ops-event is-info']);
    // Colour never stands alone: every event names its severity.
    expect(all('.ops-sev').map(n => n.textContent)).toEqual(['Критично', 'Восстановлено', 'Инфо']);
    expect(items[0].querySelector('.ops-event-title')?.textContent).toBe('Сервер недоступен');
    expect(items[0].querySelector('.ops-event-text')?.textContent).toContain('причина: нет ответа');
    expect(items[0].querySelector('.ops-event-meta')?.textContent).toContain('Сервер · Сервер недоступен');
    expect(items[0].querySelector('.ops-event-meta')?.textContent).toContain('Отправлено в Telegram');
    expect(items[1].querySelector('.ops-event-meta')?.textContent).toContain('Без уведомления');
    expect(text('.toolbar-meta')).toBe('Найдено: 3');
  });

  it('collapses a daily report and shows it as text, never as markup', async () => {
    await mount(backend(), { view: 'events', tab: 'feed' });
    const report = all('.ops-event')[2];
    const details = report.querySelector('details');
    expect(details?.querySelector('summary')?.textContent).toBe('Показать отчёт');
    expect(details?.querySelector('pre')?.textContent).toContain('Итоги дня — 12.11.2026');
    expect(details?.querySelector('pre')?.textContent).toContain('Источник <A&B>');
    expect(report.querySelector('b')).toBeNull();
    expect(report.querySelector('.ops-notify.is-failed')?.textContent).toBe('Не доставлено');
    expect(report.querySelector('.error-text')?.textContent).toContain('bot was blocked');
  });

  it('filters by severity and kind and resets', async () => {
    const server = backend();
    await mount(server, { view: 'events', tab: 'feed' });
    await click('#ops-sev-critical');
    expect(lastCall(server, 'GET', '/ops/events')?.path).toBe('/admin/api/ops/events?severity=critical&limit=50');
    expect($('#ops-sev-critical').getAttribute('aria-pressed')).toBe('true');
    expect(all('.ops-event')).toHaveLength(1);
    expect(document.activeElement).toBe($('#ops-sev-critical'));

    choose('#ops-kind', 'server_up');
    await flush();
    expect(lastCall(server, 'GET', '/ops/events')?.path).toBe('/admin/api/ops/events?severity=critical&kind=server_up&limit=50');
    expect(text('.empty-title')).toBe('Нет событий по этим условиям');

    await click('#ops-reset');
    expect(lastCall(server, 'GET', '/ops/events')?.path).toBe('/admin/api/ops/events?limit=50');
    expect(all('.ops-event')).toHaveLength(3);
    expect(document.querySelector('#ops-reset')).toBeNull();
  });

  it('lists every kind of the backend in the filter', async () => {
    await mount(backend(), { view: 'events', tab: 'feed' });
    const kinds = Array.from($<HTMLSelectElement>('#ops-kind').options).map(o => o.value).filter(Boolean);
    // Every database.OpsKind* that service.OpsService records (builder_degraded
    // is reserved: partial failures are reported per country).
    expect(kinds.sort()).toEqual([
      'builder_disabled', 'builder_down', 'builder_up', 'country_degraded', 'country_down', 'country_removed',
      'country_up', 'daily_report', 'monitor_recovered', 'monitor_stalled', 'server_down', 'server_removed', 'server_up',
      'source_disabled', 'source_expired', 'source_expiring', 'source_failing', 'source_recovered', 'test',
    ]);
  });

  it('pages a long feed', async () => {
    const many = Array.from({ length: 120 }, (_, i) => event({ id: i + 1, created_at: new Date(Date.parse(NOW) - i * 60_000).toISOString() }));
    const server = backend({ events: many });
    await mount(server, { view: 'events', tab: 'feed' });
    expect(all('.ops-event')).toHaveLength(50);
    expect(text('.pager-range')).toBe('С 1 по 50 из 120');
    await click('[data-pager="next"]');
    expect(lastCall(server, 'GET', '/ops/events')?.path).toBe('/admin/api/ops/events?limit=50&offset=50');
    expect(text('.pager-page')).toBe('Страница 2 из 3');
  });

  it('says that an empty feed is good news', async () => {
    await mount(backend({ events: [] }), { view: 'events', tab: 'feed' });
    expect(text('.empty-title')).toBe('Событий пока нет');
    expect(text('.empty-text')).toContain('сбоев не было');
  });
});

describe('daily report', () => {
  it('shows the figures of the day with markers and the Telegram text', async () => {
    const server = backend();
    await mount(server, { view: 'events', tab: 'report' });
    expect(lastCall(server, 'GET', '/ops/report')?.path).toBe('/admin/api/ops/report?day=today');
    expect($('#ops-day-today').getAttribute('aria-pressed')).toBe('true');
    expect(text('.toolbar-meta')).toContain('12.11.2026 · день ещё идёт');
    expect(all('.ops-figure')).toHaveLength(16);
    const figure = (label: string) => all('.ops-figure').find(n => n.querySelector('dt')?.textContent === label);
    expect((figure('Продаж за день')?.querySelector('.ops-figure-value')?.textContent ?? '').replace(/\s/g, ' ')).toBe('3 618 ₽');
    expect(figure('Продаж за день')?.className).toBe('ops-figure is-ok');
    expect(figure('Открытых инцидентов')?.className).toBe('ops-figure is-down');
    expect(figure('Источников')?.className).toBe('ops-figure is-ok');
    expect(figure('Пользователей')?.querySelector('.ops-figure-note')?.textContent).toBe('за день +2');
    expect(text('.ops-telegram')).toContain('Итоги дня — 12.11.2026');
    expect(document.querySelector('.ops-telegram b')).toBeNull();
    expect(pageText()).toContain('приходит каждый день в 09:00 по Москве');
  });

  it('switches to yesterday and remembers the choice', async () => {
    const server = backend();
    await mount(server, { view: 'events', tab: 'report' });
    await click('#ops-day-yesterday');
    expect(lastCall(server, 'GET', '/ops/report')?.path).toBe('/admin/api/ops/report?day=yesterday');
    expect(text('.toolbar-meta')).toContain('11.11.2026 · полные сутки');
    expect(document.activeElement).toBe($('#ops-day-yesterday'));
    await mount(server, { view: 'events', tab: 'report' });
    expect($('#ops-day-yesterday').getAttribute('aria-pressed')).toBe('true');
  });
});

describe('telegram notifications', () => {
  it('shows where messages go and saves without touching the token', async () => {
    const server = backend();
    const { host } = await mount(server, { view: 'events', tab: 'telegram' });
    expect(text('#ops-set-state')).toBe('События и отчёт приходят в чат 777 (администратор) от основного бота.');
    expect($('#ops-set-token').closest<HTMLElement>('.field')?.hidden).toBe(true);
    expect(pageText()).toContain('Последний отчёт: за 11.11.2026.');
    expect(host.unsaved()).toBe(false);

    choose('#ops-set-hour', '21');
    choose('#ops-set-sources', 'off');
    type('#ops-set-chat', '-1001234567890');
    expect(host.unsaved()).toBe(true);
    await click('#ops-save');
    const sent = lastCall(server, 'PUT', '/admin/api/ops')?.body;
    expect(sent).toMatchObject({ version: 3, enabled: true, chat_id: -1001234567890, notify_sources: false, daily_report_hour: 21 });
    expect(sent).not.toHaveProperty('bot_token');
    expect(pageText()).toContain('Настройки сохранены.');
    expect(host.unsaved()).toBe(false);
    expect(text('#ops-set-state')).toContain('в чат -1001234567890');
  });

  it('requires a token for a separate bot and sends it once', async () => {
    const server = backend();
    await mount(server, { view: 'events', tab: 'telegram' });
    choose('#ops-bot-own', 'on');
    expect($('#ops-set-token').closest<HTMLElement>('.field')?.hidden).toBe(false);
    expect($<HTMLInputElement>('#ops-set-token').type).toBe('password');
    await click('#ops-save');
    expect(text('#ops-set-token-error')).toContain('Вставьте токен отдельного бота');
    expect(countCalls(server, 'PUT', '/admin/api/ops')).toBe(0);

    type('#ops-set-token', TOKEN);
    await click('#ops-save');
    expect(lastCall(server, 'PUT', '/admin/api/ops')?.body?.bot_token).toBe(TOKEN);
    // Saved: the token is never shown again, only the fact that a bot is configured.
    expect($<HTMLInputElement>('#ops-set-token').value).toBe('');
    expect($<HTMLInputElement>('#ops-set-token').placeholder).toContain('Токен сохранён');
    expect(document.body.innerHTML).not.toContain(TOKEN);
  });

  it('switches back to the main bot by clearing the stored token', async () => {
    const server = backend({ ownBot: true });
    await mount(server, { view: 'events', tab: 'telegram' });
    expect($<HTMLInputElement>('#ops-bot-own').checked).toBe(true);
    choose('#ops-bot-main', 'on');
    await click('#ops-save');
    expect(lastCall(server, 'PUT', '/admin/api/ops')?.body?.bot_token).toBe('');
  });

  it('explains what switching the notifications off means', async () => {
    await mount(backend(), { view: 'events', tab: 'telegram' });
    choose('#ops-set-enabled', 'off');
    expect(text('#ops-set-state')).toBe('Уведомления выключены: события остаются в ленте, в Telegram ничего не уходит.');
    choose('#ops-set-report', 'off');
    expect($('#ops-set-hour').closest<HTMLElement>('.field')?.hidden).toBe(true);
  });

  it('sends a test only by the saved settings and reports a failed delivery', async () => {
    const server = backend();
    await mount(server, { view: 'events', tab: 'telegram' });
    choose('#ops-set-hour', '10');
    await click('#ops-test');
    expect(pageText()).toContain('Сначала сохраните изменения');
    expect(countCalls(server, 'POST', '/ops/test')).toBe(0);
    choose('#ops-set-hour', '9');
    await click('#ops-test');
    expect(countCalls(server, 'POST', '/ops/test')).toBe(1);
    expect(pageText()).toContain('Тестовое сообщение отправлено.');

    await mount(backend({ testFails: true }), { view: 'events', tab: 'telegram' });
    await click('#ops-test');
    expect(pageText()).toContain('Telegram не доставил сообщение.');
    expect($<HTMLButtonElement>('#ops-test').disabled).toBe(false);
  });

  it('offers to reload after a version conflict', async () => {
    const server = backend({ staleSettings: true });
    await mount(server, { view: 'events', tab: 'telegram' });
    choose('#ops-set-hour', '12');
    await click('#ops-save');
    expect(pageText()).toContain('Настройки изменили в другой сессии.');
    expect($<HTMLButtonElement>('#ops-save').disabled).toBe(false);
    expect(Array.from(document.querySelectorAll('.notice-actions button')).map(b => b.textContent)).toEqual(['Обновить данные']);
  });
});

describe('screen lifecycle', () => {
  it('drops a response that arrives after the route changed', async () => {
    const server = backend();
    let release: (value: unknown) => void = () => undefined;
    server.request.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const { screen } = await mount(server, { view: 'promos' }, true, false);
    screen.dispose();
    release({ promos: server.promos });
    await flush();
    expect(document.querySelector('.ops-promo-table')).toBeNull();
  });
});
