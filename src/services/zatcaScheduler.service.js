// إرسال دوري تلقائي للمستندات "المعلَّقة"/"المرفوضة" لدى الهيئة — يغطي فجوتين
// حرجتين لم يكن لهما أي حل: (1) الفواتير المبسّطة (نقاط البيع) ما عندها أي
// مسار إرسال تلقائي إطلاقًا (submitInvoiceBestEffort تتجاهلها عمدًا لأنها
// صُمِّمت فقط لفواتير قياسية فشل تصديقها الفوري وقت الإنشاء)، رغم أن الهيئة
// تشترط إبلاغها خلال 24 ساعة من الإصدار؛ (2) أي مستند رُفض مرة يبقى "معلَّقًا"
// بصمت للأبد بلا أي إعادة محاولة تلقائية. هذا الملف لا يبني منطق إرسال جديد —
// يعيد استخدام submitInvoiceBestEffort/submitCreditNoteBestEffort الموجودتين
// أصلًا (بحث الاعتماد، فحص xml_content، تسجيل الرفض) عبر خيار includeSimplified.
const db = require('../config/db');
const { submitInvoiceBestEffort, submitCreditNoteBestEffort } = require('./zatcaSubmit.service');
const { validateSeller, notifyIncompleteSellerData } = require('./zatca.service');

const BATCH_LIMIT = 200;
// لا نعيد محاولة مستند فشل قبل قليل كل دورة (كل 20 دقيقة) للأبد — مهلة ساعتين
// تكفي هامش أمان واسع لمهلة الـ24 ساعة الإلزامية، وتمنع إغراق الهيئة/السجلات
// بمحاولات متكررة لمستند ناقص بيانات لن ينجح قبل تدخّل يدوي من المالك
const RETRY_COOLDOWN_SQL = `(zatca_submitted_at IS NULL OR zatca_submitted_at < NOW() - INTERVAL '2 hours')`;

async function runPendingZatcaSubmissions() {
  // بيانات بائع ناقصة (validateSeller) ما كانت تمنع أي إرسال فعلي — لا وقت
  // الإنشاء ولا هنا — فيُعاد إرسال نفس المستند الناقص كل دورة (20 دقيقة) للهيئة
  // اللي سترفضه حتمًا بنفس السبب. نتحقق من بيانات كل شركة *مرة واحدة فقط* لكل
  // تمريرة (لا لكل مستند على حدة) عبر هذا التخزين المؤقت، ونؤجّل إرسال أي
  // مستند لشركة بيانات بائعها ناقصة بدل إهدار محاولة مضمونة الفشل — بلا أي
  // تأثير على إنشاء الفاتورة نفسه (يبقى غير حاجب كما هو مصمَّم أصلًا)
  const sellerCheckCache = new Map();
  async function isSellerDataComplete(companyId) {
    if (sellerCheckCache.has(companyId)) return sellerCheckCache.get(companyId);
    const { rows: [company] } = await db.query(`SELECT * FROM companies WHERE id = $1`, [companyId]);
    const warnings = company ? validateSeller(company) : ['company not found'];
    const complete = warnings.length === 0;
    sellerCheckCache.set(companyId, complete);
    if (!complete) {
      await notifyIncompleteSellerData(db, companyId, warnings).catch(() => {});
    }
    return complete;
  }

  try {
    const { rows: pendingInvoices } = await db.query(`
      SELECT id, company_id FROM invoices
      WHERE xml_content IS NOT NULL
        AND (zatca_status IS NULL OR zatca_status IN ('pending','rejected'))
        AND ${RETRY_COOLDOWN_SQL}
      ORDER BY id ASC LIMIT ${BATCH_LIMIT}
    `);
    let invoicesSubmitted = 0;
    for (const inv of pendingInvoices) {
      if (!(await isSellerDataComplete(inv.company_id))) continue;
      await submitInvoiceBestEffort(inv.id, inv.company_id, { includeSimplified: true });
      invoicesSubmitted++;
    }

    const { rows: pendingNotes } = await db.query(`
      SELECT id, company_id, invoice_type FROM credit_notes
      WHERE xml_content IS NOT NULL
        AND (zatca_status IS NULL OR zatca_status IN ('pending','rejected'))
        AND ${RETRY_COOLDOWN_SQL}
      ORDER BY id ASC LIMIT ${BATCH_LIMIT}
    `);
    let notesSubmitted = 0;
    for (const note of pendingNotes) {
      if (!(await isSellerDataComplete(note.company_id))) continue;
      const isSimplified = (note.invoice_type || 'simplified') === 'simplified';
      await submitCreditNoteBestEffort(note.id, note.company_id, isSimplified, { includeSimplified: true });
      notesSubmitted++;
    }

    return { invoicesProcessed: invoicesSubmitted, notesProcessed: notesSubmitted };
  } catch (err) {
    console.error('[ZATCA scheduler] batch run failed:', err.message);
    return { invoicesProcessed: 0, notesProcessed: 0, error: err.message };
  }
}

module.exports = { runPendingZatcaSubmissions };
