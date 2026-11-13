package bot

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/hdjsjsdhdhhs-prog/VPNbuilderDictator/internal/database"
	"github.com/hdjsjsdhdhhs-prog/VPNbuilderDictator/internal/logger"
	"github.com/hdjsjsdhdhhs-prog/VPNbuilderDictator/internal/utils"

	tgbotapi "github.com/go-telegram-bot-api/telegram-bot-api/v5"
	"go.uber.org/zap"
)

// Promo codes, discounts and free tariffs in the purchase menu.
//
// A customer lowers the price with a promo code (typed after "🎟 Промокод" or
// sent as /promo CODE) or with the personal coupon of a warm-up message (one
// button, callback apply_discount). The tariff list then shows the price for
// this customer; a tariff that costs nothing is granted without a payment.

// promoPromptTTL is how long the bot waits for the code after "🎟 Промокод".
const promoPromptTTL = 10 * time.Minute

// promoPrompts remembers who was asked to send a code (chat ID -> deadline).
type promoPrompts struct {
	mu      sync.Mutex
	waiting map[int64]time.Time
}

func (p *promoPrompts) open(chatID int64, now time.Time) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.waiting == nil {
		p.waiting = make(map[int64]time.Time)
	}
	// Opportunistic cleanup keeps the map bounded by the active prompts.
	for id, deadline := range p.waiting {
		if !now.Before(deadline) {
			delete(p.waiting, id)
		}
	}
	p.waiting[chatID] = now.Add(promoPromptTTL)
}

// take reports whether a code is awaited from the chat and closes the prompt.
func (p *promoPrompts) take(chatID int64, now time.Time) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	deadline, ok := p.waiting[chatID]
	if !ok {
		return false
	}
	delete(p.waiting, chatID)
	return now.Before(deadline)
}

func (p *promoPrompts) close(chatID int64) {
	p.mu.Lock()
	defer p.mu.Unlock()
	delete(p.waiting, chatID)
}

// promoErrorText maps an activation rejection to the customer's text.
func promoErrorText(err error) string {
	switch {
	case errors.Is(err, database.ErrPromoNotFound):
		return "❌ Такого промокода нет. Проверьте код и отправьте его ещё раз."
	case errors.Is(err, database.ErrPromoDisabled):
		return "❌ Этот промокод больше не действует."
	case errors.Is(err, database.ErrPromoExpired):
		return "❌ Срок действия промокода закончился."
	case errors.Is(err, database.ErrPromoExhausted):
		return "❌ Промокод уже использован максимальное число раз."
	case errors.Is(err, database.ErrPromoAlreadyUsed):
		return "❌ Вы уже использовали этот промокод."
	default:
		return msg(MsgSubTempError)
	}
}

// discountLine describes the customer's active discount.
func discountLine(d *database.UserDiscount) string {
	if d == nil {
		return ""
	}
	return fmt.Sprintf("🎟 Ваша скидка *%d%%* действует до %s (МСК).", d.Percent, utils.FormatDateRu(d.ExpiresAt))
}

// tariffOffers is the purchase menu of a customer: paid tariffs (when the
// payment provider is on) and free tariffs, in catalogue order, each with the
// amount this customer pays.
func (sh *SubscriptionHandler) tariffOffers(ctx context.Context, chatID int64) ([]TariffOffer, *database.UserDiscount, error) {
	h := sh.h
	if h.orderService == nil {
		return nil, nil, nil
	}
	var products []database.Product
	if h.paymentEnabled {
		paid, err := h.db.ListActiveProducts(ctx)
		if err != nil {
			return nil, nil, fmt.Errorf("list active products: %w", err)
		}
		// XTR checkout belongs to the Mini App purchase flow, never to the
		// external provider of this menu.
		for _, product := range paid {
			if product.Currency != "XTR" {
				products = append(products, product)
			}
		}
	}
	free, err := h.orderService.FreeProducts(ctx)
	if err != nil {
		return nil, nil, fmt.Errorf("list free products: %w", err)
	}
	products = append(products, free...)
	sort.SliceStable(products, func(i, j int) bool {
		a, b := products[i], products[j]
		if a.SortOrder != b.SortOrder {
			return a.SortOrder < b.SortOrder
		}
		if a.PriceCents != b.PriceCents {
			return a.PriceCents < b.PriceCents
		}
		return a.ID < b.ID
	})

	discount, err := h.orderService.ActiveDiscount(ctx, chatID)
	if err != nil {
		// The menu still works at catalogue prices.
		logger.Warn("load customer discount failed", zap.Int64("chat_id", chatID), zap.Error(err))
		discount = nil
	}
	offers := make([]TariffOffer, 0, len(products))
	for _, product := range products {
		amount := product.PriceCents
		if discount != nil {
			amount = database.DiscountedAmount(product.PriceCents, discount.Percent)
		}
		offers = append(offers, TariffOffer{Product: product, AmountCents: amount})
	}
	return offers, discount, nil
}

// showTariffList renders the purchase menu, optionally under a notice line
// (the result of a promo code or coupon activation).
func (sh *SubscriptionHandler) showTariffList(ctx context.Context, chatID int64, messageID int, notice string) error {
	offers, discount, err := sh.tariffOffers(ctx, chatID)
	if err != nil {
		logger.Warn("tariff list failed", zap.Int64("chat_id", chatID), zap.Error(err))
		return sh.showBuyError(chatID, messageID, msg(MsgSubTempError))
	}
	if len(offers) == 0 {
		text := "❌ Нет доступных тарифов"
		if sh.h.orderService == nil || !sh.h.paymentEnabled {
			text = "❌ Платежи временно недоступны"
		}
		if notice != "" {
			text = notice + "\n\n" + text
		}
		return sh.showBuyError(chatID, messageID, text)
	}

	parts := make([]string, 0, 3)
	if notice != "" {
		parts = append(parts, notice)
	}
	parts = append(parts, msg(MsgPremiumBenefits))
	if line := discountLine(discount); line != "" {
		parts = append(parts, line+"\nЦены ниже уже со скидкой.")
	}
	keyboard := sh.h.keyboards.TariffList(offers)
	sh.editOrSend(chatID, messageID, strings.Join(parts, "\n\n"), tgbotapi.ModeMarkdown, &keyboard)

	return nil
}

// editOrSend edits the message when there is one to edit, otherwise sends a
// new one (a typed promo code has no bot message to edit).
func (sh *SubscriptionHandler) editOrSend(chatID int64, messageID int, text, parseMode string, keyboard *tgbotapi.InlineKeyboardMarkup) {
	if messageID > 0 {
		edit := tgbotapi.NewEditMessageText(chatID, messageID, text)
		edit.ParseMode = parseMode
		edit.DisableWebPagePreview = true
		edit.ReplyMarkup = keyboard
		sh.h.safeSend(edit)

		return
	}
	message := tgbotapi.NewMessage(chatID, text)
	message.ParseMode = parseMode
	message.DisableWebPagePreview = true
	if keyboard != nil {
		message.ReplyMarkup = *keyboard
	}
	sh.h.safeSend(message)
}

// showFreeConfirm asks to confirm a tariff that costs nothing.
func (sh *SubscriptionHandler) showFreeConfirm(chatID int64, messageID int, product *database.Product, discount *database.UserDiscount) {
	reason := "Этот тариф бесплатный."
	if discount != nil {
		reason = fmt.Sprintf("Ваша скидка %d%% полностью покрывает стоимость.", discount.Percent)
	}
	text := fmt.Sprintf("Тариф: 💎 *%s*\nСрок: *%d дн.*\n\n%s Оплата не требуется.\n\nНажмите «Получить бесплатно», чтобы активировать тариф.",
		utils.EscapeMarkdown(product.Name), product.DurationDays, reason)
	keyboard := sh.h.keyboards.TariffGetFree(product.ID)
	sh.editOrSend(chatID, messageID, text, tgbotapi.ModeMarkdown, &keyboard)
}

// handleGetFree grants a tariff that costs nothing (callback get_free_{id}).
func (sh *SubscriptionHandler) handleGetFree(ctx context.Context, chatID int64, username string, messageID int, productID uint) error {
	h := sh.h
	if h.orderService == nil {
		return sh.showBuyError(chatID, messageID, "❌ Тариф недоступен")
	}
	// One activation at a time per customer (double click).
	if _, loaded := h.inProgressSyncMap.LoadOrStore(chatID, true); loaded {
		return nil
	}
	defer h.inProgressSyncMap.Delete(chatID)

	activation, err := h.orderService.ActivateFree(ctx, chatID, username, productID)
	if err != nil {
		switch {
		case errors.Is(err, database.ErrFreeTariffActive):
			return sh.showBuyError(chatID, messageID, "✅ Этот тариф у вас уже активен. Получить его снова можно после окончания срока.")
		case errors.Is(err, database.ErrFreeTariffHasPaid):
			return sh.showBuyError(chatID, messageID, "ℹ️ У вас действует платная подписка. Бесплатный тариф можно получить после её окончания.")
		case errors.Is(err, database.ErrFreeActivationUnavailable), errors.Is(err, database.ErrProductNotFound):
			return sh.showBuyError(chatID, messageID, "❌ Тариф недоступен")
		}
		logger.Warn("free tariff activation failed", zap.Int64("chat_id", chatID), zap.Uint("product_id", productID), zap.Error(err))
		// User-initiated operation: the failure is surfaced, not swallowed.
		_ = sh.showBuyError(chatID, messageID, msg(MsgSubTempError))

		return fmt.Errorf("activate free tariff: %w", err)
	}

	sub := activation.Subscription
	h.cache.Set(chatID, sub)
	expiry := "—"
	if sub.ExpiresAt != nil {
		expiry = utils.FormatDateRu(*sub.ExpiresAt)
	}
	text := fmt.Sprintf("✅ Тариф *%s* активирован\n\n📅 Действует до: %s\n\n🔗 Ссылка на подписку\n`%s`\n\nОбновите подписку в приложении, чтобы получить изменения.",
		utils.EscapeMarkdown(activation.Product.Name), expiry, h.cfg.SubURL(sub.Token))
	keyboard := h.keyboards.Back()
	sh.editOrSend(chatID, messageID, text, tgbotapi.ModeMarkdown, &keyboard)

	return nil
}

// handlePromoEnter asks the customer to send the code (callback promo_enter).
func (sh *SubscriptionHandler) handlePromoEnter(ctx context.Context, chatID int64, messageID int) error {
	h := sh.h
	if h.orderService == nil {
		return sh.showBuyError(chatID, messageID, "❌ Промокоды сейчас недоступны")
	}
	h.promoPrompts.open(chatID, time.Now())
	text := "🎟 *Промокод*\n\nОтправьте код одним сообщением — скидка применится к ценам тарифов."
	discount, err := h.orderService.ActiveDiscount(ctx, chatID)
	if err == nil && discount != nil {
		text += "\n\n" + discountLine(discount)
	}
	keyboard := h.keyboards.PromoPrompt()
	sh.editOrSend(chatID, messageID, text, tgbotapi.ModeMarkdown, &keyboard)

	return nil
}

// handlePromoCode activates a code sent as text (after the prompt or with
// /promo CODE) and shows the tariff list with the new prices.
func (sh *SubscriptionHandler) handlePromoCode(ctx context.Context, chatID int64, code string) error {
	h := sh.h
	if h.orderService == nil {
		h.SendMessage(ctx, chatID, "❌ Промокоды сейчас недоступны")
		return nil
	}
	discount, err := h.orderService.ActivatePromo(ctx, chatID, code)
	if err != nil {
		text := promoErrorText(err)
		keyboard := h.keyboards.PromoPrompt()
		sh.editOrSend(chatID, 0, text, "", &keyboard)
		if text == msg(MsgSubTempError) {
			return fmt.Errorf("activate promo code: %w", err)
		}
		// A wrong code may be retyped right away.
		h.promoPrompts.open(chatID, time.Now())

		return nil
	}

	return sh.showTariffList(ctx, chatID, 0, fmt.Sprintf("✅ Промокод принят: скидка *%d%%*.", discount.Percent))
}

// handleApplyDiscount is the one-click discount of a warm-up message
// (callback apply_discount): the personal coupon is activated and the tariff
// list opens with the lowered prices.
func (sh *SubscriptionHandler) handleApplyDiscount(ctx context.Context, chatID int64, messageID int) error {
	h := sh.h
	if h.orderService == nil {
		return sh.showBuyError(chatID, messageID, "❌ Скидка сейчас недоступна")
	}
	discount, err := h.orderService.ActivateCoupon(ctx, chatID)
	if err != nil {
		if errors.Is(err, database.ErrPromoNotFound) {
			return sh.showTariffList(ctx, chatID, messageID, "ℹ️ Скидка из этого сообщения уже использована или её срок закончился.")
		}
		logger.Warn("coupon activation failed", zap.Int64("chat_id", chatID), zap.Error(err))
		_ = sh.showBuyError(chatID, messageID, msg(MsgSubTempError))

		return fmt.Errorf("activate coupon: %w", err)
	}

	return sh.showTariffList(ctx, chatID, messageID, fmt.Sprintf("✅ Скидка *%d%%* применена.", discount.Percent))
}

// HandlePromo handles /promo [CODE].
func (h *Handler) HandlePromo(ctx context.Context, update tgbotapi.Update) error {
	if update.Message == nil {
		return nil
	}
	ctx, cancel := h.withTimeout(ctx)
	defer cancel()
	chatID := update.Message.Chat.ID
	code := strings.TrimSpace(update.Message.CommandArguments())
	if code == "" {
		return h.getSubHandler().handlePromoEnter(ctx, chatID, 0)
	}
	h.promoPrompts.close(chatID)

	return h.getSubHandler().handlePromoCode(ctx, chatID, code)
}

// handlePromoText consumes a text message as a promo code when the bot asked
// for one. ok is false when no code was awaited from this chat.
func (h *Handler) handlePromoText(ctx context.Context, update tgbotapi.Update) (ok bool, err error) {
	if update.Message == nil || update.Message.Chat == nil || !h.promoPrompts.take(update.Message.Chat.ID, time.Now()) {
		return false, nil
	}
	ctx, cancel := h.withTimeout(ctx)
	defer cancel()

	return true, h.getSubHandler().handlePromoCode(ctx, update.Message.Chat.ID, update.Message.Text)
}

// purchaseMenuAvailable reports whether the main menu offers the purchase
// row: the payment provider is on, or there is a free tariff to get.
func (h *Handler) purchaseMenuAvailable(ctx context.Context) bool {
	if h.paymentEnabled {
		return true
	}
	if h.orderService == nil {
		return false
	}
	free, err := h.orderService.FreeProducts(ctx)

	return err == nil && len(free) > 0
}
