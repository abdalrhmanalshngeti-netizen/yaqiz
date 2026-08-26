// المرحلة الثانية للفوترة الإلكترونية — الخطوة 5: التوقيع الرقمي XAdES-BES
//
// ⚠️ حالة التحقق (آخر تحديث: اختبار فعلي ضد أداة الهيئة الرسمية SDK 3.4.8،
// بشهادة اختبار موقَّعة ذاتيًا مُدرَجة يدويًا كبيانات اعتماد "إنتاج" مؤقتة):
// ✅ البنية الهيكلية الكاملة (cac:Signature المرجعي + sig:UBLDocumentSignatures/
//    sac:SignatureInformation المُغلِّف لـds:Signature داخل ext:UBLExtensions)
//    مؤكَّدة صحيحة 100% — فاتورة موقَّعة بهذا الكود تمر XSD/EN16931/KSA كاملة
//    (كانت البنية القديمة، رغم توقيعها الصحيح تشفيريًا، غير قابلة للاكتشاف
//    إطلاقًا من مسارات الفحص الفعلية للهيئة، فتُعامَل كمستند "بلا ختم تشفيري").
// ❌ **لا تزال قيم التجزئة/التوقيع الفعلية (SIGNATURE check) لا تطابق ما تعيد
//    الهيئة حسابه** (xadesSignedPropertiesDigestValue, signatureValue,
//    signingCertificateDigestValue, X509IssuerName) — جرَّبنا التبديل لـC14N
//    الحصري (Exclusive) بدل C14N 1.1 العادي (المنطق الأصح نظريًا لتجزئة شظية
//    معزولة عن سياق مستند أكبر) بلا أي تحسّن ملحوظ؛ يعني الخلل أعمق من مجرد
//    خوارزمية الـcanonicalization المُعلَنة. المستند المرجعي الوحيد اللي كان
//    يحتمل يحسم هذا ("Security Features Implementation Standards") لم يعد
//    منشورًا بموقع الهيئة (بحثنا فعليًا، رابطه القديم 404). **لا تثق بصحة
//    التوقيع الفعلي هنا حتى تحقق حقيقي عبر بيئة الهيئة (Sandbox/Simulation)
//    أو نسخة أحدث من الأداة توفّر تفاصيل أدق بسجلّ الأخطاء.**
// راجع الذاكرة (zatca_sdk_real_validation_2026_08_26) لتفاصيل الاختبار الكامل.

const crypto = require('crypto');
const { DOMParser } = require('@xmldom/xmldom');
const { ExclusiveCanonicalization } = require('xml-crypto');

// كنا نستخدم C14N العادي (غير الحصري) — نتيجته تعتمد فعليًا على كل الفضاءات
// الاسمية الموروثة من كل العناصر الأب بالمستند الكامل وقت التضمين النهائي
// (cac/cbc/ext/الافتراضي بمستوى الفاتورة)، لا فقط الفضائين اللي نضيفهما هنا
// بغلاف <root> مؤقت للتجزئة المعزولة — فتختلف التجزئة الناتجة فعليًا عن التي
// تُعيد الهيئة حسابها على نفس الشظية بموضعها الحقيقي بالمستند (تأكَّدنا من هذا
// عبر أداة تحقق الهيئة: xadesSignedPropertiesDigestValue/signatureValue خاطئان
// رغم توقيع صحيح تشفيريًا). C14N الحصري (Exclusive) مصمَّم خصيصًا لهذا: لا
// يعتمد على السياق الموروث إطلاقًا، فحساب معزول كهذا يطابق أي حساب آخر على
// نفس الشظية بأي موضع تضمين — الخيار الصحيح لتوقيع أجزاء مُقتطَعة من مستند أكبر
function c14n(xmlFragmentOrNode) {
  const c = new ExclusiveCanonicalization();
  if (typeof xmlFragmentOrNode === 'string') {
    const doc = new DOMParser().parseFromString(`<root xmlns:ds="http://www.w3.org/2000/09/xmldsig#" xmlns:xades="http://uri.etsi.org/01903/v1.3.2#">${xmlFragmentOrNode}</root>`, 'text/xml');
    return c.process(doc.documentElement.firstChild, {});
  }
  return c.process(xmlFragmentOrNode, {});
}

function sha256Base64(input) {
  return crypto.createHash('sha256').update(input, typeof input === 'string' ? 'utf8' : undefined).digest('base64');
}

/**
 * يوقّع فاتورة XML توقيعًا رقميًا XAdES-BES ويُرجع الشظية الجاهزة للحقن مكان
 * ext:UBLExtensions الفارغ الذي وضعه zatca.service.js.
 * @param {object} opts
 * @param {string} opts.invoiceHash تجزئة الفاتورة (base64) المحسوبة بالخطوة 3 — هي نفسها القيمة الموقَّعة كمرجع أساسي
 * @param {string} opts.certificatePem شهادة X.509 (PEM) من بيانات اعتماد الشركة
 * @param {string} opts.privateKeyPem  المفتاح الخاص (PEM) المطابق للشهادة
 */
function buildXadesSignature({ invoiceHash, certificatePem, privateKeyPem }) {
  const cert = new crypto.X509Certificate(certificatePem);
  const certDerBase64 = Buffer.from(cert.raw).toString('base64');
  const certDigest = sha256Base64(cert.raw);
  const issuerName = cert.issuer.split('\n').reverse().join(',');
  const serialNumber = BigInt('0x' + cert.serialNumber).toString(10);

  const signingTime = new Date().toISOString().split('.')[0] + 'Z';
  const signedPropsId = 'xadesSignedProperties';
  const signatureId = 'signature';

  const signedProperties =
    `<xades:SignedProperties xmlns:xades="http://uri.etsi.org/01903/v1.3.2#" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" Id="${signedPropsId}">` +
      `<xades:SignedSignatureProperties>` +
        `<xades:SigningTime>${signingTime}</xades:SigningTime>` +
        `<xades:SigningCertificate>` +
          `<xades:Cert>` +
            `<xades:CertDigest>` +
              `<ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>` +
              `<ds:DigestValue>${certDigest}</ds:DigestValue>` +
            `</xades:CertDigest>` +
            `<xades:IssuerSerial>` +
              `<ds:X509IssuerName>${issuerName}</ds:X509IssuerName>` +
              `<ds:X509SerialNumber>${serialNumber}</ds:X509SerialNumber>` +
            `</xades:IssuerSerial>` +
          `</xades:Cert>` +
        `</xades:SigningCertificate>` +
      `</xades:SignedSignatureProperties>` +
    `</xades:SignedProperties>`;

  const signedPropertiesDigest = sha256Base64(c14n(signedProperties));

  const signedInfo =
    `<ds:SignedInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#">` +
      `<ds:CanonicalizationMethod Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"/>` +
      `<ds:SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256"/>` +
      `<ds:Reference Id="invoiceSignedData" URI="">` +
        `<ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>` +
        `<ds:DigestValue>${invoiceHash}</ds:DigestValue>` +
      `</ds:Reference>` +
      `<ds:Reference Type="http://www.w3.org/2000/09/xmldsig#SignatureProperties" URI="#${signedPropsId}">` +
        `<ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>` +
        `<ds:DigestValue>${signedPropertiesDigest}</ds:DigestValue>` +
      `</ds:Reference>` +
    `</ds:SignedInfo>`;

  const signedInfoCanonical = c14n(signedInfo);
  const privateKeyObj = crypto.createPrivateKey(privateKeyPem);
  const signatureValue = crypto.sign('sha256', Buffer.from(signedInfoCanonical, 'utf8'), privateKeyObj).toString('base64');

  const signatureXml =
    `<ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#" xmlns:xades="http://uri.etsi.org/01903/v1.3.2#" Id="${signatureId}">` +
      signedInfo +
      `<ds:SignatureValue>${signatureValue}</ds:SignatureValue>` +
      `<ds:KeyInfo>` +
        `<ds:X509Data>` +
          `<ds:X509Certificate>${certDerBase64}</ds:X509Certificate>` +
        `</ds:X509Data>` +
      `</ds:KeyInfo>` +
      `<ds:Object>` +
        `<xades:QualifyingProperties Target="#${signatureId}">${signedProperties}</xades:QualifyingProperties>` +
      `</ds:Object>` +
    `</ds:Signature>`;

  // ext:ExtensionContent يحتاج التوقيع مغلَّفًا بـsig:UBLDocumentSignatures/
  // sac:SignatureInformation (لا ds:Signature مباشرة) — تأكَّدنا من هذا فعليًا
  // ضد XSD الرسمي (UBL-CommonSignatureComponents-2.1.xsd) بعد ما اكتشفنا عبر
  // أداة تحقق الهيئة الرسمية إن التوقيع السابق (ds:Signature مباشرة بلا هذا
  // الغلاف) كان "موجودًا" هيكليًا لكن غير قابل للاكتشاف بمسار XPath الذي
  // تفحصه الهيئة فعليًا (BR-KSA-28/60)، فيُعامَل كأنه مفقود بالكامل رغم توقيعه
  const signatureInfoXml =
    `<sig:UBLDocumentSignatures xmlns:sig="urn:oasis:names:specification:ubl:schema:xsd:CommonSignatureComponents-2" xmlns:sac="urn:oasis:names:specification:ubl:schema:xsd:SignatureAggregateComponents-2" xmlns:sbc="urn:oasis:names:specification:ubl:schema:xsd:SignatureBasicComponents-2">` +
      `<sac:SignatureInformation>` +
        `<cbc:ID xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">urn:oasis:names:specification:ubl:signature:1</cbc:ID>` +
        `<sbc:ReferencedSignatureID>urn:oasis:names:specification:ubl:signature:Invoice</sbc:ReferencedSignatureID>` +
        signatureXml +
      `</sac:SignatureInformation>` +
    `</sig:UBLDocumentSignatures>`;

  return {
    signatureXml,
    ublExtensionsXml:
      `<ext:UBLExtensions xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2">` +
        `<ext:UBLExtension>` +
          `<ext:ExtensionURI>urn:oasis:names:specification:ubl:dsig:enveloped:xades</ext:ExtensionURI>` +
          `<ext:ExtensionContent>${signatureInfoXml}</ext:ExtensionContent>` +
        `</ext:UBLExtension>` +
      `</ext:UBLExtensions>`,
    signatureValue, certDigest, signingTime,
  };
}

/** يحقن التوقيع الجاهز مكان <ext:UBLExtensions/> الفارغ داخل XML الفاتورة */
function embedSignature(invoiceXml, ublExtensionsXml) {
  if (!invoiceXml.includes('<ext:UBLExtensions/>')) {
    throw new Error('لم يُعثر على عنصر ext:UBLExtensions الفارغ داخل XML — تأكد أن الفاتورة وُلِّدت عبر zatca.service.js');
  }
  return invoiceXml.replace('<ext:UBLExtensions/>', ublExtensionsXml);
}

// يحقن رمز QR (base64) مكان عنصر EmbeddedDocumentBinaryObject الفارغ الموسوم
// بمعرّف QR الذي وضعه zatca.service.js — نفس أسلوب الاستبدال النصي لـembedSignature
// بالضبط. نبحث تحديدًا عن الشظية التالية لـ<cbc:ID>QR</cbc:ID> (وليس أي عنصر
// EmbeddedDocumentBinaryObject فارغ آخر بالمستند، مثل PIH لو كانت تجزئته فارغة)
function embedQR(invoiceXml, qrBase64) {
  const qrPlaceholder = /(<cbc:ID>QR<\/cbc:ID>\s*<cac:Attachment>\s*<cbc:EmbeddedDocumentBinaryObject mimeCode="text\/plain")\/>/;
  if (!qrPlaceholder.test(invoiceXml)) {
    throw new Error('لم يُعثر على عنصر QR الفارغ داخل XML — تأكد أن الفاتورة وُلِّدت عبر zatca.service.js');
  }
  return invoiceXml.replace(qrPlaceholder, `$1>${qrBase64}</cbc:EmbeddedDocumentBinaryObject>`);
}

module.exports = { buildXadesSignature, embedSignature, embedQR, c14n, sha256Base64 };
