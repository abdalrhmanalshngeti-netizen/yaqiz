-- كلمة مرور تجاوز منفصلة تمامًا عن كلمة مرور دخول المالك — تُستخدم فقط لتجاوز
-- إقفال فترة محاسبية أو فتحها، بدون كشف كلمة مرور حساب المالك الحقيقية.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS period_override_password_hash VARCHAR(255);
