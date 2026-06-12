-- ═══════════════════════════════════════════════════════
-- Migration 005 — Missing performance & security indexes
-- ═══════════════════════════════════════════════════════

-- login_attempts: تسريع البحث عن محاولات IP + username
CREATE INDEX IF NOT EXISTS idx_login_attempts_user_ip
  ON login_attempts(username, ip_address);

-- invoices: تسريع استعلامات الفواتير المتأخرة (due_date)
CREATE INDEX IF NOT EXISTS idx_invoices_due_date
  ON invoices(due_date)
  WHERE due_date IS NOT NULL;

-- impersonation_codes: تسريع الاستعلامات على مستوى الشركة
CREATE INDEX IF NOT EXISTS idx_imp_codes_company
  ON impersonation_codes(company_id);

-- تحديث default الباقة من 'free' إلى 'trial'
ALTER TABLE companies ALTER COLUMN plan SET DEFAULT 'trial';

-- الشركات القديمة: من free → trial
UPDATE companies SET plan = 'trial' WHERE plan = 'free' OR plan IS NULL;

-- subscriptions table: index سريع على company_id
CREATE INDEX IF NOT EXISTS idx_companies_plan ON companies(plan);
