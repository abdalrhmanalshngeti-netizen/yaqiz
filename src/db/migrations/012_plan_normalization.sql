-- Migration 012 — Normalize plan values (trial/free → basic)

-- تحديث الشركات التي لديها plan = 'trial' أو 'free' → 'basic'
UPDATE companies SET plan = 'basic'
WHERE plan IN ('trial', 'free', 'starter') OR plan IS NULL;

-- تحديث الـ default من 'trial' إلى 'basic'
ALTER TABLE companies ALTER COLUMN plan SET DEFAULT 'basic';

-- تحديث subscription_expires_at للشركات الجديدة التي لديها plan='basic' وانتهت مدتها
-- (لا نحتاج expiry لباقة basic)
UPDATE companies SET subscription_expires_at = NULL
WHERE plan = 'basic';
