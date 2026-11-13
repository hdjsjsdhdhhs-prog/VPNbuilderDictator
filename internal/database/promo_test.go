package database

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Promo codes, user discounts and free tariffs (migration 053).

type promoFixture struct {
	t    *testing.T
	svc  *Service
	ctx  context.Context
	plan *Plan
	keys int
}

// newPromoFixture seeds a sellable plan: active, with an enabled builder.
func newPromoFixture(t *testing.T) *promoFixture {
	t.Helper()
	svc := newTestService(t)
	builder := &SubscriptionBuilder{Name: "promo-builder", Enabled: true, Version: 1}
	require.NoError(t, svc.db.Create(builder).Error)
	plan := &Plan{Name: "promo-premium", IsActive: true, SubscriptionBuilderID: &builder.ID}
	require.NoError(t, svc.db.Create(plan).Error)
	return &promoFixture{t: t, svc: svc, ctx: context.Background(), plan: plan}
}

func (f *promoFixture) meta() AdminConfigMeta {
	f.keys++
	return AdminConfigMeta{Actor: "admin", RequestKey: fmt.Sprintf("promo-key-%d", f.keys)}
}

func (f *promoFixture) product(name string, price int64) *Product {
	f.t.Helper()
	p := &Product{PlanID: f.plan.ID, Name: name, DurationDays: 30, PriceCents: price, Currency: "RUB", IsActive: true, Version: 1}
	require.NoError(f.t, f.svc.db.Create(p).Error)
	return p
}

func (f *promoFixture) promo(code string, percent, maxActivations int) *PromoCode {
	f.t.Helper()
	res, err := f.svc.CreatePromoCode(f.ctx, f.meta(), PromoInput{Code: code, Percent: percent, MaxActivations: maxActivations, ValidHours: 24, Enabled: true})
	require.NoError(f.t, err)
	created, err := f.svc.GetPromoCode(f.ctx, res.TargetID)
	require.NoError(f.t, err)
	return created
}

// user creates a linked customer on the free plan without an expiry.
func (f *promoFixture) user(telegramID int64) *Subscription {
	f.t.Helper()
	sub := createTestSubscription(f.t, f.svc, telegramID, "buyer", fmt.Sprintf("promo-client-%d", telegramID))
	require.NoError(f.t, f.svc.db.Model(sub).Update("expires_at", nil).Error)
	var reloaded Subscription
	require.NoError(f.t, f.svc.db.First(&reloaded, sub.ID).Error)
	return &reloaded
}

func (f *promoFixture) coupon(telegramID int64, code string, percent int, expiresAt time.Time) *WarmupCoupon {
	f.t.Helper()
	sc := warmupScenarioByKey(f.t, f.svc, "trial_ended_discount")
	c := &WarmupCoupon{Code: code, TelegramID: telegramID, ScenarioID: sc.ID, Percent: percent, Status: WarmupCouponIssued, CreatedAt: time.Now().UTC(), ExpiresAt: expiresAt}
	require.NoError(f.t, f.svc.db.Create(c).Error)
	return c
}

func TestDiscountedAmount(t *testing.T) {
	t.Parallel()
	assert.Equal(t, int64(20000), DiscountedAmount(20000, 0))
	assert.Equal(t, int64(16000), DiscountedAmount(20000, 20))
	assert.Equal(t, int64(0), DiscountedAmount(20000, 100))
	assert.Equal(t, int64(0), DiscountedAmount(20000, 150))
	// The discount is rounded down: 33 % of 199,99 is 65,99; the customer pays 134,00.
	assert.Equal(t, int64(13400), DiscountedAmount(19999, 33))
	assert.Equal(t, int64(0), DiscountedAmount(0, 50))
}

func TestPromoCode_CreateValidateUpdateDelete(t *testing.T) {
	t.Parallel()
	f := newPromoFixture(t)
	past := time.Now().Add(-time.Hour)

	for name, in := range map[string]PromoInput{
		"short code":     {Code: "AB", Percent: 10, ValidHours: 24},
		"lower case":     {Code: "summer", Percent: 10, ValidHours: 24},
		"zero percent":   {Code: "SUMMER", Percent: 0, ValidHours: 24},
		"over 100":       {Code: "SUMMER", Percent: 101, ValidHours: 24},
		"negative limit": {Code: "SUMMER", Percent: 10, MaxActivations: -1, ValidHours: 24},
		"zero validity":  {Code: "SUMMER", Percent: 10, ValidHours: 0},
		"past expiry":    {Code: "SUMMER", Percent: 10, ValidHours: 24, ExpiresAt: &past},
	} {
		_, err := f.svc.CreatePromoCode(f.ctx, f.meta(), in)
		require.ErrorIs(t, err, ErrPromoInvalid, name)
	}

	promo := f.promo("SUMMER-25", 25, 100)
	assert.Equal(t, 1, promo.Version)
	assert.True(t, promo.Enabled)

	_, err := f.svc.CreatePromoCode(f.ctx, f.meta(), PromoInput{Code: "SUMMER-25", Percent: 5, ValidHours: 24, Enabled: true})
	require.ErrorIs(t, err, ErrPromoCodeTaken)

	// A promo code may not shadow a personal warm-up coupon.
	f.coupon(900, "TRIAL-ABCD2345", 20, time.Now().Add(time.Hour))
	_, err = f.svc.CreatePromoCode(f.ctx, f.meta(), PromoInput{Code: "TRIAL-ABCD2345", Percent: 5, ValidHours: 24, Enabled: true})
	require.ErrorIs(t, err, ErrPromoCodeTaken)

	// Replaying the same request key returns the recorded outcome.
	meta := f.meta()
	in := PromoInput{Code: "ONCE", Percent: 10, ValidHours: 24, Enabled: true}
	first, err := f.svc.CreatePromoCode(f.ctx, meta, in)
	require.NoError(t, err)
	replay, err := f.svc.CreatePromoCode(f.ctx, meta, in)
	require.NoError(t, err)
	assert.True(t, replay.Replayed)
	assert.Equal(t, first.TargetID, replay.TargetID)

	_, err = f.svc.UpdatePromoCode(f.ctx, f.meta(), PromoUpdate{ID: promo.ID, Version: 7, ValidHours: 24})
	require.ErrorIs(t, err, ErrPromoVersionConflict)
	_, err = f.svc.UpdatePromoCode(f.ctx, f.meta(), PromoUpdate{ID: promo.ID, Version: 1, MaxActivations: 5, ValidHours: 48, Enabled: false, Note: "акция"})
	require.NoError(t, err)
	updated, err := f.svc.GetPromoCode(f.ctx, promo.ID)
	require.NoError(t, err)
	assert.Equal(t, 2, updated.Version)
	assert.False(t, updated.Enabled)
	assert.Equal(t, 48, updated.ValidHours)
	assert.Equal(t, 25, updated.Percent, "the percent of a code is fixed")

	_, err = f.svc.DeletePromoCode(f.ctx, f.meta(), promo.ID, 2)
	require.NoError(t, err)
	_, err = f.svc.GetPromoCode(f.ctx, promo.ID)
	require.ErrorIs(t, err, ErrPromoNotFound)
}

func TestPromoCode_Activation(t *testing.T) {
	t.Parallel()
	f := newPromoFixture(t)
	now := time.Now().UTC()
	promo := f.promo("WELCOME", 30, 2)

	_, err := f.svc.ActivatePromoCode(f.ctx, 101, "nope", now)
	require.ErrorIs(t, err, ErrPromoNotFound)
	_, err = f.svc.ActivatePromoCode(f.ctx, 0, "WELCOME", now)
	require.ErrorIs(t, err, ErrPromoNotFound, "only linked customers activate codes")

	// The typed code is trimmed and case-insensitive.
	d, err := f.svc.ActivatePromoCode(f.ctx, 101, "  welcome ", now)
	require.NoError(t, err)
	assert.Equal(t, 30, d.Percent)
	assert.Equal(t, DiscountSourcePromo, d.Source)
	assert.WithinDuration(t, now.Add(24*time.Hour), d.ExpiresAt, time.Second)

	_, err = f.svc.ActivatePromoCode(f.ctx, 101, "WELCOME", now)
	require.ErrorIs(t, err, ErrPromoAlreadyUsed, "one activation per customer")

	_, err = f.svc.ActivatePromoCode(f.ctx, 102, "WELCOME", now)
	require.NoError(t, err)
	_, err = f.svc.ActivatePromoCode(f.ctx, 103, "WELCOME", now)
	require.ErrorIs(t, err, ErrPromoExhausted, "the activation limit is enforced")

	stored, err := f.svc.GetPromoCode(f.ctx, promo.ID)
	require.NoError(t, err)
	assert.Equal(t, 2, stored.Activations)

	// A code with activations cannot be deleted, only disabled.
	_, err = f.svc.DeletePromoCode(f.ctx, f.meta(), promo.ID, stored.Version)
	require.ErrorIs(t, err, ErrPromoInUse)

	disabled := f.promo("OFF", 10, 0)
	_, err = f.svc.UpdatePromoCode(f.ctx, f.meta(), PromoUpdate{ID: disabled.ID, Version: 1, ValidHours: 24, Enabled: false})
	require.NoError(t, err)
	_, err = f.svc.ActivatePromoCode(f.ctx, 101, "OFF", now)
	require.ErrorIs(t, err, ErrPromoDisabled)

	soon := now.Add(time.Hour)
	_, err = f.svc.CreatePromoCode(f.ctx, f.meta(), PromoInput{Code: "FLASH", Percent: 50, ValidHours: 24, ExpiresAt: &soon, Enabled: true})
	require.NoError(t, err)
	_, err = f.svc.ActivatePromoCode(f.ctx, 101, "FLASH", now.Add(2*time.Hour))
	require.ErrorIs(t, err, ErrPromoExpired)

	// The best usable discount wins; an expired one is ignored.
	best, err := f.svc.ActiveUserDiscount(f.ctx, 101, now)
	require.NoError(t, err)
	require.NotNil(t, best)
	assert.Equal(t, 30, best.Percent)
	gone, err := f.svc.ActiveUserDiscount(f.ctx, 101, now.Add(25*time.Hour))
	require.NoError(t, err)
	assert.Nil(t, gone)
	none, err := f.svc.ActiveUserDiscount(f.ctx, 999, now)
	require.NoError(t, err)
	assert.Nil(t, none)
}

func TestWarmupCoupon_OneClickActivation(t *testing.T) {
	t.Parallel()
	f := newPromoFixture(t)
	now := time.Now().UTC()

	_, err := f.svc.ActivateWarmupCoupon(f.ctx, 201, now)
	require.ErrorIs(t, err, ErrPromoNotFound, "no coupon: nothing to apply")

	f.coupon(201, "TRIAL-OLD23456", 50, now.Add(-time.Minute))
	_, err = f.svc.ActivateWarmupCoupon(f.ctx, 201, now)
	require.ErrorIs(t, err, ErrPromoNotFound, "an expired coupon is not applied")

	coupon := f.coupon(201, "TRIAL-NEW23456", 20, now.Add(72*time.Hour))
	d, err := f.svc.ActivateWarmupCoupon(f.ctx, 201, now)
	require.NoError(t, err)
	assert.Equal(t, 20, d.Percent)
	assert.Equal(t, DiscountSourceWarmup, d.Source)
	require.NotNil(t, d.WarmupCouponID)
	assert.Equal(t, coupon.ID, *d.WarmupCouponID)
	assert.WithinDuration(t, coupon.ExpiresAt, d.ExpiresAt, time.Second, "the discount lives as long as the coupon")

	// The button is idempotent: a second click returns the same discount.
	again, err := f.svc.ActivateWarmupCoupon(f.ctx, 201, now)
	require.NoError(t, err)
	assert.Equal(t, d.ID, again.ID)
	var discounts int64
	require.NoError(t, f.svc.db.Model(&UserDiscount{}).Where("telegram_id = ?", 201).Count(&discounts).Error)
	assert.Equal(t, int64(1), discounts)

	// The owner may also type the code; a stranger cannot use it.
	typed, err := f.svc.ActivatePromoCode(f.ctx, 201, "trial-new23456", now)
	require.NoError(t, err)
	assert.Equal(t, d.ID, typed.ID)
	_, err = f.svc.ActivatePromoCode(f.ctx, 202, "TRIAL-NEW23456", now)
	require.ErrorIs(t, err, ErrPromoNotFound)
}

func TestConfirmOrderPaid_RedeemsDiscountAndCoupon(t *testing.T) {
	t.Parallel()
	f := newPromoFixture(t)
	now := time.Now().UTC()
	sub := f.user(301)
	product := f.product("Месяц", 20000)
	coupon := f.coupon(301, "TRIAL-PAY23456", 20, now.Add(72*time.Hour))
	discount, err := f.svc.ActivateWarmupCoupon(f.ctx, 301, now)
	require.NoError(t, err)

	amount := DiscountedAmount(product.PriceCents, discount.Percent)
	require.Equal(t, int64(16000), amount)
	order, err := f.svc.FindOrCreatePendingPaymentOrder(f.ctx, sub.ID, product.ID, amount, product.Currency, now)
	require.NoError(t, err)
	require.NoError(t, f.svc.SetOrderDiscount(f.ctx, order.ID, discount, product.PriceCents))

	activated, err := f.svc.ConfirmOrderPaidCAS(f.ctx, order.ID, now, now, sub, product, amount)
	require.NoError(t, err)
	require.True(t, activated)

	var paid Order
	require.NoError(t, f.svc.db.First(&paid, order.ID).Error)
	assert.Equal(t, int64(16000), paid.AmountCents)
	applied, err := f.svc.GetOrderDiscount(f.ctx, order.ID)
	require.NoError(t, err)
	require.NotNil(t, applied)
	assert.Equal(t, 20, applied.Percent)
	assert.Equal(t, discount.ID, applied.UserDiscountID)
	assert.Equal(t, int64(20000), applied.ListAmountCents)

	var redeemed UserDiscount
	require.NoError(t, f.svc.db.First(&redeemed, discount.ID).Error)
	require.NotNil(t, redeemed.RedeemedAt)
	require.NotNil(t, redeemed.OrderID)
	assert.Equal(t, order.ID, *redeemed.OrderID)

	var usedCoupon WarmupCoupon
	require.NoError(t, f.svc.db.First(&usedCoupon, coupon.ID).Error)
	assert.Equal(t, WarmupCouponRedeemed, usedCoupon.Status)
	require.NotNil(t, usedCoupon.OrderID)
	assert.Equal(t, order.ID, *usedCoupon.OrderID)

	// A used discount no longer lowers prices.
	best, err := f.svc.ActiveUserDiscount(f.ctx, 301, now)
	require.NoError(t, err)
	assert.Nil(t, best)

	// A paid order keeps the discount it was paid with.
	other := f.promo("LATER", 20, 0)
	later, err := f.svc.ActivatePromoCode(f.ctx, 301, other.Code, now)
	require.NoError(t, err)
	require.NoError(t, f.svc.SetOrderDiscount(f.ctx, order.ID, later, product.PriceCents))
	kept, err := f.svc.GetOrderDiscount(f.ctx, order.ID)
	require.NoError(t, err)
	require.NotNil(t, kept)
	assert.Equal(t, discount.ID, kept.UserDiscountID, "only a pending intent is re-pointed")

	// A reused pending intent is re-pointed at the customer's current discount.
	second := f.product("Квартал", 50000)
	intent, err := f.svc.FindOrCreatePendingPaymentOrder(f.ctx, sub.ID, second.ID, 40000, second.Currency, now)
	require.NoError(t, err)
	none, err := f.svc.GetOrderDiscount(f.ctx, intent.ID)
	require.NoError(t, err)
	assert.Nil(t, none, "an intent has no discount until one is recorded")
	require.NoError(t, f.svc.SetOrderDiscount(f.ctx, intent.ID, later, second.PriceCents))
	require.NoError(t, f.svc.SetOrderDiscount(f.ctx, intent.ID, later, second.PriceCents))
	pointed, err := f.svc.GetOrderDiscount(f.ctx, intent.ID)
	require.NoError(t, err)
	require.NotNil(t, pointed)
	assert.Equal(t, later.ID, pointed.UserDiscountID)
	assert.Equal(t, int64(50000), pointed.ListAmountCents)
}

func TestExpirePendingPaymentOrder(t *testing.T) {
	t.Parallel()
	f := newPromoFixture(t)
	now := time.Now().UTC()
	sub := f.user(351)
	product := f.product("Месяц", 20000)
	order, err := f.svc.FindOrCreatePendingPaymentOrder(f.ctx, sub.ID, product.ID, product.PriceCents, product.Currency, now)
	require.NoError(t, err)

	released, err := f.svc.ExpirePendingPaymentOrder(f.ctx, order.ID)
	require.NoError(t, err)
	assert.True(t, released)
	again, err := f.svc.ExpirePendingPaymentOrder(f.ctx, order.ID)
	require.NoError(t, err)
	assert.False(t, again, "only a pending intent is released")

	// The slot is free: a new intent with the discounted amount is created.
	next, err := f.svc.FindOrCreatePendingPaymentOrder(f.ctx, sub.ID, product.ID, 16000, product.Currency, now)
	require.NoError(t, err)
	assert.NotEqual(t, order.ID, next.ID)
	assert.Equal(t, int64(16000), next.AmountCents)

	// An intent with an uncertain provider outcome is never released.
	claimed, err := f.svc.MarkPaymentCreationUncertain(f.ctx, next.ID, true)
	require.NoError(t, err)
	require.True(t, claimed)
	released, err = f.svc.ExpirePendingPaymentOrder(f.ctx, next.ID)
	require.NoError(t, err)
	assert.False(t, released)
}

func TestActivateFreeOrder_FreeTariff(t *testing.T) {
	t.Parallel()
	f := newPromoFixture(t)
	now := time.Now().UTC()
	sub := f.user(401)

	// The tariff editor accepts a price of 0.
	res, err := f.svc.CreateTariff(f.ctx, f.meta(), TariffInput{Name: "Бесплатный", PlanID: f.plan.ID, DurationDays: 30, PriceCents: 0, Currency: "RUB", IsActive: true})
	require.NoError(t, err)
	free, err := f.svc.GetProductByID(f.ctx, res.TargetID)
	require.NoError(t, err)

	listed, err := f.svc.ListFreeProducts(f.ctx)
	require.NoError(t, err)
	require.Len(t, listed, 1)
	assert.Equal(t, free.ID, listed[0].ID)
	paidList, err := f.svc.ListActiveProducts(f.ctx)
	require.NoError(t, err)
	assert.Empty(t, paidList, "a free tariff is never offered through a payment provider")

	_, err = f.svc.ActivateFreeOrder(f.ctx, 999, free.ID, now)
	require.ErrorIs(t, err, ErrSubscriptionNotFound)

	out, err := f.svc.ActivateFreeOrder(f.ctx, 401, free.ID, now)
	require.NoError(t, err)
	assert.False(t, out.Renewal)
	assert.Equal(t, OrderStatusPaid, out.Order.Status)
	assert.Equal(t, int64(0), out.Order.AmountCents)
	assert.Equal(t, FreeProvider, out.Order.PaymentProvider)
	assert.Equal(t, f.plan.ID, out.Subscription.PlanID)
	require.NotNil(t, out.Subscription.ProductID)
	assert.Equal(t, free.ID, *out.Subscription.ProductID)
	assert.Equal(t, int64(0), out.Subscription.PricePaidCents)
	require.NotNil(t, out.Subscription.ExpiresAt)
	assert.WithinDuration(t, now.AddDate(0, 0, 30), *out.Subscription.ExpiresAt, time.Second)
	assert.Equal(t, sub.ID, out.Subscription.ID)

	// No stacking: the same free tariff cannot be taken again while it runs.
	_, err = f.svc.ActivateFreeOrder(f.ctx, 401, free.ID, now.Add(time.Hour))
	require.ErrorIs(t, err, ErrFreeTariffActive)
	// After its term it can be taken again.
	later, err := f.svc.ActivateFreeOrder(f.ctx, 401, free.ID, now.AddDate(0, 0, 31))
	require.NoError(t, err)
	assert.True(t, later.Renewal)

	// The activation is journaled like a purchase, with a zero amount.
	var events int64
	require.NoError(t, f.svc.db.Model(&JournalEvent{}).Where("order_id = ? AND event_type = ?", out.Order.ID, string(JournalPaidActivated)).Count(&events).Error)
	assert.Equal(t, int64(1), events)

	// A free tariff never replaces a running paid term.
	paidUser := f.user(402)
	paidProduct := f.product("Платный", 50000)
	order, err := f.svc.FindOrCreatePendingPaymentOrder(f.ctx, paidUser.ID, paidProduct.ID, paidProduct.PriceCents, "RUB", now)
	require.NoError(t, err)
	activated, err := f.svc.ConfirmOrderPaidCAS(f.ctx, order.ID, now, now, paidUser, paidProduct, paidProduct.PriceCents)
	require.NoError(t, err)
	require.True(t, activated)
	_, err = f.svc.ActivateFreeOrder(f.ctx, 402, free.ID, now)
	require.ErrorIs(t, err, ErrFreeTariffHasPaid)

	// Unsellable products are refused.
	inactive := f.product("Выключен", 0)
	require.NoError(t, f.svc.db.Model(inactive).Update("is_active", false).Error)
	_, err = f.svc.ActivateFreeOrder(f.ctx, 401, inactive.ID, now.AddDate(0, 0, 90))
	require.ErrorIs(t, err, ErrFreeActivationUnavailable)
	_, err = f.svc.ActivateFreeOrder(f.ctx, 401, 99999, now)
	require.ErrorIs(t, err, ErrProductNotFound)
}

func TestActivateFreeOrder_FullDiscount(t *testing.T) {
	t.Parallel()
	f := newPromoFixture(t)
	now := time.Now().UTC()
	f.user(501)
	product := f.product("Месяц", 20000)

	_, err := f.svc.ActivateFreeOrder(f.ctx, 501, product.ID, now)
	require.ErrorIs(t, err, ErrFreeActivationUnavailable, "a paid tariff is not free without a discount")

	f.promo("HALF", 50, 0)
	_, err = f.svc.ActivatePromoCode(f.ctx, 501, "HALF", now)
	require.NoError(t, err)
	_, err = f.svc.ActivateFreeOrder(f.ctx, 501, product.ID, now)
	require.ErrorIs(t, err, ErrFreeActivationUnavailable, "a partial discount still needs a payment")

	f.promo("GIFT", 100, 0)
	gift, err := f.svc.ActivatePromoCode(f.ctx, 501, "GIFT", now)
	require.NoError(t, err)
	out, err := f.svc.ActivateFreeOrder(f.ctx, 501, product.ID, now)
	require.NoError(t, err)
	assert.Equal(t, int64(0), out.Order.AmountCents)
	require.NotNil(t, out.Discount)
	assert.Equal(t, 100, out.Discount.Percent)
	assert.Equal(t, gift.ID, out.Discount.UserDiscountID)
	assert.Equal(t, int64(20000), out.Discount.ListAmountCents)
	stored, err := f.svc.GetOrderDiscount(f.ctx, out.Order.ID)
	require.NoError(t, err)
	require.NotNil(t, stored)
	assert.Equal(t, 100, stored.Percent)
	assert.Equal(t, int64(0), out.Subscription.PricePaidCents, "nothing was paid")

	var used UserDiscount
	require.NoError(t, f.svc.db.First(&used, gift.ID).Error)
	require.NotNil(t, used.RedeemedAt, "the 100 % discount is used up")

	// The remaining 50 % code is still there, but it is not a free pass.
	_, err = f.svc.ActivateFreeOrder(f.ctx, 501, product.ID, now)
	require.ErrorIs(t, err, ErrFreeActivationUnavailable)
}
