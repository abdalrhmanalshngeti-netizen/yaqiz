-- إشعارات الدائن (Credit Notes) — يصدر عند إلغاء فاتورة مبيعات كاملة أو عند
-- مرتجع مبيعات مرتبط بفاتورة، بدل تغيير حالة الفاتورة بصمت فقط. مستند مستقل
-- بترقيمه التسلسلي الخاص، مرجَّع للفاتورة الأصلية، ومار بنفس مسار التوثيق
-- (سلسلة تجزئة ICV/PIH، XML، توقيع XAdES إن وُجدت شهادة، رمز QR للمرحلة الثانية).

-- عداد سلسلة تجزئة موحّد لكل شركة — يغطي الفواتير وإشعارات الدائن معًا بسلسلة
-- واحدة متصلة (BR-KSA-26 تشترط سلسلة واحدة، لا سلسلتين منفصلتين لكل نوع مستند).
-- يحل محل قراءة MAX(icv) من جدول الفواتير مباشرة، لأن PostgreSQL لا يدعم
-- FOR UPDATE على نتيجة UNION بين جدولين.
CREATE TABLE IF NOT EXISTS zatca_chain_state (
  company_id INT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  last_icv   INT NOT NULL DEFAULT 0,
  last_hash  TEXT
);

-- تعبئة أولية من آخر حالة فعلية بجدول الفواتير الحالي لكل شركة — يضمن استمرار
-- السلسلة بدون انقطاع للشركات الموجودة أصلًا وقت هذا التحديث.
-- last_icv = أعلى ICV فعلي (بغضّ النظر عن نجاح التجزئة) لأن العداد نفسه يجب أن
-- يستمر تسلسليًا دون فجوات. last_hash يجب أن يُؤخذ من آخر فاتورة *لها تجزئة فعلية*
-- تحديدًا — لو أُخذت من فاتورة أعلى ICV لكن فشل توليد XML لها (تجزئة NULL)، تنكسر
-- السلسلة القانونية للفاتورة التالية فورًا (تبدأ من FIRST_INVOICE_HASH خطأً بدل
-- تجزئة آخر فاتورة موثّقة فعليًا).
INSERT INTO zatca_chain_state (company_id, last_icv, last_hash)
SELECT
  a.company_id,
  a.max_icv,
  (SELECT i2.zatca_hash FROM invoices i2
   WHERE i2.company_id = a.company_id AND i2.zatca_hash IS NOT NULL
   ORDER BY i2.icv DESC LIMIT 1)
FROM (
  SELECT company_id, MAX(icv) AS max_icv FROM invoices WHERE icv IS NOT NULL GROUP BY company_id
) a
ON CONFLICT (company_id) DO NOTHING;

CREATE SEQUENCE IF NOT EXISTS credit_note_seq START 1;

CREATE TABLE IF NOT EXISTS credit_notes (
  id                     SERIAL PRIMARY KEY,
  company_id             INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  note_no                VARCHAR(50) NOT NULL,
  reason                 VARCHAR(20) NOT NULL, -- 'cancel' | 'return'
  reference_invoice_id   INT NOT NULL REFERENCES invoices(id),
  reference_invoice_no   VARCHAR(50) NOT NULL,
  reference_return_id    INT REFERENCES returns(id),
  customer_id            INT REFERENCES customers(id),
  customer_name          VARCHAR(200),
  customer_vat           VARCHAR(20),
  date                   DATE NOT NULL DEFAULT CURRENT_DATE,
  subtotal               DECIMAL(12,2) DEFAULT 0,
  discount_amount        DECIMAL(12,2) DEFAULT 0,
  vat_amount             DECIMAL(12,2) DEFAULT 0,
  grand_total            DECIMAL(12,2) DEFAULT 0,
  payment_method         VARCHAR(50),
  notes                  TEXT,
  zatca_uuid             UUID,
  icv                    INT,
  previous_invoice_hash  TEXT,
  zatca_hash             TEXT,
  issue_time             TIME,
  xml_content            TEXT,
  zatca_qr_phase2        TEXT,
  zatca_status           VARCHAR(20) DEFAULT 'pending',
  zatca_response         TEXT,
  zatca_submitted_at     TIMESTAMPTZ,
  branch_id              INT REFERENCES branches(id),
  created_by             INT REFERENCES users(id),
  created_at             TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(note_no, company_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_notes_company_icv
  ON credit_notes(company_id, icv) WHERE icv IS NOT NULL;

CREATE TABLE IF NOT EXISTS credit_note_items (
  id                 SERIAL PRIMARY KEY,
  credit_note_id     INT NOT NULL REFERENCES credit_notes(id) ON DELETE CASCADE,
  product_id         INT REFERENCES products(id),
  product_name       VARCHAR(200),
  qty                DECIMAL(12,3) NOT NULL,
  unit_price         DECIMAL(12,2) NOT NULL,
  discount           DECIMAL(12,2) DEFAULT 0,
  line_total         DECIMAL(12,2) NOT NULL,
  vat_amount         DECIMAL(12,2) DEFAULT 0,
  vat_category_code  VARCHAR(1) DEFAULT 'S',
  sort_order         INT DEFAULT 0
);
