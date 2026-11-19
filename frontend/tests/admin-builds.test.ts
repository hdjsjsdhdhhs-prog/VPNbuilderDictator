import { describe, expect, it } from 'vitest';
import type { AdminBuilder, AdminSource, AdminTariff, BuilderItem, MonitorBuilderSummary, SourceCatalogue, SourceEntry } from '../admin/src/api';
import {
  BUILD_LIMITS, BUILD_SERVER_FIELDS, EMPTY_PRICE, PRICE_PRESETS, buildDeleteBlocker, buildFacts, buildFactsSummary, buildHealth,
  buildTariffs, buildsHash, clearSource, clientsLabel, configItems, copyName, countryChips, countryTick, countryTitle,
  draftFromBuilder, groupByCountry, isBlankPrice, moveRule, newDraft, nodeTicked, parseBuildsRoute, priceLabel, rebindRules,
  removeRule, renameRule, resolutionSummary, resolveDraft, ruleProblemText, ruleTitle, rulesForSources, sameDraft, suggestName, systemUses,
  tickAll, toggleCountry, toggleNode, validateDraft, validatePrice,
  type BuildDraft, type DraftRule,
} from '../admin/src/builds';

// Pure logic of the «Сборки» section (admin/src/builds.ts): a сборка is a
// subscription builder as the owner sees it. The composition is edited as
// ticks and stored as builder rules; resolveDraft mirrors the /sub selection
// (subserver.selectBuilderEntries), so the preview shows what a client gets.

const T0 = '2026-09-20T08:00:00Z';

const catalogue = (over: Partial<SourceCatalogue> = {}): SourceCatalogue => ({
  entries: 5, countries: 2, no_country: 1, absent: 1,
  by_country: [{ code: 'DE', count: 3 }, { code: 'NL', count: 1 }], protocols: { vless: 4, trojan: 1 }, ...over,
});

const source = (over: Partial<AdminSource> = {}): AdminSource => ({
  id: 1, name: 'Liberty', type: 'auto', description: '', enabled: true, last_sync_at: T0, last_sync_status: 'ok',
  last_sync_error: '', catalogue: catalogue(), expires_at: null, expired: false,
  dependents: { builders: [], subscriptions: 0 }, created_at: T0, updated_at: T0, ...over,
});

const entry = (id: number, fingerprint: string, name: string, country: string, over: Partial<SourceEntry> = {}): SourceEntry => ({
  id, source_id: 1, fingerprint, original_name: name, protocol: 'vless', country_code: country, upstream_position: id,
  present: true, last_seen_at: T0, ...over,
});

const de1 = entry(1, 'de1', 'DE-1', 'DE');
const de2 = entry(2, 'de2', 'DE-2', 'DE');
const nl1 = entry(3, 'nl1', 'NL-1', 'NL');
const x1 = entry(4, 'x1', 'Unknown', '');
const gone = entry(5, 'gone', 'DE-old', 'DE', { present: false });
const ENTRIES: readonly SourceEntry[] = [de1, de2, nl1, x1, gone];
const groups = () => groupByCountry(ENTRIES);
const group = (code: string) => {
  const found = groups().find(g => g.code === code);
  if (!found) throw new Error(`no group ${code}`);
  return found;
};
const catalogues = (list: readonly SourceEntry[] = ENTRIES) => new Map<number, readonly SourceEntry[]>([[1, list]]);

const countryRule = (code: string, over: Partial<DraftRule> = {}): DraftRule => ({
  id: 0, kind: 'country', sourceId: 1, countryCode: code, fingerprint: '', originalName: '', customName: '', description: '', ...over,
});
const nodeRule = (e: Pick<SourceEntry, 'fingerprint' | 'original_name'>, over: Partial<DraftRule> = {}): DraftRule => ({
  id: 0, kind: 'node', sourceId: 1, countryCode: '', fingerprint: e.fingerprint, originalName: e.original_name, customName: '',
  description: '', ...over,
});

const item = (over: Partial<BuilderItem>): BuilderItem => ({
  id: 1, kind: 'country', source_id: 1, country_code: '', fingerprint: '', original_name: '', custom_name: null, description: '',
  position: 0, enabled: true, ...over,
});

const builder = (over: Partial<AdminBuilder> = {}): AdminBuilder => ({
  id: 7, name: 'Европа', description: '', enabled: true, profile_title: '', support_url: '', announce: '', version: 3,
  sources: [{ source_id: 1, position: 0 }], items: [], dependents: { plans: [], subscriptions: 0 },
  sales: { plan_id: null, clients: 0 }, created_at: T0, updated_at: T0, ...over,
});

const selected = (rules: readonly DraftRule[], over: Partial<BuildDraft> = {}): BuildDraft =>
  ({ ...newDraft([1]), name: 'Европа', mode: 'selected', rules, ...over });

describe('routes', () => {
  it('parses the list, the constructor and a сборка', () => {
    expect(parseBuildsRoute('builders')).toEqual({ view: 'list' });
    expect(parseBuildsRoute('builders/new')).toEqual({ view: 'new', sourceId: null });
    expect(parseBuildsRoute('builders/new/from/4')).toEqual({ view: 'new', sourceId: 4 });
    expect(parseBuildsRoute('builders/12')).toEqual({ view: 'edit', id: 12 });
  });

  it('rejects anything else', () => {
    for (const path of ['builders/0', 'builders/x', 'builders/12/edit', 'builders/new/from/0', 'builders/', 'tariffs', '']) {
      expect(parseBuildsRoute(path)).toBeNull();
    }
  });

  it('round-trips through the hash', () => {
    for (const path of ['builders', 'builders/new', 'builders/new/from/4', 'builders/12']) {
      const route = parseBuildsRoute(path);
      expect(route).not.toBeNull();
      if (route) expect(buildsHash(route)).toBe(`#/${path}`);
    }
  });
});

describe('draft', () => {
  const stored = builder({
    sources: [{ source_id: 2, position: 1 }, { source_id: 1, position: 0 }],
    items: [
      item({ id: 11, kind: 'node', fingerprint: 'nl1', original_name: 'NL-1', custom_name: 'Амстердам', position: 1 }),
      item({ id: 10, kind: 'country', country_code: 'de', position: 0 }),
      item({ id: 12, kind: 'country', country_code: 'US', position: 2, enabled: false }),
    ],
  });

  it('a new сборка gives every server of the suggested source', () => {
    expect(newDraft([1])).toEqual({
      name: '', enabled: true, description: '', profileTitle: '', supportUrl: '', announce: '', mode: 'all', sourceIds: [1], rules: [],
    });
    expect(newDraft().sourceIds).toEqual([]);
  });

  it('reads a stored сборка: rules in order, switched-off rules are not ticks', () => {
    const draft = draftFromBuilder(stored);
    expect(draft.mode).toBe('selected');
    expect(draft.sourceIds).toEqual([1, 2]);
    expect(draft.rules).toEqual([
      countryRule('DE', { id: 10 }),
      nodeRule({ fingerprint: 'nl1', original_name: 'NL-1' }, { id: 11, customName: 'Амстердам' }),
    ]);
    expect(sameDraft(draft, draftFromBuilder(stored))).toBe(true);
    expect(sameDraft(draft, { ...draft, name: 'Другая' })).toBe(false);
  });

  it('a сборка without rules is the "all servers" mode', () => {
    expect(draftFromBuilder(builder()).mode).toBe('all');
    expect(draftFromBuilder(builder({ sources: null, items: null }))).toMatchObject({ mode: 'all', sourceIds: [], rules: [] });
    // Only switched-off rules: still a selection (an empty one), never "all".
    expect(draftFromBuilder(builder({ items: [item({ enabled: false, country_code: 'DE' })] }))).toMatchObject({ mode: 'selected', rules: [] });
  });

  it('writes the rules PUT /builders/{id}/configuration expects', () => {
    expect(configItems(draftFromBuilder(stored))).toEqual([
      { id: 10, kind: 'country', source_id: 1, country_code: 'DE', fingerprint: '', original_name: '', custom_name: null, description: '', enabled: true },
      { id: 11, kind: 'node', source_id: 1, country_code: '', fingerprint: 'nl1', original_name: 'NL-1', custom_name: 'Амстердам', description: '', enabled: true },
    ]);
    // "All servers" stores no rules; rules of an unlinked source are dropped;
    // a blank custom name keeps the provider's.
    expect(configItems({ mode: 'all', sourceIds: [1], rules: [countryRule('DE')] })).toEqual([]);
    expect(configItems({ mode: 'selected', sourceIds: [2], rules: [countryRule('DE')] })).toEqual([]);
    expect(configItems({ mode: 'selected', sourceIds: [1], rules: [countryRule('DE', { customName: '   ' })] })[0].custom_name).toBeNull();
    expect(configItems({ mode: 'selected', sourceIds: [1], rules: [countryRule('DE', { customName: ' Быстрый ' })] })[0].custom_name).toBe('Быстрый');
  });

  it('validates what the server would reject', () => {
    expect(validateDraft(selected([countryRule('DE')]))).toEqual({});
    expect(validateDraft({ ...newDraft([1]), name: 'Все' })).toEqual({});
    expect(validateDraft(newDraft([1])).name).toBe('Введите название сборки.');
    expect(validateDraft({ ...newDraft([1]), name: 'я'.repeat(BUILD_LIMITS.name + 1) }).name).toContain(String(BUILD_LIMITS.name));
    expect(validateDraft({ ...newDraft([]), name: 'x' })).toEqual({ sources: 'Выберите хотя бы один источник.' });
    expect(validateDraft(selected([]))).toEqual({ composition: 'Отметьте хотя бы одну страну или сервер.' });
    // Rules of a source that left the сборка do not count as a selection.
    expect(validateDraft(selected([countryRule('DE', { sourceId: 9 })])).composition).toBeDefined();
    const many = Array.from({ length: BUILD_LIMITS.rules + 1 }, (_, i) => nodeRule({ fingerprint: `fp${i}`, original_name: `n${i}` }));
    expect(validateDraft(selected(many)).composition).toContain(String(BUILD_LIMITS.rules));
  });

  it('validates the look of the subscription', () => {
    const base = selected([countryRule('DE')]);
    expect(validateDraft({ ...base, supportUrl: 'example.com' }).supportUrl).toBe('Ссылка должна начинаться с https:// или tg://.');
    for (const ok of ['https://t.me/support', 'http://example.com/help', 'tg://resolve?domain=support', '']) {
      expect(validateDraft({ ...base, supportUrl: ok }).supportUrl).toBeUndefined();
    }
    expect(validateDraft({ ...base, profileTitle: 'x'.repeat(BUILD_LIMITS.profileTitle + 1) }).profileTitle).toBeDefined();
    expect(validateDraft({ ...base, announce: 'x'.repeat(BUILD_LIMITS.announce + 1) }).announce).toBeDefined();
    expect(validateDraft({ ...base, description: 'x'.repeat(BUILD_LIMITS.description + 1) }).description).toBeDefined();
  });

  it('maps server fields to editor fields', () => {
    expect(BUILD_SERVER_FIELDS).toMatchObject({ name: 'name', source_ids: 'sources', items: 'composition', profile_title: 'profileTitle' });
  });
});

describe('ticks become rules', () => {
  it('groups the catalogue by country, servers without a country last', () => {
    expect(groups().map(g => [g.code, g.entries.map(e => e.fingerprint)])).toEqual([['DE', ['de1', 'de2']], ['NL', ['nl1']], ['', ['x1']]]);
  });

  it('a whole country is one rule and clears again', () => {
    const ticked = toggleCountry([], 1, group('DE'));
    expect(ticked).toEqual([countryRule('DE')]);
    expect(countryTick(ticked, 1, group('DE'))).toEqual({ state: 'country', nodes: 2 });
    expect(nodeTicked(ticked, 1, group('DE'), de1)).toBe(true);
    expect(countryTick(ticked, 1, group('NL'))).toEqual({ state: 'none', nodes: 0 });
    expect(toggleCountry(ticked, 1, group('DE'))).toEqual([]);
  });

  it('single servers are node rules; ticking the country replaces them', () => {
    const one = toggleNode([], 1, group('DE'), de1);
    expect(one).toEqual([nodeRule(de1)]);
    expect(countryTick(one, 1, group('DE'))).toEqual({ state: 'nodes', nodes: 1 });
    expect(nodeTicked(one, 1, group('DE'), de1)).toBe(true);
    expect(nodeTicked(one, 1, group('DE'), de2)).toBe(false);
    expect(toggleNode(one, 1, group('DE'), de1)).toEqual([]);
    expect(toggleCountry(one, 1, group('DE'))).toEqual([countryRule('DE')]);
  });

  it('clearing one server of a whole country keeps the rest at the same position', () => {
    const rules = [countryRule('NL'), countryRule('DE'), nodeRule(x1)];
    expect(toggleNode(rules, 1, group('DE'), de1)).toEqual([countryRule('NL'), nodeRule(de2), nodeRule(x1)]);
  });

  it('servers without a country are ticked one by one', () => {
    const none = group('');
    const ticked = toggleCountry([], 1, none);
    expect(ticked).toEqual([nodeRule(x1)]);
    // There is no country rule for them, yet all ticked reads as "whole".
    expect(countryTick(ticked, 1, none)).toEqual({ state: 'country', nodes: 1 });
    expect(toggleCountry(ticked, 1, none)).toEqual([]);
  });

  it('a node rule without a fingerprint names the server by its name', () => {
    const byName = [nodeRule({ fingerprint: '', original_name: 'DE-2' })];
    expect(nodeTicked(byName, 1, group('DE'), de2)).toBe(true);
    expect(nodeTicked(byName, 1, group('DE'), de1)).toBe(false);
  });

  it('a server that got another identity keeps its tick: the rule moves to the new fingerprint', () => {
    // The provider now answers «DE-2» under another fingerprint (it moved).
    const moved = [de1, { ...de2, fingerprint: 'de2-new' }, nl1, x1, gone];
    const stale = nodeRule(de2, { id: 9, customName: 'Берлин' });
    const kept = nodeRule(de1);
    const country = countryRule('NL');
    const rebound = rebindRules([stale, kept, country], 1, moved);
    expect(rebound).toEqual([{ ...stale, fingerprint: 'de2-new' }, kept, country]);
    const movedGroup = groupByCountry(moved).find(g => g.code === 'DE')!;
    expect(nodeTicked([stale], 1, movedGroup, moved[1])).toBe(false);
    expect(nodeTicked(rebound, 1, movedGroup, moved[1])).toBe(true);

    // Nothing to move: the fingerprint is still there, the name is gone,
    // the name is ambiguous, or the rule belongs to another source.
    expect(rebindRules([stale], 1, ENTRIES)).toEqual([stale]);
    const lost = nodeRule({ fingerprint: 'lost', original_name: 'Nowhere' });
    expect(rebindRules([lost], 1, moved)).toEqual([lost]);
    const twins = [de1, { ...de2, fingerprint: 'a' }, { ...de2, id: 6, fingerprint: 'b' }];
    expect(rebindRules([stale], 1, twins)).toEqual([stale]);
    expect(rebindRules([{ ...stale, sourceId: 2 }], 1, moved)).toEqual([{ ...stale, sourceId: 2 }]);
    // A server that left the catalogue is not a new home for a rule.
    const absent = [de1, { ...de2, fingerprint: 'de2-new', present: false }];
    expect(rebindRules([stale], 1, absent)).toEqual([stale]);
  });

  it('ticks everything, clears a source, drops rules of unlinked sources', () => {
    const all = tickAll([nodeRule(de1)], 1, groups());
    expect(all).toEqual([countryRule('DE'), countryRule('NL'), nodeRule(x1)]);
    expect(tickAll(all, 1, groups())).toEqual(all);
    const other = countryRule('FR', { sourceId: 2 });
    expect(clearSource([...all, other], 1)).toEqual([other]);
    expect(rulesForSources([...all, other], [2])).toEqual([other]);
    expect(rulesForSources([...all, other], [])).toEqual([]);
  });

  it('renames, moves and removes a rule by its position', () => {
    const rules = [countryRule('DE'), countryRule('NL'), nodeRule(x1)];
    expect(renameRule(rules, 1, 'Амстердам')[1].customName).toBe('Амстердам');
    expect(renameRule(rules, 1, 'Амстердам')[0]).toEqual(rules[0]);
    expect(moveRule(rules, 2, -1)).toEqual([rules[0], rules[2], rules[1]]);
    expect(moveRule(rules, 0, 1)).toEqual([rules[1], rules[0], rules[2]]);
    expect(moveRule(rules, 0, -1)).toEqual(rules);
    expect(moveRule(rules, 2, 1)).toEqual(rules);
    expect(removeRule(rules, 1)).toEqual([rules[0], rules[2]]);
  });
});

describe('preview of what /sub serves', () => {
  const sources = [source()];

  it('"all servers" gives every present server in the provider order', () => {
    const r = resolveDraft(newDraft([1]), sources, catalogues());
    expect(r.servers.map(s => [s.name, s.country, s.rule])).toEqual([['DE-1', 'DE', -1], ['DE-2', 'DE', -1], ['NL-1', 'NL', -1], ['Unknown', '', -1]]);
    expect(r.countries).toEqual(['DE', 'NL', '']);
    expect(r.rules).toEqual([]);
    expect(r.skippedSources).toEqual([]);
    expect(resolutionSummary(r)).toBe('4 сервера · 2 страны');
  });

  it('follows the rules in order, renames and never repeats a server', () => {
    const draft = selected([
      countryRule('DE', { customName: ' Германия ' }),
      nodeRule(nl1),
      nodeRule(de1),
      countryRule('US'),
      nodeRule({ fingerprint: 'zzz', original_name: 'Nope' }),
    ]);
    const r = resolveDraft(draft, sources, catalogues());
    expect(r.servers).toEqual([
      { sourceId: 1, name: 'Германия', original: 'DE-1', country: 'DE', protocol: 'vless', rule: 0 },
      { sourceId: 1, name: 'Германия', original: 'DE-2', country: 'DE', protocol: 'vless', rule: 0 },
      { sourceId: 1, name: 'NL-1', original: 'NL-1', country: 'NL', protocol: 'vless', rule: 1 },
    ]);
    expect(r.rules).toEqual([
      { servers: 2, problem: '' }, { servers: 1, problem: '' }, { servers: 0, problem: 'covered' },
      { servers: 0, problem: 'country_empty' }, { servers: 0, problem: 'node_missing' },
    ]);
    expect(r.countries).toEqual(['DE', 'NL']);
    expect(resolutionSummary(r)).toBe('3 сервера · 2 страны');
  });

  it('finds a server by name after its fingerprint changed, unless the name is ambiguous', () => {
    const rotated = selected([nodeRule({ fingerprint: 'rotated', original_name: 'NL-1' })]);
    expect(resolveDraft(rotated, sources, catalogues()).rules).toEqual([{ servers: 1, problem: '' }]);
    const twins = [entry(1, 'a', 'Same', 'DE'), entry(2, 'b', 'Same', 'DE')];
    const ambiguous = selected([nodeRule({ fingerprint: 'old', original_name: 'Same' })]);
    expect(resolveDraft(ambiguous, sources, catalogues(twins)).rules).toEqual([{ servers: 0, problem: 'node_ambiguous' }]);
  });

  it('a server that left the provider subscription is not served', () => {
    const r = resolveDraft(selected([nodeRule(gone)]), sources, catalogues());
    expect(r.servers).toEqual([]);
    expect(r.rules).toEqual([{ servers: 0, problem: 'node_missing' }]);
    expect(resolutionSummary(r)).toBe('Ни одного сервера');
  });

  it('skips a switched-off or expired source, exactly like /sub', () => {
    for (const off of [source({ enabled: false }), source({ expired: true })]) {
      const all = resolveDraft(newDraft([1]), [off], catalogues());
      expect(all.servers).toEqual([]);
      expect(all.skippedSources).toEqual([1]);
      expect(resolveDraft(selected([countryRule('DE')]), [off], catalogues()).rules).toEqual([{ servers: 0, problem: 'source_off' }]);
    }
    // A source that is not in the list at all (deleted) is skipped as well.
    expect(resolveDraft(newDraft([9]), sources, catalogues()).skippedSources).toEqual([9]);
  });

  it('reports a rule of an unlinked source and a catalogue that is not loaded yet', () => {
    const unlinked = selected([countryRule('DE', { sourceId: 2 })]);
    expect(resolveDraft(unlinked, [source(), source({ id: 2 })], catalogues()).rules).toEqual([{ servers: 0, problem: 'source_off' }]);
    expect(resolveDraft(selected([countryRule('DE')]), sources, new Map()).rules).toEqual([{ servers: 0, problem: 'no_catalogue' }]);
  });

  it('merges several sources without mixing their servers up', () => {
    const second = [entry(1, 'de1', 'FR-1', 'FR', { source_id: 2 })];
    const both = new Map<number, readonly SourceEntry[]>([[1, ENTRIES], [2, second]]);
    const r = resolveDraft(newDraft([2, 1]), [source(), source({ id: 2, name: 'Second' })], both);
    // The same fingerprint in another source is another server.
    expect(r.servers.map(s => `${s.sourceId}:${s.original}`)).toEqual(['2:FR-1', '1:DE-1', '1:DE-2', '1:NL-1', '1:Unknown']);
    expect(r.countries).toEqual(['FR', 'DE', 'NL', '']);
  });

  it('explains every rule problem', () => {
    for (const problem of ['source_off', 'no_catalogue', 'country_empty', 'node_missing', 'node_ambiguous', 'covered'] as const) {
      expect(ruleProblemText(problem)).not.toBe('');
    }
    expect(ruleProblemText('')).toBe('');
  });
});

describe('names', () => {
  it('titles a country and a rule', () => {
    expect(countryTitle('DE')).toBe('Германия');
    expect(countryTitle('')).toBe('Без страны');
    expect(ruleTitle(countryRule('DE'))).toBe('Германия');
    expect(ruleTitle(countryRule('DE', { customName: ' Быстрый ' }))).toBe('Германия → Быстрый');
    expect(ruleTitle(nodeRule(de1))).toBe('DE-1');
    expect(ruleTitle(nodeRule(de1, { customName: 'Берлин' }))).toBe('Берлин');
    expect(ruleTitle(nodeRule({ fingerprint: 'x', original_name: '' }))).toBe('Сервер');
  });

  it('suggests a name from what is ticked', () => {
    expect(suggestName({ countries: ['DE', 'NL', ''] }, 'all', ['Liberty'])).toBe('Все серверы · Liberty');
    expect(suggestName({ countries: [] }, 'all', ['A', 'B'])).toBe('Все серверы');
    expect(suggestName({ countries: [] }, 'selected', ['Liberty'])).toBe('');
    expect(suggestName({ countries: [''] }, 'selected', ['Liberty'])).toBe('');
    expect(suggestName({ countries: ['DE'] }, 'selected', ['Liberty'])).toBe('Германия');
    expect(suggestName({ countries: ['DE', 'NL'] }, 'selected', ['Liberty'])).toBe('Германия и Нидерланды');
    expect(suggestName({ countries: ['DE', 'NL', 'FR', ''] }, 'selected', ['Liberty'])).toBe('3 страны');
  });

  it('names a copy that is not taken yet', () => {
    expect(copyName('Европа', ['Европа'])).toBe('Европа (копия)');
    expect(copyName('Европа', ['Европа', 'европа (КОПИЯ)'])).toBe('Европа (копия 2)');
    expect(copyName('Европа (копия)', ['Европа', 'Европа (копия)'])).toBe('Европа (копия 2)');
    expect(copyName('Европа (копия 2)', ['Европа'])).toBe('Европа (копия)');
  });
});

describe('list card', () => {
  it('counts what an "all servers" сборка gives from the catalogue statistics', () => {
    const facts = buildFacts(builder(), [source()]);
    expect(facts).toEqual({ servers: 5, countries: ['DE', 'NL'], mode: 'all', problem: '', sources: ['Liberty'] });
    expect(buildFactsSummary(facts)).toBe('5 серверов · 2 страны');
  });

  it('counts a selection: a country by the catalogue, a server as one', () => {
    const facts = buildFacts(builder({
      items: [
        item({ id: 1, kind: 'country', country_code: 'de', position: 0 }),
        item({ id: 2, kind: 'node', fingerprint: 'nl1', original_name: 'NL-1', position: 1 }),
        item({ id: 3, kind: 'country', country_code: 'DE', position: 2 }),
        item({ id: 4, kind: 'country', country_code: 'NL', position: 3, enabled: false }),
      ],
    }), [source()]);
    expect(facts).toMatchObject({ servers: 4, countries: ['DE'], mode: 'selected', problem: '' });
    expect(buildFactsSummary(facts)).toBe('4 сервера · 1 страна');
  });

  it('says why a сборка serves nothing', () => {
    expect(buildFacts(builder({ sources: [] }), [source()]).problem).toBe('Источник не выбран: подписка не соберётся.');
    expect(buildFacts(builder(), [source({ enabled: false })]).problem).toBe('Все источники отключены или просрочены.');
    expect(buildFacts(builder(), [source({ expired: true })]).problem).toBe('Все источники отключены или просрочены.');
    expect(buildFacts(builder({ items: [item({ country_code: 'DE', enabled: false })] }), [source()]).problem)
      .toBe('Ничего не выбрано: подписка не соберётся.');
    const empty = buildFacts(builder({ items: [item({ country_code: 'US' })] }), [source()]);
    expect(empty.problem).toBe('По выбранным странам и серверам сейчас ничего нет.');
    expect(buildFactsSummary(empty)).toBe('Ни одного сервера');
    // A deleted source still has a readable name on the card.
    expect(buildFacts(builder({ sources: [{ source_id: 9, position: 0 }] }), [source()])).toMatchObject({
      sources: ['Источник #9'], problem: 'Все источники отключены или просрочены.',
    });
  });

  it('shows the first country codes and how many more there are', () => {
    expect(countryChips(['DE', '', 'NL', 'US'], 2)).toEqual({ shown: ['DE', 'NL'], more: 1 });
    expect(countryChips(['DE'])).toEqual({ shown: ['DE'], more: 0 });
    expect(countryChips([])).toEqual({ shown: [], more: 0 });
  });

  it('pluralizes clients', () => {
    expect([0, 1, 3, 5, 21].map(clientsLabel)).toEqual(['0 клиентов', '1 клиент', '3 клиента', '5 клиентов', '21 клиент']);
  });
});

describe('what depends on a сборка', () => {
  const ref = (id: number, name: string) => ({ id, name });

  it('names the system uses, never the internal sale plan', () => {
    expect(systemUses(undefined)).toEqual([]);
    expect(systemUses({ plans: [ref(1, 'trial'), ref(2, 'free'), ref(3, 'Европа')] })).toEqual(['Пробная подписка', 'Бесплатный доступ']);
  });

  it('explains why it cannot be deleted without naming a plan', () => {
    expect(buildDeleteBlocker(undefined)).toBe('');
    expect(buildDeleteBlocker({ plans: [], subscriptions: 0 })).toBe('');
    expect(buildDeleteBlocker({ plans: [ref(1, 'trial')], subscriptions: 0 })).toBe('на ней работает «пробная подписка»');
    expect(buildDeleteBlocker({ plans: [ref(1, 'trial'), ref(2, 'free')], subscriptions: 0 }))
      .toBe('на ней работает «пробная подписка» и «бесплатный доступ»');
    // The plan of the old kind ("test-customer-1") is never shown to the owner.
    const sold = buildDeleteBlocker({ plans: [ref(3, 'test-customer-1')], subscriptions: 0 });
    expect(sold).toBe('у неё есть тарифы или клиенты, которые её купили');
    expect(sold).not.toContain('test-customer-1');
    expect(buildDeleteBlocker({ plans: [], subscriptions: 1 })).toBe('она назначена лично 1 клиенту');
    expect(buildDeleteBlocker({ plans: [ref(1, 'trial'), ref(3, 'Европа')], subscriptions: 2 }))
      .toBe('на ней работает «пробная подписка»; у неё есть тарифы или клиенты, которые её купили; она назначена лично 2 клиентам');
  });
});

describe('health from the network monitor', () => {
  const summary = (over: Partial<MonitorBuilderSummary> = {}): MonitorBuilderSummary => ({
    id: 7, name: 'Европа', enabled: true, status: 'up', countries_total: 2, countries_up: 2, countries_degraded: 0, countries_down: 0,
    nodes_total: 3, nodes_up: 3, nodes_down: 0, nodes_unknown: 0, avg_latency_ms: 40, last_checked_at: T0, last_transition: null,
    source_errors: 0, unresolved: 0, ...over,
  });

  it('reads the state of the servers a сборка serves', () => {
    expect(buildHealth(summary(), false)).toEqual({ tone: 'off', text: 'Отключена: клиентам не выдаётся' });
    expect(buildHealth(undefined, true)).toEqual({ tone: 'unknown', text: 'Проверка ещё не выполнялась' });
    expect(buildHealth(summary({ nodes_total: 0, nodes_up: 0 }), true).tone).toBe('unknown');
    expect(buildHealth(summary({ nodes_up: 0, nodes_unknown: 3 }), true)).toEqual({ tone: 'unknown', text: '3 сервера · ждут первой проверки' });
    expect(buildHealth(summary(), true)).toEqual({ tone: 'ok', text: 'Работают все серверы: 3' });
    expect(buildHealth(summary({ nodes_up: 0, nodes_down: 3 }), true)).toEqual({ tone: 'down', text: 'Недоступны все серверы: 3' });
    expect(buildHealth(summary({ nodes_up: 2, nodes_down: 1 }), true)).toEqual({ tone: 'warn', text: 'Недоступно 1 из 3' });
  });
});

describe('prices of a сборка', () => {
  const tariff = (over: Partial<AdminTariff> = {}): AdminTariff => ({
    id: 1, offer_id: 'a'.repeat(32), name: '1 месяц', plan_id: 5, plan_name: 'Европа', plan_active: true, builder_id: 7,
    builder_name: 'Европа', duration_days: 30, price_cents: 19900, currency: 'RUB', is_active: true, description: '', features: [],
    badge: '', sort_order: 0, version: 1, previous_id: null, replaced_by_id: null, orders: 0, subscriptions: 0, in_use: false,
    offer_ends_at: null, created_at: T0, updated_at: T0, ...over,
  });

  it('lists the current tariffs of the сборка, shortest term first', () => {
    const list = [
      tariff({ id: 1, duration_days: 365, price_cents: 199000 }),
      tariff({ id: 2 }),
      tariff({ id: 3, builder_id: 8 }),
      tariff({ id: 4, replaced_by_id: 2 }),
      tariff({ id: 5, price_cents: 9900, is_active: false }),
      tariff({ id: 6, builder_id: null }),
    ];
    expect(buildTariffs(list, 7).map(t => t.id)).toEqual([5, 2, 1]);
    expect(buildTariffs(list, 9)).toEqual([]);
    expect(priceLabel(tariff())).toBe('30 дней · 199 ₽');
    expect(priceLabel(tariff({ price_cents: 0, duration_days: 7 }))).toBe('7 дней · Бесплатно');
  });

  it('offers the usual terms', () => {
    expect(PRICE_PRESETS.map(p => p.days)).toEqual([30, 90, 180, 365]);
    expect(isBlankPrice(EMPTY_PRICE)).toBe(true);
    expect(isBlankPrice({ name: ' ', days: '', price: ' ' })).toBe(true);
    expect(isBlankPrice({ name: '', days: '30', price: '' })).toBe(false);
  });

  it('validates a new price like the tariff editor', () => {
    expect(validatePrice({ name: ' 1 месяц ', days: '30', price: '199' })).toEqual({
      input: { name: '1 месяц', duration_days: 30, price_cents: 19900 }, errors: {},
    });
    expect(validatePrice({ name: 'Год', days: '365', price: '1 990,50' }).input?.price_cents).toBe(199050);
    // 0 is a free tariff; an empty price is an error, so it is never free by accident.
    expect(validatePrice({ name: 'Старт', days: '7', price: '0' }).input?.price_cents).toBe(0);
    const bad = validatePrice({ name: '', days: '0', price: '' });
    expect(bad.input).toBeNull();
    expect(Object.keys(bad.errors).sort()).toEqual(['days', 'name', 'price']);
    for (const days of ['3651', 'abc', '1.5', '-1', '']) expect(validatePrice({ name: 'x', days, price: '1' }).errors.days).toBeDefined();
    expect(validatePrice({ name: 'x', days: '3650', price: '1' }).errors).toEqual({});
    expect(validatePrice({ name: 'я'.repeat(65), days: '30', price: '1' }).errors.name).toBe('Не длиннее 64 символов.');
    expect(validatePrice({ name: 'x', days: '30', price: '1000001' }).errors.price).toBe('Слишком большая цена.');
    expect(validatePrice({ name: 'x', days: '30', price: '1,999' }).errors.price).toBeDefined();
  });
});
