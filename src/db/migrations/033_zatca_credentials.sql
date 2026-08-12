-- المرحلة الثانية للفوترة الإلكترونية — الخطوة 4: تأهيل CSID (شهادة الامتثال ثم الإنتاج)
-- كل شركة تحتاج مفتاحها الخاص وشهادتها الخاصة من الهيئة — لا تُشارَك بين الشركات

CREATE TABLE IF NOT EXISTS zatca_credentials (
  id                     SERIAL PRIMARY KEY,
  company_id             INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  csid_type              VARCHAR(20) NOT NULL CHECK (csid_type IN ('compliance', 'production')),
  environment            VARCHAR(20) NOT NULL DEFAULT 'sandbox' CHECK (environment IN ('sandbox', 'simulation', 'production')),
  certificate_pem        TEXT,                 -- الشهادة (binarySecurityToken) — نص عام، لا يحتاج تشفير
  private_key_encrypted  TEXT,                 -- المفتاح الخاص مشفّر AES-256-GCM
  private_key_iv         TEXT,
  private_key_tag        TEXT,
  secret_encrypted        TEXT,                -- كلمة سر الوصول (secret) مشفّرة
  secret_iv               TEXT,
  secret_tag               TEXT,
  compliance_request_id  TEXT,                 -- يُستخدم للربط بين شهادة الامتثال وطلب شهادة الإنتاج
  is_active               BOOLEAN DEFAULT true,
  issued_at               TIMESTAMPTZ DEFAULT NOW(),
  created_at              TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_zatca_credentials_company ON zatca_credentials(company_id, csid_type, is_active);

-- حالة التأهيل الحالية على مستوى الشركة (لعرض سريع بالواجهة بدون استعلام الجدول أعلاه)
ALTER TABLE companies ADD COLUMN IF NOT EXISTS zatca_onboarding_status VARCHAR(20) DEFAULT 'none';
-- القيم الممكنة: none | csr_generated | compliance_issued | production_issued
