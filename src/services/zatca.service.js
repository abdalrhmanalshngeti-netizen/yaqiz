// خدمة المرحلة الثانية للفوترة الإلكترونية (ZATCA) — توليد فاتورة XML بصيغة UBL 2.1
// مطابقة لـ Electronic Invoice XML Implementation Standard v1.2 (القواعد BR / BR-CO / BR-KSA)
//
// هذا الملف مسؤول فقط عن بناء XML من بيانات فاتورة موجودة بالفعل بقاعدة البيانات —
// لا يحسب علاقات محاسبية جديدة ولا يتصل بأي خادم خارجي. سلسلة التجزئة والتوقيع
// الرقمي والإرسال الفعلي للهيئة خطوات لاحقة منفصلة تُبنى فوق مخرجات هذا الملف.

const { create } = require('xmlbuilder2');

const NS = {
  root: 'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2',
  cac:  'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2',
  cbc:  'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2',
  ext:  'urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2',
};

// ── أدوات مساعدة ───────────────────────────────────────────────────────────

// تقريب half-up لمنزلتين عشريتين — القسم 10 من المواصفة (يمنع أخطاء التقريب البسيطة لـ toFixed)
function round2(n) {
  const v = Number(n) || 0;
  return Math.round((v + Number.EPSILON) * 100) / 100;
}
function money(n) { return round2(n).toFixed(2); }

function pad2(n) { return String(n).padStart(2, '0'); }

// HH:mm:ss محلي (KSA-25) — بدون منطقة زمنية، الوقت بتوقيت السعودية كما تنص القاعدة BR-KSA-70
function formatTime(date) {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

// كود نوع الفاتورة السبعة أحرف (KSA-2): NN P N E S B
// NN = 01 فاتورة ضريبية كاملة (بيانات مشتري كاملة) / 02 فاتورة مبسطة
function buildTransactionCode({ isSimplified, thirdParty = false, nominal = false, exportInvoice = false, summary = false, selfBilled = false }) {
  const subtype = isSimplified ? '02' : '01';
  const bit = (v) => (v ? '1' : '0');
  return `${subtype}${bit(thirdParty)}${bit(nominal)}${bit(exportInvoice)}${bit(summary)}${bit(selfBilled)}`;
}

// BT-3: 388 فاتورة عادية (ضريبية أو مبسطة)، 383 إشعار مدين، 381 إشعار دائن، 386 فاتورة دفعة مقدمة
function invoiceTypeCodeFor(docKind) {
  switch (docKind) {
    case 'credit_note': return '381';
    case 'debit_note':  return '383';
    case 'prepayment':  return '386';
    default:            return '388';
  }
}

function schemeIdForVat() { return 'VAT'; }

// PaymentMeansCode (UN/CEFACT UNCL4461 D.16B) — كانت تُختزَل لحالتين فقط
// ('نقدي'=10، وكل شيء آخر=42 "تحويل لحساب بنكي" حتى لو كانت بطاقة أو شيك أو
// آجل). القيم أدناه تطابق نفس نصوص طرق الدفع الفعلية المستخدَمة بالنظام
// (BANK_METHODS بـtreasury.controller.js وغيره). 1="أداة غير محدَّدة" احتياطي
// آمن لأي قيمة غير معروفة، بدل الافتراض الخاطئ "تحويل بنكي" لكل شيء
const PAYMENT_MEANS_CODES = {
  'نقدي': '10', cash: '10',
  'شبكة': '48', 'بطاقة': '48', card: '48',
  'تحويل': '30', 'تحويل بنكي': '30', transfer: '30', bank: '30',
  'شيك': '20', cheque: '20', check: '20',
  'آجل': '1', credit: '1',
};
function paymentMeansCode(paymentMethod) {
  return PAYMENT_MEANS_CODES[String(paymentMethod || '').trim()] || '1';
}

// مخطط تعريف البائع حسب الحقول المتوفرة فعليًا (CRN هو الأشيع بالسجل التجاري)
function sellerIdentification(company) {
  return { schemeID: 'CRN', id: company.cr_number || company.vat_number || '' };
}

// مخطط تعريف المشتري: إن وُجد رقم ضريبي يُستخدم كمعرّف أساسي إضافي، وإلا OTH كافتراض آمن
function buyerIdentification(customer) {
  if (customer?.cr_number) return { schemeID: 'CRN', id: customer.cr_number };
  if (customer?.vat_number) return { schemeID: 'TIN', id: customer.vat_number };
  return null;
}

function validateSeller(company) {
  const errors = [];
  if (!company.vat_number || !/^3\d{13}3$/.test(company.vat_number)) {
    errors.push('الرقم الضريبي للبائع يجب أن يكون 15 رقمًا ويبدأ وينتهي بالرقم 3 (BR-KSA-40)');
  }
  if (!company.building_number || !/^\d{4}$/.test(company.building_number)) {
    errors.push('رقم مبنى البائع يجب أن يكون 4 أرقام (BR-KSA-37)');
  }
  if (!company.postal_code || !/^\d{5}$/.test(company.postal_code)) {
    errors.push('الرمز البريدي للبائع يجب أن يكون 5 أرقام (BR-KSA-66)');
  }
  if (!company.street_name) errors.push('اسم شارع البائع مطلوب (BR-KSA-09)');
  if (!company.district)    errors.push('حي البائع مطلوب (BR-KSA-09)');
  if (!company.city)        errors.push('مدينة البائع مطلوبة (BR-KSA-09)');
  return errors;
}

// تحذيرات اكتمال بيانات البائع (BR-KSA) كانت تُكتب بسجلّات السيرفر فقط
// (console.warn) — لا تصل لصاحب الحساب أبدًا، فيستمر بإصدار فواتير غير
// مكتملة البيانات نظاميًا بلا أي علم. هنا نحوّلها لإشعار حقيقي بجدول
// notifications (نفس الآلية المستخدَمة لتنبيهات تحديث الأسعار)، بشرط عدم
// تكرار الإشعار طالما فيه إشعار سابق غير مقروء من نفس النوع — وإلا كل فاتورة
// جديدة تُنشئ إشعارًا مستقلًا طالما الشركة ما أكملت بياناتها
async function notifyIncompleteSellerData(client, companyId, warnings) {
  if (!warnings || !warnings.length) return;
  try {
    const { rows: [existing] } = await client.query(
      `SELECT id FROM notifications WHERE company_id = $1 AND type = 'zatca_incomplete_seller' AND is_read = false LIMIT 1`,
      [companyId]
    );
    if (existing) return;
    const { rows: owners } = await client.query(
      `SELECT id FROM users WHERE company_id = $1 AND role = 'owner' AND active = true`,
      [companyId]
    );
    const message = `بيانات شركتك بالفوترة الإلكترونية غير مكتملة وفق متطلبات هيئة الزكاة والضريبة والجمارك: ${warnings.join('، ')}. أكمل هذي البيانات من إعدادات الشركة لضمان قبول فواتيرك رسميًا.`;
    for (const owner of owners) {
      await client.query(
        `INSERT INTO notifications (company_id, user_id, type, title, message, link)
         VALUES ($1,$2,'zatca_incomplete_seller','بيانات الفوترة الإلكترونية ناقصة',$3,'/VVIP.html#settings')`,
        [companyId, owner.id, message]
      );
    }
  } catch (e) {
    console.error('[ZATCA] failed to notify owner of incomplete seller data:', e.message);
  }
}

// تجميع أسطر الفاتورة حسب (رمز فئة الضريبة + نسبتها) — القسم 8.4 من المواصفة
function buildVatBreakdown(items, allowanceTotal = 0, chargeTotal = 0) {
  const groups = new Map();
  for (const it of items) {
    const code = it.vat_category_code || 'S';
    const rate = code === 'Z' || code === 'E' || code === 'O' ? 0 : Number(it.vat_rate ?? 15);
    const key = `${code}|${rate}`;
    if (!groups.has(key)) groups.set(key, { code, rate, taxable: 0, tax: 0 });
    const g = groups.get(key);
    g.taxable += Number(it.line_total || 0);
    g.tax += Number(it.vat_amount || 0);
  }
  // البند 9.6: مبلغ الرسوم/الخصومات على مستوى المستند يُضاف لأول فئة قياسية إن وُجدت خصومات عامة
  if ((allowanceTotal || chargeTotal) && groups.size) {
    const std = [...groups.values()].find(g => g.code === 'S') || [...groups.values()][0];
    std.taxable += (chargeTotal - allowanceTotal);
    std.tax = round2(std.taxable * (std.rate / 100));
  }
  return [...groups.values()].map(g => ({
    ...g, taxable: round2(g.taxable), tax: round2(g.tax),
  }));
}

/**
 * يبني مستند فاتورة XML كامل بصيغة UBL 2.1 لفاتورة موجودة مسبقًا بقاعدة البيانات.
 * @param {object} opts
 * @param {object} opts.company   صف من جدول companies (بعد إضافة الحقول المُهيكلة)
 * @param {object|null} opts.customer صف من جدول customers أو null لعميل نقدي بلا بيانات
 * @param {object} opts.invoice   صف من جدول invoices (بعد إضافة icv/uuid/previous_invoice_hash)
 * @param {object[]} opts.items   صفوف من جدول invoice_items الخاصة بهذه الفاتورة
 * @param {string} opts.previousInvoiceHash  تجزئة الفاتورة السابقة (من خدمة سلسلة التجزئة، الخطوة 3)
 * @param {string} [opts.docKind] 'invoice' | 'credit_note' | 'debit_note' | 'prepayment'
 * @returns {{xml: string, warnings: string[]}}
 */
function buildInvoiceXML({ company, customer, invoice, items, previousInvoiceHash, docKind = 'invoice' }) {
  const warnings = validateSeller(company);
  const isSimplified = (invoice.invoice_type || 'simplified') === 'simplified';
  const txCode = buildTransactionCode({ isSimplified });
  const typeCode = invoiceTypeCodeFor(docKind);

  const issueDate = invoice.date ? new Date(invoice.date) : new Date(invoice.created_at);
  const issueDateStr = issueDate.toISOString().slice(0, 10);
  // عمود TIME بـ Postgres قد يرجع ثوانٍ كسرية (HH:MM:SS.ffffff) — BR-KSA-70 يشترط hh:mm:ss بالضبط بدون كسور
  const issueTimeStr = invoice.issue_time
    ? String(invoice.issue_time).slice(0, 8)
    : formatTime(invoice.created_at ? new Date(invoice.created_at) : new Date());

  const allowanceTotal = round2(invoice.discount_amount || 0);
  const chargeTotal = 0; // لا توجد رسوم إضافية على مستوى المستند بالنموذج الحالي
  const vatBreakdown = buildVatBreakdown(items, allowanceTotal, chargeTotal);
  const totalTaxable = round2(vatBreakdown.reduce((s, g) => s + g.taxable, 0));
  const totalTax = round2(vatBreakdown.reduce((s, g) => s + g.tax, 0));
  const taxExclusive = round2((invoice.subtotal || totalTaxable) - allowanceTotal + chargeTotal);
  const taxInclusive = round2(taxExclusive + totalTax);
  const payable = round2(taxInclusive - Number(invoice.paid_amount_prepaid || 0));

  const doc = create({ version: '1.0', encoding: 'UTF-8' });
  const root = doc.ele(NS.root, 'Invoice');
  root.att('xmlns:cac', NS.cac);
  root.att('xmlns:cbc', NS.cbc);
  root.att('xmlns:ext', NS.ext);

  // مكان امتداد التوقيع الرقمي (XAdES) — يُملأ بالخطوة 5، تُرك بنية فاضية الآن حتى لا يتغيّر شكل المستند لاحقًا
  root.ele(NS.ext, 'ext:UBLExtensions');

  root.ele(NS.cbc, 'cbc:ProfileID').txt(isSimplified ? 'reporting:1.0' : 'standard:1.0');
  root.ele(NS.cbc, 'cbc:ID').txt(String(invoice.invoice_no));
  root.ele(NS.cbc, 'cbc:UUID').txt(invoice.zatca_uuid || invoice.uuid);
  root.ele(NS.cbc, 'cbc:IssueDate').txt(issueDateStr);
  root.ele(NS.cbc, 'cbc:IssueTime').txt(issueTimeStr);
  root.ele(NS.cbc, 'cbc:InvoiceTypeCode').att('name', txCode).txt(typeCode);
  if (invoice.notes) root.ele(NS.cbc, 'cbc:Note').txt(invoice.notes);
  root.ele(NS.cbc, 'cbc:DocumentCurrencyCode').txt('SAR');
  root.ele(NS.cbc, 'cbc:TaxCurrencyCode').txt('SAR');

  if (docKind === 'credit_note' || docKind === 'debit_note') {
    const br = root.ele(NS.cac, 'cac:BillingReference');
    br.ele(NS.cac, 'cac:InvoiceDocumentReference').ele(NS.cbc, 'cbc:ID').txt(String(invoice.linked_invoice_no || ''));
  }

  // ICV — عداد الفواتير التسلسلي (KSA-16)
  root.ele(NS.cac, 'cac:AdditionalDocumentReference')
    .ele(NS.cbc, 'cbc:ID').txt('ICV').up()
    .ele(NS.cbc, 'cbc:UUID').txt(String(invoice.icv ?? ''));

  // PIH — تجزئة الفاتورة السابقة، base64 (KSA-13)
  root.ele(NS.cac, 'cac:AdditionalDocumentReference')
    .ele(NS.cbc, 'cbc:ID').txt('PIH').up()
    .ele(NS.cac, 'cac:Attachment')
      .ele(NS.cbc, 'cbc:EmbeddedDocumentBinaryObject').att('mimeCode', 'text/plain').txt(previousInvoiceHash || '');

  // QR — عنصر فارغ الآن (بلا نص)، يُملأ لاحقًا بـ embedQR (zatcaSign.service.js)
  // بنفس أسلوب حقن ext:UBLExtensions الفارغ بالتوقيع — بعد حساب رمز QR الفعلي،
  // الذي يعتمد على التوقيع نفسه فلا يمكن حسابه هنا وقت بناء الـXML. لا يؤثر على
  // حساب التجزئة (canonicalizeForHash بـzatcaHash.service.js يحذف أي
  // AdditionalDocumentReference معرّفه QR قبل التجزئة بصرف النظر عن محتواه)
  root.ele(NS.cac, 'cac:AdditionalDocumentReference')
    .ele(NS.cbc, 'cbc:ID').txt('QR').up()
    .ele(NS.cac, 'cac:Attachment')
      .ele(NS.cbc, 'cbc:EmbeddedDocumentBinaryObject').att('mimeCode', 'text/plain').txt('');

  // AccountingSupplierParty (البائع)
  const sellerId = sellerIdentification(company);
  const supplier = root.ele(NS.cac, 'cac:AccountingSupplierParty').ele(NS.cac, 'cac:Party');
  supplier.ele(NS.cac, 'cac:PartyIdentification')
    .ele(NS.cbc, 'cbc:ID').att('schemeID', sellerId.schemeID).txt(sellerId.id);
  const sAddr = supplier.ele(NS.cac, 'cac:PostalAddress');
  sAddr.ele(NS.cbc, 'cbc:StreetName').txt(company.street_name || '');
  sAddr.ele(NS.cbc, 'cbc:BuildingNumber').txt(company.building_number || '');
  sAddr.ele(NS.cbc, 'cbc:CitySubdivisionName').txt(company.district || '');
  sAddr.ele(NS.cbc, 'cbc:CityName').txt(company.city || '');
  sAddr.ele(NS.cbc, 'cbc:PostalZone').txt(company.postal_code || '');
  sAddr.ele(NS.cac, 'cac:Country').ele(NS.cbc, 'cbc:IdentificationCode').txt(company.country_code || 'SA');
  supplier.ele(NS.cac, 'cac:PartyTaxScheme')
    .ele(NS.cbc, 'cbc:CompanyID').txt(company.vat_number || '').up()
    .ele(NS.cac, 'cac:TaxScheme').ele(NS.cbc, 'cbc:ID').txt('VAT');
  supplier.ele(NS.cac, 'cac:PartyLegalEntity').ele(NS.cbc, 'cbc:RegistrationName').txt(company.name || '');

  // AccountingCustomerParty (المشتري) — تُختصر بالفاتورة المبسطة حسب BR-10
  const custParty = root.ele(NS.cac, 'cac:AccountingCustomerParty').ele(NS.cac, 'cac:Party');
  const buyerId = buyerIdentification(customer);
  if (buyerId) {
    custParty.ele(NS.cac, 'cac:PartyIdentification')
      .ele(NS.cbc, 'cbc:ID').att('schemeID', buyerId.schemeID).txt(buyerId.id);
  }
  if (!isSimplified || customer) {
    const cAddr = custParty.ele(NS.cac, 'cac:PostalAddress');
    cAddr.ele(NS.cbc, 'cbc:StreetName').txt(customer?.street_name || customer?.address || '');
    if (customer?.building_number) cAddr.ele(NS.cbc, 'cbc:BuildingNumber').txt(customer.building_number);
    if (customer?.district) cAddr.ele(NS.cbc, 'cbc:CitySubdivisionName').txt(customer.district);
    cAddr.ele(NS.cbc, 'cbc:CityName').txt(customer?.city || '');
    if (customer?.postal_code) cAddr.ele(NS.cbc, 'cbc:PostalZone').txt(customer.postal_code);
    cAddr.ele(NS.cac, 'cac:Country').ele(NS.cbc, 'cbc:IdentificationCode').txt(customer?.country_code || 'SA');
  }
  if (customer?.vat_number) {
    custParty.ele(NS.cac, 'cac:PartyTaxScheme')
      .ele(NS.cbc, 'cbc:CompanyID').txt(customer.vat_number).up()
      .ele(NS.cac, 'cac:TaxScheme').ele(NS.cbc, 'cbc:ID').txt('VAT');
  }
  custParty.ele(NS.cac, 'cac:PartyLegalEntity')
    .ele(NS.cbc, 'cbc:RegistrationName').txt(customer?.name || invoice.customer_name || 'عميل نقدي');

  // وسيلة الدفع
  if (invoice.payment_method) {
    root.ele(NS.cac, 'cac:PaymentMeans')
      .ele(NS.cbc, 'cbc:PaymentMeansCode').txt(paymentMeansCode(invoice.payment_method));
  }

  // خصم على مستوى المستند (إن وُجد)
  if (allowanceTotal > 0) {
    const std = vatBreakdown.find(g => g.code === 'S') || vatBreakdown[0] || { rate: 15, code: 'S' };
    root.ele(NS.cac, 'cac:AllowanceCharge')
      .ele(NS.cbc, 'cbc:ChargeIndicator').txt('false').up()
      .ele(NS.cbc, 'cbc:AllowanceChargeReasonCode').txt('95').up()
      .ele(NS.cbc, 'cbc:AllowanceChargeReason').txt('خصم').up()
      .ele(NS.cbc, 'cbc:Amount').att('currencyID', 'SAR').txt(money(allowanceTotal)).up()
      .ele(NS.cac, 'cac:TaxCategory')
        .ele(NS.cbc, 'cbc:ID').txt(std.code).up()
        .ele(NS.cbc, 'cbc:Percent').txt(std.rate.toFixed(2)).up()
        .ele(NS.cac, 'cac:TaxScheme').ele(NS.cbc, 'cbc:ID').txt('VAT');
  }

  // TaxTotal — تفصيل الضريبة حسب كل فئة (القسم 9.6)
  const taxTotal = root.ele(NS.cac, 'cac:TaxTotal');
  taxTotal.ele(NS.cbc, 'cbc:TaxAmount').att('currencyID', 'SAR').txt(money(totalTax));
  for (const g of vatBreakdown) {
    const sub = taxTotal.ele(NS.cac, 'cac:TaxSubtotal');
    sub.ele(NS.cbc, 'cbc:TaxableAmount').att('currencyID', 'SAR').txt(money(g.taxable));
    sub.ele(NS.cbc, 'cbc:TaxAmount').att('currencyID', 'SAR').txt(money(g.tax));
    const cat = sub.ele(NS.cac, 'cac:TaxCategory');
    cat.ele(NS.cbc, 'cbc:ID').txt(g.code);
    cat.ele(NS.cbc, 'cbc:Percent').txt(g.rate.toFixed(2));
    if (g.code !== 'S') {
      cat.ele(NS.cbc, 'cbc:TaxExemptionReasonCode').txt(g.code === 'Z' ? 'VATEX-SA-32' : g.code === 'E' ? 'VATEX-SA-29' : 'VATEX-SA-OOS');
    }
    cat.ele(NS.cac, 'cac:TaxScheme').ele(NS.cbc, 'cbc:ID').txt('VAT');
  }

  // LegalMonetaryTotal
  const totals = root.ele(NS.cac, 'cac:LegalMonetaryTotal');
  totals.ele(NS.cbc, 'cbc:LineExtensionAmount').att('currencyID', 'SAR').txt(money(totalTaxable));
  totals.ele(NS.cbc, 'cbc:TaxExclusiveAmount').att('currencyID', 'SAR').txt(money(taxExclusive));
  totals.ele(NS.cbc, 'cbc:TaxInclusiveAmount').att('currencyID', 'SAR').txt(money(taxInclusive));
  totals.ele(NS.cbc, 'cbc:AllowanceTotalAmount').att('currencyID', 'SAR').txt(money(allowanceTotal));
  totals.ele(NS.cbc, 'cbc:ChargeTotalAmount').att('currencyID', 'SAR').txt(money(chargeTotal));
  totals.ele(NS.cbc, 'cbc:PrepaidAmount').att('currencyID', 'SAR').txt(money(invoice.paid_amount_prepaid || 0));
  totals.ele(NS.cbc, 'cbc:PayableAmount').att('currencyID', 'SAR').txt(money(payable));

  // InvoiceLine[] — سطر لكل بند
  items.forEach((it, idx) => {
    const code = it.vat_category_code || 'S';
    const rate = code === 'Z' || code === 'E' || code === 'O' ? 0 : Number(it.vat_rate ?? 15);
    const lineNet = round2(it.line_total);
    const lineVat = round2(it.vat_amount || (lineNet * rate / 100));
    const qty = Number(it.qty || 1);
    const unitPrice = qty ? round2((lineNet + round2(it.discount || 0)) / qty) : lineNet;

    const line = root.ele(NS.cac, 'cac:InvoiceLine');
    line.ele(NS.cbc, 'cbc:ID').txt(String(idx + 1));
    line.ele(NS.cbc, 'cbc:InvoicedQuantity').att('unitCode', 'PCE').txt(String(qty));
    line.ele(NS.cbc, 'cbc:LineExtensionAmount').att('currencyID', 'SAR').txt(money(lineNet));
    const lineTax = line.ele(NS.cac, 'cac:TaxTotal');
    lineTax.ele(NS.cbc, 'cbc:TaxAmount').att('currencyID', 'SAR').txt(money(lineVat));
    lineTax.ele(NS.cbc, 'cbc:RoundingAmount').att('currencyID', 'SAR').txt(money(lineNet + lineVat));
    const item = line.ele(NS.cac, 'cac:Item');
    item.ele(NS.cbc, 'cbc:Name').txt(it.product_name || '');
    const cls = item.ele(NS.cac, 'cac:ClassifiedTaxCategory');
    cls.ele(NS.cbc, 'cbc:ID').txt(code);
    cls.ele(NS.cbc, 'cbc:Percent').txt(rate.toFixed(2));
    cls.ele(NS.cac, 'cac:TaxScheme').ele(NS.cbc, 'cbc:ID').txt('VAT');
    const price = line.ele(NS.cac, 'cac:Price');
    price.ele(NS.cbc, 'cbc:PriceAmount').att('currencyID', 'SAR').txt(money(unitPrice));
    if (it.discount) {
      const pac = price.ele(NS.cac, 'cac:AllowanceCharge');
      pac.ele(NS.cbc, 'cbc:ChargeIndicator').txt('false');
      pac.ele(NS.cbc, 'cbc:Amount').att('currencyID', 'SAR').txt(money(it.discount));
      pac.ele(NS.cbc, 'cbc:BaseAmount').att('currencyID', 'SAR').txt(money(unitPrice * qty));
    }
  });

  const xml = root.end({ prettyPrint: true });
  return { xml, warnings };
}

module.exports = { buildInvoiceXML, round2, money, buildTransactionCode, invoiceTypeCodeFor, buildVatBreakdown, validateSeller, notifyIncompleteSellerData };
