package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"strings"
	"sync"
	"time"

	"github.com/hdjsjsdhdhhs-prog/VPNbuilderDictator/internal/database"
	"github.com/hdjsjsdhdhhs-prog/VPNbuilderDictator/internal/logger"
	"github.com/hdjsjsdhdhhs-prog/VPNbuilderDictator/internal/netmon"

	"go.uber.org/zap"
)

// Operational notifications: what the owner of the service wants to learn
// without opening the panel. One periodic pass (OpsService.Tick):
//
//  1. turns the network monitor's outages (servers, builder countries) into
//     events — an outage opening and its end are one event each;
//  2. watches builders (all countries down, switched off, sources that fail to
//     load) and provider sources (expiring, expired, switched off) and records
//     an event on every change of state;
//  3. once a day (Moscow time) records the report of the previous day;
//  4. delivers the pending events to Telegram, several infrastructure events
//     in one message.
//
// Everything is best-effort background work: a failure is logged and the next
// pass retries; nothing here can affect subscriptions, payments or /sub.
// Events never contain a provider URL or credential — only names, countries,
// protocol and host:port, the same data the "Мониторинг" page shows.

const (
	// opsOutageLookback bounds how far back outages are turned into events.
	opsOutageLookback = 48 * time.Hour
	// opsSourceExpiringWindow: a source ending within it is "expiring".
	opsSourceExpiringWindow = 72 * time.Hour
	// opsEventRetention is how long the feed keeps events.
	opsEventRetention = 90 * 24 * time.Hour
	// opsBatchLimit is how many infrastructure events go into one message.
	opsBatchLimit = 15
	// opsMessageLimit keeps a message below Telegram's 4096 characters.
	opsMessageLimit = 3800
	// opsStalledRounds: the monitor is stalled after this many missed rounds.
	opsStalledRounds = 10
)

// ErrOpsNotConfigured: there is no chat to deliver a notification to.
var ErrOpsNotConfigured = errors.New("ops notifications have no destination")

// OpsRepository is the persistence seam of OpsService.
type OpsRepository interface {
	GetOpsSettings(ctx context.Context) (*database.OpsSettings, error)
	UpdateOpsSettings(ctx context.Context, meta database.AdminConfigMeta, in database.OpsSettingsInput) (*database.AdminConfigResult, error)
	ClaimOpsReportDay(ctx context.Context, day string) (bool, error)
	RecordOpsEvent(ctx context.Context, ev *database.OpsEvent) (bool, error)
	ExistingOpsEventKeys(ctx context.Context, keys []string) (map[string]bool, error)
	PendingOpsEvents(ctx context.Context, limit int) ([]database.OpsEvent, error)
	FinishOpsEvents(ctx context.Context, ids []uint, sendErr string, now time.Time) error
	SkipPendingOpsEvents(ctx context.Context) error
	ListOpsEvents(ctx context.Context, f database.OpsEventFilter) ([]database.OpsEvent, int64, error)
	PruneOpsEvents(ctx context.Context, cutoff time.Time) (int64, error)
	SwapOpsState(ctx context.Context, key, state string, now time.Time) (string, bool, error)
	ListOpsOutages(ctx context.Context, since time.Time, limit int) ([]database.OpsOutage, error)
	OpsDailyStats(ctx context.Context, from, to, now time.Time) (*database.OpsDailyStats, error)
	ListOpsSources(ctx context.Context) ([]database.ProviderSource, error)
}

var _ OpsRepository = (*database.Service)(nil)

// OpsMonitor is the part of the network monitor the watch needs.
// *netmon.Service implements it.
type OpsMonitor interface {
	Overview(ctx context.Context) (*netmon.Overview, error)
}

// OpsSender delivers one HTML message. botToken "" means the main bot.
type OpsSender interface {
	SendOps(ctx context.Context, botToken string, chatID int64, html string) error
}

// OpsService owns the event feed, its settings and the daily report.
type OpsService struct {
	repo    OpsRepository
	monitor OpsMonitor
	sender  OpsSender
	adminID int64
	now     func() time.Time
	loc     *time.Location

	mu        sync.Mutex
	lastPrune time.Time

	// wake asks the worker for a pass right now (one pending request at most).
	wake chan struct{}
}

// NewOpsService wires the service. adminID is the default destination
// (TELEGRAM_ADMIN_ID); monitor and sender may be nil (set later or absent).
func NewOpsService(repo OpsRepository, monitor OpsMonitor, adminID int64) *OpsService {
	return &OpsService{repo: repo, monitor: monitor, adminID: adminID, now: time.Now, loc: moscowLocation(), wake: make(chan struct{}, 1)}
}

// RequestTick asks the worker to run a pass right away instead of waiting for
// its timer. The network monitor calls it after every check round, so a server
// that went down is reported as soon as the monitor knows. Never blocks;
// requests arriving while one is pending are merged.
func (s *OpsService) RequestTick() {
	select {
	case s.wake <- struct{}{}:
	default:
	}
}

// Wake is the channel RequestTick signals.
func (s *OpsService) Wake() <-chan struct{} { return s.wake }

// moscowLocation is the report time zone; a fixed offset when the zone
// database is unavailable (Moscow has no daylight saving time).
func moscowLocation() *time.Location {
	loc, err := time.LoadLocation("Europe/Moscow")
	if err != nil {
		return time.FixedZone("MSK", 3*60*60)
	}
	return loc
}

// SetSender wires the Telegram sender (after the bot is initialized).
func (s *OpsService) SetSender(sender OpsSender) { s.sender = sender }

// SetClock replaces the clock (tests).
func (s *OpsService) SetClock(now func() time.Time) { s.now = now }

// ---------------------------------------------------------------------------
// Admin views
// ---------------------------------------------------------------------------

// OpsSettingsView is the admin projection of the settings: the bot token is
// never returned, only whether a separate bot is configured.
type OpsSettingsView struct {
	database.OpsSettings

	OwnBot bool `json:"own_bot"`
	// EffectiveChatID is where notifications go (chat_id or the admin ID).
	EffectiveChatID int64 `json:"effective_chat_id"`
}

func (s *OpsService) settingsView(settings *database.OpsSettings) *OpsSettingsView {
	return &OpsSettingsView{OpsSettings: *settings, OwnBot: settings.BotToken != "", EffectiveChatID: s.destination(settings)}
}

func (s *OpsService) destination(settings *database.OpsSettings) int64 {
	if settings.ChatID != 0 {
		return settings.ChatID
	}
	return s.adminID
}

// Settings returns the settings.
func (s *OpsService) Settings(ctx context.Context) (*OpsSettingsView, error) {
	settings, err := s.repo.GetOpsSettings(ctx)
	if err != nil {
		return nil, err
	}
	return s.settingsView(settings), nil
}

// OpsSettingsOutcome is returned by a settings save, including replays.
type OpsSettingsOutcome struct {
	Settings *OpsSettingsView       `json:"settings"`
	Replayed bool                   `json:"replayed"`
	Audit    database.AdminAuditLog `json:"audit"`
}

// UpdateSettings saves the settings.
func (s *OpsService) UpdateSettings(ctx context.Context, actor, requestKey string, in database.OpsSettingsInput) (*OpsSettingsOutcome, error) {
	result, err := s.repo.UpdateOpsSettings(ctx, database.AdminConfigMeta{Actor: actor, RequestKey: requestKey}, in)
	if err != nil {
		return nil, err
	}
	view, err := s.Settings(ctx)
	if err != nil {
		return &OpsSettingsOutcome{Replayed: result.Replayed, Audit: result.Audit}, fmt.Errorf("reload ops settings: %w", err)
	}
	return &OpsSettingsOutcome{Settings: view, Replayed: result.Replayed, Audit: result.Audit}, nil
}

// OpsEventView is one event of the feed with its decoded details.
type OpsEventView struct {
	database.OpsEvent

	Details json.RawMessage `json:"details"`
}

// OpsEventsPage is one page of the feed.
type OpsEventsPage struct {
	Events []OpsEventView `json:"events"`
	Total  int64          `json:"total"`
	Limit  int            `json:"limit"`
	Offset int            `json:"offset"`
}

// Events pages the feed, newest first.
func (s *OpsService) Events(ctx context.Context, f database.OpsEventFilter) (*OpsEventsPage, error) {
	events, total, err := s.repo.ListOpsEvents(ctx, f)
	if err != nil {
		return nil, err
	}
	page := &OpsEventsPage{Events: make([]OpsEventView, 0, len(events)), Total: total, Limit: f.Limit, Offset: f.Offset}
	if page.Limit <= 0 {
		page.Limit = 50
	}
	for _, ev := range events {
		details := json.RawMessage(ev.Details)
		if !json.Valid(details) {
			details = json.RawMessage("{}")
		}
		page.Events = append(page.Events, OpsEventView{OpsEvent: ev, Details: details})
	}
	return page, nil
}

// OpsReport is the daily report: its figures and the Telegram text.
type OpsReport struct {
	Day   string                  `json:"day"`
	Stats *database.OpsDailyStats `json:"stats"`
	Text  string                  `json:"text"`
}

// dayBounds returns [00:00, 24:00) of a Moscow calendar day.
func (s *OpsService) dayBounds(day time.Time) (time.Time, time.Time) {
	local := day.In(s.loc)
	from := time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, s.loc)
	return from, from.AddDate(0, 0, 1)
}

// Report builds the report of a Moscow calendar day. offsetDays 0 is today
// (so far), 1 is yesterday.
func (s *OpsService) Report(ctx context.Context, offsetDays int) (*OpsReport, error) {
	if offsetDays < 0 || offsetDays > 366 {
		return nil, database.ErrAdminInvalidRequest
	}
	now := s.now()
	from, to := s.dayBounds(now.AddDate(0, 0, -offsetDays))
	return s.reportFor(ctx, from, to, now)
}

func (s *OpsService) reportFor(ctx context.Context, from, to, now time.Time) (*OpsReport, error) {
	stats, err := s.repo.OpsDailyStats(ctx, from, to, now)
	if err != nil {
		return nil, err
	}
	return &OpsReport{Day: from.In(s.loc).Format("2006-01-02"), Stats: stats, Text: formatOpsReport(stats, from.In(s.loc))}, nil
}

// SendTest delivers a test message right now. It is a user-initiated
// operation: a delivery failure is returned to the caller.
func (s *OpsService) SendTest(ctx context.Context) error {
	settings, err := s.repo.GetOpsSettings(ctx)
	if err != nil {
		return err
	}
	chatID := s.destination(settings)
	if s.sender == nil || chatID == 0 {
		return ErrOpsNotConfigured
	}
	now := s.now().UTC()
	text := "✅ <b>Проверка уведомлений</b>\n\nСобытия мониторинга и ежедневный отчёт DictatorVPN будут приходить в этот чат."
	sendErr := s.sender.SendOps(ctx, settings.BotToken, chatID, text)
	ev := &database.OpsEvent{
		CreatedAt: now, Kind: database.OpsKindTest, Severity: database.OpsSeverityInfo,
		Title: "Проверка уведомлений", Message: "Тестовое сообщение отправлено из панели.",
		NotifyStatus: database.OpsNotifySent, NotifiedAt: &now,
	}
	if sendErr != nil {
		ev.NotifyStatus, ev.NotifiedAt, ev.NotifyError = database.OpsNotifyFailed, nil, truncateOps(sendErr.Error(), 300)
		ev.Severity, ev.Message = database.OpsSeverityWarning, "Тестовое сообщение не доставлено."
	}
	_, err = s.repo.RecordOpsEvent(ctx, ev)
	if err != nil {
		logger.Warn("Ops: failed to record the test event", zap.Error(err))
	}
	if sendErr != nil {
		return fmt.Errorf("send ops test: %w", sendErr)
	}
	return nil
}

// ---------------------------------------------------------------------------
// Periodic pass
// ---------------------------------------------------------------------------

// Tick runs one pass. Each step is independent: a failed step is reported in
// the joined error and does not stop the others.
func (s *OpsService) Tick(ctx context.Context) error {
	settings, err := s.repo.GetOpsSettings(ctx)
	if err != nil {
		return err
	}
	now := s.now().UTC()
	var errs []error
	for _, step := range []struct {
		name string
		run  func(context.Context, *database.OpsSettings, time.Time) error
	}{
		{"outages", s.collectOutages},
		{"builders", s.watchBuilders},
		{"sources", s.watchSources},
		{"report", s.dailyReport},
		{"deliver", s.deliver},
		{"prune", s.prune},
	} {
		if ctx.Err() != nil {
			errs = append(errs, ctx.Err())
			break
		}
		err := step.run(ctx, settings, now)
		if err != nil {
			errs = append(errs, fmt.Errorf("%s: %w", step.name, err))
		}
	}
	return errors.Join(errs...)
}

// record stores an event. notify decides whether it is delivered.
func (s *OpsService) record(ctx context.Context, ev *database.OpsEvent, notify bool, details map[string]any) error {
	if !notify {
		ev.NotifyStatus = database.OpsNotifySkipped
	}
	if len(details) > 0 {
		encoded, err := json.Marshal(details)
		if err == nil {
			ev.Details = string(encoded)
		}
	}
	_, err := s.repo.RecordOpsEvent(ctx, ev)
	return err
}

func opsKey(format string, args ...any) *string {
	key := fmt.Sprintf(format, args...)
	return &key
}

// collectOutages turns monitor outages into events: one when an outage
// opens, one when it ends. Outages from before the baseline are history and
// produce no "opened" event.
func (s *OpsService) collectOutages(ctx context.Context, settings *database.OpsSettings, now time.Time) error {
	since := now.Add(-opsOutageLookback)
	if settings.BaselineAt.After(since) {
		since = settings.BaselineAt
	}
	outages, err := s.repo.ListOpsOutages(ctx, since, 0)
	if err != nil || len(outages) == 0 {
		return err
	}
	keys := make([]string, 0, len(outages)*2)
	for _, o := range outages {
		keys = append(keys, fmt.Sprintf("outage:%d:open", o.ID), fmt.Sprintf("outage:%d:close", o.ID))
	}
	known, err := s.repo.ExistingOpsEventKeys(ctx, keys)
	if err != nil {
		return err
	}
	var errs []error
	for i := range outages {
		o := &outages[i]
		openKey, closeKey := fmt.Sprintf("outage:%d:open", o.ID), fmt.Sprintf("outage:%d:close", o.ID)
		notify := settings.NotifyCountries
		if o.Scope == database.MonitorScopeTarget {
			notify = settings.NotifyServers
		}
		if !known[openKey] && !o.StartedAt.Before(since) {
			ev := outageOpened(o)
			ev.DedupKey = &openKey
			err := s.record(ctx, ev, notify, outageDetails(o))
			if err != nil {
				errs = append(errs, err)
			}
		}
		// A "changed" end is the same incident turning into another kind; the
		// new kind opens its own outage, so only real ends are reported.
		if o.EndedAt != nil && !known[closeKey] && !o.EndedAt.Before(since) && o.EndReason != database.MonitorEndChanged {
			ev := outageClosed(o)
			ev.DedupKey = &closeKey
			err := s.record(ctx, ev, notify, outageDetails(o))
			if err != nil {
				errs = append(errs, err)
			}
		}
	}
	return errors.Join(errs...)
}

func outageDetails(o *database.OpsOutage) map[string]any {
	d := map[string]any{"outage_id": o.ID, "scope": o.Scope, "kind": o.Kind, "started_at": o.StartedAt}
	if o.EndedAt != nil {
		d["ended_at"], d["end_reason"] = *o.EndedAt, o.EndReason
		d["duration_seconds"] = int64(o.EndedAt.Sub(o.StartedAt) / time.Second)
	}
	if o.ErrorCode != "" {
		d["error_code"] = o.ErrorCode
	}
	if o.Host != "" {
		d["host"], d["port"], d["protocol"] = o.Host, o.Port, o.Protocol
	}
	if o.BuilderName != "" {
		d["builder_name"] = o.BuilderName
	}
	if o.NodeName != "" {
		d["node_name"] = o.NodeName
	}
	return d
}

func opsCountry(code string) string {
	if code == "" {
		return "без страны"
	}
	return code
}

func opsServerName(o *database.OpsOutage) string {
	name := strings.TrimSpace(o.NodeName)
	if name == "" {
		name = "сервер"
	}
	if o.Host != "" {
		name += fmt.Sprintf(" (%s %s:%d)", o.Protocol, o.Host, o.Port)
	}
	return name
}

// opsServedByLimit is how many builder names a server alert spells out.
const opsServedByLimit = 3

// opsServerPlace says which server an alert is about and who is affected:
// "🇩🇪 Berlin (vless host:443) · сборки «Европа», «Все страны» · DE". A server
// is checked once however many builders hand it out, so every one is named;
// a server without a country simply has no country part.
func opsServerPlace(o *database.OpsOutage) string {
	parts := []string{opsServerName(o)}
	names := o.BuilderNames
	if len(names) == 0 && strings.TrimSpace(o.BuilderName) != "" {
		names = []string{o.BuilderName}
	}
	if len(names) > 0 {
		shown := names
		if len(shown) > opsServedByLimit {
			shown = shown[:opsServedByLimit]
		}
		quoted := make([]string, 0, len(shown))
		for _, name := range shown {
			quoted = append(quoted, "«"+name+"»")
		}
		label := "сборка "
		if len(names) > 1 {
			label = "сборки "
		}
		served := label + strings.Join(quoted, ", ")
		if rest := len(names) - len(shown); rest > 0 {
			served += fmt.Sprintf(" и ещё %d", rest)
		}
		parts = append(parts, served)
	}
	if o.CountryCode != "" {
		parts = append(parts, o.CountryCode)
	}
	return strings.Join(parts, " · ")
}

func opsBuilderName(name string, id *uint) string {
	if strings.TrimSpace(name) != "" {
		return "«" + name + "»"
	}
	if id != nil {
		return fmt.Sprintf("#%d", *id)
	}
	return "—"
}

var opsErrorLabels = map[string]string{
	"dns": "имя не разрешается (DNS)", "timeout": "нет ответа (таймаут)", "refused": "соединение отклонено",
	"unreachable": "сеть недоступна", "reset": "соединение сброшено", "tls_handshake": "TLS-handshake не прошёл",
	"quic_handshake": "QUIC-handshake не прошёл", "obfs_key_missing": "нет ключа обфускации", "network_error": "сетевая ошибка",
}

func opsErrorLabel(code string) string {
	if label, ok := opsErrorLabels[code]; ok {
		return label
	}
	return code
}

func outageOpened(o *database.OpsOutage) *database.OpsEvent {
	ev := &database.OpsEvent{
		CreatedAt: o.StartedAt, BuilderID: o.BuilderID, TargetID: o.TargetID, CountryCode: o.CountryCode,
	}
	if o.Scope == database.MonitorScopeTarget {
		ev.Kind, ev.Severity = database.OpsKindServerDown, database.OpsSeverityWarning
		ev.Title = "Сервер недоступен"
		ev.Message = opsServerPlace(o)
		if o.ErrorCode != "" {
			ev.Message += " · причина: " + opsErrorLabel(o.ErrorCode)
		}
		return ev
	}
	where := fmt.Sprintf("сборка %s · страна %s", opsBuilderName(o.BuilderName, o.BuilderID), opsCountry(o.CountryCode))
	if o.Kind == database.MonitorOutageDegraded {
		ev.Kind, ev.Severity, ev.Title = database.OpsKindCountryDegraded, database.OpsSeverityWarning, "Страна работает частично"
		ev.Message = where + " · часть серверов не отвечает"
	} else {
		ev.Kind, ev.Severity, ev.Title = database.OpsKindCountryDown, database.OpsSeverityCritical, "Страна недоступна"
		ev.Message = where + " · не отвечает ни один сервер"
	}
	return ev
}

func outageClosed(o *database.OpsOutage) *database.OpsEvent {
	ev := &database.OpsEvent{
		CreatedAt: *o.EndedAt, BuilderID: o.BuilderID, TargetID: o.TargetID, CountryCode: o.CountryCode,
		Severity: database.OpsSeverityOK,
	}
	duration := "простой " + formatOpsDuration(o.EndedAt.Sub(o.StartedAt))
	removed := o.EndReason == database.MonitorEndRemoved
	if o.Scope == database.MonitorScopeTarget {
		ev.Kind, ev.Title = database.OpsKindServerUp, "Сервер восстановлен"
		ev.Message = opsServerPlace(o) + " · " + duration
		if removed {
			ev.Kind, ev.Severity, ev.Title = database.OpsKindServerRemoved, database.OpsSeverityInfo, "Сервер снят с выдачи"
			ev.Message = fmt.Sprintf("%s больше не выдаётся клиентам и не проверяется (не восстановился)", opsServerName(o))
		}
		return ev
	}
	where := fmt.Sprintf("сборка %s · страна %s", opsBuilderName(o.BuilderName, o.BuilderID), opsCountry(o.CountryCode))
	ev.Kind, ev.Title, ev.Message = database.OpsKindCountryUp, "Страна восстановлена", where+" · "+duration
	if removed {
		ev.Kind, ev.Severity, ev.Title = database.OpsKindCountryRemoved, database.OpsSeverityInfo, "Страна снята с выдачи"
		ev.Message = where + " · больше не выдаётся клиентам"
	}
	return ev
}

// watchBuilders alerts on builder-level changes the outages do not express:
// every country of a builder is down, a builder was switched off, its sources
// fail to load, and a stalled monitor.
func (s *OpsService) watchBuilders(ctx context.Context, settings *database.OpsSettings, now time.Time) error {
	if s.monitor == nil {
		return nil
	}
	overview, err := s.monitor.Overview(ctx)
	if err != nil {
		return err
	}
	var errs []error
	change := func(key, state string) (string, bool) {
		previous, changed, err := s.repo.SwapOpsState(ctx, key, state, now)
		if err != nil {
			errs = append(errs, err)
			return "", false
		}
		return previous, changed
	}
	for i := range overview.Builders {
		b := &overview.Builders[i]
		id := b.ID
		name := opsBuilderName(b.Name, &id)

		// Aggregate status: only "down" (nothing answers) and switching off are
		// builder-level news; partial failures are reported per country.
		state := b.Status
		if state != database.MonitorStatusDown && state != "disabled" {
			state = "serving"
		}
		if previous, changed := change(fmt.Sprintf("builder:%d", b.ID), state); changed {
			var ev *database.OpsEvent
			switch {
			case state == database.MonitorStatusDown:
				ev = &database.OpsEvent{Kind: database.OpsKindBuilderDown, Severity: database.OpsSeverityCritical, Title: "Сборка недоступна",
					Message: fmt.Sprintf("Сборка %s: не отвечает ни один сервер (%d из %d недоступны). Клиенты этой сборки остались без VPN.", name, b.NodesDown, b.NodesTotal)}
			case state == "disabled" && previous != "":
				ev = &database.OpsEvent{Kind: database.OpsKindBuilderDisabled, Severity: database.OpsSeverityInfo, Title: "Сборка отключена",
					Message: fmt.Sprintf("Сборка %s отключена: её серверы не выдаются и не проверяются.", name)}
			case state == "serving" && previous == database.MonitorStatusDown:
				ev = &database.OpsEvent{Kind: database.OpsKindBuilderUp, Severity: database.OpsSeverityOK, Title: "Сборка восстановлена",
					Message: fmt.Sprintf("Сборка %s снова выдаёт рабочие серверы (%d из %d отвечают).", name, b.NodesUp, b.NodesTotal)}
			}
			if ev != nil {
				ev.CreatedAt, ev.BuilderID = now, &id
				err := s.record(ctx, ev, settings.NotifyCountries, map[string]any{"builder_name": b.Name, "nodes_total": b.NodesTotal, "nodes_up": b.NodesUp, "nodes_down": b.NodesDown})
				if err != nil {
					errs = append(errs, err)
				}
			}
		}

		// Sources of the builder that failed to load at the last resolution.
		sourceState := "ok"
		if b.Enabled && b.SourceErrors > 0 {
			sourceState = "failing"
		}
		if previous, changed := change(fmt.Sprintf("builder_sources:%d", b.ID), sourceState); changed {
			var ev *database.OpsEvent
			switch {
			case sourceState == "failing":
				ev = &database.OpsEvent{Kind: database.OpsKindSourceFailing, Severity: database.OpsSeverityWarning, Title: "Источник не загружается",
					Message: fmt.Sprintf("Сборка %s: не удалось загрузить источников — %d. Их серверы могут пропасть из подписки.", name, b.SourceErrors)}
			case previous == "failing":
				ev = &database.OpsEvent{Kind: database.OpsKindSourceRecovered, Severity: database.OpsSeverityOK, Title: "Источники снова загружаются",
					Message: fmt.Sprintf("Сборка %s: все источники загружаются.", name)}
			}
			if ev != nil {
				ev.CreatedAt, ev.BuilderID = now, &id
				err := s.record(ctx, ev, settings.NotifySources, map[string]any{"builder_name": b.Name, "source_errors": b.SourceErrors})
				if err != nil {
					errs = append(errs, err)
				}
			}
		}
	}

	// A monitor that stopped checking makes every green badge meaningless.
	if overview.Enabled && overview.IntervalSeconds > 0 {
		state := "running"
		stalledAfter := time.Duration(overview.IntervalSeconds*opsStalledRounds) * time.Second
		if overview.LastRoundAt != nil && now.Sub(*overview.LastRoundAt) > stalledAfter {
			state = "stalled"
		}
		if previous, changed := change("monitor", state); changed {
			var ev *database.OpsEvent
			if state == "stalled" {
				ev = &database.OpsEvent{Kind: database.OpsKindMonitorStalled, Severity: database.OpsSeverityWarning, Title: "Мониторинг не проверяет серверы",
					Message: fmt.Sprintf("Последняя проверка была %s назад. Статусы на странице «Мониторинг» могут быть устаревшими.", formatOpsDuration(now.Sub(*overview.LastRoundAt)))}
			} else if previous == "stalled" {
				ev = &database.OpsEvent{Kind: database.OpsKindMonitorRecovered, Severity: database.OpsSeverityOK, Title: "Мониторинг снова работает",
					Message: "Проверки серверов возобновились."}
			}
			if ev != nil {
				ev.CreatedAt = now
				err := s.record(ctx, ev, settings.NotifyServers, nil)
				if err != nil {
					errs = append(errs, err)
				}
			}
		}
	}
	return errors.Join(errs...)
}

// opsSourceState classifies a source for the watch.
func opsSourceState(src *database.ProviderSource, now time.Time) string {
	switch {
	case !src.Enabled:
		return "disabled"
	case src.ExpiresAt != nil && !src.ExpiresAt.After(now):
		return "expired"
	case src.ExpiresAt != nil && src.ExpiresAt.Sub(now) <= opsSourceExpiringWindow:
		return "expiring"
	}
	return "ok"
}

// watchSources alerts when a provider source is about to run out of its paid
// term, ran out, was switched off or works again. The first sight of a source
// is silent unless it already needs attention.
func (s *OpsService) watchSources(ctx context.Context, settings *database.OpsSettings, now time.Time) error {
	sources, err := s.repo.ListOpsSources(ctx)
	if err != nil {
		return err
	}
	var errs []error
	for i := range sources {
		src := &sources[i]
		state := opsSourceState(src, now)
		previous, changed, err := s.repo.SwapOpsState(ctx, fmt.Sprintf("source:%d", src.ID), state, now)
		if err != nil {
			errs = append(errs, err)
			continue
		}
		if !changed {
			continue
		}
		id := src.ID
		name := "«" + src.Name + "»"
		var ev *database.OpsEvent
		switch state {
		case "expiring":
			ev = &database.OpsEvent{Kind: database.OpsKindSourceExpiring, Severity: database.OpsSeverityWarning, Title: "Источник скоро закончится",
				Message: fmt.Sprintf("Источник %s действует до %s (МСК), осталось %s. Продлите подписку у провайдера и обновите срок в «Источниках».",
					name, src.ExpiresAt.In(s.loc).Format("02.01.2006 15:04"), formatOpsDuration(src.ExpiresAt.Sub(now)))}
		case "expired":
			ev = &database.OpsEvent{Kind: database.OpsKindSourceExpired, Severity: database.OpsSeverityCritical, Title: "Срок источника истёк",
				Message: fmt.Sprintf("Источник %s больше не используется: его срок закончился %s (МСК). Серверы этого источника исчезли из подписок.",
					name, src.ExpiresAt.In(s.loc).Format("02.01.2006 15:04"))}
		case "disabled":
			if previous != "" {
				ev = &database.OpsEvent{Kind: database.OpsKindSourceDisabled, Severity: database.OpsSeverityInfo, Title: "Источник отключён",
					Message: fmt.Sprintf("Источник %s отключён: его серверы не выдаются.", name)}
			}
		case "ok":
			if previous == "expired" || previous == "disabled" || previous == "expiring" {
				ev = &database.OpsEvent{Kind: database.OpsKindSourceRecovered, Severity: database.OpsSeverityOK, Title: "Источник снова в работе",
					Message: fmt.Sprintf("Источник %s включён и действует.", name)}
			}
		}
		if ev == nil {
			continue
		}
		ev.CreatedAt, ev.SourceID = now, &id
		err = s.record(ctx, ev, settings.NotifySources, map[string]any{"source_name": src.Name, "state": state, "previous": previous})
		if err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

// dailyReport records the report of the previous Moscow day once the report
// hour has come. The claim on last_report_day makes it at-most-once.
func (s *OpsService) dailyReport(ctx context.Context, settings *database.OpsSettings, now time.Time) error {
	local := now.In(s.loc)
	if !settings.DailyReport || local.Hour() < settings.DailyReportHour {
		return nil
	}
	from, to := s.dayBounds(local.AddDate(0, 0, -1))
	day := from.Format("2006-01-02")
	if settings.LastReportDay >= day {
		return nil
	}
	report, err := s.reportFor(ctx, from, to, now)
	if err != nil {
		return err
	}
	claimed, err := s.repo.ClaimOpsReportDay(ctx, day)
	if err != nil || !claimed {
		return err
	}
	ev := &database.OpsEvent{
		CreatedAt: now, Kind: database.OpsKindDailyReport, Severity: database.OpsSeverityInfo,
		Title: "Итоги дня " + from.Format("02.01.2006"), Message: report.Text, DedupKey: opsKey("report:%s", day),
	}
	details := map[string]any{"day": day}
	encoded, err := json.Marshal(report.Stats)
	if err == nil {
		details["stats"] = json.RawMessage(encoded)
	}
	return s.record(ctx, ev, true, details)
}

// deliver sends the pending events. With the notifications off, or without a
// destination, pending events are dropped from the queue (they stay in the feed).
func (s *OpsService) deliver(ctx context.Context, settings *database.OpsSettings, now time.Time) error {
	chatID := s.destination(settings)
	if !settings.Enabled || s.sender == nil || chatID == 0 {
		return s.repo.SkipPendingOpsEvents(ctx)
	}
	events, err := s.repo.PendingOpsEvents(ctx, 100)
	if err != nil || len(events) == 0 {
		return err
	}
	var errs []error
	send := func(ids []uint, text string) bool {
		sendErr := s.sender.SendOps(ctx, settings.BotToken, chatID, text)
		reason := ""
		if sendErr != nil {
			reason = sendErr.Error()
			errs = append(errs, fmt.Errorf("send: %w", sendErr))
		}
		err := s.repo.FinishOpsEvents(ctx, ids, reason, now)
		if err != nil {
			errs = append(errs, err)
		}
		return sendErr == nil
	}

	var batch []database.OpsEvent
	flush := func() bool {
		if len(batch) == 0 {
			return true
		}
		ids := make([]uint, 0, len(batch))
		for _, ev := range batch {
			ids = append(ids, ev.ID)
		}
		ok := send(ids, formatOpsBatch(batch, s.loc))
		batch = nil
		return ok
	}
	for _, ev := range events {
		if ctx.Err() != nil {
			break
		}
		// A report is its own message; infrastructure events are grouped.
		if ev.Kind == database.OpsKindDailyReport {
			if !flush() || !send([]uint{ev.ID}, ev.Message) {
				break // Telegram is failing: retry everything on the next pass.
			}
			continue
		}
		batch = append(batch, ev)
		if len(batch) >= opsBatchLimit && !flush() {
			break
		}
	}
	flush()
	return errors.Join(errs...)
}

// prune drops old events once an hour.
func (s *OpsService) prune(ctx context.Context, _ *database.OpsSettings, now time.Time) error {
	s.mu.Lock()
	due := now.Sub(s.lastPrune) >= time.Hour
	if due {
		s.lastPrune = now
	}
	s.mu.Unlock()
	if !due {
		return nil
	}
	_, err := s.repo.PruneOpsEvents(ctx, now.Add(-opsEventRetention))
	return err
}

// ---------------------------------------------------------------------------
// Formatting (Telegram HTML)
// ---------------------------------------------------------------------------

func opsSeverityMark(severity string) string {
	switch severity {
	case database.OpsSeverityCritical:
		return "🔴"
	case database.OpsSeverityWarning:
		return "🟡"
	case database.OpsSeverityOK:
		return "🟢"
	}
	return "🔵"
}

func truncateOps(text string, limit int) string {
	runes := []rune(text)
	if len(runes) <= limit {
		return text
	}
	return string(runes[:limit]) + "…"
}

// formatOpsBatch renders infrastructure events as one message.
func formatOpsBatch(events []database.OpsEvent, loc *time.Location) string {
	var b strings.Builder
	b.WriteString("📡 <b>DictatorVPN · мониторинг</b>\n")
	shown := 0
	for _, ev := range events {
		block := fmt.Sprintf("\n%s <b>%s</b> · %s\n%s\n", opsSeverityMark(ev.Severity), html.EscapeString(ev.Title),
			ev.CreatedAt.In(loc).Format("02.01 15:04"), html.EscapeString(truncateOps(ev.Message, 500)))
		if b.Len()+len(block) > opsMessageLimit {
			break
		}
		b.WriteString(block)
		shown++
	}
	if rest := len(events) - shown; rest > 0 {
		fmt.Fprintf(&b, "\n… и ещё событий: %d (см. «События» в панели)", rest)
	}
	return b.String()
}

// formatOpsDuration renders a duration like the admin panel: "45 с",
// "12 мин", "2 ч 5 мин", "3 дн 4 ч".
func formatOpsDuration(d time.Duration) string {
	seconds := max(int64(d/time.Second), 0)
	switch {
	case seconds < 60:
		return fmt.Sprintf("%d с", seconds)
	case seconds < 3600:
		return fmt.Sprintf("%d мин", seconds/60)
	case seconds < 86400:
		if minutes := seconds % 3600 / 60; minutes > 0 {
			return fmt.Sprintf("%d ч %d мин", seconds/3600, minutes)
		}
		return fmt.Sprintf("%d ч", seconds/3600)
	}
	if hours := seconds % 86400 / 3600; hours > 0 {
		return fmt.Sprintf("%d дн %d ч", seconds/86400, hours)
	}
	return fmt.Sprintf("%d дн", seconds/86400)
}

// formatOpsMoney renders sums per currency: "3 618 ₽ · 250 ★"; "0 ₽" when empty.
func formatOpsMoney(sums []database.OpsMoney) string {
	if len(sums) == 0 {
		return "0 ₽"
	}
	parts := make([]string, 0, len(sums))
	for _, m := range sums {
		if strings.EqualFold(m.Currency, "XTR") {
			// Stars are whole units, not hundredths.
			parts = append(parts, formatMoneyCents(m.AmountCents*100, "")+" ★")
			continue
		}
		parts = append(parts, formatMoneyCents(m.AmountCents, m.Currency))
	}
	return strings.Join(parts, " · ")
}

// formatOpsReport renders the daily report (Telegram HTML).
func formatOpsReport(st *database.OpsDailyStats, day time.Time) string {
	var b strings.Builder
	fmt.Fprintf(&b, "📊 <b>Итоги дня — %s</b>\n\n", day.Format("02.01.2006"))
	fmt.Fprintf(&b, "👥 Пользователей: <b>%d</b> (%+d)\n", st.UsersTotal, st.UsersNew)
	fmt.Fprintf(&b, "✅ Активных подписок: <b>%d</b> (платных: %d)\n", st.ActiveSubs, st.PaidActiveSubs)
	fmt.Fprintf(&b, "🎁 Пробных активаций: %d (привязано к Telegram: %d)\n", st.TrialsStarted, st.TrialsBound)
	fmt.Fprintf(&b, "🛒 Подписок оформлено: <b>%d</b> · продлений: %d\n", st.Purchases, st.Renewals)
	if st.FreeActivations > 0 {
		fmt.Fprintf(&b, "🆓 Из них без оплаты: %d\n", st.FreeActivations)
	}
	fmt.Fprintf(&b, "💰 Продаж за день: <b>%s</b>\n", formatOpsMoney(st.PeriodRevenue))
	fmt.Fprintf(&b, "💼 Оборот за всё время: %s\n", formatOpsMoney(st.TotalRevenue))
	if st.PendingOrders > 0 {
		fmt.Fprintf(&b, "🧾 Начали оплату и не завершили: %d\n", st.PendingOrders)
	}
	fmt.Fprintf(&b, "🎟 Промокодов активировано: %d · оплачено со скидкой: %d\n", st.PromoActivations, st.PromoRedemptions)
	fmt.Fprintf(&b, "📲 Подключались к VPN: %d\n", st.Connected)
	fmt.Fprintf(&b, "⌛ Подписок истекло: %d", st.Expired)
	if st.Refunds > 0 {
		fmt.Fprintf(&b, " · возвратов: %d", st.Refunds)
	}
	fmt.Fprintf(&b, "\n⏳ Платных истекает за 3 дня: %d\n", st.ExpiringIn3Days)
	if st.WarmupSent > 0 {
		fmt.Fprintf(&b, "📨 Сообщений прогрева: %d\n", st.WarmupSent)
	}

	b.WriteString("\n🛰 <b>Инфраструктура</b>\n")
	mark := "🟢"
	if st.OpenIncidents > 0 || st.SourcesUnusable > 0 {
		mark = "🟡"
	}
	fmt.Fprintf(&b, "%s Открытых инцидентов сейчас: %d\n", mark, st.OpenIncidents)
	fmt.Fprintf(&b, "Инцидентов за день: стран %d · серверов %d\n", st.IncidentsCountry, st.IncidentsServer)
	fmt.Fprintf(&b, "Источников: %d (не работает: %d) · сборок включено: %d", st.SourcesTotal, st.SourcesUnusable, st.BuildersEnabled)
	return b.String()
}
