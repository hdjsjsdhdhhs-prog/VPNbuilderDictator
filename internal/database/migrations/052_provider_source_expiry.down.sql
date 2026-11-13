-- Rollback: 052_provider_source_expiry
ALTER TABLE provider_sources DROP COLUMN expires_at;
