-- Migration 009 — Ensure all core columns exist (safe re-run)

-- أعمدة companies المطلوبة للتسجيل
ALTER TABLE companies ADD COLUMN IF NOT EXISTS status                 VARCHAR(20)   DEFAULT 'active';
ALTER TABLE companies ADD COLUMN IF NOT EXISTS plan                   VARCHAR(20)   DEFAULT 'trial';
ALTER TABLE companies ADD COLUMN IF NOT EXISTS max_users              INT           DEFAULT 5;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS subscription_expires_at TIMESTAMPTZ;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS contact_email          VARCHAR(200);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS contact_phone          VARCHAR(50);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS logo_url               TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS notes                  TEXT;

-- is_super_admin على users
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_super_admin BOOLEAN DEFAULT FALSE;

-- جدول platform_log
CREATE TABLE IF NOT EXISTS platform_log (
  id           SERIAL PRIMARY KEY,
  event_type   VARCHAR(50) NOT NULL,
  company_id   INT REFERENCES companies(id) ON DELETE SET NULL,
  user_id      INT REFERENCES users(id) ON DELETE SET NULL,
  description  TEXT,
  ip_address   VARCHAR(50),
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- جدول subscriptions
CREATE TABLE IF NOT EXISTS subscriptions (
  id           SERIAL PRIMARY KEY,
  company_id   INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  plan         VARCHAR(20) NOT NULL DEFAULT 'free',
  started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at   TIMESTAMPTZ,
  amount       NUMERIC(10,2) DEFAULT 0,
  status       VARCHAR(20) DEFAULT 'active',
  notes        TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- indexes آمنة
CREATE INDEX IF NOT EXISTS idx_platform_log_company ON platform_log(company_id);
CREATE INDEX IF NOT EXISTS idx_platform_log_created ON platform_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_subscriptions_company ON subscriptions(company_id);
