-- ═══════════════════════════════════════════════════════
-- Migration 004 — Impersonation (one-time codes + revocation)
-- ═══════════════════════════════════════════════════════

-- أكواد الدخول الإداري المؤقتة (تُستهلك مرة واحدة)
CREATE TABLE IF NOT EXISTS impersonation_codes (
  code         VARCHAR(64) PRIMARY KEY,
  company_id   INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id      INT NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  company_name TEXT NOT NULL,
  created_by   TEXT NOT NULL,
  expires_at   TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '5 minutes',
  used         BOOLEAN DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_imp_codes_expires ON impersonation_codes(expires_at);

-- عمود إلغاء جلسات الأدمن على مستوى الشركة
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS revoke_sessions_before TIMESTAMPTZ;
