// المرحلة الثانية للفوترة الإلكترونية — الخطوة 5: التوقيع الرقمي XAdES-BES
//
// ⚠️ حالة التحقق: البنية العامة هنا (ds:Signature بمرجعين — مستند الفاتورة
// وxades:SignedProperties — موقّعين بمعيار XAdES-BES القياسي) صحيحة ومطابقة
// لمعيار W3C XMLDSig / ETSI XAdES-BES العام، والتوقيع نفسه (ECDSA-secp256k1)
// تحقّقنا من صحته فعليًا محليًا (توليد شهادة اختبار موقَّعة ذاتيًا، توقيع فاتورة،
// ثم التحقق من التوقيع عبر Node crypto.verify() مباشرة — راجع سكربت الاختبار).
// **غير مؤكَّد بعد**: القيم الدقيقة لبعض المعرّفات (Id) والحقول التي قد تشترطها
// أداة تحقق الهيئة تحديدًا (موثّقة بملف "Security Features Implementation
// Standards" المنفصل الذي لا نملكه بهذه المحادثة) — يجب مقارنتها قبل أول إرسال
// فعلي، ويُفضَّل التحقق من أول فاتورة موقَّعة عبر أداة الهيئة الرسمية أولًا.

const crypto = require('crypto');
const { DOMParser } = require('@xmldom/xmldom');
const { C14nCanonicalization } = require('xml-crypto');

function c14n(xmlFragmentOrNode) {
  const c = new C14nCanonicalization();
  if (typeof xmlFragmentOrNode === 'string') {
    const doc = new DOMParser().parseFromString(`<root xmlns:ds="http://www.w3.org/2000/09/xmldsig#" xmlns:xades="http://uri.etsi.org/01903/v1.3.2#">${xmlFragmentOrNode}</root>`, 'text/xml');
    return c.process(doc.documentElement.firstChild);
  }
  return c.process(xmlFragmentOrNode);
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
      `<ds:CanonicalizationMethod Algorithm="http://www.w3.org/2006/12/xml-c14n11"/>` +
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

  return {
    signatureXml,
    ublExtensionsXml:
      `<ext:UBLExtensions xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2">` +
        `<ext:UBLExtension>` +
          `<ext:ExtensionURI>urn:oasis:names:specification:ubl:dsig:enveloped:xades</ext:ExtensionURI>` +
          `<ext:ExtensionContent>${signatureXml}</ext:ExtensionContent>` +
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
