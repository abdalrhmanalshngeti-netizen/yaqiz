-- Migration 010 — Platform Admins table (separate from company users)
CREATE TABLE IF NOT EXISTS platform_admins (
  id            SERIAL PRIMARY KEY,
  email         VARCHAR(200) NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  full_name     VARCHAR(200) DEFAULT 'مالك المنصة',
  active        BOOLEAN DEFAULT TRUE,
  last_login    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
