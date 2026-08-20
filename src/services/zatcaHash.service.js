// المرحلة الثانية للفوترة الإلكترونية — الخطوة 3: سلسلة تجزئة الفواتير (KSA-13/BR-KSA-26)
//
// كل فاتورة تحمل تجزئة الفاتورة السابقة لها (Previous Invoice Hash) بحيث يستحيل
// حذف أو إدراج فاتورة بمنتصف السلسلة دون كسر تسلسل التجزئة بأكمله — هذا هو الضامن
// الفني لمبدأ "لا تعديل، إلغاء فقط" الذي تفرضه الهيئة.
//
// ملاحظة مهمة على التغطية الحالية: القاعدة BR-KSA-26 تشترط تكانونة (canonicalize)
// الفاتورة بمعيار C14N11 (Canonical XML 1.1) قبل التجزئة. مكتبات Node.js المتاحة
// حاليًا (xml-crypto 6.1.2 — تحقّقنا فعليًا: لا تصدّر أي تنفيذ لـC14N 1.1، فقط
// C14nCanonicalization/ExclusiveCanonicalization) تنفّذ C14N 1.0 القياسي فقط.
// الفرقان الوحيدان الموثّقان بين 1.0 و1.1 يخصّان معالجة خاصيتَي xml:base وxml:id
// الموروثتين — ودالة assertNoC14N11Divergence أدناه تتحقق برمجيًا من كل مستند
// قبل تجزئته أنه لا يحتوي أيًا منهما، فتجعل الفرق بين النسختين معدومًا فعليًا
// لهذا المستند تحديدًا (لا "على الأغلب" فقط). هذا ضمان على شكل المستند الحالي،
// وليس بديلاً عن التحقق الرسمي: **لا يوجد بهذه البيئة حساب/شهادة إنتاج حقيقية
// من الهيئة**، فالتحقق الفعلي من مطابقة التجزئة الناتجة هنا مع أداة التحقق
// الرسمية من بيئة المحاكاة (Fatoora Simulation Portal) يتطلب حساب Fatoora حقيقي
// لهذه المنشأة ورمز OTP منه — خطوة يدوية لصاحب الحساب فقط قبل أي اعتماد إنتاجي.

const crypto = require('crypto');
const { DOMParser } = require('@xmldom/xmldom');
const { C14nCanonicalization } = require('xml-crypto');

// القيمة الخاصة بالفاتورة الأولى بالسلسلة — base64 لتجزئة SHA-256 لحرف "0" (نص القاعدة BR-KSA-26 بالمواصفة حرفيًا)
const FIRST_INVOICE_HASH =
  'NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==';

// يحذف من شجرة XML أي عنصر ابن مباشر لجذر Invoice يطابق [localName, أو localName+معرّف ID فرعي]
function removeDirectChildren(root, predicate) {
  const toRemove = [];
  for (let i = 0; i < root.childNodes.length; i++) {
    const node = root.childNodes[i];
    if (node.nodeType === 1 && predicate(node)) toRemove.push(node);
  }
  toRemove.forEach(n => root.removeChild(n));
}

function localName(node) {
  return node.localName || node.nodeName.split(':').pop();
}

function firstChildText(node, ln) {
  for (let i = 0; i < node.childNodes.length; i++) {
    const c = node.childNodes[i];
    if (c.nodeType === 1 && localName(c) === ln) return c.textContent;
  }
  return null;
}

// يتحقق أن الشجرة كاملة خالية من xml:base وxml:id — الخاصيتان الوحيدتان
// اللتان يختلف فيهما سلوك C14N 1.1 عن 1.0 (راجع الملاحظة أعلى الملف). لو ظهرت
// أي منهما مستقبلاً (مثلاً بتوسعة لاحقة لبنية XML)، يجب التوقف والتحقق الفعلي
// من فرق التجزئة بدل الاستمرار بافتراض غير مضمون
function assertNoC14N11Divergence(node) {
  if (node.nodeType === 1) {
    const attrs = node.attributes;
    for (let i = 0; i < (attrs?.length || 0); i++) {
      const a = attrs[i];
      if (a.nodeName === 'xml:base' || a.nodeName === 'xml:id') {
        throw new Error(
          `عنصر <${node.nodeName}> يستخدم ${a.nodeName} — هذا يكسر افتراض تطابق C14N 1.0/1.1 ` +
          `الموثّق أعلى zatcaHash.service.js، ويحتاج تحقق فعلي من التجزئة قبل المتابعة`
        );
      }
    }
  }
  const children = node.childNodes;
  for (let i = 0; i < (children?.length || 0); i++) assertNoC14N11Divergence(children[i]);
}

/**
 * يحضّر XML الفاتورة للتجزئة حسب خطوات BR-KSA-26:
 * 1) حذف UBLExtensions  2) حذف AdditionalDocumentReference الذي معرّفه QR
 * 3) حذف Signature  4) تكانونة  5) SHA-256  6) base64
 */
function canonicalizeForHash(xml) {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const root = doc.documentElement;

  removeDirectChildren(root, (n) => localName(n) === 'UBLExtensions');
  removeDirectChildren(root, (n) =>
    localName(n) === 'AdditionalDocumentReference' && firstChildText(n, 'ID') === 'QR'
  );
  removeDirectChildren(root, (n) => localName(n) === 'Signature');

  assertNoC14N11Divergence(root);

  const c14n = new C14nCanonicalization();
  return c14n.process(root);
}

function computeInvoiceHash(xml) {
  const canonical = canonicalizeForHash(xml);
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('base64');
}

/**
 * يحدد ICV التالي وتجزئة المستند السابق لشركة معيّنة، ضمن معاملة قائمة (لمنع
 * تسابق مستندين يُنشآن بنفس اللحظة). يجب استدعاؤها داخل نفس transaction إنشاء
 * الفاتورة أو إشعار الدائن، مع قفل صف حالة السلسلة الموحّدة لهذه الشركة —
 * السلسلة تغطي الفواتير وإشعارات الدائن معًا (BR-KSA-26 تشترط سلسلة واحدة
 * متصلة، لا سلسلتين منفصلتين حسب نوع المستند). ICV يُخصَّص نهائيًا فور هذا
 * الاستدعاء حتى لو فشل توليد XML لاحقًا للمستند نفسه — نفس تسامح النظام مع
 * رقم الفاتورة العادي، المرتبط بوجود الصف لا بنجاح توليد XML.
 */
async function nextChainInfo(client, companyId) {
  await client.query(`
    INSERT INTO zatca_chain_state (company_id, last_icv, last_hash)
    VALUES ($1, 0, NULL) ON CONFLICT (company_id) DO NOTHING
  `, [companyId]);
  const { rows: [state] } = await client.query(
    `SELECT last_icv, last_hash FROM zatca_chain_state WHERE company_id = $1 FOR UPDATE`,
    [companyId]
  );
  const icv = (state.last_icv || 0) + 1;
  await client.query(`UPDATE zatca_chain_state SET last_icv = $1 WHERE company_id = $2`, [icv, companyId]);
  return { icv, previousInvoiceHash: state.last_hash || FIRST_INVOICE_HASH };
}

/**
 * تُستدعى بعد نجاح حساب تجزئة مستند (فاتورة أو إشعار دائن) — تُحدّث آخر تجزئة
 * معروفة بالسلسلة الموحّدة لتُستخدم كـ"تجزئة سابقة" للمستند التالي أيًا كان
 * نوعه. لو فشل توليد XML ولم تُستدعَ هذي الدالة، المستند التالي يرث نفس
 * "التجزئة السابقة" اللي ورثها هذا المستند (فجوة معروفة موروثة من نفس تسامح
 * النظام الحالي مع فشل توليد XML، غير حصرية لإشعارات الدائن).
 */
async function commitChainHash(client, companyId, hash) {
  await client.query(`UPDATE zatca_chain_state SET last_hash = $1 WHERE company_id = $2`, [hash, companyId]);
}

module.exports = { FIRST_INVOICE_HASH, canonicalizeForHash, computeInvoiceHash, nextChainInfo, commitChainHash };
