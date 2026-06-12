CREATE TABLE IF NOT EXISTS support_tickets (
  id           SERIAL PRIMARY KEY,
  company_id   INTEGER REFERENCES companies(id) ON DELETE SET NULL,
  company_name TEXT,
  user_name    TEXT NOT NULL,
  user_role    TEXT,
  department   TEXT,
  sub_dept     TEXT,
  description  TEXT,
  status       TEXT NOT NULL DEFAULT 'open',
  note         TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_support_tickets_status     ON support_tickets(status);
CREATE INDEX IF NOT EXISTS idx_support_tickets_company    ON support_tickets(company_id);
CREATE INDEX IF NOT EXISTS idx_support_tickets_created_at ON support_tickets(created_at DESC);
