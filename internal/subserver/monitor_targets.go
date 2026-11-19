package subserver

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"

	"github.com/hdjsjsdhdhhs-prog/VPNbuilderDictator/internal/database"
	"github.com/hdjsjsdhdhhs-prog/VPNbuilderDictator/internal/interfaces"
)

// Network monitor resolution. The monitor must check exactly the servers a
// builder serves on /sub, so it runs the same pipeline as
// fetchAndAggregateBuilder — builderSourcesToFetch → fetch →
// parseFetchedBuilderSources → selectBuilderEntries — and only then reduces
// every pick to a credential-free endpoint. Share links, UUIDs, passwords and
// Reality keys never leave this file: MonitorEndpoint carries only protocol,
// host, port and transport parameters (plus the Hysteria2 obfuscation key,
// held in an unexported field for the probe and never serialized).

// monitorSubID labels monitor resolution in the shared pipeline's logs.
const monitorSubID = "netmon"

// Probe kinds: how an endpoint is checked (see doc/network-monitoring.md).
const (
	ProbeTCP         = "tcp"         // TCP connect
	ProbeTLS         = "tls"         // TCP connect + TLS handshake (tls / reality)
	ProbeQUIC        = "quic"        // QUIC handshake (hysteria2)
	ProbeUnsupported = "unsupported" // protocol without a handshake-level check
)

// MonitorEndpoint is the credential-free network identity of one server.
type MonitorEndpoint struct {
	// Key is a stable sha256 of protocol, host, port and transport; servers
	// that differ only in credentials or name share one key (one check).
	Key       string   `json:"key"`
	Protocol  string   `json:"protocol"`
	Host      string   `json:"host"`
	Port      int      `json:"port"`
	Security  string   `json:"security"`  // none | tls | reality (TCP protocols)
	Transport string   `json:"transport"` // tcp | ws | grpc | xhttp | httpupgrade | udp | plugin …
	SNI       string   `json:"sni"`
	ALPN      []string `json:"alpn,omitempty"`
	Obfs      string   `json:"obfs,omitempty"` // hysteria2 obfuscation type ("salamander")
	Probe     string   `json:"probe"`

	// obfsPassword is the Hysteria2 salamander key. It is needed to talk to
	// an obfuscated server at all, lives only in memory and is never
	// marshalled (unexported), stored or logged.
	obfsPassword string
}

// ObfsPassword returns the in-memory Hysteria2 obfuscation key (probe only).
func (e MonitorEndpoint) ObfsPassword() string { return e.obfsPassword }

// MonitorNode is one server selected by a builder.
type MonitorNode struct {
	SourceID    uint
	Fingerprint string
	Name        string
	Country     string
	Endpoint    MonitorEndpoint
}

// MonitorBuilder is the resolved monitoring view of one builder.
type MonitorBuilder struct {
	BuilderID   uint
	BuilderName string
	// ScopeSources are the enabled, valid sources the builder currently
	// fetches (builderSourcesToFetch); a source outside it is disabled or
	// no longer used and its nodes are no longer served.
	ScopeSources []uint
	// FetchedSources are the scope sources fetched and parsed in this run.
	// Nodes of a scope source that failed to fetch are unknown, not gone.
	FetchedSources []uint
	// SourceErrors maps a failed scope source to its credential-free code.
	SourceErrors map[uint]string
	Nodes        []MonitorNode
	// Unresolved counts picks that could not be reduced to an endpoint.
	Unresolved int
}

// sourceFetch is the shared per-run result of one source.
type sourceFetch struct {
	resp    *NodeResponse
	failure string
}

// ResolveMonitorBuilders resolves the current servers of every given builder.
// Each distinct source is fetched once per call, however many builders use
// it. Only a database error fails the call; per-source failures are reported
// in MonitorBuilder.SourceErrors.
func ResolveMonitorBuilders(ctx context.Context, db interfaces.SubscriptionRepository, builders []database.SubscriptionBuilder) ([]MonitorBuilder, error) {
	type scope struct {
		sources []database.ProviderSource
	}
	scopes := make([]scope, len(builders))
	unique := make(map[uint]database.ProviderSource)
	var order []uint
	for i := range builders {
		sources, _ := builderSourcesToFetch(monitorSubID, &builders[i])
		scopes[i].sources = sources
		for _, s := range sources {
			if _, ok := unique[s.ID]; !ok {
				unique[s.ID] = s
				order = append(order, s.ID)
			}
		}
	}

	fetched := make(map[uint]sourceFetch, len(order))
	var mu sync.Mutex
	var wg sync.WaitGroup
	sem := make(chan struct{}, maxSourceConcurrency)
	for _, id := range order {
		if ctx.Err() != nil {
			break
		}
		wg.Add(1)
		sem <- struct{}{}
		go func(source database.ProviderSource) {
			defer wg.Done()
			defer func() { <-sem }()
			resp, failure := fetchProviderSource(ctx, source)
			mu.Lock()
			fetched[source.ID] = sourceFetch{resp: resp, failure: failure}
			mu.Unlock()
		}(unique[id])
	}
	wg.Wait()
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	// Parse each fetched source once; builders share the parsed entries.
	parsedByID := make(map[uint]builderSource, len(order))
	serversByID := make(map[uint]map[string]bool, len(order))
	for _, id := range order {
		f := fetched[id]
		if f.resp == nil {
			continue
		}
		parsed, err := parseFetchedBuilderSources(ctx, db, monitorSubID, 0, []database.ProviderSource{unique[id]}, []*NodeResponse{f.resp})
		if err != nil {
			return nil, err
		}
		if len(parsed) == 1 {
			parsedByID[id] = parsed[0]
			serversByID[id] = singleServerAddresses(parsed[0].entries)
		}
	}

	out := make([]MonitorBuilder, 0, len(builders))
	for i := range builders {
		b := &builders[i]
		mb := MonitorBuilder{BuilderID: b.ID, BuilderName: b.Name, SourceErrors: map[uint]string{}}
		parsed := make([]builderSource, 0, len(scopes[i].sources))
		for _, s := range scopes[i].sources {
			mb.ScopeSources = append(mb.ScopeSources, s.ID)
			p, ok := parsedByID[s.ID]
			if !ok {
				code := fetched[s.ID].failure
				if code == "" {
					code = "unreachable"
				}
				mb.SourceErrors[s.ID] = code
				continue
			}
			mb.FetchedSources = append(mb.FetchedSources, s.ID)
			parsed = append(parsed, p)
		}
		if len(parsed) > 0 {
			for _, pick := range selectBuilderEntries(monitorSubID, b, parsed) {
				ep, ok := monitorEndpointOf(pick.entry, serversByID[pick.entry.sourceID])
				if !ok {
					mb.Unresolved++
					continue
				}
				mb.Nodes = append(mb.Nodes, MonitorNode{
					SourceID:    pick.entry.sourceID,
					Fingerprint: pick.entry.fingerprint,
					Name:        truncateRunes(pick.name, 255),
					Country:     pick.entry.country,
					Endpoint:    ep,
				})
			}
		}
		out = append(out, mb)
	}

	return out, nil
}

// BuilderConfigSignature changes whenever the builder, its linked sources
// (enabled, updated, last catalogue sync) or its rules change. It is the same
// digest the /sub response cache keys on, so the monitor re-resolves exactly
// when a subscription would be rebuilt.
func BuilderConfigSignature(b *database.SubscriptionBuilder) string {
	return builderCacheKey(monitorSubID, b)
}

// monitorEndpointOf reduces a selected entry to its endpoint. A full Xray
// config with one server is checked through that outbound (the one served as
// a share link); a config without one cannot be resolved.
//
// A config with several servers inside is a balancer: the client application
// picks a working member, so no single member says whether the config works,
// and providers rotate the members between requests (a "decoy" taken from the
// other servers of the subscription). Checking the first member would report
// somebody else's server under this name — and a different one after every
// re-read of the source. Such a config is checked only through a member of
// its own: one that is not a server of the same subscription by itself
// (servers lists those). That member does not rotate and is what the config
// exists for. Without exactly one such member the config is not checked; its
// members that are servers of the subscription are checked under their own
// names anyway.
func monitorEndpointOf(e builderEntry, servers map[string]bool) (MonitorEndpoint, bool) {
	if e.xray {
		members := xrayOutboundEndpoints(e.raw)
		if len(members) > 1 {
			var own []MonitorEndpoint
			for _, ep := range members {
				if !servers[endpointAddress(ep)] {
					own = append(own, ep)
				}
			}
			if len(own) == 1 {
				// Even this member is not always the same: a provider may hand
				// a "section" entry (a heading such as «⬇️ Обходы белых списков
				// ⬇️») a random member of its pool on every request. The
				// identity of such a config is the config itself, exactly as
				// for its fingerprint: the target key comes from the source
				// and the entry, and the address to check is whatever the
				// latest answer holds. A rotation moves the probe, not the
				// target, so history and open outages continue and nothing is
				// reported as removed.
				ep := own[0]
				ep.Key = balancerKey(e.sourceID, e.fingerprint)
				return ep, true
			}
			return MonitorEndpoint{}, false
		}
	}
	if e.link == "" {
		return MonitorEndpoint{}, false
	}
	return MonitorEndpointFromLink(e.link)
}

// balancerKey is the target key of a config with several servers inside: it
// identifies the entry of a source, not any address that entry points to.
func balancerKey(sourceID uint, fingerprint string) string {
	sum := sha256.Sum256([]byte("v1|netmon-group|" + strconv.FormatUint(uint64(sourceID), 10) + "|" + fingerprint))
	return hex.EncodeToString(sum[:])
}

func endpointAddress(ep MonitorEndpoint) string {
	return net.JoinHostPort(ep.Host, strconv.Itoa(ep.Port))
}

// xrayOutboundEndpoints returns the endpoints of every proxy outbound of a
// full Xray config, one per distinct address.
func xrayOutboundEndpoints(raw json.RawMessage) []MonitorEndpoint {
	var out []MonitorEndpoint
	seen := make(map[string]bool)
	for _, link := range xrayOutboundLinks(raw) {
		ep, ok := MonitorEndpointFromLink(link)
		if !ok {
			continue
		}
		addr := endpointAddress(ep)
		if seen[addr] {
			continue
		}
		seen[addr] = true
		out = append(out, ep)
	}
	return out
}

// singleServerAddresses collects the address of every entry of a source that
// is one server by itself: a share link or a full Xray config with a single
// server inside.
func singleServerAddresses(entries []builderEntry) map[string]bool {
	out := make(map[string]bool, len(entries))
	for _, e := range entries {
		if e.xray {
			if members := xrayOutboundEndpoints(e.raw); len(members) == 1 {
				out[endpointAddress(members[0])] = true
			}
			continue
		}
		if ep, ok := MonitorEndpointFromLink(e.link); ok {
			out[endpointAddress(ep)] = true
		}
	}
	return out
}

// MonitorEndpointFromLink parses a share link into its endpoint. The link
// itself (with its credentials) is not retained.
func MonitorEndpointFromLink(link string) (MonitorEndpoint, bool) {
	link = strings.TrimSpace(link)
	protocol := linkProtocol(link)
	var ep MonitorEndpoint
	var ok bool
	switch protocol {
	case "vless", "trojan":
		ep, ok = urlEndpoint(protocol, link)
	case "vmess":
		ep, ok = vmessEndpoint(link)
	case "shadowsocks":
		ep, ok = shadowsocksEndpoint(link)
	case "hysteria2":
		ep, ok = hysteria2Endpoint(link)
	case "":
		return MonitorEndpoint{}, false
	default:
		// hysteria (v1), tuic …: parse the address for display, no probe.
		ep, ok = genericEndpoint(protocol, link)
		ep.Probe = ProbeUnsupported
	}
	if !ok {
		return MonitorEndpoint{}, false
	}
	ep.Protocol = protocol
	ep.Host = strings.ToLower(strings.Trim(ep.Host, "[]"))
	if ep.Host == "" || ep.Port <= 0 || ep.Port > 65535 {
		return MonitorEndpoint{}, false
	}
	if ep.Transport == "" {
		ep.Transport = "tcp"
	}
	ep.Key = endpointKey(ep)
	return ep, true
}

func endpointKey(ep MonitorEndpoint) string {
	alpn := append([]string(nil), ep.ALPN...)
	sort.Strings(alpn)
	// A Reality listener accepts many camouflage names and providers rotate
	// them between requests: the name is used for the handshake but does not
	// make another target (identitySNI).
	identity := strings.Join([]string{
		"v1", "netmon", ep.Protocol, ep.Host, strconv.Itoa(ep.Port), ep.Security, ep.Transport,
		strings.ToLower(identitySNI(ep.Security, ep.SNI)), strings.Join(alpn, ","), ep.Obfs, ep.Probe,
	}, "|")
	sum := sha256.Sum256([]byte(identity))
	return hex.EncodeToString(sum[:])
}

// urlEndpoint handles vless:// and trojan://.
func urlEndpoint(protocol, link string) (MonitorEndpoint, bool) {
	u, err := url.Parse(link)
	if err != nil {
		return MonitorEndpoint{}, false
	}
	port, err := strconv.Atoi(u.Port())
	if err != nil {
		return MonitorEndpoint{}, false
	}
	q := u.Query()
	security := strings.ToLower(q.Get("security"))
	if security == "" {
		if protocol == "trojan" {
			security = "tls" // Trojan is TLS by definition
		} else {
			security = "none"
		}
	}
	transport := strings.ToLower(q.Get("type"))
	if transport == "splithttp" {
		transport = "xhttp"
	}
	ep := MonitorEndpoint{
		Host: u.Hostname(), Port: port, Security: security, Transport: transport,
		SNI: firstNonEmpty(q.Get("sni"), q.Get("peer")), ALPN: splitALPN(q.Get("alpn")),
	}
	ep.Probe = tcpProbeFor(security)
	return ep, true
}

func vmessEndpoint(link string) (MonitorEndpoint, bool) {
	obj, ok := decodeVMess(link[len("vmess://"):])
	if !ok {
		return MonitorEndpoint{}, false
	}
	port, err := strconv.Atoi(strings.TrimSpace(jsonString(obj["port"])))
	if err != nil {
		return MonitorEndpoint{}, false
	}
	security := strings.ToLower(jsonString(obj["tls"]))
	if security == "" {
		security = "none"
	}
	ep := MonitorEndpoint{
		Host: jsonString(obj["add"]), Port: port, Security: security,
		Transport: strings.ToLower(jsonString(obj["net"])), SNI: jsonString(obj["sni"]),
		ALPN: splitALPN(jsonString(obj["alpn"])),
	}
	ep.Probe = tcpProbeFor(security)
	return ep, true
}

func shadowsocksEndpoint(link string) (MonitorEndpoint, bool) {
	host, portText := "", ""
	if u, err := url.Parse(link); err == nil {
		host, portText = u.Hostname(), u.Port()
	}
	if host == "" || portText == "" {
		_, rest, _ := strings.Cut(link, "://")
		host, portText = legacySSHostPort(rest)
	}
	port, err := strconv.Atoi(portText)
	if err != nil {
		return MonitorEndpoint{}, false
	}
	transport := "tcp"
	if u, err := url.Parse(link); err == nil && u.Query().Get("plugin") != "" {
		transport = "plugin"
	}
	return MonitorEndpoint{Host: host, Port: port, Security: "none", Transport: transport, Probe: ProbeTCP}, true
}

// hysteria2Endpoint parses hysteria2:// and hy2:// by hand: port hopping
// ("443,20000-30000") is not a valid URL port for net/url. The first port is
// checked; hopping ranges are a known limitation.
func hysteria2Endpoint(link string) (MonitorEndpoint, bool) {
	_, rest, _ := strings.Cut(link, "://")
	rest, _, _ = strings.Cut(rest, "#")
	hostPort, rawQuery, _ := strings.Cut(rest, "?")
	if at := strings.LastIndexByte(hostPort, '@'); at >= 0 {
		hostPort = hostPort[at+1:]
	}
	hostPort = strings.TrimSuffix(hostPort, "/")
	host, portSpec := splitHostPortSpec(hostPort)
	port := firstPort(portSpec)
	q, _ := url.ParseQuery(rawQuery)
	if port == 0 {
		port = firstPort(q.Get("mport"))
	}
	if port == 0 {
		port = 443
	}
	ep := MonitorEndpoint{
		Host: host, Port: port, Security: "tls", Transport: "udp",
		SNI: q.Get("sni"), ALPN: splitALPN(q.Get("alpn")), Probe: ProbeQUIC,
	}
	if obfs := strings.ToLower(q.Get("obfs")); obfs != "" && obfs != "none" {
		ep.Obfs = obfs
		ep.obfsPassword = q.Get("obfs-password")
	}
	return ep, host != ""
}

func genericEndpoint(protocol, link string) (MonitorEndpoint, bool) {
	_, rest, _ := strings.Cut(link, "://")
	rest, _, _ = strings.Cut(rest, "#")
	hostPort, _, _ := strings.Cut(rest, "?")
	if at := strings.LastIndexByte(hostPort, '@'); at >= 0 {
		hostPort = hostPort[at+1:]
	}
	host, portSpec := splitHostPortSpec(strings.TrimSuffix(hostPort, "/"))
	transport := "tcp"
	if protocol == "tuic" || protocol == "hysteria" {
		transport = "udp"
	}
	return MonitorEndpoint{Host: host, Port: firstPort(portSpec), Transport: transport}, host != ""
}

func splitHostPortSpec(hostPort string) (string, string) {
	if strings.HasPrefix(hostPort, "[") {
		end := strings.IndexByte(hostPort, ']')
		if end < 0 {
			return "", ""
		}
		host := hostPort[1:end]
		return host, strings.TrimPrefix(hostPort[end+1:], ":")
	}
	if h, p, err := net.SplitHostPort(hostPort); err == nil {
		return h, p
	}
	host, port, _ := strings.Cut(hostPort, ":")
	return host, port
}

// firstPort returns the first port of "443", "443,8443" or "20000-30000".
func firstPort(spec string) int {
	spec = strings.TrimSpace(spec)
	end := 0
	for end < len(spec) && spec[end] >= '0' && spec[end] <= '9' {
		end++
	}
	port, err := strconv.Atoi(spec[:end])
	if err != nil || port <= 0 || port > 65535 {
		return 0
	}
	return port
}

func splitALPN(raw string) []string {
	var out []string
	for _, p := range strings.Split(raw, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

func tcpProbeFor(security string) string {
	switch security {
	case "tls", "reality", "xtls":
		return ProbeTLS
	default:
		return ProbeTCP
	}
}
