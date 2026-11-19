package netmon

import (
	"context"
	"testing"
	"time"

	"github.com/hdjsjsdhdhhs-prog/VPNbuilderDictator/internal/database"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// CheckNow is the manual "check right now": one resolution and one round, the
// after-round callback (notifications) runs, and it never overlaps a pass that
// is already running.
func TestCheckNow_RunsOnePassAndNotifies(t *testing.T) {
	f := newMonFixture(t)
	ctx := context.Background()
	rounds := 0
	f.svc.SetAfterRound(func() { rounds++ })

	require.NoError(t, f.svc.CheckNow(ctx))
	assert.Equal(t, 1, rounds)
	f.resolver.mu.Lock()
	resolutions := f.resolver.calls
	f.resolver.mu.Unlock()
	assert.Equal(t, 1, resolutions)
	f.svc.mu.Lock()
	lastRound := f.svc.lastRoundAt
	f.svc.mu.Unlock()
	require.NotNil(t, lastRound)

	// While a pass holds the cycle, a second check is refused and nothing runs.
	f.svc.cycleMu.Lock()
	err := f.svc.CheckNow(ctx)
	f.svc.cycleMu.Unlock()
	require.ErrorIs(t, err, ErrCheckInProgress)
	assert.Equal(t, 1, rounds)

	// The background round notifies as well.
	f.svc.roundBestEffort(ctx)
	assert.Equal(t, 2, rounds)
}

// One press of «Проверить сейчас» ends with a verdict: a server that does not
// answer is probed again right away (the background loop would wait for its
// next round), the servers that answered are not probed twice, and the
// notifications are woken once, after the verdict.
func TestCheckNow_ConfirmsAFailedServerRightAway(t *testing.T) {
	f := newMonFixture(t)
	f.standardTopology(t)
	f.svc.confirmPause = 0
	ctx := context.Background()

	require.NoError(t, f.svc.CheckNow(ctx))
	assert.Equal(t, 4, f.prober.totalCalls(), "everything answers: one probe per server")

	f.advance(time.Minute)
	f.prober.set("fi.example.com", false, 0)
	notified := 0
	f.svc.SetAfterRound(func() { notified++ })
	require.NoError(t, f.svc.CheckNow(ctx))
	assert.Equal(t, 4+4+1, f.prober.totalCalls(), "only the server that failed is probed again")
	assert.Equal(t, 1, notified)

	detail, err := f.svc.BuilderDetail(ctx, 2)
	require.NoError(t, err)
	fi := countryOf(t, detail, "FI")
	assert.Equal(t, database.MonitorStatusDown, fi.Status)
	require.Len(t, fi.Nodes, 1)
	assert.Equal(t, database.MonitorStatusDown, fi.Nodes[0].Status)
	assert.Equal(t, database.MonitorStatusUp, countryOf(t, detail, "DE").Status)

	// The next press finds it down already: nothing is probed twice.
	f.advance(time.Minute)
	require.NoError(t, f.svc.CheckNow(ctx))
	assert.Equal(t, 4+4+1+4, f.prober.totalCalls())
}

// A blip — one probe that fails and the next one that answers — is not an
// outage for a manual check either.
func TestCheckNow_ABlipIsNotAnOutage(t *testing.T) {
	f := newMonFixture(t)
	f.standardTopology(t)
	f.svc.confirmPause = 0
	ctx := context.Background()
	require.NoError(t, f.svc.CheckNow(ctx))

	f.advance(time.Minute)
	f.prober.blip("fi.example.com", 1)
	require.NoError(t, f.svc.CheckNow(ctx))
	assert.Equal(t, 4+4+1, f.prober.totalCalls(), "the failed probe is repeated once")

	detail, err := f.svc.BuilderDetail(ctx, 2)
	require.NoError(t, err)
	fi := countryOf(t, detail, "FI")
	assert.Equal(t, database.MonitorStatusUp, fi.Status)
	history, err := f.svc.History(ctx, HistoryQuery{BuilderID: 2, Period: "24h"})
	require.NoError(t, err)
	assert.Empty(t, history.Outages)
}
