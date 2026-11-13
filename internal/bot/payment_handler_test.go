package bot

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/hdjsjsdhdhhs-prog/VPNbuilderDictator/internal/config"
	"github.com/hdjsjsdhdhhs-prog/VPNbuilderDictator/internal/database"
	"github.com/hdjsjsdhdhhs-prog/VPNbuilderDictator/internal/service"
	"github.com/hdjsjsdhdhhs-prog/VPNbuilderDictator/internal/service/payment/platega"
	"github.com/hdjsjsdhdhhs-prog/VPNbuilderDictator/internal/testutil"

	tgbotapi "github.com/go-telegram-bot-api/telegram-bot-api/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// fakePaymentProvider satisfies service.PaymentProvider for bot-level tests.
type fakePaymentProvider struct{}

func (fakePaymentProvider) CreateTransaction(context.Context, platega.CreateTransactionRequest) (*platega.CreateTransactionResponse, error) {
	return &platega.CreateTransactionResponse{
		TransactionID: "550e8400-e29b-41d4-a716-446655440099",
		URL:           "https://pay.example",
		ExpiresIn:     "00:15:00",
	}, nil
}

func (fakePaymentProvider) GetTransactionStatus(context.Context, uuid.UUID) (*platega.TransactionStatusResponse, error) {
	return nil, errors.New("status not configured")
}

// newPaymentTestHandler builds a Handler with payment enabled and an OrderService
// backed by the provided DB mock and provider. Passing a nil provider yields an
// OrderService with disabled payments (ErrPaymentDisabled from RequestPayment).
func newPaymentTestHandler(t *testing.T, mockDB *testutil.DatabaseService, provider service.PaymentProvider) (*Handler, *testutil.BotAPI) {
	t.Helper()

	cfg := &config.Config{TelegramAdminID: 123, PaymentEnabled: true}
	bot := testutil.NewBotAPI()
	h := NewHandler(bot, cfg, mockDB, NewTestBotConfig(), nil, "")
	o := service.NewOrderService(mockDB, nil, provider, "testbot", cfg)
	h.SetOrderService(o)

	return h, bot
}

func TestHandleBuyPremiumList_NotConfigured(t *testing.T) {
	t.Parallel()

	cfg := &config.Config{TelegramAdminID: 123, PaymentEnabled: false}
	mockDB := testutil.NewDatabaseService()
	bot := testutil.NewBotAPI()
	h := NewHandler(bot, cfg, mockDB, NewTestBotConfig(), nil, "")

	err := h.handleBuyPremiumList(context.Background(), 42, "user", 99)
	require.NoError(t, err)

	messages := bot.GetAllSentMessages()
	require.Len(t, messages, 1)
	assert.Contains(t, messages[0].Text, "Платежи временно недоступны")
}

func TestHandleBuyPremiumList_ListErrorShowsTempError(t *testing.T) {
	t.Parallel()

	mockDB := testutil.NewDatabaseService()
	mockDB.ListActiveProductsFunc = func(context.Context) ([]database.Product, error) {
		return nil, assert.AnError
	}
	h, bot := newPaymentTestHandler(t, mockDB, fakePaymentProvider{})

	err := h.handleBuyPremiumList(context.Background(), 42, "user", 99)
	require.NoError(t, err)

	messages := bot.GetAllSentMessages()
	require.Len(t, messages, 1)
	assert.Equal(t, msg(MsgSubTempError), messages[0].Text)
}

func TestHandleBuyPremiumList_EmptyListShowsNoTariffs(t *testing.T) {
	t.Parallel()

	mockDB := testutil.NewDatabaseService()
	mockDB.ListActiveProductsFunc = func(context.Context) ([]database.Product, error) {
		return nil, nil
	}
	h, bot := newPaymentTestHandler(t, mockDB, fakePaymentProvider{})

	err := h.handleBuyPremiumList(context.Background(), 42, "user", 99)
	require.NoError(t, err)

	messages := bot.GetAllSentMessages()
	require.Len(t, messages, 1)
	assert.Contains(t, messages[0].Text, "Нет доступных тарифов")
}

func TestHandleBuyPremiumList_SuccessShowsProducts(t *testing.T) {
	t.Parallel()

	mockDB := testutil.NewDatabaseService()
	mockDB.ListActiveProductsFunc = func(context.Context) ([]database.Product, error) {
		return []database.Product{
			{ID: 1, Name: "Месяц", PriceCents: 19900, IsActive: true},
			{ID: 2, Name: "Год", PriceCents: 199900, IsActive: true},
		}, nil
	}
	h, bot := newPaymentTestHandler(t, mockDB, fakePaymentProvider{})

	err := h.handleBuyPremiumList(context.Background(), 42, "user", 99)
	require.NoError(t, err)

	messages := bot.GetAllSentMessages()
	require.Len(t, messages, 1)
	assert.Equal(t, msg(MsgPremiumBenefits), messages[0].Text)
	assert.Contains(t, messages[0].Text, "🌍 Больше серверов и вариантов подключения")
	assert.Contains(t, messages[0].Text, "💬 Приоритетная поддержка")

	edit, ok := bot.LastChattableSafe().(tgbotapi.EditMessageTextConfig)
	require.True(t, ok, "expected an edited message with a keyboard")
	assert.Equal(t, tgbotapi.ModeMarkdown, edit.ParseMode)
	require.NotNil(t, edit.ReplyMarkup, "product list must carry the BuyProductList keyboard")
	require.NotEmpty(t, edit.ReplyMarkup.InlineKeyboard)

	// Product rows, then the promo code entry, then the way back.
	rows := edit.ReplyMarkup.InlineKeyboard
	require.Len(t, rows, 4)
	for _, row := range rows[:len(rows)-2] {
		require.NotNil(t, row[0].CallbackData)
		assert.Contains(t, *row[0].CallbackData, "buy_product_", "product rows use buy_product_{id} callbacks")
	}
	require.NotNil(t, rows[2][0].CallbackData)
	assert.Equal(t, "promo_enter", *rows[2][0].CallbackData, "the promo code is entered next to the prices")
	require.NotNil(t, rows[3][0].CallbackData)
	assert.Equal(t, "back_to_start", *rows[3][0].CallbackData)
}

// The bot shows products in the catalogue order returned by
// ListActiveProducts (database.ProductCatalogOrder: sort_order, then price):
// the same order as the Mini App. It must never re-sort by price.
func TestHandleBuyPremiumList_KeepsCatalogueSortOrder(t *testing.T) {
	t.Parallel()

	mockDB := testutil.NewDatabaseService()
	mockDB.ListActiveProductsFunc = func(context.Context) ([]database.Product, error) {
		return []database.Product{
			{ID: 3, Name: "Год", PriceCents: 199900, IsActive: true, SortOrder: 0, Currency: "RUB"},
			{ID: 1, Name: "Месяц", PriceCents: 19900, IsActive: true, SortOrder: 1, Currency: "RUB"},
			{ID: 2, Name: "Квартал", PriceCents: 49900, IsActive: true, SortOrder: 2, Currency: "RUB"},
		}, nil
	}
	h, bot := newPaymentTestHandler(t, mockDB, fakePaymentProvider{})

	require.NoError(t, h.handleBuyPremiumList(context.Background(), 42, "user", 99))

	edit, ok := bot.LastChattableSafe().(tgbotapi.EditMessageTextConfig)
	require.True(t, ok)
	require.NotNil(t, edit.ReplyMarkup)
	rows := edit.ReplyMarkup.InlineKeyboard
	// Three tariffs, the promo code entry and the way back.
	require.Len(t, rows, 5)
	var callbacks []string
	for _, row := range rows[:3] {
		require.NotNil(t, row[0].CallbackData)
		callbacks = append(callbacks, *row[0].CallbackData)
	}
	assert.Equal(t, []string{"buy_product_3", "buy_product_1", "buy_product_2"}, callbacks)
}

func TestHandleBuyProduct_NotConfigured(t *testing.T) {
	t.Parallel()

	cfg := &config.Config{TelegramAdminID: 123, PaymentEnabled: false}
	mockDB := testutil.NewDatabaseService()
	bot := testutil.NewBotAPI()
	h := NewHandler(bot, cfg, mockDB, NewTestBotConfig(), nil, "")

	err := h.handleBuyProduct(context.Background(), 42, "user", 99, 1)
	require.NoError(t, err)

	messages := bot.GetAllSentMessages()
	require.Len(t, messages, 1)
	assert.Contains(t, messages[0].Text, "Платежи временно недоступны")
}

func TestHandleBuyProduct_ProductLoadErrorShowsTempError(t *testing.T) {
	t.Parallel()

	mockDB := testutil.NewDatabaseService()
	mockDB.GetProductByIDFunc = func(context.Context, uint) (*database.Product, error) {
		return nil, assert.AnError
	}
	h, bot := newPaymentTestHandler(t, mockDB, fakePaymentProvider{})

	err := h.handleBuyProduct(context.Background(), 42, "user", 99, 1)
	require.NoError(t, err)

	messages := bot.GetAllSentMessages()
	require.Len(t, messages, 1)
	assert.Equal(t, msg(MsgSubTempError), messages[0].Text)
}

func TestHandleBuyProduct_TariffUnavailable(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		product *database.Product
	}{
		{name: "nil product", product: nil},
		{name: "inactive product", product: &database.Product{ID: 1, Name: "Месяц", PriceCents: 19900, IsActive: false}},
		{name: "inactive free product", product: &database.Product{ID: 1, Name: "Free", PriceCents: 0, IsActive: false}},
		{name: "negative price", product: &database.Product{ID: 1, Name: "Broken", PriceCents: -1, IsActive: true}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			mockDB := testutil.NewDatabaseService()
			mockDB.GetProductByIDFunc = func(context.Context, uint) (*database.Product, error) {
				return tt.product, nil
			}
			h, bot := newPaymentTestHandler(t, mockDB, fakePaymentProvider{})

			err := h.handleBuyProduct(context.Background(), 42, "user", 99, 1)
			require.NoError(t, err)

			messages := bot.GetAllSentMessages()
			require.Len(t, messages, 1)
			assert.Contains(t, messages[0].Text, "Тариф недоступен")
		})
	}
}

// A free tariff (price 0) is not "unavailable": it is offered for a free
// activation and never sent to the payment provider.
func TestHandleBuyProduct_FreeTariffOffersFreeActivation(t *testing.T) {
	t.Parallel()

	mockDB := testutil.NewDatabaseService()
	mockDB.GetProductByIDFunc = func(context.Context, uint) (*database.Product, error) {
		return &database.Product{ID: 7, Name: "Free", PriceCents: 0, DurationDays: 30, IsActive: true}, nil
	}
	h, bot := newPaymentTestHandler(t, mockDB, fakePaymentProvider{})

	require.NoError(t, h.handleBuyProduct(context.Background(), 42, "user", 99, 7))

	edit, ok := bot.LastChattableSafe().(tgbotapi.EditMessageTextConfig)
	require.True(t, ok)
	assert.Contains(t, edit.Text, "Этот тариф бесплатный")
	assert.Contains(t, edit.Text, "30 дн.")
	require.NotNil(t, edit.ReplyMarkup)
	rows := edit.ReplyMarkup.InlineKeyboard
	require.Len(t, rows, 2)
	require.NotNil(t, rows[0][0].CallbackData)
	assert.Equal(t, "get_free_7", *rows[0][0].CallbackData)
	assert.Nil(t, rows[0][0].URL, "a free tariff has no payment link")
}

// The promo code entry: the prompt opens, the next text is consumed as the
// code exactly once, and an expired or closed prompt is not a code.
func TestPromoPrompts(t *testing.T) {
	t.Parallel()

	var prompts promoPrompts
	now := time.Now()
	assert.False(t, prompts.take(1, now), "nothing was asked")

	prompts.open(1, now)
	assert.True(t, prompts.take(1, now.Add(time.Minute)))
	assert.False(t, prompts.take(1, now.Add(time.Minute)), "a prompt is consumed once")

	prompts.open(2, now)
	assert.False(t, prompts.take(2, now.Add(promoPromptTTL+time.Second)), "an expired prompt is not a code")

	prompts.open(3, now)
	prompts.close(3)
	assert.False(t, prompts.take(3, now))
}

func TestTariffPriceLabel(t *testing.T) {
	t.Parallel()

	product := database.Product{Name: "Месяц", PriceCents: 20000}
	assert.Equal(t, "200₽", tariffPriceLabel(TariffOffer{Product: product, AmountCents: 20000}))
	assert.Equal(t, "150₽ вместо 200₽", tariffPriceLabel(TariffOffer{Product: product, AmountCents: 15000}))
	assert.Equal(t, "Бесплатно", tariffPriceLabel(TariffOffer{Product: product, AmountCents: 0}))
	assert.Equal(t, "Бесплатно", tariffPriceLabel(TariffOffer{Product: database.Product{PriceCents: 0}, AmountCents: 0}))
}

func TestHandleBuyProduct_PaymentDisabled(t *testing.T) {
	t.Parallel()

	mockDB := testutil.NewDatabaseService()
	mockDB.GetProductByIDFunc = func(context.Context, uint) (*database.Product, error) {
		return &database.Product{ID: 1, Name: "Месяц", PriceCents: 19900, IsActive: true}, nil
	}
	// orderService with a nil provider → RequestPayment returns ErrPaymentDisabled.
	h, bot := newPaymentTestHandler(t, mockDB, nil)

	err := h.handleBuyProduct(context.Background(), 42, "user", 99, 1)
	require.NoError(t, err)

	messages := bot.GetAllSentMessages()
	require.Len(t, messages, 1)
	assert.Contains(t, messages[0].Text, "Платежи временно недоступны")
}

func TestHandleBuyProduct_PaymentAlreadyInProgress(t *testing.T) {
	t.Parallel()

	mockDB := testutil.NewDatabaseService()
	mockDB.GetProductByIDFunc = func(context.Context, uint) (*database.Product, error) {
		return &database.Product{ID: 1, Name: "Месяц", PriceCents: 19900, Currency: "RUB", IsActive: true}, nil
	}
	mockDB.GetByTelegramIDFunc = func(context.Context, int64) (*database.Subscription, error) {
		return &database.Subscription{ID: 7, TelegramID: 42}, nil
	}
	mockDB.FindPendingPaymentOrderFunc = func(context.Context, uint, uint, time.Time) (*database.Order, error) {
		// Pending intent already claimed by a provider transaction without a
		// usable link → RequestPayment must report ErrPaymentAlreadyInProgress.
		return &database.Order{
			ID: 3, Status: database.OrderStatusPending, ProviderPaymentID: "550e8400-e29b-41d4-a716-446655440099",
		}, nil
	}
	h, bot := newPaymentTestHandler(t, mockDB, fakePaymentProvider{})

	err := h.handleBuyProduct(context.Background(), 42, "user", 99, 1)
	require.NoError(t, err)

	messages := bot.GetAllSentMessages()
	require.Len(t, messages, 1)
	assert.Equal(t, msg(MsgPaymentInProgress), messages[0].Text)
}

func TestHandleBuyProduct_PaymentNeedsReview(t *testing.T) {
	t.Parallel()

	mockDB := testutil.NewDatabaseService()
	mockDB.GetProductByIDFunc = func(context.Context, uint) (*database.Product, error) {
		return &database.Product{ID: 1, Name: "Месяц", PriceCents: 19900, Currency: "RUB", IsActive: true}, nil
	}
	mockDB.GetByTelegramIDFunc = func(context.Context, int64) (*database.Subscription, error) {
		return &database.Subscription{ID: 7, TelegramID: 42}, nil
	}
	mockDB.FindPendingPaymentOrderFunc = func(context.Context, uint, uint, time.Time) (*database.Order, error) {
		return &database.Order{ID: 3, Status: database.OrderStatusPending, PaymentCreationUncertain: true}, nil
	}
	h, bot := newPaymentTestHandler(t, mockDB, fakePaymentProvider{})

	err := h.handleBuyProduct(context.Background(), 42, "user", 99, 1)
	require.NoError(t, err)

	messages := bot.GetAllSentMessages()
	require.Len(t, messages, 1)
	assert.Equal(t, msg(MsgPaymentNeedsReview), messages[0].Text)
}

func TestHandleBuyProduct_GenericRequestErrorShowsTempError(t *testing.T) {
	t.Parallel()

	mockDB := testutil.NewDatabaseService()
	mockDB.GetProductByIDFunc = func(context.Context, uint) (*database.Product, error) {
		return &database.Product{ID: 1, Name: "Месяц", PriceCents: 19900, Currency: "RUB", IsActive: true}, nil
	}
	mockDB.GetByTelegramIDFunc = func(context.Context, int64) (*database.Subscription, error) {
		return &database.Subscription{ID: 7, TelegramID: 42}, nil
	}
	mockDB.FindPendingPaymentOrderFunc = func(context.Context, uint, uint, time.Time) (*database.Order, error) {
		return nil, assert.AnError
	}
	h, bot := newPaymentTestHandler(t, mockDB, fakePaymentProvider{})

	err := h.handleBuyProduct(context.Background(), 42, "user", 99, 1)
	require.NoError(t, err)

	messages := bot.GetAllSentMessages()
	require.Len(t, messages, 1)
	assert.Equal(t, msg(MsgSubTempError), messages[0].Text)
}

func TestHandleBuyProduct_SuccessShowsPaymentButton(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		priceCents int64
		wantPrice  string
	}{
		{name: "whole rubles", priceCents: 19900, wantPrice: "199₽"},
		{name: "kopecks preserved", priceCents: 19999, wantPrice: "199.99₽"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			mockDB := testutil.NewDatabaseService()
			mockDB.GetProductByIDFunc = func(context.Context, uint) (*database.Product, error) {
				return &database.Product{ID: 1, Name: "Месяц", PriceCents: tt.priceCents, Currency: "RUB", IsActive: true}, nil
			}
			mockDB.GetByTelegramIDFunc = func(context.Context, int64) (*database.Subscription, error) {
				return &database.Subscription{ID: 7, TelegramID: 42}, nil
			}
			mockDB.FindPendingPaymentOrderFunc = func(context.Context, uint, uint, time.Time) (*database.Order, error) {
				return nil, nil
			}
			mockDB.GetPlanByIDFunc = func(context.Context, uint) (*database.Plan, error) {
				// Only a plan with a subscription builder is sellable.
				return &database.Plan{ID: 2, IsActive: true, SubscriptionBuilderID: testutil.PtrUint(1)}, nil
			}
			mockDB.FindOrCreatePendingPaymentOrderFunc = func(context.Context, uint, uint, int64, string, time.Time) (*database.Order, error) {
				return &database.Order{ID: 3, SubscriptionID: 7, ProductID: 1, Status: database.OrderStatusPending, AmountCents: tt.priceCents, Currency: "RUB"}, nil
			}
			mockDB.MarkPaymentCreationUncertainFunc = func(context.Context, uint, bool) (bool, error) { return true, nil }
			mockDB.SavePaymentDetailsFunc = func(context.Context, uint, uuid.UUID, string, time.Time) error { return nil }
			h, bot := newPaymentTestHandler(t, mockDB, fakePaymentProvider{})

			err := h.handleBuyProduct(context.Background(), 42, "user", 99, 1)
			require.NoError(t, err)

			messages := bot.GetAllSentMessages()
			require.Len(t, messages, 1)
			assert.Contains(t, messages[0].Text, "Тариф: 💎 *Месяц*")
			assert.Contains(t, messages[0].Text, "Стоимость: *"+tt.wantPrice+"*")
			assert.Contains(t, messages[0].Text, "После оплаты тариф активируется автоматически.")
			assert.Contains(t, messages[0].Text, "Если тариф уже активен, новые дни прибавятся к текущему сроку.")
			assert.Contains(t, messages[0].Text, "_Платёжная система может дополнительно взимать комиссию._")

			edit, ok := bot.LastChattableSafe().(tgbotapi.EditMessageTextConfig)
			require.True(t, ok, "expected an edited message with a payment keyboard")
			require.Equal(t, "Markdown", edit.ParseMode)
			require.NotNil(t, edit.ReplyMarkup, "payment screen must carry the BuyProductConfirm keyboard")
			require.NotEmpty(t, edit.ReplyMarkup.InlineKeyboard)
			urlButton := edit.ReplyMarkup.InlineKeyboard[0][0]
			require.NotNil(t, urlButton.URL, "payment button must carry the provider URL")
			assert.Equal(t, "https://pay.example", *urlButton.URL, "payment button must link to the provider URL")
			assert.Equal(t, "💳 Оплатить "+tt.wantPrice, urlButton.Text)
		})
	}
}
