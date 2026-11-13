package service

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/hdjsjsdhdhhs-prog/VPNbuilderDictator/internal/database"
	"github.com/hdjsjsdhdhhs-prog/VPNbuilderDictator/internal/netmon"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Operational notifications: outages and state changes become events, the
// daily report is sent once, deliveries are batched and retried.

type fakeOpsMonitor struct {
	overview *netmon.Overview
	err      error
}

func (m *fakeOpsMonitor) Overview(context.Context) (*netmon.Overview, error) {
	return m.overview, m.err
}

type opsMessage struct {
	token  string
	chatID int64
	text   string
}

type fakeOpsSender struct {
	mu   sync.Mutex
	sent []opsMessage
	err  error
}

func (s *fakeOpsSender) SendOps(_ context.Context, token string, chatID int64, text string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.err != nil {
		return s.err
	}
	s.sent = append(s.sent, opsMessage{token, chatID, text})
	return nil
}

func (s *fakeOpsSender) texts() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]string, 0, len(s.sent))
	for _, m := range s.sent {
		out = append(out, m.text)
	}
	return out
}

type opsFixture struct {
	t       *testing.T
	ctx     context.Context
	db      *database.Service
	svc     *OpsService
	monitor *fakeOpsMonitor
	sender  *fakeOpsSender
	now     time.Time
}

const opsTestAdminID = int64(777)

func newOpsFixture(t *testing.T) *opsFixture {
	t.Helper()
	db, err := database.NewService(filepath.Join(t.TempDir(), "ops.db"))
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })
	f := &opsFixture{
		t: t, ctx: context.Background(), db: db, sender: &fakeOpsSender{},
		monitor: &fakeOpsMonitor{overview: &netmon.Overview{Builders: []netmon.BuilderSummary{}}},
		// The clock runs after the migration baseline, so new outages count.
		now: time.Now().UTC().Add(10 * time.Minute),
	}
	f.svc = NewOpsService(db, f.monitor, opsTestAdminID)
	f.svc.SetSender(f.sender)
	f.svc.SetClock(func() time.Time { return f.now })
	return f
}

// settings applies a change to the settings row.
func (f *opsFixture) settings(change func(*database.OpsSettingsInput)) {
	f.t.Helper()
	current, err := f.db.GetOpsSettings(f.ctx)
	require.NoError(f.t, err)
	in := database.OpsSettingsInput{
		Version: current.Version, Enabled: current.Enabled, ChatID: current.ChatID, NotifyServers: current.NotifyServers,
		NotifyCountries: current.NotifyCountries, NotifySources: current.NotifySources,
		DailyReport: current.DailyReport, DailyReportHour: current.DailyReportHour,
	}
	change(&in)
	_, err = f.svc.UpdateSettings(f.ctx, "admin", "settings-v"+strings.Repeat("i", current.Version), in)
	require.NoError(f.t, err)
}

func (f *opsFixture) events() []database.OpsEvent {
	f.t.Helper()
	var events []database.OpsEvent
	require.NoError(f.t, f.db.GetDB().Order("id ASC").Find(&events).Error)
	return events
}

func (f *opsFixture) kinds() []string {
	kinds := []string{}
	for _, ev := range f.events() {
		kinds = append(kinds, ev.Kind)
	}
	return kinds
}

// outageFixture creates a builder, a monitored server and an open outage of
// the server and of its country.
func (f *opsFixture) openOutages() (builder *database.SubscriptionBuilder, target *database.MonitorTarget, server, country *database.MonitorOutage) {
	f.t.Helper()
	gdb := f.db.GetDB()
	builder = &database.SubscriptionBuilder{Name: "Premium EU", Enabled: true, Version: 1}
	require.NoError(f.t, gdb.Create(builder).Error)
	seen := f.now.Add(-time.Hour)
	target = &database.MonitorTarget{EndpointKey: "vless|de1.example.com|443", Protocol: "vless", Host: "de1.example.com", Port: 443, Probe: "tls", Active: true, Status: "down", FirstSeenAt: seen, LastSeenAt: seen}
	require.NoError(f.t, gdb.Create(target).Error)
	require.NoError(f.t, gdb.Create(&database.MonitorBinding{BuilderID: builder.ID, BuilderName: builder.Name, SourceID: 1, Fingerprint: "fp-1", TargetID: target.ID, CountryCode: "DE", NodeName: "🇩🇪 Germany 1", Active: true, FirstSeenAt: seen, LastSeenAt: seen}).Error)
	started := f.now.Add(-5 * time.Minute)
	server = &database.MonitorOutage{Scope: database.MonitorScopeTarget, TargetID: &target.ID, CountryCode: "DE", Kind: database.MonitorOutageDown, StartedAt: started, ErrorCode: "timeout"}
	require.NoError(f.t, gdb.Create(server).Error)
	country = &database.MonitorOutage{Scope: database.MonitorScopeCountry, BuilderID: &builder.ID, CountryCode: "DE", Kind: database.MonitorOutageDown, StartedAt: started}
	require.NoError(f.t, gdb.Create(country).Error)
	return builder, target, server, country
}

func TestOpsTick_OutagesBecomeBatchedAlerts(t *testing.T) {
	t.Parallel()
	f := newOpsFixture(t)
	f.settings(func(in *database.OpsSettingsInput) { in.DailyReport = false })
	_, _, server, country := f.openOutages()

	require.NoError(t, f.svc.Tick(f.ctx))
	assert.ElementsMatch(t, []string{database.OpsKindServerDown, database.OpsKindCountryDown}, f.kinds())

	texts := f.sender.texts()
	require.Len(t, texts, 1, "infrastructure events of one pass go into one message")
	assert.Equal(t, opsTestAdminID, f.sender.sent[0].chatID, "chat_id 0 means the admin")
	assert.Empty(t, f.sender.sent[0].token, "the main bot is used by default")
	assert.Contains(t, texts[0], "🟡 <b>Сервер недоступен</b>")
	assert.Contains(t, texts[0], "🔴 <b>Страна недоступна</b>")
	assert.Contains(t, texts[0], "vless de1.example.com:443")
	assert.Contains(t, texts[0], "нет ответа (таймаут)")
	assert.Contains(t, texts[0], "«Premium EU»")
	for _, ev := range f.events() {
		assert.Equal(t, database.OpsNotifySent, ev.NotifyStatus, ev.Kind)
	}

	// A second pass adds nothing and sends nothing.
	require.NoError(t, f.svc.Tick(f.ctx))
	assert.Len(t, f.events(), 2)
	assert.Len(t, f.sender.texts(), 1)

	// The outages end: one "recovered" event each, with the downtime.
	f.now = f.now.Add(7 * time.Minute)
	ended := f.now.Add(-time.Minute)
	gdb := f.db.GetDB()
	for _, id := range []uint{server.ID, country.ID} {
		require.NoError(t, gdb.Model(&database.MonitorOutage{}).Where("id = ?", id).
			Updates(map[string]any{"ended_at": ended, "end_reason": database.MonitorEndRecovered}).Error)
	}
	require.NoError(t, f.svc.Tick(f.ctx))
	texts = f.sender.texts()
	require.Len(t, texts, 2)
	assert.Contains(t, texts[1], "🟢 <b>Сервер восстановлен</b>")
	assert.Contains(t, texts[1], "🟢 <b>Страна восстановлена</b>")
	assert.Contains(t, texts[1], "простой 11 мин")

	// An outage that only changed its kind is not a recovery.
	changed := &database.MonitorOutage{Scope: database.MonitorScopeCountry, BuilderID: country.BuilderID, CountryCode: "NL", Kind: database.MonitorOutageDegraded, StartedAt: f.now.Add(-2 * time.Minute), EndedAt: &ended, EndReason: database.MonitorEndChanged}
	require.NoError(t, gdb.Create(changed).Error)
	require.NoError(t, f.svc.Tick(f.ctx))
	kinds := f.kinds()
	assert.Contains(t, kinds, database.OpsKindCountryDegraded)
	assert.Len(t, kinds, 5, "no close event for a changed outage")
}

func TestOpsTick_HistoryBeforeBaselineIsSilent(t *testing.T) {
	t.Parallel()
	f := newOpsFixture(t)
	f.settings(func(in *database.OpsSettingsInput) { in.DailyReport = false })
	builder := &database.SubscriptionBuilder{Name: "Old", Enabled: true, Version: 1}
	require.NoError(t, f.db.GetDB().Create(builder).Error)
	// Started and ended long before the notifications existed.
	started, ended := f.now.Add(-30*time.Hour), f.now.Add(-29*time.Hour)
	require.NoError(t, f.db.GetDB().Create(&database.MonitorOutage{Scope: database.MonitorScopeCountry, BuilderID: &builder.ID, CountryCode: "DE", Kind: database.MonitorOutageDown, StartedAt: started, EndedAt: &ended, EndReason: database.MonitorEndRecovered}).Error)

	require.NoError(t, f.svc.Tick(f.ctx))
	assert.Empty(t, f.events())
	assert.Empty(t, f.sender.texts())
}

func TestOpsTick_SwitchedOffKindsStayInFeedOnly(t *testing.T) {
	t.Parallel()
	f := newOpsFixture(t)
	f.settings(func(in *database.OpsSettingsInput) { in.DailyReport, in.NotifyServers = false, false })
	f.openOutages()

	require.NoError(t, f.svc.Tick(f.ctx))
	byKind := map[string]string{}
	for _, ev := range f.events() {
		byKind[ev.Kind] = ev.NotifyStatus
	}
	assert.Equal(t, database.OpsNotifySkipped, byKind[database.OpsKindServerDown], "server alerts are off")
	assert.Equal(t, database.OpsNotifySent, byKind[database.OpsKindCountryDown])
	texts := f.sender.texts()
	require.Len(t, texts, 1)
	assert.NotContains(t, texts[0], "Сервер недоступен")
}

func TestOpsTick_DeliveryFailureIsRetried(t *testing.T) {
	t.Parallel()
	f := newOpsFixture(t)
	f.settings(func(in *database.OpsSettingsInput) { in.DailyReport = false })
	f.openOutages()

	f.sender.err = errors.New("telegram is down")
	err := f.svc.Tick(f.ctx)
	require.Error(t, err, "a failed pass is reported to the worker")
	for _, ev := range f.events() {
		assert.Equal(t, database.OpsNotifyPending, ev.NotifyStatus)
		assert.Equal(t, 1, ev.NotifyAttempts)
		assert.Contains(t, ev.NotifyError, "telegram is down")
	}

	f.sender.err = nil
	require.NoError(t, f.svc.Tick(f.ctx))
	require.Len(t, f.sender.texts(), 1)
	for _, ev := range f.events() {
		assert.Equal(t, database.OpsNotifySent, ev.NotifyStatus)
	}

	// With the notifications off nothing is queued for later.
	f.settings(func(in *database.OpsSettingsInput) { in.Enabled = false })
	f.now = f.now.Add(time.Minute)
	started := f.now.Add(-30 * time.Second)
	builderID := uint(1)
	require.NoError(t, f.db.GetDB().Create(&database.MonitorOutage{Scope: database.MonitorScopeCountry, BuilderID: &builderID, CountryCode: "FR", Kind: database.MonitorOutageDown, StartedAt: started}).Error)
	require.NoError(t, f.svc.Tick(f.ctx))
	events := f.events()
	assert.Equal(t, database.OpsNotifySkipped, events[len(events)-1].NotifyStatus)
	assert.Len(t, f.sender.texts(), 1)
}

func TestOpsTick_BuildersAndSources(t *testing.T) {
	t.Parallel()
	f := newOpsFixture(t)
	f.settings(func(in *database.OpsSettingsInput) { in.DailyReport = false })
	gdb := f.db.GetDB()
	soon, far := f.now.Add(24*time.Hour), f.now.Add(30*24*time.Hour)
	expiring := &database.ProviderSource{Name: "Liberty", Type: "subscription", SubscriptionURL: "https://example.com/secret-token", Enabled: true, ExpiresAt: &soon}
	healthy := &database.ProviderSource{Name: "Stable", Type: "subscription", SubscriptionURL: "https://example.com/other", Enabled: true, ExpiresAt: &far}
	require.NoError(t, gdb.Create(expiring).Error)
	require.NoError(t, gdb.Create(healthy).Error)
	lastRound := f.now.Add(-30 * time.Second)
	f.monitor.overview = &netmon.Overview{Enabled: true, IntervalSeconds: 60, LastRoundAt: &lastRound, Builders: []netmon.BuilderSummary{
		{ID: 1, Name: "Premium", Enabled: true, Status: database.MonitorStatusUp, NodesTotal: 4, NodesUp: 4},
		{ID: 2, Name: "Lite", Enabled: true, Status: database.MonitorStatusDegraded, NodesTotal: 2, NodesUp: 1, NodesDown: 1},
	}}

	// First sight: only what needs attention is reported.
	require.NoError(t, f.svc.Tick(f.ctx))
	assert.Equal(t, []string{database.OpsKindSourceExpiring}, f.kinds())
	texts := f.sender.texts()
	require.Len(t, texts, 1)
	assert.Contains(t, texts[0], "Источник скоро закончится")
	assert.Contains(t, texts[0], "«Liberty»")
	assert.NotContains(t, texts[0], "secret-token", "an alert never carries the provider URL")

	// The builder goes down, its sources stop loading, the source runs out,
	// the other source is switched off and the monitor stalls.
	f.now = f.now.Add(25 * time.Hour)
	stale := f.now.Add(-20 * time.Minute)
	f.monitor.overview.LastRoundAt = &stale
	f.monitor.overview.Builders[0].Status, f.monitor.overview.Builders[0].NodesUp, f.monitor.overview.Builders[0].NodesDown = database.MonitorStatusDown, 0, 4
	f.monitor.overview.Builders[0].SourceErrors = 1
	require.NoError(t, gdb.Model(healthy).Update("enabled", false).Error)
	require.NoError(t, f.svc.Tick(f.ctx))
	assert.ElementsMatch(t, []string{
		database.OpsKindSourceExpiring, database.OpsKindBuilderDown, database.OpsKindSourceFailing,
		database.OpsKindMonitorStalled, database.OpsKindSourceExpired, database.OpsKindSourceDisabled,
	}, f.kinds())
	last := f.sender.texts()[len(f.sender.texts())-1]
	assert.Contains(t, last, "🔴 <b>Построитель недоступен</b>")
	assert.Contains(t, last, "🔴 <b>Срок источника истёк</b>")
	assert.Contains(t, last, "Мониторинг не проверяет серверы")

	// Everything recovers: one green event per subject, then silence.
	f.now = f.now.Add(time.Hour)
	fresh := f.now.Add(-10 * time.Second)
	f.monitor.overview.LastRoundAt = &fresh
	f.monitor.overview.Builders[0].Status, f.monitor.overview.Builders[0].NodesUp, f.monitor.overview.Builders[0].NodesDown = database.MonitorStatusUp, 4, 0
	f.monitor.overview.Builders[0].SourceErrors = 0
	renewed := f.now.Add(60 * 24 * time.Hour)
	require.NoError(t, gdb.Model(expiring).Update("expires_at", renewed).Error)
	require.NoError(t, gdb.Model(healthy).Update("enabled", true).Error)
	require.NoError(t, f.svc.Tick(f.ctx))
	recovered := f.kinds()[6:]
	assert.ElementsMatch(t, []string{
		database.OpsKindBuilderUp, database.OpsKindSourceRecovered, database.OpsKindMonitorRecovered,
		database.OpsKindSourceRecovered, database.OpsKindSourceRecovered,
	}, recovered)
	sentBefore := len(f.sender.texts())
	require.NoError(t, f.svc.Tick(f.ctx))
	assert.Len(t, f.events(), 11)
	assert.Len(t, f.sender.texts(), sentBefore)

	// A failing monitor is reported by the pass, the rest still runs.
	f.monitor.err = errors.New("monitor unavailable")
	require.Error(t, f.svc.Tick(f.ctx))
}

func TestOpsTick_DailyReportOncePerDay(t *testing.T) {
	t.Parallel()
	f := newOpsFixture(t)
	loc := moscowLocation()
	// 10:30 Moscow time, well after the 09:00 report hour.
	day := f.now.In(loc).AddDate(0, 0, 2)
	f.now = time.Date(day.Year(), day.Month(), day.Day(), 10, 30, 0, 0, loc).UTC()

	require.NoError(t, f.svc.Tick(f.ctx))
	events := f.events()
	require.Len(t, events, 1)
	assert.Equal(t, database.OpsKindDailyReport, events[0].Kind)
	yesterday := f.now.In(loc).AddDate(0, 0, -1)
	assert.Equal(t, "Итоги дня "+yesterday.Format("02.01.2006"), events[0].Title)
	texts := f.sender.texts()
	require.Len(t, texts, 1, "the report is its own message")
	assert.Contains(t, texts[0], "📊 <b>Итоги дня — "+yesterday.Format("02.01.2006")+"</b>")
	assert.Contains(t, texts[0], "Пользователей:")
	assert.Contains(t, texts[0], "Продаж за день: <b>0 ₽</b>")
	assert.Contains(t, texts[0], "Инфраструктура")
	var details map[string]any
	require.NoError(t, json.Unmarshal([]byte(events[0].Details), &details))
	assert.Equal(t, yesterday.Format("2006-01-02"), details["day"])
	assert.Contains(t, details, "stats")

	// Later the same day: nothing. Next morning before the hour: nothing.
	f.now = f.now.Add(3 * time.Hour)
	require.NoError(t, f.svc.Tick(f.ctx))
	f.now = time.Date(day.Year(), day.Month(), day.Day()+1, 8, 59, 0, 0, loc).UTC()
	require.NoError(t, f.svc.Tick(f.ctx))
	assert.Len(t, f.events(), 1)

	// At the report hour of the next day: the next report.
	f.now = f.now.Add(2 * time.Minute)
	require.NoError(t, f.svc.Tick(f.ctx))
	assert.Len(t, f.events(), 2)
	assert.Len(t, f.sender.texts(), 2)

	// Switched off: no report.
	f.settings(func(in *database.OpsSettingsInput) { in.DailyReport = false })
	f.now = f.now.Add(24 * time.Hour)
	require.NoError(t, f.svc.Tick(f.ctx))
	assert.Len(t, f.events(), 2)
}

func TestOpsService_SettingsViewReportAndTest(t *testing.T) {
	t.Parallel()
	f := newOpsFixture(t)

	view, err := f.svc.Settings(f.ctx)
	require.NoError(t, err)
	assert.False(t, view.OwnBot)
	assert.Equal(t, opsTestAdminID, view.EffectiveChatID)
	encoded, err := json.Marshal(view)
	require.NoError(t, err)
	assert.NotContains(t, string(encoded), "bot_token", "the token is never serialized")

	token := "1234567890:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw_test"
	f.settings(func(in *database.OpsSettingsInput) { in.ChatID, in.BotToken = -100555, &token })
	view, err = f.svc.Settings(f.ctx)
	require.NoError(t, err)
	assert.True(t, view.OwnBot)
	assert.Equal(t, int64(-100555), view.EffectiveChatID)

	require.NoError(t, f.svc.SendTest(f.ctx))
	require.Len(t, f.sender.sent, 1)
	assert.Equal(t, token, f.sender.sent[0].token, "the separate bot is used when configured")
	assert.Equal(t, int64(-100555), f.sender.sent[0].chatID)
	assert.Contains(t, f.sender.sent[0].text, "Проверка уведомлений")

	// A failed test is returned to the caller and recorded in the feed.
	f.sender.err = errors.New("chat not found")
	require.Error(t, f.svc.SendTest(f.ctx))
	page, err := f.svc.Events(f.ctx, database.OpsEventFilter{})
	require.NoError(t, err)
	require.Len(t, page.Events, 2)
	assert.Equal(t, database.OpsNotifyFailed, page.Events[0].NotifyStatus)
	assert.Equal(t, 50, page.Limit)

	today, err := f.svc.Report(f.ctx, 0)
	require.NoError(t, err)
	assert.Equal(t, f.now.In(moscowLocation()).Format("2006-01-02"), today.Day)
	assert.Contains(t, today.Text, "Итоги дня")
	_, err = f.svc.Report(f.ctx, -1)
	require.ErrorIs(t, err, database.ErrAdminInvalidRequest)

	// No destination at all.
	lonely := NewOpsService(f.db, nil, 0)
	lonely.SetSender(f.sender)
	f.settings(func(in *database.OpsSettingsInput) { in.ChatID = 0 })
	require.ErrorIs(t, lonely.SendTest(f.ctx), ErrOpsNotConfigured)
}

func TestFormatOps(t *testing.T) {
	t.Parallel()
	assert.Equal(t, "45 с", formatOpsDuration(45*time.Second))
	assert.Equal(t, "12 мин", formatOpsDuration(12*time.Minute+30*time.Second))
	assert.Equal(t, "2 ч 5 мин", formatOpsDuration(2*time.Hour+5*time.Minute))
	assert.Equal(t, "2 ч", formatOpsDuration(2*time.Hour))
	assert.Equal(t, "3 дн 4 ч", formatOpsDuration(76*time.Hour))
	assert.Equal(t, "0 с", formatOpsDuration(-time.Second))

	assert.Equal(t, "0 ₽", formatOpsMoney(nil))
	assert.Equal(t, "3 618 ₽ · 250 ★", formatOpsMoney([]database.OpsMoney{{Currency: "RUB", AmountCents: 361800}, {Currency: "XTR", AmountCents: 250}}))

	report := formatOpsReport(&database.OpsDailyStats{
		UsersTotal: 94, ActiveSubs: 4, PaidActiveSubs: 4,
		TotalRevenue: []database.OpsMoney{{Currency: "RUB", AmountCents: 361800}}, OpenIncidents: 1,
	}, time.Date(2026, 10, 21, 0, 0, 0, 0, time.UTC))
	assert.Contains(t, report, "Итоги дня — 21.10.2026")
	assert.Contains(t, report, "Пользователей: <b>94</b> (+0)")
	assert.Contains(t, report, "Активных подписок: <b>4</b> (платных: 4)")
	assert.Contains(t, report, "Продаж за день: <b>0 ₽</b>")
	assert.Contains(t, report, "Оборот за всё время: 3 618 ₽")
	assert.Contains(t, report, "🟡 Открытых инцидентов сейчас: 1")

	// HTML in names is escaped; a long batch is cut with a pointer to the panel.
	events := make([]database.OpsEvent, 0, 40)
	for range 40 {
		events = append(events, database.OpsEvent{Severity: database.OpsSeverityWarning, Title: "Сервер <b>недоступен", Message: strings.Repeat("x", 300), CreatedAt: time.Now()})
	}
	batch := formatOpsBatch(events, time.UTC)
	assert.Contains(t, batch, "Сервер &lt;b&gt;недоступен")
	assert.Contains(t, batch, "и ещё событий:")
	assert.LessOrEqual(t, len([]rune(batch)), 4096)
}

func TestOpsTelegramSender(t *testing.T) {
	t.Parallel()
	token := "1234567890:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw_test"
	var got struct {
		path string
		body map[string]any
	}
	status := http.StatusOK
	reply := `{"ok":true}`
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got.path = r.URL.Path
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &got.body)
		w.WriteHeader(status)
		_, _ = w.Write([]byte(reply))
	}))
	defer server.Close()

	sender := NewOpsTelegramSender(nil)
	sender.apiBase = server.URL
	ctx := context.Background()

	require.ErrorIs(t, sender.SendOps(ctx, "", 1, "x"), ErrOpsNotConfigured, "no main bot and no token")
	require.ErrorIs(t, sender.SendOps(ctx, token, 0, "x"), ErrOpsNotConfigured, "no chat")

	require.NoError(t, sender.SendOps(ctx, token, -100555, "<b>hi</b>"))
	assert.Equal(t, "/bot"+token+"/sendMessage", got.path)
	assert.Equal(t, "HTML", got.body["parse_mode"])
	assert.Equal(t, "<b>hi</b>", got.body["text"])
	assert.InDelta(t, -100555, got.body["chat_id"], 0)

	// Telegram's refusal is reported without the token.
	status, reply = http.StatusForbidden, `{"ok":false,"description":"Forbidden: bot was blocked by the user `+token+`"}`
	err := sender.SendOps(ctx, token, 5, "x")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "403")
	assert.Contains(t, err.Error(), "bot was blocked")
	assert.NotContains(t, err.Error(), token)

	// A transport error quotes the URL: the token is masked there too.
	server.Close()
	err = sender.SendOps(ctx, token, 5, "x")
	require.Error(t, err)
	assert.NotContains(t, err.Error(), token)
}
