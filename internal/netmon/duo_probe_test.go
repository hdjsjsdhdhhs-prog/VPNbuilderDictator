//go:build duoprobe

package netmon_test

// TEMPORARY scratch test of the agent session; delete before committing.
// Resolves a real provider subscription with the production pipeline and
// probes every endpoint several times, printing what each attempt answers.

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/hdjsjsdhdhhs-prog/VPNbuilderDictator/internal/database"
	"github.com/hdjsjsdhdhhs-prog/VPNbuilderDictator/internal/netmon"
	"github.com/hdjsjsdhdhhs-prog/VPNbuilderDictator/internal/service"
	"github.com/hdjsjsdhdhhs-prog/VPNbuilderDictator/internal/subserver"
	"github.com/stretchr/testify/require"
)

func TestDuoProbeRealSource(t *testing.T) {
	link := os.Getenv("DUO_REAL_URL")
	if link == "" {
		t.Skip("DUO_REAL_URL is required")
	}
	ctx := context.Background()
	db, err := database.NewService(filepath.Join(t.TempDir(), "probe.db"))
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
	view, sync, err := builders.CreateSource(ctx, service.CreateSourceInput{Name: "real", Type: "auto", SubscriptionURL: link, Headers: "{}", Enabled: true})
	require.NoError(t, err)
	require.NotNil(t, sync)
	t.Logf("sync: %s", sync.Status)
	created, err := db.CreateBuilder(ctx, database.AdminConfigMeta{Actor: "seed", RequestKey: "seed-wide"}, database.BuilderCreateInput{Name: "wide", Enabled: true})
	require.NoError(t, err)
	cur, err := db.GetBuilder(ctx, created.TargetID)
	require.NoError(t, err)
	_, err = db.SaveBuilderConfiguration(ctx, database.AdminConfigMeta{Actor: "seed", RequestKey: "seed-wide-cfg"}, database.BuilderConfigurationInput{
		ID: created.TargetID, Version: cur.Version, Name: cur.Name, Enabled: true, SourceIDs: []uint{view.ID},
	})
	require.NoError(t, err)
	list, err := db.ListMonitorBuilders(ctx)
	require.NoError(t, err)
	resolved, err := subserver.ResolveMonitorBuilders(ctx, db, list)
	require.NoError(t, err)
	require.Len(t, resolved, 1)
	nodes := resolved[0].Nodes
	t.Logf("nodes: %d, unresolved: %d, source errors: %v", len(nodes), resolved[0].Unresolved, resolved[0].SourceErrors)
	sort.SliceStable(nodes, func(i, j int) bool { return nodes[i].Country < nodes[j].Country })

	rounds := 4
	prober := netmon.NetProber{Timeout: 5 * time.Second}
	results := make([][]string, len(nodes))
	for round := 0; round < rounds; round++ {
		// Like a monitor round: 8 probes in flight.
		sem := make(chan struct{}, 8)
		done := make(chan struct{}, len(nodes))
		out := make([]string, len(nodes))
		for i := range nodes {
			sem <- struct{}{}
			go func(i int) {
				defer func() { <-sem; done <- struct{}{} }()
				r := prober.Probe(ctx, nodes[i].Endpoint)
				if r.OK {
					out[i] = fmt.Sprintf("ok/%dms", r.LatencyMS)
				} else {
					out[i] = r.ErrorCode
				}
			}(i)
		}
		for range nodes {
			<-done
		}
		for i := range nodes {
			results[i] = append(results[i], out[i])
		}
		time.Sleep(2 * time.Second)
	}
	for i, n := range nodes {
		ep := n.Endpoint
		t.Logf("%-3s %-34s %s %s:%d %s/%s sni=%s probe=%s :: %s", n.Country, n.Name, ep.Protocol, ep.Host, ep.Port, ep.Transport, ep.Security, ep.SNI, ep.Probe, strings.Join(results[i], " "))
	}
}
