package subserver

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/hdjsjsdhdhhs-prog/VPNbuilderDictator/internal/database"
	"github.com/hdjsjsdhdhhs-prog/VPNbuilderDictator/internal/testutil"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const (
	monUUID      = "11111111-2222-3333-4444-555555555555"
	monPassword  = "s3cr3t-pa55"
	monObfsKey   = "obfs-k3y"
	monRealityPK = "realityPublicKeyXYZ"
)

func TestMonitorEndpointFromLink(t *testing.T) {
	t.Parallel()

	ssUser := base64.RawURLEncoding.EncodeToString([]byte("chacha20-ietf-poly1305:" + monPassword))
	ssLegacy := base64.StdEncoding.EncodeToString([]byte("aes-256-gcm:" + monPassword + "@ss.example.com:8388"))
	vmess := base64.StdEncoding.EncodeToString([]byte(`{"v":"2","ps":"vm","add":"vm.example.com","port":"8443","id":"` + monUUID + `","net":"ws","tls":"tls","sni":"cdn.example.com"}`))

	cases := []struct {
		name  string
		link  string
		want  MonitorEndpoint
		obfs  string
		fails bool
	}{
		{name: "vless reality", link: "vless://" + monUUID + "@DE.example.com:443?security=reality&sni=www.microsoft.com&pbk=" + monRealityPK + "&sid=ab&type=tcp&flow=xtls-rprx-vision#DE",
			want: MonitorEndpoint{Protocol: "vless", Host: "de.example.com", Port: 443, Security: "reality", Transport: "tcp", SNI: "www.microsoft.com", Probe: ProbeTLS}},
		{name: "vless plain", link: "vless://" + monUUID + "@1.2.3.4:8080?type=ws&path=%2Fws#x",
			want: MonitorEndpoint{Protocol: "vless", Host: "1.2.3.4", Port: 8080, Security: "none", Transport: "ws", Probe: ProbeTCP}},
		{name: "vless grpc tls alpn", link: "vless://" + monUUID + "@g.example.com:443?security=tls&type=grpc&serviceName=svc&alpn=h2,http%2F1.1&sni=g.example.com#g",
			want: MonitorEndpoint{Protocol: "vless", Host: "g.example.com", Port: 443, Security: "tls", Transport: "grpc", SNI: "g.example.com", ALPN: []string{"h2", "http/1.1"}, Probe: ProbeTLS}},
		{name: "vless splithttp alias", link: "vless://" + monUUID + "@x.example.com:443?security=tls&type=splithttp#x",
			want: MonitorEndpoint{Protocol: "vless", Host: "x.example.com", Port: 443, Security: "tls", Transport: "xhttp", Probe: ProbeTLS}},
		{name: "trojan defaults to tls", link: "trojan://" + monPassword + "@tr.example.com:443?peer=front.example.com#tr",
			want: MonitorEndpoint{Protocol: "trojan", Host: "tr.example.com", Port: 443, Security: "tls", Transport: "tcp", SNI: "front.example.com", Probe: ProbeTLS}},
		{name: "vmess tls", link: "vmess://" + vmess,
			want: MonitorEndpoint{Protocol: "vmess", Host: "vm.example.com", Port: 8443, Security: "tls", Transport: "ws", SNI: "cdn.example.com", Probe: ProbeTLS}},
		{name: "shadowsocks sip002", link: "ss://" + ssUser + "@ss.example.com:8388#ss",
			want: MonitorEndpoint{Protocol: "shadowsocks", Host: "ss.example.com", Port: 8388, Security: "none", Transport: "tcp", Probe: ProbeTCP}},
		{name: "shadowsocks legacy", link: "ss://" + ssLegacy + "#legacy",
			want: MonitorEndpoint{Protocol: "shadowsocks", Host: "ss.example.com", Port: 8388, Security: "none", Transport: "tcp", Probe: ProbeTCP}},
		{name: "shadowsocks plugin", link: "ss://" + ssUser + "@ss.example.com:8388?plugin=obfs-local%3Bobfs%3Dhttp#p",
			want: MonitorEndpoint{Protocol: "shadowsocks", Host: "ss.example.com", Port: 8388, Security: "none", Transport: "plugin", Probe: ProbeTCP}},
		{name: "hysteria2 obfs port hopping", link: "hysteria2://" + monPassword + "@hy.example.com:443,20000-30000/?sni=hy.example.com&obfs=salamander&obfs-password=" + monObfsKey + "#hy",
			want: MonitorEndpoint{Protocol: "hysteria2", Host: "hy.example.com", Port: 443, Security: "tls", Transport: "udp", SNI: "hy.example.com", Obfs: "salamander", Probe: ProbeQUIC},
			obfs: monObfsKey},
		{name: "hy2 alias default port", link: "hy2://" + monPassword + "@[2001:db8::1]?insecure=1#v6",
			want: MonitorEndpoint{Protocol: "hysteria2", Host: "2001:db8::1", Port: 443, Security: "tls", Transport: "udp", Probe: ProbeQUIC}},
		{name: "tuic unsupported", link: "tuic://" + monUUID + ":" + monPassword + "@tu.example.com:443?sni=tu.example.com#tu",
			want: MonitorEndpoint{Protocol: "tuic", Host: "tu.example.com", Port: 443, Transport: "udp", Probe: ProbeUnsupported}},
		{name: "vless without port", link: "vless://" + monUUID + "@noport.example.com?security=tls#x", fails: true},
		{name: "not a link", link: "# comment", fails: true},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			ep, ok := MonitorEndpointFromLink(tc.link)
			if tc.fails {
				assert.False(t, ok)
				return
			}
			require.True(t, ok)
			assert.Len(t, ep.Key, 64)
			assert.Equal(t, tc.obfs, ep.ObfsPassword())
			got := ep
			got.Key, got.obfsPassword = "", ""
			assert.Equal(t, tc.want, got)

			// Credentials never reach the serialized endpoint.
			encoded, err := json.Marshal(ep)
			require.NoError(t, err)
			for _, secret := range []string{monUUID, monPassword, monObfsKey, monRealityPK, ssUser} {
				assert.NotContains(t, string(encoded), secret)
			}
		})
	}
}

func TestMonitorEndpointKey_IgnoresCredentialsAndName(t *testing.T) {
	t.Parallel()

	a, ok := MonitorEndpointFromLink("vless://" + monUUID + "@h.example.com:443?security=reality&sni=s.example.com&type=tcp#A")
	require.True(t, ok)
	b, ok := MonitorEndpointFromLink("vless://99999999-2222-3333-4444-555555555555@H.example.com:443?security=reality&sni=s.example.com&type=tcp&pbk=other#B")
	require.True(t, ok)
	c, ok := MonitorEndpointFromLink("vless://" + monUUID + "@h.example.com:443?security=reality&sni=other.example.com&type=tcp#A")
	require.True(t, ok)

	assert.Equal(t, a.Key, b.Key, "same endpoint with other credentials/name is one check")
	// A Reality listener accepts many camouflage names and providers hand out
	// a random one per request: it is the same target (its history and its
	// outage continue), probed with the name of the latest answer.
	assert.Equal(t, a.Key, c.Key, "another Reality SNI is the same server")
	assert.Equal(t, "other.example.com", c.SNI)
	assert.Equal(t,
		EntryFingerprint("vless://"+monUUID+"@h.example.com:443?security=reality&sni=s.example.com&type=tcp#A"),
		EntryFingerprint("vless://"+monUUID+"@h.example.com:443?security=reality&sni=other.example.com&type=tcp#A"),
		"and the same catalogue entry")

	// Behind TLS the SNI selects the server (CDN fronting): another target.
	d, ok := MonitorEndpointFromLink("vless://" + monUUID + "@cdn.example.com:443?security=tls&sni=one.example.com&type=ws#A")
	require.True(t, ok)
	e, ok := MonitorEndpointFromLink("vless://" + monUUID + "@cdn.example.com:443?security=tls&sni=two.example.com&type=ws#A")
	require.True(t, ok)
	assert.NotEqual(t, d.Key, e.Key, "another TLS SNI is another handshake")
	assert.NotEqual(t,
		EntryFingerprint("vless://"+monUUID+"@cdn.example.com:443?security=tls&sni=one.example.com&type=ws#A"),
		EntryFingerprint("vless://"+monUUID+"@cdn.example.com:443?security=tls&sni=two.example.com&type=ws#A"))
}

// switchingUpstream serves a body that can change between resolutions.
type switchingUpstream struct {
	srv  *httptest.Server
	body atomic.Value
	hits atomic.Int32
	fail atomic.Bool
}

func newSwitchingUpstream(t *testing.T, lines ...string) *switchingUpstream {
	t.Helper()
	u := &switchingUpstream{}
	u.set(lines...)
	u.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		u.hits.Add(1)
		if u.fail.Load() {
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		_, _ = w.Write([]byte(u.body.Load().(string)))
	}))
	t.Cleanup(u.srv.Close)
	return u
}

func (u *switchingUpstream) set(lines ...string) { u.body.Store(strings.Join(lines, "\n")) }

func monitorTestDB() *testutil.DatabaseService {
	db := testutil.NewDatabaseService()
	db.GetSourceEntriesFunc = func(context.Context, uint, string) ([]database.ProviderSourceEntry, error) {
		return nil, nil
	}
	return db
}

func nodeNames(nodes []MonitorNode) []string {
	out := make([]string, 0, len(nodes))
	for _, n := range nodes {
		out = append(out, n.Name)
	}
	return out
}

func TestResolveMonitorBuilders_MatchesSubPipelineAndFetchesSharedSourceOnce(t *testing.T) {
	t.Parallel()

	shared := newSwitchingUpstream(t,
		testLink(monUUID, "de1.example.com", "🇩🇪 Germany 1"),
		testLink(monUUID, "de2.example.com", "🇩🇪 Germany 2"),
		testLink(monUUID, "nl1.example.com", "🇳🇱 Netherlands"),
	)
	other := newSwitchingUpstream(t, testLink(monUUID, "fi1.example.com", "🇫🇮 Finland"))
	s1 := testSource(1, shared.srv.URL)
	s2 := testSource(2, other.srv.URL)

	// Builder 10: both sources, no rules (merge all). Builder 20: only DE of
	// the shared source, with a custom node name for NL.
	b10 := testBuilder(10, []*database.ProviderSource{s1, s2})
	b20 := testBuilder(20, []*database.ProviderSource{s1},
		countryItem(1, "DE", 0),
		nodeItem(1, EntryFingerprint(testLink(monUUID, "nl1.example.com", "🇳🇱 Netherlands")), "", strPtr("NL custom"), 1),
	)

	db := monitorTestDB()
	got, err := ResolveMonitorBuilders(context.Background(), db, []database.SubscriptionBuilder{*b10, *b20})
	require.NoError(t, err)
	require.Len(t, got, 2)

	assert.EqualValues(t, 1, shared.hits.Load(), "a source used by two builders is fetched once")
	assert.EqualValues(t, 1, other.hits.Load())

	assert.Equal(t, []string{"🇩🇪 Germany 1", "🇩🇪 Germany 2", "🇳🇱 Netherlands", "🇫🇮 Finland"}, nodeNames(got[0].Nodes))
	assert.Equal(t, []string{"🇩🇪 Germany 1", "🇩🇪 Germany 2", "NL custom"}, nodeNames(got[1].Nodes))
	assert.Equal(t, []uint{1, 2}, got[0].ScopeSources)
	assert.Equal(t, []uint{1}, got[1].FetchedSources)
	assert.Equal(t, "DE", got[1].Nodes[0].Country)
	assert.Equal(t, "NL", got[1].Nodes[2].Country)
	assert.Equal(t, got[0].Nodes[0].Endpoint.Key, got[1].Nodes[0].Endpoint.Key, "same server in two builders is one endpoint")

	// The selection is exactly what /sub serves for the same builders.
	for i, b := range []*database.SubscriptionBuilder{b10, b20} {
		agg, _, _, err := fetchAndAggregateBuilder(context.Background(), db, "sub", b)
		require.NoError(t, err)
		served := make([]string, 0, len(agg.agg.items))
		for _, link := range agg.agg.items {
			served = append(served, EntryName(link))
		}
		assert.Equal(t, served, nodeNames(got[i].Nodes), "builder %d", b.ID)
	}
}

func TestResolveMonitorBuilders_DisabledAndFailedSourcesAndCatalogueChange(t *testing.T) {
	t.Parallel()

	up := newSwitchingUpstream(t,
		testLink(monUUID, "de1.example.com", "🇩🇪 Germany 1"),
		testLink(monUUID, "de2.example.com", "🇩🇪 Germany 2"),
	)
	down := newSwitchingUpstream(t, testLink(monUUID, "fi1.example.com", "🇫🇮 Finland"))
	down.fail.Store(true)
	off := newSwitchingUpstream(t, testLink(monUUID, "se1.example.com", "🇸🇪 Sweden"))

	s1, s2, s3 := testSource(1, up.srv.URL), testSource(2, down.srv.URL), testSource(3, off.srv.URL)
	s3.Enabled = false
	b := testBuilder(7, []*database.ProviderSource{s1, s2, s3})

	db := monitorTestDB()
	got, err := ResolveMonitorBuilders(context.Background(), db, []database.SubscriptionBuilder{*b})
	require.NoError(t, err)
	require.Len(t, got, 1)
	assert.Equal(t, []uint{1, 2}, got[0].ScopeSources, "a disabled source is out of scope")
	assert.Equal(t, []uint{1}, got[0].FetchedSources)
	assert.Equal(t, map[uint]string{2: "http_502"}, got[0].SourceErrors)
	assert.EqualValues(t, 0, off.hits.Load(), "a disabled source is not fetched")
	assert.Equal(t, []string{"🇩🇪 Germany 1", "🇩🇪 Germany 2"}, nodeNames(got[0].Nodes))

	// The upstream catalogue changes: DE2 disappears, AT appears.
	up.set(testLink(monUUID, "de1.example.com", "🇩🇪 Germany 1"), testLink(monUUID, "at1.example.com", "🇦🇹 Austria"))
	got, err = ResolveMonitorBuilders(context.Background(), db, []database.SubscriptionBuilder{*b})
	require.NoError(t, err)
	assert.Equal(t, []string{"🇩🇪 Germany 1", "🇦🇹 Austria"}, nodeNames(got[0].Nodes))

	// Nothing credential-bearing leaves the resolution.
	encoded, err := json.Marshal(got)
	require.NoError(t, err)
	assert.NotContains(t, string(encoded), monUUID)
	assert.NotContains(t, string(encoded), up.srv.URL)
}

func TestBuilderConfigSignature_ChangesWithConfiguration(t *testing.T) {
	t.Parallel()

	s := testSource(1, "https://up.example.com/sub")
	b := testBuilder(1, []*database.ProviderSource{s}, countryItem(1, "DE", 0))
	base := BuilderConfigSignature(b)
	assert.Equal(t, base, BuilderConfigSignature(b))

	b.Items[0].CountryCode = "NL"
	assert.NotEqual(t, base, BuilderConfigSignature(b), "rule change")
	b.Items[0].CountryCode = "DE"
	s.Enabled = false
	assert.NotEqual(t, base, BuilderConfigSignature(b), "source disabled")
}

// rotateXrayMember replaces an address inside the config called name: what a
// provider does when it picks another decoy member for the next request.
func rotateXrayMember(t *testing.T, body []byte, name, from, to string) []byte {
	t.Helper()
	var configs []json.RawMessage
	require.NoError(t, json.Unmarshal(body, &configs))
	rotated := false
	for i, raw := range configs {
		if info, ok := parseXrayFullConfig(raw); ok && info.name == name {
			require.Contains(t, string(raw), `"`+from+`"`)
			configs[i] = json.RawMessage(strings.ReplaceAll(string(raw), `"`+from+`"`, `"`+to+`"`))
			rotated = true
		}
	}
	require.True(t, rotated, name)
	out, err := json.Marshal(configs)
	require.NoError(t, err)
	return out
}

// Balancing configs of a real provider response (testdata, see
// catalogue_test.go): a white-list config holds a "decoy" — another server of
// the same subscription, a different one on every request — and a member of
// its own. It is checked through its own member only, so its target does not
// move with the decoy and never reports somebody else's server under its
// name. The "auto" config balances 13 servers of the subscription and has
// nothing of its own: it is not checked (its members are, as themselves).
func TestResolveMonitorBuilders_BalancerIsCheckedThroughItsOwnMember(t *testing.T) {
	t.Parallel()

	const (
		whiteList = "🇩🇪⚪Германия (БС-5)☁️"
		auto      = "🇪🇺 🚀Авто | Лучший сервер ⚡⚡"
	)
	fixture := loadXrayFixture(t)
	up := newSwitchingUpstream(t, string(fixture))
	b := testBuilder(3, []*database.ProviderSource{testSource(1, up.srv.URL)})
	db := monitorTestDB()

	resolve := func() (MonitorBuilder, map[string]MonitorNode) {
		got, err := ResolveMonitorBuilders(context.Background(), db, []database.SubscriptionBuilder{*b})
		require.NoError(t, err)
		require.Len(t, got, 1)
		byName := make(map[string]MonitorNode, len(got[0].Nodes))
		for _, n := range got[0].Nodes {
			byName[n.Name] = n
		}
		return got[0], byName
	}

	first, nodes := resolve()
	assert.Empty(t, first.SourceErrors)
	assert.Equal(t, 1, first.Unresolved, "only the auto balancer has no member of its own")
	assert.Len(t, first.Nodes, 39)
	assert.NotContains(t, nodes, auto)

	address := func(n MonitorNode) string { return endpointAddress(n.Endpoint) }
	// A single server is checked at its own address, as before.
	assert.Equal(t, "198.51.100.2:8443", address(nodes["🇫🇷⚡Франция"]))
	// White-list configs: the member of their own, never the decoy.
	assert.Equal(t, "198.51.100.27:443", address(nodes[whiteList]))
	assert.Equal(t, "198.51.100.26:9443", address(nodes["🇹🇷⚪Турция (БС-3)☁️"]))
	assert.Equal(t, "198.51.100.26:8443", address(nodes["🇹🇷⚪Турция (БС-4)☁️"]))
	assert.Equal(t, "host36.example:10443", address(nodes["🇨🇭⚪Швейцария (БС-1)☁️"]))

	// The next request carries another decoy: «Нидерланды» instead of the
	// server at 198.51.100.9 (both listen on 443).
	up.set(string(rotateXrayMember(t, fixture, whiteList, "198.51.100.9", "198.51.100.3")))
	second, rotated := resolve()
	assert.Equal(t, first.Unresolved, second.Unresolved)
	assert.Len(t, second.Nodes, 39)
	assert.Equal(t, "198.51.100.27:443", address(rotated[whiteList]))
	assert.Equal(t, nodes[whiteList].Endpoint.Key, rotated[whiteList].Endpoint.Key, "the same target: its history and outages continue")
	assert.Equal(t, nodes[whiteList].Fingerprint, rotated[whiteList].Fingerprint, "the same server for rules and bindings")
	assert.Equal(t, "198.51.100.3:443", address(rotated["🇳🇱⚡Нидерланды"]), "the decoy is checked as the server it is")
}
