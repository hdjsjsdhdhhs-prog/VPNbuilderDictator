//go:build adminsmoke

package web

// Local browser smoke stand: the real web.Server (admin auth, CSRF, admin API
// with сборки and their tariffs, embedded admin UI, /sub), the real network
// monitor and the real notifications worker on a temporary SQLite database.
// A local upstream serves two test catalogues whose servers are local TLS
// listeners, so the monitor probes them for real; Telegram is replaced by a
// recorder that writes every message to telegram.jsonl in the state directory.
// It never touches a real provider (unless the spec adds one through the UI,
// see frontend/admin/live/README.md), database or production setting. Run it
// only through
// frontend/admin/live/README.md (`go test -tags adminsmoke -run
// TestAdminLiveSmokeServer ./internal/web/`), then run the Playwright live
// spec against it; the test blocks until the spec writes the stop file.

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/hdjsjsdhdhhs-prog/VPNbuilderDictator/internal/config"
	"github.com/hdjsjsdhdhhs-prog/VPNbuilderDictator/internal/database"
	"github.com/hdjsjsdhdhhs-prog/VPNbuilderDictator/internal/netmon"
	"github.com/hdjsjsdhdhhs-prog/VPNbuilderDictator/internal/scheduler"
	"github.com/hdjsjsdhdhhs-prog/VPNbuilderDictator/internal/service"
	"github.com/hdjsjsdhdhhs-prog/VPNbuilderDictator/internal/subserver"
	"github.com/stretchr/testify/require"
	"golang.org/x/crypto/bcrypt"
)

// smokeAdminChat is the Telegram chat the stand "delivers" notifications to.
const smokeAdminChat = 777000

// smokeServers are local TLS listeners standing in for VPN servers: the
// network monitor probes them for real (TCP connect + TLS handshake). The spec
// takes one down and brings it back through files in the state directory.
type smokeServers struct {
	mu      sync.Mutex
	addrs   map[string]string
	running map[string]*httptest.Server
}

func (s *smokeServers) listen(key, addr string) error {
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		return err
	}
	srv := httptest.NewUnstartedServer(http.NotFoundHandler())
	_ = srv.Listener.Close()
	srv.Listener = listener
	srv.StartTLS()
	s.addrs[key], s.running[key] = listener.Addr().String(), srv
	return nil
}

// link starts the server of key and returns its share link.
func (s *smokeServers) link(t *testing.T, key, name string) string {
	t.Helper()
	s.mu.Lock()
	defer s.mu.Unlock()
	require.NoError(t, s.listen(key, "127.0.0.1:0"))
	return fmt.Sprintf("vless://%s@%s?security=tls&sni=%s.smoke.test&type=tcp#%s", key, s.addrs[key], key, url.PathEscape(name))
}

// down closes the listener: the next probe is refused.
func (s *smokeServers) down(key string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if srv := s.running[key]; srv != nil {
		srv.Close()
		delete(s.running, key)
	}
}

// up listens again on the same address.
func (s *smokeServers) up(key string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	addr, known := s.addrs[key]
	if !known || s.running[key] != nil {
		return nil
	}
	return s.listen(key, addr)
}

func (s *smokeServers) closeAll() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for key, srv := range s.running {
		srv.Close()
		delete(s.running, key)
	}
}

// control applies the "down-<key>" / "up-<key>" files the spec writes and
// removes each one as the acknowledgement.
func (s *smokeServers) control(t *testing.T, stateDir string) {
	s.mu.Lock()
	keys := make([]string, 0, len(s.addrs))
	for key := range s.addrs {
		keys = append(keys, key)
	}
	s.mu.Unlock()
	for _, key := range keys {
		if file := filepath.Join(stateDir, "down-"+key); os.Remove(file) == nil {
			s.down(key)
			t.Logf("smoke server %s is down", key)
		}
		if file := filepath.Join(stateDir, "up-"+key); os.Remove(file) == nil {
			require.NoError(t, s.up(key))
			t.Logf("smoke server %s is up", key)
		}
	}
}

// smokeTelegram records what would be sent to Telegram, one JSON line per
// message, so the spec can read the notifications.
type smokeTelegram struct {
	mu   sync.Mutex
	path string
}

func (r *smokeTelegram) SendOps(_ context.Context, _ string, chatID int64, html string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	line, err := json.Marshal(map[string]any{"chat_id": chatID, "html": html})
	if err != nil {
		return err
	}
	f, err := os.OpenFile(r.path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer func() { _ = f.Close() }()
	_, err = f.Write(append(line, '\n'))
	return err
}

// liveSmokeState is what the Playwright spec reads.
type liveSmokeState struct {
	SourceA        uint   `json:"source_a"`
	SourceB        uint   `json:"source_b"`
	OtherBuilder   uint   `json:"other_builder"`
	OtherRule      uint   `json:"other_rule"`
	SubscriptionID uint   `json:"subscription_id"`
	SubToken       string `json:"sub_token"`
	AdminChat      int64  `json:"admin_chat"`
}

func TestAdminLiveSmokeServer(t *testing.T) {
	addr := os.Getenv("ADMIN_SMOKE_ADDR")
	origin := os.Getenv("ADMIN_SMOKE_ORIGIN")
	password := os.Getenv("ADMIN_SMOKE_PASSWORD")
	stateDir := os.Getenv("ADMIN_SMOKE_STATE_DIR")
	if addr == "" || origin == "" || password == "" || stateDir == "" {
		t.Skip("ADMIN_SMOKE_ADDR, ADMIN_SMOKE_ORIGIN, ADMIN_SMOKE_PASSWORD and ADMIN_SMOKE_STATE_DIR are required")
	}
	ctx := context.Background()

	servers := &smokeServers{addrs: map[string]string{}, running: map[string]*httptest.Server{}}
	t.Cleanup(servers.closeAll)
	catalogues := map[string][]string{
		"/a": {
			servers.link(t, "de1", "🇩🇪 Frankfurt"),
			servers.link(t, "de2", "🇩🇪 Berlin"),
			servers.link(t, "nl", "🇳🇱 Amsterdam"),
			servers.link(t, "fi", "🇫🇮 Helsinki"),
		},
		"/b": {
			servers.link(t, "us", "🇺🇸 Dallas"),
			servers.link(t, "de3", "🇩🇪 Munich"),
		},
	}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		links, ok := catalogues[r.URL.Path]
		if !ok {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write([]byte(strings.Join(links, "\n")))
	}))
	t.Cleanup(upstream.Close)

	db, err := database.NewService(filepath.Join(t.TempDir(), "admin-live-smoke.db"))
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })

	builders := service.NewBuilderService(db)
	builders.SetCatalogueFetcher(func(ctx context.Context, src database.ProviderSource) (*service.FetchedCatalogue, error) {
		c, err := subserver.FetchSourceCatalogue(ctx, src)
		if err != nil {
			return nil, err
		}
		return &service.FetchedCatalogue{Format: c.Format, Entries: c.Entries, Skipped: c.Skipped, Duplicates: c.Duplicates}, nil
	})

	newSource := func(name, path string) uint {
		view, sync, err := builders.CreateSource(ctx, service.CreateSourceInput{
			Name: name, Type: "auto", SubscriptionURL: upstream.URL + path, Headers: "{}", Enabled: true,
		})
		require.NoError(t, err)
		require.NotNil(t, sync)
		require.Equal(t, database.SourceSyncOK, sync.Status, name)
		return view.ID
	}
	state := liveSmokeState{SourceA: newSource("Smoke A", "/a"), SourceB: newSource("Smoke B", "/b"), AdminChat: smokeAdminChat}

	// Another builder with its own rule (ownership checks).
	other, err := db.CreateBuilder(ctx, database.AdminConfigMeta{Actor: "seed", RequestKey: "seed-other"}, database.BuilderCreateInput{Name: "Чужой", Enabled: true})
	require.NoError(t, err)
	state.OtherBuilder = other.TargetID
	cur, err := db.GetBuilder(ctx, other.TargetID)
	require.NoError(t, err)
	_, err = db.SaveBuilderConfiguration(ctx, database.AdminConfigMeta{Actor: "seed", RequestKey: "seed-other-cfg"}, database.BuilderConfigurationInput{
		ID: other.TargetID, Version: cur.Version, Name: cur.Name, Enabled: true, SourceIDs: []uint{state.SourceB},
		Items: []database.BuilderConfigItem{{Kind: database.BuilderItemKindCountry, SourceID: state.SourceB, CountryCode: "US", Enabled: true}},
	})
	require.NoError(t, err)
	cur, err = db.GetBuilder(ctx, other.TargetID)
	require.NoError(t, err)
	state.OtherRule = cur.Items[0].ID

	// A customer subscription; the spec assigns the builder to it.
	free, err := db.GetPlanByName(ctx, database.FreePlanName)
	require.NoError(t, err)
	expires := time.Now().Add(24 * time.Hour)
	sub := &database.Subscription{
		TelegramID: 777001, ClientID: "smoke-client", SubscriptionID: "smoke-sub", ExpiresAt: &expires,
		Status: string(database.SubscriptionStatusActive), PlanID: free.ID,
	}
	require.NoError(t, db.CreateSubscription(ctx, sub, ""))
	state.SubscriptionID, state.SubToken = sub.ID, sub.Token

	hash, err := bcrypt.GenerateFromPassword([]byte(password), config.AdminMinBcryptCost)
	require.NoError(t, err)
	cfg := &config.Config{AdminUsername: "admin", AdminPasswordHash: string(hash), SiteURL: origin}
	subSrv := subserver.NewService(time.Minute)
	t.Cleanup(subSrv.Stop)
	// The admin namespace requires an https SITE_URL (config.AdminConfiguration),
	// so the browser talks to a local TLS proxy (self-signed httptest cert) in
	// front of the plain server, exactly like production TLS termination.
	const internalAddr = "127.0.0.1:18182"
	s := NewServer(internalAddr, db, cfg, "", nil, subSrv)
	s.SetAdminService(service.NewAdminService(db, nil))
	s.SetBuilderService(builders)
	// The constructor of a сборка sets its price: a tariff sold on the builder.
	s.SetTariffService(service.NewTariffService(db))
	s.SetPromoService(service.NewPromoService(db))

	// The network monitor and the notifications, wired like cmd/bot: the
	// monitor resolves the сборки with the /sub pipeline and probes their
	// servers; a finished round wakes the notifications worker. Only the
	// background loop is not started — the spec runs the rounds itself with
	// «Проверить сейчас», which keeps the scenario deterministic.
	monitor := netmon.New(db, func(ctx context.Context, list []database.SubscriptionBuilder) ([]subserver.MonitorBuilder, error) {
		return subserver.ResolveMonitorBuilders(ctx, db, list)
	}, netmon.NetProber{Timeout: 3 * time.Second}, netmon.Config{Enabled: true, Timeout: 3 * time.Second})
	ops := service.NewOpsService(db, monitor, smokeAdminChat)
	ops.SetSender(&smokeTelegram{path: filepath.Join(stateDir, "telegram.jsonl")})
	monitor.SetAfterRound(ops.RequestTick)
	s.SetNetworkMonitor(monitor)
	s.SetOpsService(ops)
	workerCtx, stopWorker := context.WithCancel(ctx)
	workerDone := make(chan struct{})
	go func() {
		defer close(workerDone)
		scheduler.NewOpsWorker(ops).Run(workerCtx)
	}()
	t.Cleanup(func() {
		stopWorker()
		<-workerDone
	})

	require.NoError(t, s.Start(ctx))
	t.Cleanup(func() {
		stopCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = s.Stop(stopCtx)
	})

	backend, err := url.Parse("http://" + internalAddr)
	require.NoError(t, err)
	proxy := httptest.NewUnstartedServer(&httputil.ReverseProxy{Rewrite: func(r *httputil.ProxyRequest) {
		r.SetURL(backend)
		r.Out.Host = r.In.Host
	}})
	listener, err := net.Listen("tcp", addr)
	require.NoError(t, err)
	_ = proxy.Listener.Close()
	proxy.Listener = listener
	proxy.StartTLS()
	t.Cleanup(proxy.Close)

	raw, err := json.Marshal(state)
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(filepath.Join(stateDir, "state.json"), raw, 0o600))
	t.Logf("admin live smoke server ready on %s", addr)

	stop := filepath.Join(stateDir, "stop")
	deadline := time.Now().Add(15 * time.Minute)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(stop); err == nil {
			return
		}
		servers.control(t, stateDir)
		time.Sleep(250 * time.Millisecond)
	}
	t.Fatal("smoke stand timed out waiting for the stop file")
}
