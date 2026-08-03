-- Existing companies registered before the 30-day-trial-for-all-plans change
-- (mainly old 'basic' plan companies) had subscription_expires_at = NULL,
-- meaning permanent free access. Give them a fresh 30-day trial starting now,
-- matching the same rule now applied to all new signups.
UPDATE companies
SET subscription_expires_at = NOW() + INTERVAL '30 days'
WHERE subscription_expires_at IS NULL;
