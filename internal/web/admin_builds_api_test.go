package web

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/hdjsjsdhdhhs-prog/VPNbuilderDictator/internal/config"
	"github.com/hdjsjsdhdhhs-prog/VPNbuilderDictator/internal/database"
	"github.com/hdjsjsdhdhhs-prog/VPNbuilderDictator/internal/netmon"
	"github.com/hdjsjsdhdhhs-prog/VPNbuilderDictator/internal/service"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"golang.org/x/crypto/bcrypt"
)

// HTTP contract of the "сборка" flow: a tariff is sold on a builder (the plan
// behind it is internal), the link of a source can be replaced, and the
// network monitor can be asked for a check right now.

// newBuildsAPIFixture wires the builder and tariff services on one database.
func newBuildsAPIFixture(t *testing.T) *adminAPIFixture {
	t.Helper()
	base := newAdminAPIFixtureNoServer(t)
	hash, err := bcrypt.GenerateFromPassword([]byte(adminTestPassword), config.AdminMinBcryptCost)
	require.NoError(t, err)
	cfg := &config.Config{AdminUsername: "admin", AdminPasswordHash: string(hash), SiteURL: "https://admin.example.com"}
	s := NewServer("127.0.0.1:0", nil, cfg, "", nil, nil)
	s.SetAdminService(service.NewAdminService(base.db, nil))
	s.SetBuilderService(service.NewBuilderService(base.db))
	s.SetTariffService(service.NewTariffService(base.db))
	require.NoError(t, s.Start(context.Background()))
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		require.NoError(t, s.Stop(ctx))
	})
	base.attach(s)
	return base
}

//nolint:bodyclose // every body is closed by adminAPIFixture.doAs (t.Cleanup)
func TestAdminTariffAPI_SoldOnABuilder(t *testing.T) {
	f := newBuildsAPIFixture(t)
	f.login()

	resp := f.do(http.MethodPost, "/admin/api/builders", f.withCSRF(),
		withJSON(`{"request_key":"build-create","name":"Европа","description":"","enabled":true,"profile_title":"","support_url":"","announce":""}`))
	require.Equal(t, http.StatusCreated, resp.StatusCode)
	var created struct {
		Builder service.BuilderView `json:"builder"`
	}
	f.decode(resp, &created)
	builderID := created.Builder.ID
	assert.Nil(t, created.Builder.Sales.PlanID, "no plan until the builder is sold")

	tariff := func(key string, builder uint) string {
		return fmt.Sprintf(`{"request_key":%q,"name":"Месяц","builder_id":%d,"duration_days":30,"price_cents":19900,"currency":"RUB",`+
			`"description":"","features":[],"badge":"","is_active":true}`, key, builder)
	}

	// No plan_id: the panel names only the builder.
	resp = f.do(http.MethodPost, "/admin/api/tariffs", f.withCSRF(), withJSON(tariff("tariff-on-build", builderID)))
	require.Equal(t, http.StatusCreated, resp.StatusCode)
	var out tariffOutcomeWire
	f.decode(resp, &out)
	require.NotNil(t, out.Tariff)
	require.NotNil(t, out.Tariff.BuilderID)
	assert.Equal(t, builderID, *out.Tariff.BuilderID)
	assert.Equal(t, "Европа", out.Tariff.BuilderName)
	assert.Equal(t, "Европа", out.Tariff.PlanName)
	assert.NotZero(t, out.Tariff.PlanID)

	// The builder now reports its sale plan; it is in use while the tariff exists.
	var view service.BuilderView
	f.decode(f.do(http.MethodGet, builderPath(builderID, "")), &view)
	require.NotNil(t, view.Sales.PlanID)
	assert.Equal(t, out.Tariff.PlanID, *view.Sales.PlanID)
	assert.Equal(t, []database.DependentRef{{ID: out.Tariff.PlanID, Name: "Европа"}}, view.Dependents.Plans)

	// The same key replays; an unknown builder is an invalid field.
	resp = f.do(http.MethodPost, "/admin/api/tariffs", f.withCSRF(), withJSON(tariff("tariff-on-build", builderID)))
	require.Equal(t, http.StatusCreated, resp.StatusCode)
	var replay tariffOutcomeWire
	f.decode(resp, &replay)
	assert.True(t, replay.Replayed)
	assert.Equal(t, out.Tariff.ID, replay.Tariff.ID)

	resp = f.do(http.MethodPost, "/admin/api/tariffs", f.withCSRF(), withJSON(tariff("tariff-unknown-build", 424242)))
	require.Equal(t, http.StatusBadRequest, resp.StatusCode)
	var rejected map[string]any
	f.decode(resp, &rejected)
	assert.Equal(t, map[string]any{"error": "invalid_tariff", "field": "builder_id"}, rejected)
}

//nolint:bodyclose // every body is closed by adminAPIFixture.doAs (t.Cleanup)
func TestAdminSourceAPI_ReplacesTheSubscriptionLink(t *testing.T) {
	f := newSourceAPIFixture(t)
	f.login()
	src := f.mustCreateSource(f.createBody("Liberty", ""))
	firstHits := f.hits.Load()
	require.Positive(t, firstHits, "the initial sync fetched the first link")

	// The provider issued a new link: a second upstream with the same content.
	var rotatedHits atomic.Int32
	rotated := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rotatedHits.Add(1)
		assert.Equal(t, sourceTestHWID, r.Header.Get("X-Hwid"), "untouched credentials are kept")
		assert.Equal(t, sourceTestHeader, r.Header.Get("X-Token"))
		proxied, err := http.NewRequestWithContext(r.Context(), http.MethodGet, f.upstream.URL+"/rotated", nil)
		if !assert.NoError(t, err) {
			return
		}
		proxied.Header = r.Header.Clone()
		upstream, err := http.DefaultClient.Do(proxied)
		if !assert.NoError(t, err) {
			return
		}
		defer upstream.Body.Close()
		w.WriteHeader(upstream.StatusCode)
		_, _ = io.Copy(w, upstream.Body)
	}))
	t.Cleanup(rotated.Close)

	patch := func(body string) *http.Response {
		return f.do(http.MethodPatch, sourcePath(src.ID, ""), f.withCSRF(), withJSON(body))
	}
	stored := func() database.ProviderSource {
		t.Helper()
		var row database.ProviderSource
		require.NoError(t, f.db.GetDB().First(&row, src.ID).Error)
		return row
	}
	before := stored()

	// A malformed link is rejected and nothing changes.
	for _, bad := range []string{`"ftp://example.com/sub"`, `"not a url"`, `"https://example.com/sub#fragment"`} {
		f.expectSourceField(patch(`{"name":"Liberty","description":"","type":"auto","subscription_url":`+bad+`}`), "subscription_url")
	}
	f.expectSourceField(patch(`{"name":"Liberty","description":"","type":"auto","headers":"[1]"}`), "headers")
	assert.Equal(t, before.SubscriptionURL, stored().SubscriptionURL)
	assert.Equal(t, before.Headers, stored().Headers)

	// The new link is stored and never echoed; the other credentials stay.
	resp := patch(fmt.Sprintf(`{"name":"Liberty","description":"","type":"auto","subscription_url":%q}`, rotated.URL+"/connection/subs/rotated-token"))
	require.Equal(t, http.StatusOK, resp.StatusCode)
	body := f.text(resp)
	assert.NotContains(t, body, rotated.URL)
	assert.NotContains(t, body, "rotated-token")
	after := stored()
	assert.Equal(t, rotated.URL+"/connection/subs/rotated-token", after.SubscriptionURL)
	assert.Equal(t, before.HWID, after.HWID)
	assert.Equal(t, before.UserAgent, after.UserAgent)
	assert.Equal(t, before.Headers, after.Headers)

	// A metadata edit without the member keeps the new link.
	resp = patch(`{"name":"Liberty 2","description":"","type":"auto"}`)
	require.Equal(t, http.StatusOK, resp.StatusCode)
	_ = f.text(resp)
	assert.Equal(t, after.SubscriptionURL, stored().SubscriptionURL)

	// The next sync goes to the new link.
	resp = f.do(http.MethodPost, sourcePath(src.ID, "/refresh"), f.withCSRF(), withJSON(`{}`))
	require.Equal(t, http.StatusOK, resp.StatusCode)
	var sync syncWire
	require.NoError(t, jsonUnmarshal(f.text(resp), &sync))
	assert.Equal(t, database.SourceSyncOK, sync.Status)
	assert.EqualValues(t, 1, rotatedHits.Load())
}

//nolint:bodyclose // every body is closed by adminAPIFixture.doAs (t.Cleanup)
func TestAdminAPI_MonitoringCheckNow(t *testing.T) {
	monitor := &stubMonitor{}
	f := newMonitorAPIFixture(t, monitor)
	f.login()
	const path = "/admin/api/monitoring/check"

	// Only an explicit, CSRF-protected POST runs a check.
	assert.Equal(t, http.StatusMethodNotAllowed, f.do(http.MethodGet, path).StatusCode)
	assert.Equal(t, http.StatusForbidden, f.do(http.MethodPost, path, withJSON(`{}`)).StatusCode)
	f.expectError(f.do(http.MethodPost, path, f.withCSRF(), withJSON(`{"force":true}`)), http.StatusBadRequest, "invalid_request")
	assert.Zero(t, monitor.checks)

	// A check answers the fresh overview.
	resp := f.do(http.MethodPost, path, f.withCSRF(), withJSON(`{}`))
	require.Equal(t, http.StatusOK, resp.StatusCode)
	var out netmon.Overview
	f.decode(resp, &out)
	require.Len(t, out.Builders, 1)
	assert.Equal(t, 1, monitor.checks)

	// A pass already running is a conflict, not an error.
	monitor.checkErr = netmon.ErrCheckInProgress
	f.expectError(f.do(http.MethodPost, path, f.withCSRF(), withJSON(`{}`)), http.StatusConflict, "check_in_progress")
	monitor.checkErr = context.DeadlineExceeded
	f.expectError(f.do(http.MethodPost, path, f.withCSRF(), withJSON(`{}`)), http.StatusGatewayTimeout, "check_timeout")
}
