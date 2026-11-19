// Promo codes (Admin → «Промокоды», /admin/api/promos) and operational events
// (Admin → «События», /admin/api/ops): types, strict response parsing, the
// API client and the pure helpers of the screens in ops-ui.ts. No DOM here;
// covered by tests/admin-ops.test.ts.
//
// Every write carries a request_key (RequestKeys from warmup.ts): an uncertain
// response is retried with the same key and replays the committed outcome.
// The Telegram bot token is write-only: the server never returns it, only
// whether a separate bot is configured (own_bot).

import { ApiError, errorText, type AdminApi } from './api';
import { pluralRu } from './tariffs';

// =============================================================================
// Types (wire shapes of internal/service/promo.go and internal/service/ops.go)
// =============================================================================

export const PROMO_STATES = ['active', 'disabled', 'expired', 'exhausted'] as const;
export type PromoState = (typeof PROMO_STATES)[number];

/** service.PromoView. */
export interface PromoCode {
  readonly id: number;
  readonly code: string;
  readonly percent: number;
  /** 0 = unlimited. */
  readonly max_activations: number;
  readonly activations: number;
  /** How long an activated discount stays usable, hours. */
  readonly valid_hours: number;
  /** End of the code itself; null = no end. */
  readonly expires_at: string | null;
  readonly enabled: boolean;
  readonly note: string;
  readonly version: number;
  readonly created_at: string;
  readonly updated_at: string;
  /** Activations that paid an order (0 in a mutation outcome). */
  readonly redeemed: number;
  readonly state: PromoState;
}

/** Body of POST /promos (request_key added by the client). */
export interface PromoInput {
  readonly code: string;
  readonly percent: number;
  readonly max_activations: number;
  readonly valid_hours: number;
  /** RFC 3339, '' = no end. */
  readonly expires_at: string;
  readonly enabled: boolean;
  readonly note: string;
}

/** Body of PATCH /promos/{id}: the code and its percent are fixed. */
export type PromoPatch = Omit<PromoInput, 'code' | 'percent'>;

/** database.Promo* bounds. */
export const PROMO_LIMITS = { maxActivations: 1_000_000, maxValidHours: 8760, maxNote: 200, codePattern: /^[A-Z0-9][A-Z0-9_-]{2,31}$/ } as const;

export const OPS_SEVERITIES = ['critical', 'warning', 'ok', 'info'] as const;
export type OpsSeverity = (typeof OPS_SEVERITIES)[number];

/** service.OpsSettingsView (the bot token is never part of it). */
export interface OpsSettings {
  readonly enabled: boolean;
  readonly chat_id: number;
  readonly notify_servers: boolean;
  readonly notify_countries: boolean;
  readonly notify_sources: boolean;
  readonly daily_report: boolean;
  readonly daily_report_hour: number;
  readonly last_report_day: string;
  readonly version: number;
  readonly updated_at: string;
  /** A separate notification bot is configured (otherwise the main bot sends). */
  readonly own_bot: boolean;
  /** Where messages go: chat_id, or the admin's Telegram ID when chat_id is 0. */
  readonly effective_chat_id: number;
}

/** Body of PUT /ops. bot_token: undefined keeps the stored token, '' switches back to the main bot. */
export interface OpsSettingsSave {
  readonly version: number;
  readonly enabled: boolean;
  readonly chat_id: number;
  readonly bot_token?: string;
  readonly notify_servers: boolean;
  readonly notify_countries: boolean;
  readonly notify_sources: boolean;
  readonly daily_report: boolean;
  readonly daily_report_hour: number;
}

/** service.OpsEventView. */
export interface OpsEvent {
  readonly id: number;
  readonly created_at: string;
  readonly kind: string;
  readonly severity: OpsSeverity;
  readonly title: string;
  /** Plain text; for a daily report the Telegram HTML of the message. */
  readonly message: string;
  readonly builder_id: number | null;
  readonly source_id: number | null;
  readonly target_id: number | null;
  readonly country_code: string;
  /** pending | sent | failed | skipped */
  readonly notify_status: string;
  readonly notified_at: string | null;
  readonly notify_error: string;
  readonly details: Readonly<Record<string, unknown>>;
}

export interface OpsEventsPage {
  readonly events: readonly OpsEvent[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

export interface OpsEventsQuery {
  readonly severity: OpsSeverity | '';
  readonly kind: string;
  readonly offset: number;
}

export const EMPTY_EVENTS_QUERY: OpsEventsQuery = { severity: '', kind: '', offset: 0 };
export const EVENTS_PAGE_SIZE = 50;

/** database.OpsMoney: minor units, whole Stars for XTR. */
export interface OpsMoney {
  readonly currency: string;
  readonly amount_cents: number;
  readonly orders: number;
}

/** database.OpsDailyStats. */
export interface OpsDailyStats {
  readonly from: string;
  readonly to: string;
  readonly users_total: number;
  readonly users_new: number;
  readonly active_subscriptions: number;
  readonly paid_active_subscriptions: number;
  readonly trials_started: number;
  readonly trials_bound: number;
  readonly purchases: number;
  readonly renewals: number;
  readonly free_activations: number;
  readonly expired: number;
  readonly refunds: number;
  readonly promo_activations: number;
  readonly promo_redemptions: number;
  readonly connected: number;
  readonly incidents_country: number;
  readonly incidents_server: number;
  readonly open_incidents: number;
  readonly expiring_in_3_days: number;
  readonly sources_total: number;
  readonly sources_unusable: number;
  readonly builders_enabled: number;
  readonly warmup_sent: number;
  readonly pending_orders: number;
  readonly period_revenue: readonly OpsMoney[];
  readonly total_revenue: readonly OpsMoney[];
}

/** service.OpsReport. */
export interface OpsReport {
  readonly day: string;
  readonly stats: OpsDailyStats;
  /** The Telegram HTML of the report message. */
  readonly text: string;
}

export type ReportDay = 'today' | 'yesterday';

// =============================================================================
// Parsing (a malformed response is ApiError invalid_response)
// =============================================================================

type Wire = Record<string, unknown>;

const isRecord = (v: unknown): v is Wire => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);
const isCount = (v: unknown): v is number => isInt(v) && v >= 0;
const isId = (v: unknown): v is number => isInt(v) && v > 0;
const isText = (v: unknown): v is string => typeof v === 'string';
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const isTime = (v: unknown): v is string => typeof v === 'string' && v.length <= 40 && !Number.isNaN(Date.parse(v));
const isNullTime = (v: unknown): v is string | null => v === null || v === undefined || isTime(v);
const isNullId = (v: unknown): v is number | null => v === null || v === undefined || isId(v);

function invalid(): never {
  throw new ApiError('invalid_response');
}

const isPromoState = (v: unknown): v is PromoState => (PROMO_STATES as readonly unknown[]).includes(v);
export const isSeverity = (v: unknown): v is OpsSeverity => (OPS_SEVERITIES as readonly unknown[]).includes(v);

export function parsePromo(v: unknown): PromoCode {
  if (!isRecord(v)) invalid();
  const {
    id, code, percent, max_activations, activations, valid_hours, expires_at = null, enabled, note, version,
    created_at, updated_at, redeemed = 0, state,
  } = v;
  if (!isId(id) || !isText(code) || !isInt(percent) || percent < 1 || percent > 100 || !isCount(max_activations) ||
    !isCount(activations) || !isCount(valid_hours) || !isNullTime(expires_at) || !isBool(enabled) || !isText(note) ||
    !isId(version) || !isTime(created_at) || !isTime(updated_at) || !isCount(redeemed) || !isPromoState(state)) invalid();
  return {
    id, code, percent, max_activations, activations, valid_hours, expires_at: expires_at ?? null, enabled, note, version,
    created_at, updated_at, redeemed, state,
  };
}

export function parseOpsSettings(v: unknown): OpsSettings {
  if (!isRecord(v)) invalid();
  const {
    enabled, chat_id, notify_servers, notify_countries, notify_sources, daily_report, daily_report_hour,
    last_report_day = '', version, updated_at, own_bot, effective_chat_id,
  } = v;
  if (!isBool(enabled) || !isInt(chat_id) || !isBool(notify_servers) || !isBool(notify_countries) || !isBool(notify_sources) ||
    !isBool(daily_report) || !isInt(daily_report_hour) || daily_report_hour < 0 || daily_report_hour > 23 ||
    !isText(last_report_day) || !isId(version) || !isTime(updated_at) || !isBool(own_bot) || !isInt(effective_chat_id)) invalid();
  return {
    enabled, chat_id, notify_servers, notify_countries, notify_sources, daily_report, daily_report_hour,
    last_report_day, version, updated_at, own_bot, effective_chat_id,
  };
}

export function parseOpsEvent(v: unknown): OpsEvent {
  if (!isRecord(v)) invalid();
  const {
    id, created_at, kind, severity, title, message, builder_id = null, source_id = null, target_id = null,
    country_code = '', notify_status, notified_at = null, notify_error = '', details = {},
  } = v;
  if (!isId(id) || !isTime(created_at) || !isText(kind) || !isSeverity(severity) || !isText(title) || !isText(message) ||
    !isNullId(builder_id) || !isNullId(source_id) || !isNullId(target_id) || !isText(country_code) ||
    !isText(notify_status) || !isNullTime(notified_at) || !isText(notify_error) || !isRecord(details)) invalid();
  return {
    id, created_at, kind, severity, title, message, builder_id: builder_id ?? null, source_id: source_id ?? null,
    target_id: target_id ?? null, country_code, notify_status, notified_at: notified_at ?? null, notify_error, details,
  };
}

function parseMoneyList(v: unknown): OpsMoney[] {
  if (v === null || v === undefined) return [];
  if (!Array.isArray(v)) invalid();
  return v.map(item => {
    if (!isRecord(item) || !isText(item.currency) || !isInt(item.amount_cents) || !isCount(item.orders)) invalid();
    return { currency: item.currency, amount_cents: item.amount_cents, orders: item.orders };
  });
}

const STAT_COUNTERS = [
  'users_total', 'users_new', 'active_subscriptions', 'paid_active_subscriptions', 'trials_started', 'trials_bound',
  'purchases', 'renewals', 'free_activations', 'expired', 'refunds', 'promo_activations', 'promo_redemptions', 'connected',
  'incidents_country', 'incidents_server', 'open_incidents', 'expiring_in_3_days', 'sources_total', 'sources_unusable',
  'builders_enabled', 'warmup_sent', 'pending_orders',
] as const;

export function parseDailyStats(v: unknown): OpsDailyStats {
  if (!isRecord(v) || !isTime(v.from) || !isTime(v.to)) invalid();
  const counters: Record<string, number> = {};
  for (const key of STAT_COUNTERS) {
    const value = v[key];
    // users_new can be negative only in theory (deleted rows); accept any integer.
    if (!isInt(value)) invalid();
    counters[key] = value;
  }
  return {
    ...(counters as Record<(typeof STAT_COUNTERS)[number], number>),
    from: v.from, to: v.to,
    period_revenue: parseMoneyList(v.period_revenue), total_revenue: parseMoneyList(v.total_revenue),
  };
}

export function parseReport(v: unknown): OpsReport {
  if (!isRecord(v) || !isText(v.day) || !/^\d{4}-\d{2}-\d{2}$/.test(v.day) || !isText(v.text)) invalid();
  return { day: v.day, stats: parseDailyStats(v.stats), text: v.text };
}

function checkId(id: number) {
  if (!isId(id)) throw new ApiError('not_found', 404);
}

export function eventsPath(q: OpsEventsQuery): string {
  const params = new URLSearchParams();
  if (q.severity) params.set('severity', q.severity);
  if (q.kind) params.set('kind', q.kind);
  params.set('limit', String(EVENTS_PAGE_SIZE));
  if (q.offset > 0) params.set('offset', String(q.offset));
  return `/admin/api/ops/events?${params.toString()}`;
}

// =============================================================================
// API client
// =============================================================================

export interface PromoOutcome { readonly promo: PromoCode | null; readonly replayed: boolean }
export interface OpsSettingsOutcome { readonly settings: OpsSettings; readonly replayed: boolean }

export class OpsApi {
  constructor(private readonly api: Pick<AdminApi, 'request'>) {}

  async promos(): Promise<PromoCode[]> {
    const data = await this.api.request('GET', '/admin/api/promos');
    if (!isRecord(data) || !Array.isArray(data.promos)) invalid();
    return data.promos.map(parsePromo);
  }

  /** POST /promos: 400 invalid_promo (field), 409 promo_code_taken. */
  async createPromo(input: PromoInput, requestKey: string): Promise<PromoOutcome> {
    const data = await this.api.request('POST', '/admin/api/promos', JSON.stringify({ request_key: requestKey, ...input }));
    return parsePromoOutcome(data);
  }

  /** PATCH /promos/{id}: 409 version_conflict when another session saved first. */
  async updatePromo(id: number, version: number, patch: PromoPatch, requestKey: string): Promise<PromoOutcome> {
    checkId(id);
    const data = await this.api.request('PATCH', `/admin/api/promos/${id}`, JSON.stringify({ request_key: requestKey, version, ...patch }));
    return parsePromoOutcome(data);
  }

  /** DELETE /promos/{id}: 409 promo_in_use once somebody activated the code. */
  async deletePromo(id: number, version: number, requestKey: string): Promise<void> {
    checkId(id);
    const data = await this.api.request('DELETE', `/admin/api/promos/${id}`, JSON.stringify({ request_key: requestKey, version }));
    if (!isRecord(data) || !isBool(data.replayed)) invalid();
  }

  async settings(): Promise<OpsSettings> {
    return parseOpsSettings(await this.api.request('GET', '/admin/api/ops'));
  }

  async saveSettings(save: OpsSettingsSave, requestKey: string): Promise<OpsSettingsOutcome> {
    const data = await this.api.request('PUT', '/admin/api/ops', JSON.stringify({ request_key: requestKey, ...save }));
    if (!isRecord(data) || !isBool(data.replayed)) invalid();
    return { settings: parseOpsSettings(data.settings), replayed: data.replayed };
  }

  async events(q: OpsEventsQuery): Promise<OpsEventsPage> {
    const data = await this.api.request('GET', eventsPath(q));
    if (!isRecord(data) || !Array.isArray(data.events) || !isCount(data.total) || !isCount(data.limit) || !isCount(data.offset)) invalid();
    return { events: data.events.map(parseOpsEvent), total: data.total, limit: data.limit, offset: data.offset };
  }

  async report(day: ReportDay): Promise<OpsReport> {
    return parseReport(await this.api.request('GET', `/admin/api/ops/report?day=${day}`));
  }

  /** POST /ops/test: 409 ops_not_configured, 502 ops_send_failed. */
  async sendTest(): Promise<void> {
    const data = await this.api.request('POST', '/admin/api/ops/test', '{}');
    if (!isRecord(data) || data.sent !== true) invalid();
  }
}

function parsePromoOutcome(data: unknown): PromoOutcome {
  if (!isRecord(data) || !isBool(data.replayed)) invalid();
  // A replay of a create whose code was deleted since has no promo.
  return { promo: data.promo === null || data.promo === undefined ? null : parsePromo(data.promo), replayed: data.replayed };
}

// =============================================================================
// Error texts
// =============================================================================

export const PROMO_FIELD_TEXT: Readonly<Record<string, string>> = {
  code: 'Код: 3–32 символа, латинские буквы, цифры, «-» и «_», начинается с буквы или цифры.',
  percent: 'Скидка: от 1 до 100 %.',
  max_activations: `Лимит активаций: от 0 (без лимита) до ${PROMO_LIMITS.maxActivations.toLocaleString('ru-RU')}.`,
  valid_hours: `Срок действия скидки: от 1 до ${PROMO_LIMITS.maxValidHours} часов.`,
  expires_at: 'Дата окончания должна быть в будущем.',
  note: `Заметка: не длиннее ${PROMO_LIMITS.maxNote} символов.`,
};

const OPS_REJECTIONS: Readonly<Record<string, string>> = {
  promo_code_taken: 'Такой код уже есть (среди промокодов или персональных купонов прогрева).',
  promo_in_use: 'Код уже активировали: удалить его нельзя, можно только отключить.',
  version_conflict: 'Данные изменили в другой сессии. Обновите страницу.',
  request_key_conflict: 'Запрос конфликтует с ранее отправленным. Повторите действие.',
  invalid_ops_settings: 'Проверьте настройки: час отчёта 0–23, токен бота в формате 123456:ABC…',
  ops_not_configured: 'Некуда отправлять: укажите ID чата или TELEGRAM_ADMIN_ID на сервере.',
  ops_send_failed: 'Telegram не доставил сообщение. Проверьте ID чата, токен и что получатель запустил бота (/start).',
  service_unavailable: 'Раздел не подключён на сервере.',
};

export function opsErrorText(error: unknown): string {
  if (!(error instanceof ApiError)) return errorText(error);
  if (error.code === 'invalid_promo') return PROMO_FIELD_TEXT[error.field] ?? 'Сервер отклонил значение одного из полей.';
  if (error.code === 'not_found' && error.status === 404) return 'Не найдено: возможно, запись уже удалили.';
  if (error.code === 'invalid_request') return 'Сервер отклонил параметры запроса.';
  return OPS_REJECTIONS[error.code] ?? errorText(error);
}

// =============================================================================
// Promo form
// =============================================================================

export interface PromoForm {
  code: string;
  percent: string;
  /** '' or '0' = unlimited. */
  maxActivations: string;
  validHours: string;
  /** datetime-local value ('' = no end). */
  expiresAt: string;
  enabled: boolean;
  note: string;
}

export type PromoField = Exclude<keyof PromoForm, 'enabled'>;
export type PromoErrors = Partial<Record<PromoField, string>>;

/** Server field → form field. */
export const PROMO_SERVER_FIELDS: Readonly<Record<string, PromoField>> = {
  code: 'code', percent: 'percent', max_activations: 'maxActivations', valid_hours: 'validHours', expires_at: 'expiresAt', note: 'note',
};

export const PERCENT_PRESETS = [5, 10, 15, 20, 30, 50, 100] as const;
export const VALID_HOURS_PRESETS = [24, 72, 168, 720] as const;

export const NEW_PROMO_FORM: PromoForm = {
  code: '', percent: '10', maxActivations: '', validHours: '72', expiresAt: '', enabled: true, note: '',
};

const pad = (n: number) => String(n).padStart(2, '0');

/** An ISO time as a datetime-local value in the browser's time zone. */
export function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A datetime-local value as RFC 3339 UTC; null when it is not a date. */
export function fromLocalInput(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function formFromPromo(p: PromoCode): PromoForm {
  return {
    code: p.code, percent: String(p.percent), maxActivations: p.max_activations > 0 ? String(p.max_activations) : '',
    validHours: String(p.valid_hours), expiresAt: toLocalInput(p.expires_at), enabled: p.enabled, note: p.note,
  };
}

export const normalizeCode = (raw: string) => raw.trim().toUpperCase();

function wholeNumber(raw: string): number | null {
  const text = raw.trim().replace(/\s/g, '');
  if (!/^\d{1,9}$/.test(text)) return null;
  return Number(text);
}

/** Random readable code: no 0/O/1/I. */
export function suggestPromoCode(prefix = 'PROMO', random: () => number = Math.random): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let tail = '';
  for (let i = 0; i < 6; i++) tail += alphabet[Math.floor(random() * alphabet.length) % alphabet.length];
  const head = normalizeCode(prefix).replace(/[^A-Z0-9_-]/g, '').slice(0, 20) || 'PROMO';
  return `${head}-${tail}`;
}

/**
 * Validates the form with the server's bounds. editing: the code and the
 * percent are fixed and not checked; the end date may then stay in the past
 * (an expired code being re-enabled must get a new date from the server check).
 */
export function validatePromoForm(form: PromoForm, editing: boolean, now = Date.now()): { input: PromoInput | null; errors: PromoErrors } {
  const errors: PromoErrors = {};
  const code = normalizeCode(form.code);
  if (!editing && !PROMO_LIMITS.codePattern.test(code)) errors.code = PROMO_FIELD_TEXT.code;
  const percent = wholeNumber(form.percent);
  if (!editing && (percent === null || percent < 1 || percent > 100)) errors.percent = PROMO_FIELD_TEXT.percent;
  const max = form.maxActivations.trim() === '' ? 0 : wholeNumber(form.maxActivations);
  if (max === null || max > PROMO_LIMITS.maxActivations) errors.maxActivations = PROMO_FIELD_TEXT.max_activations;
  const hours = wholeNumber(form.validHours);
  if (hours === null || hours < 1 || hours > PROMO_LIMITS.maxValidHours) errors.validHours = PROMO_FIELD_TEXT.valid_hours;
  let expires = '';
  if (form.expiresAt.trim()) {
    const iso = fromLocalInput(form.expiresAt.trim());
    if (iso === null) errors.expiresAt = 'Укажите дату и время окончания.';
    else if (!editing && Date.parse(iso) <= now) errors.expiresAt = PROMO_FIELD_TEXT.expires_at;
    else expires = iso;
  }
  const note = form.note.trim();
  if (Array.from(note).length > PROMO_LIMITS.maxNote) errors.note = PROMO_FIELD_TEXT.note;
  if (Object.keys(errors).length) return { input: null, errors };
  return {
    input: {
      code, percent: percent ?? 0, max_activations: max ?? 0, valid_hours: hours ?? 0, expires_at: expires, enabled: form.enabled, note,
    },
    errors,
  };
}

export const promoPatch = (input: PromoInput): PromoPatch => ({
  max_activations: input.max_activations, valid_hours: input.valid_hours, expires_at: input.expires_at, enabled: input.enabled, note: input.note,
});

// =============================================================================
// Promo labels
// =============================================================================

export const PROMO_STATE_LABELS: Readonly<Record<PromoState, string>> = {
  active: 'Действует', disabled: 'Отключён', expired: 'Истёк', exhausted: 'Лимит исчерпан',
};

export const PROMO_STATE_BADGES: Readonly<Record<PromoState, string>> = {
  active: 'badge badge-ok', disabled: 'badge', expired: 'badge badge-danger', exhausted: 'badge badge-warn',
};

const countFormat = new Intl.NumberFormat('ru-RU');

/** "3 из 100" / "3 · без лимита". */
export function activationsText(p: Pick<PromoCode, 'activations' | 'max_activations'>): string {
  return p.max_activations > 0
    ? `${countFormat.format(p.activations)} из ${countFormat.format(p.max_activations)}`
    : `${countFormat.format(p.activations)} · без лимита`;
}

/** Share of the limit used, 0–100; null without a limit. */
export function activationsShare(p: Pick<PromoCode, 'activations' | 'max_activations'>): number | null {
  if (p.max_activations <= 0) return null;
  return Math.min(100, Math.round((p.activations / p.max_activations) * 100));
}

/** "72 часа" / "3 дня" / "1 неделя" for the discount validity. */
export function validHoursText(hours: number): string {
  if (hours % 168 === 0) {
    const weeks = hours / 168;
    return `${countFormat.format(weeks)} ${pluralRu(weeks, 'неделя', 'недели', 'недель')}`;
  }
  if (hours % 24 === 0) {
    const days = hours / 24;
    return `${countFormat.format(days)} ${pluralRu(days, 'день', 'дня', 'дней')}`;
  }
  return `${countFormat.format(hours)} ${pluralRu(hours, 'час', 'часа', 'часов')}`;
}

/** What a user sees: 199 ₽ with a 20 % discount costs 159,20 ₽ (database.DiscountedAmount). */
export function discountedCents(priceCents: number, percent: number): number {
  if (percent <= 0 || priceCents <= 0) return priceCents;
  if (percent >= 100) return 0;
  return priceCents - Math.floor((priceCents * percent) / 100);
}

export interface PromoTotals { readonly total: number; readonly active: number; readonly activations: number; readonly redeemed: number }

export function promoTotals(list: readonly PromoCode[]): PromoTotals {
  return list.reduce((t, p) => ({
    total: t.total + 1, active: t.active + (p.state === 'active' ? 1 : 0),
    activations: t.activations + p.activations, redeemed: t.redeemed + p.redeemed,
  }), { total: 0, active: 0, activations: 0, redeemed: 0 });
}

/** Conversion of activations into paid orders, "40 %"; '—' without activations. */
export function conversionText(activations: number, redeemed: number): string {
  if (activations <= 0) return '—';
  return `${Math.round((redeemed / activations) * 100)} %`;
}

// =============================================================================
// Events: labels, grouping, report rendering
// =============================================================================

export const SEVERITY_LABELS: Readonly<Record<OpsSeverity, string>> = {
  critical: 'Критично', warning: 'Внимание', ok: 'Восстановлено', info: 'Инфо',
};

/** Health tone of a severity (monitoring.ts HealthTone values). */
export const SEVERITY_TONES: Readonly<Record<OpsSeverity, 'down' | 'warn' | 'ok' | 'info'>> = {
  critical: 'down', warning: 'warn', ok: 'ok', info: 'info',
};

/** Kinds of the feed grouped for the filter (database.OpsKind*). */
export const EVENT_KIND_GROUPS: readonly (readonly [group: string, kinds: readonly (readonly [kind: string, label: string])[]])[] = [
  ['Серверы', [['server_down', 'Сервер недоступен'], ['server_up', 'Сервер восстановлен'], ['server_removed', 'Сервер снят с выдачи']]],
  ['Страны', [['country_down', 'Страна недоступна'], ['country_degraded', 'Страна работает частично'], ['country_up', 'Страна восстановлена'], ['country_removed', 'Страна снята с выдачи']]],
  ['Сборки', [['builder_down', 'Сборка недоступна'], ['builder_up', 'Сборка восстановлена'], ['builder_disabled', 'Сборка отключена']]],
  ['Источники', [['source_failing', 'Источник не загружается'], ['source_recovered', 'Источник снова работает'], ['source_expiring', 'Источник скоро закончится'], ['source_expired', 'Срок источника истёк'], ['source_disabled', 'Источник отключён']]],
  ['Мониторинг', [['monitor_stalled', 'Проверки остановились'], ['monitor_recovered', 'Проверки возобновились']]],
  ['Отчёты', [['daily_report', 'Итоги дня'], ['test', 'Проверка уведомлений']]],
];

const KIND_LABELS: Readonly<Record<string, string>> = Object.fromEntries(EVENT_KIND_GROUPS.flatMap(([, kinds]) => kinds));
export const kindLabel = (kind: string) => KIND_LABELS[kind] ?? kind;

/** What the event is about, for its icon: server, country, builder, source, report, monitor. */
export function kindSubject(kind: string): 'server' | 'country' | 'builder' | 'source' | 'report' | 'monitor' {
  if (kind.startsWith('server_')) return 'server';
  if (kind.startsWith('country_')) return 'country';
  if (kind.startsWith('builder_')) return 'builder';
  if (kind.startsWith('source_')) return 'source';
  if (kind.startsWith('monitor_')) return 'monitor';
  return 'report';
}

export const NOTIFY_LABELS: Readonly<Record<string, string>> = {
  pending: 'Ждёт отправки', sent: 'Отправлено в Telegram', failed: 'Не доставлено', skipped: 'Без уведомления',
};

/** "Сегодня", "Вчера" or "12 ноября 2026" of a moment in the browser's time zone. */
export function dayLabel(iso: string, now = Date.now()): string {
  const d = new Date(iso);
  const n = new Date(now);
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  if (day === new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime()) return 'Сегодня';
  if (day === new Date(n.getFullYear(), n.getMonth(), n.getDate() - 1).getTime()) return 'Вчера';
  return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }).format(d);
}

/** Events split into consecutive days (the feed is newest first). */
export function groupByDay<T extends { created_at: string }>(events: readonly T[], now = Date.now()): { label: string; events: T[] }[] {
  const groups: { label: string; events: T[] }[] = [];
  for (const ev of events) {
    const label = dayLabel(ev.created_at, now);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.events.push(ev);
    else groups.push({ label, events: [ev] });
  }
  return groups;
}

const ENTITIES: Readonly<Record<string, string>> = { '&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"', '&#39;': "'", '&#34;': '"' };

/** Telegram HTML as plain text (tags dropped, the four escapes decoded); shown via textContent only. */
export function telegramPlainText(html: string): string {
  return html.replace(/<[^>]*>/g, '').replace(/&(lt|gt|amp|quot|#39|#34);/g, entity => ENTITIES[entity] ?? entity);
}

/** formatOpsMoney of the server: "3 618 ₽ · 250 ★"; "0 ₽" without sales. */
export function formatMoney(list: readonly OpsMoney[]): string {
  if (list.length === 0) return '0 ₽';
  return list.map(m => {
    if (m.currency.toUpperCase() === 'XTR') return `${countFormat.format(m.amount_cents)} ★`;
    const major = m.amount_cents / 100;
    const text = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: m.amount_cents % 100 === 0 ? 0 : 2, maximumFractionDigits: 2 }).format(major);
    return m.currency.toUpperCase() === 'RUB' ? `${text} ₽` : `${text} ${m.currency}`;
  }).join(' · ');
}

export const ordersOf = (list: readonly OpsMoney[]) => list.reduce((n, m) => n + m.orders, 0);

export interface ReportFigure {
  readonly label: string;
  readonly value: string;
  readonly note?: string;
  /** A figure that needs attention (red) or is good news (green). */
  readonly tone?: 'ok' | 'warn' | 'down';
}

/** The figures of the report cards, in the order of the Telegram message. */
export function reportFigures(s: OpsDailyStats): { business: ReportFigure[]; infra: ReportFigure[] } {
  const c = (n: number) => countFormat.format(n);
  const signed = (n: number) => (n > 0 ? `+${c(n)}` : c(n));
  const business: ReportFigure[] = [
    { label: 'Пользователей', value: c(s.users_total), note: `за день ${signed(s.users_new)}`, tone: s.users_new > 0 ? 'ok' : undefined },
    { label: 'Активных подписок', value: c(s.active_subscriptions), note: `платных: ${c(s.paid_active_subscriptions)}` },
    { label: 'Продаж за день', value: formatMoney(s.period_revenue), note: `оплат: ${c(ordersOf(s.period_revenue))}`, tone: ordersOf(s.period_revenue) > 0 ? 'ok' : undefined },
    { label: 'Оборот за всё время', value: formatMoney(s.total_revenue) },
    { label: 'Подписок оформлено', value: c(s.purchases), note: `продлений: ${c(s.renewals)}${s.free_activations > 0 ? ` · без оплаты: ${c(s.free_activations)}` : ''}` },
    { label: 'Пробных активаций', value: c(s.trials_started), note: `привязано к Telegram: ${c(s.trials_bound)}` },
    { label: 'Подключались к VPN', value: c(s.connected) },
    { label: 'Промокоды', value: c(s.promo_activations), note: `оплачено со скидкой: ${c(s.promo_redemptions)}` },
    { label: 'Истекло подписок', value: c(s.expired), note: s.refunds > 0 ? `возвратов: ${c(s.refunds)}` : undefined, tone: s.refunds > 0 ? 'warn' : undefined },
    { label: 'Платных истекает за 3 дня', value: c(s.expiring_in_3_days), tone: s.expiring_in_3_days > 0 ? 'warn' : undefined },
    { label: 'Не завершили оплату', value: c(s.pending_orders), tone: s.pending_orders > 0 ? 'warn' : undefined },
    { label: 'Сообщений прогрева', value: c(s.warmup_sent) },
  ];
  const infra: ReportFigure[] = [
    { label: 'Открытых инцидентов', value: c(s.open_incidents), tone: s.open_incidents > 0 ? 'down' : 'ok' },
    { label: 'Инцидентов за день', value: c(s.incidents_country + s.incidents_server), note: `стран ${c(s.incidents_country)} · серверов ${c(s.incidents_server)}`, tone: s.incidents_country + s.incidents_server > 0 ? 'warn' : 'ok' },
    { label: 'Источников', value: c(s.sources_total), note: `не работает: ${c(s.sources_unusable)}`, tone: s.sources_unusable > 0 ? 'down' : 'ok' },
    { label: 'Сборок включено', value: c(s.builders_enabled) },
  ];
  return { business, infra };
}

// =============================================================================
// Telegram settings form
// =============================================================================

export interface OpsForm {
  enabled: boolean;
  chatId: string;
  /** '' keeps the stored token; the "use the main bot" switch clears it. */
  botToken: string;
  useMainBot: boolean;
  notifyServers: boolean;
  notifyCountries: boolean;
  notifySources: boolean;
  dailyReport: boolean;
  dailyReportHour: string;
}

export type OpsField = 'chatId' | 'botToken' | 'dailyReportHour';

export const opsForm = (s: OpsSettings): OpsForm => ({
  enabled: s.enabled, chatId: s.chat_id !== 0 ? String(s.chat_id) : '', botToken: '', useMainBot: !s.own_bot,
  notifyServers: s.notify_servers, notifyCountries: s.notify_countries, notifySources: s.notify_sources,
  dailyReport: s.daily_report, dailyReportHour: String(s.daily_report_hour),
});

export const sameOpsForm = (a: OpsForm, b: OpsForm) => JSON.stringify(a) === JSON.stringify(b);

export const BOT_TOKEN_PATTERN = /^[0-9]{5,15}:[A-Za-z0-9_-]{30,64}$/;

/** Builds the PUT body; the token is sent only when it changes. */
export function opsSave(form: OpsForm, settings: OpsSettings): { save: OpsSettingsSave | null; errors: Partial<Record<OpsField, string>> } {
  const errors: Partial<Record<OpsField, string>> = {};
  const chatText = form.chatId.trim();
  let chatId = 0;
  if (chatText) {
    if (!/^-?\d{1,16}$/.test(chatText) || !Number.isSafeInteger(Number(chatText)) || Number(chatText) === 0) {
      errors.chatId = 'ID чата — целое число, например 123456789 или -1001234567890 для группы.';
    } else chatId = Number(chatText);
  }
  const token = form.botToken.trim();
  if (!form.useMainBot && token && !BOT_TOKEN_PATTERN.test(token)) errors.botToken = 'Токен выглядит как 123456789:AAE… (его выдаёт @BotFather).';
  if (!form.useMainBot && !token && !settings.own_bot) errors.botToken = 'Вставьте токен отдельного бота или выберите основной бот.';
  const hour = Number(form.dailyReportHour);
  if (!/^\d{1,2}$/.test(form.dailyReportHour.trim()) || hour < 0 || hour > 23) errors.dailyReportHour = 'Час отчёта: от 0 до 23 (по Москве).';
  if (Object.keys(errors).length) return { save: null, errors };
  let botToken: string | undefined;
  if (form.useMainBot) botToken = settings.own_bot ? '' : undefined;
  else if (token) botToken = token;
  return {
    save: {
      version: settings.version, enabled: form.enabled, chat_id: chatId, ...(botToken !== undefined ? { bot_token: botToken } : {}),
      notify_servers: form.notifyServers, notify_countries: form.notifyCountries, notify_sources: form.notifySources,
      daily_report: form.dailyReport, daily_report_hour: hour,
    },
    errors,
  };
}

// =============================================================================
// Routes: #/promos, #/events, #/events/report, #/events/telegram
// =============================================================================

export const EVENTS_TABS = ['feed', 'report', 'telegram'] as const;
export type EventsTab = (typeof EVENTS_TABS)[number];

export const EVENTS_TAB_LABELS: Readonly<Record<EventsTab, string>> = {
  feed: 'Лента событий', report: 'Итоги дня', telegram: 'Уведомления в Telegram',
};

export function parseEventsTab(path: string): EventsTab | null {
  if (path === 'events') return 'feed';
  const match = /^events\/(report|telegram)$/.exec(path);
  return match ? match[1] as EventsTab : path.startsWith('events/') ? 'feed' : null;
}

export const eventsHash = (tab: EventsTab) => (tab === 'feed' ? '#/events' : `#/events/${tab}`);

/** A screen of ops-ui.ts: the promo codes, or one tab of the events section. */
export type OpsRoute = { readonly view: 'promos' } | { readonly view: 'events'; readonly tab: EventsTab };

/** The route of a hash path ("promos", "events/report"); null when the path belongs to another section. */
export function parseOpsRoute(path: string): OpsRoute | null {
  if (path === 'promos' || path.startsWith('promos/')) return { view: 'promos' };
  const tab = parseEventsTab(path);
  return tab ? { view: 'events', tab } : null;
}

export const opsHash = (route: OpsRoute) => (route.view === 'promos' ? '#/promos' : eventsHash(route.tab));

/** "2026-11-12" (the Moscow day of a report) as "12.11.2026"; the input when it is not a day. */
export function reportDayText(day: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  return match ? `${match[3]}.${match[2]}.${match[1]}` : day;
}
