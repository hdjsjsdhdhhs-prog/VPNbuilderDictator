package database

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Operational notifications storage (migration 053).

func TestOpsSettings_DefaultsAndUpdate(t *testing.T) {
	t.Parallel()
	svc := newTestService(t)
	ctx := context.Background()

	settings, err := svc.GetOpsSettings(ctx)
	require.NoError(t, err)
	assert.True(t, settings.Enabled)
	assert.Zero(t, settings.ChatID, "0 = TELEGRAM_ADMIN_ID")
	assert.Empty(t, settings.BotToken)
	assert.True(t, settings.NotifyServers)
	assert.True(t, settings.NotifyCountries)
	assert.True(t, settings.NotifySources)
	assert.True(t, settings.DailyReport)
	assert.Equal(t, 9, settings.DailyReportHour)
	assert.Empty(t, settings.LastReportDay)
	assert.WithinDuration(t, time.Now(), settings.BaselineAt, time.Minute)
	assert.Equal(t, 1, settings.Version)

	token := "1234567890:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw_test"
	in := OpsSettingsInput{Version: 1, Enabled: true, ChatID: -1001234567890, BotToken: &token, NotifyServers: false, NotifyCountries: true, NotifySources: true, DailyReport: true, DailyReportHour: 21}
	res, err := svc.UpdateOpsSettings(ctx, AdminConfigMeta{Actor: "admin", RequestKey: "ops-1"}, in)
	require.NoError(t, err)
	assert.NotContains(t, res.Audit.OldValue+res.Audit.NewValue, token, "the bot token never reaches the audit log")
	assert.Contains(t, res.Audit.NewValue, `"own_bot":true`)

	saved, err := svc.GetOpsSettings(ctx)
	require.NoError(t, err)
	assert.Equal(t, int64(-1001234567890), saved.ChatID)
	assert.Equal(t, token, saved.BotToken)
	assert.False(t, saved.NotifyServers)
	assert.Equal(t, 21, saved.DailyReportHour)
	assert.Equal(t, 2, saved.Version)

	// Replay: same key and payload.
	replay, err := svc.UpdateOpsSettings(ctx, AdminConfigMeta{Actor: "admin", RequestKey: "ops-1"}, in)
	require.NoError(t, err)
	assert.True(t, replay.Replayed)

	// A stale version is refused; a nil token keeps the stored one.
	stale := OpsSettingsInput{Version: 1, Enabled: true, DailyReportHour: 9}
	_, err = svc.UpdateOpsSettings(ctx, AdminConfigMeta{Actor: "admin", RequestKey: "ops-2"}, stale)
	require.ErrorIs(t, err, ErrOpsVersionConflict)
	keep := OpsSettingsInput{Version: 2, Enabled: false, DailyReportHour: 9}
	_, err = svc.UpdateOpsSettings(ctx, AdminConfigMeta{Actor: "admin", RequestKey: "ops-3"}, keep)
	require.NoError(t, err)
	saved, err = svc.GetOpsSettings(ctx)
	require.NoError(t, err)
	assert.Equal(t, token, saved.BotToken)
	assert.False(t, saved.Enabled)

	// An empty token switches back to the main bot.
	empty := ""
	_, err = svc.UpdateOpsSettings(ctx, AdminConfigMeta{Actor: "admin", RequestKey: "ops-4"}, OpsSettingsInput{Version: 3, BotToken: &empty, DailyReportHour: 9})
	require.NoError(t, err)
	saved, err = svc.GetOpsSettings(ctx)
	require.NoError(t, err)
	assert.Empty(t, saved.BotToken)

	bad := "not-a-token"
	for name, invalid := range map[string]OpsSettingsInput{
		"bad token":    {Version: 4, BotToken: &bad, DailyReportHour: 9},
		"bad hour":     {Version: 4, DailyReportHour: 24},
		"zero version": {Version: 0, DailyReportHour: 9},
	} {
		_, err = svc.UpdateOpsSettings(ctx, AdminConfigMeta{Actor: "admin", RequestKey: "ops-bad-" + name}, invalid)
		require.ErrorIs(t, err, ErrOpsSettingsInvalid, name)
	}
}

func TestOpsEvents_RecordDeliverAndPrune(t *testing.T) {
	t.Parallel()
	svc := newTestService(t)
	ctx := context.Background()
	now := time.Now().UTC()
	key := "outage:1:open"

	created, err := svc.RecordOpsEvent(ctx, &OpsEvent{Kind: OpsKindServerDown, Severity: OpsSeverityWarning, Title: "Сервер недоступен", DedupKey: &key, CreatedAt: now})
	require.NoError(t, err)
	assert.True(t, created)
	again, err := svc.RecordOpsEvent(ctx, &OpsEvent{Kind: OpsKindServerDown, Severity: OpsSeverityWarning, Title: "Сервер недоступен", DedupKey: &key, CreatedAt: now})
	require.NoError(t, err)
	assert.False(t, again, "the dedup key makes the event idempotent")

	_, err = svc.RecordOpsEvent(ctx, &OpsEvent{Kind: OpsKindServerUp, Severity: "loud", Title: "x"})
	require.Error(t, err, "an unknown severity is rejected")

	_, err = svc.RecordOpsEvent(ctx, &OpsEvent{Kind: OpsKindSourceDisabled, Severity: OpsSeverityInfo, Title: "Источник отключён", NotifyStatus: OpsNotifySkipped, CreatedAt: now})
	require.NoError(t, err)
	old, err := svc.RecordOpsEvent(ctx, &OpsEvent{Kind: OpsKindCountryUp, Severity: OpsSeverityOK, Title: "Старое", CreatedAt: now.Add(-100 * 24 * time.Hour)})
	require.NoError(t, err)
	require.True(t, old)

	known, err := svc.ExistingOpsEventKeys(ctx, []string{key, "outage:1:close"})
	require.NoError(t, err)
	assert.Equal(t, map[string]bool{key: true}, known)

	pending, err := svc.PendingOpsEvents(ctx, 10)
	require.NoError(t, err)
	require.Len(t, pending, 2, "a skipped event is not queued")
	ids := []uint{pending[0].ID, pending[1].ID}

	// A failed delivery stays pending until the attempts run out.
	for attempt := 1; attempt <= OpsMaxNotifyAttempts; attempt++ {
		require.NoError(t, svc.FinishOpsEvents(ctx, ids[:1], strings.Repeat("e", 400), now))
		var ev OpsEvent
		require.NoError(t, svc.db.First(&ev, ids[0]).Error)
		assert.Equal(t, attempt, ev.NotifyAttempts)
		assert.Len(t, ev.NotifyError, 300, "the stored error is bounded")
		if attempt < OpsMaxNotifyAttempts {
			assert.Equal(t, OpsNotifyPending, ev.NotifyStatus)
		} else {
			assert.Equal(t, OpsNotifyFailed, ev.NotifyStatus)
		}
	}
	require.NoError(t, svc.FinishOpsEvents(ctx, ids[1:], "", now))
	var sent OpsEvent
	require.NoError(t, svc.db.First(&sent, ids[1]).Error)
	assert.Equal(t, OpsNotifySent, sent.NotifyStatus)
	require.NotNil(t, sent.NotifiedAt)

	events, total, err := svc.ListOpsEvents(ctx, OpsEventFilter{})
	require.NoError(t, err)
	assert.Equal(t, int64(3), total)
	require.Len(t, events, 3)
	assert.True(t, !events[0].CreatedAt.Before(events[2].CreatedAt), "newest first")
	_, warnings, err := svc.ListOpsEvents(ctx, OpsEventFilter{Severity: OpsSeverityWarning})
	require.NoError(t, err)
	assert.Equal(t, int64(1), warnings)

	pruned, err := svc.PruneOpsEvents(ctx, now.Add(-90*24*time.Hour))
	require.NoError(t, err)
	assert.Equal(t, int64(1), pruned)

	_, err = svc.RecordOpsEvent(ctx, &OpsEvent{Kind: OpsKindTest, Severity: OpsSeverityInfo, Title: "ждёт"})
	require.NoError(t, err)
	require.NoError(t, svc.SkipPendingOpsEvents(ctx))
	pending, err = svc.PendingOpsEvents(ctx, 10)
	require.NoError(t, err)
	assert.Empty(t, pending)
}

func TestOpsState_SwapAndReportDay(t *testing.T) {
	t.Parallel()
	svc := newTestService(t)
	ctx := context.Background()
	now := time.Now().UTC()

	previous, changed, err := svc.SwapOpsState(ctx, "source:1", "ok", now)
	require.NoError(t, err)
	assert.True(t, changed)
	assert.Empty(t, previous, "a new subject has no previous state")

	previous, changed, err = svc.SwapOpsState(ctx, "source:1", "ok", now)
	require.NoError(t, err)
	assert.False(t, changed)
	assert.Equal(t, "ok", previous)

	previous, changed, err = svc.SwapOpsState(ctx, "source:1", "expired", now)
	require.NoError(t, err)
	assert.True(t, changed)
	assert.Equal(t, "ok", previous)

	claimed, err := svc.ClaimOpsReportDay(ctx, "2026-11-12")
	require.NoError(t, err)
	assert.True(t, claimed)
	claimed, err = svc.ClaimOpsReportDay(ctx, "2026-11-12")
	require.NoError(t, err)
	assert.False(t, claimed, "a day is reported at most once")
	claimed, err = svc.ClaimOpsReportDay(ctx, "2026-11-11")
	require.NoError(t, err)
	assert.False(t, claimed, "an earlier day is never reported after a later one")
	claimed, err = svc.ClaimOpsReportDay(ctx, "2026-11-13")
	require.NoError(t, err)
	assert.True(t, claimed)
	_, err = svc.ClaimOpsReportDay(ctx, "yesterday")
	require.ErrorIs(t, err, ErrOpsSettingsInvalid)
}

func TestOpsDailyStats(t *testing.T) {
	t.Parallel()
	f := newPromoFixture(t)
	now := time.Now().UTC()
	from, to := now.Add(-time.Hour), now.Add(time.Hour)

	// Two customers: one buys with a promo code, one takes a free tariff.
	buyer := f.user(701)
	f.user(702)
	product := f.product("Месяц", 20000)
	free := f.product("Бесплатный", 0)
	f.promo("STAT", 25, 0)
	discount, err := f.svc.ActivatePromoCode(f.ctx, 701, "STAT", now)
	require.NoError(t, err)
	order, err := f.svc.FindOrCreatePendingPaymentOrder(f.ctx, buyer.ID, product.ID, 15000, "RUB", now)
	require.NoError(t, err)
	require.NoError(t, f.svc.SetOrderDiscount(f.ctx, order.ID, discount, product.PriceCents))
	activated, err := f.svc.ConfirmOrderPaidCAS(f.ctx, order.ID, now, now, buyer, product, 15000)
	require.NoError(t, err)
	require.True(t, activated)
	_, err = f.svc.ActivateFreeOrder(f.ctx, 702, free.ID, now)
	require.NoError(t, err)

	// One usable source and one that ran out of its term.
	past := now.Add(-time.Hour)
	require.NoError(t, f.svc.db.Create(&ProviderSource{Name: "ok", Type: "subscription", SubscriptionURL: "https://example.com/sub", Enabled: true}).Error)
	require.NoError(t, f.svc.db.Create(&ProviderSource{Name: "expired", Type: "subscription", SubscriptionURL: "https://example.com/old", Enabled: true, ExpiresAt: &past}).Error)

	st, err := f.svc.OpsDailyStats(f.ctx, from, to, now)
	require.NoError(t, err)
	assert.Equal(t, int64(2), st.UsersTotal)
	assert.Equal(t, int64(2), st.UsersNew)
	assert.Equal(t, int64(2), st.ActiveSubs)
	assert.Equal(t, int64(2), st.PaidActiveSubs, "a tariff holder counts, paid or free")
	assert.Equal(t, int64(2), st.Purchases)
	assert.Equal(t, int64(1), st.FreeActivations)
	assert.Equal(t, int64(1), st.PromoActivations)
	assert.Equal(t, int64(1), st.PromoRedemptions)
	assert.Equal(t, int64(2), st.SourcesTotal)
	assert.Equal(t, int64(1), st.SourcesUnusable)
	assert.Equal(t, int64(1), st.BuildersEnabled)
	// Revenue counts money only: the free activation adds nothing.
	require.Len(t, st.PeriodRevenue, 1)
	assert.Equal(t, OpsMoney{Currency: "RUB", AmountCents: 15000, Orders: 1}, st.PeriodRevenue[0])
	require.Len(t, st.TotalRevenue, 1)
	assert.Equal(t, int64(15000), st.TotalRevenue[0].AmountCents)

	// Another period has no sales but the same totals.
	empty, err := f.svc.OpsDailyStats(f.ctx, from.Add(-48*time.Hour), to.Add(-48*time.Hour), now)
	require.NoError(t, err)
	assert.Zero(t, empty.Purchases)
	assert.Empty(t, empty.PeriodRevenue)
	assert.Equal(t, int64(2), empty.UsersTotal)
	require.Len(t, empty.TotalRevenue, 1)
}
