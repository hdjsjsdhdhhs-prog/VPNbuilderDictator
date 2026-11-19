// Pure logic of the «Сборки» section: a сборка is a subscription builder as the
// owner sees it — which servers of the bought provider subscriptions a client
// gets and for what price. No DOM, no network: covered by
// tests/admin-builds.test.ts.
//
// The composition is edited as ticks (a whole country or single servers) and
// stored as the builder rules the backend already has:
//   mode "all"      -> no rules: every server of every linked source;
//   country ticked  -> one country rule: new servers of that country join by
//                      themselves after the next sync of the source;
//   servers ticked  -> one node rule per server.
// resolveDraft mirrors subserver.selectBuilderEntries, so the preview shows
// what /sub will serve; the backend stays authoritative.

import type {
  AdminBuilder, AdminSource, AdminTariff, BuilderConfigItemInput, BuilderDependents, MonitorBuilderSummary, SourceEntry,
} from './api';
import type { HealthTone } from './monitoring';
import { countriesLabel, resolveNode, serversLabel, sourceUsable } from './sources';
import { durationLabel, formatTariffPrice, parsePriceInput, pluralRu } from './tariffs';
import { countryName, entryCountry, groupByCountry, type CountryGroup } from './trial';

export const BUILD_LIMITS = { name: 128, profileTitle: 128, announce: 512, supportUrl: 512, description: 4096, customName: 128, rules: 500 } as const;

const countFormat = new Intl.NumberFormat('ru-RU');
const chars = (value: string) => Array.from(value).length;

// ---------------------------------------------------------------------------
// Routes: #/builders (list), #/builders/new, #/builders/{id}.

export type BuildsRoute = { readonly view: 'list' } | { readonly view: 'new'; readonly sourceId: number | null } | { readonly view: 'edit'; readonly id: number };

const EDIT_ROUTE = /^builders\/([1-9][0-9]{0,15})$/;
const NEW_ROUTE = /^builders\/new(?:\/from\/([1-9][0-9]{0,15}))?$/;

/** null when the path is not a builds route. */
export function parseBuildsRoute(path: string): BuildsRoute | null {
  if (path === 'builders') return { view: 'list' };
  const created = NEW_ROUTE.exec(path);
  if (created) {
    const sourceId = created[1] ? Number(created[1]) : null;
    return { view: 'new', sourceId: sourceId !== null && Number.isSafeInteger(sourceId) ? sourceId : null };
  }
  const edit = EDIT_ROUTE.exec(path);
  if (edit) {
    const id = Number(edit[1]);
    if (Number.isSafeInteger(id)) return { view: 'edit', id };
  }
  return null;
}

export function buildsHash(route: BuildsRoute): string {
  if (route.view === 'list') return '#/builders';
  if (route.view === 'edit') return `#/builders/${route.id}`;
  return route.sourceId === null ? '#/builders/new' : `#/builders/new/from/${route.sourceId}`;
}

// ---------------------------------------------------------------------------
// Draft

/** One stored rule: a whole country of a source, or one server. */
export interface DraftRule {
  /** Stored rule id; 0 for a rule added in the editor. */
  readonly id: number;
  readonly kind: 'country' | 'node';
  readonly sourceId: number;
  /** Country rules: ISO code. */
  readonly countryCode: string;
  /** Node rules: the stable identity of the server and its name in the source. */
  readonly fingerprint: string;
  readonly originalName: string;
  /** '' keeps the name the provider gave. */
  readonly customName: string;
  readonly description: string;
}

export type BuildMode = 'all' | 'selected';

export interface BuildDraft {
  readonly name: string;
  readonly enabled: boolean;
  readonly description: string;
  readonly profileTitle: string;
  readonly supportUrl: string;
  readonly announce: string;
  readonly mode: BuildMode;
  readonly sourceIds: readonly number[];
  readonly rules: readonly DraftRule[];
}

export const newDraft = (sourceIds: readonly number[] = []): BuildDraft => ({
  name: '', enabled: true, description: '', profileTitle: '', supportUrl: '', announce: '',
  mode: 'all', sourceIds: [...sourceIds], rules: [],
});

/**
 * The stored builder as a draft. Rules switched off in the old editor are not
 * ticked here: saving the draft removes them, exactly what the screen shows.
 */
export function draftFromBuilder(b: AdminBuilder): BuildDraft {
  const items = b.items ?? [];
  const rules = [...items].filter(item => item.enabled)
    .sort((x, y) => x.position - y.position || x.id - y.id)
    .map((item): DraftRule => ({
      id: item.id, kind: item.kind === 'country' ? 'country' : 'node', sourceId: item.source_id,
      countryCode: item.kind === 'country' ? (item.country_code ?? '').toUpperCase() : '',
      fingerprint: item.kind === 'node' ? (item.fingerprint ?? '') : '',
      originalName: item.kind === 'node' ? (item.original_name ?? '') : '',
      customName: item.custom_name ?? '', description: item.description ?? '',
    }));
  return {
    name: b.name, enabled: b.enabled, description: b.description, profileTitle: b.profile_title,
    supportUrl: b.support_url, announce: b.announce, mode: items.length ? 'selected' : 'all',
    sourceIds: [...(b.sources ?? [])].sort((x, y) => x.position - y.position).map(s => s.source_id), rules,
  };
}

export const sameDraft = (a: BuildDraft, b: BuildDraft) => JSON.stringify(a) === JSON.stringify(b);

/** Rules as PUT /builders/{id}/configuration expects them (index = position). */
export function configItems(draft: Pick<BuildDraft, 'mode' | 'sourceIds' | 'rules'>): BuilderConfigItemInput[] {
  if (draft.mode === 'all') return [];
  return draft.rules.filter(rule => draft.sourceIds.includes(rule.sourceId)).map(rule => ({
    id: rule.id > 0 ? rule.id : 0, kind: rule.kind, source_id: rule.sourceId,
    country_code: rule.kind === 'country' ? rule.countryCode : '',
    fingerprint: rule.kind === 'node' ? rule.fingerprint : '',
    original_name: rule.kind === 'node' ? rule.originalName : '',
    custom_name: rule.customName.trim() || null, description: rule.description, enabled: true,
  }));
}

export type DraftField = 'name' | 'sources' | 'composition' | 'profileTitle' | 'announce' | 'supportUrl' | 'description';
export type DraftErrors = Partial<Record<DraftField, string>>;

/** Server field (database.BuilderFieldError.Field) -> editor field. */
export const BUILD_SERVER_FIELDS: Readonly<Record<string, DraftField>> = {
  name: 'name', source_ids: 'sources', items: 'composition', profile_title: 'profileTitle',
  announce: 'announce', support_url: 'supportUrl', description: 'description',
};

export function validateDraft(draft: BuildDraft): DraftErrors {
  const errors: DraftErrors = {};
  const name = draft.name.trim();
  if (!name) errors.name = 'Введите название сборки.';
  else if (chars(name) > BUILD_LIMITS.name) errors.name = `Не длиннее ${BUILD_LIMITS.name} символов.`;
  if (draft.sourceIds.length === 0) errors.sources = 'Выберите хотя бы один источник.';
  else if (draft.mode === 'selected' && configItems(draft).length === 0) errors.composition = 'Отметьте хотя бы одну страну или сервер.';
  else if (configItems(draft).length > BUILD_LIMITS.rules) errors.composition = `Слишком много отдельных серверов (больше ${BUILD_LIMITS.rules}). Отмечайте страны целиком.`;
  if (chars(draft.profileTitle.trim()) > BUILD_LIMITS.profileTitle) errors.profileTitle = `Не длиннее ${BUILD_LIMITS.profileTitle} символов.`;
  if (chars(draft.announce.trim()) > BUILD_LIMITS.announce) errors.announce = `Не длиннее ${BUILD_LIMITS.announce} символов.`;
  const support = draft.supportUrl.trim();
  if (chars(support) > BUILD_LIMITS.supportUrl) errors.supportUrl = `Не длиннее ${BUILD_LIMITS.supportUrl} символов.`;
  else if (support && !/^(https?:\/\/|tg:\/\/)\S+$/i.test(support)) errors.supportUrl = 'Ссылка должна начинаться с https:// или tg://.';
  if (chars(draft.description.trim()) > BUILD_LIMITS.description) errors.description = `Не длиннее ${BUILD_LIMITS.description} символов.`;
  return errors;
}

// ---------------------------------------------------------------------------
// Ticks -> rules

export type CountryTick = 'country' | 'nodes' | 'none';

const isCountryRule = (r: DraftRule, sourceId: number, code: string) => r.kind === 'country' && r.sourceId === sourceId && r.countryCode === code;

/** A node rule names this server: by fingerprint, or by name when it has none. */
const isNodeRuleOf = (r: DraftRule, sourceId: number, e: Pick<SourceEntry, 'fingerprint' | 'original_name'>) =>
  r.kind === 'node' && r.sourceId === sourceId &&
  (r.fingerprint !== '' ? r.fingerprint === e.fingerprint : r.originalName !== '' && r.originalName === e.original_name);

const nodeRule = (sourceId: number, e: SourceEntry): DraftRule => ({
  id: 0, kind: 'node', sourceId, countryCode: '', fingerprint: e.fingerprint, originalName: e.original_name, customName: '', description: '',
});
const countryRule = (sourceId: number, code: string): DraftRule => ({
  id: 0, kind: 'country', sourceId, countryCode: code, fingerprint: '', originalName: '', customName: '', description: '',
});

/** How a country of a source is ticked: whole, some servers, nothing. */
export function countryTick(rules: readonly DraftRule[], sourceId: number, group: CountryGroup): { state: CountryTick; nodes: number } {
  if (group.code && rules.some(r => isCountryRule(r, sourceId, group.code))) return { state: 'country', nodes: group.entries.length };
  const nodes = group.entries.filter(e => rules.some(r => isNodeRuleOf(r, sourceId, e))).length;
  // A group without a country has no country rule: all its servers ticked reads as "whole".
  if (!group.code && nodes > 0 && nodes === group.entries.length) return { state: 'country', nodes };
  return { state: nodes ? 'nodes' : 'none', nodes };
}

export const nodeTicked = (rules: readonly DraftRule[], sourceId: number, group: CountryGroup, e: SourceEntry) =>
  (group.code !== '' && rules.some(r => isCountryRule(r, sourceId, group.code))) || rules.some(r => isNodeRuleOf(r, sourceId, e));

const withoutGroup = (rules: readonly DraftRule[], sourceId: number, group: CountryGroup) =>
  rules.filter(r => !(isCountryRule(r, sourceId, group.code) && group.code !== '') && !group.entries.some(e => isNodeRuleOf(r, sourceId, e)));

/**
 * Ticks or clears a whole country. Ticking replaces its server rules by one
 * country rule; a group without a country ticks every server of it.
 */
export function toggleCountry(rules: readonly DraftRule[], sourceId: number, group: CountryGroup): DraftRule[] {
  const { state } = countryTick(rules, sourceId, group);
  const others = withoutGroup(rules, sourceId, group);
  if (state === 'country') return others;
  if (!group.code) return [...others, ...group.entries.map(e => nodeRule(sourceId, e))];
  return [...others, countryRule(sourceId, group.code)];
}

/**
 * Ticks or clears one server. Clearing a server of a whole country turns the
 * country rule into rules for the remaining servers at the same position, so
 * the result is exactly what is ticked.
 */
export function toggleNode(rules: readonly DraftRule[], sourceId: number, group: CountryGroup, e: SourceEntry): DraftRule[] {
  const countryIndex = group.code ? rules.findIndex(r => isCountryRule(r, sourceId, group.code)) : -1;
  if (countryIndex >= 0) {
    const rest = group.entries.filter(other => other.fingerprint !== e.fingerprint).map(other => nodeRule(sourceId, other));
    return [...rules.slice(0, countryIndex), ...rest, ...rules.slice(countryIndex + 1)];
  }
  if (rules.some(r => isNodeRuleOf(r, sourceId, e))) return rules.filter(r => !isNodeRuleOf(r, sourceId, e));
  return [...rules, nodeRule(sourceId, e)];
}

/** Every country of a source ticked whole (servers without a country one by one). */
export function tickAll(rules: readonly DraftRule[], sourceId: number, groups: readonly CountryGroup[]): DraftRule[] {
  let next = [...rules];
  for (const group of groups) {
    if (countryTick(next, sourceId, group).state !== 'country') {
      next = withoutGroup(next, sourceId, group);
      next.push(...(group.code ? [countryRule(sourceId, group.code)] : group.entries.map(e => nodeRule(sourceId, e))));
    }
  }
  return next;
}

export const clearSource = (rules: readonly DraftRule[], sourceId: number) => rules.filter(r => r.sourceId !== sourceId);

/** Rules of sources that left the composition are dropped. */
export const rulesForSources = (rules: readonly DraftRule[], sourceIds: readonly number[]) =>
  rules.filter(r => sourceIds.includes(r.sourceId));

/**
 * A server rule remembers the fingerprint its server had when it was ticked.
 * A provider may give the same server another identity later (it moved, or
 * the rule was saved before identities became stable): the fingerprint is gone
 * from the catalogue, but exactly one server still has the name. /sub serves
 * that server (subserver.resolveNodeEntry), so the rule is moved to its new
 * fingerprint: its tick shows in the constructor and the next save stores it.
 */
export function rebindRules(rules: readonly DraftRule[], sourceId: number, entries: readonly SourceEntry[]): DraftRule[] {
  return rules.map(rule => {
    if (rule.kind !== 'node' || rule.sourceId !== sourceId || rule.fingerprint === '') return rule;
    const resolved = resolveNode(rule.fingerprint, rule.originalName, entries);
    if (resolved.status !== 'fallback' || !resolved.entry || !resolved.entry.fingerprint) return rule;
    return { ...rule, fingerprint: resolved.entry.fingerprint };
  });
}

/** Sets the name clients see for the rule at index ('' = the provider's name). */
export function renameRule(rules: readonly DraftRule[], index: number, name: string): DraftRule[] {
  return rules.map((r, i) => (i === index ? { ...r, customName: name } : r));
}

export function moveRule(rules: readonly DraftRule[], index: number, delta: -1 | 1): DraftRule[] {
  const to = index + delta;
  if (index < 0 || index >= rules.length || to < 0 || to >= rules.length) return [...rules];
  const next = [...rules];
  const [item] = next.splice(index, 1);
  next.splice(to, 0, item);
  return next;
}

export const removeRule = (rules: readonly DraftRule[], index: number) => rules.filter((_, i) => i !== index);

// ---------------------------------------------------------------------------
// Preview: what /sub serves with the draft (subserver.selectBuilderEntries).

export interface ResolvedServer {
  readonly sourceId: number;
  /** The name clients see. */
  readonly name: string;
  readonly original: string;
  readonly country: string;
  readonly protocol: string;
  /** Index of the rule that selected it; -1 in the "all" mode. */
  readonly rule: number;
}

export type RuleProblem = 'source_off' | 'no_catalogue' | 'country_empty' | 'node_missing' | 'node_ambiguous' | 'covered';

export interface RuleState {
  readonly servers: number;
  readonly problem: RuleProblem | '';
}

export interface Resolution {
  readonly servers: readonly ResolvedServer[];
  /** Country codes in output order; '' = servers without a country. */
  readonly countries: readonly string[];
  /** One state per draft rule (empty in the "all" mode). */
  readonly rules: readonly RuleState[];
  /** Linked sources skipped right now: switched off or expired. */
  readonly skippedSources: readonly number[];
}

const RULE_PROBLEM_TEXT: Readonly<Record<RuleProblem, string>> = {
  source_off: 'Источник отключён или его срок истёк: правило пропускается.',
  no_catalogue: 'Каталог источника ещё не загружен.',
  country_empty: 'В источнике сейчас нет серверов этой страны.',
  node_missing: 'Сервера больше нет в источнике.',
  node_ambiguous: 'В источнике несколько серверов с таким названием: выберите нужный заново.',
  covered: 'Сервер уже выбран правилом выше.',
};

export const ruleProblemText = (problem: RuleProblem | '') => (problem ? RULE_PROBLEM_TEXT[problem] : '');

export function resolveDraft(
  draft: Pick<BuildDraft, 'mode' | 'sourceIds' | 'rules'>,
  sources: readonly AdminSource[],
  entries: ReadonlyMap<number, readonly SourceEntry[]>,
): Resolution {
  const usable = (id: number) => {
    const src = sources.find(s => s.id === id);
    return src !== undefined && sourceUsable(src);
  };
  const present = (id: number) => [...(entries.get(id) ?? [])].filter(e => e.present)
    .sort((a, b) => a.upstream_position - b.upstream_position || a.id - b.id);
  const skippedSources = draft.sourceIds.filter(id => !usable(id));
  const servers: ResolvedServer[] = [];
  const seen = new Set<string>();
  const add = (sourceId: number, e: SourceEntry, name: string, rule: number): boolean => {
    const key = `${sourceId}|${e.fingerprint}`;
    if (seen.has(key)) return false;
    seen.add(key);
    servers.push({ sourceId, name, original: e.original_name, country: entryCountry(e), protocol: e.protocol, rule });
    return true;
  };

  const rules: RuleState[] = [];
  if (draft.mode === 'all') {
    for (const id of draft.sourceIds) {
      if (!usable(id)) continue;
      for (const e of present(id)) add(id, e, e.original_name, -1);
    }
  } else {
    draft.rules.forEach((rule, index) => {
      if (!draft.sourceIds.includes(rule.sourceId) || !usable(rule.sourceId)) { rules.push({ servers: 0, problem: 'source_off' }); return; }
      if (!entries.has(rule.sourceId)) { rules.push({ servers: 0, problem: 'no_catalogue' }); return; }
      const list = present(rule.sourceId);
      let added = 0;
      if (rule.kind === 'country') {
        const matched = list.filter(e => entryCountry(e) !== '' && entryCountry(e) === rule.countryCode);
        for (const e of matched) if (add(rule.sourceId, e, rule.customName.trim() || e.original_name, index)) added++;
        rules.push({ servers: added, problem: matched.length === 0 ? 'country_empty' : added === 0 ? 'covered' : '' });
        return;
      }
      const resolved = resolveNode(rule.fingerprint, rule.originalName, list);
      if (!resolved.entry) { rules.push({ servers: 0, problem: resolved.status === 'conflict' ? 'node_ambiguous' : 'node_missing' }); return; }
      if (add(rule.sourceId, resolved.entry, rule.customName.trim() || resolved.entry.original_name, index)) added++;
      rules.push({ servers: added, problem: added === 0 ? 'covered' : '' });
    });
  }
  const countries: string[] = [];
  for (const s of servers) if (!countries.includes(s.country)) countries.push(s.country);
  return { servers, countries, rules, skippedSources };
}

/** "24 сервера · 6 стран" / "Ни одного сервера". */
export function resolutionSummary(r: Pick<Resolution, 'servers' | 'countries'>): string {
  if (r.servers.length === 0) return 'Ни одного сервера';
  const named = r.countries.filter(Boolean).length;
  return named ? `${serversLabel(r.servers.length)} · ${countriesLabel(named)}` : serversLabel(r.servers.length);
}

/**
 * "Германия" for a rule or a country card; "Без страны" for ''. The code is
 * shown next to it as a text chip: flag emoji do not render on Windows.
 */
export function countryTitle(code: string): string {
  if (!code) return 'Без страны';
  return countryName(code).replace(/ · [A-Z]{2}$/, '');
}

/** Title of a rule in the order list. */
export function ruleTitle(rule: DraftRule): string {
  if (rule.kind === 'country') return rule.customName.trim() ? `${countryTitle(rule.countryCode)} → ${rule.customName.trim()}` : countryTitle(rule.countryCode);
  return rule.customName.trim() || rule.originalName || 'Сервер';
}

export { groupByCountry, type CountryGroup };

// ---------------------------------------------------------------------------
// List card: what a сборка gives, by the catalogue statistics of its sources
// (no entries are loaded for the list).

export interface BuildFacts {
  /** Servers the configuration selects now; an estimate from catalogue counts. */
  readonly servers: number;
  /** Country codes, in rule order ('' never listed). */
  readonly countries: readonly string[];
  readonly mode: BuildMode;
  /** Why nothing is served ('' when it works). */
  readonly problem: string;
  /** Names of the linked sources, in order. */
  readonly sources: readonly string[];
}

export function buildFacts(b: Pick<AdminBuilder, 'sources' | 'items'>, sources: readonly AdminSource[]): BuildFacts {
  const links = [...(b.sources ?? [])].sort((x, y) => x.position - y.position).map(s => s.source_id);
  const items = (b.items ?? []).filter(item => item.enabled);
  const byId = new Map(sources.map(s => [s.id, s]));
  const names = links.map(id => byId.get(id)?.name ?? `Источник #${id}`);
  const usable = links.filter(id => { const s = byId.get(id); return s !== undefined && sourceUsable(s); });
  const mode: BuildMode = (b.items ?? []).length ? 'selected' : 'all';
  const countries: string[] = [];
  let servers = 0;
  if (mode === 'all') {
    for (const id of usable) {
      const s = byId.get(id);
      if (!s) continue;
      servers += s.catalogue.entries;
      for (const c of s.catalogue.by_country) if (c.code && !countries.includes(c.code)) countries.push(c.code);
    }
  } else {
    const whole = new Set<string>();
    for (const item of [...items].sort((x, y) => x.position - y.position || x.id - y.id)) {
      if (!usable.includes(item.source_id)) continue;
      const s = byId.get(item.source_id);
      if (item.kind === 'country') {
        const code = (item.country_code ?? '').toUpperCase();
        const key = `${item.source_id}|${code}`;
        if (whole.has(key)) continue;
        whole.add(key);
        servers += s?.catalogue.by_country.find(c => c.code.toUpperCase() === code)?.count ?? 0;
        if (code && !countries.includes(code)) countries.push(code);
      } else {
        servers += 1;
      }
    }
  }
  let problem = '';
  if (links.length === 0) problem = 'Источник не выбран: подписка не соберётся.';
  else if (usable.length === 0) problem = 'Все источники отключены или просрочены.';
  else if (mode === 'selected' && items.length === 0) problem = 'Ничего не выбрано: подписка не соберётся.';
  else if (servers === 0) problem = 'По выбранным странам и серверам сейчас ничего нет.';
  return { servers, countries, mode, problem, sources: names };
}

/** "24 сервера · 6 стран" for a card. */
export function buildFactsSummary(f: BuildFacts): string {
  if (f.servers === 0) return 'Ни одного сервера';
  return f.countries.length ? `${serversLabel(f.servers)} · ${countriesLabel(f.countries.length)}` : serversLabel(f.servers);
}

/** The first country codes for a row of chips and how many more there are. */
export function countryChips(countries: readonly string[], limit = 10): { shown: string[]; more: number } {
  const codes = countries.filter(Boolean);
  return { shown: codes.slice(0, limit), more: Math.max(0, codes.length - limit) };
}

export const clientsLabel = (n: number) => `${countFormat.format(n)} ${pluralRu(n, 'клиент', 'клиента', 'клиентов')}`;

/** What a system plan (database.TrialPlanName / FreePlanName) uses a сборка for. */
export const SYSTEM_PLAN_LABELS: Readonly<Record<string, string>> = { trial: 'Пробная подписка', free: 'Бесплатный доступ' };

/** The system uses of a сборка, for badges: «Пробная подписка», «Бесплатный доступ». */
export const systemUses = (d: Pick<BuilderDependents, 'plans'> | undefined) =>
  (d?.plans ?? []).map(p => SYSTEM_PLAN_LABELS[p.name]).filter((label): label is string => Boolean(label));

/**
 * Why a сборка cannot be deleted ('' when nothing depends on it). The server
 * lists a plan only while it blocks: a system plan, or the sale plan while it
 * has tariffs or subscriptions (database.planBlocksBuilderDeletion).
 */
export function buildDeleteBlocker(d: BuilderDependents | undefined): string {
  const parts: string[] = [];
  const system = systemUses(d);
  if (system.length) parts.push(`на ней работает ${system.map(label => `«${label.toLocaleLowerCase('ru-RU')}»`).join(' и ')}`);
  if ((d?.plans ?? []).some(p => !SYSTEM_PLAN_LABELS[p.name])) parts.push('у неё есть тарифы или клиенты, которые её купили');
  const personal = d?.subscriptions ?? 0;
  if (personal > 0) parts.push(`она назначена лично ${countFormat.format(personal)} ${pluralRu(personal, 'клиенту', 'клиентам', 'клиентам')}`);
  return parts.join('; ');
}

// ---------------------------------------------------------------------------
// Health of a сборка from the network monitor overview.

export interface BuildHealth { readonly tone: HealthTone; readonly text: string }

export function buildHealth(m: MonitorBuilderSummary | undefined, enabled: boolean): BuildHealth {
  if (!enabled) return { tone: 'off', text: 'Отключена: клиентам не выдаётся' };
  if (!m || m.nodes_total === 0) return { tone: 'unknown', text: 'Проверка ещё не выполнялась' };
  const checked = m.nodes_up + m.nodes_down;
  if (checked === 0) return { tone: 'unknown', text: `${serversLabel(m.nodes_total)} · ждут первой проверки` };
  if (m.nodes_down === 0) return { tone: 'ok', text: `Работают все серверы: ${countFormat.format(m.nodes_up)}` };
  if (m.nodes_up === 0) return { tone: 'down', text: `Недоступны все серверы: ${countFormat.format(checked)}` };
  return { tone: 'warn', text: `Недоступно ${countFormat.format(m.nodes_down)} из ${countFormat.format(checked)}` };
}

// ---------------------------------------------------------------------------
// Prices: the tariffs sold on a сборка.

/** Current (not retired) tariffs of a builder: shortest term first. */
export function buildTariffs(tariffs: readonly AdminTariff[], builderId: number): AdminTariff[] {
  return tariffs.filter(t => t.builder_id === builderId && t.replaced_by_id === null)
    .sort((a, b) => a.duration_days - b.duration_days || a.price_cents - b.price_cents || a.id - b.id);
}

/** "30 дней · 199 ₽". */
export const priceLabel = (t: Pick<AdminTariff, 'duration_days' | 'price_cents' | 'currency'>) =>
  `${durationLabel(t.duration_days)} · ${formatTariffPrice(t.price_cents, t.currency)}`;

export const PRICE_PRESETS = [
  { label: '1 месяц', name: '1 месяц', days: 30 },
  { label: '3 месяца', name: '3 месяца', days: 90 },
  { label: '6 месяцев', name: '6 месяцев', days: 180 },
  { label: '1 год', name: '1 год', days: 365 },
] as const;

/** A price being added in the editor, as typed. */
export interface PriceRow { readonly name: string; readonly days: string; readonly price: string }

export const EMPTY_PRICE: PriceRow = { name: '', days: '', price: '' };

export type PriceField = 'name' | 'days' | 'price';
export type PriceErrors = Partial<Record<PriceField, string>>;

export interface PriceInput { readonly name: string; readonly duration_days: number; readonly price_cents: number }

/** A row is blank while nothing is typed: it is then simply not added. */
export const isBlankPrice = (row: PriceRow) => !row.name.trim() && !row.days.trim() && !row.price.trim();

export function validatePrice(row: PriceRow): { input: PriceInput | null; errors: PriceErrors } {
  const errors: PriceErrors = {};
  const name = row.name.trim();
  if (!name) errors.name = 'Назовите тариф, например «1 месяц».';
  else if (chars(name) > 64) errors.name = 'Не длиннее 64 символов.';
  const days = /^\d{1,4}$/.test(row.days.trim()) ? Number(row.days.trim()) : NaN;
  if (!Number.isInteger(days) || days < 1 || days > 3650) errors.days = 'Срок в днях: от 1 до 3650.';
  const price = parsePriceInput(row.price, 'RUB');
  if (price === null) errors.price = 'Цена в рублях, например 199. Для бесплатного — 0.';
  else if (price > 100_000_000) errors.price = 'Слишком большая цена.';
  if (Object.keys(errors).length > 0 || price === null) return { input: null, errors };
  return { input: { name, duration_days: days, price_cents: price }, errors };
}

// ---------------------------------------------------------------------------
// Names

/** "Европа (копия)", "Европа (копия 2)", … not taken by another сборка. */
export function copyName(name: string, taken: readonly string[]): string {
  const used = new Set(taken.map(n => n.trim().toLocaleLowerCase('ru-RU')));
  const base = name.trim().replace(/ \(копия(?: \d+)?\)$/, '');
  for (let n = 1; n < 1000; n++) {
    const candidate = n === 1 ? `${base} (копия)` : `${base} (копия ${n})`;
    if (!used.has(candidate.toLocaleLowerCase('ru-RU')) && chars(candidate) <= BUILD_LIMITS.name) return candidate;
  }
  return `${base.slice(0, 100)} (копия ${Date.now()})`;
}

/** A name for a new сборка from what is ticked: "Германия", "Германия и Нидерланды", "5 стран". */
export function suggestName(resolution: Pick<Resolution, 'countries'>, mode: BuildMode, sourceNames: readonly string[]): string {
  const named = resolution.countries.filter(Boolean).map(code => countryName(code).replace(/ · [A-Z]{2}$/, ''));
  if (mode === 'all') return sourceNames.length === 1 ? `Все серверы · ${sourceNames[0]}`.slice(0, BUILD_LIMITS.name) : 'Все серверы';
  if (named.length === 0) return '';
  if (named.length === 1) return named[0];
  if (named.length === 2) return `${named[0]} и ${named[1]}`;
  return countriesLabel(named.length);
}
