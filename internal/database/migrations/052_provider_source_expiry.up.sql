-- Migration: 052_provider_source_expiry
-- Description: Admin-set end of validity of an external (provider) subscription
-- (Admin -> "Источники"). A provider sells its subscription for a term; the
-- admin records until which date and hour it works.
--
-- * NULL = no limit (every existing source keeps working as before).
-- * Past expires_at the source is unusable, exactly like a disabled one: /sub,
--   the builder preview and the network monitor skip it
--   (ProviderSource.RequestConfiguration is the single check).
-- * The value is compared in Go, never in SQL, so its text format is
--   irrelevant; it is stored in UTC like every other timestamp.

ALTER TABLE provider_sources ADD COLUMN expires_at DATETIME;
