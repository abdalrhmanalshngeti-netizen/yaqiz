-- Migration 012 — Normalize plan values (trial/free → basic)

-- تحديث الشركات التي لديها plan = 'trial' أو 'free' → 'basic'
UPDATE companies SET plan = 'basic'
WHERE plan IN ('trial', 'free', 'starter') OR plan IS NULL;

-- تحديث الـ default من 'trial' إلى 'basic'
ALTER TABLE companies ALTER COLUMN plan SET DEFAULT 'basic';

-- ملاحظة: كانت هذه الهجرة تصفّر subscription_expires_at لباقة basic (على اعتبار
-- أنها مجانية للأبد). تمت إزالة ذلك لأن باقة basic أصبحت الآن تخضع لنفس تجربة
-- الـ30 يوم كباقي الباقات (راجع 016_retroactive_trial.sql) — إبقاء هذا السطر كان
-- سيصفّر تاريخ الانتهاء في كل إعادة تشغيل للسيرفر لأن هذا الملف يُعاد تنفيذه دائماً.
