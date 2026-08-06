-- استرجاع كلمة مرور ذاتي لحسابات لوحة الإدارة (كانت تحتاج دخول مباشر لقاعدة البيانات)
CREATE TABLE IF NOT EXISTS admin_password_reset_tokens (
  id         SERIAL PRIMARY KEY,
  admin_id   INT NOT NULL REFERENCES platform_admins(id) ON DELETE CASCADE,
  token      VARCHAR(64) NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used       BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_aprt_token ON admin_password_reset_tokens(token);
CREATE INDEX IF NOT EXISTS idx_aprt_admin ON admin_password_reset_tokens(admin_id);
