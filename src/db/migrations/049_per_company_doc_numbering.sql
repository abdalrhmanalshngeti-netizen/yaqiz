-- عدّاد ترقيم مستندات مستقل لكل شركة — يحل محل التسلسلات العامة المشتركة
-- بين كل شركات المنصة (invoice_seq, purchase_seq, ...) اللي كانت تجعل رقم
-- فاتورة الشركة يقفز حسب نشاط شركات أخرى، وهو ما يخالف اشتراط الفوترة
-- الإلكترونية السعودية بترقيم تسلسلي لكل شركة تحديدًا. نفس نمط
-- zatca_chain_state (قفل صف company_id عبر FOR UPDATE داخل معاملة الاستدعاء).
CREATE TABLE IF NOT EXISTS doc_number_counters (
  company_id  INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  doc_type    VARCHAR(30) NOT NULL,
  last_number INT NOT NULL DEFAULT 0,
  PRIMARY KEY (company_id, doc_type)
);

-- تعبئة أولية: كل شركة تبدأ عدّادها من عدد مستنداتها الحالي — يضمن استمرار
-- الترقيم للأمام بلا تصادم مع أرقام قديمة (بعضها موقَّع فعليًا بـZATCA)،
-- بلا أي إعادة ترقيم للمستندات التاريخية. آمنة لإعادة التشغيل (last_number
-- يبقى دائمًا مساويًا لعدد الصفوف الفعلي طالما كل زيادة عدّاد ترافقها فعليًا
-- صف واحد مُنشأ، لأن nextDocNumber يعيش داخل نفس معاملة إنشاء المستند).
INSERT INTO doc_number_counters (company_id, doc_type, last_number)
SELECT company_id, 'invoice', COUNT(*) FROM invoices GROUP BY company_id
ON CONFLICT (company_id, doc_type) DO UPDATE SET last_number = EXCLUDED.last_number;

INSERT INTO doc_number_counters (company_id, doc_type, last_number)
SELECT company_id, 'purchase', COUNT(*) FROM purchases GROUP BY company_id
ON CONFLICT (company_id, doc_type) DO UPDATE SET last_number = EXCLUDED.last_number;

INSERT INTO doc_number_counters (company_id, doc_type, last_number)
SELECT company_id, 'quote', COUNT(*) FROM quotes GROUP BY company_id
ON CONFLICT (company_id, doc_type) DO UPDATE SET last_number = EXCLUDED.last_number;

INSERT INTO doc_number_counters (company_id, doc_type, last_number)
SELECT company_id, 'po', COUNT(*) FROM purchase_orders GROUP BY company_id
ON CONFLICT (company_id, doc_type) DO UPDATE SET last_number = EXCLUDED.last_number;

INSERT INTO doc_number_counters (company_id, doc_type, last_number)
SELECT company_id, 'return', COUNT(*) FROM returns GROUP BY company_id
ON CONFLICT (company_id, doc_type) DO UPDATE SET last_number = EXCLUDED.last_number;

INSERT INTO doc_number_counters (company_id, doc_type, last_number)
SELECT company_id, 'entry', COUNT(*) FROM journal_entries GROUP BY company_id
ON CONFLICT (company_id, doc_type) DO UPDATE SET last_number = EXCLUDED.last_number;

INSERT INTO doc_number_counters (company_id, doc_type, last_number)
SELECT company_id, 'credit_note', COUNT(*) FROM credit_notes GROUP BY company_id
ON CONFLICT (company_id, doc_type) DO UPDATE SET last_number = EXCLUDED.last_number;

INSERT INTO doc_number_counters (company_id, doc_type, last_number)
SELECT company_id, 'transfer', COUNT(*) FROM stock_transfers GROUP BY company_id
ON CONFLICT (company_id, doc_type) DO UPDATE SET last_number = EXCLUDED.last_number;

INSERT INTO doc_number_counters (company_id, doc_type, last_number)
SELECT company_id, 'payroll', COUNT(*) FROM payroll GROUP BY company_id
ON CONFLICT (company_id, doc_type) DO UPDATE SET last_number = EXCLUDED.last_number;

-- سندات القبض والصرف يشتركان بعدّاد واحد (نفس السلوك الحالي بالضبط عبر
-- voucher_seq — لا تغيير بمنطق تداخل ترقيمهما، فقط يصير لكل شركة عدّادها)
INSERT INTO doc_number_counters (company_id, doc_type, last_number)
SELECT company_id, 'voucher', COUNT(*) FROM vouchers GROUP BY company_id
ON CONFLICT (company_id, doc_type) DO UPDATE SET last_number = EXCLUDED.last_number;

-- ملاحظة: grn_seq/goods_receipts كود ميت بالكامل (لا INSERT واحد له بكل
-- الباكند) — لا عدّاد جديد له عمدًا، ولا تعديل على أي كنترولر بخصوصه.
