// التشغيل: السيرفر شغّال محليًا (node src/app.js) + Playwright مثبّت، ثم
//   node scripts/accounting-cycle.e2e.js
// ينشئ منشأة تجريبية (اسم مستخدم cyc######) — احذفها بعد الفحص. حد التسجيل
// 5 حسابات بالساعة: أعد تشغيل السيرفر لو تكرر التشغيل.
// دورة محاسبية ومخزنية مكثفة لمنشأة جديدة عبر واجهة يقظ الحقيقية.
// بعد كل عملية: نقارن تغيّر الدفاتر (حسب مجموعات الحسابات) والمخزون والخزينة
// بالقيم المحسوبة يدويًا. بالنهاية: مطابقة كاملة مع السيرفر (SQL) وطبقات FIFO.
const { chromium } = require('playwright');
const path = require('path').resolve(__dirname, '..') + '/';
require(path + 'node_modules/dotenv').config({ path: path + '.env', quiet: true });
const { Pool } = require(path + 'node_modules/pg');
const pool = new Pool({ host: process.env.DB_HOST || 'localhost', port: process.env.DB_PORT || 5432, database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD });
const r2 = n => Math.round(n * 100) / 100;
let fails = 0, passes = 0;
const ok = (c, m) => { if (c) passes++; else fails++; console.log((c ? '  ✓ ' : '  ✗ FAIL ') + m); };

(async () => {
  const b = await chromium.launch({ channel: 'msedge' });
  // عامل الخدمة (sw.js) يمرّر الطلبات من غير ما يشوفها page.route — نوقفه بالاختبار فقط
  const ctx = await b.newContext({ viewport: { width: 1366, height: 860 }, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const errs = [], toastErr = [], popups = [];
  page.on('pageerror', e => errs.push('PAGEERR ' + e.message + ' @ ' + String(e.stack).split(String.fromCharCode(10)).slice(1,3).join(' / ')));
  page.on('dialog', d => d.accept());
  ctx.on('page', p => popups.push(p));
  page.on('response', async r => { if (r.url().includes('/api/') && r.status() >= 400 && !/quotes\?|loyalty$|bank-recon$|trial-balance/.test(r.url())) { let t = ''; try { t = (await r.text()).slice(0, 200); } catch (e) {} errs.push(`HTTP ${r.status()} ${r.request().method()} ${r.url().replace('http://localhost:3000', '')} ${t}`); } });
  await page.exposeFunction('_t', t => toastErr.push(t));
  await page.addInitScript(() => { document.addEventListener('DOMContentLoaded', () => { const o = window.showToast; if (o) window.showToast = function (m, t) { if (t === 'error') window._t(m); return o.apply(this, arguments); }; }); });

  // ── لقطة الحالة من الواجهة: مجموعات حسابات + مخزون + خزينة + أرصدة ──
  const snap = () => page.evaluate(() => {
    const db = getDB(); const g = { cash: 0, ar: 0, inv: 0, transit: 0, otherA: 0, ap: 0, vatOut: 0, vatIn: 0, otherL: 0, equity: 0, rev: 0, cogs: 0, exp: 0 };
    let unbalanced = 0;
    for (const j of db.journal || []) {
      let d = 0, c = 0;
      for (const e of j.entries || []) {
        const a = Number(e.amount) || 0, v = e.side === 'debit' ? a : -a, k = String(e.account_code || '');
        if (e.side === 'debit') d += a; else c += a;
        if (k === '1100') g.cash += v; else if (k === '1200') g.ar += v; else if (k === '1300') g.inv += v; else if (k === '1350') g.transit += v;
        else if (k[0] === '1') g.otherA += v; else if (k === '2100') g.ap -= v; else if (k === '2200') g.vatOut -= v; else if (k === '2210') g.vatIn += v;
        else if (k[0] === '2') g.otherL -= v; else if (k[0] === '3') g.equity -= v; else if (k[0] === '4') g.rev -= v; else if (k === '5100') g.cogs += v; else if (k[0] === '5') g.exp += v;
      }
      if (Math.abs(d - c) > 0.005) unbalanced++;
    }
    for (const k in g) g[k] = Math.round(g[k] * 100) / 100;
    return { g, unbalanced, journals: (db.journal || []).length, treasury: Math.round(db.treasury.balance * 100) / 100,
      qty: Object.fromEntries(db.products.map(p => [p.name, Number(p.qty)])),
      cust: Object.fromEntries(db.customers.map(c => [c.name, Math.round((c.balance || 0) * 100) / 100])),
      supp: Object.fromEntries(db.suppliers.map(s => [s.name, Math.round((s.balance || 0) * 100) / 100])) };
  });
  const settle = async (ms = 2500) => { await page.waitForTimeout(ms); await page.evaluate(() => { const mc = el('modal-container'); if (mc) mc.innerHTML = ''; }); };
  // يشغّل عملية ويقارن الفروقات بالمتوقع (القيم غير المذكورة يجب أن تبقى صفر)
  const op = async (name, fn, exp) => {
    console.log('\n▶ ' + name);
    const before = await snap(); toastErr.length = 0;
    await fn(); await settle(exp.wait || 3000);
    const after = await snap();
    ok(after.unbalanced === 0, 'all journal entries balanced');
    const d = {}; for (const k in after.g) d[k] = r2(after.g[k] - before.g[k]);
    const eg = exp.g || {};
    for (const k of Object.keys(d)) { const want = r2(eg[k] || 0); if (Math.abs(d[k] - want) > 0.005 || (eg[k] !== undefined)) ok(Math.abs(d[k] - want) <= 0.005, `GL ${k}: ${d[k]} (expected ${want})`); }
    if (exp.treasury !== undefined) ok(Math.abs(r2(after.treasury - before.treasury) - exp.treasury) < 0.005, `treasury Δ ${r2(after.treasury - before.treasury)} (expected ${exp.treasury})`);
    for (const [p, q] of Object.entries(exp.qty || {})) ok(Math.abs((after.qty[p] - before.qty[p]) - q) < 0.0005, `stock ${p} Δ ${after.qty[p] - before.qty[p]} (expected ${q})`);
    for (const [p, v] of Object.entries(exp.cust || {})) ok(Math.abs(r2(after.cust[p] - before.cust[p]) - v) < 0.005, `customer ${p} balance Δ ${r2(after.cust[p] - before.cust[p])} (expected ${v})`);
    for (const [p, v] of Object.entries(exp.supp || {})) ok(Math.abs(r2(after.supp[p] - before.supp[p]) - v) < 0.005, `supplier ${p} balance Δ ${r2(after.supp[p] - before.supp[p])} (expected ${v})`);
    if (toastErr.length) console.log('    toast errors:', toastErr.join(' | '));
    return after;
  };
  const prod = n => page.evaluate(n => getDB().products.find(p => p.name === n)?.id, n);
  const cust = n => page.evaluate(n => getDB().customers.find(p => p.name === n)?.id, n);
  const supp = n => page.evaluate(n => getDB().suppliers.find(p => p.name === n)?.id, n);
  const lastInv = () => page.evaluate(() => getDB().invoices.slice().sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0]);

  // ══ التسجيل والإعداد ══
  await page.goto('http://localhost:3000/');
  const sfx = Date.now().toString().slice(-6);
  const VAT = '3' + sfx + '12345673';
  await page.evaluate(async ({ sfx, uiLang }) => {
    const r = await fetch('/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ company_name: 'دورة محاسبية ' + sfx, username: 'cyc' + sfx, password: 'Cycle@1234', full_name: 'مدقق الدورة', contact_phone: '0551234567', plan: 'pro', vat_registered: true }) });
    const d = await r.json(); localStorage.setItem('yaqiz_access_token', d.accessToken); localStorage.setItem('yaqiz_refresh_token', d.refreshToken);
    localStorage.setItem('yaqiz_lang', uiLang);
  }, { sfx, uiLang: process.env.E2E_LANG || 'ar' });
  await page.goto('http://localhost:3000/VVIP.html');
  await page.waitForSelector('.qs-shell', { timeout: 20000 });
  await page.evaluate((VAT) => {
    const set = (k, v) => { const i = el('qs-' + k); if (i) { i.value = v; i.dispatchEvent(new Event('input', { bubbles: true })); } };
    set('vat_number', VAT); set('cr_number', '1010101010'); set('street_name', 'الملك فهد'); set('building_number', '1234'); set('district', 'العليا'); set('city', 'الرياض'); set('postal_code', '12345'); set('additional_number', '5678');
    qsNext();
  }, VAT);
  await page.waitForTimeout(600);
  console.log('QS step after store:', await page.evaluate(() => _qs.step), toastErr.join('|'));
  for (const [n, q, bp, sp] of [['صنف أ', 100, 10, 20], ['صنف ب', 50, 40, 70], ['صنف ج', 20, 5, 12]]) {
    await page.fill('#ob-p-name', n); await page.fill('#ob-p-qty', String(q)); await page.fill('#ob-p-buy', String(bp)); await page.fill('#ob-p-sell', String(sp));
    await page.evaluate(() => obAddProduct());
  }
  await page.evaluate(() => qsNext()); await page.waitForTimeout(300);
  await page.fill('#qs-cash-box', '10000'); await page.fill('#qs-cash-bank', '5000');
  await page.evaluate(() => qsNext()); await page.waitForTimeout(300);
  await page.evaluate(() => qsFinish('dashboard'));
  await settle(6000);
  let s0 = await snap();
  console.log('\n▶ opening balances');
  ok(s0.g.cash === 15000 && s0.g.inv === 3100 && s0.g.equity === 18100 && s0.unbalanced === 0, `opening: cash ${s0.g.cash}/15000, inventory ${s0.g.inv}/3100, capital ${s0.g.equity}/18100`);

  // عملاء وموردون
  await page.evaluate(() => {
    const db = getDB();
    db.customers.push({ id: nextId(db, 'customer'), name: 'شركة الأفق', phone: '0500000001', vat_num: '300000000000003', street_name: 'العليا', building_number: '2222', district: 'الورود', city: 'الرياض', postal_code: '11111', additional_number: '3333', balance: 0, credit_limit: 0, is_active: true });
    db.customers.push({ id: nextId(db, 'customer'), name: 'خالد', phone: '0500000002', balance: 0, credit_limit: 0, is_active: true });
    db.customers.push({ id: nextId(db, 'customer'), name: 'نادر', phone: '0500000009', balance: 0, credit_limit: 0, is_active: true });
    db.suppliers.push({ id: nextId(db, 'supplier'), name: 'مورد الخليج', phone: '0500000003', balance: 0, is_active: true });
    db.suppliers.push({ id: nextId(db, 'supplier'), name: 'مورد النخبة', phone: '0500000004', balance: 0, is_active: true });
    saveDB(db);
  });
  await settle(3500);

  // ══ المبيعات ══
  const A = await prod('صنف أ'), B = await prod('صنف ب'), C = await prod('صنف ج');
  const pos = async (items, method) => { await page.evaluate(() => goTo('pos')); await page.waitForTimeout(700); await page.evaluate(({ items, method }) => { cart = []; for (const [id, n] of items) for (let i = 0; i < n; i++) addToCart(id); setPosPayment(method); doCheckout(); }, { items, method }); };
  await op('1. POS simplified sale, cash: A×5', () => pos([[A, 5]], 'نقدي'), { g: { cash: 115, rev: 100, vatOut: 15, cogs: 50, inv: -50 }, treasury: 115, qty: { 'صنف أ': -5 } });
  const inv1 = await lastInv();
  await op('2. POS simplified sale, card: B×2', () => pos([[B, 2]], 'شبكة'), { g: { cash: 161, rev: 140, vatOut: 21, cogs: 80, inv: -80 }, treasury: 161, qty: { 'صنف ب': -2 } });

  const newInvoice = async ({ customer, type, items, payment, partial, discountPct }) => {
    await page.evaluate(() => goTo('sales')); await page.waitForTimeout(400);
    await page.evaluate(() => showNewInvoiceModal()); await page.waitForTimeout(400);
    await page.fill('#ni-customer', customer); await page.dispatchEvent('#ni-customer', 'input');
    if (type) await page.evaluate(t => { el('ni-type').value = t; setNewInvType(t); }, type);
    await page.evaluate(({ items, discountPct }) => { for (const [id, n] of items) { const p = getDB().products.find(x => x.id === id); newInvItems.push({ id: p.id, code: p.code, name: p.name, unit: 'قطعة', qty: n, price: p.sell_price, line_total: n * p.sell_price }); } if (discountPct) newInvDiscount = { type: 'percent', value: discountPct }; }, { items, discountPct });
    await page.selectOption('#ni-payment', payment);
    if (partial) await page.evaluate(v => { const e = el('ni-partial-amount'); if (e) e.value = v; }, String(partial));
    await page.evaluate(() => saveNewInvoice());
  };
  await op('3. B2B detailed tax invoice on credit to شركة الأفق: A×10 + B×3', () => newInvoice({ customer: 'شركة الأفق', type: 'tax', items: [[A, 10], [B, 3]], payment: 'آجل' }),
    { g: { ar: 471.5, rev: 410, vatOut: 61.5, cogs: 220, inv: -220 }, qty: { 'صنف أ': -10, 'صنف ب': -3 }, cust: { 'شركة الأفق': 471.5 } });
  const inv3 = await lastInv();
  console.log('    invoice type:', inv3.invoice_type, inv3.invoice_no, 'customer_vat:', inv3.customer_vat);
  await op('4. Invoice to خالد, 10% discount, partial payment 50: C×10', () => newInvoice({ customer: 'خالد', items: [[C, 10]], payment: 'جزئي', partial: 50, discountPct: 10 }),
    { g: { cash: 50, ar: 74.2, rev: 108, vatOut: 16.2, cogs: 50, inv: -50 }, treasury: 50, qty: { 'صنف ج': -10 }, cust: { 'خالد': 74.2 } });
  const inv4 = await lastInv();

  // ══ التحصيل ══
  const voucher = async (type, party, amount, link) => {
    await page.evaluate(() => goTo('receipts')); await page.waitForTimeout(300);
    await page.evaluate(t => showVoucherModal(t), type); await page.waitForTimeout(400);
    await page.evaluate(({ type, party, amount, link }) => {
      const db = getDB(); const p = (type === 'receipt' ? db.customers : db.suppliers).find(x => x.name === party);
      // نفس ترتيب المستخدم: يربط الفاتورة أولًا (تعبّي المتبقي تلقائيًا) ثم يعدّل المبلغ
      if (link) { const s = el(type === 'receipt' ? 'v-invoice-link' : 'v-purchase-link'); if (s) { s.value = String(link); s.dispatchEvent(new Event('change', { bubbles: true })); } }
      el('v-party').value = p.name; el('v-party-id').value = p.id; el('v-amount').value = String(amount);
      saveVoucher(type, false);
    }, { type, party, amount, link });
  };
  await op('5. Receipt 300 from شركة الأفق linked to the B2B invoice', () => voucher('receipt', 'شركة الأفق', 300, inv3.id),
    { g: { cash: 300, ar: -300 }, treasury: 300, cust: { 'شركة الأفق': -300 } });
  await op('6. Receipt 100 from خالد, unlinked (74.20 settles invoice, 25.80 advance)', () => voucher('receipt', 'خالد', 100),
    { g: { cash: 100, ar: -74.2, otherL: 25.8 }, treasury: 100, cust: { 'خالد': -100 } });

  // ══ المشتريات ══
  const purchase = async (vendor, items, payment) => {
    await page.evaluate(() => goTo('purchases')); await page.waitForTimeout(400);
    await page.evaluate(() => showAddGoodsPurchase()); await page.waitForTimeout(400);
    await page.fill('#gp-vendor', vendor);
    await page.evaluate(items => { for (const [id, n, price] of items) { const p = getDB().products.find(x => x.id === id); _goodsItems.push({ name: p.name, qty: n, price, line_total: n * price, vat: n * price * 0.15, product_id: id }); } }, items);
    await page.selectOption('#gp-payment', payment);
    await page.evaluate(() => saveGoodsPurchase());
  };
  await op('7. Credit purchase from مورد الخليج: A×50 @12', () => purchase('مورد الخليج', [[A, 50, 12]], 'آجل'),
    { g: { inv: 600, vatIn: 90, ap: 690 }, qty: { 'صنف أ': 50 }, supp: { 'مورد الخليج': 690 }, wait: 4500 });
  await op('8. Cash purchase from مورد النخبة: C×30 @6', () => purchase('مورد النخبة', [[C, 30, 6]], 'نقدي'),
    { g: { inv: 180, vatIn: 27, cash: -207 }, treasury: -207, qty: { 'صنف ج': 30 }, wait: 4500 });
  await op('9. Payment voucher 400 to مورد الخليج', () => voucher('payment', 'مورد الخليج', 400),
    { g: { cash: -400, ap: -400 }, treasury: -400, supp: { 'مورد الخليج': -400 } });

  const whMain = await page.evaluate(() => resolveActiveWarehouseId());
  const stockMove = async (pid, type, qty, reason) => {
    await page.evaluate(() => goTo('inventory')); await page.waitForTimeout(300);
    await page.evaluate(() => showStockMoveModal()); await page.waitForTimeout(400);
    await page.evaluate(({ pid, type, qty, reason, wh }) => { el('sm-product').value = String(pid); el('sm-type').value = type; el('sm-qty').value = String(qty); const r = el('sm-reason'); if (r) { if ([...r.options || []].some(o => o.value === reason)) r.value = reason; else if (r.options?.length) r.selectedIndex = 1; } const w = el('sm-warehouse'); if (w) w.value = String(wh); saveStockMove(); }, { pid, type, qty, reason, wh: whMain });
  };
  await op('9b. Damaged stock-out right after buying at a new price: A −2 → FIFO cost 20 (not last price 24)', () => stockMove(A, 'out', 2, 'تالف'),
    { g: { inv: -20, exp: 20 }, qty: { 'صنف أ': -2 }, wait: 4500 });

  // ══ المرتجعات ══
  const ret = async (type, linkId, prodId, qty, amount) => {
    await page.evaluate(t => showReturnModal(t), type); await page.waitForTimeout(500);
    await page.evaluate(({ type, linkId, prodId, qty, amount }) => {
      const l = el('rt-link'); l.value = String(linkId); onReturnLinkChange(type);
      el('rt-product').value = String(prodId); el('rt-qty').value = String(qty); el('rt-amount').value = String(amount); calcReturnVat();
      saveReturn(type);
    }, { type, linkId, prodId, qty, amount });
  };
  await op('10. Sales return from the B2B credit invoice: B×1 (80.50)', () => ret('sales', inv3.id, B, 1, 80.5),
    { g: { ar: -80.5, rev: -70, vatOut: -10.5, inv: 40, cogs: -40 }, qty: { 'صنف ب': 1 }, cust: { 'شركة الأفق': -80.5 } });
  await op('11. Sales return from the POS cash sale: A×2 (46 refunded cash)', () => ret('sales', inv1.id, A, 2, 46),
    { g: { cash: -46, rev: -40, vatOut: -6, inv: 20, cogs: -20 }, treasury: -46, qty: { 'صنف أ': 2 } });
  const pur7 = await page.evaluate(() => getDB().purchases.find(p => p.vendor === 'مورد الخليج'));
  await op('12. Purchase return to مورد الخليج: A×5 (69 incl. VAT)', () => ret('purchases', pur7.id, A, 5, 69),
    { g: { ap: -69, vatIn: -9, inv: -60 }, qty: { 'صنف أ': -5 }, supp: { 'مورد الخليج': -69 } });

  // ══ إلغاء فاتورة ══
  // حذف مرتجع: يجب أن يعكس كل أثره (المخزون والدفاتر والرصيد) محليًا وبالسيرفر
  await op('12b. Sales return from invoice 4 (خالد, fully settled): C×1 = 13.80 → cash refund', () => ret('sales', inv4.id, C, 1, 13.8),
    { g: { cash: -13.8, rev: -12, vatOut: -1.8, inv: 5, cogs: -5 }, treasury: -13.8, qty: { 'صنف ج': 1 } });
  await page.waitForTimeout(3000);
  const ret12b = await page.evaluate(() => getDB().returns.find(r => Math.abs(r.amount - 13.8) < 0.001));
  await op('12c. Try deleting it — must be refused (tax credit note issued)', () => page.evaluate(id => deleteReturn(id), ret12b.id),
    { g: {}, treasury: 0, qty: { 'صنف ج': 0 }, wait: 3000 });
  ok(await page.evaluate(id => !!getDB().returns.find(r => r.id === id), ret12b.id), 'return with credit note still exists');
  await op('12d. Purchase return to مورد الخليج: A×1 (13.80)', () => ret('purchases', pur7.id, A, 1, 13.8),
    { g: { ap: -13.8, vatIn: -1.8, inv: -12 }, qty: { 'صنف أ': -1 }, supp: { 'مورد الخليج': -13.8 } });
  await page.waitForTimeout(3000);
  const ret12d = await page.evaluate(() => getDB().returns.find(r => r.type === 'purchases' && Math.abs(r.amount - 13.8) < 0.001));
  await op('12e. Delete that purchase return (full reversal)', () => page.evaluate(id => deleteReturn(id), ret12d.id),
    { g: { ap: 13.8, vatIn: 1.8, inv: 12 }, qty: { 'صنف أ': 1 }, supp: { 'مورد الخليج': 13.8 }, wait: 4000 });

  await op('13a. Credit invoice to شركة الأفق (VAT-registered) left as simplified → saved as a tax invoice: A×4', () => newInvoice({ customer: 'شركة الأفق', type: 'simplified', items: [[A, 4]], payment: 'آجل' }),
    { g: { ar: 92, rev: 80, vatOut: 12, cogs: 40, inv: -40 }, qty: { 'صنف أ': -4 }, cust: { 'شركة الأفق': 92 } });
  const inv13 = await lastInv();
  {
    const srvType = (await pool.query('select invoice_type from invoices where id=$1', [inv13.id])).rows[0]?.invoice_type;
    ok(inv13.invoice_type === 'tax' && srvType === 'tax', 'buyer with a VAT number → B2B tax invoice automatically (app ' + inv13.invoice_type + ', server ' + srvType + ')');
  }
  await op('13b. Cancel that invoice (full reversal)', () => page.evaluate(id => cancelInvoice(id), inv13.id),
    { g: { ar: -92, rev: -80, vatOut: -12, cogs: -40, inv: 40 }, qty: { 'صنف أ': 4 }, cust: { 'شركة الأفق': -92 } });

  // ══ دفعة عميل مقدمة: رصيد دائن (2160) يُسوّى تلقائيًا من فواتيره الآجلة بقيد مستقل ══
  await op('13c. Advance 200 from نادر (no invoices) → credit balance 200 (2160)', () => voucher('receipt', 'نادر', 200),
    { g: { cash: 200, otherL: 200 }, treasury: 200, cust: { 'نادر': -200 } });
  await op('13d. Credit invoice to نادر A×4 = 92 → fully settled from the advance', () => newInvoice({ customer: 'نادر', items: [[A, 4]], payment: 'آجل' }),
    { g: { ar: 0, otherL: -92, rev: 80, vatOut: 12, cogs: 40, inv: -40 }, qty: { 'صنف أ': -4 }, cust: { 'نادر': 92 } });
  const inv13d = await lastInv();
  ok(inv13d.status === 'مسددة' && Math.abs(inv13d.paid_amount - 92) < 0.01 && Math.abs((inv13d.advance_applied || 0) - 92) < 0.01, 'invoice paid from the advance → ' + inv13d.status + ' ' + inv13d.paid_amount);
  await op('13e. Credit invoice to نادر A×10 = 230 → 108 from the advance, 122 owed', () => newInvoice({ customer: 'نادر', items: [[A, 10]], payment: 'آجل' }),
    { g: { ar: 122, otherL: -108, rev: 200, vatOut: 30, cogs: 100, inv: -100 }, qty: { 'صنف أ': -10 }, cust: { 'نادر': 230 } });
  const inv13e = await lastInv();
  ok(inv13e.status === 'جزئي' && Math.abs(inv13e.paid_amount - 108) < 0.01, 'invoice partly settled from the advance → ' + inv13e.status + ' ' + inv13e.paid_amount);
  {
    const adv = await page.evaluate(() => getDB().journal.filter(j => /^ADV-/.test(j.ref || '')).map(j => ({ ref: j.ref, s: j._serverId, d: j.entries.find(e => e.account_code === '2160' && e.side === 'debit')?.amount })));
    ok(adv.length === 2 && adv.every(a => a.s), 'settlement entries (Dr 2160 / Cr 1200) posted by the server, visible in the journal → ' + JSON.stringify(adv));
  }
  const v13c = await page.evaluate(() => getDB().receipts.find(r => r.party === 'نادر').id);
  await op('13f. Cancel the advance voucher after it was used → refused', () => page.evaluate(id => deleteReceipt(id), v13c),
    { g: { cash: 0, otherL: 0 }, treasury: 0, cust: { 'نادر': 0 } });
  await op('13g. Cancel invoice 13e → its settled 108 goes back to the customer credit, no cash refund', () => page.evaluate(id => cancelInvoice(id), inv13e.id),
    { g: { ar: -122, otherL: 108, rev: -200, vatOut: -30, cogs: -100, inv: 100 }, treasury: 0, qty: { 'صنف أ': 10 }, cust: { 'نادر': -230 }, wait: 5000 });

  await op('13h. Cash invoice to نادر A×10 = 230 → 108 from the advance + 122 cash (compound)', () => newInvoice({ customer: 'نادر', items: [[A, 10]], payment: 'نقدي' }),
    { g: { cash: 122, ar: 0, otherL: -108, rev: 200, vatOut: 30, cogs: 100, inv: -100 }, treasury: 122, qty: { 'صنف أ': -10 }, cust: { 'نادر': 108 } });
  {
    const i = await lastInv();
    ok(i.status === 'مسددة' && Math.abs((i.advance_applied || 0) - 108) < 0.01, 'cash invoice: advance 108 deducted first, the rest in cash → ' + i.status + ' adv ' + i.advance_applied);
  }

  // ══ المخزون: تسويات وتحويل بين الفروع ══
  // ج: بعد البيع (10 من طبقة 5) والشراء (30 بـ6): سعر الشراء الحالي 6
  await op('14. Manual stock-in (found): C +5', () => stockMove(C, 'in', 5, 'جرد'), { g: { inv: 30, rev: 30 }, qty: { 'صنف ج': 5 } });
  // أ: طبقات FIFO الحالية تبدأ بتكلفة 10 → خروج 3 = 30 (سعر الشراء الحالي 12 → قد يُقيَّد 36)
  await op('15. Manual stock-out (damaged): A −3 at FIFO cost', () => stockMove(A, 'out', 3, 'تالف'), { g: { inv: -30, exp: 30 }, qty: { 'صنف أ': -3 } });

  // فرع ثاني + تحويل مخزون
  await page.evaluate(() => goTo('branches')); await page.waitForTimeout(400);
  await page.evaluate(() => { showBranchModal(); }); await page.waitForTimeout(400);
  await page.evaluate(() => { el('br-name').value = 'فرع جدة'; el('br-number').value = '2'; saveBranch(); });
  await settle(4000);
  const wh2 = await page.evaluate(() => { const b = getDB().branches.find(x => x.name === 'فرع جدة'); return { b: b?.id, w: (getDB().warehouses || []).find(w => w.branch_id === b?.id)?.id }; });
  console.log('    branch 2:', JSON.stringify(wh2));
  await op('16. Stock transfer A×20 main → فرع جدة (no GL effect)', async () => {
    await page.evaluate(() => goTo('inventory')); await page.waitForTimeout(300);
    await page.evaluate(() => showStockTransferModal()); await page.waitForTimeout(500);
    await page.evaluate(({ from, to, A }) => {
      el('tr-from').value = String(from); el('tr-from').dispatchEvent(new Event('change', { bubbles: true }));
      el('tr-to').value = String(to); el('tr-to').dispatchEvent(new Event('change', { bubbles: true }));
    }, { from: whMain, to: wh2.w, A });
    await page.waitForTimeout(300);
    await page.evaluate(({ A }) => { const inp = document.querySelector('[data-tr-product="' + A + '"]'); if (inp) inp.value = '20'; saveStockTransfer(); }, { A });
  }, { g: {}, qty: { 'صنف أ': 0 }, wait: 4000 });
  const stockBr = await page.evaluate(({ A, w1, w2 }) => ({ main: getWarehouseStockQty(getDB(), A, w1), br2: getWarehouseStockQty(getDB(), A, w2) }), { A, w1: whMain, w2: wh2.w });
  console.log('    A per warehouse:', JSON.stringify(stockBr));
  ok(stockBr.br2 === 20, 'branch 2 warehouse holds the 20 transferred units');

  // بيع من الفرع الثاني
  await op('17. POS sale at فرع جدة: A×1 cash', async () => { await page.evaluate(b => { _manualActiveBranchId = b; }, wh2.b); await pos([[A, 1]], 'نقدي'); },
    { g: { cash: 23, rev: 20, vatOut: 3, cogs: 10, inv: -10 }, treasury: 23, qty: { 'صنف أ': -1 } });
  const brAfter = await page.evaluate(({ A, w2 }) => getWarehouseStockQty(getDB(), A, w2), { A, w2: wh2.w });
  ok(brAfter === 19, 'branch-2 stock dropped to 19 (sale deducted from the selling branch) — got ' + brAfter);
  await page.evaluate(() => { _manualActiveBranchId = null; });

  // ══ مسارات المخزون الإضافية ══
  await op('26. New product with opening qty (inventory → add product): D 10 @8', async () => {
    await page.evaluate(() => goTo('inventory')); await page.waitForTimeout(300);
    await page.evaluate(() => showProductModal()); await page.waitForTimeout(400);
    await page.evaluate(() => { el('pr-name').value = 'صنف د'; el('pr-code').value = 'D-1'; el('pr-buy').value = '8'; el('pr-sell').value = '15'; el('pr-qty').value = '10'; saveProduct(); });
  }, { g: { inv: 80, equity: 80 }, wait: 4500 });
  const D = await prod('صنف د');
  ok(await page.evaluate(id => getDB().products.find(p => p.id === id)?.qty === 10, D), 'D created with qty 10');
  await op('27. Editing a product cannot change its quantity (field is read-only)', async () => {
    await page.evaluate(id => showProductModal(id), D); await page.waitForTimeout(400);
    ok(await page.evaluate(() => el('pr-qty').readOnly === true), 'quantity field is read-only on edit');
    await page.evaluate(id => { el('pr-qty').value = '99'; el('pr-sell').value = '16'; saveProduct(id); }, D);
  }, { g: {}, qty: { 'صنف د': 0 }, wait: 3500 });
  await op('28. Excel import: existing D set to 12 (+2 adjustment) and new E 5 @4 (opening)', () => page.evaluate(() => {
    confirmImport([{ name: 'صنف د', code: 'D-1', qty: 12, buy_price: 8, sell_price: 16 }, { name: 'صنف هـ', code: 'E-1', qty: 5, buy_price: 4, sell_price: 9 }], 'inventory', 'excel');
  }), { g: { inv: 36, rev: 16, equity: 20 }, qty: { 'صنف د': 2 }, wait: 5000 });
  ok(await page.evaluate(() => getDB().products.find(p => p.name === 'صنف هـ')?.qty === 5), 'E imported with qty 5');

  // أمر شراء ← استلام
  await op('29. Purchase order (D×5 @8) → received as a credit purchase', async () => {
    await page.evaluate(() => goTo('purchases')); await page.waitForTimeout(300);
    await page.evaluate(() => { showPOModal(); }); await page.waitForTimeout(400);
    await page.evaluate(() => { el('po-supplier').value = 'مورد الخليج'; window._poItems = [{ name: 'صنف د', qty: 5, price: 8, total: 40 }]; savePO(); });
    await page.waitForTimeout(2500);
    const poId = await page.evaluate(() => getDB().purchase_orders.slice(-1)[0].id);
    await page.evaluate(id => { el('modal-container').innerHTML = ''; startPOReceive(id); }, poId); await page.waitForTimeout(500);
    await page.selectOption('#gp-payment', 'آجل');
    await page.evaluate(() => saveGoodsPurchase());
  }, { g: { inv: 40, vatIn: 6, ap: 46 }, qty: { 'صنف د': 5 }, supp: { 'مورد الخليج': 46 }, wait: 5000 });
  ok(await page.evaluate(() => getDB().purchase_orders.slice(-1)[0].status !== 'معلق'), 'purchase order no longer pending after receipt: ' + await page.evaluate(() => getDB().purchase_orders.slice(-1)[0].status));

  // فاتورة شراء مقروءة بالذكاء الاصطناعي: صنف معروف + صنف جديد غير مسجّل
  await op('30. AI-read supplier invoice (cash): C×4 @5 (known) + new item ×3 @7 (created from the purchase)', async () => {
    await page.evaluate(() => goTo('purchases')); await page.waitForTimeout(300);
    await page.evaluate(() => openPurchaseFormWithAIData({ vendor: 'مورد النخبة', invoice_no: 'AI-77', items: [{ description: 'صنف ج', qty: 4, unit_price: 5, total: 20 }, { description: 'صنف مستورد جديد', qty: 3, unit_price: 7, total: 21 }] }, null));
    await page.waitForTimeout(500);
    await page.selectOption('#gp-payment', 'نقدي');
    await page.evaluate(() => saveGoodsPurchase());
    await page.waitForTimeout(1500);
    const missing = await page.evaluate(() => !!el('mp-code-0'));
    ok(missing, 'new item opens the "create product" form');
    if (missing) await page.evaluate(() => { el('mp-code-0').value = 'NEW-AI-1'; el('mp-sell-0').value = '12'; saveMissingProducts(); });
  }, { g: { inv: 41, vatIn: 6.15, cash: -47.15 }, treasury: -47.15, qty: { 'صنف ج': 4 }, wait: 5500 });
  ok(await page.evaluate(() => getDB().products.find(p => p.name === 'صنف مستورد جديد')?.qty === 3), 'new AI item exists with qty 3');

  // شراء لفرع جدة
  await op('31. Cash purchase into فرع جدة: A×10 @12', async () => {
    await page.evaluate(() => goTo('purchases')); await page.waitForTimeout(300);
    await page.evaluate(() => showAddGoodsPurchase()); await page.waitForTimeout(400);
    await page.fill('#gp-vendor', 'مورد الخليج');
    await page.evaluate(({ A, b }) => { const p = getDB().products.find(x => x.id === A); _goodsItems.push({ name: p.name, qty: 10, price: 12, line_total: 120, vat: 18, product_id: A }); const sel = el('gp-branch'); if (sel) sel.value = String(b); }, { A, b: wh2.b });
    await page.selectOption('#gp-payment', 'نقدي');
    await page.evaluate(() => saveGoodsPurchase());
  }, { g: { inv: 120, vatIn: 18, cash: -138 }, treasury: -138, qty: { 'صنف أ': 10 }, wait: 5000 });
  const br2A = await page.evaluate(({ A, w2 }) => getWarehouseStockQty(getDB(), A, w2), { A, w2: wh2.w });
  ok(br2A === 29, 'فرع جدة warehouse received the 10 units (19 → 29): ' + br2A);

  // بيع أكثر من المتوفر
  const bAvail = await page.evaluate(B => getDB().products.find(p => p.id === B).qty, B);
  await op('32a. POS: adding more than available stock is capped', async () => {
    await page.evaluate(() => goTo('pos')); await page.waitForTimeout(500);
    await page.evaluate(({ B, n }) => { cart = []; for (let i = 0; i < n + 3; i++) addToCart(B); }, { B, n: bAvail });
    const inCart = await page.evaluate(B => (cart.find(c => c.id === B) || {}).qty || 0, B);
    ok(inCart <= bAvail, `cart capped at available stock (${inCart} ≤ ${bAvail})`);
    await page.evaluate(() => { cart = []; });
  }, { g: {}, wait: 1000 });
  const invCount0 = await page.evaluate(() => getDB().invoices.length);
  await op('32b. Invoice for more than available stock is refused (nothing recorded)', () => newInvoice({ customer: 'شركة الأفق', type: 'tax', items: [[B, bAvail + 50]], payment: 'آجل' }),
    { g: {}, qty: { 'صنف ب': 0 }, wait: 4000 });
  ok(await page.evaluate(() => getDB().invoices.length) === invCount0, 'no invoice was created');
  await page.evaluate(() => { el('modal-container').innerHTML = ''; });

  // حذف منتج
  await op('33a. Deleting a product that still has stock is refused', () => page.evaluate(id => deleteProduct(id), D), { g: {}, qty: { 'صنف د': 0 }, wait: 2500 });
  ok(await page.evaluate(id => !!getDB().products.find(p => p.id === id), D), 'product with stock still exists');
  await page.evaluate(() => { const db = getDB(); db.products.push({ id: nextId(db, 'product'), name: 'صنف فارغ', code: 'Z-0', buy_price: 1, sell_price: 2, qty: 0, min_qty: 0 }); saveDB(db); });
  await settle(3500);
  const Z = await prod('صنف فارغ');
  await op('33b. Deleting a product with zero stock works', () => page.evaluate(id => deleteProduct(id), Z), { g: {}, wait: 4000 });
  ok(!(await prod('صنف فارغ')), 'zero-stock product removed');

  // تعديل الأرصدة الافتتاحية بعد حفظها
  await op('34. Edit opening balances: cash in drawer 10000 → 11000', () => page.evaluate(() => {
    showOpeningBalancesWizard(true);
    _obData.cash_box = (_obData.cash_box || 0) + 1000;
    _obStep = _obActiveSteps().length;
    obSaveAll();
  }), { g: { cash: 1000, equity: 1000 }, treasury: 1000, wait: 5000 });
  await page.evaluate(() => { el('modal-container').innerHTML = ''; });

  // ══ عرض سعر ← فاتورة ══
  await op('18. Quote to شركة الأفق B×1 → converted to invoice', async () => {
    await page.evaluate(() => goTo('quotes')); await page.waitForTimeout(400);
    await page.evaluate(() => showQuoteModal()); await page.waitForTimeout(400);
    await page.evaluate(() => { el('q-customer').value = 'شركة الأفق'; c_quoteItems.push({ name: 'صنف ب', qty: 1, price: 70, line_total: 70 }); saveQuote(false); });
    await page.waitForTimeout(3000);
    await page.evaluate(() => { el('modal-container').innerHTML = ''; const q = getDB().quotes.slice(-1)[0]; return convertQuoteToInvoice(q.id); });
  }, { g: { ar: 80.5, rev: 70, vatOut: 10.5, cogs: 40, inv: -40 }, qty: { 'صنف ب': -1 }, cust: { 'شركة الأفق': 80.5 }, wait: 5000 });

  // ══ المصاريف والرواتب والالتزامات ══
  await op('19. Admin expense 500 + VAT 75, cash', async () => { await page.evaluate(() => goTo('obligations')); await page.waitForTimeout(300); await page.evaluate(() => showAddOpexPurchase()); await page.waitForTimeout(400); await page.evaluate(() => { el('p-vendor').value = 'شركة الكهرباء'; el('p-amount').value = '500'; savePurchase('opex'); }); },
    { g: { exp: 500, vatIn: 75, cash: -575 }, treasury: -575 });

  // السيرفر يرفض المصروف (نحاكي رفضًا 403) → القيد وحركة الخزينة والمصروف نفسه يُلغون محليًا،
  // وما يوصل للسيرفر أي قيد بلا مستنده
  {
    let blocked = 0;
    await page.route(u => new URL(u).pathname === '/api/purchases', route => {
      if (route.request().method() === 'POST' && !blocked) { blocked++; return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ success: false, message: 'ليس لديك صلاحية لهذه العملية' }) }); }
      return route.continue();
    });
    const nBefore = await page.evaluate(() => getDB().purchases.filter(p => p.vendor === 'مصروف مرفوض').length);
    await op('19b. Admin expense rejected by the server → its entry and cash movement are undone', async () => { await page.evaluate(() => showAddOpexPurchase()); await page.waitForTimeout(400); await page.evaluate(() => { el('p-vendor').value = 'مصروف مرفوض'; el('p-amount').value = '40'; savePurchase('opex'); }); },
      { g: { exp: 0, vatIn: 0, cash: 0 }, treasury: 0, wait: 5000 });
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    const after = await page.evaluate(() => ({ p: getDB().purchases.filter(p => p.vendor === 'مصروف مرفوض').length, j: getDB().journal.filter(j => (j.description || '').includes('مصروف مرفوض')).length }));
    const srvJ = (await pool.query("select count(*)::int n from journal_entries where company_id=(select company_id from users where username=$1) and description like '%مصروف مرفوض%'", ['cyc' + sfx])).rows[0].n;
    ok(blocked === 1 && after.p === nBefore && after.j === 0 && srvJ === 0, 'rejected expense removed locally, no orphan entry on the server → ' + JSON.stringify({ blocked, after, srvJ }));
  }
  await op('20. Recurring obligation (rent 2000) paid in full', async () => {
    await page.evaluate(() => goTo('obligations')); await page.waitForTimeout(300);
    await page.evaluate(() => { showObligationModal(); }); await page.waitForTimeout(400);
    await page.evaluate(() => { el('ob-name').value = 'إيجار المحل'; el('ob-amount').value = '2000'; if (el('ob-vendor')) el('ob-vendor').value = 'المالك'; saveObligation(); });
    await page.waitForTimeout(2500);
    const oid = await page.evaluate(() => getDB().obligations.find(o => o.name === 'إيجار المحل')?.id);
    await page.evaluate(id => { el('modal-container').innerHTML = ''; payObligation(id); }, oid); await page.waitForTimeout(500);
    await page.evaluate(id => confirmObligationPayment(id, 'full', 2000, 'نقدي'), oid);
  }, { g: { exp: 2000, cash: -2000 }, treasury: -2000, wait: 4000 });
  await op('20b. Obligation WITH VAT (internet 115 incl. 15%) paid', async () => {
    await page.evaluate(() => { showObligationModal(); }); await page.waitForTimeout(400);
    await page.evaluate(() => { el('ob-name').value = 'اشتراك الإنترنت'; el('ob-amount').value = '115'; el('ob-vat').checked = true; saveObligation(); });
    await page.waitForTimeout(2500);
    const oid = await page.evaluate(() => getDB().obligations.find(o => o.name === 'اشتراك الإنترنت')?.id);
    await page.evaluate(id => { el('modal-container').innerHTML = ''; confirmObligationPayment(id, 'full', 115, 'نقدي'); }, oid);
  }, { g: { exp: 100, vatIn: 15, cash: -115 }, treasury: -115, wait: 4000 });
  await op('21. Employee salary 4000', async () => {
    await page.evaluate(() => goTo('employees')); await page.waitForTimeout(300);
    await page.evaluate(() => showEmployeeModal()); await page.waitForTimeout(300);
    await page.evaluate(() => { el('em-name').value = 'أحمد الكاشير'; el('em-salary').value = '4000'; if (el('em-pos')) el('em-pos').value = 'كاشير'; saveEmployee(); });
    await page.waitForTimeout(2500);
    const eid = await page.evaluate(() => getDB().employees.find(e => e.name === 'أحمد الكاشير')?.id);
    await page.evaluate(id => { el('modal-container').innerHTML = ''; showPaySalaryModal(id); }, eid); await page.waitForTimeout(400);
    await page.evaluate(id => paySalary(id), eid);
  }, { g: { exp: 4000, cash: -4000 }, treasury: -4000, wait: 4000 });

  // ══ قيود يدوية وتصحيحها ══
  const manualJE = async (desc, lines) => {
    await page.evaluate(() => goTo('journal')); await page.waitForTimeout(300);
    await page.evaluate(() => showJournalModal()); await page.waitForTimeout(400);
    await page.evaluate(({ desc, lines }) => {
      el('je-desc').value = desc;
      window._jEntries = lines.map(([code, side, amount]) => { const a = (getDB().accounts || []).find(x => x.code === code); return { account: a ? `${code} - ${a.name}` : code, account_code: code, side, amount }; });
      saveJournalEntry();
    }, { desc, lines });
  };
  await op('22a. Manual journal (mistake): Dr 5200 expense 150 / Cr 1100 cash', () => manualJE('قيد خاطئ: صيانة', [['5200', 'debit', 150], ['1100', 'credit', 150]]), { g: { exp: 150, cash: -150 } });
  await op('22b. Correcting reversal entry: Dr 1100 150 / Cr 5200 150', () => manualJE('عكس القيد الخاطئ', [['1100', 'debit', 150], ['5200', 'credit', 150]]), { g: { exp: -150, cash: 150 } });
  await op('22c. Correct entry: owner capital injection Dr 1100 1000 / Cr 3000 1000', () => manualJE('زيادة رأس المال', [['1100', 'debit', 1000], ['3000', 'credit', 1000]]), { g: { cash: 1000, equity: 1000 }, treasury: 1000 });

  // ══ إيداع/سحب يدوي من الخزينة ══
  const trMove = async (type, kind, amount, desc) => {
    await page.evaluate(() => goTo('treasury')); await page.waitForTimeout(300);
    await page.evaluate(t => showTreasuryMove(t), type); await page.waitForTimeout(300);
    await page.evaluate(({ type, kind, amount, desc }) => { el('tr-amount').value = String(amount); el('tr-desc').value = desc; el('tr-kind').value = kind; saveTreasuryMove(type); }, { type, kind, amount, desc });
  };
  await op('22d. Treasury deposit — owner funding 500 (equity, not income)', () => trMove('in', 'owner', 500, 'تمويل من المالك'), { g: { cash: 500, equity: 500 }, treasury: 500 });
  await op('22e. Treasury withdrawal — owner drawings 200 (equity, not expense)', () => trMove('out', 'owner', 200, 'مسحوبات شخصية'), { g: { cash: -200, equity: -200 }, treasury: -200 });
  await op('22f. Treasury withdrawal — other expense 50', () => trMove('out', 'other', 50, 'إكرامية'), { g: { cash: -50, exp: 50 }, treasury: -50 });
  await op('22g. Treasury move without a reason — refused', () => trMove('in', '', 999, 'بدون سبب'), { g: {}, treasury: 0 });

  // ══ حذف سند بعد مزامنته (يجب أن يعكس كل أثره) ══
  await op('23a. Receipt 25 from شركة الأفق (to be deleted)', () => voucher('receipt', 'شركة الأفق', 25), { g: { cash: 25, ar: -25 }, treasury: 25, cust: { 'شركة الأفق': -25 } });
  await page.waitForTimeout(2000);
  const vdel = await page.evaluate(() => getDB().receipts.filter(r => r.amount === 25).map(r => ({ id: r.id, no: r.voucher_no, sid: r._serverId })));
  console.log('    voucher to delete:', JSON.stringify(vdel));
  const vRef = await page.evaluate(() => getDB().journal.filter(j => /^(RCV|RCP)-/.test(j.ref || '') && (j.entries || []).some(e => Number(e.amount) === 25)).map(j => ({ id: j.id, ref: j.ref, sid: j._serverId })));
  console.log('    its journal entries before cancelling:', JSON.stringify(vRef));
  await op('23b. Delete that voucher after it synced', () => page.evaluate(id => deleteReceipt(id), vdel[0].id), { g: { cash: -25, ar: 25 }, treasury: -25, cust: { 'شركة الأفق': 25 }, wait: 4000 });
  {
    const ref0 = vRef[0] && vRef[0].ref;
    const jv = await page.evaluate(r => getDB().journal.filter(j => j.ref === r || (j.ref || '').startsWith('REV-' + r + '#')).map(j => j.ref), ref0);
    ok(jv.length === 2 && jv.some(r => r.startsWith('REV-')), 'cancelled voucher: original journal entry kept + one reversing entry added → ' + JSON.stringify(jv));
  }

  // ══ التصحيح بقيد عكسي (لا حذف ولا تعديل) ══
  // رقم الفاتورة الجديد بعد ما تتزامن (معرّفها المحلي يتبدّل بمعرّف السيرفر)
  const knownNos = () => page.evaluate(() => getDB().purchases.map(p => p.purchase_no).filter(Boolean));
  const newPurchaseNo = async (before, ms = 20000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const n = await page.evaluate(b => getDB().purchases.map(p => p.purchase_no).filter(x => x && !b.includes(x)), before);
      if (n.length) return n[0]; await page.waitForTimeout(700);
    }
    return null;
  };
  const reversePurchase = async (pid, reason) => {
    await page.evaluate(id => { el('modal-container').innerHTML = ''; showPurchaseCorrection(id); }, pid); await page.waitForTimeout(300);
    await page.evaluate(r => { el('corr-reason').value = r; }, reason);
    await page.evaluate(id => doPurchaseCorrection(id), pid);
  };
  const purchaseByNo = no => page.evaluate(no => getDB().purchases.find(p => p.purchase_no === no), no);
  let nos = await knownNos();
  await op('26a. Credit purchase (mistake): B×10 @40', async () => {
    await purchase('مورد الخليج', [[B, 10, 40]], 'آجل');
    await page.waitForTimeout(300);
  }, { g: { inv: 400, vatIn: 60, ap: 460 }, qty: { 'صنف ب': 10 }, supp: { 'مورد الخليج': 460 }, wait: 4500 });
  const noWrong = await newPurchaseNo(nos);
  const pWrong = await purchaseByNo(noWrong);
  ok(!!noWrong, 'purchase synced to server: ' + noWrong);
  await op('26b. Reverse it ("recorded by mistake") → stock, VAT and supplier all restored', () => reversePurchase(pWrong.id, 'الكمية الصحيحة 8 مو 10'),
    { g: { inv: -400, vatIn: -60, ap: -460 }, qty: { 'صنف ب': -10 }, supp: { 'مورد الخليج': -460 }, treasury: 0, wait: 4500 });
  {
    const p = await purchaseByNo(noWrong);
    const js = await page.evaluate(no => getDB().journal.filter(j => (j.ref || '') === 'REV-' + no).length, noWrong);
    const srv = (await pool.query("select status, remaining::float r, reversal_reason from purchases where purchase_no=$1 and company_id=(select company_id from users where username=$2)", [noWrong, 'cyc' + sfx])).rows[0];
    ok(p && p.status === 'معكوسة', 'original purchase kept, marked "معكوسة" (not deleted)');
    ok(js === 1, 'one reversing journal entry REV-' + noWrong);
    ok(srv && srv.status === 'reversed' && srv.r === 0 && /الكمية/.test(srv.reversal_reason || ''), 'server: purchase reversed, remaining 0, reason stored → ' + JSON.stringify(srv));
  }
  const dlg = []; page.on('dialog', d => dlg.push(d.message()));
  await op('26c. Re-enter the correct one (pre-filled copy, qty 8) — not flagged as duplicate', async () => {
    await page.evaluate(id => reEnterPurchase(id), pWrong.id); await page.waitForTimeout(500);
    await page.evaluate(() => { _goodsItems[0].qty = 8; _goodsItems[0].line_total = 320; _goodsItems[0].vat = 48; renderGPItems(); updateGPTotals(); });
    await page.selectOption('#gp-payment', 'آجل');
    await page.evaluate(() => saveGoodsPurchase());
  }, { g: { inv: 320, vatIn: 48, ap: 368 }, qty: { 'صنف ب': 8 }, supp: { 'مورد الخليج': 368 }, wait: 4500 });
  ok(!dlg.some(m => /مسجّلة سابقًا|already recorded/.test(m)), 'no duplicate-invoice warning against the reversed one');
  nos = await knownNos();
  await op('26d. Cash purchase (mistake): C×10 @6', () => purchase('مورد النخبة', [[C, 10, 6]], 'نقدي'),
    { g: { inv: 60, vatIn: 9, cash: -69 }, treasury: -69, qty: { 'صنف ج': 10 }, wait: 4500 });
  const noCash = await newPurchaseNo(nos); const pCash = await purchaseByNo(noCash);
  await op('26e. Reverse the cash purchase → money back to treasury', () => reversePurchase(pCash.id, 'مسجّلة مرتين'),
    { g: { inv: -60, vatIn: -9, cash: 69 }, treasury: 69, qty: { 'صنف ج': -10 }, wait: 4500 });
  nos = await knownNos();
  let noPaid = null;
  await op('26f. Credit purchase A×5 @12 then quick-pay 30', async () => {
    await purchase('مورد الخليج', [[A, 5, 12]], 'آجل'); await page.waitForTimeout(500);
    noPaid = await newPurchaseNo(nos);
    const pp = await purchaseByNo(noPaid);
    await page.evaluate(id => { el('modal-container').innerHTML = ''; quickPayPurchase(id); }, pp.id); await page.waitForTimeout(300);
    await page.evaluate(id => { el('qpp-amount').value = '30'; saveQuickPayPurchase(id); }, pp.id);
  }, { g: { inv: 60, vatIn: 9, ap: 39, cash: -30 }, treasury: -30, qty: { 'صنف أ': 5 }, supp: { 'مورد الخليج': 39 }, wait: 5000 });
  await page.waitForTimeout(3000);
  const pPaid = await purchaseByNo(noPaid);
  await op('26g. Reversing a purchase that has a payment voucher → refused (cancel the voucher first)', () => reversePurchase(pPaid.id, 'تجربة'), { g: {}, treasury: 0, wait: 2500 });
  const qpv = await page.evaluate(id => getDB().receipts.find(v => v.linked_purchase_id === id), pPaid.id);
  ok(!!qpv, 'quick-pay voucher is linked to its purchase (' + (qpv && qpv.voucher_no) + ')');
  await page.waitForTimeout(3000);
  await op('26h. Cancel the quick-pay voucher → reversing entry, purchase unpaid again', () => page.evaluate(id => deleteReceipt(id), qpv.id),
    { g: { cash: 30, ap: 30 }, treasury: 30, supp: { 'مورد الخليج': 30 }, wait: 4000 });
  await page.waitForTimeout(5000); // إلغاء السند وإرجاع المدفوع يوصلون للسيرفر قبل العكس
  await op('26i. Now reverse that purchase', () => reversePurchase(pPaid.id, 'المورد غلط'),
    { g: { inv: -60, vatIn: -9, ap: -69 }, qty: { 'صنف أ': -5 }, supp: { 'مورد الخليج': -69 }, treasury: 0, wait: 4500 });
  const opex500 = await page.evaluate(() => getDB().purchases.find(p => p.purchase_type === 'opex' && Math.abs(p.amount - 500) < 0.01));
  await op('26j. Reverse the admin expense (500 + VAT 75, cash)', () => reversePurchase(opex500.id, 'فاتورة كهرباء مكررة'),
    { g: { exp: -500, vatIn: -75, cash: 575 }, treasury: 575, wait: 4500 });
  const emp = await page.evaluate(() => getDB().employees.find(e => e.name === 'أحمد الكاشير'));
  const salJ = await page.evaluate(n => getDB().journal.find(j => /^SAL-/.test(j.ref || '') && (j.description || '').includes(n)), emp.name);
  ok(!!(salJ && salJ._serverId), 'salary journal entry synced (' + (salJ && salJ._serverId) + ')');
  await op('26k. Reverse the 4000 salary payment', async () => {
    await page.evaluate(({ jid, eid }) => { el('modal-container').innerHTML = ''; reverseSalaryPayment(jid, eid); }, { jid: salJ.id, eid: emp.id }); await page.waitForTimeout(300);
    await page.evaluate(() => { el('corr-reason').value = 'المبلغ الصحيح 3500'; el('corr-ok').click(); });
  }, { g: { exp: -4000, cash: 4000 }, treasury: 4000 });
  await op('26l. Pay the correct salary 3500', async () => {
    await page.evaluate(id => { el('modal-container').innerHTML = ''; showPaySalaryModal(id); }, emp.id); await page.waitForTimeout(400);
    await page.evaluate(id => { el('ps-amount').value = '3500'; paySalary(id); }, emp.id);
  }, { g: { exp: 3500, cash: -3500 }, treasury: -3500 });
  ok(await page.evaluate(({ jid }) => { el('modal-container').innerHTML = ''; showSalaryHistory(getDB().employees.find(e => e.name === 'أحمد الكاشير').id); return /معكوسة|Reversed/.test(el('modal-container').innerText) && !!jeReversalOf(getDB(), getDB().journal.find(j => j.id === jid)); }, { jid: salJ.id }),
    'salary history shows the original payment as reversed');
  await op('26m. Manual journal (mistake): Dr 5200 30 / Cr 1100 30', () => manualJE('قيد خاطئ: ضيافة', [['5200', 'debit', 30], ['1100', 'credit', 30]]), { g: { exp: 30, cash: -30 }, treasury: -30 });
  await page.waitForTimeout(3000);
  const mj = await page.evaluate(() => getDB().journal.filter(j => j.ref === 'MANUAL' && j.description === 'قيد خاطئ: ضيافة')[0]);
  await op('26n. "Reverse" button on that manual entry', async () => {
    await page.evaluate(id => { el('modal-container').innerHTML = ''; reverseManualJournal(id); }, mj.id); await page.waitForTimeout(300);
    await page.evaluate(() => { el('corr-reason').value = 'ما صار'; el('corr-ok').click(); });
  }, { g: { exp: -30, cash: 30 }, treasury: 30 });
  ok(await page.evaluate(id => getDB().journal.some(j => j.id === id), mj.id), 'manual entry kept in the journal after reversal');


  // ══ إقفال الشهر: أي قيد بتاريخه يُرفض بدون كلمة مرور التجاوز ══
  const month = new Date().toISOString().slice(0, 7), year = month.slice(0, 4);
  // الإقفال يتطلب كلمة تجاوز مضبوطة أولًا (بدونها المالك ما يقدر يفتح الفترة) — مثل المالك الحقيقي
  {
    const closeNoPw = await page.evaluate(async m => { const before = (getDB().closed_periods || []).length; await closePeriod('month', m); return (getDB().closed_periods || []).length - before; }, month);
    ok(closeNoPw === 0, 'closing a period without an override password is refused (owner would be locked out)');
    const setPw = await page.evaluate(() => window._cloudApiFetch('PUT', '/api/closed-periods/override-password', { current_login_password: 'Cycle@1234', new_override_password: 'Override@1' }).then(r => !!r?.success).catch(e => e.message));
    ok(setPw === true, 'owner sets the period override password → ' + setPw);
  }
  await page.evaluate(m => closePeriod('month', m), month); await settle(3000);
  await op('24. After closing ' + month + ': manual journal dated inside it is blocked', () => manualJE('قيد بعد الإقفال', [['5200', 'debit', 77], ['1100', 'credit', 77]]), { g: {}, treasury: 0, wait: 3000 });
  await page.evaluate(() => { const ov = [...document.querySelectorAll('.modal-bg')].pop(); if (ov && ov.parentElement === document.body) ov.remove(); });

  // ══ مطابقة نهائية مع السيرفر ══
  await page.waitForTimeout(5000);
  await page.evaluate(() => { goTo('dashboard'); });
  await page.waitForTimeout(65000); // دورة سحب كاملة من السيرفر
  const fin = await snap();
  const cid = (await pool.query(`select company_id from users where username=$1`, ['cyc' + sfx])).rows[0].company_id;
  console.log('\n▶ FINAL RECONCILIATION (company ' + cid + ')');
  const q = async (sql, p = [cid]) => (await pool.query(sql, p)).rows;
  const gl = Object.fromEntries((await q(`select ji.account_code c, sum(case when side='debit' then amount else -amount end)::float b from journal_items ji join journal_entries je on je.id=ji.entry_id where je.company_id=$1 group by 1`)).map(r => [r.c, r2(r.b)]));
  const unbal = await q(`select je.id from journal_entries je join journal_items ji on ji.entry_id=je.id where je.company_id=$1 group by je.id having abs(sum(case when side='debit' then amount else -amount end))>0.005`);
  ok(unbal.length === 0, 'server: every journal entry balanced (' + unbal.length + ' unbalanced)');
  const tot = Object.values(gl).reduce((s, v) => s + v, 0); ok(Math.abs(tot) < 0.01, 'server: trial balance debits = credits (diff ' + r2(tot) + ')');
  const srvGroups = { cash: gl['1100'] || 0, ar: gl['1200'] || 0, inv: gl['1300'] || 0, ap: -(gl['2100'] || 0), vatOut: -(gl['2200'] || 0), vatIn: gl['2210'] || 0 };
  for (const k of Object.keys(srvGroups)) ok(Math.abs(r2(srvGroups[k]) - fin.g[k]) < 0.01, `server GL ${k} ${r2(srvGroups[k])} = app ${fin.g[k]}`);
  const tre = (await q(`select coalesce(sum(balance),0)::float s from treasury_accounts where company_id=$1`))[0].s;
  ok(Math.abs(tre - srvGroups.cash) < 0.01, `treasury accounts ${tre} = GL cash ${srvGroups.cash}`);
  ok(Math.abs(fin.treasury - srvGroups.cash) < 0.01, `app treasury ${fin.treasury} = GL cash`);
  const lots = (await q(`select coalesce(sum(qty_remaining*unit_cost),0)::float v from stock_lots where company_id=$1`))[0].v;
  ok(Math.abs(r2(lots) - r2(srvGroups.inv + (gl['1350'] || 0))) < 0.01, `FIFO stock value ${r2(lots)} = GL inventory ${r2(srvGroups.inv + (gl['1350'] || 0))}`);
  const pq = await q(`select p.name, p.qty::float q, coalesce((select sum(qty_remaining) from stock_lots l where l.product_id=p.id),0)::float lq, coalesce((select sum(qty) from product_stock w where w.product_id=p.id),0)::float wq from products p where p.company_id=$1 and p.is_active`);
  for (const r of pq) ok(Math.abs(r.q - r.lq) < 0.001 && Math.abs(r.q - r.wq) < 0.001 && Math.abs(r.q - fin.qty[r.name]) < 0.001, `${r.name}: qty ${r.q} = FIFO lots ${r.lq} = warehouses ${r.wq} = app ${fin.qty[r.name]}`);
  const custSum = (await q(`select coalesce(sum(balance),0)::float s from customers where company_id=$1`))[0].s;
  // أرصدة العملاء = الذمم − دفعاتهم المقدمة غير المسوّاة (رصيد دائن لهم): خالد 25.80 (نادر استُهلك)
  ok(Math.abs(r2(custSum) - r2(srvGroups.ar - 25.8)) < 0.01, `customer balances ${r2(custSum)} = AR ${srvGroups.ar} − advances 25.80`);
  const advGL = -Object.entries(gl).filter(([c]) => c[0] === '2' && !['2100', '2200', '2210'].includes(c)).reduce((s, [, v]) => s + v, 0);
  ok(Math.abs(advGL - 25.8) < 0.01, 'customer advance (prepayment) liability = 25.80 (نادر fully used) → ' + r2(advGL));
  const invState = await q(`select invoice_no, grand_total::float g, paid_amount::float p, credited_amount::float cr, status from invoices where company_id=$1 order by id`);
  const arFromInv = invState.filter(i => i.status !== 'cancelled').reduce((s, i) => s + i.g - i.p - i.cr, 0);
  ok(Math.abs(r2(arFromInv) - srvGroups.ar) < 0.01, `open invoice balances (total − paid − credit notes) ${r2(arFromInv)} = AR ${srvGroups.ar}`);
  const purState = await q(`select coalesce(sum(remaining),0)::float r from purchases where company_id=$1 and purchase_type<>'opex'`);
  ok(Math.abs(r2(purState[0].r) - srvGroups.ap) < 0.01, `open purchase balances ${r2(purState[0].r)} = AP ${srvGroups.ap}`);
  const supSum = (await q(`select coalesce(sum(balance),0)::float s from suppliers where company_id=$1`))[0].s;
  ok(Math.abs(r2(supSum) - srvGroups.ap) < 0.01, `supplier balances ${r2(supSum)} = AP ${srvGroups.ap}`);
  const vchCount = await q(`select type, count(*)::int n, sum(amount)::float s from vouchers where company_id=$1 group by 1 order by 1`);
  console.log('    server vouchers:', JSON.stringify(vchCount));
  ok(JSON.stringify(vchCount) === JSON.stringify([{ type: 'payment', n: 1, s: 400 }, { type: 'receipt', n: 3, s: 600 }]), 'server vouchers: 3 receipts (300+100+200 advance) + 1 payment (400); deleted voucher gone');
  const invs = await q(`select invoice_no, invoice_type, status, grand_total::float g, paid_amount::float p, vat_amount::float v, cogs_total::float c, zatca_qr_phase2 is not null qr from invoices where company_id=$1 order by id`);
  console.log('    server invoices:'); invs.forEach(i => console.log('      ', JSON.stringify(i)));
  const appBS = await page.evaluate(async () => (await window._cloudApiFetch('GET', '/api/reports/balance-sheet')).data);
  ok(Math.abs(appBS.assets.total - (appBS.liabilities.total + appBS.equity)) < 0.01, `server balance sheet balances: assets ${appBS.assets.total} = liabilities ${appBS.liabilities.total} + equity ${appBS.equity}`);
  const IS = await page.evaluate(async () => (await window._cloudApiFetch('GET', '/api/reports/income-statement')).data);
  console.log('    income statement:', JSON.stringify(IS));
  console.log('    final app groups:', JSON.stringify(fin.g));

  // ══ محتوى الفواتير المطبوعة ══
  console.log('\n▶ Session token expires while the app is open');
  {
    // نخرّب توكن الدخول (كأن صلاحيته انتهت) ونطلق السحب الكامل (~20 طلب سوا): التجديد يصير
    // مرة وحدة والكل يكمل — كان كل طلب يجدد بنفسه، والتجديد الثاني يفشل فيُطلَع المستخدم
    await page.waitForTimeout(11000);
    const r = await page.evaluate(async () => {
      const rtBefore = localStorage.getItem('yaqiz_refresh_token');
      localStorage.setItem('yaqiz_access_token', 'expired.token.value');
      window._pullIfStale?.();
      await new Promise(res => setTimeout(res, 6000));
      return { user: !!currentUser, token: localStorage.getItem('yaqiz_access_token') !== 'expired.token.value', rotated: localStorage.getItem('yaqiz_refresh_token') !== rtBefore };
    });
    ok(r.user && r.token && r.rotated, 'expired access token renewed once; still logged in → ' + JSON.stringify(r));
  }

  console.log('\n▶ VAT return — Excel export');
  {
    // نعترض الكتابة ونقرأ المصنف نفسه بالمتصفح (نفس مكتبة التصدير)
    const xl = await page.evaluate(() => {
      reportPeriod = 'all'; vatPeriodKey = null;
      let wb = null; const orig = XLSX.writeFile; XLSX.writeFile = w => { wb = w; };
      try { exportVATReportExcel(); } finally { XLSX.writeFile = orig; }
      if (!wb) return null;
      const rows = n => XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1 });
      const sum = rows(wb.SheetNames[0]);
      const val = i => (sum[i] || [])[1];
      return { names: wb.SheetNames, out: val(6), inp: val(7), docOut: val(10),
        sales: rows(wb.SheetNames[1]), purch: rows(wb.SheetNames[3]), invCount: getDB().invoices.filter(i => i.status !== 'ملغاة').length };
    });
    ok(!!xl && xl.names.length === 5, 'Excel has 5 sheets → ' + (xl && xl.names.join(' | ')));
    if (xl) {
      ok(Math.abs(xl.out - srvGroups.vatOut) < 0.01 && Math.abs(xl.inp - srvGroups.vatIn) < 0.01, `Excel summary VAT = server ledger (out ${xl.out} / ${srvGroups.vatOut}, in ${xl.inp} / ${srvGroups.vatIn})`);
      const salesRows = xl.sales.slice(1, -1), total = xl.sales[xl.sales.length - 1];
      ok(salesRows.length === xl.invCount, 'one row per sales invoice → ' + salesRows.length + ' / ' + xl.invCount);
      ok(salesRows.every(r => typeof r[5] === 'number' && typeof r[6] === 'number' && Math.abs(r[5] + r[6] - r[7]) < 0.011), 'every invoice row: taxable + VAT = total (numeric cells)');
      ok(Math.abs(total[6] - salesRows.reduce((t, r) => t + r[6], 0)) < 0.01, 'sales sheet total row = sum of its rows');
      ok(Math.abs(xl.docOut - xl.out) < 0.01, `documents reconcile with the ledger (invoices − returns VAT ${xl.docOut} = ${xl.out})`);
      ok(xl.purch.length > 2 && /^\d{4}-\d{2}-\d{2}$/.test(String(xl.purch[1][1])), 'purchases sheet filled, dates as YYYY-MM-DD');
    }
  }

  console.log('\n▶ Printed invoices');
  const printed = async (id) => { const [pp] = await Promise.all([ctx.waitForEvent('page', { timeout: 15000 }), page.evaluate(id => printSalesInvoice(id), id)]); await pp.waitForTimeout(2500); const r = await pp.evaluate(() => ({ t: document.body.innerText, qr: document.querySelectorAll('canvas, img[src^="data:image"], svg').length })); await pp.close(); return r; };
  const b2b = await printed(inv3.id);
  ok(/فاتورة ضريبية/.test(b2b.t) && !/مبسطة/.test(b2b.t.split('\n').slice(0, 15).join(' ')), 'B2B print titled as a (standard) tax invoice');
  ok(b2b.t.includes(VAT), 'B2B print shows seller VAT number ' + VAT);
  ok(b2b.t.includes('300000000000003') && b2b.t.includes('شركة الأفق'), 'B2B print shows buyer name + buyer VAT');
  ok(/الورود|العليا|2222/.test(b2b.t), 'B2B print shows buyer address');
  ok(b2b.qr > 0, 'B2B print has a QR code (' + b2b.qr + ' graphic elements)');
  ok(/471.50|471.5/.test(b2b.t) && /61.50|61.5/.test(b2b.t), 'B2B print totals 471.50 incl. VAT 61.50');
  const simp = await printed(inv1.id);
  ok(/مبسطة/.test(simp.t), 'POS print titled simplified tax invoice');
  ok(simp.qr > 0 && simp.t.includes(VAT), 'POS print has QR + seller VAT');
  ok(/115/.test(simp.t), 'POS print total 115.00');

  // ══ إقفال السنة: قيد تصفير حقيقي ══
  console.log('\n▶ 25. Year-end close ' + year);
  await page.evaluate(y => closePeriod('year', y), year); await page.waitForTimeout(6000);
  const gl2 = Object.fromEntries((await q(`select ji.account_code c, sum(case when side='debit' then amount else -amount end)::float b from journal_items ji join journal_entries je on je.id=ji.entry_id where je.company_id=$1 group by 1`)).map(r => [r.c, r2(r.b)]));
  const pl = Object.entries(gl2).filter(([c]) => c[0] === '4' || c[0] === '5').reduce((s, [, v]) => s + Math.abs(v), 0);
  ok(pl < 0.01, 'all revenue/expense accounts zeroed by the closing entry (residual ' + r2(pl) + ')');
  ok(Math.abs((gl2['3100'] || 0) - (-(IS.net_income))) < 0.01 || Math.abs(-(gl2['3100'] || 0) - IS.net_income) < 0.01, `retained earnings 3100 = net income ${IS.net_income} → ${-(gl2['3100'] || 0)}`);
  const tot2 = Object.values(gl2).reduce((s, v) => s + v, 0); ok(Math.abs(tot2) < 0.01, 'trial balance still balanced after closing');
  const BS2 = await page.evaluate(async () => (await window._cloudApiFetch('GET', '/api/reports/balance-sheet')).data);
  ok(Math.abs(BS2.assets.total - (BS2.liabilities.total + BS2.equity)) < 0.01 && Math.abs(BS2.equity - appBS.equity) < 0.01, `balance sheet unchanged & balanced after closing: equity ${BS2.equity} (before ${appBS.equity})`);
  console.log('\n▶ 25b. Reopen ' + year + ' → closing entry reversed, not deleted');
  const cpId = (await q(`select id from closed_periods where company_id=$1 and period_type='year' and period_key=$2`, [cid, year]))[0]?.id;
  // الشهر مقفل أيضًا — يُفتح أولًا (السنة ما تنفتح وشهر بداخلها مقفل؟ لا شرط) ثم السنة
  await page.evaluate(async ({ id, y }) => {
    await window._cloudApiFetch('DELETE', '/api/closed-periods/' + id);
    // بالفترة نفسها لا بالمعرّف: النسخة المسحوبة من السيرفر معرّفها «srv-…»
    const d = getDB(); d.closed_periods = (d.closed_periods || []).filter(x => !(x.period_type === 'year' && x.period_key === y)); saveDB(d); // نفس ما تسويه شاشة فتح الفترة
  }, { id: cpId, y: year });
  await page.waitForTimeout(1500);
  const ce = await q(`select source_type, count(*)::int n from journal_entries where company_id=$1 and source_type in ('period_close','period_close_reversal') group by 1 order by 1`);
  ok(JSON.stringify(ce) === JSON.stringify([{ source_type: 'period_close', n: 1 }, { source_type: 'period_close_reversal', n: 1 }]), 'closing entry kept + one reversing entry → ' + JSON.stringify(ce));
  const gl3 = Object.fromEntries((await q(`select ji.account_code c, sum(case when side='debit' then amount else -amount end)::float b from journal_items ji join journal_entries je on je.id=ji.entry_id where je.company_id=$1 group by 1`)).map(r => [r.c, r2(r.b)]));
  ok(Object.keys(gl).every(c => Math.abs((gl3[c] || 0) - (gl[c] || 0)) < 0.01), 'after reopening, every account is back to its pre-closing balance');
  await page.evaluate(y => closePeriod('year', y), year); await page.waitForTimeout(6000);
  const gl4 = Object.fromEntries((await q(`select ji.account_code c, sum(case when side='debit' then amount else -amount end)::float b from journal_items ji join journal_entries je on je.id=ji.entry_id where je.company_id=$1 group by 1`)).map(r => [r.c, r2(r.b)]));
  ok(Object.entries(gl4).filter(([c]) => c[0] === '4' || c[0] === '5').reduce((s, [, v]) => s + Math.abs(v), 0) < 0.01 && Math.abs((gl4['3100'] || 0) - (gl2['3100'] || 0)) < 0.01, 're-closing gives the same result (P&L zeroed, retained earnings ' + (gl4['3100'] || 0) + ')');
  console.log('\n▶ Ledger guard on this company');
  const { checkCompany } = require(path + 'src/services/ledgerGuard.service.js');
  const gf = await checkCompany(cid);
  ok(gf.length === 0, 'daily ledger guard finds no discrepancy (' + gf.length + ')' + (gf.length ? ': ' + gf.map(x => x.title + ' ' + x.diff).join(' | ') : ''));
  console.log('\nRESULT: ' + passes + ' passed, ' + fails + ' failed');
  console.log('ERRORS:', errs.length ? '\n' + errs.join('\n') : 'none');
  console.log('USER cyc' + sfx, 'COMPANY', cid);
  await b.close(); await pool.end();
})().catch(async e => { console.error('CRASH', e); process.exit(1); });
