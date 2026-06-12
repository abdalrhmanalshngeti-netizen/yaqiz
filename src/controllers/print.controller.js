const db = require('../config/db');

async function printInvoice(req, res) {
  const { id } = req.params;
  const { company_id } = req.user;

  try {
    // Invoice + customer + company
    const { rows: inv } = await db.query(`
      SELECT
        i.id, i.invoice_no AS number, i.invoice_type AS type,
        i.date AS issue_date, i.due_date,
        i.subtotal, i.vat_amount, i.grand_total AS total,
        i.notes, i.status,
        i.customer_name, i.customer_vat,
        co.name     AS company_name,
        co.cr_number, co.vat_number AS company_vat,
        co.address  AS company_address, co.phone AS company_phone
      FROM invoices i
      LEFT JOIN companies co ON co.id = i.company_id
      WHERE i.id = $1 AND i.company_id = $2
    `, [id, company_id]);

    if (!inv.length) return res.status(404).send('<h2>الفاتورة غير موجودة</h2>');
    const invoice = inv[0];

    // Items
    const { rows: items } = await db.query(`
      SELECT
        ii.product_name, ii.product_code,
        ii.qty, ii.unit_price, ii.vat_amount, ii.line_total,
        ROUND(CASE WHEN (ii.qty * ii.unit_price) > 0
          THEN (ii.vat_amount / (ii.qty * ii.unit_price)) * 100
          ELSE 15 END, 0) AS vat_rate
      FROM invoice_items ii
      WHERE ii.invoice_id = $1
      ORDER BY ii.sort_order, ii.id
    `, [id]);

    const esc  = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
    const fmt  = n => Number(n || 0).toFixed(2);
    const date = d => d ? new Date(d).toLocaleDateString('ar-SA', { year:'numeric', month:'long', day:'numeric' }) : '—';
    const typeLabel = invoice.type === 'tax' ? 'فاتورة ضريبية' : 'فاتورة مبسّطة';
    const statusMap = { draft:'مسودة', issued:'صادرة', paid:'مدفوعة', cancelled:'ملغية', overdue:'متأخرة' };
    const statusLabel = statusMap[invoice.status] || esc(invoice.status) || '—';

    const itemRows = items.map((it, i) => `
      <tr>
        <td>${i + 1}</td>
        <td>${esc(it.product_name) || '—'}${it.product_code ? `<br><small style="color:#94a3b8">${esc(it.product_code)}</small>` : ''}</td>
        <td>${fmt(it.qty)}</td>
        <td>${fmt(it.unit_price)}</td>
        <td>${Number(it.vat_rate || 15).toFixed(0)}٪</td>
        <td>${fmt(it.vat_amount)}</td>
        <td><strong>${fmt(it.line_total)}</strong></td>
      </tr>
    `).join('');

    const html = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>فاتورة رقم ${esc(invoice.number)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Tajawal:wght@400;500;700;900&display=swap" rel="stylesheet">
  <style>
    * { margin:0; padding:0; box-sizing:border-box; }
    body { font-family:'Tajawal',sans-serif; color:#1e293b; background:#f1f5f9; }
    .page { max-width:800px; margin:2rem auto; background:#fff; border-radius:12px; overflow:hidden; box-shadow:0 4px 24px rgba(0,0,0,0.1); }

    /* Header */
    .inv-header { background:linear-gradient(135deg,#0f172a,#1e3a8a); color:#fff; padding:2.5rem; display:flex; justify-content:space-between; align-items:flex-start; gap:2rem; }
    .inv-header h1 { font-size:2rem; font-weight:900; margin-bottom:0.3rem; }
    .inv-header .type-badge { background:rgba(255,255,255,0.15); border:1px solid rgba(255,255,255,0.25); padding:4px 14px; border-radius:100px; font-size:0.82rem; display:inline-block; margin-bottom:0.75rem; }
    .inv-header p { font-size:0.88rem; opacity:.75; margin-top:4px; }
    .inv-num { text-align:left; }
    .inv-num .label { font-size:0.78rem; opacity:.65; text-transform:uppercase; letter-spacing:1px; }
    .inv-num .value { font-size:1.6rem; font-weight:900; }
    .status-pill { display:inline-block; padding:5px 16px; border-radius:100px; font-size:0.82rem; font-weight:700; margin-top:0.5rem; background:rgba(16,185,129,0.2); color:#6ee7b7; border:1px solid rgba(16,185,129,0.35); }

    /* Parties */
    .parties { display:grid; grid-template-columns:1fr 1fr; gap:0; border-bottom:1px solid #e2e8f0; }
    .party { padding:1.75rem 2.5rem; }
    .party:first-child { border-left:1px solid #e2e8f0; }
    .party-label { font-size:0.75rem; text-transform:uppercase; letter-spacing:1px; color:#94a3b8; margin-bottom:0.6rem; font-weight:700; }
    .party h3 { font-size:1.05rem; font-weight:700; color:#0f172a; margin-bottom:0.35rem; }
    .party p { font-size:0.88rem; color:#64748b; line-height:1.6; }

    /* Dates */
    .dates { display:flex; gap:0; border-bottom:1px solid #e2e8f0; }
    .date-item { flex:1; padding:1rem 2.5rem; border-left:1px solid #e2e8f0; }
    .date-item:last-child { border-left:none; }
    .date-label { font-size:0.75rem; text-transform:uppercase; letter-spacing:1px; color:#94a3b8; font-weight:700; }
    .date-value { font-size:0.95rem; font-weight:600; color:#1e293b; margin-top:2px; }

    /* Table */
    .table-wrap { padding:2rem 2.5rem; }
    table { width:100%; border-collapse:collapse; font-size:0.9rem; }
    thead tr { background:#f8fafc; }
    th { padding:0.75rem 0.75rem; text-align:right; font-weight:700; color:#64748b; font-size:0.78rem; text-transform:uppercase; letter-spacing:0.5px; border-bottom:2px solid #e2e8f0; }
    td { padding:0.85rem 0.75rem; border-bottom:1px solid #f1f5f9; color:#374151; }
    tbody tr:last-child td { border-bottom:none; }
    tbody tr:hover { background:#fafafa; }
    td:last-child, th:last-child { text-align:left; }

    /* Totals */
    .totals { padding:0 2.5rem 2rem; display:flex; justify-content:flex-end; }
    .totals-box { width:320px; border:1px solid #e2e8f0; border-radius:12px; overflow:hidden; }
    .total-row { display:flex; justify-content:space-between; padding:0.7rem 1.25rem; font-size:0.93rem; }
    .total-row:not(:last-child) { border-bottom:1px solid #f1f5f9; }
    .total-row span:first-child { color:#64748b; }
    .total-row span:last-child { font-weight:600; }
    .total-row.grand { background:linear-gradient(135deg,#0f172a,#1e3a8a); }
    .total-row.grand span { color:#fff !important; font-size:1.05rem; font-weight:900; }

    /* Notes */
    .notes { padding:0 2.5rem 2rem; }
    .notes-label { font-size:0.78rem; text-transform:uppercase; letter-spacing:1px; color:#94a3b8; font-weight:700; margin-bottom:0.5rem; }
    .notes-text { font-size:0.9rem; color:#64748b; background:#f8fafc; padding:0.85rem 1rem; border-radius:8px; border:1px solid #e2e8f0; }

    /* Footer */
    .inv-footer { background:#f8fafc; padding:1.25rem 2.5rem; display:flex; justify-content:space-between; align-items:center; border-top:1px solid #e2e8f0; }
    .inv-footer p { font-size:0.8rem; color:#94a3b8; }
    .print-btn { background:#1e40af; color:#fff; border:none; padding:0.55rem 1.4rem; border-radius:8px; font-family:inherit; font-size:0.9rem; font-weight:700; cursor:pointer; transition:all 0.2s; }
    .print-btn:hover { background:#1e3a8a; }

    @media print {
      body { background:#fff; }
      .page { box-shadow:none; margin:0; border-radius:0; }
      .print-btn { display:none; }
    }
  </style>
</head>
<body>
<div class="page">

  <!-- HEADER -->
  <div class="inv-header">
    <div>
      <div class="type-badge">${typeLabel}</div>
      <h1>${esc(invoice.company_name) || 'شركتي'}</h1>
      ${invoice.company_vat ? `<p>الرقم الضريبي: ${esc(invoice.company_vat)}</p>` : ''}
      ${invoice.cr_number   ? `<p>السجل التجاري: ${esc(invoice.cr_number)}</p>` : ''}
      ${invoice.company_phone ? `<p>📞 ${esc(invoice.company_phone)}</p>` : ''}
    </div>
    <div class="inv-num">
      <div class="label">رقم الفاتورة</div>
      <div class="value">${esc(invoice.number)}</div>
      <div class="status-pill">${statusLabel}</div>
    </div>
  </div>

  <!-- PARTIES -->
  <div class="parties">
    <div class="party">
      <div class="party-label">من (البائع)</div>
      <h3>${esc(invoice.company_name) || '—'}</h3>
      ${invoice.company_address ? `<p>${esc(invoice.company_address)}</p>` : ''}
    </div>
    <div class="party">
      <div class="party-label">إلى (المشتري)</div>
      <h3>${esc(invoice.customer_name) || 'نقد'}</h3>
      ${invoice.customer_vat     ? `<p>الرقم الضريبي: ${esc(invoice.customer_vat)}</p>` : ''}
      ${invoice.customer_address ? `<p>${esc(invoice.customer_address)}</p>` : ''}
      ${invoice.customer_phone   ? `<p>📞 ${esc(invoice.customer_phone)}</p>` : ''}
    </div>
  </div>

  <!-- DATES -->
  <div class="dates">
    <div class="date-item">
      <div class="date-label">تاريخ الإصدار</div>
      <div class="date-value">${date(invoice.issue_date)}</div>
    </div>
    <div class="date-item">
      <div class="date-label">تاريخ الاستحقاق</div>
      <div class="date-value">${date(invoice.due_date)}</div>
    </div>
  </div>

  <!-- ITEMS TABLE -->
  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>#</th>
          <th>الوصف</th>
          <th>الكمية</th>
          <th>سعر الوحدة</th>
          <th>الضريبة</th>
          <th>مبلغ الضريبة</th>
          <th>الإجمالي</th>
        </tr>
      </thead>
      <tbody>${itemRows}</tbody>
    </table>
  </div>

  <!-- TOTALS -->
  <div class="totals">
    <div class="totals-box">
      <div class="total-row">
        <span>المجموع قبل الضريبة</span>
        <span>${fmt(invoice.subtotal)} ر.س</span>
      </div>
      <div class="total-row">
        <span>ضريبة القيمة المضافة (١٥٪)</span>
        <span>${fmt(invoice.vat_amount)} ر.س</span>
      </div>
      <div class="total-row grand">
        <span>الإجمالي النهائي</span>
        <span>${fmt(invoice.total)} ر.س</span>
      </div>
    </div>
  </div>

  ${invoice.notes ? `
  <div class="notes">
    <div class="notes-label">ملاحظات</div>
    <div class="notes-text">${esc(invoice.notes)}</div>
  </div>` : ''}

  <!-- FOOTER -->
  <div class="inv-footer">
    <p>تم إصداره بواسطة منصة يقظ — yaqiz.me</p>
    <button class="print-btn" onclick="window.print()">🖨️ طباعة / PDF</button>
  </div>

</div>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);

  } catch (err) {
    console.error('[print]', err.message);
    res.status(500).send('<h2>خطأ في تحميل الفاتورة</h2>');
  }
}

module.exports = { printInvoice };
