import { test, expect } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

// Tariff editor of the browser admin panel against a mock backend that
// follows the real contract:
//   routes    internal/web/admin_tariff_api.go (bodies, unknown fields, codes)
//   сборка    a tariff is sold on a builder ("сборка"): the panel sends
//             builder_id and never a plan; the plan behind it is internal
//             (database/builder_plans.go) and is never shown
//   rules     database.UpdateTariff / SetTariffActive / ReorderTariffs /
//             DeleteTariff (optimistic version, versioning of used tariffs,
//             retired versions, complete reorder lists, in-use protection)
//   replay    runAdminConfigMutation (same key + same payload replays the
//             recorded outcome, same key + other payload is a conflict)

const CSRF = 'c'.repeat(43);
const KEY_PATTERN = /^ui-[0-9a-f]{32}$/;
const T0 = '2026-09-20T08:00:00Z';

interface Row {
  /** builder_id null: a tariff of the old model whose plan never had a сборка. */
  id: number; name: string; builder_id: number | null; duration_days: number; price_cents: number; currency: string;
  is_active: boolean; description: string; features: string[]; badge: string; sort_order: number; version: number;
  previous_id: number | null; orders: number; subscriptions: number; created_at: string; updated_at: string;
}

/** The internal plan of a tariff without a сборка: must never reach the screen. */
const LEGACY_PLAN_NAME = 'test-customer-1';

/** service.TariffPlanView source: a plan has no device or traffic limits. */
interface Plan {
  id: number; name: string; is_active: boolean; builder: number | null; selectable: boolean;
  /** database.ListAdminPlans: subscriptions of the plan in every status. */
  subscriptions: number;
}

interface Call { method: string; path: string; body: Record<string, unknown> }

interface Options {
  rows?: Partial<Row>[];
  /** GET /admin/api/tariffs answered with 500 this many times. */
  listFailures?: number;
  /** Mutations whose response is lost after the commit. */
  lostResponses?: number;
  /** Ids of the сборки that exist (default: both). */
  builders?: number[];
}

// «Основной» serves the whole source; «Резервный» has no source yet.
const BUILDERS = [
  { id: 2, name: 'Основной', description: '', enabled: true, profile_title: '', support_url: '', announce: '', version: 1, sources: [{ source_id: 1, position: 0 }], items: [], dependents: { plans: [], subscriptions: 0 }, sales: { plan_id: 102, clients: 2 }, created_at: T0, updated_at: T0 },
  { id: 5, name: 'Резервный', description: '', enabled: true, profile_title: '', support_url: '', announce: '', version: 1, sources: [], items: [], dependents: { plans: [], subscriptions: 0 }, sales: { plan_id: null, clients: 0 }, created_at: T0, updated_at: T0 },
];

const SOURCES = [{
  id: 1, name: 'Provider A', type: 'auto', description: '', enabled: true, last_sync_at: T0, last_sync_status: 'ok', last_sync_error: '',
  catalogue: { entries: 5, countries: 2, no_country: 1, absent: 0, by_country: [{ code: 'DE', count: 3 }, { code: 'NL', count: 1 }], protocols: { vless: 5 } },
  expires_at: null, expired: false, dependents: { builders: [{ id: 2, name: 'Основной' }], subscriptions: 0 }, created_at: T0, updated_at: T0,
}];

const CREATE_FIELDS = ['request_key', 'name', 'builder_id', 'duration_days', 'price_cents', 'currency', 'description', 'features', 'badge', 'sort_order', 'is_active'];

function row(over: Partial<Row> & { id: number }): Row {
  return {
    name: `Тариф ${over.id}`, builder_id: 2, duration_days: 30, price_cents: 19900, currency: 'RUB', is_active: true,
    description: '', features: [], badge: '', sort_order: 0, version: 1, previous_id: null, orders: 0, subscriptions: 0,
    created_at: T0, updated_at: T0, ...over,
  };
}

async function backend(page: Page, options: Options = {}) {
  const rows: Row[] = (options.rows ?? [
    { id: 1, name: 'Месяц', price_cents: 19900, sort_order: 0, orders: 3, subscriptions: 2, badge: 'Хит' },
    { id: 2, name: 'Квартал', duration_days: 90, price_cents: 49900, sort_order: 1 },
    { id: 3, name: 'Звёзды', currency: 'XTR', price_cents: 150, sort_order: 2, is_active: false },
  ]).map(item => row(item as Partial<Row> & { id: number }));
  // Plans are internal: the sale plan of «Основной» (named after it) and the
  // system plans database.TrialPlanName / FreePlanName.
  const plans: Plan[] = [
    { id: 3, name: 'Основной', is_active: true, builder: 2, selectable: true, subscriptions: 21 },
    { id: 1, name: 'trial', is_active: true, builder: null, selectable: false, subscriptions: 5 },
    { id: 6, name: 'free', is_active: true, builder: null, selectable: false, subscriptions: 21 },
  ];
  const builders = BUILDERS.filter(b => (options.builders ?? [2, 5]).includes(b.id));
  let nextId = Math.max(0, ...rows.map(item => item.id)) + 1;
  let auditId = 0;
  let listFailures = options.listFailures ?? 0;
  let lostResponses = options.lostResponses ?? 0;
  let authenticated = true;
  let clock = Date.parse(T0);
  const calls: Call[] = [];
  const problems: string[] = [];
  const recorded = new Map<string, { hash: string; status: number; payload: Record<string, unknown> }>();

  const now = () => new Date(clock += 60_000).toISOString();
  const planOf = (id: number) => plans.find(item => item.id === id);
  const successorOf = (id: number) => rows.find(item => item.previous_id === id)?.id ?? null;
  // service.TariffView: the plan is named after the сборка it serves.
  const view = (item: Row) => {
    const builder = BUILDERS.find(b => b.id === item.builder_id);
    return {
      ...item, offer_id: String(item.id).padStart(32, '0'), plan_id: item.builder_id === null ? 90 : 100 + item.builder_id,
      plan_name: builder?.name ?? LEGACY_PLAN_NAME, plan_active: true, builder_name: builder?.name ?? '',
      replaced_by_id: successorOf(item.id), in_use: item.orders > 0 || item.subscriptions > 0, offer_ends_at: null,
    };
  };
  const ordered = () => [...rows].sort((a, b) => a.sort_order - b.sort_order || a.price_cents - b.price_cents || a.id - b.id);
  const planView = (plan: Plan) => ({
    id: plan.id, name: plan.name, is_active: plan.is_active,
    subscription_builder_id: plan.builder, builder_name: BUILDERS.find(b => b.id === plan.builder)?.name ?? '',
    tariffs: 0, subscriptions: plan.subscriptions, selectable: plan.selectable,
  });
  const json = (route: Route, status: number, payload: unknown) =>
    route.fulfill({ status, contentType: 'application/json', headers: { 'Cache-Control': 'no-store' }, body: JSON.stringify(payload) });

  /** database.TariffInput.Validate + ensureBuilderSalePlan; the offending field or ''. */
  const invalidField = (body: Record<string, unknown>) => {
    const name = String(body.name ?? '').trim();
    if (!name || Array.from(name).length > 64) return 'name';
    if (!builders.some(b => b.id === body.builder_id)) return 'builder_id';
    if (!Number.isInteger(body.duration_days) || (body.duration_days as number) < 1 || (body.duration_days as number) > 3650) return 'duration_days';
    // 0 is a free tariff.
    if (!Number.isInteger(body.price_cents) || (body.price_cents as number) < 0) return 'price_cents';
    if (!/^[A-Z]{3}$/.test(String(body.currency))) return 'currency';
    if (!Array.isArray(body.features) || body.features.length > 8) return 'features';
    return '';
  };
  const content = (body: Record<string, unknown>) => ({
    name: String(body.name).trim(), builder_id: Number(body.builder_id), duration_days: Number(body.duration_days),
    price_cents: Number(body.price_cents), currency: String(body.currency), description: String(body.description).trim(),
    features: (body.features as string[]).map(item => item.trim()).filter(Boolean), badge: String(body.badge).trim(),
    is_active: Boolean(body.is_active),
  });
  const outcome = (target: Row | undefined, previous: Row | null, versioned: boolean) => ({
    tariff: target ? view(target) : null, previous: previous ? view(previous) : null, versioned, replayed: false,
    audit: { id: ++auditId, actor: 'admin', success: true },
  });

  /** One mutation; returns [status, payload]. */
  const mutate = (method: string, path: string, body: Record<string, unknown>): [number, Record<string, unknown>] => {
    const reorder = path === '/admin/api/tariffs/reorder';
    const item = /^\/admin\/api\/tariffs\/(\d+)(?:\/(enable|disable))?$/.exec(path);
    if (method === 'POST' && path === '/admin/api/tariffs') {
      const field = invalidField(body);
      if (field) return [400, { error: 'invalid_tariff', field }];
      const created = row({
        id: nextId++, ...content(body), sort_order: body.sort_order === undefined ? Math.max(-1, ...rows.map(r => r.sort_order)) + 1 : Number(body.sort_order),
        created_at: now(), updated_at: now(),
      });
      rows.push(created);
      return [201, outcome(created, null, false)];
    }
    if (reorder && method === 'POST') {
      const ids = body.ids as number[];
      if (ids.length !== rows.length || !rows.every(r => ids.includes(r.id))) return [409, { error: 'order_stale' }];
      ids.forEach((id, index) => {
        const target = rows.find(r => r.id === id)!;
        if (target.sort_order !== index) { target.sort_order = index; target.version++; }
      });
      return [200, { tariffs: ordered().map(view), replayed: false, audit: { id: ++auditId } }];
    }
    if (!item) return [404, { error: 'not_found' }];
    const target = rows.find(r => r.id === Number(item[1]));
    if (!target) return [404, { error: 'not_found' }];
    if (target.version !== body.version) return [409, { error: 'version_conflict' }];
    const inUse = target.orders > 0 || target.subscriptions > 0;
    if (method === 'DELETE') {
      if (inUse) return [409, { error: 'tariff_in_use' }];
      rows.splice(rows.indexOf(target), 1);
      return [200, { deleted: target.id, ...outcome(undefined, null, false) }];
    }
    if (item[2]) {
      const active = item[2] === 'enable';
      if (active && successorOf(target.id) !== null) return [409, { error: 'tariff_superseded' }];
      Object.assign(target, { is_active: active, version: target.version + 1, updated_at: now() });
      return [200, outcome(target, null, false)];
    }
    if (method === 'PATCH') {
      if (successorOf(target.id) !== null) return [409, { error: 'tariff_superseded' }];
      const field = invalidField(body);
      if (field) return [400, { error: 'invalid_tariff', field }];
      const next = content(body);
      // A tariff without a сборка gets one in place: its plan adopts the сборка,
      // which is not a change of the purchase terms.
      const sameBuilder = target.builder_id === null || next.builder_id === target.builder_id;
      const sameTerms = next.name === target.name && sameBuilder && next.duration_days === target.duration_days &&
        next.price_cents === target.price_cents && next.currency === target.currency;
      const order = body.sort_order === undefined ? target.sort_order : Number(body.sort_order);
      if (inUse && !sameTerms) {
        Object.assign(target, { is_active: false, version: target.version + 1, updated_at: now() });
        const successor = row({ id: nextId++, ...next, sort_order: order, previous_id: target.id, created_at: now(), updated_at: now() });
        rows.push(successor);
        return [200, outcome(successor, target, true)];
      }
      Object.assign(target, next, { sort_order: order, version: target.version + 1, updated_at: now() });
      return [200, outcome(target, null, false)];
    }
    return [405, { error: 'method_not_allowed' }];
  };

  await page.route('**/admin/**', async route => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    const method = request.method();
    const session = { authenticated, csrf_token: CSRF };

    if ((pathname === '/admin/login' || pathname === '/admin/session') && method === 'GET') return json(route, 200, session);
    if (!authenticated) return json(route, 401, { error: 'unauthorized' });
    if (method === 'GET') {
      if (pathname === '/admin/api/tariffs') {
        if (listFailures > 0) { listFailures--; return json(route, 500, { error: 'internal' }); }
        return json(route, 200, { tariffs: ordered().map(view) });
      }
      const one = /^\/admin\/api\/tariffs\/(\d+)$/.exec(pathname);
      if (one) {
        const target = rows.find(item => item.id === Number(one[1]));
        return target ? json(route, 200, view(target)) : json(route, 404, { error: 'not_found' });
      }
      if (pathname === '/admin/api/plans') return json(route, 200, { plans: plans.map(planView) });
      if (pathname === '/admin/api/builders') return json(route, 200, { builders });
      if (pathname === '/admin/api/sources') return json(route, 200, { sources: SOURCES });
      // A linked customer on the sale plan of «Основной» (same wire shape as subscription-management.spec.ts).
      if (pathname === '/admin/api/users/1001') {
        const plan = planOf(3)!;
        return json(route, 200, {
          subscription: {
            id: 42, telegram_id: 1001, username: 'anya', status: 'active', expires_at: '2026-10-10T12:00:00Z', plan_id: 3,
            plan_name: plan.name, provider_source_id: null, product_id: 1, is_paid: true, price_paid_cents: 19900, currency: 'RUB',
            referred_by: null, started_at: T0, last_request: T0, created_at: T0, updated_at: T0, reminders_sent: 0, devices: 1, ips: 1,
          },
          plan: { id: plan.id, name: plan.name, is_active: plan.is_active, subscription_builder_id: plan.builder },
          audit: [],
        });
      }
      problems.push(`unexpected GET ${pathname}`);
      return json(route, 404, { error: 'not_found' });
    }

    const headers = request.headers();
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(request.postData() ?? '{}') as Record<string, unknown>; } catch { problems.push(`bad json ${pathname}`); }
    calls.push({ method, path: pathname, body });
    if (headers['x-csrf-token'] !== CSRF) { problems.push(`csrf ${pathname}`); return json(route, 403, { error: 'forbidden' }); }
    if (headers['content-type']?.split(';')[0].trim() !== 'application/json') { problems.push(`content type ${pathname}`); return json(route, 415, { error: 'unsupported_media_type' }); }

    const planBuilder = /^\/admin\/api\/plans\/(\d+)\/builder$/.exec(pathname);
    if (planBuilder && method === 'POST') {
      const plan = planOf(Number(planBuilder[1]));
      if (!plan) return json(route, 404, { error: 'not_found' });
      plan.builder = body.builder_id as number | null;
      return json(route, 200, { audit: { id: ++auditId, actor: 'admin', action: 'plan_builder', target_type: 'plan', target_id: plan.id, created_at: now(), success: true } });
    }

    // web.tariffBody / tariffUpdateBody / tariffVersionBody / tariffReorderBody: unknown fields are rejected.
    const isCreate = method === 'POST' && pathname === '/admin/api/tariffs';
    const allowed = isCreate ? CREATE_FIELDS : method === 'PATCH' ? [...CREATE_FIELDS, 'version']
      : pathname.endsWith('/reorder') ? ['request_key', 'ids'] : ['request_key', 'version'];
    const unknown = Object.keys(body).filter(key => !allowed.includes(key));
    if (unknown.length || typeof body.request_key !== 'string' || !KEY_PATTERN.test(body.request_key)) {
      problems.push(`invalid body ${method} ${pathname}: ${unknown.join(',') || 'request_key'}`);
      return json(route, 400, { error: 'invalid_request' });
    }
    // A short delay keeps the request in flight long enough for double clicks to matter.
    await new Promise(resolve => setTimeout(resolve, 120));

    const key = body.request_key as string;
    const rest: Record<string, unknown> = { ...body };
    delete rest.request_key;
    const hash = `${method} ${pathname} ${JSON.stringify(rest)}`;
    const previous = recorded.get(key);
    let status: number;
    let payload: Record<string, unknown>;
    if (previous) {
      if (previous.hash !== hash) return json(route, 409, { error: 'request_key_conflict' });
      status = previous.status;
      payload = { ...previous.payload, replayed: true };
    } else {
      [status, payload] = mutate(method, pathname, body);
      // Only committed outcomes are recorded for replay.
      if (status < 300) recorded.set(key, { hash, status, payload });
    }
    if (status < 300 && lostResponses > 0) {
      lostResponses--;
      return route.abort('failed');
    }
    return json(route, status, payload);
  });

  return {
    calls: () => calls,
    mutations: (path?: string) => calls.filter(call => !path || call.path === path),
    problems: () => problems,
    rows: () => rows,
    plan: (id: number) => planOf(id),
    /** A сборка deleted elsewhere after the page loaded. */
    dropBuilder: (id: number) => { builders.splice(builders.findIndex(b => b.id === id), 1); },
    /** A change made elsewhere (another admin) after the page loaded. */
    touch: (id: number, change: Partial<Row>) => {
      const target = rows.find(item => item.id === id)!;
      Object.assign(target, change, { version: target.version + 1, updated_at: now() });
    },
    add: (item: Partial<Row> & { id: number }) => { rows.push(row(item)); nextId = Math.max(nextId, item.id + 1); },
    signOut: () => { authenticated = false; },
  };
}

const heading = (page: Page, name: string) => page.getByRole('heading', { level: 1, name });
/** The сборка picker of the editor (the side panel is a region with the same name). */
const buildSelect = (page: Page) => page.getByRole('combobox', { name: 'Сборка', exact: true });
const buildPanel = (page: Page) => page.getByRole('region', { name: 'Сборка', exact: true });
const editorForm = (page: Page) => page.getByRole('form', { name: 'Параметры тарифа' });
const catalogue = (page: Page) => page.getByRole('region', { name: 'Каталог' });
const rowNames = (page: Page) => catalogue(page).locator('.tariff-name');

async function openList(page: Page) {
  await page.goto('/#/tariffs');
  await expect(heading(page, 'Тарифы')).toBeVisible();
  await expect(rowNames(page).first()).toBeVisible();
}

async function openEditor(page: Page, id: number | 'new', title: string) {
  await page.goto(`/#/tariffs/${id}`);
  await expect(heading(page, title)).toBeVisible();
  await expect(editorForm(page)).toBeVisible();
}

test('list: catalogue order, state, badge, usage and navigation', async ({ page }) => {
  const api = await backend(page);
  await openList(page);
  await expect(page.getByRole('link', { name: 'Тарифы' })).toHaveAttribute('aria-current', 'page');
  await expect(rowNames(page)).toHaveText(['Месяц', 'Квартал', 'Звёзды']);
  await expect(page.locator('.tariffs-summary')).toHaveText('3 тарифа · в продаже 2');
  const first = catalogue(page).getByRole('listitem').first();
  await expect(first).toContainText('В продаже');
  await expect(first).toContainText('Хит');
  await expect(first).toContainText('199 ₽ · 30 дней · сборка «Основной» · 3 заказа, 2 подписки');
  await expect(catalogue(page).getByRole('listitem').nth(2)).toContainText('Скрыт');
  await expect(catalogue(page).getByRole('listitem').nth(2)).toContainText('150 ★');
  await expect(page.getByRole('button', { name: 'Поднять «Месяц» выше' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Опустить «Звёзды» ниже' })).toBeDisabled();

  await page.getByRole('link', { name: 'Квартал' }).click();
  await expect(page).toHaveURL(/#\/tariffs\/2$/);
  await expect(heading(page, 'Квартал')).toBeVisible();
  await page.getByRole('link', { name: 'Назад к тарифам' }).click();
  await expect(heading(page, 'Тарифы')).toBeVisible();
  expect(api.problems()).toEqual([]);
});

test('list: empty state offers to create the first tariff', async ({ page }) => {
  await backend(page, { rows: [] });
  await page.goto('/#/tariffs');
  const empty = page.getByRole('status').filter({ hasText: 'Тарифов пока нет' });
  await expect(empty).toBeVisible();
  await empty.getByRole('link', { name: 'Создать тариф' }).click();
  await expect(heading(page, 'Новый тариф')).toBeVisible();
});

test('list: load error with retry', async ({ page }) => {
  const api = await backend(page, { listFailures: 1 });
  await page.goto('/#/tariffs');
  const alert = page.getByRole('alert').filter({ hasText: 'Не удалось загрузить тарифы' });
  await expect(alert).toBeVisible();
  await alert.getByRole('button', { name: 'Повторить' }).click();
  await expect(rowNames(page)).toHaveText(['Месяц', 'Квартал', 'Звёзды']);
  expect(api.problems()).toEqual([]);
});

test('401 on the list returns to the login screen', async ({ page }) => {
  const api = await backend(page);
  await openList(page);
  // The session ends while the list is open; the next request answers 401.
  api.signOut();
  await page.getByRole('button', { name: 'Обновить' }).click();
  await expect(heading(page, 'Вход в панель')).toBeVisible();
  await expect(page.getByText('Сессия завершилась. Войдите снова.')).toBeVisible();
});

test('404: an unknown tariff shows a not-found state', async ({ page }) => {
  await backend(page);
  await page.goto('/#/tariffs/999');
  await expect(page.getByRole('status').filter({ hasText: 'Тарифа #999 нет' })).toBeVisible();
  await page.getByRole('link', { name: 'К списку тарифов' }).click();
  await expect(heading(page, 'Тарифы')).toBeVisible();
});

test('reorder: arrows edit the order, one save sends the full list', async ({ page }) => {
  const api = await backend(page, {
    rows: [
      { id: 1, name: 'Месяц', sort_order: 0 }, { id: 2, name: 'Квартал', sort_order: 1 }, { id: 3, name: 'Год', sort_order: 2 },
      // A retired version: not reorderable, but part of every reorder list.
      { id: 9, name: 'Месяц (старый)', sort_order: 3, is_active: false, orders: 1 },
      { id: 10, name: 'Месяц+', sort_order: 4, previous_id: 9 },
    ],
  });
  await openList(page);
  await expect(rowNames(page)).toHaveText(['Месяц', 'Квартал', 'Год', 'Месяц+']);
  await page.getByRole('button', { name: 'Опустить «Месяц» ниже' }).click();
  await expect(page.getByRole('button', { name: 'Опустить «Месяц» ниже' })).toBeFocused();
  await page.getByRole('button', { name: 'Опустить «Месяц» ниже' }).click();
  await expect(rowNames(page)).toHaveText(['Квартал', 'Год', 'Месяц', 'Месяц+']);
  const banner = page.getByRole('region', { name: 'Несохранённый порядок' });
  await expect(banner).toBeVisible();
  expect(api.mutations()).toHaveLength(0);

  // Leaving with an unsaved order asks first; staying keeps it.
  page.once('dialog', dialog => void dialog.dismiss());
  await page.getByRole('link', { name: 'Обзор' }).click();
  await expect(banner).toBeVisible();
  await expect(page).toHaveURL(/#\/tariffs$/);

  await banner.getByRole('button', { name: 'Сохранить порядок' }).dblclick();
  await expect(banner).toBeHidden();
  await expect(page.getByText('Порядок тарифов сохранён.')).toBeVisible();
  const reorders = api.mutations('/admin/api/tariffs/reorder');
  expect(reorders).toHaveLength(1);
  expect(reorders[0].body).toEqual({ request_key: expect.stringMatching(KEY_PATTERN), ids: [2, 3, 1, 10, 9] });
  await page.reload();
  await expect(rowNames(page)).toHaveText(['Квартал', 'Год', 'Месяц', 'Месяц+']);

  await page.getByLabel('Показывать прежние версии').check();
  const retired = page.getByRole('region', { name: 'Прежние версии' });
  await expect(retired).toContainText('Месяц (старый)');
  await expect(retired).toContainText('Прежняя версия');
  await expect(retired.getByRole('button')).toHaveCount(0);
  expect(api.problems()).toEqual([]);
});

test('reorder: a stale catalogue drops the edited order', async ({ page }) => {
  const api = await backend(page);
  await openList(page);
  await page.getByRole('button', { name: 'Поднять «Звёзды» выше' }).click();
  api.add({ id: 7, name: 'Неделя', sort_order: 5 });
  await page.getByRole('button', { name: 'Сохранить порядок' }).click();
  await expect(page.getByText('Порядок не сохранён. Каталог изменился после загрузки')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Несохранённый порядок' })).toBeHidden();
  await expect(rowNames(page)).toHaveText(['Месяц', 'Квартал', 'Звёзды', 'Неделя']);
  expect(api.problems()).toEqual([]);
});

test('enable and disable from the list', async ({ page }) => {
  const api = await backend(page);
  await openList(page);
  await page.getByRole('button', { name: 'Включить «Звёзды»' }).click();
  await expect(page.getByText('Тариф «Звёзды» включён и показывается в каталоге.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Скрыть «Звёзды»' })).toBeFocused();
  await page.getByRole('button', { name: 'Скрыть «Квартал»' }).click();
  await expect(page.getByText('Тариф «Квартал» скрыт из каталога.')).toBeVisible();
  await expect(page.locator('.tariffs-summary')).toHaveText('3 тарифа · в продаже 2');
  expect(api.mutations().map(call => [call.path, call.body.version])).toEqual([
    ['/admin/api/tariffs/3/enable', 1], ['/admin/api/tariffs/2/disable', 1],
  ]);
  expect(api.rows().map(item => item.is_active)).toEqual([true, false, true]);
  expect(api.problems()).toEqual([]);
});

test('create: validation, live preview, one request and the editor re-opens', async ({ page }) => {
  const api = await backend(page);
  await openEditor(page, 'new', 'Новый тариф');
  const form = editorForm(page);
  await form.getByRole('button', { name: 'Создать тариф' }).click();
  await expect(form.getByText('Введите название.')).toBeVisible();
  await expect(form.getByText('Введите цену, например 199 или 199,90.')).toBeVisible();
  // With several сборки the choice is explicit, and it is the first question.
  await expect(form.getByText('Выберите сборку: что получит покупатель.')).toBeVisible();
  await expect(buildSelect(page)).toBeFocused();
  await expect(buildSelect(page).locator('option')).toHaveText(['Выберите сборку', 'Основной', 'Резервный']);
  expect(api.mutations()).toHaveLength(0);

  await page.getByLabel('Название').fill('Полгода');
  await buildSelect(page).selectOption({ label: 'Резервный' });
  await form.getByRole('button', { name: '180 дней' }).click();
  await expect(page.getByLabel('Срок, дней')).toHaveValue('180');
  await page.getByLabel('Цена', { exact: true }).fill('899,50');
  await page.getByLabel('Описание').fill('Полгода без забот');
  await page.getByLabel('Преимущества').fill('Все серверы\n\nПоддержка 24/7');
  await form.getByRole('button', { name: 'Выгодно' }).click();

  const card = page.getByRole('group', { name: 'Карточка в Mini App' });
  await expect(card).toContainText('Полгода');
  await expect(card).toContainText('180 дней доступа');
  await expect(card).toContainText('Полгода без забот');
  await expect(card).toContainText('Выгодно');
  await expect(card.getByRole('listitem')).toHaveText(['Все серверы', 'Поддержка 24/7']);
  await expect(card).toContainText('899,5 RUB');
  await expect(card).toContainText('Оплата Stars недоступна');
  await expect(page.getByRole('group', { name: 'Кнопка в боте' })).toContainText('Полгода — 899.50₽');
  // The side panel follows the selected сборка: «Резервный» has no source yet.
  await expect(buildPanel(page)).toContainText('Резервный');
  await expect(buildPanel(page)).toContainText('Ни одного сервера');
  await expect(buildPanel(page)).toContainText('Источник не выбран: подписка не соберётся.');

  await page.getByLabel('Валюта').selectOption('XTR');
  await expect(form.getByText('Цена в звёздах — целое число.')).toBeHidden();
  await expect(page.getByRole('group', { name: 'Кнопка в боте' })).toContainText('Не показывается');
  await page.getByLabel('Валюта').selectOption('RUB');

  await form.getByRole('button', { name: 'Создать тариф' }).dblclick();
  await expect(page).toHaveURL(/#\/tariffs\/4$/);
  await expect(heading(page, 'Полгода')).toBeVisible();
  await expect(editorForm(page).getByRole('status')).toContainText('Тариф «Полгода» создан и показывается в каталоге.');

  const creates = api.mutations('/admin/api/tariffs');
  expect(creates).toHaveLength(1);
  expect(creates[0].body).toEqual({
    request_key: expect.stringMatching(KEY_PATTERN), name: 'Полгода', builder_id: 5, duration_days: 180, price_cents: 89950,
    currency: 'RUB', description: 'Полгода без забот', features: ['Все серверы', 'Поддержка 24/7'], badge: 'Выгодно', is_active: true,
  });
  await expect(page.getByLabel('Позиция в каталоге')).toHaveValue('3');
  expect(api.problems()).toEqual([]);
});

test('create: a lost response is retried with the same key and never duplicates', async ({ page }) => {
  const api = await backend(page, { lostResponses: 1 });
  await openEditor(page, 'new', 'Новый тариф');
  await buildSelect(page).selectOption({ label: 'Основной' });
  await page.getByLabel('Название').fill('Неделя');
  await page.getByLabel('Срок, дней').fill('7');
  await page.getByLabel('Цена', { exact: true }).fill('59');
  await editorForm(page).getByRole('button', { name: 'Создать тариф' }).click();
  const alert = editorForm(page).getByRole('alert');
  await expect(alert).toContainText('Не удалось подтвердить сохранение. Нет связи с сервером.');
  // The payload is frozen under its key.
  await expect(page.getByLabel('Название')).toHaveAttribute('readonly', '');
  await editorForm(page).getByRole('button', { name: 'Повторить сохранение' }).click();
  await expect(heading(page, 'Неделя')).toBeVisible();
  await expect(editorForm(page).getByRole('status')).toContainText('Этот запрос уже был выполнен ранее');
  const creates = api.mutations('/admin/api/tariffs');
  expect(creates).toHaveLength(2);
  expect(creates[1].body).toEqual(creates[0].body);
  expect(api.rows().filter(item => item.name === 'Неделя')).toHaveLength(1);
  expect(api.problems()).toEqual([]);
});

test('edit an unused tariff in place; server field errors are highlighted', async ({ page }) => {
  const api = await backend(page);
  await openEditor(page, 2, 'Квартал');
  const form = editorForm(page);
  await expect(form.getByText('Все изменения сохранены')).toBeVisible();
  await expect(form.getByRole('button', { name: 'Сохранить', exact: true })).toBeDisabled();

  await page.getByLabel('Цена', { exact: true }).fill('459');
  await page.getByLabel('Бейдж', { exact: true }).fill('Новинка');
  await expect(form.getByText('Есть несохранённые изменения')).toBeVisible();
  await form.getByRole('button', { name: 'Отменить изменения' }).click();
  await expect(page.getByLabel('Цена', { exact: true })).toHaveValue('499');
  await expect(form.getByRole('button', { name: 'Сохранить', exact: true })).toBeDisabled();

  await page.getByLabel('Цена', { exact: true }).fill('459');
  await buildSelect(page).selectOption({ label: 'Резервный' });
  await form.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(form.getByRole('status')).toContainText('Изменения сохранены.');
  await expect(page.getByLabel('Цена', { exact: true })).toHaveValue('459');
  await expect(form.getByText('Все изменения сохранены')).toBeVisible();
  expect(api.rows().find(item => item.id === 2)).toMatchObject({ price_cents: 45900, builder_id: 5, version: 2 });
  expect(api.mutations('/admin/api/tariffs/2')[0].body).toMatchObject({ version: 1, sort_order: 1, builder_id: 5 });
  expect(api.mutations('/admin/api/tariffs/2')[0].body).not.toHaveProperty('plan_id');

  // The сборка is deleted elsewhere: the server names the field.
  api.dropBuilder(5);
  await page.getByLabel('Название').fill('Квартал+');
  await form.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(form.getByRole('alert')).toContainText('Изменения не сохранены. Сборка недоступна: возможно, её удалили.');
  await expect(buildSelect(page)).toHaveAttribute('aria-invalid', 'true');
  await expect(buildSelect(page)).toBeFocused();
  expect(api.problems()).toEqual([]);
});

test('used tariff: changing purchase terms creates a new version', async ({ page }) => {
  const api = await backend(page);
  await openEditor(page, 1, 'Месяц');
  const form = editorForm(page);
  const terms = form.locator('[data-terms]');
  await expect(terms).toHaveAttribute('data-terms', 'protected');
  // Card changes stay in place.
  await page.getByLabel('Описание').fill('Для старта');
  await expect(form.getByRole('button', { name: 'Сохранить', exact: true })).toBeEnabled();
  await page.getByLabel('Цена', { exact: true }).fill('249');
  await expect(terms).toHaveAttribute('data-terms', 'versioned');
  await expect(terms).toContainText('Сохранение создаст новую версию тарифа');
  await form.getByRole('button', { name: 'Сохранить как новую версию' }).click();

  await expect(page).toHaveURL(/#\/tariffs\/4$/);
  await expect(editorForm(page).getByRole('status')).toContainText('создана новая версия тарифа #4. Прежняя версия #1 снята с продажи');
  await expect(page.getByLabel('Цена', { exact: true })).toHaveValue('249');
  await expect(page.getByRole('region', { name: 'Продажа и удаление' }).getByRole('link', { name: 'Тариф #1' })).toBeVisible();
  expect(api.rows().find(item => item.id === 1)).toMatchObject({ is_active: false, price_cents: 19900 });

  // The retired version is read-only and points to its successor.
  await page.goto('/#/tariffs/1');
  await expect(editorForm(page)).toContainText('Это прежняя версия тарифа');
  await expect(page.getByLabel('Название')).toBeDisabled();
  await expect(editorForm(page).getByRole('button', { name: /Сохранить/ })).toBeHidden();
  await editorForm(page).getByRole('link', { name: 'Открыть актуальную версию' }).click();
  await expect(page).toHaveURL(/#\/tariffs\/4$/);
  expect(api.problems()).toEqual([]);
});

test('version conflict: keep my edits on top of the latest version', async ({ page }) => {
  const api = await backend(page);
  await openEditor(page, 2, 'Квартал');
  const form = editorForm(page);
  await page.getByLabel('Описание').fill('Моё описание');
  api.touch(2, { badge: 'Выгодно' });
  await form.getByRole('button', { name: 'Сохранить', exact: true }).click();
  const alert = form.getByRole('alert');
  await expect(alert).toContainText('Тариф успели изменить в другом окне');
  await alert.getByRole('button', { name: 'Перенести мои правки' }).click();
  await expect(form.getByRole('status')).toContainText('Ваши правки остались в форме');
  await expect(page.getByLabel('Описание')).toHaveValue('Моё описание');
  await expect(page.getByLabel('Бейдж', { exact: true })).toHaveValue('Выгодно');
  await form.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(form.getByRole('status')).toContainText('Изменения сохранены.');
  const patches = api.mutations('/admin/api/tariffs/2');
  expect(patches.map(call => call.body.version)).toEqual([1, 2]);
  expect(patches[0].body.request_key).not.toBe(patches[1].body.request_key);
  expect(api.rows().find(item => item.id === 2)).toMatchObject({ description: 'Моё описание', badge: 'Выгодно', version: 3 });
  expect(api.problems()).toEqual([]);
});

test('unsaved changes: leaving asks for confirmation', async ({ page }) => {
  await backend(page);
  await openEditor(page, 2, 'Квартал');
  await page.getByLabel('Название').fill('Квартал 2');
  let asked = 0;
  page.on('dialog', dialog => { asked++; void (asked === 1 ? dialog.dismiss() : dialog.accept()); });
  await page.getByRole('link', { name: 'Назад к тарифам' }).click();
  await expect(page).toHaveURL(/#\/tariffs\/2$/);
  await expect(page.getByLabel('Название')).toHaveValue('Квартал 2');
  await page.getByRole('link', { name: 'Назад к тарифам' }).click();
  await expect(heading(page, 'Тарифы')).toBeVisible();
  expect(asked).toBe(2);
});

test('sale and delete: a used tariff is protected, an unused one is deleted', async ({ page }) => {
  const api = await backend(page);
  await openEditor(page, 1, 'Месяц');
  const manage = page.getByRole('region', { name: 'Продажа и удаление' });
  await expect(manage.getByRole('button', { name: 'Удалить тариф' })).toBeDisabled();
  await expect(manage).toContainText('Удалить нельзя: 3 заказа, 2 подписки.');
  await manage.getByRole('button', { name: 'Скрыть из каталога' }).click();
  await expect(editorForm(page).getByRole('status')).toContainText('Тариф скрыт из каталога.');
  await expect(page.getByLabel('В продаже: показывать в каталоге Mini App и бота')).not.toBeChecked();
  await expect(manage.getByRole('button', { name: 'Включить продажу' })).toBeEnabled();

  await openEditor(page, 2, 'Квартал');
  await manage.getByRole('button', { name: 'Удалить тариф' }).click();
  const confirm = page.getByRole('dialog', { name: 'Удалить тариф «Квартал»?' });
  await expect(confirm.getByRole('button', { name: 'Отмена' })).toBeFocused();
  await confirm.getByRole('button', { name: 'Отмена' }).click();
  await expect(confirm).toBeHidden();
  expect(api.mutations().filter(call => call.method === 'DELETE')).toHaveLength(0);
  await manage.getByRole('button', { name: 'Удалить тариф' }).click();
  await confirm.getByRole('button', { name: 'Удалить' }).click();
  await expect(heading(page, 'Тарифы')).toBeVisible();
  await expect(page.getByText('Тариф «Квартал» удалён.')).toBeVisible();
  await expect(rowNames(page)).toHaveText(['Месяц', 'Звёзды']);
  expect(api.mutations().filter(call => call.method === 'DELETE').map(call => call.body)).toEqual([
    { request_key: expect.stringMatching(KEY_PATTERN), version: 1 },
  ]);
  expect(api.problems()).toEqual([]);
});

test('сборка panel: what the buyer gets, a link to the сборка, and no plan anywhere', async ({ page }) => {
  const api = await backend(page);
  await openEditor(page, 2, 'Квартал');
  await expect(buildSelect(page)).toHaveValue('2');
  const panel = buildPanel(page);
  await expect(panel.locator('dt')).toHaveText(['Название', 'Что получит покупатель']);
  await expect(panel).toContainText('Основной');
  // Counted from the catalogue of the source the сборка serves.
  await expect(panel).toContainText('5 серверов · 2 страны');
  await expect(panel.getByRole('link', { name: 'Открыть сборку' })).toHaveAttribute('href', '#/builders/2');

  await buildSelect(page).selectOption({ label: 'Резервный' });
  await expect(panel).toContainText('Резервный');
  await expect(panel).toContainText('Ни одного сервера');
  await expect(panel.getByRole('link', { name: 'Открыть сборку' })).toHaveAttribute('href', '#/builders/5');
  // The plan behind a сборка is internal: neither the word nor a picker.
  await expect(page.getByRole('main')).not.toContainText(/план/i);
  await expect(page.getByLabel('План', { exact: true })).toHaveCount(0);
  expect(api.mutations()).toHaveLength(0);
  expect(api.problems()).toEqual([]);
});

test('a new tariff takes the only сборка by itself', async ({ page }) => {
  const api = await backend(page, { builders: [2] });
  await openEditor(page, 'new', 'Новый тариф');
  await expect(buildSelect(page)).toHaveValue('2');
  await page.getByLabel('Название').fill('Месяц+');
  await page.getByLabel('Цена', { exact: true }).fill('299');
  await editorForm(page).getByRole('button', { name: 'Создать тариф' }).click();
  await expect(heading(page, 'Месяц+')).toBeVisible();
  expect(api.mutations('/admin/api/tariffs')[0].body).toMatchObject({ name: 'Месяц+', builder_id: 2, price_cents: 29900 });
  expect(api.problems()).toEqual([]);
});

test('without any сборка the editor leads to creating one', async ({ page }) => {
  const api = await backend(page, { builders: [], rows: [] });
  await openEditor(page, 'new', 'Новый тариф');
  await expect(buildSelect(page).locator('option')).toHaveText(['Сборок пока нет']);
  await expect(editorForm(page)).toContainText('Сначала создайте сборку в разделе «Сборки», затем вернитесь сюда.');
  await expect(buildPanel(page).getByRole('link', { name: 'Создать сборку' })).toHaveAttribute('href', '#/builders/new');
  expect(api.problems()).toEqual([]);
});

test('a tariff of the old model gets a сборка in place; its plan name never shows', async ({ page }) => {
  // The "ПЛАН: test-customer-1" case: a sold tariff whose plan has no сборка.
  const api = await backend(page, {
    rows: [{ id: 1, name: 'Месяц', builder_id: null, orders: 4, subscriptions: 4 }],
  });
  await openList(page);
  await expect(catalogue(page).getByRole('listitem').first()).toContainText('199 ₽ · 30 дней · сборка не выбрана · 4 заказа, 4 подписки');
  await expect(page.getByRole('main')).not.toContainText(LEGACY_PLAN_NAME);

  await openEditor(page, 1, 'Месяц');
  const form = editorForm(page);
  await expect(buildSelect(page)).toHaveValue('');
  await expect(buildPanel(page)).toContainText('У этого тарифа ещё нет сборки. Выберите её: клиенты, уже купившие тариф, тоже начнут получать её серверы.');
  await expect(page.getByRole('main')).not.toContainText(LEGACY_PLAN_NAME);

  // Choosing a сборка is not a change of the purchase terms: no new version.
  await buildSelect(page).selectOption({ label: 'Основной' });
  await expect(form.locator('[data-terms]')).toHaveAttribute('data-terms', 'protected');
  await form.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(form.getByRole('status')).toContainText('Изменения сохранены.');
  await expect(page).toHaveURL(/#\/tariffs\/1$/);
  await expect(buildPanel(page)).toContainText('5 серверов · 2 страны');
  await expect(buildPanel(page)).not.toContainText('ещё нет сборки');
  expect(api.rows()).toHaveLength(1);
  expect(api.rows()[0]).toMatchObject({ id: 1, builder_id: 2, is_active: true, version: 2 });
  expect(api.mutations('/admin/api/tariffs/1')[0].body).toMatchObject({ builder_id: 2, version: 1 });
  expect(api.problems()).toEqual([]);
});

test('free access: the сборка of clients without a paid tariff is chosen on the Tariffs page', async ({ page }) => {
  const api = await backend(page);
  await openList(page);
  const free = page.getByRole('region', { name: 'Бесплатный доступ' });
  await expect(free).toContainText('21 подписка');
  await expect(free).toContainText('Не выбрана');
  await expect(free).toContainText('Бесплатные клиенты не получают серверы: их подписка не открывается.');

  await free.getByRole('button', { name: 'Выбрать сборку' }).click();
  const dialog = page.getByRole('dialog', { name: 'Сборка бесплатного доступа' });
  // An explicit warning with the number of subscriptions that get other servers.
  const warning = dialog.locator('#ba-impact');
  await expect(warning).toHaveText('Изменение затронет 21 подписку тарифа «Бесплатный доступ»: их клиенты начнут получать серверы выбранной сборки. Учитываются подписки во всех статусах.');
  await expect(warning).toHaveAttribute('data-subscriptions', '21');
  await expect(dialog.getByLabel('Сборка')).toHaveAttribute('aria-describedby', 'ba-impact');
  await dialog.getByRole('button', { name: 'Отмена' }).click();
  await expect(dialog).toBeHidden();
  expect(api.mutations()).toHaveLength(0);

  await free.getByRole('button', { name: 'Выбрать сборку' }).click();
  await dialog.getByLabel('Сборка').selectOption({ label: 'Основной' });
  await dialog.getByRole('button', { name: 'Сохранить' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Сборка бесплатного доступа назначена.')).toBeVisible();
  await expect(free).toContainText('Основной');
  await expect(free).not.toContainText('Не выбрана');
  await expect(free.getByRole('button', { name: 'Изменить сборку' })).toBeVisible();
  expect(api.plan(6)!.builder).toBe(2);
  const [call] = api.mutations('/admin/api/plans/6/builder');
  expect(call.body).toEqual({ request_key: expect.stringMatching(KEY_PATTERN), builder_id: 2 });
  expect(api.problems()).toEqual([]);
});

test('free access warning: plural forms follow the count, nobody affected says so', async ({ page }) => {
  const api = await backend(page);
  api.plan(6)!.subscriptions = 3;
  await openList(page);
  const free = page.getByRole('region', { name: 'Бесплатный доступ' });
  const dialog = page.getByRole('dialog', { name: 'Сборка бесплатного доступа' });
  await free.getByRole('button', { name: 'Выбрать сборку' }).click();
  await expect(dialog.locator('#ba-impact')).toContainText('Изменение затронет 3 подписки тарифа «Бесплатный доступ»');
  await dialog.getByRole('button', { name: 'Отмена' }).click();
  await expect(dialog).toBeHidden();

  api.plan(6)!.subscriptions = 0;
  await page.getByRole('button', { name: 'Обновить' }).click();
  await expect(free).toContainText('0 подписок');
  await free.getByRole('button', { name: 'Выбрать сборку' }).click();
  await expect(dialog.locator('#ba-impact')).toHaveText('На тарифе «Бесплатный доступ» пока нет клиентов: изменение никого не затронет.');
  await expect(dialog.locator('#ba-impact')).toHaveAttribute('data-subscriptions', '0');
  await dialog.getByRole('button', { name: 'Отмена' }).click();
  // Cancelling sends nothing.
  expect(api.mutations()).toHaveLength(0);
  expect(api.problems()).toEqual([]);
});

test('user page: the сборка of the tariff warns about every client, a personal сборка does not', async ({ page }) => {
  const api = await backend(page);
  await page.goto('/#/users/1001');
  await expect(heading(page, '@anya')).toBeVisible();
  const panel = page.getByRole('region', { name: 'Сборка', exact: true });
  await expect(panel.locator('dt')).toHaveText(['Сборка тарифа', 'Личная сборка клиента']);
  await expect(panel).toContainText('Её получают все клиенты этого тарифа');
  await expect(panel).toContainText('Не задана: клиент получает сборку тарифа');
  await panel.getByRole('button', { name: 'Изменить' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Сборка тарифа' });
  await expect(dialog.locator('#ba-impact')).toHaveText('Изменение затронет 21 подписку тарифа «Основной»: их клиенты начнут получать серверы выбранной сборки. Учитываются подписки во всех статусах.');
  await dialog.getByRole('button', { name: 'Отмена' }).click();
  await expect(dialog).toBeHidden();
  // A personal сборка changes one client only: no such warning there.
  await panel.getByRole('button', { name: 'Изменить' }).nth(1).click();
  const override = page.getByRole('dialog', { name: 'Личная сборка клиента' });
  await expect(override).toBeVisible();
  await expect(override.locator('#ba-impact')).toHaveCount(0);
  await expect(override.getByLabel('Сборка').locator('option')).toHaveText(['— Как у тарифа —', 'Основной', 'Резервный']);
  await override.getByRole('button', { name: 'Отмена' }).click();
  expect(api.mutations()).toHaveLength(0);
  expect(api.problems()).toEqual([]);
});
test('responsive: list and editor fit narrow and wide screens', async ({ page }) => {
  await backend(page);
  for (const width of [360, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await openList(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(page.getByRole('button', { name: 'Скрыть «Месяц»' })).toBeInViewport();
    await openEditor(page, 1, 'Месяц');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const nameBox = await page.getByLabel('Название').boundingBox();
    const previewBox = await page.getByRole('group', { name: 'Карточка в Mini App' }).boundingBox();
    expect(nameBox && previewBox).toBeTruthy();
    if (nameBox && previewBox) {
      // Two columns on wide screens, the form above the preview on narrow ones.
      if (width >= 1024) expect(previewBox.x).toBeGreaterThan(nameBox.x + nameBox.width - 1);
      else expect(previewBox.y).toBeGreaterThan(nameBox.y);
    }
  }
});
