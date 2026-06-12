-- ═══════════════════════════════════════════════════════
-- Migration 002 — SaaS Multi-tenant upgrades
-- ═══════════════════════════════════════════════════════

-- حقول إضافية لجدول الشركات
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS status            VARCHAR(20)  DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS plan              VARCHAR(20)  DEFAULT 'free',
  ADD COLUMN IF NOT EXISTS max_users         INT          DEFAULT 5,
  ADD COLUMN IF NOT EXISTS subscription_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS contact_email     VARCHAR(200),
  ADD COLUMN IF NOT EXISTS contact_phone     VARCHAR(50),
  ADD COLUMN IF NOT EXISTS logo_url          TEXT,
  ADD COLUMN IF NOT EXISTS notes             TEXT,
  ADD COLUMN IF NOT EXISTS created_at        TIMESTAMPTZ  DEFAULT NOW();

-- Super Admin flag على المستخدمين
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_super_admin BOOLEAN DEFAULT FALSE;

-- جدول الاشتراكات (للمستقبل)
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

-- جدول سجل نشاط المنصة (لمراقبة المالك)
CREATE TABLE IF NOT EXISTS platform_log (
  id           SERIAL PRIMARY KEY,
  event_type   VARCHAR(50) NOT NULL,
  company_id   INT REFERENCES companies(id) ON DELETE SET NULL,
  user_id      INT REFERENCES users(id) ON DELETE SET NULL,
  description  TEXT,
  ip_address   VARCHAR(50),
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_platform_log_company ON platform_log(company_id);
CREATE INDEX IF NOT EXISTS idx_platform_log_created ON platform_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_subscriptions_company ON subscriptions(company_id);
