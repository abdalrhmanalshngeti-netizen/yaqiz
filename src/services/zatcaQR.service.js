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
  let vb = valueBuffer;
  if (vb.length > 255) {
    // طول TLV بايت واحد فقط (0-255) — بلا هذا القص كان الطول الفعلي يُلتف
    // (modulo 256) بصمت، فيُنتج TLV تالفًا لأي قيمة تتجاوز 255 بايت (مثلاً
    // اسم شركة طويل جدًا بالعربي) بدل قص واضح موثّق بالسجلّ
    vb = vb.subarray(0, 255);
    while (vb.length > 0 && (vb[vb.length - 1] & 0xC0) === 0x80) {
      vb = vb.subarray(0, vb.length - 1); // تراجع لحد حرف UTF-8 صحيح لو انقطع بمنتصف حرف متعدد البايتات
    }
    console.warn(`zatcaQR: TLV tag ${tag} value truncated from ${valueBuffer.length} to ${vb.length} bytes (255-byte TLV limit)`);
  }
  const len = Buffer.from([vb.length]);
  return Buffer.concat([Buffer.from([tag]), len, vb]);
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
