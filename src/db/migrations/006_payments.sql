-- ═══════════════════════════════════════════════════════
-- Migration 006 — Moyasar Payments
-- ═══════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS payments (
  id             SERIAL PRIMARY KEY,
  company_id     INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  moyasar_id     VARCHAR(100) UNIQUE,
  plan           VARCHAR(20) NOT NULL,
  amount         NUMERIC(10,2) NOT NULL,
  status         VARCHAR(20) DEFAULT 'pending',
  months         INT DEFAULT 1,
  callback_url   TEXT,
  metadata       JSONB DEFAULT '{}',
  paid_at        TIMESTAMPTZ,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payments_company   ON payments(company_id);
CREATE INDEX IF NOT EXISTS idx_payments_moyasar   ON payments(moyasar_id);
CREATE INDEX IF NOT EXISTS idx_payments_status    ON payments(status);
