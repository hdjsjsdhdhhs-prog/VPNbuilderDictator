package service

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/hdjsjsdhdhhs-prog/VPNbuilderDictator/internal/config"
	"github.com/hdjsjsdhdhhs-prog/VPNbuilderDictator/internal/database"
	"github.com/hdjsjsdhdhhs-prog/VPNbuilderDictator/internal/service/payment/platega"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The purchase flow with discounts and free tariffs, on a real database: the
// provider is asked for the discounted amount, the payment redeems the
// discount, and a tariff that costs nothing is granted without the provider.

// recordingProvider answers every request with a fresh transaction and
// remembers what it was asked to charge.
type recordingProvider struct {
	mu       sync.Mutex
	requests []platega.CreateTransactionRequest
	ids      []uuid.UUID
}

func (p *recordingProvider) CreateTransaction(_ context.Context, req platega.CreateTransactionRequest) (*platega.CreateTransactionResponse, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	id := uuid.New()
	p.requests = append(p.requests, req)
	p.ids = append(p.ids, id)
	return &platega.CreateTransactionResponse{TransactionID: id.String(), URL: "https://pay.example/" + id.String(), ExpiresIn: "00:15:00"}, nil
}

func (p *recordingProvider) GetTransactionStatus(context.Context, uuid.UUID) (*platega.TransactionStatusResponse, error) {
	return nil, errors.New("status not configured")
}

type promoFlowFixture struct {
	ctx      context.Context
	db       *database.Service
	orders   *OrderService
	provider *recordingProvider
	plan     *database.Plan
}

func newPromoFlowFixture(t *testing.T) *promoFlowFixture {
	t.Helper()
	db, err := database.NewService(filepath.Join(t.TempDir(), "promo.db"))
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })
	builder := &database.SubscriptionBuilder{Name: "flow-builder", Enabled: true, Version: 1}
	require.NoError(t, db.GetDB().Create(builder).Error)
	plan := &database.Plan{Name: "flow-premium", IsActive: true, SubscriptionBuilderID: &builder.ID}
	require.NoError(t, db.GetDB().Create(plan).Error)
	provider := &recordingProvider{}
	cfg := &config.Config{GlobalSubURL: "https://vpn.example.com/sub/"}
	subs := NewSubscriptionService(db, cfg)
	return &promoFlowFixture{ctx: context.Background(), db: db, provider: provider, plan: plan,
		orders: NewOrderService(db, subs, provider, "testbot", cfg)}
}

func (f *promoFlowFixture) product(t *testing.T, name string, price int64) *database.Product {
	t.Helper()
	p := &database.Product{PlanID: f.plan.ID, Name: name, DurationDays: 30, PriceCents: price, Currency: "RUB", IsActive: true, Version: 1}
	require.NoError(t, f.db.GetDB().Create(p).Error)
	return p
}

func (f *promoFlowFixture) promo(t *testing.T, code string, percent int) {
	t.Helper()
	_, err := NewPromoService(f.db).Create(f.ctx, "admin", "create-"+code, database.PromoInput{Code: code, Percent: percent, ValidHours: 24, Enabled: true})
	require.NoError(t, err)
}

func TestPurchaseFlow_DiscountLowersThePayment(t *testing.T) {
	t.Parallel()
	f := newPromoFlowFixture(t)
	const buyer = int64(4242)
	product := f.product(t, "Месяц", 20000)

	// Without a discount: the catalogue price. The customer has no
	// subscription yet; one is created for the payment.
	quote := f.orders.Quote(f.ctx, buyer, product)
	assert.Equal(t, int64(20000), quote.AmountCents)
	assert.Nil(t, quote.Discount)
	info, order, err := f.orders.RequestPayment(f.ctx, buyer, "buyer", product)
	require.NoError(t, err)
	require.NotNil(t, info)
	assert.Equal(t, int64(20000), order.AmountCents)
	require.Len(t, f.provider.requests, 1)
	assert.Equal(t, int64(20000), f.provider.requests[0].AmountCents)

	// The code is typed in lower case; the service normalizes it.
	f.promo(t, "sale25", 25)
	discount, err := f.orders.ActivatePromo(f.ctx, buyer, " sale25 ")
	require.NoError(t, err)
	assert.Equal(t, 25, discount.Percent)
	_, err = f.orders.ActivatePromo(f.ctx, buyer, "SALE25")
	require.ErrorIs(t, err, database.ErrPromoAlreadyUsed)
	_, err = f.orders.ActivatePromo(f.ctx, buyer, "missing")
	require.ErrorIs(t, err, database.ErrPromoNotFound)

	quote = f.orders.Quote(f.ctx, buyer, product)
	assert.Equal(t, int64(15000), quote.AmountCents)
	assert.Equal(t, int64(20000), quote.ListCents)
	require.NotNil(t, quote.Discount)
	assert.False(t, quote.Free())

	// The full-price intent is released and replaced by a discounted one;
	// the provider is asked for the discounted amount.
	info2, order2, err := f.orders.RequestPayment(f.ctx, buyer, "buyer", product)
	require.NoError(t, err)
	assert.NotEqual(t, order.ID, order2.ID)
	assert.NotEqual(t, info.PaymentID, info2.PaymentID)
	assert.Equal(t, int64(15000), order2.AmountCents)
	applied, err := f.db.GetOrderDiscount(f.ctx, order2.ID)
	require.NoError(t, err)
	require.NotNil(t, applied)
	assert.Equal(t, 25, applied.Percent)
	assert.Equal(t, discount.ID, applied.UserDiscountID)
	assert.Equal(t, int64(20000), applied.ListAmountCents)
	fullPrice, err := f.db.GetOrderDiscount(f.ctx, order.ID)
	require.NoError(t, err)
	assert.Nil(t, fullPrice, "an order at the catalogue price has no discount")
	require.Len(t, f.provider.requests, 2)
	assert.Equal(t, int64(15000), f.provider.requests[1].AmountCents)
	old, err := f.db.GetOrderByID(f.ctx, order.ID)
	require.NoError(t, err)
	assert.Equal(t, database.OrderStatusExpired, old.Status)

	// Asking again reuses the discounted link: no third provider request.
	info3, order3, err := f.orders.RequestPayment(f.ctx, buyer, "buyer", product)
	require.NoError(t, err)
	assert.Equal(t, order2.ID, order3.ID)
	assert.Equal(t, info2.URL, info3.URL)
	assert.Len(t, f.provider.requests, 2)

	// An underpayment of the discounted amount is still rejected.
	_, err = f.orders.ConfirmPayment(f.ctx, info2.PaymentID, json.Number("149.99"), "RUB")
	require.ErrorIs(t, err, ErrAmountMismatch)

	confirmation, err := f.orders.ConfirmPayment(f.ctx, info2.PaymentID, json.Number("150"), "RUB")
	require.NoError(t, err)
	require.True(t, confirmation.Activated)

	sub, err := f.db.GetByTelegramID(f.ctx, buyer)
	require.NoError(t, err)
	assert.Equal(t, f.plan.ID, sub.PlanID)
	require.NotNil(t, sub.ExpiresAt)

	// The discount is used up: the next purchase is at the catalogue price.
	used, err := f.orders.ActiveDiscount(f.ctx, buyer)
	require.NoError(t, err)
	assert.Nil(t, used)
	assert.Equal(t, int64(20000), f.orders.Quote(f.ctx, buyer, product).AmountCents)
	var redeemed database.UserDiscount
	require.NoError(t, f.db.GetDB().First(&redeemed, discount.ID).Error)
	require.NotNil(t, redeemed.OrderID)
	assert.Equal(t, order2.ID, *redeemed.OrderID)
}

func TestPurchaseFlow_NothingToPayIsGrantedWithoutProvider(t *testing.T) {
	t.Parallel()
	f := newPromoFlowFixture(t)
	const buyer = int64(5151)
	paid := f.product(t, "Месяц", 20000)
	free := f.product(t, "Бесплатный", 0)

	products, err := f.orders.FreeProducts(f.ctx)
	require.NoError(t, err)
	require.Len(t, products, 1)
	assert.Equal(t, free.ID, products[0].ID)
	assert.True(t, f.orders.Quote(f.ctx, buyer, free).Free())

	// A free tariff: the subscription is created on demand, no provider call.
	activation, err := f.orders.ActivateFree(f.ctx, buyer, "buyer", free.ID)
	require.NoError(t, err)
	assert.Equal(t, int64(0), activation.Order.AmountCents)
	assert.Equal(t, database.FreeProvider, activation.Order.PaymentProvider)
	assert.Equal(t, f.plan.ID, activation.Subscription.PlanID)
	require.NotNil(t, activation.Subscription.ExpiresAt)
	assert.WithinDuration(t, time.Now().AddDate(0, 0, 30), *activation.Subscription.ExpiresAt, time.Minute)
	assert.Empty(t, f.provider.requests)

	_, err = f.orders.ActivateFree(f.ctx, buyer, "buyer", free.ID)
	require.ErrorIs(t, err, database.ErrFreeTariffActive, "free terms do not stack")
	_, err = f.orders.ActivateFree(f.ctx, buyer, "buyer", paid.ID)
	require.ErrorIs(t, err, database.ErrFreeActivationUnavailable, "a paid tariff is not free")

	// A 100 % code: RequestPayment has nothing to charge, ActivateFree grants it.
	f.promo(t, "GIFT", 100)
	_, err = f.orders.ActivatePromo(f.ctx, buyer, "GIFT")
	require.NoError(t, err)
	assert.True(t, f.orders.Quote(f.ctx, buyer, paid).Free())
	_, _, err = f.orders.RequestPayment(f.ctx, buyer, "buyer", paid)
	require.ErrorIs(t, err, ErrNothingToPay)
	assert.Empty(t, f.provider.requests, "the provider is never asked to charge zero")

	gift, err := f.orders.ActivateFree(f.ctx, buyer, "buyer", paid.ID)
	require.NoError(t, err)
	require.NotNil(t, gift.Discount)
	assert.Equal(t, 100, gift.Discount.Percent)
	assert.Nil(t, activation.Discount, "a free tariff uses no discount")
	require.NotNil(t, gift.Subscription.ProductID)
	assert.Equal(t, paid.ID, *gift.Subscription.ProductID)

	// The gift is used: the same tariff now costs its price again.
	_, err = f.orders.ActivateFree(f.ctx, buyer, "buyer", paid.ID)
	require.ErrorIs(t, err, database.ErrFreeActivationUnavailable)
}

func TestPromoService_AdminViews(t *testing.T) {
	t.Parallel()
	f := newPromoFlowFixture(t)
	svc := NewPromoService(f.db)

	created, err := svc.Create(f.ctx, "admin", "k1", database.PromoInput{Code: " spring ", Percent: 15, MaxActivations: 1, ValidHours: 48, Enabled: true, Note: "  весна  "})
	require.NoError(t, err)
	require.NotNil(t, created.Promo)
	assert.Equal(t, "SPRING", created.Promo.Code, "codes are stored in upper case")
	assert.Equal(t, "весна", created.Promo.Note)
	assert.Equal(t, "active", created.Promo.State)

	_, err = f.orders.ActivatePromo(f.ctx, 77, "spring")
	require.NoError(t, err)
	list, err := svc.List(f.ctx)
	require.NoError(t, err)
	require.Len(t, list, 1)
	assert.Equal(t, "exhausted", list[0].State)
	assert.Equal(t, 1, list[0].Activations)

	updated, err := svc.Update(f.ctx, "admin", "k2", database.PromoUpdate{ID: created.Promo.ID, Version: list[0].Version, MaxActivations: 0, ValidHours: 48, Enabled: false})
	require.NoError(t, err)
	assert.Equal(t, "disabled", updated.Promo.State)

	_, err = svc.Delete(f.ctx, "admin", "k3", created.Promo.ID, updated.Promo.Version)
	require.ErrorIs(t, err, database.ErrPromoInUse)
}
