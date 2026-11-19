// Pure logic of the source catalogue screens: format labels, sync state and
// error texts, count labels, entry filters, and what the «Сборки» constructor
// shares with them (node resolution, the summary of the server check).
// No DOM here; covered by tests/admin-sources.test.ts.
import type {
  AdminSource, BuilderPreview, DependentRef, FingerprintStatus, SourceCatalogue, SourceDependents, SourceEntry, SourceSyncResult,
} from './api';
import { pluralRu } from './tariffs';

/** ProviderSource.type: the expected response format (database.SourceFormats). */
export const SOURCE_FORMATS = [
  {
    value: 'auto', label: 'Автоопределение',
    hint: 'Формат определяется по ответу провайдера. Подходит почти всегда.',
  },
  {
    value: 'json', label: 'JSON (Xray / 3x-ui)',
    hint: 'JSON-массив полных конфигов Xray (Remnawave, Marzban и т. п.) или серверов 3x-ui.',
  },
  {
    value: 'base64', label: 'Base64-подписка',
    hint: 'Ссылки vless://, vmess://, trojan://, ss://, hysteria2://, закодированные в base64 (формат v2rayN, Happ, v2rayTun).',
  },
  {
    value: 'plain', label: 'Список ссылок',
    hint: 'Те же ссылки без кодирования, по одной на строку.',
  },
  {
    value: 'clash', label: 'Clash / Mihomo (YAML)',
    hint: 'YAML-конфиг с разделом proxies.',
  },
] as const;

export type SourceFormat = typeof SOURCE_FORMATS[number]['value'];

const FORMAT_VALUES: readonly string[] = SOURCE_FORMATS.map(f => f.value);

/** Legacy free-text types never had a runtime meaning: they read as auto. */
export const normalizeFormat = (type: string): SourceFormat =>
  (FORMAT_VALUES.includes(type) ? type : 'auto') as SourceFormat;

export const formatLabel = (type: string) => SOURCE_FORMATS.find(f => f.value === normalizeFormat(type))!.label;

/** Detected format of a sync result (json | base64 | plain | clash). */
export const detectedFormatLabel = (format: string) =>
  SOURCE_FORMATS.find(f => f.value === format && f.value !== 'auto')?.label ?? format;

const countFormat = new Intl.NumberFormat('ru-RU');
export const serversLabel = (n: number) => `${countFormat.format(n)} ${pluralRu(n, 'сервер', 'сервера', 'серверов')}`;
export const countriesLabel = (n: number) => `${countFormat.format(n)} ${pluralRu(n, 'страна', 'страны', 'стран')}`;
export const catalogueSummary = (c: SourceCatalogue) => `${serversLabel(c.entries)} · ${countriesLabel(c.countries)}`;

export type SyncState = 'never' | 'ok' | 'partial' | 'error';

export function syncState(src: Pick<AdminSource, 'last_sync_at' | 'last_sync_status'>): SyncState {
  if (!src.last_sync_at) return 'never';
  switch (src.last_sync_status) {
    case 'ok': return 'ok';
    case 'partial': return 'partial';
    // Pre-catalogue values ("fetch_error", "parse_error", ...) were failures too.
    default: return 'error';
  }
}

export const SYNC_STATE_LABELS: Readonly<Record<SyncState, string>> = {
  never: 'Не синхронизирован',
  ok: 'Синхронизирован',
  partial: 'Синхронизирован частично',
  error: 'Ошибка синхронизации',
};

/** Human text for a stable sync code (service.SourceSyncResult.error). */
export function syncErrorText(code: string): string {
  if (!code) return '';
  const skipped = /^skipped:(\d+)$/.exec(code);
  if (skipped) return `Не удалось разобрать ${serversLabel(Number(skipped[1]))} из ответа.`;
  const http = /^http_(\d{3})$/.exec(code);
  if (http) return `Источник ответил ошибкой HTTP ${http[1]}.`;
  const mismatch = /^format_mismatch:(\w+)$/.exec(code);
  if (mismatch) return `Ответ пришёл в формате «${detectedFormatLabel(mismatch[1])}», а в источнике указан другой. Выберите «Автоопределение» или правильный формат.`;
  switch (code) {
    case 'invalid_config': return 'Неверные параметры источника: URL, заголовки, HWID или User-Agent.';
    case 'timeout': return 'Источник не ответил вовремя.';
    case 'unreachable': return 'Источник недоступен: не удалось подключиться.';
    case 'read_error': return 'Не удалось прочитать ответ источника.';
    case 'too_large': return 'Ответ источника слишком большой.';
    case 'credential_echo': return 'Ответ содержит переданные учётные данные и отклонён.';
    case 'empty_response': return 'Источник вернул пустой ответ.';
    case 'unknown_format': return 'Не удалось определить формат ответа: это не подписка.';
    case 'no_servers': return 'В ответе нет ни одного сервера.';
    case 'internal': return 'Внутренняя ошибка при синхронизации.';
    default: return `Ошибка синхронизации (${code}).`;
  }
}

export interface SyncMessage { tone: 'success' | 'info' | 'error'; text: string }

/** The notice shown after a sync (initial or manual). */
export function syncResultMessage(r: SourceSyncResult): SyncMessage {
  if (r.status === 'error') {
    const kept = r.total > 0 ? ` Сохранён прежний каталог: ${serversLabel(r.total)}.` : ' Каталог пуст.';
    return { tone: 'error', text: `Синхронизация не удалась. ${syncErrorText(r.error)}${kept}` };
  }
  const parts = [
    `Синхронизировано: ${catalogueSummary(r.source.catalogue)}.`,
    `Добавлено ${countFormat.format(r.added)}, обновлено ${countFormat.format(r.updated)}, исчезло ${countFormat.format(r.removed)}.`,
  ];
  if (r.duplicates > 0) parts.push(`Повторов объединено: ${countFormat.format(r.duplicates)}.`);
  if (r.status === 'partial') parts.push(syncErrorText(r.error));
  return { tone: r.status === 'partial' ? 'info' : 'success', text: parts.join(' ') };
}

// ---------------------------------------------------------------------------
// Validity of a source (provider_sources.expires_at): the end of the provider's
// own subscription. Past it the backend skips the source exactly like a
// disabled one (database.ProviderSource.RequestConfiguration).

/** A source the builders can use right now: switched on and not past its end. */
export const sourceUsable = (s: Pick<AdminSource, 'enabled' | 'expired'>) => s.enabled && !s.expired;

export type ExpiryState = 'none' | 'active' | 'soon' | 'expired';

/** A source that ends within this window is flagged in the list. */
export const EXPIRY_SOON_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * The server flag is authoritative; the local clock only catches a source that
 * ran out while the page was open.
 */
export function expiryState(src: Pick<AdminSource, 'expires_at' | 'expired'>, now: number): ExpiryState {
  if (src.expired) return 'expired';
  const at = src.expires_at ? Date.parse(src.expires_at) : NaN;
  if (Number.isNaN(at)) return 'none';
  if (at <= now) return 'expired';
  return at - now <= EXPIRY_SOON_MS ? 'soon' : 'active';
}

export const EXPIRY_STATE_LABELS: Readonly<Record<Exclude<ExpiryState, 'none' | 'active'>, string>> = {
  soon: 'Скоро истекает',
  expired: 'Срок истёк',
};

// ---------------------------------------------------------------------------
// Deletion: a source may be deleted only while nothing depends on it
// (database.SourceDependents). The backend re-checks. The blocker of a сборка
// is builds.buildDeleteBlocker.

const quoted = (refs: readonly DependentRef[]) => refs.map(r => `«${r.name}»`).join(', ');

/** Why a source cannot be deleted ('' when nothing depends on it). */
export function sourceDeleteBlocker(d: SourceDependents): string {
  const parts: string[] = [];
  if (d.builders.length > 0) {
    parts.push(`${d.builders.length === 1 ? 'используется сборкой' : 'используется сборками'} ${quoted(d.builders)}`);
  }
  if (d.subscriptions > 0) {
    parts.push(`на нём ${pluralRu(d.subscriptions, 'продана', 'проданы', 'продано')} ${countFormat.format(d.subscriptions)} ${pluralRu(d.subscriptions, 'подписка', 'подписки', 'подписок')}`);
  }
  return parts.join('; ');
}

/** Regional-indicator flag for a two-letter code ('' otherwise). */
export function flagEmoji(code: string): string {
  if (!/^[A-Z]{2}$/.test(code)) return '';
  return String.fromCodePoint(...[...code].map(c => 0x1F1E6 + c.charCodeAt(0) - 65));
}

export const shortFingerprint = (fp: string) => (fp.length > 12 ? `${fp.slice(0, 12)}…` : fp);

// ---------------------------------------------------------------------------
// Entry filters (source details)

/** country: '' = all, '-' = entries without a country, else an ISO code. */
export interface EntryFilter { country: string; protocol: string; query: string; showAbsent: boolean }

export const EMPTY_FILTER: EntryFilter = { country: '', protocol: '', query: '', showAbsent: false };

export function filterEntries(entries: readonly SourceEntry[], f: EntryFilter): SourceEntry[] {
  const q = f.query.trim().toLocaleLowerCase('ru-RU');
  return entries.filter(e =>
    (f.showAbsent || e.present) &&
    (f.country === '' || (f.country === '-' ? e.country_code === '' : e.country_code === f.country)) &&
    (f.protocol === '' || e.protocol === f.protocol) &&
    (q === '' || e.original_name.toLocaleLowerCase('ru-RU').includes(q)));
}

export const protocolsOf = (entries: readonly SourceEntry[]) =>
  [...new Set(entries.map(e => e.protocol).filter(Boolean))].sort();

// ---------------------------------------------------------------------------
// Node rules against the real catalogue. The backend (the server check and
// /sub) stays authoritative; these helpers mirror database.MatchOriginalName
// and database.ResolveNodeItem for the live preview of a сборка.

// database.originalNameTiers: exact, then %XX decoding, then "+" as space.
const safeDecode = (s: string, plusAsSpace: boolean) => {
  try { return decodeURIComponent(plusAsSpace ? s.replace(/\+/g, ' ') : s); } catch { return s; }
};
const NAME_TIERS: readonly ((s: string) => string)[] = [
  s => s,
  s => safeDecode(s, false).trim(),
  s => safeDecode(s, true).trim(),
];

/** database.MatchOriginalName: indexes of names matching want. */
export function matchOriginalName(want: string, names: readonly string[]): number[] {
  if (want === '') return [];
  for (const norm of NAME_TIERS) {
    const target = norm(want);
    if (target === '') continue;
    const out: number[] = [];
    names.forEach((n, i) => { if (norm(n) === target) out.push(i); });
    if (out.length > 0) return out;
  }
  return [];
}

export interface NodeResolution { status: FingerprintStatus; entry: SourceEntry | null }

/** database.ResolveNodeItem against present entries: fingerprint, then a unique name. */
export function resolveNode(fingerprint: string, originalName: string, entries: readonly SourceEntry[]): NodeResolution {
  const present = entries.filter(e => e.present);
  if (fingerprint) {
    const hit = present.find(e => e.fingerprint === fingerprint);
    if (hit) return { status: 'matched', entry: hit };
  }
  const matches = matchOriginalName(originalName, present.map(e => e.original_name));
  if (matches.length === 1) return { status: 'fallback', entry: present[matches[0]] };
  return { status: matches.length === 0 ? 'missing' : 'conflict', entry: null };
}

export interface PreviewSummary {
  /** Output servers (matched + fallback), as /sub would serve them now. */
  servers: number;
  countries: number;
  /** Output servers per source id, in first-seen order. */
  bySource: { sourceId: number; count: number }[];
}

export function previewSummary(preview: Pick<BuilderPreview, 'items'>): PreviewSummary {
  const codes = new Set<string>();
  const per = new Map<number, number>();
  let servers = 0;
  for (const it of preview.items) {
    if (!it.entry || (it.status !== 'matched' && it.status !== 'fallback')) continue;
    servers++;
    if (it.entry.country_code) codes.add(it.entry.country_code);
    per.set(it.source_id, (per.get(it.source_id) ?? 0) + 1);
  }
  return { servers, countries: codes.size, bySource: [...per].map(([sourceId, count]) => ({ sourceId, count })) };
}
