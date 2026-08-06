-- تتبّع جلسات موظفي لوحة الإدارة (كانت غير موجودة إطلاقاً — توكن واحد بدون أي سجل)
CREATE TABLE IF NOT EXISTS admin_sessions (
  id         SERIAL PRIMARY KEY,
  admin_id   INT NOT NULL REFERENCES platform_admins(id) ON DELETE CASCADE,
  ip_address INET,
  user_agent TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_admin ON admin_sessions(admin_id);
