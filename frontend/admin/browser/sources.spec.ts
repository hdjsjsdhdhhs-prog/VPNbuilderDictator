import { test, expect } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

// Sources and сборки, against a mock backend that follows the real contract.
// A source is a provider subscription bought by the owner; a сборка (a
// subscription builder) is what a client gets: countries and servers of the
// sources, their names and the price.
//   routes    internal/web/admin_builder_api.go (create returns {source, sync},
//             refresh takes no entries and answers 200 with a sync result even
//             when the upstream failed, unknown fields are rejected)
//   catalogue database.SourceCatalogueStats (present entries only, by_country
//             by descending count then code, absent counted apart); a failed
//             sync keeps the previous catalogue
//   preview   database.PreviewBuilder (country rules expand to every present
//             entry of the country, node rules resolve by fingerprint then by a
//             unique name, unlinked/disabled/expired sources are skipped)
//   validity  provider_sources.expires_at: null = no limit, a new end must be
//             in the future, an omitted member keeps the stored one; `expired`
//             is evaluated on the server clock
//   deletion  database.DeleteProviderSource / DeleteBuilder: only while
//             nothing depends on the row (409 source_in_use | builder_in_use),
//             a builder also needs the loaded version (409 version_conflict)
// URLs are placeholders: no real provider address or credential is used.

const CSRF = 'c'.repeat(43);
const T0 = '2026-09-20T08:00:00Z';
const KEY_PATTERN = /^ui-[0-9a-f]{32}$/;
const SECRET_URL = 'https://provider.test/sub/fixture-token-000';

interface Entry {
  id: number; source_id: number; fingerprint: string; original_name: string; protocol: string; country_code: string;
  upstream_position: number; present: boolean; last_seen_at: string;
}
type EntryInput = Pick<Entry, 'fingerprint' | 'original_name' | 'protocol' | 'country_code'>;

interface Source {
  id: number; name: string; type: string; description: string; enabled: boolean;
  last_sync_at: string | null; last_sync_status: string; last_sync_error: string;
  expires_at: string | null;
}
interface DependentRef { id: number; name: string }

/** The next upstream answer of a source: a parsed catalogue or a failure code. */
type Outcome = { entries: EntryInput[]; skipped?: number; format?: string } | { error: string };

interface Item {
  id: number; kind: 'country' | 'node'; source_id: number; country_code: string; fingerprint: string; original_name: string;
  custom_name: string | null; description: string; position: number; enabled: boolean;
}
interface Builder {
  id: number; name: string; description: string; enabled: boolean; profile_title: string; support_url: string; announce: string;
  version: number; sources: { source_id: number; position: number }[]; items: Item[];
  dependents?: { plans: DependentRef[]; subscriptions: number };
}
/** service.TariffView of a price created in the constructor. */
interface Tariff { id: number; builder_id: number; [field: string]: unknown }
interface Call { method: string; path: string; body: Record<string, unknown> }

const e = (fingerprint: string, original_name: string, country_code: string, protocol = 'vless'): EntryInput =>
  ({ fingerprint, original_name, country_code, protocol });

const CATALOGUE_A = [
  e('a1', '🇩🇪 Frankfurt 1', 'DE'), e('a2', '🇩🇪 Frankfurt 2', 'DE'), e('a3', '🇩🇪 Berlin', 'DE', 'trojan'),
  e('a4', '🇳🇱 Amsterdam', 'NL'), e('a5', 'Mystery', '', 'ss'),
];
const CATALOGUE_B = [e('b1', '🇺🇸 New York', 'US'), e('b2', '🇺🇸 Dallas', 'US'), e('b3', '🇩🇪 Munich', 'DE')];

const CREATE_FIELDS = ['name', 'description', 'type', 'subscription_url', 'hwid', 'user_agent', 'headers', 'enabled', 'expires_at'];
// The link and the request parameters are write-only: sent only when replaced.
const UPDATE_FIELDS = ['name', 'description', 'type', 'expires_at', 'subscription_url', 'hwid', 'user_agent', 'headers'];
const TARIFF_FIELDS = ['request_key', 'name', 'builder_id', 'duration_days', 'price_cents', 'currency', 'description', 'features', 'badge', 'sort_order', 'is_active'];
/** The form the panel sends expires_at in: RFC 3339, UTC, whole seconds. */
const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const ITEM_FIELDS = ['id', 'kind', 'source_id', 'country_code', 'fingerprint', 'original_name', 'custom_name', 'description', 'position', 'enabled'];
const BUILDER_FIELDS = ['request_key', 'version', 'name', 'description', 'enabled', 'profile_title', 'support_url', 'announce'];
const CONFIG_FIELDS = [...BUILDER_FIELDS, 'source_ids', 'items'];
const CONFIG_ITEM_FIELDS = ['id', 'kind', 'source_id', 'country_code', 'fingerprint', 'original_name', 'custom_name', 'description', 'enabled'];

interface BackendOptions {
  outcomes?: Record<number, Outcome[]>;
  builderSources?: number[];
  /** Stored validity end per source id. */
  expiresAt?: Record<number, string>;
  /** Subscriptions sold directly on a source, per source id. */
  sold?: Record<number, number>;
  /** Plans whose default builder is the fixture builder. */
  plans?: DependentRef[];
}

async function backend(page: Page, options: BackendOptions = {}) {
  let clock = Date.parse(T0);
  const now = () => new Date(clock += 60_000).toISOString();
  let nextEntryId = 1;
  let nextItemId = 100;
  const sources: Source[] = [];
  const entries: Entry[] = [];
  const outcomes = new Map<number, Outcome[]>(Object.entries(options.outcomes ?? {}).map(([k, v]) => [Number(k), [...v]]));
  const calls: Call[] = [];
  const problems: string[] = [];

  /** database.SyncSourceCatalogue: upsert by fingerprint, mark the rest absent. */
  const applySync = (src: Source, outcome: Outcome) => {
    const at = now();
    const present = () => entries.filter(x => x.source_id === src.id && x.present).length;
    if ('error' in outcome) {
      Object.assign(src, { last_sync_at: at, last_sync_status: 'error', last_sync_error: outcome.error });
      return { status: 'error', error: outcome.error, format: '', added: 0, updated: 0, removed: 0, total: present(), skipped: 0, duplicates: 0 };
    }
    let added = 0, updated = 0, removed = 0;
    const seen = new Set<string>();
    outcome.entries.forEach((input, position) => {
      seen.add(input.fingerprint);
      const old = entries.find(x => x.source_id === src.id && x.fingerprint === input.fingerprint);
      if (old) { Object.assign(old, input, { upstream_position: position, present: true, last_seen_at: at }); updated++; }
      else { entries.push({ id: nextEntryId++, source_id: src.id, ...input, upstream_position: position, present: true, last_seen_at: at }); added++; }
    });
    for (const x of entries) {
      if (x.source_id === src.id && x.present && !seen.has(x.fingerprint)) { x.present = false; removed++; }
    }
    const skipped = outcome.skipped ?? 0;
    const status = skipped > 0 ? 'partial' : 'ok';
    Object.assign(src, { last_sync_at: at, last_sync_status: status, last_sync_error: skipped > 0 ? `skipped:${skipped}` : '' });
    return { status, error: src.last_sync_error, format: outcome.format ?? 'base64', added, updated, removed, total: present(), skipped, duplicates: 0 };
  };

  const addSource = (over: Partial<Source> & { id: number; name: string }, catalogue: EntryInput[] | null) => {
    const src: Source = {
      type: 'auto', description: '', enabled: true, last_sync_at: null, last_sync_status: '', last_sync_error: '', expires_at: null, ...over,
    };
    sources.push(src);
    if (catalogue) applySync(src, { entries: catalogue });
    return src;
  };
  addSource({ id: 1, name: 'Provider A' }, CATALOGUE_A);
  // One entry of A disappeared upstream: it is kept but counted apart.
  entries.push({ id: nextEntryId++, source_id: 1, ...e('a0', '🇩🇪 Old', 'DE'), upstream_position: 0, present: false, last_seen_at: T0 });
  addSource({ id: 2, name: 'Provider B', type: 'json' }, CATALOGUE_B);
  const broken = addSource({ id: 3, name: 'Broken', type: 'base64' }, null);
  applySync(broken, { error: 'timeout' });
  for (const [id, at] of Object.entries(options.expiresAt ?? {})) sources.find(s => s.id === Number(id))!.expires_at = at;
  const sold = new Map<number, number>(Object.entries(options.sold ?? {}).map(([k, v]) => [Number(k), v]));
  const builderDeps = { plans: [...(options.plans ?? [])], subscriptions: 0 };
  let sourceListReads = 0;
  /** database.ProviderSource.Expired on the server clock. */
  const expired = (src: Source) => src.expires_at !== null && Date.parse(src.expires_at) <= Date.now();

  const builders: Builder[] = [{
    id: 7, name: 'Основной', description: '', enabled: true, profile_title: '', support_url: '', announce: '', version: 1,
    sources: (options.builderSources ?? [1]).map((source_id, position) => ({ source_id, position })), items: [],
  }];
  const reads: string[] = [];
  const tariffs: Tariff[] = [];
  const failures = { list: false, get: false };
  /** service.BuilderView: a snapshot of the stored row, sources and items by position. */
  const stored = (b: Builder): Builder => structuredClone({
    ...b,
    sources: [...b.sources].sort((x, y) => x.position - y.position),
    items: [...b.items].sort((x, y) => x.position - y.position),
    // The fixture сборка carries the configured dependents; a new one has none.
    dependents: b.id === 7 ? builderDeps : { plans: [], subscriptions: 0 },
    // database.BuilderSales: the internal sale plan appears with the first tariff.
    sales: { plan_id: tariffs.some(t => t.builder_id === b.id) ? 100 + b.id : null, clients: 0 },
  });

  /** service.SourceView: metadata and catalogue statistics, never the URL or credentials. */
  const view = (src: Source) => {
    const mine = entries.filter(x => x.source_id === src.id);
    const live = mine.filter(x => x.present);
    const counts = new Map<string, number>();
    const protocols: Record<string, number> = {};
    for (const x of live) {
      if (x.country_code) counts.set(x.country_code, (counts.get(x.country_code) ?? 0) + 1);
      if (x.protocol) protocols[x.protocol] = (protocols[x.protocol] ?? 0) + 1;
    }
    const by_country = [...counts].map(([code, count]) => ({ code, count }))
      .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
    return {
      ...src, created_at: T0, updated_at: T0,
      catalogue: {
        entries: live.length, countries: counts.size, no_country: live.filter(x => !x.country_code).length,
        absent: mine.length - live.length, by_country, protocols,
      },
      expired: expired(src),
      // database.SourceDependents: builders that link the source or have a rule on it.
      dependents: {
        builders: builders.filter(b => b.sources.some(s => s.source_id === src.id) || b.items.some(i => i.source_id === src.id))
          .map(b => ({ id: b.id, name: b.name })),
        subscriptions: sold.get(src.id) ?? 0,
      },
    };
  };
  const presentOf = (id: number) => entries.filter(x => x.source_id === id && x.present).sort((a, b) => a.upstream_position - b.upstream_position);

  /** database.PreviewBuilder. */
  const preview = (b: Builder) => {
    const linked = new Set(b.sources.map(s => s.source_id));
    const usable = (id: number) => {
      const src = sources.find(s => s.id === id);
      return src !== undefined && src.enabled && !expired(src);
    };
    const items: unknown[] = [];
    const warnings: string[] = [];
    const seen = new Set<string>();
    let pos = 0, missing = 0, conflicts = 0, total = 0;
    const add = (itemId: number, kind: string, x: Entry, name: string) => {
      const key = `${x.source_id}|${x.fingerprint}`;
      if (seen.has(key)) return;
      seen.add(key);
      items.push({ item_id: itemId, kind, source_id: x.source_id, entry: x, display_name: name, status: 'matched', position: pos++ });
      total++;
    };
    if (b.items.length === 0) {
      for (const link of b.sources) {
        if (!usable(link.source_id)) { warnings.push(`source ${link.source_id} is disabled or unusable, skipped`); continue; }
        for (const x of presentOf(link.source_id)) add(0, 'source', x, x.original_name);
      }
    }
    for (const it of [...b.items].sort((x, y) => x.position - y.position || x.id - y.id)) {
      if (!it.enabled) continue;
      if (!linked.has(it.source_id)) { warnings.push(`item ${it.id}: source ${it.source_id} is not linked to the builder, rule ignored`); continue; }
      if (!usable(it.source_id)) { warnings.push(`item ${it.id}: source ${it.source_id} is disabled or unusable, rule skipped`); continue; }
      const live = presentOf(it.source_id);
      if (it.kind === 'country') {
        for (const x of live) if (x.country_code.toUpperCase() === it.country_code.toUpperCase()) add(it.id, it.kind, x, it.custom_name || x.original_name);
        continue;
      }
      let hit = live.find(x => x.fingerprint === it.fingerprint);
      let status = 'matched';
      if (!hit) {
        const byName = live.filter(x => x.original_name === it.original_name);
        status = byName.length === 1 ? 'fallback' : byName.length === 0 ? 'missing' : 'conflict';
        hit = byName.length === 1 ? byName[0] : undefined;
      }
      if (hit) {
        const key = `${hit.source_id}|${hit.fingerprint}`;
        if (seen.has(key)) continue;
        seen.add(key);
      }
      items.push({ item_id: it.id, kind: it.kind, source_id: it.source_id, entry: hit ?? null,
        display_name: hit ? it.custom_name || hit.original_name : '', status, position: pos });
      if (hit) { pos++; total++; } else if (status === 'missing') missing++; else conflicts++;
    }
    return { builder_id: b.id, items, warnings, missing, conflicts, total, previewed_at: now() };
  };

  const json = (route: Route, status: number, payload: unknown) =>
    route.fulfill({ status, contentType: 'application/json', headers: { 'Cache-Control': 'no-store' }, body: JSON.stringify(payload) });

  await page.route('**/admin/**', async route => {
    const request = route.request();
    const { pathname, searchParams } = new URL(request.url());
    const method = request.method();

    if ((pathname === '/admin/login' || pathname === '/admin/session') && method === 'GET') {
      return json(route, 200, { authenticated: true, csrf_token: CSRF });
    }
    if (method === 'GET') {
      if (pathname === '/admin/api/sources') {
        sourceListReads++;
        return json(route, 200, { sources: sources.map(view) });
      }
      const one = /^\/admin\/api\/sources\/(\d+)$/.exec(pathname);
      if (one) {
        const src = sources.find(s => s.id === Number(one[1]));
        return src ? json(route, 200, view(src)) : json(route, 404, { error: 'not_found' });
      }
      const list = /^\/admin\/api\/sources\/(\d+)\/entries$/.exec(pathname);
      if (list) {
        const id = Number(list[1]);
        if (!sources.some(s => s.id === id)) return json(route, 404, { error: 'not_found' });
        const country = searchParams.get('country') ?? '*';
        const out = searchParams.get('all') === '1' ? entries.filter(x => x.source_id === id)
          : presentOf(id).filter(x => country === '*' || x.country_code === country);
        return json(route, 200, { source_id: id, entries: out });
      }
      // service.ListBuilders / GetBuilder: both carry the stored sources and
      // items ([] when empty), ordered by position.
      if (pathname === '/admin/api/builders') {
        reads.push(pathname);
        if (failures.list) return json(route, 500, { error: 'internal' });
        return json(route, 200, { builders: builders.map(stored) });
      }
      const oneBuilder = /^\/admin\/api\/builders\/(\d+)$/.exec(pathname);
      if (oneBuilder) {
        reads.push(pathname);
        if (failures.get) return json(route, 500, { error: 'internal' });
        const found = builders.find(x => x.id === Number(oneBuilder[1]));
        return found ? json(route, 200, stored(found)) : json(route, 404, { error: 'not_found' });
      }
      if (pathname === '/admin/api/tariffs') return json(route, 200, { tariffs });
      // The сборки screens ask for the network verdict (best effort): this
      // stand runs without the monitor.
      if (pathname === '/admin/api/monitoring') return json(route, 503, { error: 'service_unavailable' });
      problems.push(`unexpected GET ${pathname}`);
      return json(route, 404, { error: 'not_found' });
    }

    const raw = request.postData();
    let body: Record<string, unknown> = {};
    if (raw) {
      try { body = JSON.parse(raw) as Record<string, unknown>; } catch { problems.push(`bad json ${pathname}`); }
      if (request.headers()['content-type']?.split(';')[0].trim() !== 'application/json') problems.push(`content type ${pathname}`);
    }
    calls.push({ method, path: pathname, body });
    if (request.headers()['x-csrf-token'] !== CSRF) { problems.push(`csrf ${pathname}`); return json(route, 403, { error: 'forbidden' }); }
    const unknown = (allowed: string[]) => Object.keys(body).filter(k => !allowed.includes(k));

    if (method === 'POST' && pathname === '/admin/api/sources') {
      if (unknown(CREATE_FIELDS).length) { problems.push(`unknown fields ${unknown(CREATE_FIELDS)}`); return json(route, 400, { error: 'invalid_request' }); }
      const url = String(body.subscription_url);
      if (!/^https?:\/\/[^\s/#]+/.test(url) || url.includes('rejected')) return json(route, 400, { error: 'invalid_source', field: 'subscription_url' });
      const until = body.expires_at ?? null;
      if (until !== null && (typeof until !== 'string' || !RFC3339_UTC.test(until) || Date.parse(until) <= Date.now())) {
        return json(route, 400, { error: 'invalid_source', field: 'expires_at' });
      }
      const id = Math.max(...sources.map(s => s.id)) + 1;
      const src = addSource({
        id, name: String(body.name), type: String(body.type), description: String(body.description), enabled: Boolean(body.enabled),
        expires_at: until,
      }, null);
      const sync = { ...applySync(src, outcomes.get(id)?.shift() ?? { entries: [] }) };
      return json(route, 201, { source: view(src), sync: { ...sync, source: view(src) } });
    }
    const refresh = /^\/admin\/api\/sources\/(\d+)\/refresh$/.exec(pathname);
    if (refresh && method === 'POST') {
      if (raw && raw.trim() !== '{}') { problems.push('refresh with a body'); return json(route, 400, { error: 'invalid_request' }); }
      const src = sources.find(s => s.id === Number(refresh[1]));
      if (!src) return json(route, 404, { error: 'not_found' });
      // Keeps the sync in flight long enough to observe the busy state.
      await new Promise(resolve => setTimeout(resolve, 300));
      const result = applySync(src, outcomes.get(src.id)?.shift() ?? { error: 'timeout' });
      return json(route, 200, { ...result, source: view(src) });
    }
    const toggle = /^\/admin\/api\/sources\/(\d+)\/(enable|disable)$/.exec(pathname);
    if (toggle && method === 'POST') {
      const src = sources.find(s => s.id === Number(toggle[1]))!;
      src.enabled = toggle[2] === 'enable';
      return json(route, 200, view(src));
    }

    const oneSource = /^\/admin\/api\/sources\/(\d+)$/.exec(pathname);
    if (oneSource && (method === 'PATCH' || method === 'DELETE')) {
      const src = sources.find(s => s.id === Number(oneSource[1]));
      if (!src) return json(route, 404, { error: 'not_found' });
      // service.UpdateSource: an omitted expires_at keeps the stored end, the
      // stored value re-sent is accepted, any other end must be in the future.
      if (method === 'PATCH') {
        if (unknown(UPDATE_FIELDS).length) { problems.push(`unknown fields ${unknown(UPDATE_FIELDS)}`); return json(route, 400, { error: 'invalid_request' }); }
        // A replaced link is validated like on create and never echoed.
        if ('subscription_url' in body && !/^https?:\/\/[^\s/#]+/.test(String(body.subscription_url))) {
          return json(route, 400, { error: 'invalid_source', field: 'subscription_url' });
        }
        if ('expires_at' in body) {
          const until = body.expires_at;
          const unchanged = typeof until === 'string' && src.expires_at !== null && Date.parse(until) === Date.parse(src.expires_at);
          if (until !== null && !unchanged && (typeof until !== 'string' || !RFC3339_UTC.test(until) || Date.parse(until) <= Date.now())) {
            return json(route, 400, { error: 'invalid_source', field: 'expires_at' });
          }
          if (!unchanged) src.expires_at = until as string | null;
        }
        Object.assign(src, { name: String(body.name), description: String(body.description), type: String(body.type) });
        return json(route, 200, view(src));
      }
      // database.DeleteProviderSource: only while nothing depends on the source.
      if (unknown(['request_key']).length || !KEY_PATTERN.test(String(body.request_key))) {
        problems.push(`source delete body ${JSON.stringify(body)}`);
        return json(route, 400, { error: 'invalid_request' });
      }
      const deps = view(src).dependents;
      if (deps.builders.length > 0 || deps.subscriptions > 0) return json(route, 409, { error: 'source_in_use' });
      sources.splice(sources.indexOf(src), 1);
      for (let i = entries.length - 1; i >= 0; i--) if (entries[i].source_id === src.id) entries.splice(i, 1);
      return json(route, 200, { deleted: src.id, audit: {} });
    }

    // service.CreateBuilder: metadata only; sources and rules come with the
    // configuration save that follows.
    if (method === 'POST' && pathname === '/admin/api/builders') {
      const fields = BUILDER_FIELDS.filter(field => field !== 'version');
      if (unknown(fields).length || !KEY_PATTERN.test(String(body.request_key))) {
        problems.push(`builder create body ${unknown(fields)}`);
        return json(route, 400, { error: 'invalid_request' });
      }
      if (builders.some(x => x.name === body.name)) return json(route, 409, { error: 'name_taken' });
      const created: Builder = {
        id: Math.max(7, ...builders.map(x => x.id)) + 1, name: String(body.name), description: String(body.description),
        enabled: Boolean(body.enabled), profile_title: String(body.profile_title), support_url: String(body.support_url),
        announce: String(body.announce), version: 1, sources: [], items: [],
      };
      builders.push(created);
      return json(route, 201, { builder: stored(created), audit: {} });
    }
    // web.tariffBody: a price of a сборка is a tariff sold on it — builder_id,
    // never a plan.
    if (method === 'POST' && pathname === '/admin/api/tariffs') {
      if (unknown(TARIFF_FIELDS).length || !KEY_PATTERN.test(String(body.request_key))) {
        problems.push(`tariff body ${unknown(TARIFF_FIELDS)}`);
        return json(route, 400, { error: 'invalid_request' });
      }
      const owner = builders.find(x => x.id === body.builder_id);
      if (!owner) return json(route, 400, { error: 'invalid_tariff', field: 'builder_id' });
      const id = tariffs.length + 1;
      const tariff: Tariff = {
        id, offer_id: String(id).padStart(32, '0'), name: String(body.name), plan_id: 100 + owner.id, plan_name: owner.name,
        plan_active: true, builder_id: owner.id, builder_name: owner.name, duration_days: Number(body.duration_days),
        price_cents: Number(body.price_cents), currency: String(body.currency), is_active: Boolean(body.is_active),
        description: String(body.description), features: body.features as string[], badge: String(body.badge), sort_order: id - 1,
        version: 1, previous_id: null, replaced_by_id: null, orders: 0, subscriptions: 0, in_use: false, offer_ends_at: null,
        created_at: T0, updated_at: T0,
      };
      tariffs.push(tariff);
      return json(route, 201, { tariff, previous: null, versioned: false, replayed: false, audit: {} });
    }

    const bm = /^\/admin\/api\/builders\/(\d+)(?:\/(sources|items|reorder|preview|enable|disable|configuration))?(?:\/(\d+))?$/.exec(pathname);
    const b = bm ? builders.find(x => x.id === Number(bm[1])) : undefined;
    if (bm && !b) return json(route, 404, { error: 'not_found' });
    // database.DeleteBuilder: the loaded version, and nothing may depend on it.
    if (b && method === 'DELETE' && !bm![2]) {
      if (unknown(['request_key', 'version']).length || !KEY_PATTERN.test(String(body.request_key))) {
        problems.push(`builder delete body ${JSON.stringify(body)}`);
        return json(route, 400, { error: 'invalid_request' });
      }
      if (body.version !== b.version) return json(route, 409, { error: 'version_conflict' });
      if (builderDeps.plans.length > 0 || builderDeps.subscriptions > 0) return json(route, 409, { error: 'builder_in_use' });
      builders.splice(builders.indexOf(b), 1);
      return json(route, 200, { deleted: b.id, audit: {} });
    }
    // database.SaveBuilderConfiguration: one transaction, expected version,
    // rule ids must be rules of this builder, position = index.
    if (b && method === 'PUT' && bm![2] === 'configuration') {
      if (unknown(CONFIG_FIELDS).length || !KEY_PATTERN.test(String(body.request_key)) || !Array.isArray(body.source_ids) || !Array.isArray(body.items)) {
        problems.push(`configuration body ${unknown(CONFIG_FIELDS)}`);
        return json(route, 400, { error: 'invalid_request' });
      }
      if (body.version !== b.version) return json(route, 409, { error: 'version_conflict' });
      const rules = body.items as Record<string, unknown>[];
      for (const it of rules) {
        if (Object.keys(it).some(k => !CONFIG_ITEM_FIELDS.includes(k))) { problems.push('configuration item fields'); return json(route, 400, { error: 'invalid_request' }); }
        if (it.id && !b.items.some(x => x.id === it.id)) return json(route, 404, { error: 'not_found' });
      }
      b.items = rules.map((it, position) => ({
        id: Number(it.id) || nextItemId++, kind: it.kind as Item['kind'], source_id: Number(it.source_id),
        country_code: String(it.country_code), fingerprint: String(it.fingerprint), original_name: String(it.original_name),
        custom_name: (it.custom_name as string | null) ?? null, description: String(it.description), position, enabled: Boolean(it.enabled),
      }));
      b.sources = (body.source_ids as number[]).map((source_id, position) => ({ source_id, position }));
      Object.assign(b, { name: body.name, description: body.description, enabled: body.enabled, profile_title: body.profile_title,
        support_url: body.support_url, announce: body.announce, version: b.version + 1 });
      return json(route, 200, { builder: stored(b), audit: {} });
    }
    if (b && method === 'POST' && (bm![2] === 'enable' || bm![2] === 'disable')) {
      Object.assign(b, { enabled: bm![2] === 'enable', version: b.version + 1 });
      return json(route, 200, stored(b));
    }
    if (b && method === 'PATCH' && !bm![2]) {
      if (unknown(BUILDER_FIELDS).length || !KEY_PATTERN.test(String(body.request_key))) { problems.push('builder body'); return json(route, 400, { error: 'invalid_request' }); }
      if (body.version !== b.version) return json(route, 409, { error: 'version_conflict' });
      Object.assign(b, { name: body.name, description: body.description, enabled: body.enabled, profile_title: body.profile_title,
        support_url: body.support_url, announce: body.announce, version: b.version + 1 });
      return json(route, 200, { builder: stored(b), audit: {} });
    }
    if (b && method === 'PUT' && bm![2] === 'sources') {
      b.sources = (body.source_ids as number[]).map((source_id, position) => ({ source_id, position }));
      return json(route, 200, stored(b));
    }
    if (b && method === 'POST' && bm![2] === 'items') {
      if (unknown(ITEM_FIELDS).length) { problems.push(`item fields ${unknown(ITEM_FIELDS)}`); return json(route, 400, { error: 'invalid_request' }); }
      const input = {
        kind: body.kind as Item['kind'], source_id: Number(body.source_id), country_code: String(body.country_code ?? ''),
        fingerprint: String(body.fingerprint ?? ''), original_name: String(body.original_name ?? ''),
        custom_name: (body.custom_name as string | null | undefined) ?? null, description: String(body.description ?? ''),
        position: Number(body.position), enabled: Boolean(body.enabled),
      };
      let it = body.id ? b.items.find(x => x.id === body.id) : undefined;
      if (body.id && !it) return json(route, 404, { error: 'not_found' });
      if (it) Object.assign(it, input);
      else { it = { id: nextItemId++, ...input }; b.items.push(it); }
      return json(route, 200, it);
    }
    if (b && method === 'DELETE' && bm![2] === 'items' && bm![3]) {
      const idx = b.items.findIndex(x => x.id === Number(bm![3]));
      if (idx < 0) return json(route, 404, { error: 'not_found' });
      b.items.splice(idx, 1);
      return json(route, 200, { deleted: Number(bm![3]) });
    }
    if (b && method === 'POST' && bm![2] === 'reorder') {
      (body.item_ids as number[]).forEach((id, position) => { const it = b.items.find(x => x.id === id); if (it) it.position = position; });
      return json(route, 200, { ok: true });
    }
    if (b && method === 'POST' && bm![2] === 'preview') return json(route, 200, preview(b));

    problems.push(`unexpected ${method} ${pathname}`);
    return json(route, 404, { error: 'not_found' });
  });

  return {
    calls: (path?: string | RegExp, method?: string) => calls.filter(c =>
      (!path || (typeof path === 'string' ? c.path === path : path.test(c.path))) && (!method || c.method === method)),
    problems: () => problems,
    builder: () => builders[0],
    builders: () => builders,
    tariffs: () => tariffs,
    /** GET requests of the builder list and of single builders, in order. */
    reads: () => reads,
    failures,
    /** Another admin tab changed the stored builder. */
    changeBuilder: (change: (b: Builder) => void) => change(builders[0]),
    source: (id: number) => sources.find(s => s.id === id)!,
    /** Queues the next upstream answers of a source. */
    queue: (id: number, ...next: Outcome[]) => outcomes.set(id, [...(outcomes.get(id) ?? []), ...next]),
    /** The upstream changed and a background sync ran (another admin, scheduler). */
    resync: (id: number, catalogue: EntryInput[]) => applySync(sources.find(s => s.id === id)!, { entries: catalogue }),
    /** Ids of the stored sources / builders. */
    sourceIds: () => sources.map(s => s.id),
    builderIds: () => builders.map(x => x.id),
    /** GET requests of the source list. */
    sourceListReads: () => sourceListReads,
    /** A subscription was sold directly on the source meanwhile. */
    sell: (id: number, count: number) => sold.set(id, count),
  };
}

const heading = (page: Page, name: string) => page.getByRole('heading', { level: 1, name });
const region = (page: Page, name: string) => page.getByRole('region', { name, exact: true });
const serverRows = (page: Page) => region(page, 'Серверы').locator('tbody tr');

async function openDetail(page: Page, id: number, name: string) {
  await page.goto(`/#/sources/${id}`);
  await expect(heading(page, name)).toBeVisible();
  await expect(region(page, 'Сводка')).toBeVisible();
}

/** A card of the «Сборки» list. */
const buildCard = (page: Page, id = 7) => page.locator(`.bd-card[data-build-id="${id}"]`);
const buildForm = (page: Page) => page.getByRole('form', { name: 'Параметры сборки' });
/** The live preview of the constructor: what a client gets. */
const buildPreview = (page: Page) => region(page, 'Подписка клиента');
const previewTotal = (page: Page) => buildPreview(page).locator('.bd-preview-total');
const sourcePick = (page: Page, name: string) =>
  page.getByRole('group', { name: 'Источники сборки' }).getByRole('checkbox', { name: new RegExp(`^${name}`) });
const countryPick = (page: Page, name: string) => page.locator('.bd-country', { hasText: name }).locator('.bd-country-head input');

/** Opens the constructor of a stored сборка and waits for its catalogue. */
async function openBuild(page: Page, id = 7, name = 'Основной') {
  await page.goto(`/#/builders/${id}`);
  await expect(heading(page, name)).toBeVisible();
  await expect(buildForm(page)).toBeVisible();
  await expect(previewTotal(page)).not.toHaveText('Считаем серверы…');
}
test.describe('sources', () => {
  test('list: sync status, servers and countries of each source', async ({ page }) => {
    const api = await backend(page);
    await page.goto('/#/sources');
    await expect(heading(page, 'Источники')).toBeVisible();
    const list = region(page, 'Источники');
    await expect(list.locator('.panel-meta')).toHaveText('3 · 8 серверов всего');

    const a = list.getByRole('listitem', { name: 'Provider A' });
    await expect(a.locator('.source-stats')).toHaveText('5 серверов · 2 страны');
    await expect(a).toContainText('Синхронизирован');
    await expect(a).toContainText('Автоопределение');
    await expect(list.getByRole('listitem', { name: 'Provider B' })).toContainText('JSON (Xray / 3x-ui)');

    const broken = list.getByRole('listitem', { name: 'Broken' });
    await expect(broken).toContainText('Ошибка синхронизации');
    await expect(broken.locator('.source-error')).toHaveText('Источник не ответил вовремя.');
    await expect(broken.locator('.source-stats')).toHaveText('0 серверов · 0 стран');

    await a.getByRole('link', { name: 'Provider A', exact: true }).click();
    await expect(heading(page, 'Provider A')).toBeVisible();
    await expect(page).toHaveURL(/#\/sources\/1$/);
    expect(api.problems()).toEqual([]);
  });

  test('create: the link is the only required field; validation, initial sync, no URL echo', async ({ page }) => {
    const api = await backend(page, { outcomes: { 4: [{ entries: [e('n1', '🇫🇮 Helsinki', 'FI'), e('n2', '🇫🇮 Tampere', 'FI', 'trojan'), e('n3', '🇸🇪 Stockholm', 'SE')] }] } });
    await page.goto('/#/sources');
    await page.getByRole('button', { name: 'Добавить источник' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Новый источник' });
    await expect(dialog).toBeVisible();
    // The common case is one field: it comes first and has the focus; what a
    // provider rarely needs is folded away.
    const link = dialog.getByLabel('Ссылка на подписку провайдера');
    await expect(link).toBeFocused();
    await expect(dialog.getByLabel('Формат подписки')).toBeHidden();

    const submit = dialog.getByRole('button', { name: 'Создать и синхронизировать' });
    await submit.click();
    await expect(dialog.getByText('Нужен полный адрес http:// или https:// без #фрагмента.')).toBeVisible();
    await link.fill('provider.test/sub');
    await submit.click();
    await expect(dialog.getByText('Нужен полный адрес http:// или https:// без #фрагмента.')).toBeVisible();
    await expect(link).toHaveAttribute('aria-invalid', 'true');
    await link.fill(SECRET_URL);

    await dialog.getByText('Дополнительно', { exact: true }).click();
    const format = dialog.getByLabel('Формат подписки');
    await expect(format).toHaveValue('auto');
    await expect(format.locator('option')).toHaveText([
      'Автоопределение', 'JSON (Xray / 3x-ui)', 'Base64-подписка', 'Список ссылок', 'Clash / Mihomo (YAML)',
    ]);
    await format.selectOption('clash');
    await expect(dialog).toContainText('YAML-конфиг с разделом proxies.');
    await format.selectOption('auto');
    await dialog.getByLabel('Дополнительные заголовки').fill('{broken');
    await submit.click();
    await expect(dialog.getByText(/Заголовки — JSON-объект/)).toBeVisible();
    expect(api.calls('/admin/api/sources', 'POST')).toHaveLength(0);

    await dialog.getByLabel('Название').fill('Nordic');
    await dialog.getByLabel('Дополнительные заголовки').fill('{"X-Client": "panel"}');
    await submit.click();
    await expect(heading(page, 'Nordic')).toBeVisible();
    await expect(page).toHaveURL(/#\/sources\/4$/);

    const [create] = api.calls('/admin/api/sources', 'POST');
    expect(create.body).toEqual({
      name: 'Nordic', description: '', type: 'auto', subscription_url: SECRET_URL, hwid: '', user_agent: '',
      headers: '{"X-Client": "panel"}', enabled: true, expires_at: null,
    });
    // The initial sync ran on the server as part of the create request.
    expect(api.calls(/\/refresh$/)).toHaveLength(0);
    await expect(page.locator('.source-sync-status')).toContainText('Синхронизировано: 3 сервера · 2 страны.');
    await expect(page.locator('.source-sync-status')).toContainText('Формат ответа: Base64-подписка.');
    await expect(region(page, 'Сводка')).toContainText('Синхронизирован');
    await expect(serverRows(page)).toHaveCount(3);
    // The URL and credentials are write-only: never shown back.
    await expect(page.locator('body')).not.toContainText('fixture-token');
    expect(api.problems()).toEqual([]);
  });

  test('create: the name defaults to the host of the link; a failed initial sync keeps the source and says why', async ({ page }) => {
    const api = await backend(page, { outcomes: { 4: [{ error: 'http_403' }] } });
    await page.goto('/#/sources');
    await page.getByRole('button', { name: 'Добавить источник' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Новый источник' });
    const link = dialog.getByLabel('Ссылка на подписку провайдера');
    // The server names the field it rejects.
    await link.fill('https://provider.test/rejected');
    await dialog.getByRole('button', { name: 'Создать и синхронизировать' }).click();
    await expect(dialog.getByText('Нужен полный адрес http:// или https:// без #фрагмента.')).toBeVisible();
    await expect(link).toHaveAttribute('aria-invalid', 'true');

    await link.fill('https://www.guarded.example/list');
    await dialog.getByRole('button', { name: 'Создать и синхронизировать' }).click();
    // No name was typed: the source is called after the host of its link.
    await expect(heading(page, 'guarded.example')).toBeVisible();
    expect(api.calls('/admin/api/sources', 'POST').at(-1)!.body).toMatchObject({ name: 'guarded.example', type: 'auto', enabled: true });
    const status = page.locator('.source-sync-status');
    await expect(status).toContainText('Синхронизация не удалась. Источник ответил ошибкой HTTP 403. Каталог пуст.');
    await expect(region(page, 'Сводка')).toContainText('Ошибка синхронизации');
    await expect(serverRows(page)).toHaveText(['Каталог пуст. Нажмите «Синхронизировать».']);
    expect(api.problems()).toEqual([]);
  });

  test('edit: a new link from the provider replaces the stored one and the catalogue is read again', async ({ page }) => {
    const api = await backend(page);
    api.queue(1, { entries: [...CATALOGUE_A, e('a7', '🇫🇷 Paris', 'FR')] });
    await page.goto('/#/sources');
    const list = region(page, 'Источники');
    await list.getByRole('button', { name: 'Изменить «Provider A»' }).click();
    const dialog = page.getByRole('dialog', { name: 'Источник: Provider A' });
    await dialog.getByText('Заменить ссылку подписки', { exact: true }).click();
    // The stored link never reaches the browser: the field starts empty.
    const link = dialog.getByLabel('Новая ссылка на подписку');
    await expect(link).toHaveValue('');
    await link.fill('not a link');
    await dialog.getByRole('button', { name: 'Сохранить' }).click();
    await expect(dialog.getByText('Нужен полный адрес http:// или https:// без #фрагмента.')).toBeVisible();
    expect(api.calls('/admin/api/sources/1', 'PATCH')).toHaveLength(0);

    await link.fill('https://rotated.example/list');
    await dialog.getByRole('button', { name: 'Сохранить' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('.toast-region')).toContainText('Изменения сохранены, каталог серверов обновлён.');
    // Only what was typed is replaced; then the source is read again at once.
    expect(api.calls('/admin/api/sources/1', 'PATCH').map(c => c.body)).toEqual([
      { name: 'Provider A', description: '', type: 'auto', subscription_url: 'https://rotated.example/list' },
    ]);
    expect(api.calls('/admin/api/sources/1/refresh')).toHaveLength(1);
    await expect(list.getByRole('listitem', { name: 'Provider A' }).locator('.source-stats')).toHaveText('6 серверов · 3 страны');
    await expect(page.locator('body')).not.toContainText('rotated.example');
    expect(api.problems()).toEqual([]);
  });
  test('details: statistics and country breakdown', async ({ page }) => {
    const api = await backend(page);
    await openDetail(page, 1, 'Provider A');
    const summary = region(page, 'Сводка');
    await expect(summary.locator('.panel-meta')).toHaveText('5 серверов · 2 страны');
    await expect(summary).toContainText('Исчезли из подписки: 1');
    await expect(summary).toContainText('Без страны: 1');
    await expect(summary).toContainText('vless 3 · ss 1 · trojan 1');

    const chips = region(page, 'Страны').locator('.country-chip');
    await expect(chips).toHaveText(['🇩🇪 DE · 3', '🇳🇱 NL · 1', 'Без страны · 1']);
    expect(api.problems()).toEqual([]);
  });

  test('details: full node list with country, protocol and name filters', async ({ page }) => {
    const api = await backend(page);
    await openDetail(page, 1, 'Provider A');
    const servers = region(page, 'Серверы');
    const count = servers.locator('.source-filter-count');
    await expect(serverRows(page)).toHaveCount(5);
    await expect(count).toHaveText('Показано 5 из 5');

    await region(page, 'Страны').locator('.country-chip[data-country="DE"]').click();
    await expect(servers.getByLabel('Страна')).toHaveValue('DE');
    await expect(serverRows(page)).toHaveCount(3);
    await expect(region(page, 'Страны').locator('.country-chip[data-country="DE"]')).toHaveAttribute('aria-pressed', 'true');

    await servers.getByLabel('Протокол').selectOption('trojan');
    await expect(serverRows(page)).toHaveCount(1);
    await expect(serverRows(page).first()).toContainText('🇩🇪 Berlin');
    await servers.getByLabel('Протокол').selectOption('');

    await servers.getByLabel('Поиск по имени').fill('frankfurt 2');
    await expect(serverRows(page)).toHaveCount(1);
    await expect(count).toHaveText('Показано 1 из 5');
    await servers.getByLabel('Поиск по имени').fill('');

    await servers.getByLabel('Страна').selectOption('-');
    await expect(serverRows(page)).toHaveCount(1);
    await expect(serverRows(page).first()).toContainText('Mystery');
    await servers.getByLabel('Страна').selectOption('');

    await servers.getByLabel('Показывать исчезнувшие (1)').check();
    await expect(serverRows(page)).toHaveCount(6);
    await expect(servers.locator('tbody tr.is-absent')).toContainText('🇩🇪 Old');
    await servers.getByLabel('Поиск по имени').fill('zzz');
    await expect(serverRows(page)).toHaveText(['Нет серверов под выбранные фильтры.']);
    expect(api.problems()).toEqual([]);
  });

  test('refresh: success updates the catalogue, partial is reported', async ({ page }) => {
    const api = await backend(page);
    api.queue(1,
      { entries: [...CATALOGUE_A.slice(0, 4), e('a6', '🇺🇸 Seattle', 'US', 'hysteria2')] },
      { entries: CATALOGUE_A, skipped: 2 });
    await openDetail(page, 1, 'Provider A');
    const sync = page.getByRole('button', { name: 'Синхронизировать', exact: true });
    await sync.click();
    await expect(page.getByRole('button', { name: 'Синхронизируем…' })).toBeDisabled();
    const status = page.locator('.source-sync-status');
    await expect(status).toContainText('Синхронизировано: 5 серверов · 3 страны.');
    await expect(status).toContainText('Добавлено 1, обновлено 4, исчезло 1.');
    await expect(region(page, 'Страны').locator('.country-chip')).toHaveText(['🇩🇪 DE · 3', '🇳🇱 NL · 1', '🇺🇸 US · 1']);
    await expect(serverRows(page)).toHaveCount(5);
    await expect(sync).toBeEnabled();

    await sync.click();
    await expect(status).toContainText('Не удалось разобрать 2 сервера из ответа.');
    await expect(region(page, 'Сводка')).toContainText('Синхронизирован частично');
    expect(api.calls('/admin/api/sources/1/refresh').map(c => c.body)).toEqual([{}, {}]);
    expect(api.problems()).toEqual([]);
  });

  test('refresh: a failure (timeout) keeps the previous catalogue', async ({ page }) => {
    const api = await backend(page);
    api.queue(1, { error: 'timeout' });
    await openDetail(page, 1, 'Provider A');
    await page.getByRole('button', { name: 'Синхронизировать', exact: true }).click();
    await expect(page.locator('.source-sync-status')).toContainText(
      'Синхронизация не удалась. Источник не ответил вовремя. Сохранён прежний каталог: 5 серверов.');
    const summary = region(page, 'Сводка');
    await expect(summary).toContainText('Ошибка синхронизации');
    await expect(summary).toContainText('Показан каталог последней успешной синхронизации');
    await expect(summary.locator('.panel-meta')).toHaveText('5 серверов · 2 страны');
    await expect(serverRows(page)).toHaveCount(5);

    // The list shows the same outcome for the row.
    await page.getByRole('link', { name: 'Назад к источникам' }).click();
    const row = region(page, 'Источники').getByRole('listitem', { name: 'Provider A' });
    await expect(row).toContainText('Ошибка синхронизации');
    await expect(row.locator('.source-stats')).toHaveText('5 серверов · 2 страны');
    expect(api.problems()).toEqual([]);
  });

  test('refresh from the list row', async ({ page }) => {
    const api = await backend(page);
    api.queue(3, { entries: [e('c1', '🇯🇵 Tokyo', 'JP')] });
    await page.goto('/#/sources');
    const row = region(page, 'Источники').getByRole('listitem', { name: 'Broken' });
    await row.getByRole('button', { name: 'Синхронизировать «Broken»' }).click();
    await expect(row.locator('.source-stats')).toHaveText('1 сервер · 1 страна');
    await expect(row).toContainText('Синхронизирован');
    await expect(row.locator('.notice')).toContainText('Синхронизировано: 1 сервер · 1 страна.');
    expect(api.problems()).toEqual([]);
  });
});

test.describe('сборки', () => {
  const rule = (over: Partial<Item> & Pick<Item, 'id' | 'kind' | 'source_id' | 'position'>): Item => ({
    country_code: '', fingerprint: '', original_name: '', custom_name: null, description: '', enabled: true, ...over,
  });

  test('list: what each сборка gives, its price, health and clients', async ({ page }) => {
    const api = await backend(page, { builderSources: [1, 2] });
    api.changeBuilder(b => {
      b.items = [
        rule({ id: 51, kind: 'country', source_id: 1, country_code: 'DE', position: 0 }),
        rule({ id: 52, kind: 'node', source_id: 2, fingerprint: 'b2', original_name: '🇺🇸 Dallas', position: 1 }),
        rule({ id: 53, kind: 'country', source_id: 2, country_code: 'US', position: 2, enabled: false }),
      ];
    });
    await page.goto('/#/builders');
    await expect(heading(page, 'Сборки')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Сборки', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('.bd-summary')).toHaveText('1 сборка · в продаже 0');
    const card = buildCard(page);
    await expect(card.locator('.bd-card-title')).toHaveText('Основной');
    // A whole country counts by the catalogue, a single server as one; the
    // switched-off rule gives nothing.
    await expect(card.locator('.bd-card-facts')).toHaveText('4 сервера · 1 страна · выбранные страны и серверы');
    await expect(card.locator('.bd-codes')).toHaveText('DE');
    await expect(card).toContainText('Без цены');
    await expect(card.locator('.bd-card-prices')).toHaveText('Цена не задана: купить эту сборку пока нельзя');
    await expect(card.locator('.bd-card-meta')).toHaveText('0 клиентов · источник: Provider A, Provider B');
    await expect(card.locator('.bd-card-health')).toHaveText('Проверка ещё не выполнялась');
    // The plan a сборка is sold on is internal: the list never mentions one.
    await expect(page.getByRole('main')).not.toContainText(/план/i);

    await card.getByRole('link', { name: 'Открыть «Основной»' }).click();
    await expect(page).toHaveURL(/#\/builders\/7$/);
    await expect(heading(page, 'Основной')).toBeVisible();
    expect(api.problems()).toEqual([]);
  });

  test('create: source, countries, names and price on one page; the result is what a client gets', async ({ page }) => {
    const api = await backend(page);
    await page.goto('/#/builders/new');
    await expect(heading(page, 'Новая сборка')).toBeVisible();

    // 1. The source. Everything it has is the default: a wide subscription.
    await sourcePick(page, 'Provider A').check();
    await expect(previewTotal(page)).toHaveText('5 серверов · 2 страны');
    const name = page.getByLabel('Название сборки');
    await expect(name).toHaveValue('Все серверы · Provider A');

    // 2. A narrow one: only what is ticked. The name follows the choice.
    await page.getByRole('radio', { name: /Выбрать страны и серверы/ }).check();
    await expect(buildPreview(page)).toContainText('Ничего не отмечено: клиент получит пустую подписку.');
    await countryPick(page, 'Германия').check();
    await expect(page.locator('.bd-country', { hasText: 'Германия' })).toContainText('Вся страна: новые серверы провайдера добавятся сами.');
    await expect(previewTotal(page)).toHaveText('3 сервера · 1 страна');
    await expect(name).toHaveValue('Германия');
    await page.getByRole('button', { name: 'Показать серверы: Нидерланды' }).click();
    await page.getByRole('checkbox', { name: '🇳🇱 Amsterdam' }).check();
    await expect(previewTotal(page)).toHaveText('4 сервера · 2 страны');
    await expect(name).toHaveValue('Германия и Нидерланды');

    // 3. Names the client sees.
    await page.getByLabel('Своё название: Германия').fill('DE Fast');
    await expect(buildPreview(page).locator('.bd-preview-name')).toHaveText(['DE Fast', 'DE Fast', 'DE Fast', '🇳🇱 Amsterdam']);

    // 5. The price: a preset term, only the amount is typed.
    await page.getByRole('button', { name: '+ 1 месяц' }).click();
    await expect(page.getByLabel('Срок, дней')).toHaveValue('30');
    await page.getByLabel('Цена, ₽').fill('199');
    expect(api.calls(undefined, 'POST')).toHaveLength(0);

    await buildForm(page).getByRole('button', { name: 'Создать сборку' }).click();
    await expect(page).toHaveURL(/#\/builders\/8$/);
    await expect(heading(page, 'Германия и Нидерланды')).toBeVisible();
    await expect(buildForm(page).locator('.editor-status')).toContainText('Сборка «Германия и Нидерланды» создана и выставлена на продажу: 1 цена.');
    const price = page.locator('.bd-price');
    await expect(price).toHaveCount(1);
    await expect(price).toContainText('1 месяц');
    await expect(price).toContainText('30 дней · 199 ₽');
    await expect(price).toContainText('В продаже');

    // One create, one configuration save, one tariff — and no plan anywhere.
    const meta = { name: 'Германия и Нидерланды', description: '', enabled: true, profile_title: '', support_url: '', announce: '' };
    expect(api.calls('/admin/api/builders', 'POST').map(c => c.body)).toEqual([{ request_key: expect.stringMatching(KEY_PATTERN), ...meta }]);
    expect(api.calls('/admin/api/builders/8/configuration', 'PUT').map(c => c.body)).toEqual([{
      request_key: expect.stringMatching(KEY_PATTERN), version: 1, ...meta, source_ids: [1],
      items: [
        { id: 0, kind: 'country', source_id: 1, country_code: 'DE', fingerprint: '', original_name: '', custom_name: 'DE Fast', description: '', enabled: true },
        { id: 0, kind: 'node', source_id: 1, country_code: '', fingerprint: 'a4', original_name: '🇳🇱 Amsterdam', custom_name: null, description: '', enabled: true },
      ],
    }]);
    expect(api.calls('/admin/api/tariffs', 'POST').map(c => c.body)).toEqual([{
      request_key: expect.stringMatching(KEY_PATTERN), name: '1 месяц', builder_id: 8, duration_days: 30, price_cents: 19900,
      currency: 'RUB', description: '', features: [], badge: '', is_active: true,
    }]);
    await expect(page.getByRole('main')).not.toContainText(/план/i);

    // The server assembles the saved сборка exactly like for a client.
    const check = region(page, 'Проверка на сервере');
    await check.getByRole('button', { name: 'Проверить на сервере' }).click();
    await expect(check).toContainText('Клиент получит: 4 сервера · 2 страны.');
    expect(api.problems()).toEqual([]);
  });

  test('edit: the stored composition is ticked; a stale tab cannot overwrite it', async ({ page }) => {
    const api = await backend(page);
    api.changeBuilder(b => { b.items = [rule({ id: 51, kind: 'country', source_id: 1, country_code: 'DE', position: 0 })]; });
    await openBuild(page);
    const save = () => buildForm(page).getByRole('button', { name: 'Сохранить', exact: true });
    await expect(countryPick(page, 'Германия')).toBeChecked();
    await expect(countryPick(page, 'Нидерланды')).not.toBeChecked();
    await expect(buildForm(page).getByText('Все изменения сохранены')).toBeVisible();
    await expect(save()).toBeDisabled();
    await expect(previewTotal(page)).toHaveText('3 сервера · 1 страна');

    await countryPick(page, 'Нидерланды').check();
    await expect(buildForm(page).getByText('Есть несохранённые изменения')).toBeVisible();
    await expect(previewTotal(page)).toHaveText('4 сервера · 2 страны');

    // Another tab saved the сборка meanwhile: this one must not overwrite it.
    api.changeBuilder(b => { b.version = 5; b.items = []; });
    await save().click();
    const status = buildForm(page).locator('.editor-status');
    await expect(status).toContainText('Изменения не сохранены. Сборку изменили в другом окне или другим администратором. Сохранённая версия не затронута.');
    expect(api.builder()).toMatchObject({ version: 5, items: [] });

    page.once('dialog', dialog => void dialog.accept());
    await status.getByRole('button', { name: 'Загрузить актуальную версию' }).click();
    // The server state: no rules is «все серверы».
    await expect(page.getByRole('radio', { name: /Все серверы/ })).toBeChecked();
    await expect(previewTotal(page)).toHaveText('5 серверов · 2 страны');

    await page.getByRole('radio', { name: /Выбрать страны и серверы/ }).check();
    await countryPick(page, 'Нидерланды').check();
    await save().click();
    await expect(buildForm(page).locator('.editor-status')).toContainText('Сборка сохранена. Клиенты получат изменения при следующем обновлении подписки.');
    const saves = api.calls('/admin/api/builders/7/configuration', 'PUT');
    expect(saves.map(c => c.body.version)).toEqual([1, 5]);
    // A retry after a refusal is a new request, never a replay.
    expect(saves[0].body.request_key).not.toBe(saves[1].body.request_key);
    expect(saves[1].body.items).toEqual([
      { id: 0, kind: 'country', source_id: 1, country_code: 'NL', fingerprint: '', original_name: '', custom_name: null, description: '', enabled: true },
    ]);
    expect(api.builder().items.map(item => item.country_code)).toEqual(['NL']);
    expect(api.problems()).toEqual([]);
  });

  test('duplicate opens an unsaved copy; switching off stops serving a сборка', async ({ page }) => {
    const api = await backend(page);
    await page.goto('/#/builders');
    await page.getByRole('button', { name: 'Дублировать «Основной»' }).click();
    await expect(page).toHaveURL(/#\/builders\/new$/);
    await expect(page.getByLabel('Название сборки')).toHaveValue('Основной (копия)');
    await expect(sourcePick(page, 'Provider A')).toBeChecked();
    // Nothing is written until the copy is saved.
    expect(api.builderIds()).toEqual([7]);
    await buildForm(page).getByRole('button', { name: 'Создать сборку' }).click();
    await expect(page).toHaveURL(/#\/builders\/8$/);
    await expect(heading(page, 'Основной (копия)')).toBeVisible();
    expect(api.builderIds()).toEqual([7, 8]);
    expect(api.builders()[1]).toMatchObject({ name: 'Основной (копия)', sources: [{ source_id: 1, position: 0 }], items: [] });

    await page.getByRole('link', { name: 'Назад к сборкам' }).click();
    await expect(page.locator('.bd-summary')).toHaveText('2 сборки · в продаже 0');
    await page.getByRole('button', { name: 'Отключить «Основной»' }).click();
    await expect(page.locator('.toast-region')).toContainText('Сборка «Основной» отключена: клиенты перестали её получать.');
    await expect(buildCard(page).locator('.bd-card-health')).toHaveText('Отключена: клиентам не выдаётся');
    await expect(page.getByRole('button', { name: 'Включить «Основной»' })).toBeVisible();
    expect(api.builder().enabled).toBe(false);
    expect(api.problems()).toEqual([]);
  });
});
// The browser runs in UTC (playwright.admin.config.ts), so a datetime-local
// value is the UTC wall clock; dates are relative to the real clock because
// the panel validates against Date.now().
const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 16);
/** A datetime-local value as the panel prints it (ru-RU, dd.mm.yyyy, hh:mm). */
const printed = (local: string) => `${local.slice(8, 10)}.${local.slice(5, 7)}.${local.slice(0, 4)}, ${local.slice(11, 16)}`;
const toasts = (page: Page) => page.locator('.toast-region');
const sourceDeletes = (api: Awaited<ReturnType<typeof backend>>) => api.calls(/^\/admin\/api\/sources\/\d+$/, 'DELETE');
const builderDeletes = (api: Awaited<ReturnType<typeof backend>>) => api.calls(/^\/admin\/api\/builders\/\d+$/, 'DELETE');

test.describe('source validity end', () => {
  test('create: the end is validated, sent in UTC and shown in the list and details', async ({ page }) => {
    const api = await backend(page, { outcomes: { 4: [{ entries: [e('n1', '🇫🇮 Helsinki', 'FI')] }] } });
    await page.goto('/#/sources');
    await page.getByRole('button', { name: 'Добавить источник' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Новый источник' });
    await dialog.getByLabel('Название').fill('Termed');
    await dialog.getByLabel('Ссылка на подписку провайдера').fill(SECRET_URL);
    const until = dialog.getByLabel('Действует до');
    await expect(until).toHaveValue('');
    const submit = dialog.getByRole('button', { name: 'Создать и синхронизировать' });

    // A past end would switch the source off the moment it is saved.
    await until.fill('2020-01-01T10:00');
    await submit.click();
    await expect(dialog.getByText('Срок должен быть в будущем. Чтобы выключить источник сейчас, отключите его.')).toBeVisible();
    await expect(until).toHaveAttribute('aria-invalid', 'true');
    expect(api.calls('/admin/api/sources', 'POST')).toHaveLength(0);

    // Presets fill a future end and clear the error; "Бессрочно" empties the field.
    await dialog.getByRole('button', { name: 'Срок действия: 30 дней от текущего момента' }).click();
    await expect(until).toHaveValue(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    await expect(until).not.toHaveAttribute('aria-invalid', 'true');
    await dialog.getByRole('button', { name: 'Убрать срок действия: источник бессрочный' }).click();
    await expect(until).toHaveValue('');

    const local = inDays(40);
    await until.fill(local);
    await submit.click();
    await expect(heading(page, 'Termed')).toBeVisible();
    const [create] = api.calls('/admin/api/sources', 'POST');
    expect(create.body.expires_at).toBe(`${local}:00Z`);
    await expect(region(page, 'Сводка')).toContainText('Действует до');
    await expect(region(page, 'Сводка')).toContainText(printed(local));

    await page.goto('/#/sources');
    const row = region(page, 'Источники').getByRole('listitem', { name: 'Termed' });
    await expect(row.locator('.source-meta')).toContainText(`Действует до ${printed(local)}`);
    await expect(row).not.toContainText('Срок истёк');
    await expect(row).not.toContainText('Скоро истекает');
    // A source without a limit says nothing about it.
    await expect(region(page, 'Источники').getByRole('listitem', { name: 'Provider A' })).not.toContainText('Действует до');
    expect(api.problems()).toEqual([]);
  });

  test('edit: an untouched end is not sent, a new one replaces it, "Бессрочно" clears it', async ({ page }) => {
    const stored = inDays(10);
    const api = await backend(page, { expiresAt: { 1: `${stored}:00Z` } });
    await page.goto('/#/sources');
    const list = region(page, 'Источники');
    const patches = () => api.calls('/admin/api/sources/1', 'PATCH');
    const save = async (dialogName: string, edit: (dialog: ReturnType<Page['getByRole']>) => Promise<void>) => {
      const dialog = page.getByRole('dialog', { name: dialogName });
      await expect(dialog).toBeVisible();
      await edit(dialog);
      await dialog.getByRole('button', { name: 'Сохранить' }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
    };

    await list.getByRole('button', { name: 'Изменить «Provider A»' }).click();
    await save('Источник: Provider A', async dialog => {
      await expect(dialog.getByLabel('Действует до')).toHaveValue(stored);
      await dialog.getByLabel('Название').fill('Provider A2');
    });
    // The member is absent: the server keeps the stored end.
    expect(patches()[0].body).toEqual({ name: 'Provider A2', description: '', type: 'auto' });
    const row = list.getByRole('listitem', { name: 'Provider A2' });
    await expect(row.locator('.source-meta')).toContainText(`Действует до ${printed(stored)}`);

    const later = inDays(90);
    await list.getByRole('button', { name: 'Изменить «Provider A2»' }).click();
    await save('Источник: Provider A2', dialog => dialog.getByLabel('Действует до').fill(later));
    expect(patches()[1].body).toEqual({ name: 'Provider A2', description: '', type: 'auto', expires_at: `${later}:00Z` });
    await expect(row.locator('.source-meta')).toContainText(`Действует до ${printed(later)}`);

    await list.getByRole('button', { name: 'Изменить «Provider A2»' }).click();
    await save('Источник: Provider A2', dialog => dialog.getByRole('button', { name: 'Убрать срок действия: источник бессрочный' }).click());
    expect(patches()[2].body).toEqual({ name: 'Provider A2', description: '', type: 'auto', expires_at: null });
    await expect(row).not.toContainText('Действует до');
    expect(api.problems()).toEqual([]);
  });

  test('an expired source is flagged, left out of the builder totals and comes back when extended', async ({ page }) => {
    const api = await backend(page, { builderSources: [1, 2], expiresAt: { 1: `${inDays(2)}:00Z`, 2: '2020-01-01T00:00:00Z' } });
    await page.goto('/#/sources');
    const list = region(page, 'Источники');
    const b = list.getByRole('listitem', { name: 'Provider B' });
    // Expiry does not flip the admin switch: both badges are shown.
    await expect(b).toContainText('Включён');
    await expect(b).toContainText('Срок истёк');
    await expect(b.locator('.source-error')).toHaveText('Срок действия истёк: сборки пропускают источник, как отключённый.');
    await expect(b.locator('.source-meta')).toContainText('Срок истёк 01.01.2020, 00:00');
    // Less than three days left.
    await expect(list.getByRole('listitem', { name: 'Provider A' })).toContainText('Скоро истекает');
    await expect(list.getByRole('listitem', { name: 'Broken' })).not.toContainText('истек');

    await openDetail(page, 2, 'Provider B');
    await expect(region(page, 'Сводка')).toContainText('Срок истёк: сборки пропускают источник, как отключённый');
    await expect(page.locator('body')).toContainText('включён · срок истёк');

    // The constructor counts only what /sub would serve.
    await openBuild(page);
    await expect(page.locator('.bd-source', { hasText: 'Provider B' })).toContainText('Срок истёк');
    await expect(region(page, '1. Источник')).toContainText('Сейчас не используется: Provider B.');
    await expect(previewTotal(page)).toHaveText('5 серверов · 2 страны');
    const check = region(page, 'Проверка на сервере');
    await check.getByRole('button', { name: 'Проверить на сервере' }).click();
    await expect(check).toContainText('Клиент получит: 5 серверов · 2 страны.');
    // Renaming an expired source does not reject its past end...
    await page.goto('/#/sources');
    await list.getByRole('button', { name: 'Изменить «Provider B»' }).click();
    let editor = page.getByRole('dialog', { name: 'Источник: Provider B' });
    await expect(editor.getByLabel('Действует до')).toHaveValue('2020-01-01T00:00');
    await editor.getByText('Дополнительно', { exact: true }).click();
    await editor.getByLabel('Заметка').fill('renewal pending');
    await editor.getByRole('button', { name: 'Сохранить' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(api.calls('/admin/api/sources/2', 'PATCH')[0].body).toEqual({ name: 'Provider B', description: 'renewal pending', type: 'json' });
    await expect(b).toContainText('Срок истёк');

    // ...and extending it brings the source back.
    await list.getByRole('button', { name: 'Изменить «Provider B»' }).click();
    editor = page.getByRole('dialog', { name: 'Источник: Provider B' });
    await editor.getByRole('button', { name: 'Срок действия: 90 дней от текущего момента' }).click();
    await editor.getByRole('button', { name: 'Сохранить' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(b).not.toContainText('Срок истёк');
    await expect(b.locator('.source-error')).toHaveCount(0);
    expect(api.problems()).toEqual([]);
  });

  test('a server rejection of the end is shown on the field', async ({ page }) => {
    const api = await backend(page);
    // The server clock is ahead of the browser: the end the panel accepted is already past there.
    await page.route('**/admin/api/sources/3', async route => {
      if (route.request().method() !== 'PATCH') return route.fallback();
      await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'invalid_source', field: 'expires_at' }) });
    });
    await page.goto('/#/sources');
    await region(page, 'Источники').getByRole('button', { name: 'Изменить «Broken»' }).click();
    const dialog = page.getByRole('dialog', { name: 'Источник: Broken' });
    await dialog.getByLabel('Действует до').fill(inDays(1));
    await dialog.getByRole('button', { name: 'Сохранить' }).click();
    await expect(dialog.getByText('Срок должен быть корректной датой и временем в будущем.')).toBeVisible();
    await expect(dialog.getByLabel('Действует до')).toHaveAttribute('aria-invalid', 'true');
    await expect(dialog.getByLabel('Действует до')).toBeFocused();
    expect(api.problems()).toEqual([]);
  });
});

test.describe('deleting sources and builders', () => {
  test('source: explained while used, confirmed and removed when free', async ({ page }) => {
    const api = await backend(page);
    await page.goto('/#/sources');
    const list = region(page, 'Источники');
    await expect(list.locator('.panel-meta')).toHaveText('3 · 8 серверов всего');

    // Linked to the builder: nothing is asked and nothing is sent.
    await list.getByRole('button', { name: 'Удалить «Provider A»' }).click();
    await expect(toasts(page)).toContainText('Источник «Provider A» нельзя удалить: используется сборкой «Основной». Его можно отключить.');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(sourceDeletes(api)).toHaveLength(0);

    // Cancelling keeps the source.
    await list.getByRole('button', { name: 'Удалить «Broken»' }).click();
    const confirm = page.getByRole('dialog', { name: 'Удалить источник «Broken»?' });
    await expect(confirm).toContainText('Источник и его каталог серверов будут удалены. Действие нельзя отменить.');
    await confirm.getByRole('button', { name: 'Отмена' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(list.getByRole('listitem', { name: 'Broken' })).toBeVisible();
    expect(sourceDeletes(api)).toHaveLength(0);

    await list.getByRole('button', { name: 'Удалить «Broken»' }).click();
    await page.getByRole('dialog', { name: 'Удалить источник «Broken»?' }).getByRole('button', { name: 'Удалить' }).click();
    await expect(list.getByRole('listitem', { name: 'Broken' })).toHaveCount(0);
    await expect(toasts(page)).toContainText('Источник «Broken» удалён.');
    await expect(list.locator('.panel-meta')).toHaveText('2 · 8 серверов всего');
    const [del] = sourceDeletes(api);
    expect(del.path).toBe('/admin/api/sources/3');
    expect(Object.keys(del.body)).toEqual(['request_key']);
    expect(String(del.body.request_key)).toMatch(KEY_PATTERN);
    expect(api.sourceIds()).toEqual([1, 2]);
    expect(api.problems()).toEqual([]);
  });

  test('source: a list that went stale is corrected by the server and reloaded', async ({ page }) => {
    const api = await backend(page);
    await page.goto('/#/sources');
    const list = region(page, 'Источники');
    await expect(list.getByRole('listitem', { name: 'Provider B' })).toBeVisible();
    // Subscriptions were sold on the source after the list was loaded.
    api.sell(2, 3);
    const reads = api.sourceListReads();
    await list.getByRole('button', { name: 'Удалить «Provider B»' }).click();
    await page.getByRole('dialog', { name: 'Удалить источник «Provider B»?' }).getByRole('button', { name: 'Удалить' }).click();
    await expect(toasts(page)).toContainText('Источник «Provider B» уже используется сборкой или подпиской: удалить его нельзя, можно отключить.');
    await expect(list.getByRole('listitem', { name: 'Provider B' })).toBeVisible();
    await expect.poll(() => api.sourceListReads()).toBeGreaterThan(reads);
    expect(api.sourceIds()).toEqual([1, 2, 3]);

    // The details page explains why and offers switching off instead.
    await openDetail(page, 2, 'Provider B');
    await expect(region(page, 'Сводка')).toContainText('Удалить нельзя: на нём проданы 3 подписки. Источник можно отключить.');
    await region(page, 'Сводка').getByRole('button', { name: 'Удалить' }).click();
    await expect(toasts(page)).toContainText('Источник «Provider B» нельзя удалить: на нём проданы 3 подписки. Его можно отключить.');
    expect(sourceDeletes(api)).toHaveLength(1);
    expect(api.problems()).toEqual([]);
  });

  test('source: deleting from the details page returns to the list', async ({ page }) => {
    const api = await backend(page);
    await openDetail(page, 3, 'Broken');
    await expect(region(page, 'Сводка')).not.toContainText('Удалить нельзя');
    await region(page, 'Сводка').getByRole('button', { name: 'Удалить' }).click();
    await page.getByRole('dialog', { name: 'Удалить источник «Broken»?' }).getByRole('button', { name: 'Удалить' }).click();
    await expect(page).toHaveURL(/#\/sources$/);
    await expect(heading(page, 'Источники')).toBeVisible();
    await expect(region(page, 'Источники').getByRole('listitem', { name: 'Broken' })).toHaveCount(0);
    await expect(region(page, 'Источники').getByRole('listitem', { name: 'Provider A' })).toBeVisible();
    expect(sourceDeletes(api)).toHaveLength(1);
    expect(api.problems()).toEqual([]);
  });

  test('сборка: the trial that runs on it blocks the deletion', async ({ page }) => {
    const api = await backend(page, { plans: [{ id: 2, name: 'trial' }] });
    await page.goto('/#/builders');
    await expect(buildCard(page)).toContainText('Пробная подписка');
    await page.getByRole('button', { name: 'Удалить «Основной»' }).click();
    await expect(toasts(page)).toContainText('Сборку «Основной» нельзя удалить: на ней работает «пробная подписка». Её можно отключить.');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(builderDeletes(api)).toHaveLength(0);
    expect(api.problems()).toEqual([]);
  });

  test('сборка: the loaded version is checked, then it is removed and frees its sources', async ({ page }) => {
    const api = await backend(page);
    await page.goto('/#/builders');
    const remove = page.getByRole('button', { name: 'Удалить «Основной»' });
    await expect(remove).toBeVisible();

    // Another tab renamed and saved the сборка: the stale card must not delete it.
    api.changeBuilder(b => { b.version = 5; b.name = 'Европа'; });
    await remove.click();
    const confirm = page.getByRole('dialog', { name: 'Удалить сборку «Основной»?' });
    await expect(confirm).toContainText('Сборка, её состав и названия серверов будут удалены. Источники и их серверы останутся. Действие нельзя отменить.');
    await confirm.getByRole('button', { name: 'Удалить' }).click();
    await expect(toasts(page)).toContainText('Сборка «Основной» не удалена. Сборку изменили в другом окне или другим администратором.');
    expect(api.builderIds()).toEqual([7]);

    // The list is read again, so the next attempt carries the current version.
    await page.getByRole('button', { name: 'Удалить «Европа»' }).click();
    await page.getByRole('dialog', { name: 'Удалить сборку «Европа»?' }).getByRole('button', { name: 'Удалить' }).click();
    await expect(page.getByText('Сборок пока нет')).toBeVisible();
    await expect(toasts(page)).toContainText('Сборка «Европа» удалена.');
    const deletes = builderDeletes(api);
    expect(deletes.map(c => c.body.version)).toEqual([1, 5]);
    for (const c of deletes) {
      expect(Object.keys(c.body).sort()).toEqual(['request_key', 'version']);
      expect(String(c.body.request_key)).toMatch(KEY_PATTERN);
    }
    // A retry is a new request, not a replay of the rejected one.
    expect(deletes[0].body.request_key).not.toBe(deletes[1].body.request_key);
    expect(api.builderIds()).toEqual([]);
    // Its source is no longer referenced and can be deleted now.
    await page.goto('/#/sources');
    await region(page, 'Источники').getByRole('button', { name: 'Удалить «Provider A»' }).click();
    await page.getByRole('dialog', { name: 'Удалить источник «Provider A»?' }).getByRole('button', { name: 'Удалить' }).click();
    await expect(region(page, 'Источники').getByRole('listitem', { name: 'Provider A' })).toHaveCount(0);
    expect(api.sourceIds()).toEqual([2, 3]);
    expect(api.problems()).toEqual([]);
  });
});
