package web

import (
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/hdjsjsdhdhhs-prog/VPNbuilderDictator/internal/config"
	"github.com/hdjsjsdhdhhs-prog/VPNbuilderDictator/internal/database"
	"github.com/hdjsjsdhdhhs-prog/VPNbuilderDictator/internal/service"
	"github.com/hdjsjsdhdhhs-prog/VPNbuilderDictator/internal/subserver"
	"github.com/hdjsjsdhdhhs-prog/VPNbuilderDictator/internal/testutil"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"golang.org/x/crypto/bcrypt"
)

// The product path end to end, wired like cmd/bot (lifecycle.go): ready
// provider subscription URLs are added as Sources through the admin HTTP API,
// synced into the catalogue by the production fetcher/parser, composed by a
// Builder whose configuration is saved by the editor route, assigned to the
// customer's plan, and served on the public /sub URL. Every step checks the
// content the VPN client receives, not only the status code.

// e2eProvider is a mock VPN provider: a ready subscription URL that requires
// its own credentials and whose server list can change between syncs.
type e2eProvider struct {
	srv    *httptest.Server
	auth   string
	hwid   string
	base64 bool
	body   atomic.Pointer[string]
	status atomic.Int32
	hits   atomic.Int32
}

func newE2EProvider(t *testing.T, auth, hwid string, base64Body bool, links ...string) *e2eProvider {
	t.Helper()
	p := &e2eProvider{auth: auth, hwid: hwid, base64: base64Body}
	p.status.Store(http.StatusOK)
	p.setLinks(links...)
	p.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p.hits.Add(1)
		if r.Header.Get("Authorization") != p.auth || r.Header.Get("X-Hwid") != p.hwid {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		w.WriteHeader(int(p.status.Load()))
		_, _ = io.WriteString(w, *p.body.Load())
	}))
	t.Cleanup(p.srv.Close)
	return p
}

func (p *e2eProvider) setLinks(links ...string) {
	body := strings.Join(links, "\n")
	if p.base64 {
		body = base64.StdEncoding.EncodeToString([]byte(body))
	}
	p.body.Store(&body)
}

func e2eLink(host, name string) string {
	return "vless://11111111-2222-3333-4444-555555555555@" + net.JoinHostPort(host, "443") +
		"?security=tls&sni=" + host + "&type=tcp#" + url.PathEscape(name)
}

func TestSourcesBuilderSubscription_AdminHTTPToPublicSub(t *testing.T) {
	ctx := context.Background()
	db, err := testutil.NewTestDatabaseService(t)
	require.NoError(t, err)

	// Two providers in different formats, each with its own credentials.
	provA := newE2EProvider(t, "Bearer token-a", "hwid-a", true,
		e2eLink("de1.provider-a.example", "🇩🇪 Frankfurt"),
		e2eLink("de2.provider-a.example", "🇩🇪 Berlin"),
		e2eLink("nl.provider-a.example", "🇳🇱 Amsterdam"),
		e2eLink("fi.provider-a.example", "🇫🇮 Helsinki"),
	)
	provB := newE2EProvider(t, "Bearer token-b", "hwid-b", false,
		e2eLink("us.provider-b.example", "🇺🇸 Dallas"),
		e2eLink("de.provider-b.example", "🇩🇪 Munich"),
	)

	// Production wiring (cmd/bot/lifecycle.go): /sub cache invalidation and the
	// server-side catalogue fetcher.
	hash, err := bcrypt.GenerateFromPassword([]byte(adminTestPassword), config.AdminMinBcryptCost)
	require.NoError(t, err)
	cfg := &config.Config{AdminUsername: "admin", AdminPasswordHash: string(hash), SiteURL: "https://admin.example.com",
		GlobalSubURL: "https://sub.example.com/sub/"}
	subSvc := service.NewSubscriptionService(db, cfg)
	runtime := subserver.NewService(time.Minute)
	t.Cleanup(runtime.Stop)
	subSvc.SetInvalidateBySubIDFunc(runtime.InvalidateCache)
	srv := NewServer("127.0.0.1:0", db, cfg, "", subSvc, runtime)
	srv.SetAdminService(service.NewAdminService(db, subSvc))
	builders := service.NewBuilderService(db)
	builders.SetCatalogueFetcher(func(ctx context.Context, src database.ProviderSource) (*service.FetchedCatalogue, error) {
		c, err := subserver.FetchSourceCatalogue(ctx, src)
		if err != nil {
			return nil, err
		}
		return &service.FetchedCatalogue{Format: c.Format, Entries: c.Entries, Skipped: c.Skipped, Duplicates: c.Duplicates}, nil
	})
	srv.SetBuilderService(builders)
	require.NoError(t, srv.Start(ctx))
	t.Cleanup(func() {
		stopCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		require.NoError(t, srv.Stop(stopCtx))
	})
	f := &adminAPIFixture{t: t, db: db}
	f.attach(srv)
	f.login()

	readJSON := func(resp *http.Response, status int, v any) {
		t.Helper()
		defer resp.Body.Close()
		body, err := io.ReadAll(resp.Body)
		require.NoError(t, err)
		require.Equal(t, status, resp.StatusCode, "%s", body)
		for _, secret := range []string{"token-a", "token-b", "hwid-a", "hwid-b", provA.srv.URL, provB.srv.URL} {
			assert.NotContains(t, string(body), secret, "admin responses never carry provider credentials")
		}
		if v != nil {
			require.NoError(t, jsonUnmarshal(string(body), v))
		}
	}

	// 1. Ready provider URLs become Sources; creation syncs the catalogue.
	addSource := func(name string, p *e2eProvider, format string) service.SourceView {
		body := fmt.Sprintf(`{"name":%q,"description":"","type":%q,"subscription_url":%q,"hwid":%q,"user_agent":"DictatorVPN-E2E","headers":%q,"enabled":true}`,
			name, format, p.srv.URL+"/sub/private", p.hwid, `{"Authorization":"`+p.auth+`"}`)
		var out struct {
			Source service.SourceView `json:"source"`
			Sync   *syncWire          `json:"sync"`
		}
		readJSON(f.do(http.MethodPost, "/admin/api/sources", f.withCSRF(), withJSON(body)), http.StatusCreated, &out)
		require.NotNil(t, out.Sync)
		require.Equal(t, "ok", out.Sync.Status, out.Sync.Error)
		return out.Source
	}
	srcA := addSource("Provider A", provA, "base64")
	srcB := addSource("Provider B", provB, "")
	assert.Equal(t, 4, srcA.Catalogue.Entries)
	assert.Equal(t, 2, srcB.Catalogue.Entries)

	entryOf := func(sourceID uint, name string) database.ProviderSourceEntry {
		t.Helper()
		var out struct {
			Entries []database.ProviderSourceEntry `json:"entries"`
		}
		readJSON(f.do(http.MethodGet, sourcePath(sourceID, "/entries")), http.StatusOK, &out)
		for _, e := range out.Entries {
			if e.OriginalName == name {
				return e
			}
		}
		t.Fatalf("entry %q not in the catalogue of source %d", name, sourceID)
		return database.ProviderSourceEntry{}
	}
	amsterdam := entryOf(srcA.ID, "🇳🇱 Amsterdam")
	frankfurt := entryOf(srcA.ID, "🇩🇪 Frankfurt")
	assert.Equal(t, "NL", amsterdam.CountryCode)

	// 2. A Builder over both sources: DE of A, Amsterdam renamed, US of B,
	// a disabled FI rule, and Frankfurt again (already selected → once).
	var created struct {
		Builder service.BuilderView `json:"builder"`
	}
	readJSON(f.do(http.MethodPost, "/admin/api/builders", f.withCSRF(), withJSON(
		`{"request_key":"e2e-create","name":"DictatorVPN Europe+US","description":"","enabled":true,"profile_title":"","support_url":"","announce":""}`)),
		http.StatusCreated, &created)
	vip := "Нидерланды VIP"
	keys := 0
	saveConfig := func(items []configItemWire, sourceIDs ...uint) service.BuilderView {
		t.Helper()
		var current service.BuilderView
		readJSON(f.do(http.MethodGet, builderPath(created.Builder.ID, "")), http.StatusOK, &current)
		keys++
		c := configOf(current, fmt.Sprintf("e2e-config-%d", keys))
		c.ProfileTitle, c.SupportURL = "DictatorVPN", "https://t.me/dictator_support"
		c.SourceIDs, c.Items = sourceIDs, items
		var out struct {
			Builder service.BuilderView `json:"builder"`
		}
		readJSON(f.do(http.MethodPut, builderPath(created.Builder.ID, "/configuration"), f.withCSRF(), withJSON(jsonBody(t, c))), http.StatusOK, &out)
		return out.Builder
	}
	rules := []configItemWire{
		{Kind: "country", SourceID: srcA.ID, CountryCode: "DE", Enabled: true},
		{Kind: "node", SourceID: srcA.ID, Fingerprint: amsterdam.Fingerprint, OriginalName: amsterdam.OriginalName, CustomName: &vip, Enabled: true},
		{Kind: "country", SourceID: srcB.ID, CountryCode: "US", Enabled: true},
		{Kind: "country", SourceID: srcA.ID, CountryCode: "FI", Enabled: false},
		{Kind: "node", SourceID: srcA.ID, Fingerprint: frankfurt.Fingerprint, OriginalName: frankfurt.OriginalName, Enabled: true},
	}
	saveConfig(rules, srcA.ID, srcB.ID)

	// 3. The customer's plan is served by the builder.
	sub, err := subSvc.Create(ctx, 700700700, "customer", "")
	require.NoError(t, err)
	readJSON(f.do(http.MethodPost, fmt.Sprintf("/admin/api/plans/%d/builder", sub.Subscription.PlanID), f.withCSRF(),
		withJSON(fmt.Sprintf(`{"request_key":"e2e-plan","builder_id":%d}`, created.Builder.ID))), http.StatusOK, nil)

	// 4. One public URL, the selected servers in rule order.
	fetchSub := func() (int, []string, http.Header) {
		t.Helper()
		resp, err := f.anon.Get(f.tls.URL + "/sub/" + sub.Subscription.Token)
		require.NoError(t, err)
		defer resp.Body.Close()
		body, err := io.ReadAll(resp.Body)
		require.NoError(t, err)
		for _, secret := range []string{"token-a", "token-b", "hwid-a", "hwid-b", provA.srv.URL, provB.srv.URL, "Provider A"} {
			assert.NotContains(t, string(body), secret, "the client never sees provider credentials")
		}
		if resp.StatusCode != http.StatusOK {
			return resp.StatusCode, []string{string(body)}, resp.Header
		}
		decoded, err := base64.StdEncoding.DecodeString(string(body))
		require.NoError(t, err, "the subscription body is base64")
		links := strings.Split(strings.TrimSpace(string(decoded)), "\n")
		names := make([]string, 0, len(links))
		for _, l := range links {
			require.True(t, strings.HasPrefix(l, "vless://"), "every line is a share link: %q", l)
			names = append(names, subserver.EntryName(l))
		}
		return resp.StatusCode, names, resp.Header
	}
	status, names, headers := fetchSub()
	require.Equal(t, http.StatusOK, status)
	assert.Equal(t, []string{"🇩🇪 Frankfurt", "🇩🇪 Berlin", vip, "🇺🇸 Dallas"}, names,
		"DE of A, the renamed server, US of B; Helsinki (disabled) and Munich (unselected) are absent; Frankfurt once")
	assert.Equal(t, "text/plain; charset=utf-8; profile=base64", headers.Get("Content-Type"))
	title := strings.TrimPrefix(headers.Get("Profile-Title"), "base64:")
	decodedTitle, err := base64.StdEncoding.DecodeString(title)
	require.NoError(t, err)
	assert.True(t, strings.HasPrefix(string(decodedTitle), "DictatorVPN"), "builder metadata: %q", decodedTitle)
	assert.Equal(t, "https://t.me/dictator_support", headers.Get("Support-Url"))

	// 5. A repeated request is served from the cache.
	hitsA, hitsB := provA.hits.Load(), provB.hits.Load()
	status, names2, _ := fetchSub()
	require.Equal(t, http.StatusOK, status)
	assert.Equal(t, names, names2)
	assert.Equal(t, hitsA, provA.hits.Load())
	assert.Equal(t, hitsB, provB.hits.Load())

	// 6. The provider changes its servers; a refresh updates the catalogue and
	// the subscription: the country rule picks the new DE server, the renamed
	// server keeps its rule through its fingerprint.
	provA.setLinks(
		e2eLink("de1.provider-a.example", "🇩🇪 Frankfurt"),
		e2eLink("nl.provider-a.example", "🇳🇱 Amsterdam"),
		e2eLink("de3.provider-a.example", "🇩🇪 Hamburg"),
		e2eLink("fi.provider-a.example", "🇫🇮 Helsinki"),
	)
	var refreshed syncWire
	readJSON(f.do(http.MethodPost, sourcePath(srcA.ID, "/refresh"), f.withCSRF(), withJSON("{}")), http.StatusOK, &refreshed)
	assert.Equal(t, "ok", refreshed.Status)
	assert.Equal(t, 1, refreshed.Added)
	assert.Equal(t, 1, refreshed.Removed)
	status, names, _ = fetchSub()
	require.Equal(t, http.StatusOK, status)
	assert.Equal(t, []string{"🇩🇪 Frankfurt", "🇩🇪 Hamburg", vip, "🇺🇸 Dallas"}, names)

	// 7. One provider is down: the others are still served (best effort).
	provB.status.Store(http.StatusBadGateway)
	reordered := []configItemWire{rules[2], rules[0], rules[1]}
	saveConfig(reordered, srcA.ID, srcB.ID)
	status, names, _ = fetchSub()
	require.Equal(t, http.StatusOK, status)
	assert.Equal(t, []string{"🇩🇪 Frankfurt", "🇩🇪 Hamburg", vip}, names)

	// 8. Every source is down: a safe 503 (ErrProviderSourceUnavailable), no
	// fallback content and nothing about the providers.
	provA.status.Store(http.StatusBadGateway)
	saveConfig(reordered, srcA.ID, srcB.ID)
	status, body, _ := fetchSub()
	assert.Equal(t, http.StatusServiceUnavailable, status)
	assert.Equal(t, []string{"Subscription source is unavailable"}, body)

	// 9. Providers are back: the new rule order is served.
	provA.status.Store(http.StatusOK)
	provB.status.Store(http.StatusOK)
	status, names, _ = fetchSub()
	require.Equal(t, http.StatusOK, status)
	assert.Equal(t, []string{"🇺🇸 Dallas", "🇩🇪 Frankfurt", "🇩🇪 Hamburg", vip}, names)

	// 10. Access is revoked and restored from the admin panel at the same URL.
	readJSON(f.do(http.MethodPost, f.subscriptionPath(sub.Subscription.ID)+"/disable", f.withCSRF(),
		withJSON(`{"request_key":"e2e-disable"}`)), http.StatusOK, nil)
	status, _, _ = fetchSub()
	assert.Equal(t, http.StatusNotFound, status, "a disabled subscription is not served, even from the cache")
	readJSON(f.do(http.MethodPost, f.subscriptionPath(sub.Subscription.ID)+"/enable", f.withCSRF(),
		withJSON(`{"request_key":"e2e-enable"}`)), http.StatusOK, nil)
	status, names, _ = fetchSub()
	require.Equal(t, http.StatusOK, status)
	assert.Equal(t, []string{"🇺🇸 Dallas", "🇩🇪 Frankfurt", "🇩🇪 Hamburg", vip}, names)
}
