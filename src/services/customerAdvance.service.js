const { todayLocalDateStr } = require('../utils/date.util');
const { nextDocNumber } = require('./docNumber.service');

// تسوية دفعات العملاء المقدمة — المعالجة المعتمدة: المقبوض مقدمًا التزام على المنشأة
// (2160 دفعات عملاء مقدمة = رصيد دائن للعميل). لما يأخذ بضاعة بالآجل تُثبت الذمة كاملة
// بقيد الفاتورة، ثم قيد تسوية مستقل يقفل المقدم منها: من حـ/ 2160 إلى حـ/ 1200.
// القيد يُسجَّل هنا بالسيرفر داخل نفس معاملة الفاتورة — ما يعتمد على وصوله من الجهاز

const r2 = v => Math.round((parseFloat(v) || 0) * 100) / 100;

async function accountId(client, companyId, code, name) {
  const { rows: [a] } = await client.query(`SELECT id FROM chart_of_accounts WHERE company_id = $1 AND code = $2`, [companyId, code]);
  if (a) return a.id;
  const { rows: [c] } = await client.query(
    `INSERT INTO chart_of_accounts (company_id, code, name, name_en, type, is_group) VALUES ($1,$2,$3,$3,$4,false) RETURNING id`,
    [companyId, code, name, code.startsWith('1') ? 'أصول' : 'التزامات']);
  return c.id;
}

async function postEntry(client, { companyId, userId, description, reference, sourceType, sourceId, lines }) {
  const seq = await nextDocNumber(client, companyId, 'entry');
  const { rows: [entry] } = await client.query(`
    INSERT INTO journal_entries (company_id, entry_no, description, reference, date, source_type, source_id, created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, entry_no, date`,
    [companyId, `JE-${String(seq).padStart(6, '0')}`, description, reference, todayLocalDateStr(), sourceType, sourceId, userId]);
  for (const l of lines) {
    await client.query(`INSERT INTO journal_items (entry_id, account_id, account_code, account_name, side, amount) VALUES ($1,$2,$3,$4,$5,$6)`,
      [entry.id, await accountId(client, companyId, l.account_code, l.account), l.account_code, l.account, l.side, l.amount]);
  }
  return { id: entry.id, entry_no: entry.entry_no, date: entry.date, ref: reference, description, entries: lines };
}

const ADV = { account: 'دفعات عملاء مقدمة', account_code: '2160' };
const AR  = { account: 'الذمم المدينة', account_code: '1200' };

// المتاح للعميل من دفعات مقدمة: المقبوض مقدمًا − ما سُوّي منه، وبحد رصيده الدائن
async function availableAdvance(client, companyId, customerId) {
  const { rows: [c] } = await client.query(`SELECT balance FROM customers WHERE id = $1 AND company_id = $2 FOR UPDATE`, [customerId, companyId]);
  if (!c) return 0;
  const { rows: [a] } = await client.query(`
    SELECT COALESCE((SELECT SUM(advance_amount) FROM vouchers WHERE company_id = $1 AND party_id = $2 AND type = 'receipt'),0)
         - COALESCE((SELECT SUM(advance_applied) FROM invoices WHERE company_id = $1 AND customer_id = $2 AND COALESCE(status,'') <> 'cancelled'),0) AS v`,
    [companyId, customerId]);
  return Math.max(0, Math.min(r2(a.v), r2(-parseFloat(c.balance))));
}

// تُستدعى بعد إنشاء فاتورة آجلة وقبل رفع رصيد العميل بقيمتها
async function applyToInvoice(client, { companyId, userId, invoice }) {
  if (!invoice.customer_id) return null;
  const due = r2(parseFloat(invoice.grand_total) - (parseFloat(invoice.paid_amount) || 0));
  if (due <= 0) return null;
  const applied = r2(Math.min(due, await availableAdvance(client, companyId, invoice.customer_id)));
  if (applied <= 0) return null;
  const paid = r2((parseFloat(invoice.paid_amount) || 0) + applied);
  const status = paid >= parseFloat(invoice.grand_total) - 0.005 ? 'paid' : 'partial';
  await client.query(`UPDATE invoices SET paid_amount = $1, advance_applied = $2, status = $3 WHERE id = $4`, [paid, applied, status, invoice.id]);
  const entry = await postEntry(client, { companyId, userId,
    description: `تسوية دفعة مقدمة على الفاتورة ${invoice.invoice_no} — ${invoice.customer_name || ''}`,
    reference: `ADV-${invoice.invoice_no}`, sourceType: 'advance_apply', sourceId: invoice.id,
    lines: [{ ...ADV, side: 'debit', amount: applied }, { ...AR, side: 'credit', amount: applied }] });
  Object.assign(invoice, { paid_amount: paid, advance_applied: applied, status });
  return entry;
}

// إلغاء فاتورة سُوّيت من دفعة مقدمة: قيد عكسي يرجّع المبلغ لرصيد العميل الدائن
async function reverseForInvoice(client, { companyId, userId, invoice }) {
  const applied = r2(invoice.advance_applied);
  if (applied <= 0) return null;
  return postEntry(client, { companyId, userId,
    description: `عكس تسوية دفعة مقدمة — إلغاء الفاتورة ${invoice.invoice_no}`,
    reference: `REV-ADV-${invoice.invoice_no}`, sourceType: 'advance_apply_reversal', sourceId: invoice.id,
    lines: [{ ...AR, side: 'debit', amount: applied }, { ...ADV, side: 'credit', amount: applied }] });
}

module.exports = { applyToInvoice, reverseForInvoice, availableAdvance };
