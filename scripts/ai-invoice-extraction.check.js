// التشغيل: node scripts/ai-invoice-extraction.check.js (يحتاج OPENAI_API_KEY بملف .env + Playwright)
// يستهلك 3 طلبات استخراج من OpenAI لكل تشغيل
// يولّد صور فواتير موردين واقعية بصيغ مختلفة، يقرأها بالذكاء الاصطناعي الحقيقي
// (نفس الدالة اللي يستخدمها السيرفر) ثم المطابقة الحسابية، ويقارن بالأرقام الصحيحة
const { chromium } = require('playwright');
const root = require('path').resolve(__dirname, '..') + '/';
require(root + 'node_modules/dotenv').config({ path: root + '.env', quiet: true });
const ai = require(root + 'src/services/ai.service.js');
const { normalizeExtractedInvoice } = require(root + 'src/services/invoiceNormalize.service.js');

const css = `body{font-family:Tahoma,Arial;direction:rtl;padding:24px;width:620px;color:#111}table{width:100%;border-collapse:collapse;margin:12px 0}td,th{border:1px solid #999;padding:6px;text-align:center;font-size:14px}h2{margin:0}.r{text-align:left}`;
const inv = [
  { name: 'A: net lines + VAT row + total (tax invoice)', expect: { S: 300, V: 45, G: 345, n: 3 },
    html: `<h2>مؤسسة الخليج للتموين</h2><div>فاتورة ضريبية رقم: INV-88231 — التاريخ: 2026-11-02</div><div>الرقم الضريبي: 300123456700003</div>
      <table><tr><th>الصنف</th><th>الكمية</th><th>سعر الوحدة</th><th>المجموع</th></tr>
      <tr><td>مياه 330 مل كرتون</td><td>10</td><td>15.00</td><td>150.00</td></tr>
      <tr><td>عصير برتقال 1 لتر</td><td>12</td><td>8.00</td><td>96.00</td></tr>
      <tr><td>بسكويت شاي</td><td>6</td><td>9.00</td><td>54.00</td></tr>
      <tr><td colspan="3">الإجمالي قبل الضريبة</td><td>300.00</td></tr>
      <tr><td colspan="3">ضريبة القيمة المضافة 15%</td><td>45.00</td></tr>
      <tr><td colspan="3"><b>الإجمالي شامل الضريبة</b></td><td><b>345.00</b></td></tr></table>` },
  { name: 'B: VAT-inclusive line prices (simplified)', expect: { S: 200, V: 30, G: 230, n: 2 },
    html: `<h2>تموينات النخبة</h2><div>فاتورة ضريبية مبسطة رقم 5512 — 2026-11-03</div><div>الأسعار شاملة ضريبة القيمة المضافة</div>
      <table><tr><th>الصنف</th><th>الكمية</th><th>السعر شامل الضريبة</th><th>الإجمالي</th></tr>
      <tr><td>أرز بسمتي 5 كجم</td><td>4</td><td>34.50</td><td>138.00</td></tr>
      <tr><td>زيت دوار الشمس 1.5 لتر</td><td>4</td><td>23.00</td><td>92.00</td></tr></table>
      <div>الإجمالي: 230.00 ر.س</div><div>منها ضريبة القيمة المضافة: 30.00 ر.س</div>` },
  { name: 'C: supplier not VAT registered', expect: { S: 120, V: 0, G: 120, n: 2 },
    html: `<h2>مخبز الحي</h2><div>فاتورة رقم 77 — 2026-11-04</div>
      <table><tr><th>الصنف</th><th>الكمية</th><th>السعر</th><th>المجموع</th></tr>
      <tr><td>خبز صامولي</td><td>40</td><td>1.50</td><td>60.00</td></tr>
      <tr><td>كعك</td><td>20</td><td>3.00</td><td>60.00</td></tr>
      <tr><td colspan="3">الإجمالي</td><td>120.00</td></tr></table>` },
];

(async () => {
  const b = await chromium.launch({ channel: 'msedge' });
  const page = await (await b.newContext({ viewport: { width: 680, height: 700 } })).newPage();
  let fails = 0;
  for (const t of inv) {
    await page.setContent(`<html><head><meta charset="utf-8"><style>${css}</style></head><body>${t.html}</body></html>`);
    const png = (await page.screenshot({ fullPage: true })).toString('base64');
    const res = await ai.extractDocument(png, 'image/png');
    let raw; try { raw = JSON.parse(res.content.replace(/```json|```/g, '').trim()); } catch (e) { console.log(t.name, 'PARSE FAIL', res.content.slice(0, 200)); fails++; continue; }
    const n = normalizeExtractedInvoice(raw);
    // ما سيظهر بشاشة الشراء: صافي + ضريبة بنسبة الفاتورة
    const net = n.items.reduce((s, i) => s + i.total, 0), vat = Math.round(net * n.vat_ratio * 100) / 100;
    const ok = Math.abs(net - t.expect.S) < 0.05 && Math.abs(vat - t.expect.V) < 0.06 && n.items.length === t.expect.n;
    if (!ok) fails++;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${t.name}\n   AI raw: items=${raw.items?.length} incl_vat=${raw.prices_include_vat} S=${raw.subtotal} V=${raw.vat_amount} G=${raw.grand_total}\n   → purchase form: ${n.items.map(i => `${i.description}×${i.qty}@${i.unit_price}`).join(', ')} | net ${net.toFixed(2)} + VAT ${vat.toFixed(2)} = ${(net + vat).toFixed(2)} (expected ${t.expect.G}) ${n.warnings.length ? '| ⚠ ' + n.warnings.join(' / ') : ''}`);
  }
  console.log(fails ? `${fails} FAILED` : 'ALL PASS');
  await b.close();
})().catch(e => { console.error(e); process.exit(1); });
