// Promo codes (Admin → «Промокоды») and operational events (Admin → «События»:
// the event feed, the daily report and the Telegram notification settings).
//
// The screens are plain DOM over OpsApi (admin/src/ops.ts). Every rule stays on
// the server: a code's state, the limit guard, which events exist and what the
// report counts. Text is always assigned as text; the Telegram HTML of a report
// is shown as plain text (telegramPlainText), never as markup.
//
// The host (AdminApp in main.ts) owns routing, the session, the confirmation
// dialog and the unsaved-changes guard; a screen is created per route and
// disposed when the route changes, which drops every response still in flight.

import { ApiError } from './api';
import {
  EMPTY_EVENTS_QUERY, EVENTS_TABS, EVENTS_TAB_LABELS, EVENT_KIND_GROUPS, NEW_PROMO_FORM, NOTIFY_LABELS, OPS_SEVERITIES,
  PERCENT_PRESETS, PROMO_FIELD_TEXT, PROMO_SERVER_FIELDS, PROMO_STATE_BADGES, PROMO_STATE_LABELS, SEVERITY_LABELS,
  SEVERITY_TONES, VALID_HOURS_PRESETS, activationsShare, activationsText, conversionText, discountedCents, eventsHash,
  formFromPromo, groupByDay, kindLabel, kindSubject, opsErrorText, opsForm, opsSave, promoPatch,
  promoTotals, reportDayText, reportFigures, sameOpsForm, suggestPromoCode, telegramPlainText, validHoursText, validatePromoForm,
  type EventsTab, type OpsApi, type OpsEvent, type OpsEventsPage, type OpsEventsQuery, type OpsField, type OpsForm,
  type OpsReport, type OpsRoute, type OpsSettings, type PromoCode, type PromoField, type PromoForm, type PromoPatch,
  type ReportDay, type ReportFigure,
} from './ops';
import { RequestKeys, isUncertain } from './warmup';

// =============================================================================
// Host contract
// =============================================================================

/** Icons the screens use (a subset of the admin icon set). */
export type OpsIcon = 'plus' | 'refresh' | 'edit' | 'trash' | 'alert' | 'info' | 'check' | 'prev' | 'next';

export interface OpsHost {
  readonly api: OpsApi;
  icon(name: OpsIcon): Element;
  toast(text: string): void;
  /** A modal yes/no question; false when dismissed. */
  confirm(title: string, text: string, confirmLabel: string): Promise<boolean>;
  /** Reports unsaved changes of the open screen to the navigation guard (null: none). */
  setUnsaved(check: (() => boolean) | null): void;
  /** true when the error ended the session and the host left the screen. */
  signedOut(error: unknown, current: () => boolean): Promise<boolean>;
  /** A protected request just succeeded (the session is alive). */
  sessionUsed(): void;
}

export interface OpsPage {
  readonly header: HTMLElement;
  readonly title: HTMLElement;
  readonly desc: HTMLElement;
}

// What survives navigation within the signed-in session (never the URL or
// storage): the feed filters and the chosen report day.
interface Memory {
  events: OpsEventsQuery;
  reportDay: ReportDay;
}

const memory: Memory = { events: EMPTY_EVENTS_QUERY, reportDay: 'today' };

/** Forgets the session memory (sign-out, tests). */
export function resetOpsMemory() {
  memory.events = EMPTY_EVENTS_QUERY;
  memory.reportDay = 'today';
}

// =============================================================================
// DOM helpers (text is always assigned as text)
// =============================================================================

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function textInput(id: string, mode: 'text' | 'numeric' = 'text'): HTMLInputElement {
  const node = el('input', 'input');
  node.id = id;
  node.type = 'text';
  node.autocomplete = 'off';
  node.spellcheck = false;
  node.inputMode = mode;
  return node;
}

function checkbox(id: string, label: string): { root: HTMLLabelElement; input: HTMLInputElement } {
  const input = el('input');
  input.type = 'checkbox';
  input.id = id;
  const root = el('label', 'toggle');
  root.htmlFor = id;
  root.append(input, el('span', '', label));
  return { root, input };
}

interface Field {
  readonly root: HTMLElement;
  readonly hint: HTMLElement;
  setError(text: string): void;
}

/** Label, control (with an optional unit after it), hint and error. */
function field(label: string, control: HTMLInputElement | HTMLSelectElement, hint = '', suffix = ''): Field {
  const root = el('div', 'field');
  const caption = el('label', 'field-label', label);
  caption.htmlFor = control.id;
  const box = el('div', suffix ? 'control wu-suffixed' : 'control');
  box.append(control);
  if (suffix) box.append(el('span', 'wu-suffix', suffix));
  const hintNode = el('p', 'field-hint', hint);
  hintNode.id = `${control.id}-hint`;
  control.setAttribute('aria-describedby', hintNode.id);
  const error = el('p', 'field-error');
  error.id = `${control.id}-error`;
  error.setAttribute('aria-live', 'polite');
  root.append(caption, box, hintNode, error);
  return {
    root, hint: hintNode,
    setError(text: string) {
      error.textContent = text;
      if (text) control.setAttribute('aria-invalid', 'true');
      else control.removeAttribute('aria-invalid');
    },
  };
}

function row(...nodes: HTMLElement[]): HTMLElement {
  const node = el('div', 'form-row');
  node.append(...nodes);
  return node;
}

/** A decorative dot of a health tone; the text next to it carries the meaning. */
function dot(tone: string): HTMLElement {
  const node = el('span', `health-dot is-${tone}`);
  node.setAttribute('aria-hidden', 'true');
  return node;
}

function head(columns: readonly string[]): HTMLTableSectionElement {
  const thead = el('thead');
  const tr = el('tr');
  for (const text of columns) {
    const th = el('th', '', text);
    th.scope = 'col';
    tr.append(th);
  }
  thead.append(tr);
  return thead;
}

/** A cell that carries its column name for the stacked narrow layout. */
function cell(label: string, content: string | Node, className = ''): HTMLTableCellElement {
  const td = el('td', className);
  td.dataset.label = label;
  td.append(content);
  return td;
}

const numberFormat = new Intl.NumberFormat('ru-RU');
const count = (n: number) => numberFormat.format(n);
const dateTimeFormat = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const timeFormat = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });
const formatDateTime = (iso: string) => dateTimeFormat.format(new Date(iso));

/** "199 ₽" / "159,20 ₽" for the price example of the promo editor. */
function rubles(cents: number): string {
  return `${new Intl.NumberFormat('ru-RU', { minimumFractionDigits: cents % 100 === 0 ? 0 : 2, maximumFractionDigits: 2 }).format(cents / 100)} ₽`;
}

type Tone = 'error' | 'info' | 'success' | 'warn';
interface Notice { tone: Tone; text: string; actions?: HTMLElement[] }

const isCode = (error: unknown, code: string) => error instanceof ApiError && error.code === code;

/** The hint after an uncertain failure: a retry is a replay, never a duplicate. */
const uncertainText = (error: unknown) => (isUncertain(error) ? ' Повторите действие: запрос уйдёт с тем же ключом, дубля не будет.' : '');

/** The tariff price used in the editor's example (199 ₽). */
const EXAMPLE_PRICE_CENTS = 19_900;

const EVENT_SUBJECT_LABELS: Readonly<Record<ReturnType<typeof kindSubject>, string>> = {
  server: 'Сервер', country: 'Страна', builder: 'Сборка', source: 'Источник', monitor: 'Мониторинг', report: 'Отчёт',
};

// =============================================================================
// Screen
// =============================================================================

export class OpsScreen {
  readonly body = el('div', 'ops');
  #live = true;
  #request = 0;
  readonly #keys = new RequestKeys();
  // Promo list of the open screen and whether its editor is open.
  #promos: PromoCode[] = [];
  #editorOpen = false;

  constructor(private readonly host: OpsHost, private readonly route: OpsRoute, private readonly page: OpsPage) {}

  /** The route changed: drop every response still in flight. */
  dispose() {
    this.#live = false;
    this.#request++;
  }

  load(): Promise<void> {
    if (this.route.view === 'promos') return this.#loadPromos();
    switch (this.route.tab) {
      case 'feed': return this.#loadEvents(null);
      case 'report': return this.#loadReport();
      case 'telegram': return this.#loadSettings();
    }
  }

  // Shared ------------------------------------------------------------------

  /** Starts a request of this screen; the returned check is false once it is stale. */
  #begin(): () => boolean {
    const request = ++this.#request;
    return () => this.#live && request === this.#request;
  }

  #button(label: string, className: string, leading?: OpsIcon): HTMLButtonElement {
    const node = el('button', className);
    node.type = 'button';
    if (leading) node.append(this.host.icon(leading));
    node.append(el('span', 'btn-label', label));
    return node;
  }

  #notice(next: Notice): HTMLElement {
    const node = el('div', `notice notice-${next.tone}`);
    node.setAttribute('role', next.tone === 'error' ? 'alert' : 'status');
    node.append(this.host.icon(next.tone === 'error' || next.tone === 'warn' ? 'alert' : next.tone === 'success' ? 'check' : 'info'));
    const content = el('div', 'notice-body');
    content.append(el('p', '', next.text));
    if (next.actions?.length) {
      const actions = el('div', 'notice-actions');
      actions.append(...next.actions);
      content.append(actions);
    }
    node.append(content);
    return node;
  }

  /** The tab bar of the events section. */
  #tabs(active: EventsTab): HTMLElement {
    const nav = el('nav', 'wu-tabs');
    nav.setAttribute('aria-label', 'Разделы событий');
    for (const tab of EVENTS_TABS) {
      const link = el('a', 'wu-tab', EVENTS_TAB_LABELS[tab]);
      link.href = eventsHash(tab);
      if (tab === active) link.setAttribute('aria-current', 'page');
      nav.append(link);
    }
    return nav;
  }

  #headerActions(...nodes: HTMLElement[]) {
    const actions = el('div', 'page-actions');
    actions.append(...nodes);
    this.page.header.classList.add('has-actions');
    this.page.header.append(actions);
  }

  #skeleton(label: string, panels: number): HTMLElement[] {
    this.body.setAttribute('aria-busy', 'true');
    this.body.setAttribute('aria-label', label);
    const nodes: HTMLElement[] = [];
    for (let i = 0; i < panels; i++) {
      const panel = el('div', 'panel wu-skeleton');
      const lines = el('div', 'skeleton-rows');
      for (let j = 0; j < 4; j++) lines.append(el('span', 'skeleton skeleton-row'));
      panel.append(lines);
      nodes.push(panel);
    }
    return nodes;
  }

  #ready() {
    this.body.removeAttribute('aria-busy');
    this.body.removeAttribute('aria-label');
  }

  #errorPanel(title: string, error: unknown, retry: () => void): HTMLElement {
    const panel = el('section', 'panel empty');
    panel.setAttribute('role', 'alert');
    const again = this.#button('Повторить', 'btn btn-secondary btn-sm', 'refresh');
    again.addEventListener('click', retry);
    panel.append(this.host.icon('alert'), el('h2', 'empty-title', title), el('p', 'empty-text', opsErrorText(error)), again);
    return panel;
  }

  #emptyPanel(title: string, text: string, action?: HTMLElement): HTMLElement {
    const panel = el('section', 'panel empty');
    panel.setAttribute('role', 'status');
    panel.append(this.host.icon('info'), el('h2', 'empty-title', title), el('p', 'empty-text', text));
    if (action) panel.append(action);
    return panel;
  }

  #panel(id: string, title: string, meta = ''): { root: HTMLElement; body: HTMLElement } {
    const root = el('section', 'panel wu-panel');
    root.setAttribute('aria-labelledby', id);
    const headNode = el('div', 'panel-head');
    const heading = el('h2', 'panel-title', title);
    heading.id = id;
    headNode.append(heading);
    if (meta) headNode.append(el('p', 'panel-meta', meta));
    const body = el('div', 'wu-panel-body');
    root.append(headNode, body);
    return { root, body };
  }

  /** Runs a failed load through the session check; true when nothing more should be painted. */
  async #failed(error: unknown, current: () => boolean): Promise<boolean> {
    if (!current()) return true;
    return this.host.signedOut(error, current);
  }

  #pager(total: number, limit: number, offset: number, shown: number, go: (offset: number, dir: 'prev' | 'next') => void): HTMLElement {
    const foot = el('div', 'pager');
    foot.append(el('p', 'pager-range', shown ? `С ${count(offset + 1)} по ${count(offset + shown)} из ${count(total)}` : `Всего ${count(total)}`));
    const pages = limit > 0 ? Math.ceil(total / limit) : 1;
    if (pages <= 1) return foot;
    const nav = el('nav', 'pager-nav');
    nav.setAttribute('aria-label', 'Страницы списка');
    const prev = this.#button('Предыдущая', 'btn btn-secondary btn-sm', 'prev');
    prev.dataset.pager = 'prev';
    const next = this.#button('Следующая', 'btn btn-secondary btn-sm');
    next.append(this.host.icon('next'));
    next.dataset.pager = 'next';
    prev.disabled = offset === 0;
    next.disabled = offset + limit >= total;
    prev.addEventListener('click', () => go(Math.max(0, offset - limit), 'prev'));
    next.addEventListener('click', () => go(offset + limit, 'next'));
    nav.append(el('p', 'pager-page', `Страница ${count(Math.floor(offset / limit) + 1)} из ${count(pages)}`), prev, next);
    foot.append(nav);
    return foot;
  }

  // ===========================================================================
  // Promo codes (#/promos)
  // ===========================================================================

  async #loadPromos(status?: Notice) {
    const current = this.#begin();
    if (!this.body.childElementCount) {
      const refresh = this.#button('Обновить', 'btn btn-secondary btn-sm', 'refresh');
      refresh.addEventListener('click', () => void this.#refreshPromos());
      const create = this.#button('Новый промокод', 'btn btn-primary btn-sm', 'plus');
      create.id = 'promo-create';
      create.addEventListener('click', () => void this.#openPromoEditor(null));
      this.#headerActions(refresh, create);
      this.body.replaceChildren(...this.#skeleton('Загружаем промокоды', 2));
    } else {
      this.body.querySelector('.ops-results')?.setAttribute('aria-busy', 'true');
    }
    try {
      const list = await this.host.api.promos();
      if (!current()) return;
      this.host.sessionUsed();
      this.#promos = list;
      this.#paintPromos(status ?? null);
    } catch (error) {
      if (await this.#failed(error, current)) return;
      this.#ready();
      this.#closeEditor();
      this.body.replaceChildren(this.#errorPanel('Не удалось загрузить промокоды', error, () => void this.#loadPromos()));
    }
  }

  /** Reloads the list; an open editor with changes is kept until the admin agrees to drop it. */
  async #refreshPromos() {
    if (this.#editorOpen && !(await this.#leaveEditor())) return;
    if (this.#live) void this.#loadPromos();
  }

  #closeEditor() {
    this.#editorOpen = false;
    this.host.setUnsaved(null);
  }

  /** Asks before dropping unsaved editor changes; true when the editor may be closed. */
  async #leaveEditor(): Promise<boolean> {
    const dirty = this.#editorDirty?.() ?? false;
    if (dirty && !(await this.host.confirm('Закрыть без сохранения?', 'Изменения промокода будут потеряны.', 'Закрыть'))) return false;
    if (!this.#live) return false;
    this.#closeEditor();
    this.#editorDirty = null;
    this.body.querySelector('#promo-editor-slot')?.replaceChildren();
    return true;
  }

  #editorDirty: (() => boolean) | null = null;

  #paintPromos(status: Notice | null, focusId = '') {
    this.#ready();
    this.#closeEditor();
    this.#editorDirty = null;
    const list = this.#promos;
    const statusSlot = el('div', 'editor-status');
    statusSlot.id = 'promo-status';
    if (status) statusSlot.append(this.#notice(status));

    const totals = promoTotals(list);
    const kpis: readonly (readonly [string, string, string])[] = [
      ['Всего кодов', count(totals.total), list.length ? `действуют: ${count(totals.active)}` : 'ещё не создано'],
      ['Действуют', count(totals.active), 'можно активировать сейчас'],
      ['Активаций', count(totals.activations), 'клиенты ввели код'],
      ['Оплат со скидкой', count(totals.redeemed), `конверсия ${conversionText(totals.activations, totals.redeemed)}`],
    ];
    const grid = el('dl', 'wu-kpis ops-kpis');
    grid.setAttribute('aria-label', 'Сводка промокодов');
    for (const [label, value, meta] of kpis) {
      const item = el('div', 'kpi wu-kpi');
      item.append(el('dt', 'kpi-label', label), el('dd', 'kpi-value', value), el('p', 'kpi-meta', meta));
      grid.append(item);
    }

    const how = this.#notice({
      tone: 'info',
      text: 'Клиент активирует код в боте: кнопка «🎟 Промокод» рядом с «Купить Premium» или команда /promo КОД. ' +
        'Скидка действует на следующую оплату и сразу видна в ценах тарифов; скидка 100 % выдаёт тариф без оплаты.',
    });

    const editorSlot = el('div', 'ops-editor-slot');
    editorSlot.id = 'promo-editor-slot';
    const results = el('div', 'ops-results');
    if (!list.length) {
      const create = this.#button('Создать промокод', 'btn btn-primary btn-sm', 'plus');
      create.addEventListener('click', () => void this.#openPromoEditor(null));
      results.append(this.#emptyPanel('Промокодов пока нет',
        'Создайте код со скидкой и отправьте его клиентам: в канале, рассылке или лично. Сколько раз код ввели и сколько оплат он принёс, будет видно здесь.', create));
    } else {
      const panel = el('section', 'panel');
      panel.setAttribute('aria-label', 'Промокоды');
      const wrap = el('div', 'table-wrap');
      const table = el('table', 'table table-cards wu-table ops-promo-table');
      table.append(head(['Код', 'Скидка', 'Активации', 'Оплачено', 'Скидка действует', 'Код действует до', 'Статус', 'Действия']));
      const tbody = el('tbody');
      for (const promo of list) tbody.append(this.#promoRow(promo));
      table.append(tbody);
      wrap.append(table);
      panel.append(wrap);
      results.append(panel);
    }
    this.body.replaceChildren(statusSlot, grid, how, editorSlot, results);
    if (focusId) document.getElementById(focusId)?.focus();
  }

  #promoRow(p: PromoCode): HTMLTableRowElement {
    const tr = el('tr', p.state === 'active' ? '' : 'is-zero');
    tr.dataset.promo = String(p.id);

    const codeCell = cell('Код', el('span', 'wu-mono ops-code', p.code));
    if (p.note) codeCell.append(el('span', 'cell-note', p.note));

    const activations = cell('Активации', activationsText(p));
    const share = activationsShare(p);
    if (share !== null) {
      const meter = el('span', 'ops-meter');
      meter.setAttribute('role', 'img');
      meter.setAttribute('aria-label', `Использовано ${share} % лимита`);
      const fill = el('span', share >= 100 ? 'ops-meter-fill is-full' : 'ops-meter-fill');
      fill.style.width = `${share}%`;
      meter.append(fill);
      activations.append(meter);
    }

    const paid = cell('Оплачено', count(p.redeemed));
    if (p.activations > 0) paid.append(el('span', 'cell-note', `конверсия ${conversionText(p.activations, p.redeemed)}`));

    const until = cell('Код действует до', p.expires_at ? formatDateTime(p.expires_at) : 'Без срока', p.expires_at ? '' : 'muted');

    const actions = el('div', 'ops-row-actions');
    const edit = this.#button('Изменить', 'btn btn-secondary btn-sm', 'edit');
    edit.id = `promo-edit-${p.id}`;
    edit.setAttribute('aria-label', `Изменить промокод ${p.code}`);
    edit.addEventListener('click', () => void this.#openPromoEditor(p));
    const toggle = this.#button(p.enabled ? 'Отключить' : 'Включить', 'btn btn-secondary btn-sm');
    toggle.id = `promo-toggle-${p.id}`;
    toggle.setAttribute('aria-label', `${p.enabled ? 'Отключить' : 'Включить'} промокод ${p.code}`);
    toggle.addEventListener('click', () => void this.#togglePromo(p, toggle));
    const remove = this.#button('Удалить', 'btn btn-danger btn-sm', 'trash');
    remove.id = `promo-delete-${p.id}`;
    remove.setAttribute('aria-label', `Удалить промокод ${p.code}`);
    remove.addEventListener('click', () => void this.#deletePromo(p, remove));
    actions.append(edit, toggle, remove);

    tr.append(
      codeCell,
      cell('Скидка', `${p.percent} %`, 'ops-percent'),
      activations,
      paid,
      cell('Скидка действует', validHoursText(p.valid_hours)),
      until,
      cell('Статус', el('span', PROMO_STATE_BADGES[p.state], PROMO_STATE_LABELS[p.state])),
      cell('Действия', actions),
    );
    return tr;
  }

  #showPromoStatus(next: Notice | null) {
    this.body.querySelector('#promo-status')?.replaceChildren(...(next ? [this.#notice(next)] : []));
  }

  /** Replaces one promo of the list (keeping its redemption count) and repaints. */
  #replacePromo(saved: PromoCode, status: Notice, focusId: string) {
    const previous = this.#promos.find(p => p.id === saved.id);
    // A mutation outcome does not count redemptions: keep the listed figure.
    const merged = previous ? { ...saved, redeemed: previous.redeemed } : saved;
    this.#promos = previous ? this.#promos.map(p => (p.id === saved.id ? merged : p)) : [merged, ...this.#promos];
    this.#paintPromos(status, focusId);
  }

  async #togglePromo(p: PromoCode, trigger: HTMLButtonElement) {
    if (this.#editorOpen && !(await this.#leaveEditor())) return;
    if (!this.#live) return;
    const patch: PromoPatch = {
      max_activations: p.max_activations, valid_hours: p.valid_hours, expires_at: p.expires_at ?? '', enabled: !p.enabled, note: p.note,
    };
    const scope = `toggle:${p.id}`;
    const requestKey = this.#keys.key(scope, JSON.stringify([p.version, patch]));
    trigger.disabled = true;
    trigger.setAttribute('aria-busy', 'true');
    try {
      const out = await this.host.api.updatePromo(p.id, p.version, patch, requestKey);
      this.#keys.settle(scope);
      if (!this.#live) return;
      this.host.sessionUsed();
      if (!out.promo) { void this.#loadPromos(); return; }
      this.#replacePromo(out.promo, {
        tone: 'success',
        text: out.promo.enabled ? `Промокод ${p.code} включён.` : `Промокод ${p.code} отключён: новые активации не принимаются, уже выданные скидки действуют до своего срока.`,
      }, `promo-toggle-${p.id}`);
    } catch (error) {
      this.#keys.settle(scope, error);
      if (!this.#live || await this.host.signedOut(error, () => this.#live)) return;
      trigger.disabled = false;
      trigger.removeAttribute('aria-busy');
      if (isCode(error, 'version_conflict') || (error instanceof ApiError && error.status === 404)) {
        void this.#loadPromos({ tone: 'info', text: 'Промокод изменили в другой сессии: список обновлён. Повторите действие.' });
        return;
      }
      this.#showPromoStatus({ tone: 'error', text: `Не удалось изменить промокод ${p.code}. ${opsErrorText(error)}${uncertainText(error)}` });
    }
  }

  async #deletePromo(p: PromoCode, trigger: HTMLButtonElement) {
    if (p.activations > 0) {
      this.#showPromoStatus({
        tone: 'info',
        text: `Промокод ${p.code} уже активировали (${count(p.activations)}): удалить его нельзя, чтобы не потерять историю скидок. Его можно отключить.`,
      });
      return;
    }
    if (this.#editorOpen && !(await this.#leaveEditor())) return;
    if (!this.#live) return;
    const confirmed = await this.host.confirm(`Удалить промокод ${p.code}?`, 'Код ещё никто не активировал. Действие нельзя отменить.', 'Удалить');
    if (!this.#live) return;
    if (!confirmed) { trigger.focus(); return; }
    const scope = `delete:${p.id}`;
    const requestKey = this.#keys.key(scope, String(p.version));
    trigger.disabled = true;
    trigger.setAttribute('aria-busy', 'true');
    const forget = (text: string) => {
      this.#promos = this.#promos.filter(x => x.id !== p.id);
      this.#paintPromos({ tone: 'success', text }, 'promo-create');
    };
    try {
      await this.host.api.deletePromo(p.id, p.version, requestKey);
      this.#keys.settle(scope);
      if (!this.#live) return;
      this.host.sessionUsed();
      forget(`Промокод ${p.code} удалён.`);
    } catch (error) {
      this.#keys.settle(scope, error);
      if (!this.#live || await this.host.signedOut(error, () => this.#live)) return;
      // Already deleted in another session: the outcome the admin asked for.
      if (error instanceof ApiError && error.status === 404) { forget(`Промокода ${p.code} уже нет.`); return; }
      trigger.disabled = false;
      trigger.removeAttribute('aria-busy');
      if (isCode(error, 'promo_in_use') || isCode(error, 'version_conflict')) {
        void this.#loadPromos({ tone: 'info', text: `${opsErrorText(error)} Список обновлён.` });
        return;
      }
      this.#showPromoStatus({ tone: 'error', text: `Не удалось удалить промокод ${p.code}. ${opsErrorText(error)}${uncertainText(error)}` });
    }
  }

  /** Opens the editor above the list: a new code (stored null) or the mutable part of an existing one. */
  async #openPromoEditor(stored: PromoCode | null) {
    if (this.#editorOpen && !(await this.#leaveEditor())) return;
    if (!this.#live) return;
    const slot = this.body.querySelector<HTMLElement>('#promo-editor-slot');
    if (!slot) return; // the list is still loading or failed to load
    const editing = stored !== null;
    const baseline: PromoForm = stored ? formFromPromo(stored) : { ...NEW_PROMO_FORM };
    const form: PromoForm = { ...baseline };
    let saving = false;
    const dirty = () => JSON.stringify(form) !== JSON.stringify(baseline);
    this.#editorOpen = true;
    this.#editorDirty = dirty;
    this.host.setUnsaved(() => this.#live && this.#editorOpen && dirty());

    const panel = this.#panel('promo-editor-title', stored ? `Промокод ${stored.code}` : 'Новый промокод',
      stored ? `активаций: ${activationsText(stored)}` : '');
    panel.root.classList.add('ops-editor');
    const formEl = el('form', 'ops-form');
    formEl.noValidate = true;
    const statusSlot = el('div', 'editor-status');
    const showStatus = (next: Notice | null) => statusSlot.replaceChildren(...(next ? [this.#notice(next)] : []));

    const fields = new Map<PromoField, { f: Field; input: HTMLInputElement }>();
    const bind = (key: PromoField, input: HTMLInputElement, f: Field) => {
      input.value = form[key];
      fields.set(key, { f, input });
      input.addEventListener('input', () => { form[key] = input.value; f.setError(''); refresh(); });
    };
    const chipRow = (label: string, values: readonly (readonly [string, string])[], pick: (value: string) => void) => {
      const group = el('div', 'chips');
      group.setAttribute('role', 'group');
      group.setAttribute('aria-label', label);
      const chips = values.map(([value, text]) => {
        const chip = el('button', 'chip', text);
        chip.type = 'button';
        chip.dataset.value = value;
        chip.addEventListener('click', () => pick(value));
        group.append(chip);
        return chip;
      });
      return { group, chips };
    };
    const assign = (key: PromoField, value: string) => {
      const target = fields.get(key);
      if (!target) return;
      form[key] = value;
      target.input.value = value;
      target.f.setError('');
      refresh();
    };

    // Code -------------------------------------------------------------------
    const code = textInput('promo-code');
    code.maxLength = 32;
    code.placeholder = 'SUMMER20';
    const codeField = field('Код', code, editing
      ? 'Код и размер скидки изменить нельзя: клиенты уже могли активировать этот код.'
      : 'Латинские буквы, цифры, «-» и «_», 3–32 символа. Регистр не важен: клиент может ввести код строчными.');
    bind('code', code, codeField);
    code.disabled = editing;
    if (!editing) {
      code.addEventListener('input', () => {
        const normalized = code.value.toUpperCase();
        if (normalized !== code.value) { code.value = normalized; form.code = normalized; }
      });
      const suggest = this.#button('Сгенерировать', 'chip');
      suggest.id = 'promo-suggest';
      suggest.addEventListener('click', () => { assign('code', suggestPromoCode()); code.focus(); });
      const tools = el('div', 'chips');
      tools.append(suggest);
      codeField.root.insertBefore(tools, codeField.hint);
    }

    // Percent ----------------------------------------------------------------
    const percent = textInput('promo-percent', 'numeric');
    percent.maxLength = 3;
    const percentField = field('Скидка', percent, '', '%');
    bind('percent', percent, percentField);
    percent.disabled = editing;
    const percentChips = chipRow('Размер скидки', PERCENT_PRESETS.map(p => [String(p), `${p} %`] as const), value => assign('percent', value));
    if (!editing) percentField.root.insertBefore(percentChips.group, percentField.hint);

    // Limits -----------------------------------------------------------------
    const max = textInput('promo-max', 'numeric');
    max.maxLength = 7;
    max.placeholder = 'Без лимита';
    const maxField = field('Лимит активаций', max,
      `Сколько раз код можно активировать всего. Пусто — без лимита. Один клиент активирует код один раз.${stored ? ` Уже активировано: ${count(stored.activations)}.` : ''}`);
    bind('maxActivations', max, maxField);

    const hours = textInput('promo-hours', 'numeric');
    hours.maxLength = 4;
    const hoursField = field('Скидка действует после активации', hours, '', 'часов');
    bind('validHours', hours, hoursField);
    const hoursChips = chipRow('Срок действия скидки', VALID_HOURS_PRESETS.map(h => [String(h), validHoursText(h)] as const), value => assign('validHours', value));
    hoursField.root.insertBefore(hoursChips.group, hoursField.hint);

    const expires = el('input', 'input');
    expires.id = 'promo-expires';
    expires.type = 'datetime-local';
    expires.step = '60';
    expires.max = '9999-12-31T23:59';
    const expiresField = field('Код действует до', expires, 'До какого момента код можно активировать, по времени браузера. Пусто — без срока.');
    bind('expiresAt', expires, expiresField);
    const forever = this.#button('Без срока', 'chip');
    forever.addEventListener('click', () => assign('expiresAt', ''));
    const expiresTools = el('div', 'chips');
    expiresTools.append(forever);
    expiresField.root.insertBefore(expiresTools, expiresField.hint);

    const note = textInput('promo-note');
    note.maxLength = 200;
    note.placeholder = 'Например: канал, акция, блогер';
    const noteField = field('Заметка', note, 'Видна только в панели.');
    bind('note', note, noteField);

    const enabled = checkbox('promo-enabled', 'Код включён');
    enabled.input.checked = form.enabled;
    enabled.input.setAttribute('role', 'switch');
    enabled.input.addEventListener('change', () => { form.enabled = enabled.input.checked; refresh(); });

    const example = el('p', 'wu-human ops-example');
    example.id = 'promo-example';
    example.setAttribute('aria-live', 'polite');

    const actions = el('div', 'ops-form-actions');
    const unsaved = el('p', 'unsaved-text');
    unsaved.setAttribute('aria-live', 'polite');
    const cancel = this.#button('Отмена', 'btn btn-secondary');
    cancel.id = 'promo-cancel';
    const saveButton = el('button', 'btn btn-primary');
    saveButton.type = 'submit';
    saveButton.id = 'promo-save';
    saveButton.append(el('span', 'btn-label', editing ? 'Сохранить' : 'Создать промокод'));
    actions.append(unsaved, cancel, saveButton);

    function refresh() {
      const value = Number(form.percent.trim());
      const valid = /^\d{1,3}$/.test(form.percent.trim()) && value >= 1 && value <= 100;
      example.textContent = !valid ? ''
        : value >= 100 ? 'Скидка 100 %: клиент получает любой тариф бесплатно, оплата не нужна.'
          : `Пример: тариф за ${rubles(EXAMPLE_PRICE_CENTS)} со скидкой ${value} % будет стоить ${rubles(discountedCents(EXAMPLE_PRICE_CENTS, value))}.`;
      const h = Number(form.validHours.trim());
      hoursField.hint.textContent = `${/^\d{1,4}$/.test(form.validHours.trim()) && h >= 1 ? `= ${validHoursText(h)}. ` : ''}Сколько времени после ввода кода клиент может оплатить со скидкой.`;
      for (const chip of percentChips.chips) chip.setAttribute('aria-pressed', String(chip.dataset.value === form.percent.trim()));
      for (const chip of hoursChips.chips) chip.setAttribute('aria-pressed', String(chip.dataset.value === form.validHours.trim()));
      unsaved.textContent = saving ? 'Сохраняем…' : dirty() ? 'Есть несохранённые изменения' : editing ? 'Изменений нет' : '';
      unsaved.classList.toggle('is-dirty', dirty());
      saveButton.disabled = saving;
      cancel.disabled = saving;
    }

    // Closing returns the focus to the control that opened the editor.
    const returnFocus = stored ? `promo-edit-${stored.id}` : 'promo-create';
    cancel.addEventListener('click', () => void (async () => {
      if (await this.#leaveEditor()) document.getElementById(returnFocus)?.focus();
    })());

    const save = async () => {
      if (saving) return;
      for (const { f } of fields.values()) f.setError('');
      const { input, errors } = validatePromoForm(form, editing);
      if (!input) {
        let first: HTMLInputElement | null = null;
        for (const [key, text] of Object.entries(errors) as [PromoField, string][]) {
          const target = fields.get(key);
          target?.f.setError(text);
          first ??= target?.input ?? null;
        }
        first?.focus();
        showStatus({ tone: 'error', text: 'Исправьте отмеченные поля.' });
        return;
      }
      if (editing && !dirty()) { showStatus({ tone: 'info', text: 'Нет изменений для сохранения.' }); return; }
      const scope = stored ? `promo:${stored.id}` : 'promo:new';
      const payload = stored ? JSON.stringify([stored.version, promoPatch(input)]) : JSON.stringify(input);
      const requestKey = this.#keys.key(scope, payload);
      saving = true;
      refresh();
      try {
        const out = stored
          ? await this.host.api.updatePromo(stored.id, stored.version, promoPatch(input), requestKey)
          : await this.host.api.createPromo(input, requestKey);
        this.#keys.settle(scope);
        if (!this.#live) return;
        this.host.sessionUsed();
        const text = stored ? `Промокод ${stored.code} сохранён.` : `Промокод ${input.code} создан. Отправьте его клиентам.`;
        if (!out.promo) { void this.#loadPromos({ tone: 'success', text }); return; }
        this.#replacePromo(out.promo, { tone: 'success', text }, `promo-edit-${out.promo.id}`);
      } catch (error) {
        this.#keys.settle(scope, error);
        if (!this.#live || await this.host.signedOut(error, () => this.#live)) return;
        saving = false;
        refresh();
        if (isCode(error, 'version_conflict')) {
          const reload = this.#button('Обновить список', 'btn btn-secondary btn-sm', 'refresh');
          reload.addEventListener('click', () => { this.#closeEditor(); void this.#loadPromos({ tone: 'info', text: 'Загружены актуальные промокоды.' }); });
          showStatus({ tone: 'error', text: 'Промокод изменили в другой сессии. Обновите список и повторите правку.', actions: [reload] });
          return;
        }
        if (isCode(error, 'promo_code_taken')) {
          codeField.setError(opsErrorText(error));
          code.focus();
        } else if (error instanceof ApiError && error.code === 'invalid_promo') {
          const target = fields.get(PROMO_SERVER_FIELDS[error.field]);
          target?.f.setError(PROMO_FIELD_TEXT[error.field] ?? 'Сервер отклонил это значение.');
          target?.input.focus();
        }
        showStatus({ tone: 'error', text: `${opsErrorText(error)}${uncertainText(error)}` });
      }
    };
    formEl.addEventListener('submit', event => { event.preventDefault(); void save(); });

    formEl.append(row(codeField.root, percentField.root), example, row(maxField.root, hoursField.root), row(expiresField.root, noteField.root),
      enabled.root, el('p', 'field-hint', 'Отключённый код нельзя активировать; уже выданные скидки действуют до своего срока.'),
      statusSlot, actions);
    panel.body.append(formEl);
    slot.replaceChildren(panel.root);
    refresh();
    (editing ? max : code).focus();
  }

  // ===========================================================================
  // Event feed (#/events)
  // ===========================================================================

  async #loadEvents(focus: 'prev' | 'next' | null, focusId = '') {
    const current = this.#begin();
    const query = memory.events;
    if (!this.body.childElementCount) {
      const refresh = this.#button('Обновить', 'btn btn-secondary btn-sm', 'refresh');
      refresh.addEventListener('click', () => void this.#loadEvents(null));
      this.#headerActions(refresh);
      this.body.replaceChildren(this.#tabs('feed'), ...this.#skeleton('Загружаем события', 1));
    } else {
      this.body.querySelector('.ops-results')?.setAttribute('aria-busy', 'true');
    }
    try {
      const page = await this.host.api.events(query);
      if (!current()) return;
      this.host.sessionUsed();
      // The feed shrank below the requested page: step back to its last page.
      const last = page.total > 0 && page.limit > 0 ? Math.floor((page.total - 1) / page.limit) * page.limit : 0;
      if (!page.events.length && query.offset > last) {
        memory.events = { ...query, offset: last };
        void this.#loadEvents(focus);
        return;
      }
      this.#paintEvents(page, focus, focusId);
    } catch (error) {
      if (await this.#failed(error, current)) return;
      this.#ready();
      this.body.replaceChildren(this.#tabs('feed'), this.#errorPanel('Не удалось загрузить события', error, () => void this.#loadEvents(null)));
    }
  }

  #paintEvents(page: OpsEventsPage, focus: 'prev' | 'next' | null, focusId: string) {
    this.#ready();
    const q = memory.events;
    const filtered = q.severity !== '' || q.kind !== '';

    const filters = el('div', 'toolbar ops-filters');
    filters.setAttribute('role', 'group');
    filters.setAttribute('aria-label', 'Фильтры событий');
    const severities = el('div', 'chips');
    severities.setAttribute('role', 'group');
    severities.setAttribute('aria-label', 'Важность');
    const severityChip = (value: OpsEventsQuery['severity'], label: string) => {
      const chip = el('button', 'chip ops-sev-chip');
      chip.type = 'button';
      chip.id = `ops-sev-${value || 'all'}`;
      chip.setAttribute('aria-pressed', String(q.severity === value));
      if (value) chip.append(dot(SEVERITY_TONES[value]));
      chip.append(el('span', '', label));
      chip.addEventListener('click', () => {
        memory.events = { ...memory.events, severity: value, offset: 0 };
        void this.#loadEvents(null, chip.id);
      });
      severities.append(chip);
    };
    severityChip('', 'Все');
    for (const severity of OPS_SEVERITIES) severityChip(severity, SEVERITY_LABELS[severity]);

    const kind = el('select', 'input select-input');
    kind.id = 'ops-kind';
    const all = el('option', '', 'Все типы событий');
    all.value = '';
    kind.append(all);
    for (const [group, kinds] of EVENT_KIND_GROUPS) {
      const optgroup = el('optgroup');
      optgroup.label = group;
      for (const [value, label] of kinds) {
        const item = el('option', '', label);
        item.value = value;
        optgroup.append(item);
      }
      kind.append(optgroup);
    }
    kind.value = q.kind;
    kind.addEventListener('change', () => {
      memory.events = { ...memory.events, kind: kind.value, offset: 0 };
      void this.#loadEvents(null, 'ops-kind');
    });
    const kindWrap = el('div', 'wu-filter');
    const kindLabelNode = el('label', 'wu-filter-label', 'Тип события');
    kindLabelNode.htmlFor = kind.id;
    kindWrap.append(kindLabelNode, kind);
    filters.append(severities, kindWrap);
    if (filtered) {
      const reset = this.#button('Сбросить', 'btn btn-ghost btn-sm');
      reset.id = 'ops-reset';
      reset.addEventListener('click', () => { memory.events = EMPTY_EVENTS_QUERY; void this.#loadEvents(null, 'ops-sev-all'); });
      filters.append(reset);
    }

    const results = el('div', 'ops-results');
    if (!page.events.length) {
      results.append(filtered
        ? this.#emptyPanel('Нет событий по этим условиям', 'Измените или сбросьте фильтры.')
        : this.#emptyPanel('Событий пока нет',
          'Здесь появятся сбои и восстановления серверов, стран, сборок и источников, а также ежедневные итоги. Пока записей нет — сбоев не было.'));
    } else {
      const panel = el('section', 'panel ops-feed-panel');
      panel.setAttribute('aria-label', 'Лента событий');
      for (const group of groupByDay(page.events)) {
        const day = el('h2', 'ops-day', group.label);
        const list = el('ol', 'ops-feed');
        list.setAttribute('aria-label', `События: ${group.label}`);
        for (const ev of group.events) list.append(this.#eventItem(ev));
        panel.append(day, list);
      }
      panel.append(this.#pager(page.total, page.limit, page.offset, page.events.length, (offset, dir) => {
        memory.events = { ...memory.events, offset };
        void this.#loadEvents(dir);
      }));
      results.append(panel);
    }
    this.body.replaceChildren(this.#tabs('feed'), filters, el('p', 'toolbar-meta', `Найдено: ${count(page.total)}`), results);
    if (focus) this.body.querySelector<HTMLElement>(`[data-pager='${focus}']:not(:disabled)`)?.focus();
    else if (focusId) document.getElementById(focusId)?.focus();
  }

  #eventItem(ev: OpsEvent): HTMLLIElement {
    const tone = SEVERITY_TONES[ev.severity];
    const item = el('li', `ops-event is-${tone}`);
    item.dataset.event = String(ev.id);
    const body = el('div', 'ops-event-body');
    const headNode = el('div', 'ops-event-head');
    const time = el('time', 'ops-event-time', timeFormat.format(new Date(ev.created_at)));
    time.dateTime = ev.created_at;
    time.title = formatDateTime(ev.created_at);
    const severity = el('span', `badge ops-sev is-${tone}`);
    severity.append(dot(tone), el('span', '', SEVERITY_LABELS[ev.severity]));
    headNode.append(el('h3', 'ops-event-title', ev.title), severity, time);
    body.append(headNode);

    const report = kindSubject(ev.kind) === 'report';
    const text = report ? telegramPlainText(ev.message) : ev.message;
    if (text) {
      if (report && ev.kind === 'daily_report') {
        // A report is long: collapsed by default, the full figures are on «Итоги дня».
        const details = el('details', 'ops-event-details');
        details.append(el('summary', '', 'Показать отчёт'), el('pre', 'ops-telegram', text));
        body.append(details);
      } else {
        body.append(el('p', 'ops-event-text', text));
      }
    }

    const meta = el('p', 'ops-event-meta');
    const notify = NOTIFY_LABELS[ev.notify_status] ?? ev.notify_status;
    meta.append(el('span', '', `${EVENT_SUBJECT_LABELS[kindSubject(ev.kind)]} · ${kindLabel(ev.kind)}`),
      el('span', ev.notify_status === 'failed' ? 'ops-notify is-failed' : 'ops-notify', notify));
    if (ev.notify_status === 'failed' && ev.notify_error) meta.append(el('span', 'error-text', ev.notify_error));
    body.append(meta);
    item.append(body);
    return item;
  }

  // ===========================================================================
  // Daily report (#/events/report)
  // ===========================================================================

  async #loadReport(focusId = '') {
    const current = this.#begin();
    const day = memory.reportDay;
    if (!this.body.childElementCount) {
      const refresh = this.#button('Обновить', 'btn btn-secondary btn-sm', 'refresh');
      refresh.addEventListener('click', () => void this.#loadReport());
      this.#headerActions(refresh);
      this.body.replaceChildren(this.#tabs('report'), ...this.#skeleton('Загружаем итоги дня', 2));
    } else {
      this.body.querySelector('.ops-results')?.setAttribute('aria-busy', 'true');
    }
    try {
      // The schedule line is a nicety: the report is shown even if the settings fail to load.
      const [report, settings] = await Promise.all([this.host.api.report(day), this.host.api.settings().catch(() => null)]);
      if (!current()) return;
      this.host.sessionUsed();
      this.#paintReport(report, settings, day, focusId);
    } catch (error) {
      if (await this.#failed(error, current)) return;
      this.#ready();
      this.body.replaceChildren(this.#tabs('report'), this.#errorPanel('Не удалось загрузить итоги дня', error, () => void this.#loadReport()));
    }
  }

  #paintReport(report: OpsReport, settings: OpsSettings | null, day: ReportDay, focusId: string) {
    this.#ready();
    const days = el('div', 'chips');
    days.setAttribute('role', 'group');
    days.setAttribute('aria-label', 'День отчёта');
    for (const [value, label] of [['today', 'Сегодня'], ['yesterday', 'Вчера']] as const) {
      const chip = el('button', 'chip', label);
      chip.type = 'button';
      chip.id = `ops-day-${value}`;
      chip.setAttribute('aria-pressed', String(day === value));
      chip.addEventListener('click', () => { memory.reportDay = value; void this.#loadReport(chip.id); });
      days.append(chip);
    }
    const toolbar = el('div', 'toolbar');
    toolbar.append(days, el('p', 'toolbar-meta', day === 'today'
      ? `${reportDayText(report.day)} · день ещё идёт, цифры на текущий момент (время московское)`
      : `${reportDayText(report.day)} · полные сутки по московскому времени`));

    const figures = reportFigures(report.stats);
    const figureGrid = (id: string, title: string, list: readonly ReportFigure[]) => {
      const panel = el('section', 'panel ops-figures-panel');
      panel.setAttribute('aria-labelledby', id);
      const headNode = el('div', 'panel-head');
      const heading = el('h2', 'panel-title', title);
      heading.id = id;
      headNode.append(heading);
      const grid = el('dl', 'ops-figures');
      for (const figure of list) {
        const item = el('div', figure.tone ? `ops-figure is-${figure.tone}` : 'ops-figure');
        const value = el('dd', 'ops-figure-value');
        if (figure.tone) value.append(dot(figure.tone));
        value.append(el('span', '', figure.value));
        item.append(el('dt', 'ops-figure-label', figure.label), value);
        if (figure.note) item.append(el('dd', 'ops-figure-note', figure.note));
        grid.append(item);
      }
      panel.append(headNode, grid);
      return panel;
    };

    const telegram = this.#panel('ops-report-telegram', 'Так отчёт выглядит в Telegram');
    const schedule = !settings ? ''
      : !settings.enabled ? 'Уведомления в Telegram выключены: отчёт не отправляется.'
        : !settings.daily_report ? 'Ежедневный отчёт выключен в настройках уведомлений.'
          : `Отчёт за прошедший день приходит каждый день в ${String(settings.daily_report_hour).padStart(2, '0')}:00 по Москве.`;
    if (schedule) telegram.body.append(el('p', 'field-hint', schedule));
    telegram.body.append(el('pre', 'ops-telegram', telegramPlainText(report.text)));
    const configure = el('a', 'btn btn-secondary btn-sm', 'Настроить уведомления');
    configure.href = eventsHash('telegram');
    telegram.body.append(configure);

    const results = el('div', 'ops-results');
    results.append(figureGrid('ops-report-business', 'Клиенты и продажи', figures.business),
      figureGrid('ops-report-infra', 'Инфраструктура', figures.infra), telegram.root);
    this.body.replaceChildren(this.#tabs('report'), toolbar, results);
    if (focusId) document.getElementById(focusId)?.focus();
  }

  // ===========================================================================
  // Telegram notifications (#/events/telegram)
  // ===========================================================================

  async #loadSettings() {
    const current = this.#begin();
    this.host.setUnsaved(null);
    this.body.replaceChildren(this.#tabs('telegram'), ...this.#skeleton('Загружаем настройки уведомлений', 2));
    try {
      const settings = await this.host.api.settings();
      if (!current()) return;
      this.host.sessionUsed();
      this.#paintSettings(settings, null);
    } catch (error) {
      if (await this.#failed(error, current)) return;
      this.#ready();
      this.body.replaceChildren(this.#tabs('telegram'), this.#errorPanel('Не удалось загрузить настройки уведомлений', error, () => void this.#loadSettings()));
    }
  }

  #paintSettings(settings: OpsSettings, status: Notice | null) {
    this.#ready();
    const baseline = opsForm(settings);
    const form: OpsForm = { ...baseline };
    let busy = false;
    const dirty = () => !sameOpsForm(form, baseline);
    this.host.setUnsaved(() => this.#live && dirty());
    const statusSlot = el('div', 'editor-status');
    const showStatus = (next: Notice | null) => statusSlot.replaceChildren(...(next ? [this.#notice(next)] : []));
    showStatus(status);
    const errorSetters = new Map<OpsField, { f: Field; input: HTMLElement }>();

    // Destination ------------------------------------------------------------
    const where = this.#panel('ops-set-where', 'Куда отправлять', `версия ${settings.version} · изменены ${formatDateTime(settings.updated_at)}`);
    const enabled = checkbox('ops-set-enabled', 'Уведомления в Telegram включены');
    enabled.input.checked = form.enabled;
    enabled.input.setAttribute('role', 'switch');
    enabled.root.classList.add('wu-switch');
    enabled.input.addEventListener('change', () => { form.enabled = enabled.input.checked; refresh(); });
    const state = el('p', 'wu-human');
    state.id = 'ops-set-state';
    state.setAttribute('aria-live', 'polite');

    const chat = textInput('ops-set-chat');
    chat.maxLength = 20;
    chat.placeholder = settings.effective_chat_id && settings.chat_id === 0 ? String(settings.effective_chat_id) : 'Например 123456789';
    chat.value = form.chatId;
    const chatField = field('ID чата', chat,
      'Пусто — личный чат администратора (TELEGRAM_ADMIN_ID). Для группы или канала укажите ID вида -1001234567890 и добавьте туда бота.');
    errorSetters.set('chatId', { f: chatField, input: chat });
    chat.addEventListener('input', () => { form.chatId = chat.value; chatField.setError(''); refresh(); });

    const botGroup = el('fieldset', 'ops-fieldset');
    botGroup.append(el('legend', 'field-label', 'Бот, который присылает сообщения'));
    const radios = el('div', 'wu-radios');
    const radio = (id: string, label: string, main: boolean) => {
      const input = el('input');
      input.type = 'radio';
      input.name = 'ops-bot';
      input.id = id;
      input.checked = form.useMainBot === main;
      const wrap = el('label', 'toggle');
      wrap.htmlFor = id;
      wrap.append(input, el('span', '', label));
      input.addEventListener('change', () => { if (input.checked) { form.useMainBot = main; tokenField.setError(''); refresh(); } });
      radios.append(wrap);
      return input;
    };
    radio('ops-bot-main', 'Основной бот сервиса', true);
    radio('ops-bot-own', 'Отдельный бот для уведомлений', false);
    const token = el('input', 'input');
    token.id = 'ops-set-token';
    token.type = 'password';
    token.autocomplete = 'off';
    token.spellcheck = false;
    token.maxLength = 100;
    token.placeholder = settings.own_bot ? 'Токен сохранён — вставьте новый, чтобы заменить' : '123456789:AAE…';
    const tokenField = field('Токен отдельного бота', token,
      'Токен выдаёт @BotFather. Он хранится на сервере и в панели больше не показывается. Получатель должен нажать /start в этом боте.');
    errorSetters.set('botToken', { f: tokenField, input: token });
    token.addEventListener('input', () => { form.botToken = token.value; tokenField.setError(''); refresh(); });
    botGroup.append(radios, tokenField.root);
    where.body.append(enabled.root, state, chatField.root, botGroup);

    // What to send -----------------------------------------------------------
    const what = this.#panel('ops-set-what', 'Что присылать');
    const kinds: readonly (readonly [keyof Pick<OpsForm, 'notifyServers' | 'notifyCountries' | 'notifySources'>, string, string, string])[] = [
      ['notifyServers', 'ops-set-servers', 'Серверы', 'Сервер перестал отвечать, восстановился или снят с выдачи; проверки мониторинга остановились.'],
      ['notifyCountries', 'ops-set-countries', 'Страны и сборки', 'Страна недоступна или работает частично; у сборки не отвечает ни один сервер; сборка отключена.'],
      ['notifySources', 'ops-set-sources', 'Источники', 'Источник не загружается, скоро закончится, его срок истёк или он отключён.'],
    ];
    for (const [key, id, label, hint] of kinds) {
      const box = checkbox(id, label);
      box.input.checked = form[key];
      box.input.setAttribute('aria-describedby', `${id}-hint`);
      box.input.addEventListener('change', () => { form[key] = box.input.checked; refresh(); });
      const hintNode = el('p', 'field-hint ops-check-hint', hint);
      hintNode.id = `${id}-hint`;
      const wrap = el('div', 'ops-check');
      wrap.append(box.root, hintNode);
      what.body.append(wrap);
    }
    what.body.append(el('p', 'field-hint', 'Выключенные типы всё равно записываются в ленту событий — без сообщения в Telegram. Несколько событий подряд приходят одним сообщением.'));

    // Daily report -----------------------------------------------------------
    const daily = this.#panel('ops-set-daily', 'Ежедневный отчёт');
    const report = checkbox('ops-set-report', 'Присылать итоги дня');
    report.input.checked = form.dailyReport;
    report.input.setAttribute('role', 'switch');
    report.input.addEventListener('change', () => { form.dailyReport = report.input.checked; refresh(); });
    const hour = el('select', 'input select-input');
    hour.id = 'ops-set-hour';
    for (let h = 0; h < 24; h++) {
      const item = el('option', '', `${String(h).padStart(2, '0')}:00`);
      item.value = String(h);
      hour.append(item);
    }
    hour.value = form.dailyReportHour;
    const hourField = field('Время отправки, по Москве', hour,
      'Отчёт за прошедший день: пользователи, подписки, продажи, пробные активации, промокоды и состояние серверов.');
    errorSetters.set('dailyReportHour', { f: hourField, input: hour });
    hour.addEventListener('change', () => { form.dailyReportHour = hour.value; hourField.setError(''); refresh(); });
    const preview = el('a', 'btn btn-secondary btn-sm', 'Посмотреть отчёт');
    preview.href = eventsHash('report');
    daily.body.append(report.root, hourField.root,
      el('p', 'field-hint', settings.last_report_day ? `Последний отчёт: за ${reportDayText(settings.last_report_day)}.` : 'Отчёт ещё не отправлялся.'), preview);

    // Actions ----------------------------------------------------------------
    const actions = el('div', 'panel editor-actions wu-actions');
    const unsaved = el('p', 'unsaved-text');
    unsaved.setAttribute('aria-live', 'polite');
    const testButton = this.#button('Отправить тестовое сообщение', 'btn btn-secondary');
    testButton.id = 'ops-test';
    const saveButton = this.#button('Сохранить', 'btn btn-primary');
    saveButton.id = 'ops-save';
    actions.append(unsaved, testButton, saveButton);

    const destination = () => {
      const typed = form.chatId.trim();
      return typed || (settings.effective_chat_id && settings.chat_id === 0 ? `${settings.effective_chat_id} (администратор)` : 'администратора');
    };
    function refresh() {
      state.textContent = form.enabled
        ? `События и отчёт приходят в чат ${destination()} от ${form.useMainBot ? 'основного бота' : 'отдельного бота'}.`
        : 'Уведомления выключены: события остаются в ленте, в Telegram ничего не уходит.';
      state.classList.toggle('is-off', !form.enabled);
      tokenField.root.hidden = form.useMainBot;
      hourField.root.hidden = !form.dailyReport;
      unsaved.textContent = busy ? 'Выполняем…' : dirty() ? 'Есть несохранённые изменения' : 'Изменений нет';
      unsaved.classList.toggle('is-dirty', dirty());
      saveButton.disabled = busy;
      testButton.disabled = busy;
    }
    refresh();

    const save = async () => {
      if (busy) return;
      for (const { f } of errorSetters.values()) f.setError('');
      const { save: body, errors } = opsSave(form, settings);
      if (!body) {
        let first: HTMLElement | null = null;
        for (const [key, text] of Object.entries(errors) as [OpsField, string][]) {
          const target = errorSetters.get(key);
          target?.f.setError(text);
          first ??= target?.input ?? null;
        }
        first?.focus();
        showStatus({ tone: 'error', text: 'Исправьте отмеченные поля.' });
        return;
      }
      if (!dirty()) { showStatus({ tone: 'info', text: 'Нет изменений для сохранения.' }); return; }
      // The token never reaches the key store: the payload of the key carries only whether it changes.
      const { bot_token: tokenValue, ...rest } = body;
      const requestKey = this.#keys.key('settings', JSON.stringify([rest, tokenValue === undefined ? 'keep' : tokenValue === '' ? 'clear' : `set:${tokenValue.length}:${tokenValue.slice(-4)}`]));
      busy = true;
      refresh();
      try {
        const out = await this.host.api.saveSettings(body, requestKey);
        this.#keys.settle('settings');
        if (!this.#live) return;
        this.host.sessionUsed();
        this.#paintSettings(out.settings, { tone: 'success', text: 'Настройки сохранены. Отправьте тестовое сообщение, чтобы проверить доставку.' });
        document.getElementById('ops-test')?.focus();
      } catch (error) {
        this.#keys.settle('settings', error);
        if (!this.#live || await this.host.signedOut(error, () => this.#live)) return;
        busy = false;
        refresh();
        if (isCode(error, 'version_conflict')) {
          const reload = this.#button('Обновить данные', 'btn btn-secondary btn-sm', 'refresh');
          reload.addEventListener('click', () => void (async () => {
            if (dirty() && !(await this.host.confirm('Обновить данные?', 'Несохранённые изменения будут потеряны.', 'Обновить'))) return;
            if (this.#live) void this.#loadSettings();
          })());
          showStatus({ tone: 'error', text: 'Настройки изменили в другой сессии.', actions: [reload] });
          return;
        }
        showStatus({ tone: 'error', text: `${opsErrorText(error)}${uncertainText(error)}` });
      }
    };
    saveButton.addEventListener('click', () => void save());

    testButton.addEventListener('click', () => void (async () => {
      if (busy) return;
      if (dirty()) { showStatus({ tone: 'info', text: 'Сначала сохраните изменения: тест уходит по сохранённым настройкам.' }); return; }
      busy = true;
      refresh();
      try {
        await this.host.api.sendTest();
        if (!this.#live) return;
        this.host.sessionUsed();
        showStatus({ tone: 'success', text: 'Тестовое сообщение отправлено. Проверьте Telegram.' });
      } catch (error) {
        if (!this.#live || await this.host.signedOut(error, () => this.#live)) return;
        showStatus({ tone: 'error', text: opsErrorText(error) });
      } finally {
        busy = false;
        if (this.#live) refresh();
      }
    })());

    this.body.replaceChildren(this.#tabs('telegram'), statusSlot, where.root, what.root, daily.root, actions);
  }
}
