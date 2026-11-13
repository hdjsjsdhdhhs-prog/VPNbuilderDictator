// Pure logic of the network monitor screens ("Мониторинг"): status and error
// labels, time/duration formatting, filters and the latency chart geometry.
// No DOM here; covered by tests/admin-monitoring.test.ts.
import type {
  MonitorBuilderSummary, MonitorCountry, MonitorLatencyPoint, MonitorNode, MonitorOverview, MonitorStatus, MonitorTransition,
} from './api';
import { pluralRu } from './tariffs';

const countFormat = new Intl.NumberFormat('ru-RU');

export const STATUS_LABELS: Readonly<Record<MonitorStatus, string>> = {
  up: 'Работает',
  degraded: 'Частично',
  down: 'Недоступен',
  unknown: 'Нет данных',
  disabled: 'Отключён',
};

/** Badge modifier of a status (style.css .badge-*): green means "works". */
export const STATUS_BADGES: Readonly<Record<MonitorStatus, string>> = {
  up: 'badge badge-ok',
  degraded: 'badge badge-warn',
  down: 'badge badge-danger',
  unknown: 'badge',
  disabled: 'badge',
};

/**
 * Colour of a state, the same everywhere on the monitor screens: ok is green,
 * warn is yellow, down is red, unknown and off are neutral. Colour never
 * stands alone: every marker has a text label or an accessible name.
 */
export type HealthTone = 'ok' | 'warn' | 'down' | 'unknown' | 'off';

export const STATUS_TONES: Readonly<Record<MonitorStatus, HealthTone>> = {
  up: 'ok', degraded: 'warn', down: 'down', unknown: 'unknown', disabled: 'off',
};

/** Statuses offered by the status filter (a builder may also be disabled). */
export const FILTER_STATUSES: readonly MonitorStatus[] = ['up', 'degraded', 'down', 'unknown'];

/** netmon.ErrCode*: stable, credential-free failure codes. */
const ERROR_LABELS: Readonly<Record<string, string>> = {
  dns: 'Имя не разрешается (DNS)',
  timeout: 'Нет ответа (таймаут)',
  refused: 'Соединение отклонено',
  unreachable: 'Сеть недоступна',
  reset: 'Соединение сброшено',
  tls_handshake: 'TLS-handshake не прошёл',
  quic_handshake: 'QUIC-handshake не прошёл',
  obfs_key_missing: 'Нет ключа обфускации',
  unsupported: 'Протокол не проверяется',
  network_error: 'Сетевая ошибка',
};

export const errorLabel = (code: string) => (code ? ERROR_LABELS[code] ?? code : '');

const PROTOCOL_LABELS: Readonly<Record<string, string>> = {
  vless: 'VLESS', vmess: 'VMess', trojan: 'Trojan', shadowsocks: 'Shadowsocks', hysteria2: 'Hysteria2',
  hysteria: 'Hysteria', tuic: 'TUIC',
};

export const protocolLabel = (protocol: string) => PROTOCOL_LABELS[protocol] ?? protocol;

/** What the probe of a server proves (doc/network-monitoring.md). */
const PROBE_LABELS: Readonly<Record<string, string>> = {
  tcp: 'TCP connect',
  tls: 'TLS handshake',
  quic: 'QUIC handshake',
  unsupported: 'Не проверяется',
};

export const probeLabel = (probe: string) => PROBE_LABELS[probe] ?? probe;

/** Transport and security of a server, e.g. "tcp · reality". */
export function transportLabel(node: Pick<MonitorNode, 'transport' | 'security'>): string {
  const parts = [node.transport];
  if (node.security && node.security !== 'none') parts.push(node.security);
  return parts.filter(Boolean).join(' · ');
}

let regionNames: Intl.DisplayNames | null = null;
function regionName(code: string): string {
  try {
    regionNames ??= new Intl.DisplayNames(['ru'], { type: 'region' });
    return regionNames.of(code) ?? '';
  } catch {
    return '';
  }
}

/** "DE · Германия"; '' is the group of servers without a country. */
export function monitorCountryLabel(code: string): string {
  if (!code) return 'Без страны';
  if (!/^[A-Z]{2}$/.test(code)) return code;
  const name = regionName(code);
  return name && name !== code ? `${code} · ${name}` : code;
}

export const formatLatency = (ms: number | null) => (ms === null ? '—' : `${countFormat.format(ms)} мс`);

/** "12 с назад", "5 мин назад", …; null means never. */
export function formatAgo(iso: string | null, now: number, never = 'Не проверялся'): string {
  if (!iso) return never;
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 5) return 'только что';
  if (seconds < 60) return `${seconds} с назад`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ч назад`;
  const days = Math.floor(hours / 24);
  return `${countFormat.format(days)} ${pluralRu(days, 'день', 'дня', 'дней')} назад`;
}

/** Outage length: "45 с", "12 мин", "2 ч 5 мин", "3 дн 4 ч". */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s} с`;
  const minutes = Math.floor(s / 60);
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  const restMin = minutes % 60;
  if (hours < 24) return restMin ? `${hours} ч ${restMin} мин` : `${hours} ч`;
  const days = Math.floor(hours / 24);
  const restH = hours % 24;
  return restH ? `${days} дн ${restH} ч` : `${days} дн`;
}

export function formatAvailability(percent: number | null): string {
  if (percent === null) return '—';
  if (percent >= 100) return '100 %';
  // Never round a real outage up to 100 %. The epsilon only absorbs binary
  // representation error (99.3 * 100 = 9929.999…), it never rounds up a real value.
  const floored = Math.floor(percent * 100 + 1e-9) / 100;
  return `${floored.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} %`;
}

const TRANSITION_TEXT: Readonly<Record<string, string>> = {
  down: 'недоступна',
  degraded: 'работает частично',
  up: 'восстановлена',
  removed: 'больше не выдаётся',
};

/** "DE · Германия: недоступна". */
export function transitionText(t: MonitorTransition | null): string {
  if (!t) return 'Переходов не было';
  return `${monitorCountryLabel(t.country_code)}: ${TRANSITION_TEXT[t.event] ?? t.event}`;
}

export const outageKindLabel = (kind: string) => (kind === 'degraded' ? 'Частичный сбой' : 'Недоступность');

const END_REASONS: Readonly<Record<string, string>> = {
  recovered: 'Восстановлено',
  changed: 'Сменился тип сбоя',
  removed: 'Снято с выдачи',
};

export const endReasonLabel = (outage: { ongoing: boolean; end_reason: string }) =>
  (outage.ongoing ? 'Продолжается' : END_REASONS[outage.end_reason] ?? outage.end_reason);

// ---------------------------------------------------------------------------
// Filters of the builder page (in memory, never in the URL)

export interface MonitorFilter {
  /** '' = every country; '-' = servers without a country. */
  readonly country: string;
  readonly status: MonitorStatus | '';
  readonly protocol: string;
}

export const EMPTY_MONITOR_FILTER: MonitorFilter = { country: '', status: '', protocol: '' };

export const isFiltered = (f: MonitorFilter) => f.country !== '' || f.status !== '' || f.protocol !== '';

/**
 * Country and status filter the countries; protocol filters the servers of a
 * country, and a country without a matching server is hidden.
 */
export function filterCountries(countries: readonly MonitorCountry[], f: MonitorFilter): MonitorCountry[] {
  const out: MonitorCountry[] = [];
  for (const c of countries) {
    if (f.country && (f.country === '-' ? c.country_code !== '' : c.country_code !== f.country)) continue;
    if (f.status && c.status !== f.status) continue;
    const nodes = f.protocol ? c.nodes.filter(n => n.protocol === f.protocol) : c.nodes;
    if (nodes.length === 0) continue;
    out.push(nodes === c.nodes ? c : { ...c, nodes });
  }
  return out;
}

export function protocolsOf(countries: readonly MonitorCountry[]): string[] {
  const set = new Set<string>();
  for (const c of countries) for (const n of c.nodes) set.add(n.protocol);
  return [...set].sort((a, b) => protocolLabel(a).localeCompare(protocolLabel(b)));
}

// ---------------------------------------------------------------------------
// Health at a glance: one verdict for the whole network, the share of servers
// per state and the availability strip under the latency chart.

/** Rounds missed before the monitor is reported as not checking (service.opsStalledRounds). */
export const STALLED_ROUNDS = 10;

type OverviewInput = Pick<MonitorOverview, 'enabled' | 'interval_seconds' | 'last_round_at' | 'builders'>;

/** The checks are enabled but the last round is too old: every status is stale. */
export function monitorStalled(o: Pick<MonitorOverview, 'enabled' | 'interval_seconds' | 'last_round_at'>, now: number): boolean {
  if (!o.enabled || o.interval_seconds <= 0 || !o.last_round_at) return false;
  return now - Date.parse(o.last_round_at) > o.interval_seconds * STALLED_ROUNDS * 1000;
}

export interface HealthSummary {
  readonly tone: HealthTone;
  readonly title: string;
  readonly text: string;
  /** Enabled builders only: a disabled builder serves nothing and is not checked. */
  readonly builders: number;
  readonly buildersOk: number;
  readonly nodes: number;
  readonly nodesUp: number;
  readonly nodesDown: number;
  readonly nodesUnknown: number;
  readonly countries: number;
  readonly countriesUp: number;
}

const serversWord = (n: number) => pluralRu(n, 'сервер', 'сервера', 'серверов');
const buildersWord = (n: number) => pluralRu(n, 'построитель', 'построителя', 'построителей');

/**
 * The verdict of the overview. Green only when every enabled builder is up,
 * every served server answers and the checks are actually running; a stopped
 * monitor is never green.
 */
export function overviewHealth(o: OverviewInput, now: number): HealthSummary {
  const active = o.builders.filter(b => b.enabled && b.status !== 'disabled');
  const sum = (pick: (b: MonitorBuilderSummary) => number) => active.reduce((total, b) => total + pick(b), 0);
  const counts = {
    builders: active.length,
    buildersOk: active.filter(b => b.status === 'up').length,
    nodes: sum(b => b.nodes_total), nodesUp: sum(b => b.nodes_up), nodesDown: sum(b => b.nodes_down), nodesUnknown: sum(b => b.nodes_unknown),
    countries: sum(b => b.countries_total), countriesUp: sum(b => b.countries_up),
  };
  const verdict = (tone: HealthTone, title: string, text: string): HealthSummary => ({ tone, title, text, ...counts });

  if (active.length === 0) {
    return verdict('off', 'Нет включённых построителей', 'Проверять нечего: серверы клиентам сейчас не выдаются.');
  }
  if (!o.enabled) {
    return verdict('unknown', 'Проверки отключены', 'Фоновые проверки выключены в конфигурации: ниже последнее сохранённое состояние.');
  }
  if (monitorStalled(o, now)) {
    return verdict('unknown', 'Проверки не идут',
      `Последний раунд был ${formatAgo(o.last_round_at, now)}. Статусы ниже могут быть устаревшими.`);
  }
  const down = active.filter(b => b.status === 'down');
  if (down.length > 0) {
    return verdict('down', `Недоступно: ${countFormat.format(down.length)} ${buildersWord(down.length)}`,
      'У этих построителей не отвечает ни один сервер: их клиенты остались без VPN.');
  }
  const sourceErrors = sum(b => b.source_errors);
  if (counts.nodesDown > 0 || sourceErrors > 0 || active.some(b => b.status === 'degraded')) {
    const parts: string[] = [];
    if (counts.nodesDown > 0) parts.push(`не отвечает ${countFormat.format(counts.nodesDown)} из ${countFormat.format(counts.nodes)} ${serversWord(counts.nodes)}`);
    if (sourceErrors > 0) parts.push(`источников с ошибкой загрузки: ${countFormat.format(sourceErrors)}`);
    const text = parts.length ? `${parts.join(', ')}.` : 'Часть стран работает частично.';
    return verdict('warn', 'Есть сбои', `${text.charAt(0).toUpperCase()}${text.slice(1)} Клиенты подключаются через остальные серверы.`);
  }
  if (counts.nodes === 0 || counts.nodesUp < counts.nodes) {
    return verdict('unknown', 'Нет данных проверки',
      counts.nodes === 0 ? 'Построители пока не выдают серверов с проверяемым адресом.' : 'Часть серверов ещё не проверена: дождитесь следующего раунда.');
  }
  return verdict('ok', 'Всё работает',
    `Отвечают все ${countFormat.format(counts.nodes)} ${serversWord(counts.nodes)} в ${countFormat.format(counts.builders)} ${pluralRu(counts.builders, 'построителе', 'построителях', 'построителях')}.`);
}

export interface HealthSegment {
  readonly tone: 'ok' | 'down' | 'unknown';
  readonly count: number;
  /** Percent of the bar, 0–100. */
  readonly share: number;
}

/** Servers per state as shares of a bar; states without servers are omitted. */
export function healthSegments(up: number, down: number, unknown: number): HealthSegment[] {
  const total = up + down + unknown;
  if (total <= 0) return [];
  const raw: readonly (readonly [HealthSegment['tone'], number])[] = [['ok', up], ['down', down], ['unknown', unknown]];
  return raw.filter(([, count]) => count > 0).map(([tone, count]) => ({ tone, count, share: Math.round((count / total) * 1000) / 10 }));
}

/** Accessible name of a health bar: "работают 5, недоступны 1, нет данных 2". */
export function healthBarLabel(up: number, down: number, unknown: number): string {
  const parts = [`работают ${countFormat.format(up)}`];
  if (down > 0) parts.push(`недоступны ${countFormat.format(down)}`);
  if (unknown > 0) parts.push(`нет данных ${countFormat.format(unknown)}`);
  return parts.join(', ');
}

export interface UptimeCell {
  readonly tone: 'ok' | 'warn' | 'down' | 'unknown';
  /** Bounds of the cell in epoch milliseconds. */
  readonly from: number;
  readonly to: number;
  readonly checks: number;
  readonly failures: number;
}

/**
 * The availability strip: the period cut into equal cells, each coloured by
 * the checks that fell into it — green (all passed), yellow (some failed),
 * red (all failed), neutral (no checks).
 */
export function uptimeCells(points: readonly MonitorLatencyPoint[], from: string, to: string, stepSeconds: number, maxCells = 96): UptimeCell[] {
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || maxCells <= 0) return [];
  const span = end - start;
  const steps = stepSeconds > 0 ? Math.ceil(span / (stepSeconds * 1000)) : maxCells;
  const count = Math.max(1, Math.min(maxCells, steps));
  const width = span / count;
  const cells = Array.from({ length: count }, (_, i) => ({ checks: 0, failures: 0, from: start + i * width, to: start + (i + 1) * width }));
  for (const p of points) {
    const at = Date.parse(p.at);
    if (!Number.isFinite(at) || at < start || at > end) continue;
    const cell = cells[Math.min(count - 1, Math.floor((at - start) / width))];
    cell.checks += p.checks;
    cell.failures += p.failures;
  }
  return cells.map(c => ({
    ...c,
    tone: c.checks <= 0 ? 'unknown' : c.failures <= 0 ? 'ok' : c.failures >= c.checks ? 'down' : 'warn',
  }));
}

const UPTIME_TONE_TEXT: Readonly<Record<UptimeCell['tone'], string>> = {
  ok: 'все проверки успешны', warn: 'часть проверок неудачна', down: 'все проверки неудачны', unknown: 'проверок не было',
};

/** Tooltip of a cell: what happened in it (the caller adds the time range). */
export function uptimeCellText(cell: UptimeCell): string {
  const base = UPTIME_TONE_TEXT[cell.tone];
  if (cell.tone === 'unknown' || cell.tone === 'ok') return cell.checks > 0 ? `${base} (${countFormat.format(cell.checks)})` : base;
  return `${base}: ${countFormat.format(cell.failures)} из ${countFormat.format(cell.checks)}`;
}

/** One line under the strip: "Все проверки успешны" or how many cells had failures. */
export function uptimeSummary(cells: readonly UptimeCell[]): { tone: UptimeCell['tone']; text: string } {
  const checked = cells.filter(c => c.tone !== 'unknown');
  if (checked.length === 0) return { tone: 'unknown', text: 'За период проверок не было.' };
  const bad = checked.filter(c => c.tone !== 'ok');
  if (bad.length === 0) return { tone: 'ok', text: 'Все проверки за период успешны.' };
  const tone = bad.some(c => c.tone === 'down') ? 'down' : 'warn';
  return { tone, text: `Интервалов с неудачными проверками: ${countFormat.format(bad.length)} из ${countFormat.format(checked.length)}.` };
}

/** Tone of the availability figure: 100 % is green, under 99 % is red. */
export function availabilityTone(percent: number | null): HealthTone {
  if (percent === null) return 'unknown';
  if (percent >= 100) return 'ok';
  return percent >= 99 ? 'warn' : 'down';
}

// ---------------------------------------------------------------------------
// Latency chart: one polyline of the average per step, scaled into a box.

export interface ChartGeometry {
  /** SVG polyline "x,y x,y …" of the steps with a latency. */
  readonly line: string;
  /** Steps with at least one failed check, as x positions. */
  readonly failures: readonly number[];
  readonly maxMs: number;
}

export function latencyChart(points: readonly MonitorLatencyPoint[], from: string, to: string, width: number, height: number): ChartGeometry {
  const start = Date.parse(from);
  const span = Math.max(1, Date.parse(to) - start);
  let maxMs = 0;
  for (const p of points) if (p.avg_ms !== null && p.avg_ms > maxMs) maxMs = p.avg_ms;
  const scaleMax = maxMs > 0 ? maxMs : 1;
  const x = (iso: string) => Math.min(width, Math.max(0, ((Date.parse(iso) - start) / span) * width));
  const coords: string[] = [];
  const failures: number[] = [];
  for (const p of points) {
    const px = Math.round(x(p.at) * 10) / 10;
    if (p.avg_ms !== null) {
      const py = Math.round((height - (p.avg_ms / scaleMax) * height) * 10) / 10;
      coords.push(`${px},${py}`);
    }
    if (p.failures > 0) failures.push(px);
  }
  return { line: coords.join(' '), failures, maxMs };
}
