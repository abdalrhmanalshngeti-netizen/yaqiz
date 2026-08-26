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

const BATCH_LIMIT = 200;
// لا نعيد محاولة مستند فشل قبل قليل كل دورة (كل 20 دقيقة) للأبد — مهلة ساعتين
// تكفي هامش أمان واسع لمهلة الـ24 ساعة الإلزامية، وتمنع إغراق الهيئة/السجلات
// بمحاولات متكررة لمستند ناقص بيانات لن ينجح قبل تدخّل يدوي من المالك
const RETRY_COOLDOWN_SQL = `(zatca_submitted_at IS NULL OR zatca_submitted_at < NOW() - INTERVAL '2 hours')`;

async function runPendingZatcaSubmissions() {
  try {
    const { rows: pendingInvoices } = await db.query(`
      SELECT id, company_id FROM invoices
      WHERE xml_content IS NOT NULL
        AND (zatca_status IS NULL OR zatca_status IN ('pending','rejected'))
        AND ${RETRY_COOLDOWN_SQL}
      ORDER BY id ASC LIMIT ${BATCH_LIMIT}
    `);
    for (const inv of pendingInvoices) {
      await submitInvoiceBestEffort(inv.id, inv.company_id, { includeSimplified: true });
    }

    const { rows: pendingNotes } = await db.query(`
      SELECT id, company_id, invoice_type FROM credit_notes
      WHERE xml_content IS NOT NULL
        AND (zatca_status IS NULL OR zatca_status IN ('pending','rejected'))
        AND ${RETRY_COOLDOWN_SQL}
      ORDER BY id ASC LIMIT ${BATCH_LIMIT}
    `);
    for (const note of pendingNotes) {
      const isSimplified = (note.invoice_type || 'simplified') === 'simplified';
      await submitCreditNoteBestEffort(note.id, note.company_id, isSimplified, { includeSimplified: true });
    }

    return { invoicesProcessed: pendingInvoices.length, notesProcessed: pendingNotes.length };
  } catch (err) {
    console.error('[ZATCA scheduler] batch run failed:', err.message);
    return { invoicesProcessed: 0, notesProcessed: 0, error: err.message };
  }
}

module.exports = { runPendingZatcaSubmissions };
