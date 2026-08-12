// المرحلة الثانية للفوترة الإلكترونية — الخطوة 3: سلسلة تجزئة الفواتير (KSA-13/BR-KSA-26)
//
// كل فاتورة تحمل تجزئة الفاتورة السابقة لها (Previous Invoice Hash) بحيث يستحيل
// حذف أو إدراج فاتورة بمنتصف السلسلة دون كسر تسلسل التجزئة بأكمله — هذا هو الضامن
// الفني لمبدأ "لا تعديل، إلغاء فقط" الذي تفرضه الهيئة.
//
// ملاحظة مهمة على التغطية الحالية: القاعدة BR-KSA-26 تشترط تكانونة (canonicalize)
// الفاتورة بمعيار C14N11 (Canonical XML 1.1) قبل التجزئة. مكتبات Node.js المتاحة
// حاليًا (xml-crypto) تنفّذ C14N 1.0 القياسي وليس 1.1 حرفيًا — الفرق بينهما ضئيل
// جدًا عمليًا (يظهر فقط مع استخدام خصائص xml:base/xml:id النادرة، وفاتورتنا لا
// تستخدمها) لكنه ليس تطابقًا رسميًا موثقًا من الهيئة. قبل الاعتماد الفعلي في
// الإنتاج يجب التحقق من تطابق التجزئة الناتجة هنا مع نتيجة أداة التحقق الرسمية
// من بيئة المحاكاة (Fatoora Simulation Portal).

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

  const c14n = new C14nCanonicalization();
  return c14n.process(root);
}

function computeInvoiceHash(xml) {
  const canonical = canonicalizeForHash(xml);
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('base64');
}

/**
 * يحدد ICV التالي وتجزئة الفاتورة السابقة لشركة معيّنة، ضمن معاملة قائمة (لمنع
 * تسابق فاتورتين تُنشآن بنفس اللحظة). يجب استدعاؤها داخل نفس transaction إنشاء
 * الفاتورة، مع قفل صفوف الفواتير السابقة لهذه الشركة.
 */
async function nextChainInfo(client, companyId) {
  const { rows } = await client.query(
    `SELECT icv, zatca_hash FROM invoices
     WHERE company_id = $1 AND icv IS NOT NULL
     ORDER BY icv DESC LIMIT 1 FOR UPDATE`,
    [companyId]
  );
  const last = rows[0];
  return {
    icv: (last?.icv || 0) + 1,
    previousInvoiceHash: last?.zatca_hash || FIRST_INVOICE_HASH,
  };
}

module.exports = { FIRST_INVOICE_HASH, canonicalizeForHash, computeInvoiceHash, nextChainInfo };
