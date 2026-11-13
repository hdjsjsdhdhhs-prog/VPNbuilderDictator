-- Migration: 053_promo_ops
-- Description: promo codes and discounts applied to payments, free tariffs,
-- and operational notifications (Telegram alerts, event feed, daily report).
--
-- * promo_codes     admin-created discount codes (Admin -> "Промокоды").
-- * user_discounts  a discount a user activated: from a promo code or from a
--                   personal warm-up coupon (one-click button or typed code).
--                   The best unredeemed, unexpired row lowers the price of the
--                   next purchase in the bot; it is redeemed by the order that
--                   was paid with it.
-- * order_discounts the discount an order was created with (one row per
--                   discounted order). It is a table of its own, not columns
--                   of orders, so the orders schema - and the code that writes
--                   orders - stays the same on every schema version.
--                   orders.amount_cents stays the amount to be paid. A free
--                   tariff (products.price_cents = 0) or a 100 % discount is
--                   activated by an order with amount 0 and provider 'free'.
-- * ops_settings    one row (id = 1): where operational notifications go and
--                   which ones are sent. chat_id = 0 means TELEGRAM_ADMIN_ID;
--                   an empty bot_token means the main bot. baseline_at keeps
--                   history from before this migration out of the alerts.
-- * ops_events      append-only feed of infrastructure events (servers,
--                   countries, builders, sources, daily report) shown in
--                   Admin -> "События" and delivered to Telegram.
-- * ops_states      last known state per subject, to alert on transitions only.

CREATE TABLE promo_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL,
    percent INTEGER NOT NULL CHECK (percent BETWEEN 1 AND 100),
    -- 0 = unlimited.
    max_activations INTEGER NOT NULL DEFAULT 0 CHECK (max_activations >= 0),
    activations INTEGER NOT NULL DEFAULT 0 CHECK (activations >= 0),
    -- How long an activated discount stays usable by the user.
    valid_hours INTEGER NOT NULL DEFAULT 72 CHECK (valid_hours BETWEEN 1 AND 8760),
    -- The code can be activated until this moment (NULL = no limit).
    expires_at DATETIME,
    enabled BOOLEAN NOT NULL DEFAULT 1,
    note TEXT NOT NULL DEFAULT '',
    version INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL
);

CREATE UNIQUE INDEX idx_promo_codes_code ON promo_codes(code);

CREATE TABLE user_discounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id INTEGER NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('promo', 'warmup')),
    promo_code_id INTEGER REFERENCES promo_codes(id) ON DELETE SET NULL,
    warmup_coupon_id INTEGER,
    code TEXT NOT NULL,
    percent INTEGER NOT NULL CHECK (percent BETWEEN 1 AND 100),
    activated_at DATETIME NOT NULL,
    expires_at DATETIME NOT NULL,
    redeemed_at DATETIME,
    order_id INTEGER
);

-- A promo code is activated at most once per user; a coupon at most once.
CREATE UNIQUE INDEX idx_user_discounts_promo ON user_discounts(telegram_id, promo_code_id) WHERE promo_code_id IS NOT NULL;
CREATE UNIQUE INDEX idx_user_discounts_coupon ON user_discounts(warmup_coupon_id) WHERE warmup_coupon_id IS NOT NULL;
CREATE INDEX idx_user_discounts_user ON user_discounts(telegram_id, redeemed_at, expires_at);

CREATE TABLE order_discounts (
    order_id INTEGER PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
    user_discount_id INTEGER NOT NULL,
    discount_percent INTEGER NOT NULL CHECK (discount_percent BETWEEN 1 AND 100),
    -- Catalogue price before the discount.
    list_amount_cents INTEGER NOT NULL CHECK (list_amount_cents >= 0),
    created_at DATETIME NOT NULL
);

CREATE INDEX idx_order_discounts_discount ON order_discounts(user_discount_id);

CREATE TABLE ops_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    enabled BOOLEAN NOT NULL DEFAULT 1,
    chat_id INTEGER NOT NULL DEFAULT 0,
    bot_token TEXT NOT NULL DEFAULT '',
    notify_servers BOOLEAN NOT NULL DEFAULT 1,
    notify_countries BOOLEAN NOT NULL DEFAULT 1,
    notify_sources BOOLEAN NOT NULL DEFAULT 1,
    daily_report BOOLEAN NOT NULL DEFAULT 1,
    -- Hour of the day (Moscow time) the report for the previous day is sent.
    daily_report_hour INTEGER NOT NULL DEFAULT 9 CHECK (daily_report_hour BETWEEN 0 AND 23),
    -- Moscow calendar day (YYYY-MM-DD) the last report covered.
    last_report_day TEXT NOT NULL DEFAULT '',
    baseline_at DATETIME NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    updated_at DATETIME NOT NULL
);

INSERT INTO ops_settings (id, baseline_at, updated_at)
VALUES (1, strftime('%Y-%m-%d %H:%M:%f+00:00', 'now'), strftime('%Y-%m-%d %H:%M:%f+00:00', 'now'));

CREATE TABLE ops_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at DATETIME NOT NULL,
    kind TEXT NOT NULL,
    severity TEXT NOT NULL CHECK (severity IN ('ok', 'info', 'warning', 'critical')),
    title TEXT NOT NULL,
    message TEXT NOT NULL DEFAULT '',
    builder_id INTEGER,
    source_id INTEGER,
    target_id INTEGER,
    country_code TEXT NOT NULL DEFAULT '',
    details TEXT NOT NULL DEFAULT '{}',
    dedup_key TEXT,
    -- pending: to be delivered; sent; failed: gave up; skipped: notifications
    -- of this kind were switched off when the event was recorded.
    notify_status TEXT NOT NULL DEFAULT 'pending' CHECK (notify_status IN ('pending', 'sent', 'failed', 'skipped')),
    notify_attempts INTEGER NOT NULL DEFAULT 0,
    notified_at DATETIME,
    notify_error TEXT NOT NULL DEFAULT ''
);

CREATE UNIQUE INDEX idx_ops_events_dedup ON ops_events(dedup_key) WHERE dedup_key IS NOT NULL;
CREATE INDEX idx_ops_events_created ON ops_events(created_at, id);
CREATE INDEX idx_ops_events_pending ON ops_events(notify_status, id);

-- Warm-up: a ready-made "discount after the trial" scenario. It is created
-- switched OFF (the admin decides on the discount and enables it). Its button
-- uses the apply_discount action: one click activates the personal coupon of
-- the message and opens the tariff list with the lowered prices.
INSERT INTO warmup_scenarios (key, category, name, description, trigger_type, timing, delay_value, delay_unit, enabled, enabled_at,
                              message_html, buttons, conditions, discount_percent, coupon_template, coupon_ttl_hours,
                              position, created_at, updated_at)
SELECT 'trial_ended_discount', 'trial', 'Скидка после пробника',
       'Через день после окончания пробного периода: персональная скидка, которая применяется одной кнопкой',
       'trial_period_end', 'after', 1, 'days', 0, NULL,
       '<b>Скидка {{discount_percent}}% на подписку</b>' || char(10) || char(10) ||
       'Пробный период закончился, но VPN можно оставить.' || char(10) ||
       'Дарим скидку {{discount_percent}}% на любой тариф: нажмите кнопку ниже, и цены сразу станут ниже.' || char(10) || char(10) ||
       'Ваш код: <code>{{discount_code}}</code>' || char(10) ||
       'Скидка действует ограниченное время.',
       '[{"text":"Применить скидку","kind":"callback","value":"apply_discount"}]',
       '{"has_active_paid":false,"ever_paid":false}', 20, 'TRIAL', 72, 65,
       strftime('%Y-%m-%d %H:%M:%f+00:00', 'now'), strftime('%Y-%m-%d %H:%M:%f+00:00', 'now')
WHERE NOT EXISTS (SELECT 1 FROM warmup_scenarios WHERE key = 'trial_ended_discount');

CREATE TABLE ops_states (
    key TEXT PRIMARY KEY,
    state TEXT NOT NULL,
    since DATETIME NOT NULL
);
