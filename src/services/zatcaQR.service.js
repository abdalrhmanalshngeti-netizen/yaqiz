// المرحلة الثانية للفوترة الإلكترونية — الخطوة 7: رمز QR بصيغة المرحلة الثانية
// (9 حقول TLV بدل 5 بالمرحلة الأولى) — القسم 15 من مواصفة XML (تفاصيلها الكاملة
// بملف منفصل "Security Features Implementation Standards" لا نملكه هنا؛ الحقول
// أدناه مبنية على البنية العامة الموثّقة في مصادر تكامل عامة لـZATCA Phase 2).
//
// ⚠️ الحقل التاسع (توقيع سلطة الاعتماد على المفتاح العام) يأتي من داخل الشهادة
// نفسها التي تُصدرها الهيئة عند التأهيل الفعلي (CSID) — شهادات الاختبار
// الموقَّعة ذاتيًا (self-signed) المستخدمة بفحوصاتنا المحلية لا تحتويه، لذا
// الدالة تتقبّله كمعامل اختياري وتضعه فارغًا إن لم يتوفر، مع تنبيه بالسجلّ.

function tlv(tag, valueBuffer) {
  const len = Buffer.from([valueBuffer.length]);
  return Buffer.concat([Buffer.from([tag]), len, valueBuffer]);
}

/**
 * يبني رمز QR TLV للمرحلة الثانية (9 حقول) ويُرجعه كنص base64 جاهز للترميز
 * كصورة QR (نفس ما يفعله generateQRCanvas بالواجهة الأمامية للمرحلة الأولى).
 * @param {object} opts
 * @param {object} opts.company        صف الشركة (name, vat_number)
 * @param {object} opts.invoice        صف الفاتورة (يحتاج grand_total, vat_amount, date/created_at)
 * @param {string} opts.invoiceHashBase64   تجزئة الفاتورة (من الخطوة 3) — base64
 * @param {string} opts.signatureValueBase64 قيمة التوقيع الرقمي (من الخطوة 5) — base64
 * @param {Buffer} opts.publicKeyDer   المفتاح العام (SPKI DER) من شهادة الاعتماد
 * @param {Buffer} [opts.caSignatureDer] توقيع الهيئة على المفتاح العام (من داخل الشهادة الحقيقية) — اختياري
 */
function generatePhase2QR({ company, invoice, invoiceHashBase64, signatureValueBase64, publicKeyDer, caSignatureDer }) {
  const dt = invoice.date ? new Date(invoice.date) : new Date(invoice.created_at);
  const parts = [
    tlv(1, Buffer.from(company.name || '', 'utf8')),
    tlv(2, Buffer.from(company.vat_number || '', 'utf8')),
    tlv(3, Buffer.from(dt.toISOString(), 'utf8')),
    tlv(4, Buffer.from(Number(invoice.grand_total || 0).toFixed(2), 'utf8')),
    tlv(5, Buffer.from(Number(invoice.vat_amount || 0).toFixed(2), 'utf8')),
    tlv(6, Buffer.from(invoiceHashBase64 || '', 'base64')),
    tlv(7, Buffer.from(signatureValueBase64 || '', 'base64')),
    tlv(8, publicKeyDer || Buffer.alloc(0)),
  ];
  if (caSignatureDer) parts.push(tlv(9, caSignatureDer));
  return Buffer.concat(parts).toString('base64');
}

module.exports = { generatePhase2QR };
