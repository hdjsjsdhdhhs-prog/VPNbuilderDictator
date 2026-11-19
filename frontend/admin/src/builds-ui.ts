// «Сборки» (Admin → Сборки): the list of сборки and the constructor of one.
//
// A сборка is a subscription builder as the owner sees it: which servers of the
// bought provider subscriptions a client gets, what they are called and for
// what price. One page does the whole job: pick the sources, tick countries or
// single servers, name the result and set the prices. The plan a tariff is
// sold on is never shown: the server keeps it (database/builder_plans.go).
//
// The screens are plain DOM over AdminApi. Every rule stays on the server; the
// live preview (builds.resolveDraft) mirrors the /sub selection and the
// «Проверить на сервере» button runs the real one for the saved сборка. Text is
// always assigned as text.
//
// The host (AdminApp in main.ts) owns routing, the session, the confirmation
// dialog and the unsaved-changes guard; a screen is created per route and
// disposed when the route changes, which drops every response still in flight.

import {
  ApiError, errorText, newRequestKey,
  type AdminApi, type AdminBuilder, type AdminSource, type AdminTariff, type BuilderPreview, type MonitorOverview,
  type SourceEntry,
} from './api';
import {
  BUILD_LIMITS, BUILD_SERVER_FIELDS, EMPTY_PRICE, PRICE_PRESETS, buildDeleteBlocker, buildFacts, buildFactsSummary, buildHealth,
  buildTariffs, buildsHash, clearSource, clientsLabel, configItems, copyName, countryChips, countryTick, countryTitle,
  draftFromBuilder, groupByCountry, isBlankPrice, moveRule, newDraft, nodeTicked, priceLabel, rebindRules, removeRule, renameRule,
  resolutionSummary, resolveDraft, ruleProblemText, ruleTitle, rulesForSources, sameDraft, suggestName, systemUses, tickAll,
  toggleCountry, toggleNode, validateDraft, validatePrice,
  type BuildDraft, type BuildsRoute, type CountryGroup, type DraftErrors, type DraftField, type DraftRule, type PriceErrors,
  type PriceRow, type Resolution,
} from './builds';
import { catalogueSummary, expiryState, previewSummary, serversLabel, sourceUsable, syncState } from './sources';
import { pluralRu } from './tariffs';

// =============================================================================
// Host contract
// =============================================================================

/** Icons the screens use (a subset of the admin icon set). */
export type BuildsIcon = 'plus' | 'refresh' | 'trash' | 'alert' | 'info' | 'check' | 'up' | 'chevron' | 'search' | 'close'
  | 'builders' | 'sources' | 'monitoring' | 'eye' | 'edit';

/** Lists shared with the other sections; null while a list was never loaded. */
export interface BuildsStore {
  sources: readonly AdminSource[] | null;
  builders: readonly AdminBuilder[] | null;
  tariffs: readonly AdminTariff[] | null;
}

export interface BuildsHost {
  readonly api: AdminApi;
  readonly store: BuildsStore;
  icon(name: BuildsIcon, size?: 16 | 20): Element;
  toast(text: string): void;
  /** A modal yes/no question; false when dismissed. */
  confirm(title: string, text: string, confirmLabel: string): Promise<boolean>;
  /** Reports unsaved changes of the open screen to the navigation guard (null: none). */
  setUnsaved(check: (() => boolean) | null): void;
  /** true when the error ended the session and the host left the screen. */
  signedOut(error: unknown, current: () => boolean): Promise<boolean>;
  /** Leaves the screen without the unsaved-changes question. */
  navigate(hash: string): void;
  /** A protected request just succeeded (the session is alive). */
  sessionUsed(): void;
}

export interface BuildsPage {
  readonly header: HTMLElement;
  readonly title: HTMLElement;
  readonly desc: HTMLElement;
}

// What survives one navigation within the signed-in session (never the URL or
// storage): a draft to open the constructor with («Дублировать») and the notice
// to show after a created сборка is reopened under its own address.
interface Memory {
  copy: BuildDraft | null;
  notice: { id: number; text: string } | null;
}

const memory: Memory = { copy: null, notice: null };

/** Forgets the session memory (sign-out, tests). */
export function resetBuildsMemory() {
  memory.copy = null;
  memory.notice = null;
}

const LIST_DESC = 'Сборка — это подписка, которую получает клиент: страны и серверы из купленных вами подписок провайдеров, их названия и цена.';
const NEW_DESC = 'Выберите источник, отметьте страны или отдельные серверы и задайте цену. Справа сразу видно, что получит клиент.';
/** Servers listed in the live preview before «ещё N». */
const PREVIEW_LIMIT = 40;

// =============================================================================
// DOM helpers (text is always assigned as text)
// =============================================================================

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const numberFormat = new Intl.NumberFormat('ru-RU');
const count = (n: number) => numberFormat.format(n);
const clockSeconds = (date: Date) => date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

function setLabel(node: HTMLButtonElement, label: string) {
  const target = node.querySelector('.btn-label');
  if (target) target.textContent = label;
}

function setBusy(node: HTMLButtonElement, busy: boolean) {
  node.disabled = busy;
  if (busy) node.setAttribute('aria-busy', 'true');
  else node.removeAttribute('aria-busy');
}

function setLoading(node: HTMLElement, label: string | null) {
  if (label) {
    node.setAttribute('aria-busy', 'true');
    node.setAttribute('role', 'status');
    node.setAttribute('aria-label', label);
  } else {
    node.removeAttribute('aria-busy');
    node.removeAttribute('role');
    node.removeAttribute('aria-label');
  }
}

function skeleton(rows: number): HTMLElement {
  const panel = el('div', 'panel');
  const lines = el('div', 'skeleton-rows');
  for (let i = 0; i < rows; i++) lines.append(el('span', 'skeleton skeleton-row'));
  panel.append(lines);
  return panel;
}

function dot(tone: string): HTMLElement {
  const node = el('span', `health-dot is-${tone}`);
  node.setAttribute('aria-hidden', 'true');
  return node;
}

/** A country code as a text chip: flag emoji do not render on Windows. */
function codeChip(code: string): HTMLElement {
  const node = el('span', 'bd-code', code || '—');
  node.title = countryTitle(code);
  return node;
}

interface Field {
  readonly root: HTMLElement;
  setError(text: string): void;
}

/** Label, control, hint and error of one input. */
function field(label: string, control: HTMLInputElement | HTMLTextAreaElement, hint = ''): Field {
  const root = el('div', 'field');
  const caption = el('label', 'field-label', label);
  caption.htmlFor = control.id;
  const box = el('div', 'control');
  box.append(control);
  const error = el('p', 'field-error');
  error.id = `${control.id}-error`;
  error.setAttribute('aria-live', 'polite');
  root.append(caption, box);
  if (hint) {
    const hintNode = el('p', 'field-hint', hint);
    hintNode.id = `${control.id}-hint`;
    control.setAttribute('aria-describedby', hintNode.id);
    root.append(hintNode);
  }
  root.append(error);
  return {
    root,
    setError(text: string) {
      error.textContent = text;
      if (text) control.setAttribute('aria-invalid', 'true');
      else control.removeAttribute('aria-invalid');
    },
  };
}

function textInput(id: string, maxLength: number, mode: 'text' | 'numeric' | 'decimal' | 'url' = 'text'): HTMLInputElement {
  const node = el('input', 'input');
  node.id = id;
  node.type = 'text';
  node.autocomplete = 'off';
  node.spellcheck = false;
  node.inputMode = mode;
  node.maxLength = maxLength;
  return node;
}

function panel(id: string, title: string, note = ''): { root: HTMLElement; body: HTMLElement; meta: HTMLElement } {
  const root = el('section', 'panel bd-panel');
  root.setAttribute('aria-labelledby', id);
  const head = el('div', 'panel-head');
  const heading = el('h2', 'panel-title', title);
  heading.id = id;
  const meta = el('span', 'panel-meta');
  head.append(heading, meta);
  const body = el('div', 'bd-panel-body');
  root.append(head);
  if (note) root.append(el('p', 'bd-panel-note', note));
  root.append(body);
  return { root, body, meta };
}

/** The data-focus-key of the focused control inside container, if any. */
function focusKeyOf(container: HTMLElement): string | undefined {
  const active = document.activeElement;
  return active instanceof HTMLElement && container.contains(active) ? active.dataset.focusKey : undefined;
}

function restoreFocus(container: HTMLElement, key: string | undefined) {
  if (!key) return;
  container.querySelector<HTMLElement>(`[data-focus-key='${CSS.escape(key)}']`)?.focus();
}

/** Text of a failed save/delete/toggle of a сборка. */
function buildErrorText(error: unknown): string {
  if (!(error instanceof ApiError)) return errorText(error);
  switch (error.code) {
    case 'name_taken': return 'Сборка с таким названием уже есть.';
    case 'version_conflict': return 'Сборку изменили в другом окне или другим администратором.';
    case 'builder_in_use': return 'Сборку уже продают или она назначена клиентам: удалить её нельзя, можно отключить.';
    case 'request_key_conflict': return 'Запрос конфликтует с ранее отправленным. Повторите действие.';
    case 'invalid_request': return 'Сервер отклонил параметры сборки.';
    case 'invalid_tariff': return 'Сервер отклонил параметры цены.';
    case 'not_found': return error.status === 404 ? 'Сборка не найдена: возможно, её уже удалили.' : errorText(error);
    default: return errorText(error);
  }
}

const ITEMS_REASONS: Readonly<Record<string, string>> = {
  too_many: 'Слишком много отдельных серверов. Отмечайте страны целиком.',
  custom_name_too_long: `Название сервера для клиента — не длиннее ${BUILD_LIMITS.customName} символов.`,
  invalid_country: 'У одной из стран нет кода: отметьте её серверы по отдельности.',
  source_required: 'Одно из правил ссылается на источник, которого нет в сборке.',
};

// =============================================================================
// Screen
// =============================================================================

export class BuildsScreen {
  readonly body: HTMLElement;
  private disposed = false;
  private request = 0;
  private refresh: HTMLButtonElement | null = null;
  private updated: HTMLElement | null = null;
  private monitor: MonitorOverview | null = null;

  constructor(private readonly host: BuildsHost, private readonly route: BuildsRoute, private readonly page: BuildsPage) {
    this.body = el('div', route.view === 'list' ? 'bd bd-list' : 'bd bd-editor');
    if (route.view === 'list') this.mountList();
    else this.mountEditorShell();
  }

  dispose() {
    this.disposed = true;
    this.request++;
    this.host.setUnsaved(null);
  }

  load(): Promise<void> {
    return this.route.view === 'list' ? this.loadList(false) : this.loadEditor();
  }

  private current = (request: number) => !this.disposed && request === this.request;

  private btn(label: string, className: string, leading?: BuildsIcon): HTMLButtonElement {
    const node = el('button', className);
    node.type = 'button';
    if (leading) node.append(this.host.icon(leading));
    node.append(el('span', 'btn-label', label));
    return node;
  }

  private link(label: string, href: string, className: string, leading?: BuildsIcon): HTMLAnchorElement {
    const node = el('a', className);
    node.href = href;
    if (leading) node.append(this.host.icon(leading));
    node.append(el('span', 'btn-label', label));
    return node;
  }

  private notice(tone: 'error' | 'info' | 'success' | 'warn', text: string, actions: HTMLElement[] = []): HTMLElement {
    const node = el('div', `notice notice-${tone}`);
    node.append(this.host.icon(tone === 'error' || tone === 'warn' ? 'alert' : tone === 'success' ? 'check' : 'info'));
    if (!actions.length) {
      node.append(el('p', '', text));
      return node;
    }
    const content = el('div', 'notice-body');
    const row = el('div', 'notice-actions');
    row.append(...actions);
    content.append(el('p', '', text), row);
    node.append(content);
    return node;
  }

  private message(name: BuildsIcon, title: string, text: string, role: 'status' | 'alert', action?: HTMLElement): HTMLElement {
    const node = el('section', 'panel empty');
    node.setAttribute('role', role);
    node.append(this.host.icon(name, 20), el('h2', 'empty-title', title), el('p', 'empty-text', text));
    if (action) node.append(action);
    return node;
  }

  // ===========================================================================
  // List (#/builders)
  // ===========================================================================

  private mountList() {
    const { header, desc } = this.page;
    desc.textContent = LIST_DESC;
    const actions = el('div', 'page-actions');
    const updated = el('p', 'updated');
    updated.setAttribute('aria-live', 'polite');
    const refresh = this.btn('Обновить', 'btn btn-secondary btn-sm', 'refresh');
    refresh.addEventListener('click', () => void this.loadList(false));
    const add = this.link('Новая сборка', buildsHash({ view: 'new', sourceId: null }), 'btn btn-primary btn-sm', 'plus');
    actions.append(updated, add, refresh);
    header.classList.add('has-actions');
    header.append(actions);
    this.refresh = refresh;
    this.updated = updated;
    const { builders, sources, tariffs } = this.host.store;
    if (builders && sources && tariffs) this.paintList(builders, sources, tariffs);
    else this.paintListSkeleton();
  }

  private paintListSkeleton() {
    setLoading(this.body, 'Загружаем сборки');
    this.body.replaceChildren(skeleton(4), skeleton(4));
  }

  private async loadList(silent: boolean) {
    const request = ++this.request;
    const current = () => this.current(request);
    const { store, api } = this.host;
    const known = store.builders !== null && store.sources !== null && store.tariffs !== null;
    if (this.refresh && !silent) {
      setBusy(this.refresh, true);
      setLabel(this.refresh, 'Обновляем…');
    }
    if (!known) this.paintListSkeleton();
    try {
      // The monitor is a best-effort extra: the list works without it.
      const [builders, sources, tariffs, monitor] = await Promise.all([
        api.listBuilders(), api.listSources(), api.listTariffs(), api.monitoring().catch(() => null),
      ]);
      if (!current()) return;
      this.host.sessionUsed();
      store.builders = builders;
      store.sources = sources;
      store.tariffs = tariffs;
      this.monitor = monitor;
      this.paintList(builders, sources, tariffs);
      if (this.updated) this.updated.textContent = `Обновлено в ${clockSeconds(new Date())}`;
    } catch (error) {
      if (!current()) return;
      if (await this.host.signedOut(error, current)) return;
      if (known) {
        this.host.toast(`Не удалось обновить сборки. ${errorText(error)}`);
      } else {
        setLoading(this.body, null);
        const retry = this.btn('Повторить', 'btn btn-secondary btn-sm', 'refresh');
        retry.addEventListener('click', () => void this.loadList(false));
        this.body.replaceChildren(this.message('alert', 'Не удалось загрузить сборки', errorText(error), 'alert', retry));
      }
    } finally {
      if (current() && this.refresh) {
        setBusy(this.refresh, false);
        setLabel(this.refresh, 'Обновить');
      }
    }
  }

  private paintList(builders: readonly AdminBuilder[], sources: readonly AdminSource[], tariffs: readonly AdminTariff[]) {
    setLoading(this.body, null);
    if (builders.length === 0) {
      if (sources.length === 0) {
        const add = this.link('Добавить источник', '#/sources', 'btn btn-primary btn-sm', 'plus');
        this.body.replaceChildren(this.message('sources', 'Сначала добавьте источник',
          'Источник — это купленная у провайдера подписка: одна ссылка, в которой много стран и серверов. Из неё собираются ваши подписки для клиентов.',
          'status', add));
        return;
      }
      const create = this.link('Создать сборку', buildsHash({ view: 'new', sourceId: null }), 'btn btn-primary btn-sm', 'plus');
      this.body.replaceChildren(this.message('builders', 'Сборок пока нет',
        'Соберите первую подписку для клиентов: выберите страны и серверы из источника, дайте ей название и цену.', 'status', create));
      return;
    }
    const focusKey = focusKeyOf(this.body);
    const selling = builders.filter(b => b.enabled && buildTariffs(tariffs, b.id).some(t => t.is_active)).length;
    const summary = el('p', 'bd-summary',
      `${count(builders.length)} ${pluralRu(builders.length, 'сборка', 'сборки', 'сборок')} · в продаже ${count(selling)}`);
    const list = el('ul', 'bd-cards');
    list.setAttribute('aria-label', 'Сборки');
    for (const b of builders) list.append(this.card(b, sources, tariffs));
    this.body.replaceChildren(summary, list);
    restoreFocus(this.body, focusKey);
  }

  private card(b: AdminBuilder, sources: readonly AdminSource[], tariffs: readonly AdminTariff[]): HTMLElement {
    const facts = buildFacts(b, sources);
    const prices = buildTariffs(tariffs, b.id);
    const onSale = prices.filter(t => t.is_active);
    const system = systemUses(b.dependents);
    const item = el('li', b.enabled ? 'bd-card' : 'bd-card is-off');
    item.dataset.buildId = String(b.id);

    const head = el('div', 'bd-card-head');
    const title = el('a', 'bd-card-title', b.name);
    title.href = buildsHash({ view: 'edit', id: b.id });
    title.dataset.focusKey = `open-${b.id}`;
    head.append(title);
    if (!b.enabled) head.append(el('span', 'badge', 'Отключена'));
    else if (facts.problem) head.append(el('span', 'badge badge-danger', 'Не собирается'));
    else if (onSale.length) head.append(el('span', 'badge badge-active', 'В продаже'));
    else if (!system.length) head.append(el('span', 'badge badge-warn', 'Без цены'));
    for (const label of system) head.append(el('span', 'badge', label));
    item.append(head);

    item.append(el('p', 'bd-card-facts', `${buildFactsSummary(facts)} · ${facts.mode === 'all' ? 'все серверы источника' : 'выбранные страны и серверы'}`));
    if (facts.problem) item.append(el('p', 'bd-card-problem', facts.problem));
    const chips = countryChips(facts.countries, 12);
    if (chips.shown.length) {
      const row = el('ul', 'bd-codes');
      row.setAttribute('aria-label', 'Страны');
      for (const code of chips.shown) {
        const li = el('li');
        li.append(codeChip(code));
        row.append(li);
      }
      if (chips.more) row.append(el('li', 'bd-more', `+${count(chips.more)}`));
      item.append(row);
    }

    const health = buildHealth(this.monitor?.builders.find(m => m.id === b.id), b.enabled);
    const healthRow = el('p', 'bd-card-health');
    healthRow.append(dot(health.tone), el('span', '', health.text));
    item.append(healthRow);

    const priceText = prices.length === 0
      ? (system.length ? 'Платных цен нет' : 'Цена не задана: купить эту сборку пока нельзя')
      : prices.map(t => `${priceLabel(t)}${t.is_active ? '' : ' (скрыт)'}`).join('; ');
    item.append(el('p', prices.length === 0 && !system.length ? 'bd-card-prices is-warn' : 'bd-card-prices', priceText));

    const clients = b.sales?.clients ?? 0;
    item.append(el('p', 'bd-card-meta', [clientsLabel(clients), facts.sources.length ? `источник: ${facts.sources.join(', ')}` : 'источник не выбран'].join(' · ')));

    const actions = el('div', 'bd-card-actions');
    const open = this.link('Открыть', buildsHash({ view: 'edit', id: b.id }), 'btn btn-primary btn-sm');
    open.setAttribute('aria-label', `Открыть «${b.name}»`);
    const copy = this.btn('Дублировать', 'btn btn-secondary btn-sm');
    copy.setAttribute('aria-label', `Дублировать «${b.name}»`);
    copy.addEventListener('click', () => this.duplicate(b));
    const toggle = this.btn(b.enabled ? 'Отключить' : 'Включить', 'btn btn-secondary btn-sm');
    toggle.setAttribute('aria-label', `${b.enabled ? 'Отключить' : 'Включить'} «${b.name}»`);
    toggle.dataset.focusKey = `toggle-${b.id}`;
    toggle.addEventListener('click', () => void this.toggle(b, toggle));
    const remove = this.btn('Удалить', 'btn btn-danger btn-sm', 'trash');
    remove.setAttribute('aria-label', `Удалить «${b.name}»`);
    remove.dataset.focusKey = `delete-${b.id}`;
    remove.addEventListener('click', () => void this.removeFromList(b, remove));
    actions.append(open, copy, toggle, remove);
    item.append(actions);
    return item;
  }

  /** Opens the constructor with a copy of a сборка; nothing is written until it is saved. */
  private duplicate(b: AdminBuilder) {
    const taken = (this.host.store.builders ?? []).map(x => x.name);
    const draft = draftFromBuilder(b);
    memory.copy = { ...draft, name: copyName(b.name, taken), rules: draft.rules.map(rule => ({ ...rule, id: 0 })) };
    this.host.navigate(buildsHash({ view: 'new', sourceId: null }));
  }

  private repaintList() {
    const { builders, sources, tariffs } = this.host.store;
    if (builders && sources && tariffs) this.paintList(builders, sources, tariffs);
  }

  private async toggle(b: AdminBuilder, trigger: HTMLButtonElement) {
    const request = this.request;
    const current = () => this.current(request);
    setBusy(trigger, true);
    try {
      const updated = b.enabled ? await this.host.api.disableBuilder(b.id) : await this.host.api.enableBuilder(b.id);
      if (!current()) return;
      this.host.sessionUsed();
      const { store } = this.host;
      // The toggle answers without the sale state: keep what the list had.
      const merged: AdminBuilder = { ...b, ...updated, dependents: updated.dependents ?? b.dependents, sales: updated.sales ?? b.sales };
      store.builders = (store.builders ?? []).map(x => (x.id === merged.id ? merged : x));
      this.repaintList();
      this.host.toast(merged.enabled ? `Сборка «${b.name}» включена.` : `Сборка «${b.name}» отключена: клиенты перестали её получать.`);
    } catch (error) {
      if (!current()) return;
      if (await this.host.signedOut(error, current)) return;
      setBusy(trigger, false);
      this.host.toast(`Не удалось изменить сборку «${b.name}». ${buildErrorText(error)}`);
    }
  }

  private async removeFromList(b: AdminBuilder, trigger: HTMLButtonElement) {
    const request = this.request;
    const current = () => this.current(request);
    const done = await this.remove(b, current, trigger);
    if (!current()) return;
    if (done === 'deleted') {
      const { store } = this.host;
      store.builders = (store.builders ?? []).filter(x => x.id !== b.id);
      this.repaintList();
    } else if (done === 'stale') {
      void this.loadList(false);
    }
  }

  /**
   * Deletes a сборка nothing depends on. One that is sold or assigned is only
   * explained: it can be switched off instead. The server re-checks the
   * dependents and the loaded version.
   */
  private async remove(b: AdminBuilder, current: () => boolean, trigger: HTMLButtonElement): Promise<'deleted' | 'stale' | 'kept'> {
    const blocker = buildDeleteBlocker(b.dependents);
    if (blocker) {
      this.host.toast(`Сборку «${b.name}» нельзя удалить: ${blocker}. Её можно отключить.`);
      return 'kept';
    }
    const confirmed = await this.host.confirm(`Удалить сборку «${b.name}»?`,
      'Сборка, её состав и названия серверов будут удалены. Источники и их серверы останутся. Действие нельзя отменить.', 'Удалить');
    if (!current()) return 'kept';
    if (!confirmed) { trigger.focus(); return 'kept'; }
    setBusy(trigger, true);
    try {
      await this.host.api.deleteBuilder(b.id, b.version, newRequestKey());
      this.host.sessionUsed();
      this.host.toast(`Сборка «${b.name}» удалена.`);
      return 'deleted';
    } catch (error) {
      if (!current()) return 'kept';
      if (await this.host.signedOut(error, current)) return 'kept';
      if (error instanceof ApiError && error.status === 404) {
        this.host.toast(`Сборки «${b.name}» уже нет.`);
        return 'deleted';
      }
      setBusy(trigger, false);
      this.host.toast(`Сборка «${b.name}» не удалена. ${buildErrorText(error)}`);
      return error instanceof ApiError && (error.code === 'builder_in_use' || error.code === 'version_conflict') ? 'stale' : 'kept';
    }
  }

  // ===========================================================================
  // Constructor (#/builders/new, #/builders/{id})
  // ===========================================================================

  private mountEditorShell() {
    const { title, desc } = this.page;
    const id = this.route.view === 'edit' ? this.route.id : null;
    const known = id === null ? null : this.host.store.builders?.find(b => b.id === id) ?? null;
    title.textContent = id === null ? 'Новая сборка' : known?.name ?? 'Сборка';
    desc.textContent = id === null ? NEW_DESC : `Сборка #${id}`;
    this.paintEditorSkeleton();
  }

  private paintEditorSkeleton() {
    setLoading(this.body, 'Загружаем сборку');
    const grid = el('div', 'editor-grid');
    const main = el('div', 'editor-main');
    main.append(skeleton(4), skeleton(6));
    const side = el('div', 'editor-side');
    side.append(skeleton(5));
    grid.append(main, side);
    this.body.replaceChildren(grid);
  }

  private async loadEditor() {
    const request = ++this.request;
    const current = () => this.current(request);
    const { api, store } = this.host;
    const id = this.route.view === 'edit' ? this.route.id : null;
    this.paintEditorSkeleton();
    try {
      const [sources, builders, tariffs, builder, monitor] = await Promise.all([
        api.listSources(), api.listBuilders(), api.listTariffs(),
        id === null ? Promise.resolve(null) : api.getBuilder(id).catch((error: unknown) => {
          if (error instanceof ApiError && error.status === 404) return 'missing' as const;
          throw error;
        }),
        id === null ? Promise.resolve(null) : api.monitoring().catch(() => null),
      ]);
      if (!current()) return;
      this.host.sessionUsed();
      store.sources = sources;
      store.builders = builders;
      store.tariffs = tariffs;
      this.monitor = monitor;
      if (builder === 'missing') {
        this.paintMissing(id ?? 0);
        return;
      }
      // The list copy carries the sale state and the dependents of the сборка.
      const listed = builder ? builders.find(b => b.id === builder.id) : undefined;
      const loaded = builder ? { ...builder, sales: builder.sales ?? listed?.sales, dependents: builder.dependents ?? listed?.dependents } : null;
      this.paintEditor(loaded, sources, current);
    } catch (error) {
      if (!current()) return;
      if (await this.host.signedOut(error, current)) return;
      setLoading(this.body, null);
      const retry = this.btn('Повторить', 'btn btn-secondary btn-sm', 'refresh');
      retry.addEventListener('click', () => void this.loadEditor());
      this.body.replaceChildren(this.message('alert', 'Не удалось загрузить сборку', errorText(error), 'alert', retry));
    }
  }

  private paintMissing(id: number) {
    setLoading(this.body, null);
    this.page.title.textContent = 'Сборка не найдена';
    this.page.desc.textContent = `Сборка #${id}`;
    const back = this.link('К списку сборок', buildsHash({ view: 'list' }), 'btn btn-secondary btn-sm');
    this.body.replaceChildren(this.message('builders', 'Сборка не найдена', `Сборки #${id} нет: возможно, её уже удалили.`, 'status', back));
  }

  /**
   * The constructor. Everything is one draft (builds.BuildDraft): the panels
   * repaint from it, the preview resolves it against the loaded catalogues and
   * saving writes it in one transaction (PUT /builders/{id}/configuration),
   * then adds the new prices as tariffs of the сборка.
   */
  private paintEditor(loaded: AdminBuilder | null, sources: readonly AdminSource[], current: () => boolean) {
    setLoading(this.body, null);
    const { host } = this;
    const { api, store } = host;
    let base = loaded;
    const isNew = () => base === null;

    // Draft ------------------------------------------------------------------
    const usable = sources.filter(sourceUsable);
    const routeSource = this.route.view === 'new' ? this.route.sourceId : null;
    const copied = this.route.view === 'new' ? memory.copy : null;
    memory.copy = null;
    const startSources = routeSource !== null && sources.some(s => s.id === routeSource) ? [routeSource]
      : usable.length === 1 ? [usable[0].id] : sources.length === 1 ? [sources[0].id] : [];
    // The baseline of a new сборка is the form as it opens: the suggested
    // source is not an edit. A copy has no baseline: all of it is unsaved.
    let baseline: BuildDraft = base ? draftFromBuilder(base) : copied ? newDraft([]) : newDraft(startSources);
    let draft: BuildDraft = base ? baseline
      : copied ? { ...copied, sourceIds: copied.sourceIds.filter(id => sources.some(s => s.id === id)) }
        : baseline;
    if (!base && copied) draft = { ...draft, rules: rulesForSources(draft.rules, draft.sourceIds) };
    // A new сборка is named after what is ticked until the name is typed by hand.
    let autoName = !base && !copied;
    // Rules switched off in the old editor are not ticks: saving removes them.
    const disabledRules = (base?.items ?? []).filter(item => !item.enabled).length;
    let parkedRules: readonly DraftRule[] = draft.mode === 'all' ? [] : draft.rules;
    let saving = false;
    let errors: DraftErrors = {};
    let prices: PriceRow[] = [];
    let priceErrors: PriceErrors[] = [];
    let priceFailure = '';
    let query = '';
    const expanded = new Set<string>();
    const entries = new Map<number, readonly SourceEntry[]>();
    const entryState = new Map<number, 'loading' | 'error'>();
    let serverPreview: { state: 'idle' | 'loading' | 'error' | 'done'; data?: BuilderPreview; error?: string } = { state: 'idle' };

    const sourceName = (id: number) => sources.find(s => s.id === id)?.name ?? `Источник #${id}`;
    const dirty = () => {
      if (prices.some(row => !isBlankPrice(row))) return true;
      // The automatic name of a new сборка is not an edit either.
      return !sameDraft(autoName ? { ...draft, name: baseline.name } : draft, baseline);
    };
    host.setUnsaved(() => current() && dirty());
    const resolution = (): Resolution => resolveDraft(draft, sources, entries);
    const takenNames = () => (store.builders ?? []).filter(b => b.id !== base?.id).map(b => b.name.trim().toLocaleLowerCase('ru-RU'));

    // Layout -----------------------------------------------------------------
    const statusSlot = el('div', 'editor-status');
    const showStatus = (node: HTMLElement | null, focus = true) => {
      if (!node) { statusSlot.replaceChildren(); return; }
      node.tabIndex = -1;
      statusSlot.replaceChildren(node);
      if (focus) node.focus();
    };

    const sourcesPanel = panel('bd-sources-title', '1. Источник',
      'Откуда брать серверы. Источник — купленная у провайдера подписка; можно объединить несколько.');
    const compositionPanel = panel('bd-composition-title', '2. Что получит клиент',
      'Отдайте всё, что есть в источнике, или соберите узкую подписку из нужных стран и серверов.');
    const orderPanel = panel('bd-order-title', '3. Порядок и названия',
      'Порядок в приложении клиента и свои названия серверов. Пустое название — как у провайдера.');
    const namePanel = panel('bd-name-title', '4. Название и оформление');
    const pricePanel = panel('bd-price-title', '5. Цена',
      'За сколько клиент покупает эту сборку. Каждая цена — отдельная кнопка в боте.');

    const dirtyNote = el('p', 'unsaved-text');
    dirtyNote.setAttribute('aria-live', 'polite');
    const reset = this.btn('Отменить изменения', 'btn btn-secondary');
    const save = this.btn('Сохранить', 'btn btn-primary');
    save.type = 'submit';
    const actionBar = el('div', 'panel editor-actions');
    actionBar.append(dirtyNote, reset, save);

    const form = el('form', 'editor-main');
    form.noValidate = true;
    form.setAttribute('aria-label', 'Параметры сборки');
    form.append(statusSlot, sourcesPanel.root, compositionPanel.root, orderPanel.root, namePanel.root, pricePanel.root, actionBar);

    const previewPanel = panel('bd-preview-title', 'Подписка клиента');
    previewPanel.root.classList.add('bd-preview');
    const checkPanel = panel('bd-check-title', 'Проверка на сервере');
    const statePanel = panel('bd-state-title', 'Состояние');
    const side = el('div', 'editor-side');
    side.append(previewPanel.root, checkPanel.root, statePanel.root);
    const grid = el('div', 'editor-grid');
    grid.append(form, side);
    this.body.replaceChildren(grid);

    // Name and look ------------------------------------------------------------
    const name = textInput('bd-name', BUILD_LIMITS.name);
    const nameField = field('Название сборки', name, 'Видно вам в панели и клиенту в названии тарифа.');
    const suggest = this.btn('Подставить по составу', 'chip');
    nameField.root.append(suggest);
    const profileTitle = textInput('bd-profile-title', BUILD_LIMITS.profileTitle);
    const profileField = field('Название подписки в приложении', profileTitle,
      'Так подписка называется в приложении клиента (Happ, v2rayTun и другие). Пусто — клиент увидит название провайдера.');
    const announce = textInput('bd-announce', BUILD_LIMITS.announce);
    const announceField = field('Объявление', announce, 'Короткая строка, которую приложение показывает при обновлении подписки. Необязательно.');
    const supportUrl = textInput('bd-support-url', BUILD_LIMITS.supportUrl, 'url');
    const supportField = field('Ссылка на поддержку', supportUrl, 'Например https://t.me/ваш_аккаунт. Необязательно.');
    const description = el('textarea', 'input textarea');
    description.id = 'bd-description';
    description.rows = 2;
    description.maxLength = BUILD_LIMITS.description;
    const descriptionField = field('Заметка для себя', description, 'Не показывается клиентам.');
    const enabled = el('input');
    enabled.type = 'checkbox';
    enabled.id = 'bd-enabled';
    const enabledRow = el('label', 'toggle');
    enabledRow.htmlFor = enabled.id;
    enabledRow.append(enabled, el('span', '', 'Сборка включена: клиенты получают её серверы'));
    const more = el('details', 'bd-more-fields');
    more.append(el('summary', '', 'Оформление в приложении клиента'), profileField.root, announceField.root, supportField.root, descriptionField.root);
    namePanel.body.append(nameField.root, enabledRow, more);

    const fieldSetters: Readonly<Record<DraftField, (text: string) => void>> = {
      name: nameField.setError, profileTitle: profileField.setError, announce: announceField.setError,
      supportUrl: supportField.setError, description: descriptionField.setError,
      sources: () => {}, composition: () => {},
    };
    const fieldTargets: Readonly<Partial<Record<DraftField, HTMLElement>>> = {
      name, profileTitle, announce, supportUrl, description, sources: sourcesPanel.root, composition: compositionPanel.root,
    };

    const writeFields = () => {
      name.value = draft.name;
      profileTitle.value = draft.profileTitle;
      announce.value = draft.announce;
      supportUrl.value = draft.supportUrl;
      description.value = draft.description;
      enabled.checked = draft.enabled;
      if (draft.profileTitle || draft.announce || draft.supportUrl || draft.description) more.open = true;
    };

    // Painters -----------------------------------------------------------------
    // A failed catalogue is not re-requested by a repaint: only «Повторить»
    // clears its state.
    const ensureEntries = (sourceId: number) => {
      if (entries.has(sourceId) || entryState.has(sourceId)) return;
      entryState.set(sourceId, 'loading');
      void api.listSourceEntries(sourceId).then(list => {
        if (!current()) return;
        entries.set(sourceId, list);
        entryState.delete(sourceId);
        // A server that got another identity on the provider's side keeps its
        // tick (builds.rebindRules); the stored сборка is rebound the same
        // way, so this alone is not an unsaved change.
        draft = { ...draft, rules: rebindRules(draft.rules, sourceId, list) };
        baseline = { ...baseline, rules: rebindRules(baseline.rules, sourceId, list) };
        parkedRules = rebindRules(parkedRules, sourceId, list);
        applyAutoName();
        paintComposition();
        paintOrder();
        paintPreview();
        paintActions();
      }).catch(async (error: unknown) => {
        if (!current()) return;
        if (await host.signedOut(error, current)) return;
        entryState.set(sourceId, 'error');
        paintComposition();
        paintPreview();
      });
    };

    const applyAutoName = () => {
      if (!autoName) return;
      const next = suggestName(resolution(), draft.mode, draft.sourceIds.map(sourceName));
      if (next === draft.name) return;
      draft = { ...draft, name: next };
      name.value = next;
    };

    const paintSources = () => {
      const nodes: HTMLElement[] = [];
      if (sources.length === 0) {
        nodes.push(this.notice('info', 'Источников пока нет. Добавьте подписку провайдера — сборка берёт серверы из неё.',
          [this.link('Добавить источник', '#/sources', 'btn btn-primary btn-sm', 'plus')]));
      }
      const list = el('div', 'bd-source-list');
      list.setAttribute('role', 'group');
      list.setAttribute('aria-label', 'Источники сборки');
      for (const src of sources) {
        const row = el('label', 'bd-source');
        const box = el('input');
        box.type = 'checkbox';
        box.checked = draft.sourceIds.includes(src.id);
        box.disabled = saving;
        box.dataset.focusKey = `source-${src.id}`;
        box.addEventListener('change', () => {
          const sourceIds = box.checked ? [...draft.sourceIds, src.id] : draft.sourceIds.filter(id => id !== src.id);
          draft = { ...draft, sourceIds, rules: rulesForSources(draft.rules, sourceIds) };
          parkedRules = rulesForSources(parkedRules, sourceIds);
          errors = { ...errors, sources: undefined, composition: undefined };
          changed();
        });
        const text = el('span', 'bd-source-text');
        text.append(el('span', 'bd-source-name', src.name));
        const state = syncState(src);
        const stats = state === 'never' && src.catalogue.entries === 0 ? 'каталог ещё не загружен' : catalogueSummary(src.catalogue);
        text.append(el('span', 'bd-source-stats', stats));
        const badges = el('span', 'bd-source-badges');
        if (!src.enabled) badges.append(el('span', 'badge', 'Отключён'));
        const expiry = expiryState(src, Date.now());
        if (expiry === 'expired') badges.append(el('span', 'badge badge-danger', 'Срок истёк'));
        else if (expiry === 'soon') badges.append(el('span', 'badge badge-warn', 'Скоро истекает'));
        if (state === 'error') badges.append(el('span', 'badge badge-danger', 'Ошибка синхронизации'));
        row.append(box, text, badges);
        list.append(row);
      }
      if (sources.length) nodes.push(list);
      if (errors.sources) nodes.push(el('p', 'field-error', errors.sources));
      const skipped = resolution().skippedSources;
      if (skipped.length) {
        nodes.push(this.notice('warn', `Сейчас не используется: ${skipped.map(sourceName).join(', ')}. Источник отключён или срок его подписки истёк — его серверы клиентам не выдаются.`));
      }
      const focusKey = focusKeyOf(sourcesPanel.body);
      sourcesPanel.body.replaceChildren(...nodes);
      restoreFocus(sourcesPanel.body, focusKey);
      sourcesPanel.meta.textContent = draft.sourceIds.length ? `выбрано ${count(draft.sourceIds.length)}` : '';
    };

    const groupVisible = (group: CountryGroup): { visible: boolean; byEntries: boolean } => {
      const needle = query.trim().toLocaleLowerCase('ru-RU');
      if (!needle) return { visible: true, byEntries: false };
      if (countryTitle(group.code).toLocaleLowerCase('ru-RU').includes(needle) || group.code.toLocaleLowerCase('ru-RU') === needle) {
        return { visible: true, byEntries: false };
      }
      const byEntries = group.entries.some(e => e.original_name.toLocaleLowerCase('ru-RU').includes(needle));
      return { visible: byEntries, byEntries };
    };

    const search = el('input', 'input search-input');
    search.id = 'bd-search';
    search.type = 'search';
    search.placeholder = 'Найти страну или сервер';
    search.autocomplete = 'off';
    search.setAttribute('aria-label', 'Найти страну или сервер');
    search.addEventListener('input', () => { query = search.value; paintCountries(); });
    const countriesSlot = el('div', 'bd-countries-slot');

    const paintCountries = () => {
      const nodes: HTMLElement[] = [];
      const needle = query.trim().toLocaleLowerCase('ru-RU');
      for (const sourceId of draft.sourceIds) {
        ensureEntries(sourceId);
        const block = el('div', 'bd-source-block');
        block.dataset.sourceId = String(sourceId);
        const head = el('div', 'bd-source-head');
        head.append(el('h3', 'bd-source-title', sourceName(sourceId)));
        const list = entries.get(sourceId);
        if (!list) {
          if (entryState.get(sourceId) === 'error') {
            const retry = this.btn('Повторить', 'btn btn-secondary btn-sm', 'refresh');
            retry.addEventListener('click', () => { entryState.delete(sourceId); paintCountries(); });
            block.append(head, this.notice('error', 'Не удалось загрузить серверы источника.', [retry]));
          } else {
            block.append(head, el('p', 'field-hint', 'Загружаем серверы источника…'));
          }
          nodes.push(block);
          continue;
        }
        const groups = groupByCountry(list);
        if (!groups.length) {
          block.append(head, this.notice('info', 'В источнике пока нет серверов. Синхронизируйте его в разделе «Источники».',
            [this.link('Открыть источник', `#/sources/${sourceId}`, 'btn btn-secondary btn-sm')]));
          nodes.push(block);
          continue;
        }
        const ticked = groups.filter(g => countryTick(draft.rules, sourceId, g).state !== 'none').length;
        head.append(el('span', 'bd-source-count', `отмечено стран: ${count(ticked)} из ${count(groups.length)}`));
        const all = this.btn('Отметить все', 'btn btn-ghost btn-sm');
        all.disabled = saving;
        all.dataset.focusKey = `all-${sourceId}`;
        all.addEventListener('click', () => { setRules(tickAll(draft.rules, sourceId, groups)); });
        const none = this.btn('Снять все', 'btn btn-ghost btn-sm');
        none.disabled = saving || ticked === 0;
        none.dataset.focusKey = `none-${sourceId}`;
        none.addEventListener('click', () => { setRules(clearSource(draft.rules, sourceId)); });
        const tools = el('div', 'bd-source-tools');
        tools.append(all, none);
        head.append(tools);
        block.append(head);

        const cards = el('ul', 'bd-countries');
        cards.setAttribute('aria-label', `Страны: ${sourceName(sourceId)}`);
        let shown = 0;
        for (const group of groups) {
          const { visible, byEntries } = groupVisible(group);
          if (!visible) continue;
          shown++;
          const key = `${sourceId}|${group.code}`;
          const tick = countryTick(draft.rules, sourceId, group);
          const open = expanded.has(key) || byEntries;
          const item = el('li', tick.state === 'none' ? 'bd-country' : 'bd-country is-ticked');
          item.dataset.country = group.code || 'none';
          const top = el('div', 'bd-country-head');
          const box = el('input');
          box.type = 'checkbox';
          box.id = `bd-c-${sourceId}-${group.code || 'none'}`;
          box.checked = tick.state === 'country';
          box.indeterminate = tick.state === 'nodes';
          box.disabled = saving;
          box.dataset.focusKey = `country-${key}`;
          box.addEventListener('change', () => { setRules(toggleCountry(draft.rules, sourceId, group)); });
          const label = el('label', 'bd-country-label');
          label.htmlFor = box.id;
          label.append(codeChip(group.code), el('span', 'bd-country-name', countryTitle(group.code)));
          const meta = tick.state === 'country' ? serversLabel(group.entries.length)
            : tick.state === 'nodes' ? `${count(tick.nodes)} из ${count(group.entries.length)}` : serversLabel(group.entries.length);
          const toggleNodes = this.btn(open ? 'Скрыть' : 'Серверы', 'btn btn-ghost btn-sm');
          toggleNodes.setAttribute('aria-expanded', String(open));
          toggleNodes.setAttribute('aria-label', `${open ? 'Скрыть серверы' : 'Показать серверы'}: ${countryTitle(group.code)}`);
          toggleNodes.dataset.focusKey = `expand-${key}`;
          toggleNodes.addEventListener('click', () => {
            if (expanded.has(key)) expanded.delete(key); else expanded.add(key);
            paintCountries();
          });
          top.append(box, label, el('span', 'bd-country-meta', meta), toggleNodes);
          item.append(top);
          if (tick.state === 'country' && group.code) {
            item.append(el('p', 'bd-country-note', 'Вся страна: новые серверы провайдера добавятся сами.'));
          }
          if (open) {
            const nodeList = el('ul', 'bd-nodes');
            nodeList.setAttribute('aria-label', `Серверы: ${countryTitle(group.code)}`);
            for (const entry of group.entries) {
              if (byEntries && needle && !entry.original_name.toLocaleLowerCase('ru-RU').includes(needle)) continue;
              const row = el('li', 'bd-node');
              const nodeBox = el('input');
              nodeBox.type = 'checkbox';
              nodeBox.id = `bd-n-${sourceId}-${entry.id}`;
              nodeBox.checked = nodeTicked(draft.rules, sourceId, group, entry);
              nodeBox.disabled = saving;
              nodeBox.dataset.focusKey = `node-${sourceId}-${entry.id}`;
              nodeBox.addEventListener('change', () => { setRules(toggleNode(draft.rules, sourceId, group, entry)); });
              const nodeLabel = el('label', 'bd-node-name', entry.original_name || 'Сервер без названия');
              nodeLabel.htmlFor = nodeBox.id;
              row.append(nodeBox, nodeLabel, el('span', 'tag', entry.protocol || '—'));
              nodeList.append(row);
            }
            item.append(nodeList);
          }
          cards.append(item);
        }
        if (shown) block.append(cards);
        else block.append(el('p', 'field-hint', 'По запросу ничего не найдено.'));
        nodes.push(block);
      }
      const focusKey = focusKeyOf(countriesSlot);
      countriesSlot.replaceChildren(...nodes);
      restoreFocus(countriesSlot, focusKey);
    };

    const paintComposition = () => {
      const nodes: HTMLElement[] = [];
      if (draft.sourceIds.length === 0) {
        compositionPanel.body.replaceChildren(el('p', 'field-hint', 'Сначала выберите источник выше.'));
        compositionPanel.meta.textContent = '';
        return;
      }
      const modes = el('div', 'bd-modes');
      modes.setAttribute('role', 'radiogroup');
      modes.setAttribute('aria-label', 'Состав сборки');
      const options = [
        ['all', 'Все серверы', 'Широкая подписка: всё, что есть в источнике. Новые страны и серверы провайдера добавляются сами.'],
        ['selected', 'Выбрать страны и серверы', 'Узкая подписка: только то, что вы отметите.'],
      ] as const;
      for (const [value, title, hint] of options) {
        const row = el('label', draft.mode === value ? 'bd-mode is-on' : 'bd-mode');
        const radio = el('input');
        radio.type = 'radio';
        radio.name = 'bd-mode';
        radio.value = value;
        radio.checked = draft.mode === value;
        radio.disabled = saving;
        radio.dataset.focusKey = `mode-${value}`;
        radio.addEventListener('change', () => {
          if (!radio.checked || draft.mode === value) return;
          if (value === 'all') {
            parkedRules = draft.rules;
            draft = { ...draft, mode: 'all', rules: [] };
          } else {
            draft = { ...draft, mode: 'selected', rules: rulesForSources(parkedRules, draft.sourceIds) };
          }
          errors = { ...errors, composition: undefined };
          changed();
        });
        const text = el('span', 'bd-mode-text');
        text.append(el('span', 'bd-mode-title', title), el('span', 'bd-mode-hint', hint));
        row.append(radio, text);
        modes.append(row);
      }
      nodes.push(modes);
      if (errors.composition) nodes.push(el('p', 'field-error', errors.composition));
      if (disabledRules > 0 && base === loaded) {
        nodes.push(el('p', 'field-hint',
          `В сборке есть выключенные правила (${count(disabledRules)}): они не отмечены и при сохранении будут удалены.`));
      }
      if (draft.mode === 'selected') {
        const box = el('div', 'search bd-search');
        box.append(host.icon('search'), search);
        nodes.push(box, countriesSlot);
      }
      const focusKey = focusKeyOf(compositionPanel.body);
      const keepSearch = document.activeElement === search;
      compositionPanel.body.replaceChildren(...nodes);
      if (draft.mode === 'selected') paintCountries();
      else for (const id of draft.sourceIds) ensureEntries(id);
      if (keepSearch) search.focus();
      else restoreFocus(compositionPanel.body, focusKey);
      compositionPanel.meta.textContent = resolutionSummary(resolution());
    };

    const paintOrder = () => {
      const visible = draft.mode === 'selected' && draft.rules.length > 0;
      orderPanel.root.hidden = !visible;
      if (!visible) return;
      const states = resolution().rules;
      const list = el('ol', 'bd-rules');
      list.setAttribute('aria-label', 'Порядок в подписке');
      draft.rules.forEach((rule, index) => {
        const state = states[index];
        const item = el('li', state?.problem ? 'bd-rule is-problem' : 'bd-rule');
        const pos = el('span', 'bd-rule-pos', String(index + 1));
        pos.setAttribute('aria-hidden', 'true');
        const info = el('div', 'bd-rule-info');
        const title = el('span', 'bd-rule-title');
        if (rule.kind === 'country') title.append(codeChip(rule.countryCode));
        title.append(el('span', '', rule.kind === 'country' ? countryTitle(rule.countryCode) : rule.originalName || 'Сервер'));
        const metaParts = [rule.kind === 'country' ? 'вся страна' : 'сервер'];
        if (draft.sourceIds.length > 1) metaParts.push(sourceName(rule.sourceId));
        if (state && !state.problem) metaParts.push(serversLabel(state.servers));
        info.append(title, el('span', 'bd-rule-meta', metaParts.join(' · ')));
        if (state?.problem) info.append(el('span', 'bd-rule-problem', ruleProblemText(state.problem)));
        const rename = textInput(`bd-rename-${index}`, BUILD_LIMITS.customName);
        rename.value = rule.customName;
        rename.placeholder = rule.kind === 'country' ? 'Своё название для всех серверов страны' : 'Своё название сервера';
        rename.setAttribute('aria-label', `Своё название: ${ruleTitle({ ...rule, customName: '' })}`);
        rename.disabled = saving;
        rename.dataset.focusKey = `rename-${index}`;
        rename.addEventListener('input', () => {
          draft = { ...draft, rules: renameRule(draft.rules, index, rename.value) };
          paintPreview();
          paintActions();
        });
        const tools = el('div', 'bd-rule-tools');
        const up = this.iconBtn('up', `Выше: ${ruleTitle(rule)}`);
        up.disabled = saving || index === 0;
        up.dataset.focusKey = `up-${index}`;
        up.addEventListener('click', () => { setRules(moveRule(draft.rules, index, -1), `up-${Math.max(0, index - 1)}`); });
        const down = this.iconBtn('chevron', `Ниже: ${ruleTitle(rule)}`);
        down.disabled = saving || index === draft.rules.length - 1;
        down.dataset.focusKey = `down-${index}`;
        down.addEventListener('click', () => { setRules(moveRule(draft.rules, index, 1), `down-${Math.min(draft.rules.length - 1, index + 1)}`); });
        const drop = this.iconBtn('close', `Убрать из сборки: ${ruleTitle(rule)}`);
        drop.disabled = saving;
        drop.dataset.focusKey = `drop-${index}`;
        drop.addEventListener('click', () => { setRules(removeRule(draft.rules, index)); });
        tools.append(up, down, drop);
        item.append(pos, info, rename, tools);
        list.append(item);
      });
      const focusKey = focusKeyOf(orderPanel.body);
      orderPanel.body.replaceChildren(list);
      restoreFocus(orderPanel.body, focusKey);
      orderPanel.meta.textContent = `${count(draft.rules.length)} ${pluralRu(draft.rules.length, 'позиция', 'позиции', 'позиций')}`;
    };

    const paintPrices = () => {
      const nodes: HTMLElement[] = [];
      const existing = base ? buildTariffs(store.tariffs ?? [], base.id) : [];
      if (existing.length) {
        const list = el('ul', 'bd-prices');
        list.setAttribute('aria-label', 'Цены сборки');
        for (const tariff of existing) {
          const row = el('li', 'bd-price');
          const info = el('div', 'bd-price-info');
          info.append(el('span', 'bd-price-name', tariff.name), el('span', 'bd-price-terms', priceLabel(tariff)));
          const edit = this.link('Изменить', `#/tariffs/${tariff.id}`, 'btn btn-secondary btn-sm');
          edit.setAttribute('aria-label', `Изменить тариф «${tariff.name}»`);
          row.append(info, el('span', tariff.is_active ? 'tag tag-on' : 'tag', tariff.is_active ? 'В продаже' : 'Скрыт'), edit);
          list.append(row);
        }
        nodes.push(list);
      } else if (!prices.length) {
        const system = systemUses(base?.dependents);
        nodes.push(el('p', 'field-hint', system.length
          ? `Сборка используется как «${system.join('», «')}». Добавьте цену, если хотите ещё и продавать её.`
          : 'Цены пока нет: клиент не сможет купить эту сборку. Добавьте хотя бы одну.'));
      }
      if (prices.length) {
        const list = el('ul', 'bd-price-rows');
        list.setAttribute('aria-label', 'Новые цены');
        prices.forEach((row, index) => {
          const rowErrors = priceErrors[index] ?? {};
          const item = el('li', 'bd-price-row');
          const mk = (key: 'name' | 'days' | 'price', label: string, mode: 'text' | 'numeric' | 'decimal', max: number, placeholder: string) => {
            const input = textInput(`bd-price-${key}-${index}`, max, mode);
            input.value = row[key];
            input.placeholder = placeholder;
            input.disabled = saving;
            input.dataset.focusKey = `price-${key}-${index}`;
            const f = field(label, input);
            f.setError(rowErrors[key] ?? '');
            input.addEventListener('input', () => {
              prices = prices.map((r, i) => (i === index ? { ...r, [key]: input.value } : r));
              priceErrors = priceErrors.map((e, i) => (i === index ? { ...e, [key]: undefined } : e));
              f.setError('');
              paintActions();
            });
            return f.root;
          };
          const drop = this.iconBtn('close', 'Убрать эту цену');
          drop.disabled = saving;
          drop.dataset.focusKey = `price-drop-${index}`;
          drop.addEventListener('click', () => {
            prices = prices.filter((_, i) => i !== index);
            priceErrors = priceErrors.filter((_, i) => i !== index);
            paintPrices();
            paintActions();
          });
          item.append(mk('name', 'Название тарифа', 'text', 64, '1 месяц'), mk('days', 'Срок, дней', 'numeric', 4, '30'),
            mk('price', 'Цена, ₽', 'decimal', 12, '199'), drop);
          list.append(item);
        });
        nodes.push(list);
      }
      if (priceFailure) nodes.push(this.notice('error', priceFailure));
      const presets = el('div', 'chips');
      presets.setAttribute('role', 'group');
      presets.setAttribute('aria-label', 'Добавить цену');
      const addRow = (row: PriceRow) => {
        prices = [...prices, row];
        priceErrors = [...priceErrors, {}];
        paintPrices();
        paintActions();
        pricePanel.body.querySelector<HTMLElement>(`[data-focus-key='price-${row.days ? 'price' : 'name'}-${prices.length - 1}']`)?.focus();
      };
      for (const preset of PRICE_PRESETS) {
        const chip = this.btn(`+ ${preset.label}`, 'chip');
        chip.disabled = saving;
        chip.dataset.focusKey = `preset-${preset.days}`;
        chip.addEventListener('click', () => addRow({ name: preset.name, days: String(preset.days), price: '' }));
        presets.append(chip);
      }
      const custom = this.btn('+ Другой срок', 'chip');
      custom.disabled = saving;
      custom.dataset.focusKey = 'preset-custom';
      custom.addEventListener('click', () => addRow(EMPTY_PRICE));
      presets.append(custom);
      nodes.push(presets, el('p', 'field-hint',
        'Цена в рублях продаётся через бота; 0 — бесплатный тариф. Описание, бейдж и оплату Telegram Stars можно настроить в разделе «Тарифы».'));
      const focusKey = focusKeyOf(pricePanel.body);
      pricePanel.body.replaceChildren(...nodes);
      restoreFocus(pricePanel.body, focusKey);
      const onSale = existing.filter(t => t.is_active).length;
      pricePanel.meta.textContent = existing.length ? `в продаже ${count(onSale)} из ${count(existing.length)}` : '';
    };

    const paintPreview = () => {
      const r = resolution();
      const nodes: HTMLElement[] = [];
      const loadingSources = draft.sourceIds.filter(id => !entries.has(id) && entryState.get(id) !== 'error');
      const headline = el('p', 'bd-preview-total', draft.sourceIds.length === 0 ? 'Источник не выбран'
        : loadingSources.length ? 'Считаем серверы…' : resolutionSummary(r));
      nodes.push(headline);
      const titleText = draft.profileTitle.trim();
      nodes.push(el('p', 'bd-preview-title', titleText ? `«${titleText}»` : 'Название в приложении — как у провайдера'));
      const failedSources = draft.sourceIds.filter(id => entryState.get(id) === 'error');
      if (failedSources.length) {
        const retry = this.btn('Повторить', 'btn btn-secondary btn-sm', 'refresh');
        retry.addEventListener('click', () => {
          for (const id of failedSources) entryState.delete(id);
          changed();
        });
        nodes.push(this.notice('error', `Не удалось загрузить серверы: ${failedSources.map(sourceName).join(', ')}.`, [retry]));
      }
      if (r.servers.length === 0 && draft.sourceIds.length > 0 && !loadingSources.length && !failedSources.length) {
        nodes.push(this.notice('warn', draft.mode === 'selected' && draft.rules.length === 0
          ? 'Ничего не отмечено: клиент получит пустую подписку.'
          : 'По выбранному сейчас нет ни одного сервера: клиент получит пустую подписку.'));
      }
      const chips = countryChips(r.countries, 30);
      if (chips.shown.length) {
        const row = el('ul', 'bd-codes');
        row.setAttribute('aria-label', 'Страны в подписке');
        for (const code of chips.shown) {
          const li = el('li');
          li.append(codeChip(code));
          row.append(li);
        }
        if (chips.more) row.append(el('li', 'bd-more', `+${count(chips.more)}`));
        nodes.push(row);
      }
      if (r.servers.length) {
        const list = el('ol', 'bd-preview-list');
        list.setAttribute('aria-label', 'Серверы в подписке');
        for (const server of r.servers.slice(0, PREVIEW_LIMIT)) {
          const li = el('li', 'bd-preview-item');
          li.append(codeChip(server.country), el('span', 'bd-preview-name', server.name || 'Сервер без названия'));
          if (server.name !== server.original) li.title = `У провайдера: ${server.original}`;
          list.append(li);
        }
        nodes.push(list);
        if (r.servers.length > PREVIEW_LIMIT) nodes.push(el('p', 'field-hint', `и ещё ${serversLabel(r.servers.length - PREVIEW_LIMIT)}`));
      }
      previewPanel.body.replaceChildren(...nodes);
      previewPanel.meta.textContent = isNew() ? 'черновик' : dirty() ? 'по текущим правкам' : 'как сохранено';
    };

    const paintCheck = () => {
      checkPanel.root.hidden = isNew();
      if (!base) return;
      const target = base;
      const nodes: HTMLElement[] = [];
      const run = this.btn(serverPreview.state === 'loading' ? 'Проверяем…' : 'Проверить на сервере', 'btn btn-secondary btn-sm', 'eye');
      run.disabled = serverPreview.state === 'loading' || dirty() || saving;
      run.addEventListener('click', () => {
        serverPreview = { state: 'loading' };
        paintCheck();
        void api.previewBuilder(target.id).then(data => {
          if (!current()) return;
          host.sessionUsed();
          serverPreview = { state: 'done', data };
          paintCheck();
        }).catch(async (error: unknown) => {
          if (!current()) return;
          if (await host.signedOut(error, current)) return;
          serverPreview = { state: 'error', error: errorText(error) };
          paintCheck();
        });
      });
      nodes.push(el('p', 'field-hint', dirty()
        ? 'Сохраните изменения: сервер проверяет сохранённую сборку — ровно то, что получают клиенты.'
        : 'Сервер соберёт подписку так же, как для клиента, и покажет результат.'));
      if (serverPreview.state === 'error') nodes.push(this.notice('error', `Проверка не удалась. ${serverPreview.error ?? ''}`));
      if (serverPreview.state === 'done' && serverPreview.data) {
        const data = serverPreview.data;
        const sum = previewSummary(data);
        const parts = [`${serversLabel(sum.servers)} · ${count(sum.countries)} ${pluralRu(sum.countries, 'страна', 'страны', 'стран')}`];
        if (data.missing > 0) parts.push(`не найдено: ${count(data.missing)}`);
        if (data.conflicts > 0) parts.push(`неоднозначно: ${count(data.conflicts)}`);
        const ok = sum.servers > 0 && data.missing === 0 && data.conflicts === 0;
        nodes.push(this.notice(sum.servers === 0 ? 'error' : ok ? 'success' : 'warn',
          sum.servers === 0 ? 'Сервер не собрал ни одного сервера: клиенты получат ошибку.' : `Клиент получит: ${parts.join(' · ')}.`));
        if (data.warnings?.length) {
          const list = el('ul', 'bd-warnings');
          for (const warning of data.warnings) list.append(el('li', '', warning));
          nodes.push(list);
        }
      }
      nodes.push(run);
      checkPanel.body.replaceChildren(...nodes);
    };

    const paintState = () => {
      statePanel.root.hidden = isNew();
      if (!base) return;
      const target = base;
      const health = buildHealth(this.monitor?.builders.find(m => m.id === target.id), target.enabled);
      const healthRow = el('p', 'bd-card-health');
      healthRow.append(dot(health.tone), el('span', '', health.text));
      const clients = target.sales?.clients ?? 0;
      const facts = el('p', 'bd-state-facts', clients ? `Сейчас получают: ${clientsLabel(clients)}` : 'Клиентов на этой сборке пока нет');
      const tools = el('div', 'bd-state-tools');
      const monitor = this.link('Мониторинг серверов', `#/monitoring/${target.id}`, 'btn btn-secondary btn-sm', 'monitoring');
      const copy = this.btn('Дублировать', 'btn btn-secondary btn-sm');
      copy.addEventListener('click', () => {
        if (dirty() && !window.confirm('Есть несохранённые изменения. Открыть копию без сохранения?')) return;
        this.duplicate(target);
      });
      const remove = this.btn('Удалить сборку', 'btn btn-danger btn-sm', 'trash');
      remove.disabled = saving;
      remove.addEventListener('click', () => {
        void this.remove(target, current, remove).then(result => {
          if (!current()) return;
          if (result === 'deleted') {
            store.builders = (store.builders ?? []).filter(x => x.id !== target.id);
            host.navigate(buildsHash({ view: 'list' }));
          } else if (result === 'stale') {
            void this.loadEditor();
          }
        });
      });
      tools.append(monitor, copy, remove);
      statePanel.body.replaceChildren(healthRow, facts, tools);
    };

    const paintHeading = () => {
      const { title, desc } = this.page;
      const shown = base?.name ?? 'Новая сборка';
      title.textContent = shown;
      document.title = `${shown} · DictatorVPN Admin`;
      desc.textContent = base ? `Сборка #${base.id} · ${base.enabled ? 'включена' : 'отключена'}` : NEW_DESC;
    };

    const paintActions = () => {
      const isDirty = dirty();
      dirtyNote.textContent = saving ? 'Сохраняем…' : isDirty ? 'Есть несохранённые изменения' : base ? 'Все изменения сохранены' : '';
      dirtyNote.classList.toggle('is-dirty', isDirty);
      reset.disabled = saving || !isDirty;
      reset.hidden = isNew();
      save.disabled = saving || (!isNew() && !isDirty);
      save.setAttribute('aria-busy', String(saving));
      setLabel(save, saving ? 'Сохраняем…' : isNew() ? 'Создать сборку' : 'Сохранить');
      for (const control of [name, profileTitle, announce, supportUrl, description]) control.readOnly = saving;
      enabled.disabled = saving;
      suggest.disabled = saving;
      paintCheck();
    };

    /** Repaints everything that depends on the draft. */
    const changed = () => {
      applyAutoName();
      paintSources();
      paintComposition();
      paintOrder();
      paintPreview();
      paintActions();
    };

    const setRules = (rules: readonly DraftRule[], focusKey?: string) => {
      draft = { ...draft, rules: [...rules] };
      errors = { ...errors, composition: undefined };
      applyAutoName();
      paintComposition();
      paintOrder();
      paintPreview();
      paintActions();
      if (focusKey) restoreFocus(orderPanel.body, focusKey);
    };

    const showErrors = (next: DraftErrors) => {
      errors = next;
      for (const key of Object.keys(fieldSetters) as DraftField[]) fieldSetters[key](next[key] ?? '');
      paintSources();
      paintComposition();
      const order: DraftField[] = ['sources', 'composition', 'name', 'profileTitle', 'announce', 'supportUrl', 'description'];
      const first = order.find(key => next[key]);
      if (!first) return;
      if (first !== 'sources' && first !== 'composition' && first !== 'name') more.open = true;
      const target = fieldTargets[first];
      if (!target) return;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) target.focus();
      else target.scrollIntoView({ block: 'center' });
    };

    // Save ---------------------------------------------------------------------
    let createKey = '';
    let configKey: { payload: string; key: string } | null = null;

    const submit = async () => {
      if (saving) return;
      const next = validateDraft(draft);
      const typedName = draft.name.trim().toLocaleLowerCase('ru-RU');
      if (!next.name && takenNames().includes(typedName)) next.name = 'Сборка с таким названием уже есть.';
      const rows = prices.map((row, index) => ({ row, index })).filter(({ row }) => !isBlankPrice(row));
      const checked = rows.map(({ row }) => validatePrice(row));
      const badPrice = checked.findIndex(result => result.input === null);
      priceErrors = prices.map((_, index) => {
        const at = rows.findIndex(item => item.index === index);
        return at >= 0 ? checked[at].errors : {};
      });
      priceFailure = '';
      if (Object.keys(next).length > 0 || badPrice >= 0) {
        showErrors(next);
        paintPrices();
        showStatus(this.notice('error', 'Проверьте выделенные поля.'), Object.keys(next).length === 0);
        if (Object.keys(next).length === 0 && badPrice >= 0) {
          pricePanel.body.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
        }
        return;
      }
      showErrors({});
      const submitted = draft;
      const meta = {
        name: submitted.name.trim(), description: submitted.description.trim(), enabled: submitted.enabled,
        profile_title: submitted.profileTitle.trim(), support_url: submitted.supportUrl.trim(), announce: submitted.announce.trim(),
      };
      const creating = base === null;
      saving = true;
      showStatus(null);
      changed();
      paintPrices();
      try {
        let target = base;
        if (!target) {
          // The row is created once: a retry after a failed configuration save
          // updates it instead of creating a second сборка.
          createKey ||= newRequestKey();
          target = (await api.createBuilder({ request_key: createKey, ...meta })).builder;
          base = target;
        }
        // Metadata, sources and rules in ONE transaction with the loaded
        // version: a сборка changed elsewhere is refused, never overwritten.
        const payload = JSON.stringify([target.id, target.version, meta, submitted.sourceIds, configItems(submitted)]);
        if (!configKey || configKey.payload !== payload) configKey = { payload, key: newRequestKey() };
        const saved = (await api.saveBuilderConfiguration(target.id, {
          request_key: configKey.key, version: target.version, ...meta,
          source_ids: submitted.sourceIds, items: configItems(submitted),
        })).builder;
        configKey = null;
        host.sessionUsed();
        base = { ...saved, sales: saved.sales ?? target.sales, dependents: saved.dependents ?? target.dependents };
        const others = (store.builders ?? []).filter(b => b.id !== saved.id);
        store.builders = [...others, base].sort((a, b) => a.id - b.id);

        // Prices: every new row becomes a tariff of the сборка. A failure keeps
        // the rows that were not created; the сборка itself is already saved.
        const created: number[] = [];
        let failure: unknown = null;
        for (let i = 0; i < rows.length; i++) {
          const input = checked[i].input;
          if (!input) continue;
          try {
            const outcome = await api.createTariff({
              name: input.name, builder_id: saved.id, duration_days: input.duration_days, price_cents: input.price_cents,
              currency: 'RUB', description: '', features: [], badge: '', is_active: true, sort_order: null,
            }, newRequestKey());
            if (outcome.tariff) store.tariffs = [...(store.tariffs ?? []).filter(t => t.id !== outcome.tariff?.id), outcome.tariff];
            created.push(rows[i].index);
          } catch (error) {
            failure = error;
            break;
          }
        }
        if (!current()) return;
        prices = prices.filter((row, index) => !created.includes(index) && !isBlankPrice(row));
        priceErrors = prices.map(() => ({}));
        saving = false;
        if (failure) {
          if (await host.signedOut(failure, current)) return;
          priceFailure = `Сборка сохранена, но цена не добавлена. ${buildErrorText(failure)} Исправьте и сохраните ещё раз.`;
        }
        const fresh = this.route.view === 'new';
        const text = fresh
          ? `Сборка «${saved.name}» создана${created.length ? ` и выставлена на продажу: ${count(created.length)} ${pluralRu(created.length, 'цена', 'цены', 'цен')}` : '. Цена не задана — добавьте её, чтобы сборку можно было купить'}.`
          : `Сборка сохранена${created.length ? `, добавлено цен: ${count(created.length)}` : ''}. Клиенты получат изменения при следующем обновлении подписки.`;
        if (fresh && !failure) {
          // Reopen under the address of the created сборка; the notice survives.
          memory.notice = { id: saved.id, text };
          host.navigate(buildsHash({ view: 'edit', id: saved.id }));
          return;
        }
        // The form is read-only while a save is in flight: the stored
        // configuration is exactly what was submitted.
        baseline = draftFromBuilder(base);
        draft = baseline;
        parkedRules = draft.mode === 'all' ? parkedRules : draft.rules;
        autoName = false;
        serverPreview = { state: 'idle' };
        writeFields();
        paintHeading();
        changed();
        paintPrices();
        paintState();
        showStatus(failure ? null : this.notice('success', text));
      } catch (error) {
        saving = false;
        if (!current()) return;
        if (await host.signedOut(error, current)) return;
        const code = error instanceof ApiError ? error.code : '';
        const prefix = creating && base === null ? 'Сборка не создана.' : 'Изменения не сохранены.';
        paintHeading();
        changed();
        paintPrices();
        paintState();
        if (code === 'name_taken') {
          showErrors({ name: 'Сборка с таким названием уже есть.' });
          showStatus(this.notice('error', `${prefix} Сборка с таким названием уже есть.`), false);
        } else if (code === 'version_conflict') {
          const reload = this.btn('Загрузить актуальную версию', 'btn btn-secondary btn-sm', 'refresh');
          reload.addEventListener('click', () => {
            if (!window.confirm('Ваши несохранённые изменения будут потеряны. Загрузить актуальную версию?')) return;
            host.setUnsaved(null);
            void this.loadEditor();
          });
          showStatus(this.notice('error', `${prefix} Сборку изменили в другом окне или другим администратором. Сохранённая версия не затронута.`, [reload]));
        } else if (error instanceof ApiError && code === 'invalid_request' && error.field) {
          const key = BUILD_SERVER_FIELDS[error.field];
          const text = error.field === 'items' ? ITEMS_REASONS[error.reason] ?? 'Сервер отклонил состав сборки.'
            : error.field === 'source_ids' ? 'Один из источников удалён. Обновите страницу и выберите источник заново.'
              : 'Сервер отклонил это значение.';
          if (key) showErrors({ [key]: text });
          showStatus(this.notice('error', `${prefix} ${text}`), !key);
        } else {
          showStatus(this.notice('error', `${prefix} ${buildErrorText(error)}`));
        }
      }
    };

    // Wiring -------------------------------------------------------------------
    const readFields = () => {
      draft = {
        ...draft, name: name.value, profileTitle: profileTitle.value, announce: announce.value,
        supportUrl: supportUrl.value, description: description.value, enabled: enabled.checked,
      };
    };
    const onField = (key: DraftField) => () => {
      readFields();
      fieldSetters[key]('');
      paintPreview();
      paintActions();
    };
    name.addEventListener('input', () => { autoName = false; onField('name')(); });
    profileTitle.addEventListener('input', onField('profileTitle'));
    announce.addEventListener('input', onField('announce'));
    supportUrl.addEventListener('input', onField('supportUrl'));
    description.addEventListener('input', onField('description'));
    enabled.addEventListener('change', () => { readFields(); paintActions(); });
    suggest.addEventListener('click', () => {
      const next = suggestName(resolution(), draft.mode, draft.sourceIds.map(sourceName));
      if (!next) { host.toast('Сначала отметьте страны или серверы.'); return; }
      draft = { ...draft, name: next };
      name.value = next;
      nameField.setError('');
      paintActions();
      name.focus();
    });
    reset.addEventListener('click', () => {
      draft = baseline;
      parkedRules = draft.mode === 'all' ? [] : draft.rules;
      prices = [];
      priceErrors = [];
      priceFailure = '';
      errors = {};
      for (const key of Object.keys(fieldSetters) as DraftField[]) fieldSetters[key]('');
      showStatus(null);
      writeFields();
      changed();
      paintPrices();
      name.focus();
    });
    form.addEventListener('submit', event => {
      event.preventDefault();
      void submit();
    });

    writeFields();
    paintHeading();
    changed();
    paintPrices();
    paintState();
    const shown = memory.notice;
    if (shown && base && shown.id === base.id) {
      memory.notice = null;
      showStatus(this.notice('success', shown.text), false);
    }
  }

  private iconBtn(name: BuildsIcon, label: string): HTMLButtonElement {
    const node = el('button', 'icon-button');
    node.type = 'button';
    node.setAttribute('aria-label', label);
    node.title = label;
    node.append(this.host.icon(name));
    return node;
  }
}
