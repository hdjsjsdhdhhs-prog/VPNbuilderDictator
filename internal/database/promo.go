package database

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/hdjsjsdhdhhs-prog/VPNbuilderDictator/internal/logger"
	"go.uber.org/zap"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// Promo codes and discounts (migration 053).
//
// A promo code is created by the admin; a user activates it in the bot. A
// warm-up coupon is a personal code issued with a warm-up message; the user
// activates it with one button (or types it like a promo code). Both produce
// a UserDiscount: the best unredeemed, unexpired discount of a user lowers the
// price of the next purchase, and the order paid with it redeems it.
//
// A free tariff (Product.PriceCents == 0) or a 100 % discount needs no
// payment provider: ActivateFreeOrder creates an order with amount 0 and
// confirms it through the same CAS as a paid order.

// FreeProvider is orders.payment_provider of an order activated without payment.
const FreeProvider = "free"

// Discount sources.
const (
	DiscountSourcePromo  = "promo"
	DiscountSourceWarmup = "warmup"
)

// Audited promo actions.
const (
	AdminActionPromoCreated AdminAction = "promo_created"
	AdminActionPromoUpdated AdminAction = "promo_updated"
	AdminActionPromoDeleted AdminAction = "promo_deleted"
)

// AdminTargetPromo is the audit target type of a promo code.
const AdminTargetPromo = "promo"

// Promo rejections. Activation errors are shown to the user as-is (mapped to
// text by the bot); admin errors are mapped to stable API codes.
var (
	ErrPromoNotFound        = errors.New("promo code not found")
	ErrPromoDisabled        = errors.New("promo code is disabled")
	ErrPromoExpired         = errors.New("promo code has expired")
	ErrPromoExhausted       = errors.New("promo code activation limit reached")
	ErrPromoAlreadyUsed     = errors.New("promo code already activated by this user")
	ErrPromoInvalid         = errors.New("promo code is invalid")
	ErrPromoCodeTaken       = errors.New("promo code is already used")
	ErrPromoVersionConflict = errors.New("promo code was changed concurrently")
	ErrPromoInUse           = errors.New("promo code has activations")

	// ErrFreeActivationUnavailable and the two errors after it are the free
	// activation rejections.
	ErrFreeActivationUnavailable = errors.New("free activation is not available")
	ErrFreeTariffActive          = errors.New("free tariff is already active")
	ErrFreeTariffHasPaid         = errors.New("a paid subscription is active")
)

// Promo input bounds.
const (
	PromoMaxActivations = 1_000_000
	PromoMaxValidHours  = 8760
	PromoMaxNoteLength  = 200
)

var promoCodePattern = regexp.MustCompile(`^[A-Z0-9][A-Z0-9_-]{2,31}$`)

// NormalizePromoCode is the canonical form of a typed code.
func NormalizePromoCode(raw string) string {
	return strings.ToUpper(strings.TrimSpace(raw))
}

// PromoCode is an admin-created discount code.
type PromoCode struct {
	ID             uint       `gorm:"primaryKey;column:id"            json:"id"`
	Code           string     `gorm:"not null;column:code"            json:"code"`
	Percent        int        `gorm:"not null;column:percent"         json:"percent"`
	MaxActivations int        `gorm:"not null;column:max_activations" json:"max_activations"`
	Activations    int        `gorm:"not null;column:activations"     json:"activations"`
	ValidHours     int        `gorm:"not null;column:valid_hours"     json:"valid_hours"`
	ExpiresAt      *time.Time `gorm:"column:expires_at"               json:"expires_at"`
	Enabled        bool       `gorm:"not null;column:enabled"         json:"enabled"`
	Note           string     `gorm:"not null;column:note"            json:"note"`
	Version        int        `gorm:"not null;column:version"         json:"version"`
	CreatedAt      time.Time  `gorm:"not null;column:created_at"      json:"created_at"`
	UpdatedAt      time.Time  `gorm:"not null;column:updated_at"      json:"updated_at"`
}

func (PromoCode) TableName() string { return "promo_codes" }

// UserDiscount is a discount a user activated.
type UserDiscount struct {
	ID             uint       `gorm:"primaryKey;column:id"         json:"id"`
	TelegramID     int64      `gorm:"not null;column:telegram_id"  json:"telegram_id"`
	Source         string     `gorm:"not null;column:source"       json:"source"`
	PromoCodeID    *uint      `gorm:"column:promo_code_id"         json:"promo_code_id"`
	WarmupCouponID *uint      `gorm:"column:warmup_coupon_id"      json:"warmup_coupon_id"`
	Code           string     `gorm:"not null;column:code"         json:"code"`
	Percent        int        `gorm:"not null;column:percent"      json:"percent"`
	ActivatedAt    time.Time  `gorm:"not null;column:activated_at" json:"activated_at"`
	ExpiresAt      time.Time  `gorm:"not null;column:expires_at"   json:"expires_at"`
	RedeemedAt     *time.Time `gorm:"column:redeemed_at"           json:"redeemed_at"`
	OrderID        *uint      `gorm:"column:order_id"              json:"order_id"`
}

func (UserDiscount) TableName() string { return "user_discounts" }

// DiscountedAmount is the amount to pay for a price with a percent discount.
// The discount is rounded down, so the customer never pays less than the
// exact discounted price; 100 % is free.
func DiscountedAmount(priceCents int64, percent int) int64 {
	if percent <= 0 || priceCents <= 0 {
		return priceCents
	}
	if percent >= 100 {
		return 0
	}
	return priceCents - priceCents*int64(percent)/100
}

// PromoInput is the content of a new promo code. Code must be normalized.
type PromoInput struct {
	Code           string     `json:"code"`
	Percent        int        `json:"percent"`
	MaxActivations int        `json:"max_activations"`
	ValidHours     int        `json:"valid_hours"`
	ExpiresAt      *time.Time `json:"expires_at"`
	Enabled        bool       `json:"enabled"`
	Note           string     `json:"note"`
}

// PromoFieldError names the invalid field. It unwraps to ErrPromoInvalid.
type PromoFieldError struct{ Field string }

func (e *PromoFieldError) Error() string { return ErrPromoInvalid.Error() + ": " + e.Field }
func (e *PromoFieldError) Unwrap() error { return ErrPromoInvalid }

func invalidPromo(field string) error { return &PromoFieldError{Field: field} }

func validatePromoLimits(maxActivations, validHours int, note string) error {
	switch {
	case maxActivations < 0 || maxActivations > PromoMaxActivations:
		return invalidPromo("max_activations")
	case validHours < 1 || validHours > PromoMaxValidHours:
		return invalidPromo("valid_hours")
	case utf8.RuneCountInString(note) > PromoMaxNoteLength || !utf8.ValidString(note):
		return invalidPromo("note")
	}
	return nil
}

// Validate checks the static bounds of a new code.
func (in PromoInput) Validate(now time.Time) error {
	switch {
	case !promoCodePattern.MatchString(in.Code):
		return invalidPromo("code")
	case in.Percent < 1 || in.Percent > 100:
		return invalidPromo("percent")
	case in.ExpiresAt != nil && !in.ExpiresAt.After(now):
		return invalidPromo("expires_at")
	}
	return validatePromoLimits(in.MaxActivations, in.ValidHours, in.Note)
}

// PromoCodeRow is a promo code with its usage for the admin list.
type PromoCodeRow struct {
	PromoCode

	// Redeemed counts activations that paid an order.
	Redeemed int64 `json:"redeemed"`
}

// ListPromoCodes returns every promo code, newest first.
func (s *Service) ListPromoCodes(ctx context.Context) ([]PromoCodeRow, error) {
	var codes []PromoCode
	err := s.db.WithContext(ctx).Order("id DESC").Find(&codes).Error
	if err != nil {
		return nil, fmt.Errorf("list promo codes: %w", err)
	}
	var counts []struct {
		PromoCodeID uint
		N           int64
	}
	err = s.db.WithContext(ctx).Model(&UserDiscount{}).Select("promo_code_id, COUNT(*) AS n").
		Where("promo_code_id IS NOT NULL AND redeemed_at IS NOT NULL").Group("promo_code_id").Scan(&counts).Error
	if err != nil {
		return nil, fmt.Errorf("count promo redemptions: %w", err)
	}
	redeemed := make(map[uint]int64, len(counts))
	for _, c := range counts {
		redeemed[c.PromoCodeID] = c.N
	}
	rows := make([]PromoCodeRow, 0, len(codes))
	for _, c := range codes {
		rows = append(rows, PromoCodeRow{PromoCode: c, Redeemed: redeemed[c.ID]})
	}
	return rows, nil
}

// GetPromoCode returns one promo code.
func (s *Service) GetPromoCode(ctx context.Context, id uint) (*PromoCode, error) {
	var code PromoCode
	err := s.db.WithContext(ctx).First(&code, id).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrPromoNotFound
		}
		return nil, fmt.Errorf("get promo code: %w", err)
	}
	return &code, nil
}

// CreatePromoCode inserts a promo code. The code must not collide with another
// promo code or with a personal warm-up coupon.
func (s *Service) CreatePromoCode(ctx context.Context, meta AdminConfigMeta, in PromoInput) (*AdminConfigResult, error) {
	err := in.Validate(time.Now().UTC())
	if err != nil {
		return nil, err
	}
	return s.runAdminConfigMutation(ctx, meta, AdminActionPromoCreated, AdminTargetPromo, 0, in,
		func(tx *gorm.DB, now time.Time) (configChange, error) {
			var taken int64
			err := tx.Model(&PromoCode{}).Where("code = ?", in.Code).Count(&taken).Error
			if err != nil {
				return configChange{}, fmt.Errorf("check promo code: %w", err)
			}
			if taken == 0 {
				err := tx.Model(&WarmupCoupon{}).Where("code = ? COLLATE NOCASE", in.Code).Count(&taken).Error
				if err != nil {
					return configChange{}, fmt.Errorf("check coupon code: %w", err)
				}
			}
			if taken > 0 {
				return configChange{}, ErrPromoCodeTaken
			}
			code := PromoCode{
				Code: in.Code, Percent: in.Percent, MaxActivations: in.MaxActivations, ValidHours: in.ValidHours,
				Enabled: in.Enabled, Note: in.Note, Version: 1, CreatedAt: now, UpdatedAt: now,
			}
			if in.ExpiresAt != nil {
				expires := in.ExpiresAt.UTC()
				code.ExpiresAt = &expires
			}
			err = tx.Create(&code).Error
			if err != nil {
				return configChange{}, fmt.Errorf("create promo code: %w", err)
			}
			return configChange{targetID: code.ID, newValue: code}, nil
		})
}

// PromoUpdate changes the mutable part of a promo code. The code and its
// percent are fixed: users may already hold discounts issued from them.
type PromoUpdate struct {
	ID             uint       `json:"id"`
	Version        int        `json:"version"`
	MaxActivations int        `json:"max_activations"`
	ValidHours     int        `json:"valid_hours"`
	ExpiresAt      *time.Time `json:"expires_at"`
	Enabled        bool       `json:"enabled"`
	Note           string     `json:"note"`
}

// UpdatePromoCode edits limits, validity, note and the enabled flag.
func (s *Service) UpdatePromoCode(ctx context.Context, meta AdminConfigMeta, in PromoUpdate) (*AdminConfigResult, error) {
	if in.ID == 0 || in.Version <= 0 {
		return nil, fmt.Errorf("%w: id/version", ErrAdminInvalidRequest)
	}
	err := validatePromoLimits(in.MaxActivations, in.ValidHours, in.Note)
	if err != nil {
		return nil, err
	}
	return s.runAdminConfigMutation(ctx, meta, AdminActionPromoUpdated, AdminTargetPromo, in.ID, in,
		func(tx *gorm.DB, now time.Time) (configChange, error) {
			var current PromoCode
			err := tx.First(&current, in.ID).Error
			if err != nil {
				if errors.Is(err, gorm.ErrRecordNotFound) {
					return configChange{}, ErrPromoNotFound
				}
				return configChange{}, fmt.Errorf("load promo code: %w", err)
			}
			var expires any
			if in.ExpiresAt != nil {
				expires = in.ExpiresAt.UTC()
			}
			update := tx.Model(&PromoCode{}).Where("id = ? AND version = ?", in.ID, in.Version).Updates(map[string]any{
				"max_activations": in.MaxActivations, "valid_hours": in.ValidHours, "expires_at": expires,
				"enabled": in.Enabled, "note": in.Note, "version": in.Version + 1, "updated_at": now,
			})
			if update.Error != nil {
				return configChange{}, fmt.Errorf("update promo code: %w", update.Error)
			}
			if update.RowsAffected == 0 {
				return configChange{}, ErrPromoVersionConflict
			}
			var saved PromoCode
			err = tx.First(&saved, in.ID).Error
			if err != nil {
				return configChange{}, fmt.Errorf("reload promo code: %w", err)
			}
			return configChange{targetID: saved.ID, oldValue: current, newValue: saved}, nil
		})
}

// DeletePromoCode physically deletes a code nobody activated. A code with
// activations is protected (ErrPromoInUse): disable it instead.
func (s *Service) DeletePromoCode(ctx context.Context, meta AdminConfigMeta, id uint, version int) (*AdminConfigResult, error) {
	if id == 0 || version <= 0 {
		return nil, fmt.Errorf("%w: id/version", ErrAdminInvalidRequest)
	}
	payload := struct {
		ID      uint `json:"id"`
		Version int  `json:"version"`
	}{id, version}
	return s.runAdminConfigMutation(ctx, meta, AdminActionPromoDeleted, AdminTargetPromo, id, payload,
		func(tx *gorm.DB, _ time.Time) (configChange, error) {
			var current PromoCode
			err := tx.First(&current, id).Error
			if err != nil {
				if errors.Is(err, gorm.ErrRecordNotFound) {
					return configChange{}, ErrPromoNotFound
				}
				return configChange{}, fmt.Errorf("load promo code: %w", err)
			}
			if current.Version != version {
				return configChange{}, ErrPromoVersionConflict
			}
			var used int64
			err = tx.Model(&UserDiscount{}).Where("promo_code_id = ?", id).Count(&used).Error
			if err != nil {
				return configChange{}, fmt.Errorf("count promo activations: %w", err)
			}
			if used > 0 || current.Activations > 0 {
				return configChange{}, ErrPromoInUse
			}
			res := tx.Where("id = ? AND version = ?", id, version).Delete(&PromoCode{})
			if res.Error != nil {
				return configChange{}, fmt.Errorf("delete promo code: %w", res.Error)
			}
			if res.RowsAffected == 0 {
				return configChange{}, ErrPromoVersionConflict
			}
			return configChange{targetID: id, oldValue: current, newValue: nil}, nil
		})
}

// ---------------------------------------------------------------------------
// User side
// ---------------------------------------------------------------------------

// ActiveUserDiscount returns the best usable discount of a user (highest
// percent, then the one expiring first), or nil when there is none.
func (s *Service) ActiveUserDiscount(ctx context.Context, telegramID int64, now time.Time) (*UserDiscount, error) {
	return activeUserDiscount(s.db.WithContext(ctx), telegramID, now)
}

func activeUserDiscount(tx *gorm.DB, telegramID int64, now time.Time) (*UserDiscount, error) {
	if telegramID <= 0 {
		return nil, nil
	}
	var d UserDiscount
	err := tx.Where("telegram_id = ? AND redeemed_at IS NULL AND expires_at > ?", telegramID, now.UTC()).
		Order("percent DESC, expires_at ASC, id ASC").First(&d).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("load user discount: %w", err)
	}
	return &d, nil
}

// isUniqueViolation reports a SQLite UNIQUE constraint failure.
func isUniqueViolation(err error) bool {
	return err != nil && strings.Contains(strings.ToLower(err.Error()), "unique constraint")
}

// ActivatePromoCode activates a typed code for a user: an admin promo code,
// or the user's own personal warm-up coupon. The result is the discount the
// code produced (not necessarily the user's best one).
func (s *Service) ActivatePromoCode(ctx context.Context, telegramID int64, raw string, now time.Time) (*UserDiscount, error) {
	code := NormalizePromoCode(raw)
	// Any short printable text is looked up (coupon prefixes are free-form);
	// promo codes themselves always match promoCodePattern.
	if telegramID <= 0 || len(code) < 3 || len(code) > 64 || !utf8.ValidString(code) {
		return nil, ErrPromoNotFound
	}
	now = now.UTC()
	var discount *UserDiscount
	err := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var promo PromoCode
		err := tx.Where("code = ?", code).First(&promo).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			// Not a promo code: a personal coupon typed by its owner (coupon
			// codes keep the case of their scenario prefix).
			var coupon WarmupCoupon
			err = tx.Where("code = ? COLLATE NOCASE AND telegram_id = ?", strings.TrimSpace(raw), telegramID).First(&coupon).Error
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrPromoNotFound
			}
			if err != nil {
				return fmt.Errorf("load coupon: %w", err)
			}
			discount, err = activateCoupon(tx, &coupon, now)
			return err
		}
		if err != nil {
			return fmt.Errorf("load promo code: %w", err)
		}
		switch {
		case !promo.Enabled:
			return ErrPromoDisabled
		case promo.ExpiresAt != nil && !promo.ExpiresAt.After(now):
			return ErrPromoExpired
		}
		var used int64
		err = tx.Model(&UserDiscount{}).Where("telegram_id = ? AND promo_code_id = ?", telegramID, promo.ID).Count(&used).Error
		if err != nil {
			return fmt.Errorf("check promo activation: %w", err)
		}
		if used > 0 {
			return ErrPromoAlreadyUsed
		}
		// The conditional increment is the limit guard: concurrent activations
		// of the last slot serialize on SQLite's writer lock.
		claim := tx.Model(&PromoCode{}).
			Where("id = ? AND enabled = ? AND (max_activations = 0 OR activations < max_activations)", promo.ID, true).
			UpdateColumn("activations", gorm.Expr("activations + 1"))
		if claim.Error != nil {
			return fmt.Errorf("claim promo activation: %w", claim.Error)
		}
		if claim.RowsAffected == 0 {
			return ErrPromoExhausted
		}
		promoID := promo.ID
		d := UserDiscount{
			TelegramID: telegramID, Source: DiscountSourcePromo, PromoCodeID: &promoID, Code: promo.Code,
			Percent: promo.Percent, ActivatedAt: now, ExpiresAt: now.Add(time.Duration(promo.ValidHours) * time.Hour),
		}
		err = tx.Create(&d).Error
		if err != nil {
			if isUniqueViolation(err) {
				return ErrPromoAlreadyUsed
			}
			return fmt.Errorf("create user discount: %w", err)
		}
		discount = &d
		return nil
	})
	if err != nil {
		return nil, err
	}
	return discount, nil
}

// activateCoupon turns a personal warm-up coupon into a discount. Activating
// it again returns the existing, still usable discount (idempotent button).
func activateCoupon(tx *gorm.DB, coupon *WarmupCoupon, now time.Time) (*UserDiscount, error) {
	var existing UserDiscount
	err := tx.Where("warmup_coupon_id = ?", coupon.ID).First(&existing).Error
	switch {
	case err == nil:
		if existing.RedeemedAt != nil {
			return nil, ErrPromoAlreadyUsed
		}
		if !existing.ExpiresAt.After(now) {
			return nil, ErrPromoExpired
		}
		return &existing, nil
	case !errors.Is(err, gorm.ErrRecordNotFound):
		return nil, fmt.Errorf("load coupon discount: %w", err)
	}
	switch coupon.EffectiveStatus(now) {
	case WarmupCouponIssued:
	case WarmupCouponExpired:
		return nil, ErrPromoExpired
	case WarmupCouponRedeemed:
		return nil, ErrPromoAlreadyUsed
	default:
		return nil, ErrPromoDisabled
	}
	couponID := coupon.ID
	d := UserDiscount{
		TelegramID: coupon.TelegramID, Source: DiscountSourceWarmup, WarmupCouponID: &couponID, Code: coupon.Code,
		Percent: coupon.Percent, ActivatedAt: now, ExpiresAt: coupon.ExpiresAt.UTC(),
	}
	err = tx.Create(&d).Error
	if err != nil {
		if isUniqueViolation(err) {
			return nil, ErrPromoAlreadyUsed
		}
		return nil, fmt.Errorf("create coupon discount: %w", err)
	}
	return &d, nil
}

// ActivateWarmupCoupon is the one-click button of a warm-up message: it
// activates the user's best valid personal coupon and returns the user's best
// discount. ErrPromoNotFound when the user holds no usable coupon.
func (s *Service) ActivateWarmupCoupon(ctx context.Context, telegramID int64, now time.Time) (*UserDiscount, error) {
	if telegramID <= 0 {
		return nil, ErrPromoNotFound
	}
	now = now.UTC()
	var discount *UserDiscount
	err := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var coupons []WarmupCoupon
		err := tx.Where("telegram_id = ? AND status = ? AND expires_at > ?", telegramID, WarmupCouponIssued, now).
			Order("percent DESC, expires_at ASC, id ASC").Find(&coupons).Error
		if err != nil {
			return fmt.Errorf("load coupons: %w", err)
		}
		for i := range coupons {
			_, err := activateCoupon(tx, &coupons[i], now)
			if err == nil {
				break
			}
			// A used or expired coupon is skipped; anything else is a failure.
			if !errors.Is(err, ErrPromoAlreadyUsed) && !errors.Is(err, ErrPromoExpired) && !errors.Is(err, ErrPromoDisabled) {
				return err
			}
		}
		best, err := activeUserDiscount(tx, telegramID, now)
		if err != nil {
			return err
		}
		if best == nil {
			return ErrPromoNotFound
		}
		discount = best
		return nil
	})
	if err != nil {
		return nil, err
	}
	return discount, nil
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

// ExpirePendingPaymentOrder terminalizes a pending provider intent whose
// amount no longer matches the price the customer should pay (a discount was
// activated or used up). The provider link deadline stays untouched, so a
// payment made on the old link is still settled inside the usual grace.
// An intent with an uncertain provider outcome is never released.
func (s *Service) ExpirePendingPaymentOrder(ctx context.Context, orderID uint) (bool, error) {
	result := s.db.WithContext(ctx).Model(&Order{}).
		Where("id = ? AND status = ? AND payment_creation_uncertain = ?", orderID, OrderStatusPending, false).
		Update("status", OrderStatusExpired)
	if result.Error != nil {
		return false, fmt.Errorf("expire payment order: %w", result.Error)
	}
	return result.RowsAffected == 1, nil
}

// OrderDiscount is the discount an order was created with: one row per
// discounted order. Order.AmountCents is the amount to be paid;
// ListAmountCents is the catalogue price before the discount. It is a table
// of its own so that the orders schema, and the code that writes orders, is
// the same on every schema version.
type OrderDiscount struct {
	OrderID         uint      `gorm:"primaryKey;autoIncrement:false;column:order_id" json:"order_id"`
	UserDiscountID  uint      `gorm:"not null;column:user_discount_id"               json:"user_discount_id"`
	Percent         int       `gorm:"not null;column:discount_percent"               json:"discount_percent"`
	ListAmountCents int64     `gorm:"not null;column:list_amount_cents"              json:"list_amount_cents"`
	CreatedAt       time.Time `gorm:"not null;column:created_at"                     json:"created_at"`
}

func (OrderDiscount) TableName() string { return "order_discounts" }

// SetOrderDiscount records the discount a pending order is to be paid with.
// It is idempotent: a reused intent is re-pointed at the customer's current
// discount (the one of the same amount), so that one is redeemed by the
// payment. An order that is no longer pending is left untouched.
func (s *Service) SetOrderDiscount(ctx context.Context, orderID uint, discount *UserDiscount, listAmountCents int64) error {
	if discount == nil {
		return nil
	}
	err := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var pending int64
		err := tx.Model(&Order{}).Where("id = ? AND status = ?", orderID, OrderStatusPending).Count(&pending).Error
		if err != nil {
			return err
		}
		if pending == 0 {
			return nil
		}
		row := OrderDiscount{
			OrderID: orderID, UserDiscountID: discount.ID, Percent: discount.Percent,
			ListAmountCents: listAmountCents, CreatedAt: time.Now().UTC(),
		}
		return tx.Clauses(clause.OnConflict{
			Columns:   []clause.Column{{Name: "order_id"}},
			DoUpdates: clause.AssignmentColumns([]string{"user_discount_id", "discount_percent", "list_amount_cents"}),
		}).Create(&row).Error
	})
	if err != nil {
		return fmt.Errorf("set order discount: %w", err)
	}
	return nil
}

// GetOrderDiscount returns the discount an order was created with, nil when
// it was created at the catalogue price.
func (s *Service) GetOrderDiscount(ctx context.Context, orderID uint) (*OrderDiscount, error) {
	return orderDiscount(s.db.WithContext(ctx), orderID)
}

func orderDiscount(tx *gorm.DB, orderID uint) (*OrderDiscount, error) {
	var rows []OrderDiscount
	err := tx.Where("order_id = ?", orderID).Limit(1).Find(&rows).Error
	if err != nil {
		return nil, fmt.Errorf("load order discount: %w", err)
	}
	if len(rows) == 0 {
		return nil, nil
	}
	return &rows[0], nil
}

// redeemOrderDiscount marks the discount of a just-paid order as used (and
// its warm-up coupon as redeemed). Best-effort inside the payment
// transaction: a failure is logged and never blocks the payment.
func redeemOrderDiscount(tx *gorm.DB, orderID uint, now time.Time) {
	applied, err := orderDiscount(tx, orderID)
	if err != nil {
		logger.Warn("failed to load order discount", zap.Uint("order_id", orderID), zap.Error(err))
		return
	}
	if applied == nil {
		return
	}
	var d UserDiscount
	err = tx.First(&d, applied.UserDiscountID).Error
	if err != nil {
		logger.Warn("failed to load order discount", zap.Uint("order_id", orderID), zap.Error(err))
		return
	}
	err = tx.Model(&UserDiscount{}).Where("id = ? AND redeemed_at IS NULL", d.ID).
		Updates(map[string]any{"redeemed_at": now, "order_id": orderID}).Error
	if err != nil {
		logger.Warn("failed to redeem order discount", zap.Uint("order_id", orderID), zap.Error(err))
		return
	}
	if d.WarmupCouponID != nil {
		err = tx.Model(&WarmupCoupon{}).Where("id = ? AND status = ?", *d.WarmupCouponID, WarmupCouponIssued).
			Updates(map[string]any{"status": WarmupCouponRedeemed, "redeemed_at": now, "order_id": orderID}).Error
		if err != nil {
			logger.Warn("failed to redeem warmup coupon", zap.Uint("order_id", orderID), zap.Error(err))
		}
	}
}

// FreeActivation is the result of ActivateFreeOrder.
type FreeActivation struct {
	Order        *Order
	Subscription *Subscription
	Product      *Product
	// Discount is the 100 % discount that paid for the order; nil for a free
	// tariff.
	Discount *OrderDiscount
	// Renewal: the subscription already held a term of the same plan.
	Renewal bool
}

// ActivateFreeOrder grants a product without payment, in one transaction:
//
//   - a free tariff (price 0): no discount is consumed. It is refused while
//     the same tariff is still running (no stacking of free terms) and while a
//     paid term is active (a free tariff never replaces paid access);
//   - a paid tariff with the user's 100 % discount: the discount is redeemed.
//
// Anything else is ErrFreeActivationUnavailable. The order is confirmed with
// the same CAS as a paid order, so the journal and the entitlement are
// identical to a purchase.
func (s *Service) ActivateFreeOrder(ctx context.Context, telegramID int64, productID uint, now time.Time) (*FreeActivation, error) {
	if telegramID <= 0 || productID == 0 {
		return nil, ErrFreeActivationUnavailable
	}
	now = now.UTC()
	var out FreeActivation
	err := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		claim := tx.Model(&Subscription{}).Where("telegram_id = ? AND status = ?", telegramID, string(SubscriptionStatusActive)).
			UpdateColumn("id", gorm.Expr("id"))
		if claim.Error != nil {
			return fmt.Errorf("lock subscription: %w", claim.Error)
		}
		if claim.RowsAffected == 0 {
			return ErrSubscriptionNotFound
		}
		var sub Subscription
		err := tx.Where("telegram_id = ? AND status = ?", telegramID, string(SubscriptionStatusActive)).First(&sub).Error
		if err != nil {
			return fmt.Errorf("load subscription: %w", err)
		}
		var product Product
		err = tx.Preload("Plan").First(&product, productID).Error
		if err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrProductNotFound
			}
			return fmt.Errorf("load product: %w", err)
		}
		if !product.IsActive || product.PriceCents < 0 || product.Plan == nil || !product.Plan.IsActive ||
			product.Plan.SubscriptionBuilderID == nil || product.Plan.Name == TrialPlanName || product.Plan.Name == FreePlanName ||
			product.DurationDays <= 0 || product.DurationDays > MaxSubscriptionRenewalDays {
			return ErrFreeActivationUnavailable
		}

		var discount *UserDiscount
		if product.PriceCents == 0 {
			running := sub.ExpiresAt != nil && sub.ExpiresAt.After(now)
			if running && sub.ProductID != nil && *sub.ProductID == product.ID {
				return ErrFreeTariffActive
			}
			if running && sub.PricePaidCents > 0 {
				return ErrFreeTariffHasPaid
			}
		} else {
			best, err := activeUserDiscount(tx, telegramID, now)
			if err != nil {
				return err
			}
			if best == nil || DiscountedAmount(product.PriceCents, best.Percent) != 0 {
				return ErrFreeActivationUnavailable
			}
			discount = best
		}

		order := Order{
			SubscriptionID: sub.ID, ProductID: product.ID, Status: OrderStatusPending, AmountCents: 0,
			Currency: product.Currency, PaymentProvider: FreeProvider, CreatedAt: now,
		}
		err = tx.Create(&order).Error
		if err != nil {
			return fmt.Errorf("create free order: %w", err)
		}
		if discount != nil {
			// Recorded before the confirmation, which redeems it.
			applied := OrderDiscount{
				OrderID: order.ID, UserDiscountID: discount.ID, Percent: discount.Percent,
				ListAmountCents: product.PriceCents, CreatedAt: now,
			}
			err := tx.Create(&applied).Error
			if err != nil {
				return fmt.Errorf("record free order discount: %w", err)
			}
			out.Discount = &applied
		}
		out.Renewal = sub.PlanID == product.PlanID && (sub.ProductID != nil || sub.PricePaidCents > 0)
		// The entitlement snapshot records what was actually paid: nothing.
		granted := product
		granted.PriceCents = 0
		payments := &Service{db: tx}
		activated, err := payments.ConfirmOrderPaidCAS(ctx, order.ID, now, now, &sub, &granted, 0)
		if err != nil {
			return err
		}
		if !activated {
			return ErrFreeActivationUnavailable
		}
		err = tx.First(&order, order.ID).Error
		if err != nil {
			return fmt.Errorf("reload free order: %w", err)
		}
		err = tx.First(&sub, sub.ID).Error
		if err != nil {
			return fmt.Errorf("reload subscription: %w", err)
		}
		out.Order, out.Subscription, out.Product = &order, &sub, &product
		return nil
	})
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// ListFreeProducts returns the active free tariffs (price 0) of active plans
// that have a builder, in catalogue order.
func (s *Service) ListFreeProducts(ctx context.Context) ([]Product, error) {
	var products []Product
	err := s.db.WithContext(ctx).Table("products").Select("products.*").
		Joins("JOIN plans ON plans.id = products.plan_id").
		Where("products.is_active = ? AND products.price_cents = ? AND plans.is_active = ? AND plans.subscription_builder_id IS NOT NULL", true, 0, true).
		Where("plans.name NOT IN ?", []string{TrialPlanName, FreePlanName}).
		Order(ProductCatalogOrder).Find(&products).Error
	if err != nil {
		return nil, fmt.Errorf("list free products: %w", err)
	}
	return products, nil
}
