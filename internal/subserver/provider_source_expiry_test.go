package subserver

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/hdjsjsdhdhhs-prog/VPNbuilderDictator/internal/database"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// A provider source past its admin-set validity end (provider_sources.expires_at)
// is out of the runtime exactly like a disabled one: /sub and the network
// monitor skip it without fetching, the response cache does not outlive the
// moment it runs out, and the admin catalogue sync still works.

func TestBuilder_ExpiredSourceIsSkippedLikeDisabled(t *testing.T) {
	t.Parallel()

	upLive := newBuilderTestUpstream(t, http.StatusOK, nil, testLink("live", "live.example", "Live"))
	upOld := newBuilderTestUpstream(t, http.StatusOK, nil, testLink("old", "old.example", "Old"))

	past, future := time.Now().Add(-time.Minute), time.Now().Add(time.Hour)
	live := testSource(41, upLive.srv.URL)
	live.ExpiresAt = &future
	old := testSource(42, upOld.srv.URL)
	old.ExpiresAt = &past
	require.True(t, old.Enabled, "expiry is independent of the admin switch")

	t.Run("expired source is skipped, a source with time left is served", func(t *testing.T) {
		sub := activeRuntimeSubscription("builder-expired-src", nil)
		db := builderTestDB(t, sub, func() *database.SubscriptionBuilder {
			return testBuilder(1, []*database.ProviderSource{old, live})
		})

		result, success, total, err := HandleSubscription(context.Background(), db, newTestSubSvc(t), sub.SubscriptionID, "", nil)
		require.NoError(t, err)
		assert.Equal(t, 1, success)
		assert.Equal(t, 1, total)
		assert.Equal(t, []string{"Live"}, linkNames(decodeBuilderLinks(t, result)))
		assert.Zero(t, upOld.hits.Load(), "an expired source is not fetched")
	})

	t.Run("only expired sources is unavailable without fallback", func(t *testing.T) {
		sub := activeRuntimeSubscription("builder-all-expired", nil)
		db := builderTestDB(t, sub, func() *database.SubscriptionBuilder {
			return testBuilder(1, []*database.ProviderSource{old})
		})

		result, _, _, err := HandleSubscription(context.Background(), db, newTestSubSvc(t), sub.SubscriptionID, "", nil)
		assert.Nil(t, result)
		assert.ErrorIs(t, err, ErrProviderSourceUnavailable)
		assert.Zero(t, upOld.hits.Load())
	})
}

func TestBuilderCacheKey_ChangesWhenASourceExpires(t *testing.T) {
	t.Parallel()

	build := func(expiresAt *time.Time) *database.SubscriptionBuilder {
		src := testSource(1, "https://provider.example/sub")
		src.ExpiresAt = expiresAt
		return testBuilder(5, []*database.ProviderSource{src}, countryItem(1, "DE", 0))
	}
	past, future := time.Now().Add(-time.Minute), time.Now().Add(time.Hour)

	unlimited := builderCacheKey("sub", build(nil))
	// A deadline that is still ahead serves the same content as no deadline.
	assert.Equal(t, unlimited, builderCacheKey("sub", build(&future)))
	// Once it passes, the cached response of the source must not be reused:
	// nothing in the database changes at that moment.
	assert.NotEqual(t, unlimited, builderCacheKey("sub", build(&past)))
	assert.NotEqual(t, BuilderConfigSignature(build(nil)), BuilderConfigSignature(build(&past)), "the monitor re-resolves too")
}

func TestResolveMonitorBuilders_ExpiredSourceIsOutOfScope(t *testing.T) {
	t.Parallel()

	up := newSwitchingUpstream(t, testLink(monUUID, "de1.example.com", "🇩🇪 Germany 1"))
	old := newSwitchingUpstream(t, testLink(monUUID, "se1.example.com", "🇸🇪 Sweden"))

	live, expired := testSource(1, up.srv.URL), testSource(2, old.srv.URL)
	past := time.Now().Add(-time.Minute)
	expired.ExpiresAt = &past
	b := testBuilder(7, []*database.ProviderSource{live, expired})

	got, err := ResolveMonitorBuilders(context.Background(), monitorTestDB(), []database.SubscriptionBuilder{*b})
	require.NoError(t, err)
	require.Len(t, got, 1)
	assert.Equal(t, []uint{1}, got[0].ScopeSources, "an expired source is out of scope")
	assert.Equal(t, []uint{1}, got[0].FetchedSources)
	assert.Empty(t, got[0].SourceErrors)
	assert.EqualValues(t, 0, old.hits.Load(), "an expired source is not fetched")
	assert.Equal(t, []string{"🇩🇪 Germany 1"}, nodeNames(got[0].Nodes))
}

func TestFetchSourceCatalogue_SyncsAnExpiredSource(t *testing.T) {
	t.Parallel()

	up := newBuilderTestUpstream(t, http.StatusOK, nil, testLink("u", "de.example", "🇩🇪 Frankfurt"))
	src := testSource(51, up.srv.URL)
	past := time.Now().Add(-time.Hour)
	src.ExpiresAt = &past

	// The runtime refuses it...
	_, err := FetchFromProviderSource(context.Background(), *src)
	require.ErrorIs(t, err, ErrProviderSourceUnavailable)
	assert.Zero(t, up.hits.Load())

	// ...the admin sync does not: the admin inspects the provider before
	// extending the term, the same way a disabled source can be synced.
	catalogue, err := FetchSourceCatalogue(context.Background(), *src)
	require.NoError(t, err)
	require.Len(t, catalogue.Entries, 1)
	assert.Equal(t, int32(1), up.hits.Load())
	require.NotNil(t, src.ExpiresAt, "the caller's source is not modified")
}
