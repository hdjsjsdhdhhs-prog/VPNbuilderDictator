package service

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/hdjsjsdhdhhs-prog/VPNbuilderDictator/internal/database"
	"github.com/hdjsjsdhdhhs-prog/VPNbuilderDictator/internal/logger"

	"go.uber.org/zap"
)

// Promo codes, discounts and free tariffs in the bot's purchase flow.
//
// The discount of a customer (database.UserDiscount) lowers the amount of the
// provider payment created by RequestPayment. When nothing is left to pay — a
// free tariff or a 100 % discount — RequestPayment answers ErrNothingToPay and
// the caller grants the tariff with ActivateFree, without a payment provider.

// ErrNothingToPay: the amount to pay is zero, so there is no provider payment
// to create; grant the tariff with ActivateFree.
var ErrNothingToPay = errors.New("nothing to pay for this product")

// discountRepository is the discount side of the order repository.
// *database.Service implements it; it is resolved from the service's database
// handle like the purchase and Stars repositories, so the composed
// interfaces.DatabaseService contract stays unchanged.
type discountRepository interface {
	ActiveUserDiscount(ctx context.Context, telegramID int64, now time.Time) (*database.UserDiscount, error)
	ActivatePromoCode(ctx context.Context, telegramID int64, code string, now time.Time) (*database.UserDiscount, error)
	ActivateWarmupCoupon(ctx context.Context, telegramID int64, now time.Time) (*database.UserDiscount, error)
	ExpirePendingPaymentOrder(ctx context.Context, orderID uint) (bool, error)
	SetOrderDiscount(ctx context.Context, orderID uint, discount *database.UserDiscount, listAmountCents int64) error
	ActivateFreeOrder(ctx context.Context, telegramID int64, productID uint, now time.Time) (*database.FreeActivation, error)
	ListFreeProducts(ctx context.Context) ([]database.Product, error)
}

var _ discountRepository = (*database.Service)(nil)

func (o *OrderService) discounts() discountRepository {
	if o == nil || o.db == nil {
		return nil
	}
	repo, _ := o.db.(discountRepository)
	return repo
}

// payableAmount is the amount to pay for a product and the discount applied.
// A discount lookup failure never blocks a purchase: the customer is quoted
// the catalogue price and the failure is logged.
func (o *OrderService) payableAmount(ctx context.Context, telegramID int64, product *database.Product, now time.Time) (int64, *database.UserDiscount) {
	if product == nil {
		return 0, nil
	}
	repo := o.discounts()
	if repo == nil || product.PriceCents <= 0 {
		return product.PriceCents, nil
	}
	discount, err := repo.ActiveUserDiscount(ctx, telegramID, now)
	if err != nil {
		logger.Warn("failed to load customer discount; quoting the catalogue price",
			zap.Int64("telegram_id", telegramID), zap.Error(err))
		return product.PriceCents, nil
	}
	if discount == nil {
		return product.PriceCents, nil
	}
	amount := database.DiscountedAmount(product.PriceCents, discount.Percent)
	if amount >= product.PriceCents {
		// The discount is rounded down to nothing on a tiny price: it is not
		// applied, so the purchase does not use it up.
		return product.PriceCents, nil
	}
	return amount, discount
}

// PriceQuote is what a customer pays for a product right now.
type PriceQuote struct {
	ListCents   int64
	AmountCents int64
	// Discount is the applied discount, nil when the catalogue price is paid.
	Discount *database.UserDiscount
}

// Free reports whether nothing is to be paid.
func (q PriceQuote) Free() bool { return q.AmountCents <= 0 }

// Quote prices a product for a customer.
func (o *OrderService) Quote(ctx context.Context, telegramID int64, product *database.Product) PriceQuote {
	if product == nil {
		return PriceQuote{}
	}
	amount, discount := o.payableAmount(ctx, telegramID, product, time.Now().UTC())
	return PriceQuote{ListCents: product.PriceCents, AmountCents: amount, Discount: discount}
}

// ActiveDiscount returns the customer's best usable discount, nil when none.
func (o *OrderService) ActiveDiscount(ctx context.Context, telegramID int64) (*database.UserDiscount, error) {
	repo := o.discounts()
	if repo == nil {
		return nil, nil
	}
	return repo.ActiveUserDiscount(ctx, telegramID, time.Now().UTC())
}

// ActivatePromo activates a typed promo code (or the customer's own personal
// coupon code). Rejections are the database.ErrPromo* sentinels.
func (o *OrderService) ActivatePromo(ctx context.Context, telegramID int64, code string) (*database.UserDiscount, error) {
	repo := o.discounts()
	if repo == nil {
		return nil, database.ErrPromoNotFound
	}
	discount, err := repo.ActivatePromoCode(ctx, telegramID, code, time.Now().UTC())
	if err != nil {
		return nil, err
	}
	logger.Info("Promo code activated", zap.Int64("telegram_id", telegramID),
		zap.String("source", discount.Source), zap.Int("percent", discount.Percent))
	return discount, nil
}

// ActivateCoupon is the one-click warm-up button: it activates the customer's
// personal coupon and returns the best discount the customer now holds.
func (o *OrderService) ActivateCoupon(ctx context.Context, telegramID int64) (*database.UserDiscount, error) {
	repo := o.discounts()
	if repo == nil {
		return nil, database.ErrPromoNotFound
	}
	discount, err := repo.ActivateWarmupCoupon(ctx, telegramID, time.Now().UTC())
	if err != nil {
		return nil, err
	}
	logger.Info("Warm-up coupon activated", zap.Int64("telegram_id", telegramID), zap.Int("percent", discount.Percent))
	return discount, nil
}

// FreeProducts lists the active free tariffs.
func (o *OrderService) FreeProducts(ctx context.Context) ([]database.Product, error) {
	repo := o.discounts()
	if repo == nil {
		return nil, nil
	}
	return repo.ListFreeProducts(ctx)
}

// ActivateFree grants a tariff without payment: a free tariff, or a paid one
// fully covered by the customer's discount. It is a user-initiated operation:
// every failure is returned (database.ErrFree* / ErrSubscriptionNotFound for
// the expected refusals). The customer needs an active subscription; one is
// created when missing, like for a payment.
func (o *OrderService) ActivateFree(ctx context.Context, telegramID int64, username string, productID uint) (*database.FreeActivation, error) {
	repo := o.discounts()
	if repo == nil || telegramID <= 0 || productID == 0 {
		return nil, database.ErrFreeActivationUnavailable
	}
	now := time.Now().UTC()
	activation, err := repo.ActivateFreeOrder(ctx, telegramID, productID, now)
	if errors.Is(err, database.ErrSubscriptionNotFound) && o.subSvc != nil {
		_, createErr := o.subSvc.GetOrCreateSubscription(ctx, telegramID, username, "")
		if createErr != nil {
			return nil, fmt.Errorf("get or create subscription: %w", createErr)
		}
		activation, err = repo.ActivateFreeOrder(ctx, telegramID, productID, now)
	}
	if err != nil {
		return nil, err
	}
	sub := activation.Subscription
	if o.subSvc != nil && sub != nil {
		// The plan (and with it the builder) changed: drop the cached card and
		// the cached /sub body, exactly like after a confirmed payment.
		o.subSvc.InvalidateSubscription(ctx, sub.TelegramID)
		if sub.SubscriptionID != "" {
			o.subSvc.InvalidateBySubID(ctx, sub.SubscriptionID)
		}
	}
	discountPercent := 0
	if activation.Discount != nil {
		discountPercent = activation.Discount.Percent
	}
	logger.Info("Tariff activated without payment",
		zap.Int64("telegram_id", telegramID), zap.Uint("product_id", productID),
		zap.Uint("order_id", activation.Order.ID), zap.Int("discount_percent", discountPercent))
	o.notifyAdminPaid(ctx, sub, activation.Order, activation.Product, activation.Renewal)
	return activation, nil
}

// ---------------------------------------------------------------------------
// Admin: promo codes
// ---------------------------------------------------------------------------

// PromoRepository is the persistence seam of PromoService.
type PromoRepository interface {
	ListPromoCodes(ctx context.Context) ([]database.PromoCodeRow, error)
	GetPromoCode(ctx context.Context, id uint) (*database.PromoCode, error)
	CreatePromoCode(ctx context.Context, meta database.AdminConfigMeta, in database.PromoInput) (*database.AdminConfigResult, error)
	UpdatePromoCode(ctx context.Context, meta database.AdminConfigMeta, in database.PromoUpdate) (*database.AdminConfigResult, error)
	DeletePromoCode(ctx context.Context, meta database.AdminConfigMeta, id uint, version int) (*database.AdminConfigResult, error)
}

var _ PromoRepository = (*database.Service)(nil)

// PromoService is the browser-admin boundary of the promo codes. Callers
// authorize the actor first.
type PromoService struct {
	repo PromoRepository
	now  func() time.Time
}

// NewPromoService wires the promo code boundary.
func NewPromoService(repo PromoRepository) *PromoService {
	return &PromoService{repo: repo, now: time.Now}
}

// PromoView is the admin projection of a promo code.
type PromoView struct {
	database.PromoCode

	Redeemed int64 `json:"redeemed"`
	// State: active | disabled | expired | exhausted.
	State string `json:"state"`
}

func promoState(c *database.PromoCode, now time.Time) string {
	switch {
	case !c.Enabled:
		return "disabled"
	case c.ExpiresAt != nil && !c.ExpiresAt.After(now):
		return "expired"
	case c.MaxActivations > 0 && c.Activations >= c.MaxActivations:
		return "exhausted"
	}
	return "active"
}

// PromoOutcome is returned by every promo mutation, including replays.
type PromoOutcome struct {
	Promo    *PromoView             `json:"promo"`
	Replayed bool                   `json:"replayed"`
	Audit    database.AdminAuditLog `json:"audit"`
}

// List returns every promo code, newest first.
func (s *PromoService) List(ctx context.Context) ([]PromoView, error) {
	rows, err := s.repo.ListPromoCodes(ctx)
	if err != nil {
		return nil, err
	}
	now := s.now().UTC()
	views := make([]PromoView, 0, len(rows))
	for i := range rows {
		views = append(views, PromoView{PromoCode: rows[i].PromoCode, Redeemed: rows[i].Redeemed, State: promoState(&rows[i].PromoCode, now)})
	}
	return views, nil
}

func (s *PromoService) outcome(ctx context.Context, result *database.AdminConfigResult) (*PromoOutcome, error) {
	out := &PromoOutcome{Replayed: result.Replayed, Audit: result.Audit}
	code, err := s.repo.GetPromoCode(ctx, result.TargetID)
	switch {
	case err == nil:
		out.Promo = &PromoView{PromoCode: *code, State: promoState(code, s.now().UTC())}
	case errors.Is(err, database.ErrPromoNotFound) && result.Replayed:
		// Replay of a request whose code has been deleted since.
	default:
		return out, fmt.Errorf("reload promo code: %w", err)
	}
	return out, nil
}

// Create creates a promo code. The code is normalized to upper case.
func (s *PromoService) Create(ctx context.Context, actor, requestKey string, in database.PromoInput) (*PromoOutcome, error) {
	in.Code = database.NormalizePromoCode(in.Code)
	in.Note = strings.TrimSpace(in.Note)
	result, err := s.repo.CreatePromoCode(ctx, database.AdminConfigMeta{Actor: actor, RequestKey: requestKey}, in)
	if err != nil {
		return nil, err
	}
	return s.outcome(ctx, result)
}

// Update edits limits, validity, note and the enabled flag of a code.
func (s *PromoService) Update(ctx context.Context, actor, requestKey string, in database.PromoUpdate) (*PromoOutcome, error) {
	in.Note = strings.TrimSpace(in.Note)
	result, err := s.repo.UpdatePromoCode(ctx, database.AdminConfigMeta{Actor: actor, RequestKey: requestKey}, in)
	if err != nil {
		return nil, err
	}
	return s.outcome(ctx, result)
}

// Delete deletes a code nobody activated.
func (s *PromoService) Delete(ctx context.Context, actor, requestKey string, id uint, version int) (*PromoOutcome, error) {
	result, err := s.repo.DeletePromoCode(ctx, database.AdminConfigMeta{Actor: actor, RequestKey: requestKey}, id, version)
	if err != nil {
		return nil, err
	}
	return &PromoOutcome{Replayed: result.Replayed, Audit: result.Audit}, nil
}
