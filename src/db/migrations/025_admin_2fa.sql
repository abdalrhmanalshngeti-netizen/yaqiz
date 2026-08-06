-- مصادقة ثنائية (2FA) اختيارية لموظفي لوحة الإدارة — تطبيق مصادقة (TOTP)
ALTER TABLE platform_admins ADD COLUMN IF NOT EXISTS totp_secret TEXT;
ALTER TABLE platform_admins ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE platform_admins ADD COLUMN IF NOT EXISTS totp_pending_secret TEXT;
ALTER TABLE platform_admins ADD COLUMN IF NOT EXISTS totp_backup_codes TEXT[] NOT NULL DEFAULT '{}';
