// المرحلة الثانية للفوترة الإلكترونية — الخطوة 5: التوقيع الرقمي XAdES-BES
//
// ⚠️ حالة التحقق (آخر تحديث: 5 محاولات إصلاح مختلفة، كل واحدة مختبَرة فعليًا
// ضد أداة الهيئة الرسمية SDK 3.4.8 بشهادة اختبار موقَّعة ذاتيًا):
// ✅ البنية الهيكلية الكاملة (cac:Signature المرجعي + sig:UBLDocumentSignatures/
//    sac:SignatureInformation المُغلِّف لـds:Signature داخل ext:UBLExtensions)
//    مؤكَّدة صحيحة 100% — فاتورة موقَّعة بهذا الكود تمر XSD/EN16931/KSA كاملة.
// ✅ أصلحنا فعليًا (ومؤكَّد بمعزل، عبر اختبار مباشر لسلوك مكتبة xml-crypto)
//    باغًا حقيقيًا بمكتبة C14N: عند تجزئة عقدة جذرها لا يحتاج فضاءً اسميًا
//    معيّنًا بينما أحفاده يحتاجونه (موروث من جدّ أبعد خارج نطاق التجزئة)،
//    المكتبة تكرّر إعلان الفضاء عند كل استخدام بدل إعلانه مرة واحدة بالجذر —
//    غير مطابق لمعيار C14N إطلاقًا. الحل: إعلان xmlns:ds صراحة على
//    xades:SignedProperties نفسها. كذلك أعدنا بناء الحساب ليعمل على العقد
//    الحقيقية المتصلة بشجرة المستند الكاملة (لا شظايا نصية معزولة)، بنفس
//    أسلوب canonicalizeForHash الناجح أصلًا لحساب PIH.
// ❌ **رغم كل هذا، لا تزال قيم xadesSignedPropertiesDigestValue/signatureValue/
//    signingCertificateDigestValue/X509IssuerName "خاطئة" حسب أداة الهيئة —
//    بلا أي تغيّر ملحوظ عبر 5 محاولات مختلفة وصحيحة كل واحدة على حدة (تحقّقنا
//    من التطابق الداخلي لكل قيمة بمعزل عن الأداة: CertDigest وSignedProperties
//    digest كلاهما ذاتي الاتساق 100% مع محتوى الشهادة/الشظية الفعليين).**
//    هذا يرجّح أن المشكلة المتبقية إما تفصيلة دقيقة غير موثَّقة إلا بملف
//    "Security Features Implementation Standards" (غير منشور حاليًا رغم البحث
//    الفعلي)، أو قصور بفحص [SIGNATURE] بهذا الإصدار من الأداة نفسه عند استبدال
//    شهادتها الافتراضية بشهادة اختبار خارجية عبر config.json. **لا تثق بصحة
//    التوقيع الفعلي هنا حتى تحقق حقيقي عبر بيئة الهيئة (Sandbox/Simulation)
//    بحساب Fatoora حقيقي، أو نسخة أخرى من الأداة/توثيق يوضّح هذا التحديدًا.**
// راجع الذاكرة (zatca_sdk_real_validation_2026_08_26) لتفاصيل كل المحاولات.

const crypto = require('crypto');
const { DOMParser, XMLSerializer } = require('@xmldom/xmldom');
const { C14nCanonicalization } = require('xml-crypto');

// C14N 1.1 العادي (غير الحصري) — يطابق ما تفرضه BR-KSA-26 صراحة لتجزئة PIH،
// ونستخدمه هنا أيضًا. صحته تعتمد على حساب العقدة بموضعها الحقيقي المتصل بالشجرة
// الكاملة (كل الفضاءات الاسمية الموروثة من الأجداد)، لا على شظية معزولة — هذا ما
// تضمنه buildXadesSignature أدناه بحقن الهيكل داخل المستند الحقيقي قبل الحساب
function c14n(node) {
  const c = new C14nCanonicalization();
  return c.process(node, {});
}

function sha256Base64(input) {
  return crypto.createHash('sha256').update(input, typeof input === 'string' ? 'utf8' : undefined).digest('base64');
}

function localName(node) {
  return node.localName || node.nodeName.split(':').pop();
}

function findByLocalName(node, name) {
  if (!node) return null;
  if (node.nodeType === 1 && localName(node) === name) return node;
  const children = node.childNodes;
  for (let i = 0; i < (children?.length || 0); i++) {
    const found = findByLocalName(children[i], name);
    if (found) return found;
  }
  return null;
}

function collectByLocalName(node, name, out) {
  if (node.nodeType === 1 && localName(node) === name) out.push(node);
  for (let i = 0; i < (node.childNodes?.length || 0); i++) collectByLocalName(node.childNodes[i], name, out);
  return out;
}

/**
 * يوقّع فاتورة XML توقيعًا رقميًا XAdES-BES ويُرجع مستند الفاتورة الكامل موقَّعًا.
 * @param {object} opts
 * @param {string} opts.unsignedXml   XML الفاتورة الكامل (بعنصر ext:UBLExtensions الفارغ) من zatca.service.js
 * @param {string} opts.invoiceHash تجزئة الفاتورة (base64) المحسوبة بالخطوة 3 — هي نفسها القيمة الموقَّعة كمرجع أساسي
 * @param {string} opts.certificatePem شهادة X.509 (PEM) من بيانات اعتماد الشركة
 * @param {string} opts.privateKeyPem  المفتاح الخاص (PEM) المطابق للشهادة
 */
function buildXadesSignature({ unsignedXml, invoiceHash, certificatePem, privateKeyPem }) {
  if (!unsignedXml.includes('<ext:UBLExtensions/>')) {
    throw new Error('لم يُعثر على عنصر ext:UBLExtensions الفارغ داخل XML — تأكد أن الفاتورة وُلِّدت عبر zatca.service.js');
  }

  const cert = new crypto.X509Certificate(certificatePem);
  const certDerBase64 = Buffer.from(cert.raw).toString('base64');
  const certDigest = sha256Base64(cert.raw);
  const issuerName = cert.issuer.split('\n').reverse().join(',');
  const serialNumber = BigInt('0x' + cert.serialNumber).toString(10);

  const signingTime = new Date().toISOString().split('.')[0] + 'Z';
  const signedPropsId = 'xadesSignedProperties';
  const signatureId = 'signature';

  // هيكل التوقيع الكامل بقيم فارغة مبدئيًا لـDigestValue الخاص بـSignedProperties
  // وSignatureValue — تُحسَب الاثنتان لاحقًا من العقد الحقيقية بعد الحقن بالشجرة
  const skeletonXml =
    `<ext:UBLExtensions xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2">` +
      `<ext:UBLExtension>` +
        `<ext:ExtensionURI>urn:oasis:names:specification:ubl:dsig:enveloped:xades</ext:ExtensionURI>` +
        `<ext:ExtensionContent>` +
          `<sig:UBLDocumentSignatures xmlns:sig="urn:oasis:names:specification:ubl:schema:xsd:CommonSignatureComponents-2" xmlns:sac="urn:oasis:names:specification:ubl:schema:xsd:SignatureAggregateComponents-2" xmlns:sbc="urn:oasis:names:specification:ubl:schema:xsd:SignatureBasicComponents-2">` +
            `<sac:SignatureInformation>` +
              `<cbc:ID>urn:oasis:names:specification:ubl:signature:1</cbc:ID>` +
              `<sbc:ReferencedSignatureID>urn:oasis:names:specification:ubl:signature:Invoice</sbc:ReferencedSignatureID>` +
              `<ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#" xmlns:xades="http://uri.etsi.org/01903/v1.3.2#" Id="${signatureId}">` +
                `<ds:SignedInfo>` +
                  `<ds:CanonicalizationMethod Algorithm="http://www.w3.org/2006/12/xml-c14n11"/>` +
                  `<ds:SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256"/>` +
                  `<ds:Reference Id="invoiceSignedData" URI="">` +
                    `<ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>` +
                    `<ds:DigestValue>${invoiceHash}</ds:DigestValue>` +
                  `</ds:Reference>` +
                  `<ds:Reference Type="http://www.w3.org/2000/09/xmldsig#SignatureProperties" URI="#${signedPropsId}">` +
                    `<ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>` +
                    `<ds:DigestValue></ds:DigestValue>` +
                  `</ds:Reference>` +
                `</ds:SignedInfo>` +
                `<ds:SignatureValue></ds:SignatureValue>` +
                `<ds:KeyInfo>` +
                  `<ds:X509Data>` +
                    `<ds:X509Certificate>${certDerBase64}</ds:X509Certificate>` +
                  `</ds:X509Data>` +
                `</ds:KeyInfo>` +
                `<ds:Object>` +
                  `<xades:QualifyingProperties Target="#${signatureId}">` +
                    `<xades:SignedProperties xmlns:ds="http://www.w3.org/2000/09/xmldsig#" Id="${signedPropsId}">` +
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
                    `</xades:SignedProperties>` +
                  `</xades:QualifyingProperties>` +
                `</ds:Object>` +
              `</ds:Signature>` +
            `</sac:SignatureInformation>` +
          `</sig:UBLDocumentSignatures>` +
        `</ext:ExtensionContent>` +
      `</ext:UBLExtension>` +
    `</ext:UBLExtensions>`;

  // نحقن الهيكل مكان ext:UBLExtensions الفارغ نصيًا أولًا (نفس نمط الاستبدال
  // القديم)، ثم نحلّل المستند الكامل كـDOM حقيقي متصل — من هذه اللحظة،
  // SignedProperties/SignedInfo عقد حقيقية بموضعها النهائي الفعلي بالشجرة
  const withSkeleton = unsignedXml.replace('<ext:UBLExtensions/>', skeletonXml);
  const doc = new DOMParser().parseFromString(withSkeleton, 'text/xml');

  // 1) تجزئة SignedProperties محسوبة من العقدة الحقيقية المتصلة بالشجرة الكاملة
  const signedPropertiesNode = findByLocalName(doc.documentElement, 'SignedProperties');
  const signedPropertiesDigest = sha256Base64(c14n(signedPropertiesNode));

  // نحدّث DigestValue الفارغ الخاص بمرجع SignedProperties داخل SignedInfo —
  // العنصر الأول ثابت أصلًا (invoiceHash)، الثاني هو الفارغ المطلوب تعبئته
  const signedInfoNode = findByLocalName(doc.documentElement, 'SignedInfo');
  const digestValueNodes = collectByLocalName(signedInfoNode, 'DigestValue', []);
  digestValueNodes[1].textContent = signedPropertiesDigest;

  // 2) توقيع SignedInfo محسوب من العقدة الحقيقية المتصلة (بعد اكتمال تجزئة SignedProperties بداخلها)
  const signedInfoCanonical = c14n(signedInfoNode);
  const privateKeyObj = crypto.createPrivateKey(privateKeyPem);
  const signatureValue = crypto.sign('sha256', Buffer.from(signedInfoCanonical, 'utf8'), privateKeyObj).toString('base64');

  const signatureValueNode = findByLocalName(doc.documentElement, 'SignatureValue');
  signatureValueNode.textContent = signatureValue;

  const signedXml = new XMLSerializer().serializeToString(doc);

  return { signedXml, signatureValue, certDigest, signingTime };
}

// يحقن رمز QR (base64) مكان عنصر EmbeddedDocumentBinaryObject الفارغ الموسوم
// بمعرّف QR الذي وضعه zatca.service.js. نبحث تحديدًا عن الشظية التالية لـ
// <cbc:ID>QR</cbc:ID> (وليس أي عنصر EmbeddedDocumentBinaryObject فارغ آخر
// بالمستند، مثل PIH لو كانت تجزئته فارغة)
function embedQR(invoiceXml, qrBase64) {
  const qrPlaceholder = /(<cbc:ID>QR<\/cbc:ID>\s*<cac:Attachment>\s*<cbc:EmbeddedDocumentBinaryObject mimeCode="text\/plain")\s*\/>/;
  if (!qrPlaceholder.test(invoiceXml)) {
    throw new Error('لم يُعثر على عنصر QR الفارغ داخل XML — تأكد أن الفاتورة وُلِّدت عبر zatca.service.js');
  }
  return invoiceXml.replace(qrPlaceholder, `$1>${qrBase64}</cbc:EmbeddedDocumentBinaryObject>`);
}

module.exports = { buildXadesSignature, embedQR, c14n, sha256Base64 };
