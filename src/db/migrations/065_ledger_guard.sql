-- الحارس المحاسبي اليومي (src/services/ledgerGuard.service.js): كل فرق بين
-- الدفاتر والسجلات الفرعية (الخزينة، طبقات المخزون، أرصدة العملاء/الموردين،
-- الفواتير المفتوحة) لكل شركة. الصف يبقى ما دام الفرق قائمًا (first_seen ثابت،
-- last_seen يتحدّث كل تشغيل)، ويُحذف تلقائيًا أول تشغيل بعد ما يتصلح
CREATE TABLE IF NOT EXISTS ledger_guard_findings (
  company_id  INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  check_key   VARCHAR(40)  NOT NULL,
  subject     VARCHAR(120) NOT NULL DEFAULT '',
  title       TEXT NOT NULL,
  expected    NUMERIC(14,3),
  actual      NUMERIC(14,3),
  diff        NUMERIC(14,3),
  first_seen  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (company_id, check_key, subject)
);

CREATE TABLE IF NOT EXISTS ledger_guard_runs (
  id          SERIAL PRIMARY KEY,
  ran_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  trigger     VARCHAR(20) NOT NULL DEFAULT 'schedule',
  companies   INT NOT NULL DEFAULT 0,
  findings    INT NOT NULL DEFAULT 0,
  duration_ms INT NOT NULL DEFAULT 0,
  error       TEXT
);
