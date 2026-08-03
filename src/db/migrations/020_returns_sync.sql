-- returns table existed in the original schema but was never wired up to
-- any controller (db.returns lived only in browser localStorage). Add the
-- two fields the frontend actually tracks that the original table lacked.
ALTER TABLE returns ADD COLUMN IF NOT EXISTS payment_method VARCHAR(30);
ALTER TABLE returns ADD COLUMN IF NOT EXISTS cogs_reversal DECIMAL(12,2) DEFAULT 0;
