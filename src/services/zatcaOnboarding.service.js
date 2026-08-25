// المرحلة الثانية للفوترة الإلكترونية — الخطوة 4: تأهيل CSID
// (Compliance CSID ثم Production CSID) لكل شركة عميل لدى منصة يقظ.
//
// حالة التحقق الحالية:
// ✅ الصحة التشفيرية والتركيبية لـCSR مُتحقَّقة فعليًا ومستقلة عبر openssl
//    (openssl req -verify يعطي "Certificate request self-signature verify OK"،
//    والمنحنى الناتج secp256k1 كما تشترط الهيئة بالضبط).
// ⚠️ غير مؤكَّد بعد: القيم الدقيقة لحقول الموضوع (Subject) والامتداد المخصص
//    (customOID بدالة buildCsr) مقابل ما تتوقعه بوابة الهيئة تحديدًا — هذا لم
//    يُختبر بعد ضد سيرفرات ZATCA الفعلية لعدم توفر حساب اختبار. قبل أول استخدام
//    حقيقي: قارن هذه القيم مع "Onboarding e-Invoicing Solutions" بموقع الهيئة
//    (developer.zatca.gov.sa)، وجرّب أول CSR فعليًا مقابل بيئة المحاكاة.

const crypto = require('crypto');
const forge = require('node-forge');
const cryptoUtil = require('../utils/crypto.util');
const { validateSeller } = require('./zatca.service');

// نقاط اتصال الهيئة — بيئة المحاكاة (Simulation) هي المتاحة للمطورين قبل الإنتاج
const ZATCA_ENDPOINTS = {
  sandbox:    'https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal',
  simulation: 'https://gw-fatoora.zatca.gov.sa/e-invoicing/simulation',
  production: 'https://gw-fatoora.zatca.gov.sa/e-invoicing/core',
};

// المنحنى الإهليلجي المطلوب من الهيئة لمفاتيح التوقيع (secp256k1 — يختلف عن P-256
// الشائع). node-forge لا يدعم توقيع/قراءة مفاتيح EC (RSA فقط بواجهته العليا)،
// لذا نستخدم forge فقط كأداة بناء/ترميز ASN.1 (DER)، ونستخدم وحدة crypto
// الأصلية بـNode (تدعم secp256k1 فعليًا عبر OpenSSL) لتوليد المفتاح والتوقيع.
const asn1 = forge.asn1;
const OID = {
  ecPublicKey: '1.2.840.10045.2.1',
  ecdsaWithSha256: '1.2.840.10045.4.3.2',
  extensionRequest: '1.2.840.113549.1.9.14',
  commonName: '2.5.4.3', organizationName: '2.5.4.10', organizationalUnitName: '2.5.4.11', countryName: '2.5.4.6',
};

function generateKeyPair() {
  const ec = crypto.generateKeyPairSync('ec', {
    namedCurve: 'secp256k1',
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return ec; // { publicKey: Buffer (DER/SPKI), privateKey: string (PEM/PKCS8) }
}

function rdn(oid, value, valueType = asn1.Type.UTF8) {
  return asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SET, true, [
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
      asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OID, false, asn1.oidToDer(oid).getBytes()),
      asn1.create(asn1.Class.UNIVERSAL, valueType, false, forge.util.encodeUtf8(value)),
    ]),
  ]);
}

/**
 * يبني CSR (طلب توقيع شهادة) بحقول الموضوع (Subject) التي تشترطها الهيئة، ويوقّعه
 * فعليًا بخوارزمية ECDSA-secp256k1 مطابقة لما تشترطه الهيئة — تحقّقنا من صحة
 * البنية والتوقيع عبر openssl مباشرة (راجع سكربت الاختبار المرفق بالخطوة).
 * @param {object} company صف الشركة (يحتاج vat_number, name, city على الأقل)
 * @param {object} opts    { commonName, organizationUnit, egsSerial }
 */
function buildCsr(company, { commonName = 'Yaqiz-POS', organizationUnit = 'Yaqiz', egsSerial } = {}) {
  const { privateKey: privateKeyPem, publicKey: spkiDer } = generateKeyPair();
  const privateKeyObj = crypto.createPrivateKey(privateKeyPem);

  // subjectPKInfo: نعيد استخدام بنية SPKI DER الصادرة من Node مباشرة (متوافقة
  // حرفيًا مع ما يتطلبه PKCS#10 لهذا الحقل، لا حاجة لإعادة بنائها يدويًا)
  const subjectPKInfo = asn1.fromDer(forge.util.createBuffer(spkiDer.toString('binary')));

  const subject = asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
    rdn(OID.countryName, company.country_code || 'SA', asn1.Type.PRINTABLESTRING),
    rdn(OID.organizationName, company.name || 'Yaqiz Merchant'),
    rdn(OID.organizationalUnitName, organizationUnit),
    rdn(OID.commonName, commonName),
  ]);

  // ⚠️ يحتاج تأكيد دقيق من دليل الهيئة الرسمي: الامتداد المخصص الذي يحمل رقم
  // التسلسل (egsSerial)، الرقم الضريبي، الموقع، ونوع الفواتير المدعومة —
  // القيمة أدناه بنية تقريبية شائعة بأدلة التكامل العامة، غير مؤكدة رسميًا هنا.
  const extensionValue = `1|${egsSerial || 'YAQIZ-' + company.id}|${company.vat_number || ''}|${company.city || 'Riyadh'}|1100`;
  const extension = asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OID, false, asn1.oidToDer('1.3.6.1.4.1.311.20.2').getBytes()),
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OCTETSTRING, false,
      asn1.toDer(asn1.create(asn1.Class.UNIVERSAL, asn1.Type.UTF8, false, forge.util.encodeUtf8(extensionValue))).getBytes()),
  ]);
  const extensionRequestAttr = asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OID, false, asn1.oidToDer(OID.extensionRequest).getBytes()),
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SET, true, [
      asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [extension]),
    ]),
  ]);
  // [0] IMPLICIT attributes — سياق ضمني رقم 0 بمواصفة PKCS#10
  const attributes = asn1.create(asn1.Class.CONTEXT_SPECIFIC, 0, true, [extensionRequestAttr]);

  const certificationRequestInfo = asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.INTEGER, false, asn1.integerToDer(0).getBytes()),
    subject,
    subjectPKInfo,
    attributes,
  ]);

  const tbs = Buffer.from(asn1.toDer(certificationRequestInfo).getBytes(), 'binary');
  // Node يُصدر توقيع EC بصيغة DER افتراضيًا (SEQUENCE من عددين صحيحين r,s) — هذا
  // بالضبط ما يشترطه X.509/PKCS#10 لحقل التوقيع
  const signature = crypto.sign('sha256', tbs, privateKeyObj);

  const signatureAlgorithm = asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OID, false, asn1.oidToDer(OID.ecdsaWithSha256).getBytes()),
  ]);
  const signatureBitString = asn1.create(asn1.Class.UNIVERSAL, asn1.Type.BITSTRING, false,
    String.fromCharCode(0) + signature.toString('binary'));

  const certificationRequest = asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
    certificationRequestInfo, signatureAlgorithm, signatureBitString,
  ]);

  const derBytes = asn1.toDer(certificationRequest).getBytes();
  const csrDer = Buffer.from(derBytes, 'binary');
  const csrPem = `-----BEGIN CERTIFICATE REQUEST-----\n${csrDer.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE REQUEST-----\n`;
  const csrBase64 = Buffer.from(csrPem).toString('base64');

  return { csrPem, csrBase64, privateKeyPem };
}

// مهلة زمنية إلزامية على أي اتصال ببوابة الهيئة — بدونها، بوابة معلَّقة (لا ترد
// ولا تقطع الاتصال) تُبقي هذا الطلب معلَّقًا للأبد. هذي الدالة تُستدعى اليوم
// دائمًا بمعزل عن أي اتصال قاعدة بيانات مفتوح (راجع requestCompliance/
// requestProduction بالـcontroller)، فالمهلة هنا حماية إضافية للمستخدم نفسه
// (لا يبقى منتظرًا للأبد)، لا لتفادي استنزاف اتصالات القاعدة تحديدًا
async function zatcaFetch(url, { method = 'POST', headers = {}, body } = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(url, {
      method, headers: { 'Content-Type': 'application/json', 'Accept-Version': 'V2', ...headers }, body,
      signal: controller.signal,
    });
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
    if (!res.ok) {
      const err = new Error(`ZATCA API error ${res.status}: ${text.slice(0, 500)}`);
      err.status = res.status; err.data = data;
      throw err;
    }
    return data;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('انتهت مهلة الاتصال ببوابة الهيئة (20 ثانية) بلا رد');
    throw e;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * الخطوة الأولى: طلب شهادة الامتثال (Compliance CSID) باستخدام الـOTP الصادر
 * يدويًا من بوابة فاتورة لحساب الشركة الحقيقي — لا بديل آلي لهذه الخطوة.
 */
async function requestComplianceCSID(client, company, otp, environment = 'sandbox') {
  // كانت بيانات البائع الناقصة (عنوان/رقم ضريبي غير مكتمل) تمر بلا أي مانع
  // حتى إصدار شهادة الإنتاج — رغم إن نفس الفحص (validateSeller) موجود أصلًا
  // ويُستخدم فقط لتحذيرات صامتة بالسجلّ عند بناء XML كل فاتورة. شهادة صادرة
  // لبيانات ناقصة عمليًا عديمة الفائدة (كل فاتورة ستُرفض من الهيئة لاحقًا على
  // BR-KSA-09/37/40/66)، فنمنع إصدارها من الأساس بدل اكتشاف الفشل لاحقًا فاتورة
  // فاتورة
  const sellerWarnings = validateSeller(company);
  if (sellerWarnings.length) {
    const err = new Error(`بيانات الشركة غير مكتملة لإصدار شهادة الفوترة الإلكترونية: ${sellerWarnings.join('، ')}`);
    err.code = 'INCOMPLETE_SELLER_DATA';
    throw err;
  }
  const { csrBase64, privateKeyPem } = buildCsr(company, {});
  const url = `${ZATCA_ENDPOINTS[environment]}/compliance`;

  const data = await zatcaFetch(url, {
    headers: { OTP: otp },
    body: JSON.stringify({ csr: csrBase64 }),
  });

  const certPem = Buffer.from(data.binarySecurityToken, 'base64').toString('utf8');
  const secret = data.secret;
  const requestId = data.requestID || data.requestId;

  const pk = cryptoUtil.encrypt(privateKeyPem);
  const sc = cryptoUtil.encrypt(secret);

  await client.query(`
    UPDATE zatca_credentials SET is_active = false WHERE company_id = $1 AND csid_type = 'compliance'
  `, [company.id]);
  await client.query(`
    INSERT INTO zatca_credentials
      (company_id, csid_type, environment, certificate_pem,
       private_key_encrypted, private_key_iv, private_key_tag,
       secret_encrypted, secret_iv, secret_tag, compliance_request_id)
    VALUES ($1,'compliance',$2,$3,$4,$5,$6,$7,$8,$9,$10)
  `, [company.id, environment, certPem,
      pk.encrypted, pk.iv, pk.tag, sc.encrypted, sc.iv, sc.tag, String(requestId)]);
  await client.query(`UPDATE companies SET zatca_onboarding_status = 'compliance_issued' WHERE id = $1`, [company.id]);

  return { requestId, environment };
}

/**
 * الخطوة الثانية: طلب شهادة الإنتاج (Production CSID) بعد اجتياز فحوصات
 * الامتثال — تحتاج requestId الناتج من الخطوة السابقة، وتستخدم شهادة الامتثال
 * نفسها للمصادقة (Basic Auth: username=certificate binary token, password=secret).
 */
async function requestProductionCSID(client, company, environment = 'sandbox') {
  // نفس فحص اكتمال البيانات أعلى requestComplianceCSID — دفاع بعمق لحالة
  // نادرة: بيانات الشركة كانت مكتملة وقت الامتثال ثم تغيّرت (مثلاً حذف
  // العنوان من الإعدادات) قبل طلب شهادة الإنتاج تحديدًا
  const sellerWarnings = validateSeller(company);
  if (sellerWarnings.length) {
    const err = new Error(`بيانات الشركة غير مكتملة لإصدار شهادة الفوترة الإلكترونية: ${sellerWarnings.join('، ')}`);
    err.code = 'INCOMPLETE_SELLER_DATA';
    throw err;
  }
  const { rows: [compliance] } = await client.query(`
    SELECT * FROM zatca_credentials
    WHERE company_id = $1 AND csid_type = 'compliance' AND is_active = true
    ORDER BY issued_at DESC LIMIT 1
  `, [company.id]);
  if (!compliance) throw new Error('لا توجد شهادة امتثال سارية لهذه الشركة — يجب تنفيذ requestComplianceCSID أولًا');

  const secret = cryptoUtil.decrypt({
    encrypted: compliance.secret_encrypted, iv: compliance.secret_iv, tag: compliance.secret_tag,
  });
  const certB64 = Buffer.from(compliance.certificate_pem).toString('base64');
  const basicAuth = Buffer.from(`${certB64}:${secret}`).toString('base64');

  const url = `${ZATCA_ENDPOINTS[environment]}/production/csids`;
  const data = await zatcaFetch(url, {
    headers: { Authorization: `Basic ${basicAuth}` },
    body: JSON.stringify({ compliance_request_id: compliance.compliance_request_id }),
  });

  const certPem = Buffer.from(data.binarySecurityToken, 'base64').toString('utf8');
  const prodSecret = data.secret;
  // نفس زوج المفاتيح المستخدم بطلب الامتثال يبقى صالحًا لشهادة الإنتاج — لا حاجة لCSR جديد
  const sc = cryptoUtil.encrypt(prodSecret);

  await client.query(`
    UPDATE zatca_credentials SET is_active = false WHERE company_id = $1 AND csid_type = 'production'
  `, [company.id]);
  await client.query(`
    INSERT INTO zatca_credentials
      (company_id, csid_type, environment, certificate_pem,
       private_key_encrypted, private_key_iv, private_key_tag,
       secret_encrypted, secret_iv, secret_tag)
    VALUES ($1,'production',$2,$3,$4,$5,$6,$7,$8,$9)
  `, [company.id, environment, certPem,
      compliance.private_key_encrypted, compliance.private_key_iv, compliance.private_key_tag,
      sc.encrypted, sc.iv, sc.tag]);
  await client.query(`UPDATE companies SET zatca_onboarding_status = 'production_issued' WHERE id = $1`, [company.id]);

  return { environment };
}

function decryptStored(row) {
  return cryptoUtil.decrypt({ encrypted: row.private_key_encrypted, iv: row.private_key_iv, tag: row.private_key_tag });
}

/** يجلب أحدث بيانات اعتماد سارية (شهادة + مفتاح خاص + سر مفكوك) لنوع معيّن — تُستخدم بالتوقيع والإرسال (الخطوتان 5 و6) */
async function getActiveCredential(client, companyId, csidType) {
  const { rows: [row] } = await client.query(`
    SELECT * FROM zatca_credentials
    WHERE company_id = $1 AND csid_type = $2 AND is_active = true
    ORDER BY issued_at DESC LIMIT 1
  `, [companyId, csidType]);
  if (!row) return null;
  return {
    certificatePem: row.certificate_pem,
    privateKeyPem: decryptStored(row),
    secret: cryptoUtil.decrypt({ encrypted: row.secret_encrypted, iv: row.secret_iv, tag: row.secret_tag }),
    environment: row.environment,
  };
}

module.exports = { buildCsr, requestComplianceCSID, requestProductionCSID, getActiveCredential, ZATCA_ENDPOINTS };
