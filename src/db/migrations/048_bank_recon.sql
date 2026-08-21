-- تسوية البنك (ميزة حصرية للباقة الاحترافية) — كانت حالتها (فترة التسوية، رصيد
-- كشف الحساب، بنود التسوية اليدوية، سطور الكشف المستوردة) محلية بالكامل بلا
-- أي حماية باقة فعلية ولا مزامنة بين الأجهزة. جدول واحد لأنها حالة موحّدة لكل
-- شركة (لا قائمة أحداث متزايدة)، محمي عبر requireFeature('bank_recon').
CREATE TABLE IF NOT EXISTS bank_recon (
  company_id         INTEGER PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  from_date          DATE,
  to_date            DATE,
  bank_network_total DECIMAL(12,2) NOT NULL DEFAULT 0,
  adjustments        JSONB NOT NULL DEFAULT '[]'::jsonb,
  imported_lines     JSONB,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
