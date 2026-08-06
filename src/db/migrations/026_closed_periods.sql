-- إقفال الفترات المحاسبية: يمنع تسجيل/تعديل عمليات بتاريخ يقع ضمن فترة مقفولة
CREATE TABLE IF NOT EXISTS closed_periods (
  id             SERIAL PRIMARY KEY,
  company_id     INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  period_type    VARCHAR(10) NOT NULL CHECK (period_type IN ('month','year')),
  period_key     VARCHAR(7)  NOT NULL, -- 'YYYY-MM' للشهري أو 'YYYY' للسنوي
  closed_by      INT REFERENCES users(id),
  closed_by_name VARCHAR(200),
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_id, period_type, period_key)
);
