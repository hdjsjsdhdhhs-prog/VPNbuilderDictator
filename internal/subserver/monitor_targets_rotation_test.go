package subserver

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/hdjsjsdhdhhs-prog/VPNbuilderDictator/internal/database"
)

// A real provider hands a "section" entry (a heading) a random member of its
// pool on every request, so even the member of its own changes between two
// reads of the source. The entry keeps its target — history, status and an
// open outage continue and nothing is reported as removed — while the address
// that is probed follows the latest answer.
func TestResolveMonitorBuilders_BalancerTargetSurvivesItsOwnMemberRotating(t *testing.T) {
	t.Parallel()

	const whiteList = "🇩🇪⚪Германия (БС-5)☁️"
	fixture := loadXrayFixture(t)
	up := newSwitchingUpstream(t, string(fixture))
	b := testBuilder(3, []*database.ProviderSource{testSource(1, up.srv.URL)})
	db := monitorTestDB()

	resolve := func() map[string]MonitorNode {
		got, err := ResolveMonitorBuilders(context.Background(), db, []database.SubscriptionBuilder{*b})
		require.NoError(t, err)
		require.Len(t, got, 1)
		byName := make(map[string]MonitorNode, len(got[0].Nodes))
		for _, n := range got[0].Nodes {
			byName[n.Name] = n
		}
		return byName
	}

	before := resolve()
	require.Contains(t, before, whiteList)
	assert.Equal(t, "198.51.100.27:443", endpointAddress(before[whiteList].Endpoint))

	// The provider points the entry at another member of its pool.
	up.set(string(rotateXrayMember(t, fixture, whiteList, "198.51.100.27", "198.51.100.77")))
	after := resolve()

	assert.Equal(t, "198.51.100.77:443", endpointAddress(after[whiteList].Endpoint), "the probe follows the latest answer")
	assert.Equal(t, before[whiteList].Endpoint.Key, after[whiteList].Endpoint.Key, "the same target: history and outages continue")
	assert.Equal(t, before[whiteList].Fingerprint, after[whiteList].Fingerprint)

	// Single servers are still identified by what they are, not by a name:
	// the key of one does not collide with the key of the entry above.
	france := before["🇫🇷⚡Франция"].Endpoint.Key
	assert.NotEqual(t, france, before[whiteList].Endpoint.Key)
	assert.Equal(t, france, after["🇫🇷⚡Франция"].Endpoint.Key)

	// Two entries of the response never share a target by accident.
	keys := make(map[string]string, len(after))
	for name, n := range after {
		if other, dup := keys[n.Endpoint.Key]; dup {
			t.Fatalf("%q and %q share the target key", name, other)
		}
		keys[n.Endpoint.Key] = name
	}
}
