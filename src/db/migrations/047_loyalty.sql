-- نظام الولاء والنقاط (ميزة حصرية للباقة الاحترافية) — كان بيانات محلية فقط
-- (localStorage) بلا أي حماية أو مزامنة فعلية بالسيرفر: أي مستخدم بأي باقة كان
-- يقدر يفعّلها محليًا عبر أدوات المطوّر بلا أي تحقق خلفي. الجدولان هنا يجعلان
-- الميزة محمية فعليًا عبر requireFeature('loyalty') ومُزامَنة بين الأجهزة.
CREATE TABLE IF NOT EXISTS loyalty_settings (
  company_id     INTEGER PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  enabled        BOOLEAN NOT NULL DEFAULT false,
  points_per_sar DECIMAL(6,2) NOT NULL DEFAULT 1,
  sar_per_point  DECIMAL(6,2) NOT NULL DEFAULT 0.1,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS loyalty_points (
  id            SERIAL PRIMARY KEY,
  company_id    INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  customer_name VARCHAR(200) NOT NULL,
  points        INTEGER NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(company_id, customer_name)
);
