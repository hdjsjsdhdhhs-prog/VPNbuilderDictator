-- Rollback: 053_promo_ops
-- The seeded scenario is removed only while it was never sent (its deliveries
-- and coupons reference it).
DELETE FROM warmup_scenarios
WHERE key = 'trial_ended_discount'
  AND NOT EXISTS (SELECT 1 FROM warmup_deliveries d WHERE d.scenario_id = warmup_scenarios.id)
  AND NOT EXISTS (SELECT 1 FROM warmup_coupons c WHERE c.scenario_id = warmup_scenarios.id);
DROP TABLE IF EXISTS ops_states;
DROP TABLE IF EXISTS ops_events;
DROP TABLE IF EXISTS ops_settings;
DROP TABLE IF EXISTS order_discounts;
DROP TABLE IF EXISTS user_discounts;
DROP TABLE IF EXISTS promo_codes;
