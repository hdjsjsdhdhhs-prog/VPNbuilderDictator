package web

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/hdjsjsdhdhhs-prog/VPNbuilderDictator/internal/config"
	"github.com/hdjsjsdhdhhs-prog/VPNbuilderDictator/internal/database"
	"github.com/hdjsjsdhdhhs-prog/VPNbuilderDictator/internal/service"
	"github.com/hdjsjsdhdhhs-prog/VPNbuilderDictator/internal/testutil"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"golang.org/x/crypto/bcrypt"
)

// Promo codes (/admin/api/promos*) and operational notifications
// (/admin/api/ops*) through the exact handler installed by Start: session,
// CSRF, body decoding, error codes, versioning and idempotent replay. This is
// the wire contract the admin panel (frontend/admin/src/ops.ts) parses.
// Repository and service rules are covered by internal/database/promo_test.go,
// ops_test.go and internal/service/promo_test.go, ops_test.go.

const (
	promoOpsAdminChat = int64(777)
	// A syntactically valid Bot API token (never a real one).
	promoOpsBotToken = "123456789:AAEabcdefghijklmnopqrstuvwxyz0123456"
)

// recordingOpsSender stands in for Telegram.
type recordingOpsSender struct {
	mu   sync.Mutex
	err  error
	sent []struct {
		token string
		chat  int64
		text  string
	}
}

func (s *recordingOpsSender) SendOps(_ context.Context, token string, chatID int64, text string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.err != nil {
		return s.err
	}
	s.sent = append(s.sent, struct {
		token string
		chat  int64
		text  string
	}{token, chatID, text})
	return nil
}

func (s *recordingOpsSender) fail(err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.err = err
}

func (s *recordingOpsSender) count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.sent)
}

type promoOpsAPIFixture struct {
	*adminAPIFixture

	sender *recordingOpsSender
}

func newPromoOpsAPIFixture(t *testing.T) *promoOpsAPIFixture {
	t.Helper()
	return newPromoOpsAPIFixtureFor(t, promoOpsAdminChat)
}

// newPromoOpsAPIFixtureFor starts the server with the given default
// destination (TELEGRAM_ADMIN_ID); 0 leaves the notifications without one.
func newPromoOpsAPIFixtureFor(t *testing.T, adminChat int64) *promoOpsAPIFixture {
	t.Helper()
	base := newAdminAPIFixtureNoServer(t)
	sender := &recordingOpsSender{}

	hash, err := bcrypt.GenerateFromPassword([]byte(adminTestPassword), config.AdminMinBcryptCost)
	require.NoError(t, err)
	cfg := &config.Config{AdminUsername: "admin", AdminPasswordHash: string(hash), SiteURL: "https://admin.example.com"}
	s := NewServer("127.0.0.1:0", nil, cfg, "", nil, nil)
	s.SetAdminService(service.NewAdminService(base.db, nil))
	s.SetPromoService(service.NewPromoService(base.db))
	ops := service.NewOpsService(base.db, nil, adminChat)
	ops.SetSender(sender)
	s.SetOpsService(ops)
	require.NoError(t, s.Start(context.Background()))
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		require.NoError(t, s.Stop(ctx))
	})
	base.attach(s)
	return &promoOpsAPIFixture{adminAPIFixture: base, sender: sender}
}

type promoOutcomeWire struct {
	Promo    *service.PromoView `json:"promo"`
	Replayed bool               `json:"replayed"`
	Audit    struct {
		ID     uint   `json:"id"`
		Action string `json:"action"`
	} `json:"audit"`
}

func promoPath(id uint) string { return fmt.Sprintf("/admin/api/promos/%d", id) }

// promoBodyJSON is a create payload; extra is appended as further members.
func promoBodyJSON(key, code string, percent int, extra string) string {
	return fmt.Sprintf(`{"request_key":%q,"code":%q,"percent":%d,"max_activations":0,"valid_hours":72,"enabled":true,"note":""%s}`,
		key, code, percent, extra)
}

func (f *promoOpsAPIFixture) createPromo(key, code string, percent int) service.PromoView {
	f.t.Helper()
	resp := f.do(http.MethodPost, "/admin/api/promos", f.withCSRF(), withJSON(promoBodyJSON(key, code, percent, "")))
	require.Equal(f.t, http.StatusCreated, resp.StatusCode)
	var out promoOutcomeWire
	f.decode(resp, &out)
	require.NotNil(f.t, out.Promo)
	return *out.Promo
}

func (f *promoOpsAPIFixture) listPromos() []service.PromoView {
	f.t.Helper()
	resp := f.do(http.MethodGet, "/admin/api/promos")
	require.Equal(f.t, http.StatusOK, resp.StatusCode)
	var out struct {
		Promos []service.PromoView `json:"promos"`
	}
	f.decode(resp, &out)
	require.NotNil(f.t, out.Promos, "an empty list is [], never null")
	return out.Promos
}

// expectPromoField asserts 400 invalid_promo naming the field.
func (f *promoOpsAPIFixture) expectPromoField(resp *http.Response, field string) {
	f.t.Helper()
	require.Equal(f.t, http.StatusBadRequest, resp.StatusCode)
	assert.Equal(f.t, map[string]any{"error": "invalid_promo", "field": field}, f.raw(resp))
}

//nolint:bodyclose // every body is closed by adminAPIFixture.doAs (t.Cleanup)
func TestAdminPromoAPI_RequiresSessionCSRFAndService(t *testing.T) {
	f := newPromoOpsAPIFixture(t)

	// No session: nothing of the section is reachable.
	for _, path := range []string{"/admin/api/promos", "/admin/api/ops", "/admin/api/ops/events", "/admin/api/ops/report"} {
		f.expectError(f.doAs(f.anon, http.MethodGet, path), http.StatusUnauthorized, "unauthorized")
	}
	f.login()

	// A write without the synchronizer token is refused before the handler.
	body := promoBodyJSON("no-csrf", "NOCSRF", 10, "")
	require.Equal(t, http.StatusForbidden, f.do(http.MethodPost, "/admin/api/promos", withJSON(body)).StatusCode)
	require.Equal(t, http.StatusForbidden, f.do(http.MethodPut, "/admin/api/ops", withJSON(`{}`)).StatusCode)
	require.Equal(t, http.StatusForbidden, f.do(http.MethodPost, "/admin/api/ops/test", withJSON(`{}`)).StatusCode)
	assert.Empty(t, f.listPromos())

	// Methods and unknown paths.
	resp := f.do(http.MethodPut, "/admin/api/promos", f.withCSRF(), withJSON(`{}`))
	require.Equal(t, http.StatusMethodNotAllowed, resp.StatusCode)
	assert.Equal(t, "GET, HEAD, POST", resp.Header.Get("Allow"))
	resp = f.do(http.MethodPost, promoPath(1), f.withCSRF(), withJSON(`{}`))
	require.Equal(t, http.StatusMethodNotAllowed, resp.StatusCode)
	assert.Equal(t, "PATCH, DELETE", resp.Header.Get("Allow"))
	resp = f.do(http.MethodDelete, "/admin/api/ops", f.withCSRF(), withJSON(`{}`))
	require.Equal(t, http.StatusMethodNotAllowed, resp.StatusCode)
	assert.Equal(t, "GET, HEAD, PUT", resp.Header.Get("Allow"))
	f.expectError(f.do(http.MethodGet, "/admin/api/promos/abc"), http.StatusNotFound, "not_found")
	f.expectError(f.do(http.MethodGet, "/admin/api/promos/1/extra"), http.StatusNotFound, "not_found")
	f.expectError(f.do(http.MethodGet, "/admin/api/ops/unknown"), http.StatusNotFound, "not_found")

	// A server without the services answers 503 on the (still protected) routes.
	bare := newAdminAPIFixture(t)
	bare.login()
	for _, path := range []string{"/admin/api/promos", "/admin/api/ops", "/admin/api/ops/events"} {
		bare.expectError(bare.do(http.MethodGet, path), http.StatusServiceUnavailable, "service_unavailable")
	}
}

//nolint:bodyclose // every body is closed by adminAPIFixture.doAs (t.Cleanup)
func TestAdminPromoAPI_CreateUpdateDelete(t *testing.T) {
	f := newPromoOpsAPIFixture(t)
	f.login()
	ctx := context.Background()
	audits := f.auditCount()

	// Rejections name the field and store nothing.
	post := func(body string) *http.Response {
		return f.do(http.MethodPost, "/admin/api/promos", f.withCSRF(), withJSON(body))
	}
	f.expectPromoField(post(promoBodyJSON("bad-code", "no", 10, "")), "code")
	f.expectPromoField(post(promoBodyJSON("bad-percent", "PERCENT", 101, "")), "percent")
	f.expectPromoField(post(promoBodyJSON("bad-date", "DATED", 10, `,"expires_at":"tomorrow"`)), "expires_at")
	f.expectPromoField(post(promoBodyJSON("past-date", "DATED", 10, `,"expires_at":"2020-01-01T00:00:00Z"`)), "expires_at")
	f.expectError(post(promoBodyJSON("unknown", "UNKNOWN", 10, `,"force":true`)), http.StatusBadRequest, "invalid_request")
	f.expectError(post(`{"code":"NOKEY","percent":10,"max_activations":0,"valid_hours":72,"enabled":true,"note":""}`), http.StatusBadRequest, "invalid_request")
	assert.Empty(t, f.listPromos())
	assert.Equal(t, audits, f.auditCount(), "rejections are not audited")

	// The code is normalized to upper case; the wire carries every field the
	// panel parses and nothing else.
	until := time.Now().UTC().Add(48 * time.Hour).Truncate(time.Second)
	resp := post(promoBodyJSON("create-1", " summer20 ", 20, fmt.Sprintf(`,"expires_at":%q`, until.Format(time.RFC3339))))
	require.Equal(t, http.StatusCreated, resp.StatusCode)
	wire := f.raw(resp)
	promoWire, ok := wire["promo"].(map[string]any)
	require.True(t, ok)
	for _, key := range []string{"id", "code", "percent", "max_activations", "activations", "valid_hours", "expires_at", "enabled", "note",
		"version", "created_at", "updated_at", "redeemed", "state"} {
		assert.Contains(t, promoWire, key)
	}
	assert.Len(t, promoWire, 14)
	assert.Equal(t, "SUMMER20", promoWire["code"])
	assert.Equal(t, "active", promoWire["state"])
	assert.Equal(t, false, wire["replayed"])
	assert.Equal(t, audits+1, f.auditCount())

	list := f.listPromos()
	require.Len(t, list, 1)
	created := list[0]
	assert.Equal(t, 20, created.Percent)
	assert.Equal(t, 1, created.Version)
	require.NotNil(t, created.ExpiresAt)
	assert.True(t, until.Equal(*created.ExpiresAt))

	// The same key and payload replay the recorded outcome; another payload
	// conflicts; the same code under a new key is taken.
	body := promoBodyJSON("create-2", "FRIENDS", 100, "")
	first := post(body)
	require.Equal(t, http.StatusCreated, first.StatusCode)
	var firstOut, replayOut promoOutcomeWire
	f.decode(first, &firstOut)
	replay := post(body)
	require.Equal(t, http.StatusCreated, replay.StatusCode)
	f.decode(replay, &replayOut)
	assert.True(t, replayOut.Replayed)
	assert.Equal(t, firstOut.Audit.ID, replayOut.Audit.ID)
	require.Len(t, f.listPromos(), 2)
	f.expectError(post(promoBodyJSON("create-2", "OTHER", 10, "")), http.StatusConflict, "request_key_conflict")
	f.expectError(post(promoBodyJSON("create-3", "summer20", 10, "")), http.StatusConflict, "promo_code_taken")

	// Update: only limits, validity, note and the switch; versioned.
	patch := func(id uint, body string) *http.Response {
		return f.do(http.MethodPatch, promoPath(id), f.withCSRF(), withJSON(body))
	}
	resp = patch(created.ID, `{"request_key":"upd-1","version":1,"max_activations":5,"valid_hours":24,"enabled":false,"note":"Канал"}`)
	require.Equal(t, http.StatusOK, resp.StatusCode)
	var updated promoOutcomeWire
	f.decode(resp, &updated)
	require.NotNil(t, updated.Promo)
	assert.Equal(t, "disabled", updated.Promo.State)
	assert.Equal(t, 2, updated.Promo.Version)
	assert.Equal(t, 5, updated.Promo.MaxActivations)
	assert.Equal(t, "Канал", updated.Promo.Note)
	assert.Nil(t, updated.Promo.ExpiresAt, "an absent expires_at clears the end")
	assert.Equal(t, "SUMMER20", updated.Promo.Code)
	assert.Equal(t, 20, updated.Promo.Percent)
	f.expectError(patch(created.ID, `{"request_key":"upd-stale","version":1,"max_activations":5,"valid_hours":24,"enabled":true,"note":""}`),
		http.StatusConflict, "version_conflict")

	// The code and its percent are fixed: users may already hold discounts
	// issued from them, so these members of the body are ignored.
	resp = patch(created.ID, `{"request_key":"upd-code","version":2,"code":"RENAMED","percent":90,"max_activations":5,"valid_hours":24,"enabled":true,"note":""}`)
	require.Equal(t, http.StatusOK, resp.StatusCode)
	var renamed promoOutcomeWire
	f.decode(resp, &renamed)
	require.NotNil(t, renamed.Promo)
	assert.Equal(t, "SUMMER20", renamed.Promo.Code)
	assert.Equal(t, 20, renamed.Promo.Percent)
	assert.Equal(t, "active", renamed.Promo.State)
	assert.Equal(t, 3, renamed.Promo.Version)
	assert.Empty(t, renamed.Promo.Note)

	// Update rejections name the field or the request; nothing is stored.
	f.expectPromoField(patch(created.ID, `{"request_key":"upd-hours","version":3,"max_activations":5,"valid_hours":0,"enabled":true,"note":""}`), "valid_hours")
	f.expectPromoField(patch(created.ID, `{"request_key":"upd-max","version":3,"max_activations":-1,"valid_hours":24,"enabled":true,"note":""}`), "max_activations")
	f.expectPromoField(patch(created.ID, `{"request_key":"upd-date","version":3,"max_activations":5,"valid_hours":24,"expires_at":"soon","enabled":true,"note":""}`), "expires_at")
	f.expectError(patch(created.ID, `{"request_key":"upd-zero","version":0,"max_activations":5,"valid_hours":24,"enabled":true,"note":""}`),
		http.StatusBadRequest, "invalid_request")
	f.expectError(patch(created.ID, `{"version":3,"max_activations":5,"valid_hours":24,"enabled":true,"note":""}`),
		http.StatusBadRequest, "invalid_request")
	f.expectError(patch(created.ID, `{"request_key":"upd-extra","version":3,"max_activations":5,"valid_hours":24,"enabled":true,"note":"","force":true}`),
		http.StatusBadRequest, "invalid_request")
	f.expectError(patch(9999, `{"request_key":"upd-missing","version":1,"max_activations":5,"valid_hours":24,"enabled":true,"note":""}`),
		http.StatusNotFound, "not_found")

	// A customer activates the code: the limit of one is now used up.
	_, err := f.db.ActivatePromoCode(ctx, testutil.DefaultTelegramID, "summer20", time.Now())
	require.NoError(t, err)
	resp = patch(created.ID, `{"request_key":"upd-limit","version":3,"max_activations":1,"valid_hours":24,"enabled":true,"note":""}`)
	require.Equal(t, http.StatusOK, resp.StatusCode)
	var exhausted promoOutcomeWire
	f.decode(resp, &exhausted)
	require.NotNil(t, exhausted.Promo)
	assert.Equal(t, "exhausted", exhausted.Promo.State)
	assert.Equal(t, 1, exhausted.Promo.Activations)
	assert.Equal(t, 4, exhausted.Promo.Version)

	// Delete: versioned, and only a code nobody activated.
	del := func(id uint, body string) *http.Response {
		return f.do(http.MethodDelete, promoPath(id), f.withCSRF(), withJSON(body))
	}
	f.expectError(del(created.ID, `{"request_key":"del-stale","version":1}`), http.StatusConflict, "version_conflict")
	f.expectError(del(created.ID, `{"request_key":"del-used","version":4}`), http.StatusConflict, "promo_in_use")
	f.expectError(del(created.ID, `{"request_key":"del-zero","version":0}`), http.StatusBadRequest, "invalid_request")
	f.expectError(del(created.ID, `{"version":4}`), http.StatusBadRequest, "invalid_request")
	f.expectError(del(created.ID, `{"request_key":"del-extra","version":4,"force":true}`), http.StatusBadRequest, "invalid_request")
	f.expectError(del(9999, `{"request_key":"del-missing","version":1}`), http.StatusNotFound, "not_found")
	require.Len(t, f.listPromos(), 2)

	require.NotNil(t, firstOut.Promo)
	friendsID := firstOut.Promo.ID
	type deletedWire struct {
		promoOutcomeWire

		Deleted uint `json:"deleted"`
	}
	resp = del(friendsID, `{"request_key":"del-1","version":1}`)
	require.Equal(t, http.StatusOK, resp.StatusCode)
	var deleted, deletedAgain deletedWire
	f.decode(resp, &deleted)
	assert.Nil(t, deleted.Promo)
	assert.False(t, deleted.Replayed)
	assert.Equal(t, friendsID, deleted.Deleted)
	assert.Equal(t, string(database.AdminActionPromoDeleted), deleted.Audit.Action)

	// A retry of the delete replays; a new request finds nothing.
	resp = del(friendsID, `{"request_key":"del-1","version":1}`)
	require.Equal(t, http.StatusOK, resp.StatusCode)
	f.decode(resp, &deletedAgain)
	assert.True(t, deletedAgain.Replayed)
	assert.Equal(t, deleted.Audit.ID, deletedAgain.Audit.ID)
	assert.Equal(t, friendsID, deletedAgain.Deleted)
	f.expectError(del(friendsID, `{"request_key":"del-2","version":1}`), http.StatusNotFound, "not_found")

	list = f.listPromos()
	require.Len(t, list, 1)
	assert.Equal(t, "SUMMER20", list[0].Code)
	assert.Equal(t, 1, list[0].Activations)
	assert.Zero(t, list[0].Redeemed)
	assert.Equal(t, "exhausted", list[0].State)
	// create-1, create-2, upd-1, upd-code, upd-limit, del-1: rejections and
	// replays add nothing.
	assert.Equal(t, audits+6, f.auditCount())
}

// last returns the most recent delivery.
func (s *recordingOpsSender) last() (token string, chat int64, text string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.sent) == 0 {
		return "", 0, ""
	}
	m := s.sent[len(s.sent)-1]
	return m.token, m.chat, m.text
}

type opsOutcomeWire struct {
	Settings *service.OpsSettingsView `json:"settings"`
	Replayed bool                     `json:"replayed"`
	Audit    struct {
		ID     uint   `json:"id"`
		Action string `json:"action"`
	} `json:"audit"`
}

// opsBodyJSON is a settings payload; extra is appended as further members
// (the bot_token variants).
func opsBodyJSON(key string, version int, chatID int64, hour int, extra string) string {
	return fmt.Sprintf(`{"request_key":%q,"version":%d,"enabled":true,"chat_id":%d,"notify_servers":true,"notify_countries":true,`+
		`"notify_sources":false,"daily_report":true,"daily_report_hour":%d%s}`, key, version, chatID, hour, extra)
}

func (f *promoOpsAPIFixture) putOps(body string) *http.Response {
	f.t.Helper()
	return f.do(http.MethodPut, "/admin/api/ops", f.withCSRF(), withJSON(body))
}

// text reads a response body; the notification bot token must never be in it.
func (f *promoOpsAPIFixture) text(resp *http.Response) string {
	f.t.Helper()
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	require.NoError(f.t, err)
	assert.NotContains(f.t, string(body), promoOpsBotToken)
	return string(body)
}

// saveOps expects a stored (or replayed) settings save.
func (f *promoOpsAPIFixture) saveOps(body string) opsOutcomeWire {
	f.t.Helper()
	resp := f.putOps(body)
	require.Equal(f.t, http.StatusOK, resp.StatusCode)
	var out opsOutcomeWire
	require.NoError(f.t, json.Unmarshal([]byte(f.text(resp)), &out))
	require.NotNil(f.t, out.Settings)
	return out
}

func (f *promoOpsAPIFixture) opsSettings() service.OpsSettingsView {
	f.t.Helper()
	resp := f.do(http.MethodGet, "/admin/api/ops")
	require.Equal(f.t, http.StatusOK, resp.StatusCode)
	var view service.OpsSettingsView
	require.NoError(f.t, json.Unmarshal([]byte(f.text(resp)), &view))
	return view
}

func (f *promoOpsAPIFixture) opsEvents(query string) service.OpsEventsPage {
	f.t.Helper()
	resp := f.do(http.MethodGet, "/admin/api/ops/events"+query)
	require.Equal(f.t, http.StatusOK, resp.StatusCode)
	var page service.OpsEventsPage
	f.decode(resp, &page)
	require.NotNil(f.t, page.Events, "an empty feed is [], never null")
	return page
}

func (f *promoOpsAPIFixture) sendOpsTest() *http.Response {
	f.t.Helper()
	return f.do(http.MethodPost, "/admin/api/ops/test", f.withCSRF(), withJSON(`{}`))
}

//nolint:bodyclose // every body is closed by adminAPIFixture.doAs (t.Cleanup)
func TestAdminOpsAPI_SettingsVersioningAndBotToken(t *testing.T) {
	f := newPromoOpsAPIFixture(t)
	f.login()
	ctx := context.Background()
	audits := f.auditCount()

	// The defaults of the migration; the wire never carries the bot token.
	resp := f.do(http.MethodGet, "/admin/api/ops")
	require.Equal(t, http.StatusOK, resp.StatusCode)
	wire := f.raw(resp)
	for _, key := range []string{"enabled", "chat_id", "notify_servers", "notify_countries", "notify_sources", "daily_report",
		"daily_report_hour", "last_report_day", "baseline_at", "version", "updated_at", "own_bot", "effective_chat_id"} {
		assert.Contains(t, wire, key)
	}
	assert.Len(t, wire, 13)
	assert.NotContains(t, wire, "bot_token")
	initial := f.opsSettings()
	assert.True(t, initial.Enabled)
	assert.True(t, initial.NotifySources)
	assert.True(t, initial.DailyReport)
	assert.Equal(t, 9, initial.DailyReportHour)
	assert.Equal(t, 1, initial.Version)
	assert.Zero(t, initial.ChatID)
	assert.False(t, initial.OwnBot)
	assert.Equal(t, promoOpsAdminChat, initial.EffectiveChatID, "chat_id 0 falls back to the admin")

	// Rejections store nothing.
	f.expectError(f.putOps(opsBodyJSON("bad-hour", 1, 0, 24, "")), http.StatusBadRequest, "invalid_ops_settings")
	f.expectError(f.putOps(opsBodyJSON("bad-token", 1, 0, 7, `,"bot_token":"not-a-token"`)), http.StatusBadRequest, "invalid_ops_settings")
	f.expectError(f.putOps(opsBodyJSON("bad-version", 0, 0, 7, "")), http.StatusBadRequest, "invalid_ops_settings")
	f.expectError(f.putOps(opsBodyJSON("", 1, 0, 7, "")), http.StatusBadRequest, "invalid_request")
	f.expectError(f.putOps(opsBodyJSON("unknown", 1, 0, 7, `,"force":true`)), http.StatusBadRequest, "invalid_request")
	assert.Equal(t, 1, f.opsSettings().Version)
	assert.Equal(t, audits, f.auditCount(), "rejections are not audited")

	// A separate bot: stored server-side, reported only as own_bot.
	withToken := opsBodyJSON("save-1", 1, 0, 7, fmt.Sprintf(`,"bot_token":%q`, promoOpsBotToken))
	saved := f.saveOps(withToken)
	assert.False(t, saved.Replayed)
	assert.Equal(t, string(database.AdminActionOpsSettingsUpdated), saved.Audit.Action)
	assert.True(t, saved.Settings.OwnBot)
	assert.Equal(t, 2, saved.Settings.Version)
	assert.Equal(t, 7, saved.Settings.DailyReportHour)
	assert.False(t, saved.Settings.NotifySources)
	assert.Equal(t, promoOpsAdminChat, saved.Settings.EffectiveChatID)
	stored, err := f.db.GetOpsSettings(ctx)
	require.NoError(t, err)
	assert.Equal(t, promoOpsBotToken, stored.BotToken)

	// Replay, key conflict, stale version.
	replay := f.saveOps(withToken)
	assert.True(t, replay.Replayed)
	assert.Equal(t, saved.Audit.ID, replay.Audit.ID)
	f.expectError(f.putOps(opsBodyJSON("save-1", 2, 0, 8, "")), http.StatusConflict, "request_key_conflict")
	f.expectError(f.putOps(opsBodyJSON("save-stale", 1, 0, 8, "")), http.StatusConflict, "version_conflict")
	assert.Equal(t, audits+1, f.auditCount())

	// An absent or null bot_token keeps the stored token; a chat of its own
	// replaces the admin as the destination.
	const groupChat = int64(-1001234567890)
	kept := f.saveOps(opsBodyJSON("save-2", 2, groupChat, 7, ""))
	assert.True(t, kept.Settings.OwnBot)
	assert.Equal(t, groupChat, kept.Settings.ChatID)
	assert.Equal(t, groupChat, kept.Settings.EffectiveChatID)
	kept = f.saveOps(opsBodyJSON("save-3", 3, groupChat, 7, `,"bot_token":null`))
	assert.True(t, kept.Settings.OwnBot)
	assert.Equal(t, 4, kept.Settings.Version)

	// The test message goes through the configured bot to the configured chat.
	resp = f.sendOpsTest()
	require.Equal(t, http.StatusOK, resp.StatusCode)
	assert.Equal(t, map[string]any{"sent": true}, f.raw(resp))
	token, chat, text := f.sender.last()
	assert.Equal(t, promoOpsBotToken, token)
	assert.Equal(t, groupChat, chat)
	assert.Contains(t, text, "Проверка уведомлений")

	// An empty bot_token switches back to the main bot.
	cleared := f.saveOps(opsBodyJSON("save-4", 4, groupChat, 7, `,"bot_token":""`))
	assert.False(t, cleared.Settings.OwnBot)
	assert.Equal(t, 5, cleared.Settings.Version)
	stored, err = f.db.GetOpsSettings(ctx)
	require.NoError(t, err)
	assert.Empty(t, stored.BotToken)
	require.Equal(t, http.StatusOK, f.sendOpsTest().StatusCode)
	token, chat, _ = f.sender.last()
	assert.Empty(t, token)
	assert.Equal(t, groupChat, chat)

	// The audit log holds the credential-free projection only.
	var entries []database.AdminAuditLog
	require.NoError(t, f.db.GetDB().Where("action = ?", string(database.AdminActionOpsSettingsUpdated)).Find(&entries).Error)
	require.Len(t, entries, 4)
	for _, entry := range entries {
		assert.NotContains(t, entry.OldValue, promoOpsBotToken)
		assert.NotContains(t, entry.NewValue, promoOpsBotToken)
		assert.Contains(t, entry.NewValue, `"own_bot"`)
	}
	assert.Equal(t, audits+4, f.auditCount())
}

//nolint:bodyclose // every body is closed by adminAPIFixture.doAs (t.Cleanup)
func TestAdminOpsAPI_TestMessageAndEventFeed(t *testing.T) {
	f := newPromoOpsAPIFixture(t)
	f.login()

	empty := f.opsEvents("")
	assert.Empty(t, empty.Events)
	assert.Zero(t, empty.Total)
	assert.Equal(t, 50, empty.Limit)
	assert.Zero(t, empty.Offset)

	// The test route takes an empty object by POST only.
	resp := f.do(http.MethodGet, "/admin/api/ops/test")
	require.Equal(t, http.StatusMethodNotAllowed, resp.StatusCode)
	assert.Equal(t, "POST", resp.Header.Get("Allow"))
	f.expectError(f.do(http.MethodPost, "/admin/api/ops/test", f.withCSRF(), withJSON(`{"chat_id":1}`)), http.StatusBadRequest, "invalid_request")
	assert.Zero(t, f.sender.count())

	// Delivered: through the main bot to the admin, and recorded in the feed.
	resp = f.sendOpsTest()
	require.Equal(t, http.StatusOK, resp.StatusCode)
	assert.Equal(t, map[string]any{"sent": true}, f.raw(resp))
	require.Equal(t, 1, f.sender.count())
	token, chat, _ := f.sender.last()
	assert.Empty(t, token)
	assert.Equal(t, promoOpsAdminChat, chat)

	// A failed delivery is the operator's to fix: 502, and it is recorded too.
	f.sender.fail(errors.New("telegram: chat not found"))
	f.expectError(f.sendOpsTest(), http.StatusBadGateway, "ops_send_failed")
	assert.Equal(t, 1, f.sender.count())

	// Newest first.
	page := f.opsEvents("")
	require.Len(t, page.Events, 2)
	assert.Equal(t, int64(2), page.Total)
	failed, sent := page.Events[0], page.Events[1]
	assert.Equal(t, database.OpsKindTest, failed.Kind)
	assert.Equal(t, database.OpsSeverityWarning, failed.Severity)
	assert.Equal(t, database.OpsNotifyFailed, failed.NotifyStatus)
	assert.Contains(t, failed.NotifyError, "chat not found")
	assert.Nil(t, failed.NotifiedAt)
	assert.Equal(t, database.OpsKindTest, sent.Kind)
	assert.Equal(t, database.OpsSeverityInfo, sent.Severity)
	assert.Equal(t, database.OpsNotifySent, sent.NotifyStatus)
	assert.Empty(t, sent.NotifyError)
	assert.NotNil(t, sent.NotifiedAt)
	assert.JSONEq(t, `{}`, string(sent.Details))

	// The wire of an event: what the panel parses, and no internal columns.
	resp = f.do(http.MethodGet, "/admin/api/ops/events?limit=1")
	require.Equal(t, http.StatusOK, resp.StatusCode)
	var feed struct {
		Events []map[string]any `json:"events"`
	}
	f.decode(resp, &feed)
	require.Len(t, feed.Events, 1)
	for _, key := range []string{"id", "created_at", "kind", "severity", "title", "message", "builder_id", "source_id", "target_id",
		"country_code", "notify_status", "notified_at", "notify_error", "details"} {
		assert.Contains(t, feed.Events[0], key)
	}
	assert.Len(t, feed.Events[0], 14)

	// Filters and paging.
	warnings := f.opsEvents("?severity=warning")
	require.Len(t, warnings.Events, 1)
	assert.Equal(t, int64(1), warnings.Total)
	assert.Equal(t, failed.ID, warnings.Events[0].ID)
	assert.Empty(t, f.opsEvents("?kind=daily_report").Events)
	second := f.opsEvents("?kind=test&limit=1&offset=1")
	require.Len(t, second.Events, 1)
	assert.Equal(t, sent.ID, second.Events[0].ID)
	assert.Equal(t, int64(2), second.Total)
	assert.Equal(t, 1, second.Limit)
	assert.Equal(t, 1, second.Offset)

	for _, query := range []string{"?severity=fatal", "?limit=-1", "?limit=abc", "?offset=-1", "?page=2",
		"?kind=" + "kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk"} {
		f.expectError(f.do(http.MethodGet, "/admin/api/ops/events"+query), http.StatusBadRequest, "invalid_request")
	}
	resp = f.do(http.MethodPost, "/admin/api/ops/events", f.withCSRF(), withJSON(`{}`))
	require.Equal(t, http.StatusMethodNotAllowed, resp.StatusCode)
	assert.Equal(t, "GET, HEAD", resp.Header.Get("Allow"))
}

//nolint:bodyclose // every body is closed by adminAPIFixture.doAs (t.Cleanup)
func TestAdminOpsAPI_TestMessageWithoutDestination(t *testing.T) {
	// No TELEGRAM_ADMIN_ID and no chat in the settings: nowhere to send.
	f := newPromoOpsAPIFixtureFor(t, 0)
	f.login()

	assert.Zero(t, f.opsSettings().EffectiveChatID)
	f.expectError(f.sendOpsTest(), http.StatusConflict, "ops_not_configured")
	assert.Zero(t, f.sender.count())
	assert.Empty(t, f.opsEvents("").Events, "nothing was attempted, nothing is recorded")

	// A chat in the settings is enough.
	saved := f.saveOps(opsBodyJSON("chat-1", 1, 42, 9, ""))
	assert.Equal(t, int64(42), saved.Settings.EffectiveChatID)
	require.Equal(t, http.StatusOK, f.sendOpsTest().StatusCode)
	_, chat, _ := f.sender.last()
	assert.Equal(t, int64(42), chat)
	assert.Len(t, f.opsEvents("").Events, 1)
}

//nolint:bodyclose // every body is closed by adminAPIFixture.doAs (t.Cleanup)
func TestAdminOpsAPI_ReportPreview(t *testing.T) {
	f := newPromoOpsAPIFixture(t)
	f.login()

	report := func(query string) service.OpsReport {
		t.Helper()
		resp := f.do(http.MethodGet, "/admin/api/ops/report"+query)
		require.Equal(t, http.StatusOK, resp.StatusCode)
		var out service.OpsReport
		f.decode(resp, &out)
		require.NotNil(t, out.Stats)
		return out
	}

	// Today (the default) and yesterday are whole Moscow calendar days; the
	// snapshot counters describe the one seeded customer in both.
	today, yesterday := report(""), report("?day=yesterday")
	assert.Equal(t, today.Day, report("?day=today").Day)
	todayDate, err := time.Parse("2006-01-02", today.Day)
	require.NoError(t, err)
	yesterdayDate, err := time.Parse("2006-01-02", yesterday.Day)
	require.NoError(t, err)
	assert.Equal(t, 24*time.Hour, todayDate.Sub(yesterdayDate))

	for _, r := range []service.OpsReport{today, yesterday} {
		assert.Equal(t, int64(1), r.Stats.UsersTotal, r.Day)
		assert.Equal(t, int64(1), r.Stats.ActiveSubs, r.Day)
		assert.Zero(t, r.Stats.Purchases, r.Day)
		assert.NotNil(t, r.Stats.PeriodRevenue, "an empty revenue is [], never null")
		assert.NotNil(t, r.Stats.TotalRevenue, "an empty revenue is [], never null")
		assert.Equal(t, 24*time.Hour, r.Stats.To.Sub(r.Stats.From), r.Day)
		assert.Contains(t, r.Text, "Итоги дня")
		assert.Contains(t, r.Text, "Пользователей: <b>1</b>")
	}

	f.expectError(f.do(http.MethodGet, "/admin/api/ops/report?day=week"), http.StatusBadRequest, "invalid_request")
	resp := f.do(http.MethodPost, "/admin/api/ops/report", f.withCSRF(), withJSON(`{}`))
	require.Equal(t, http.StatusMethodNotAllowed, resp.StatusCode)
	assert.Equal(t, "GET, HEAD", resp.Header.Get("Allow"))
}
