// المرحلة الثانية للفوترة الإلكترونية — الخطوة 5: التوقيع الرقمي XAdES-BES
//
// ⚠️ حالة التحقق (آخر تحديث: بعد الحصول على وثيقة الهيئة الرسمية "Security
// Features Implementation Standards" — كانت مفقودة طوال الجلسة، ثم زوَّدنا
// إياها المستخدم مباشرة — واختبار مباشر متكرر ضد أداة التحقق الرسمية SDK 3.4.8):
// ✅ البنية الهيكلية الكاملة (cac:Signature المرجعي + sig:UBLDocumentSignatures/
//    sac:SignatureInformation + ds:Transforms على المرجع الأول بالضبط كما تنص
//    عليه الوثيقة) مؤكَّدة صحيحة 100% — XSD/EN16931/KSA يمرّون كاملين.
// ✅ **اكتشاف حرج تم إصلاحه**: منحنى EC المستخدم لتوليد المفاتيح كان
//    secp256k1 (بافتراض خاطئ غير مُتحقَّق من جلسة سابقة) — والصحيح فعليًا P-256
//    (secp256r1)، مؤكَّد نصًا بالوثيقة الرسمية (قسم 2.2.2، SubjectPublicKeyInfo)
//    **و**تجريبيًا (محرّك تشفير أداة الهيئة رفض secp256k1 صراحة برسالة "Curve
//    not supported"). صُحِّح بـzatcaOnboarding.service.js. هذا كان يكسر أي
//    تحقق تشفيري من الأساس بصرف النظر عن أي إصلاح آخر بهذا الملف.
// ✅ أصلحنا تنسيق X509IssuerName (فاصلة+مسافة "C=X, O=Y" لا "C=X,O=Y" فقط) —
//    تأكَّد بمقارنة توقيع حقيقي أنتجته أداة الهيئة نفسها (fatoora -sign بمفتاح
//    P-256 صحيح)، والخطأ المقابل اختفى فعليًا من نتائج التحقق بعد هذا الإصلاح.
// ✅ أصلحنا Target بـQualifyingProperties (بلا "#") ليطابق نفس المرجع الحقيقي.
// ❌ **لا يزال متبقيًا، رغم كل ما سبق**: xadesSignedPropertiesDigestValue/
//    signatureValue/signingCertificateDigestValue لا تزال "خاطئة" حسب أداة
//    الهيئة. جرَّبنا فرضية إضافية (بعد ملاحظة إن توقيع أداة الهيئة الحقيقي يحمل
//    CertDigest بطول 64 بايت لا 32 — يشبه base64(hex-string) بدل base64
//    القياسي) وطبّقناها فعليًا: **لم تُغيّر شيئًا**، فأُعيدت للتنسيق القياسي.
//    السبب الجذري المتبقي غير معروف بعد رغم امتلاك الوثيقة الرسمية كاملة الآن
//    (القسم 2.3.3 لا يذكر أي تفصيلة إضافية تفسّر هذا). **لا تثق بصحة التوقيع
//    الفعلي هنا حتى تحقق حقيقي عبر بيئة الهيئة (Sandbox/Simulation) بحساب
//    Fatoora حقيقي فعلي.**
// راجع الذاكرة (zatca_sdk_real_validation_2026_08_26) لتفاصيل كل المحاولات
// (أكثر من 9 محاولات مختلفة موثَّقة، بينها اكتشاف حرج واحد فعلي [المنحنى]).

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

// ملاحظة تحقيق مهمة (جُرِّبت واستُبعِدت، موثَّقة هنا لمنع تكرارها): لاحظنا أن
// توقيع حقيقي أنتجته أداة الهيئة الرسمية نفسها (fatoora -sign) يحمل قيمتي
// CertDigest وSignedProperties-digest بطول 64 بايت لا 32 عند فك base64 —
// أي أنها **تبدو** كأنها base64(hex-string) بدل base64(raw-bytes) القياسي.
// جرّبنا تطبيق هذا التنسيق على قيمنا فعليًا: لم يُغيّر شيئًا بنتيجة أداة
// التحقق (نفس الأخطاء الثلاثة تمامًا). بما إن المواصفة الرسمية المكتوبة لا
// تذكر هذا التنسيق إطلاقًا، أبقينا الترميز القياسي (base64 مباشر على البايتات
// الخام) — الأرجح إن ملاحظة الـ64-بايت مصادفة أو خاصية بتنفيذ SDK الداخلي لا
// علاقة لها بما يتحقق منه فعليًا فحص [SIGNATURE].

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
  // ", " بفاصلة ومسافة — تحقّقنا حرفيًا من هذا بمقارنة توقيع حقيقي أنتجته أداة
  // الهيئة الرسمية نفسها (fatoora -sign بمفتاح P-256 صحيح): تنسيقها هو
  // "CN=X, O=Y, C=Z" (بمسافة بعد الفاصلة)، لا "CN=X,O=Y,C=Z" (بلا مسافة) كما
  // كان عندنا — هذا بالضبط ما كان يسبب "wrong X509IssuerName" بأداة التحقق
  const issuerName = cert.issuer.split('\n').reverse().join(', ');
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
                    `<ds:Transforms>` +
                      `<ds:Transform Algorithm="http://www.w3.org/TR/1999/REC-xpath-19991116">` +
                        `<ds:XPath>not(//ancestor-or-self::ext:UBLExtensions)</ds:XPath>` +
                      `</ds:Transform>` +
                      `<ds:Transform Algorithm="http://www.w3.org/TR/1999/REC-xpath-19991116">` +
                        `<ds:XPath>not(//ancestor-or-self::cac:Signature)</ds:XPath>` +
                      `</ds:Transform>` +
                      `<ds:Transform Algorithm="http://www.w3.org/TR/1999/REC-xpath-19991116">` +
                        `<ds:XPath>not(//ancestor-or-self::cac:AdditionalDocumentReference[cbc:ID='QR'])</ds:XPath>` +
                      `</ds:Transform>` +
                      `<ds:Transform Algorithm="http://www.w3.org/2006/12/xml-c14n11"/>` +
                    `</ds:Transforms>` +
                    `<ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>` +
                    `<ds:DigestValue>${invoiceHash}</ds:DigestValue>` +
                  `</ds:Reference>` +
                  `<ds:Reference Type="http://uri.etsi.org/01903#SignedProperties" URI="#${signedPropsId}">` +
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
                  `<xades:QualifyingProperties Target="${signatureId}">` +
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
