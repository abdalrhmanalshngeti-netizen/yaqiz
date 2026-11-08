// تطبيع ناتج قراءة فاتورة المورد بالذكاء الاصطناعي قبل ما يوصل لشاشة الشراء.
// النموذج أحيانًا: يرجّع أسعار الأصناف شاملة الضريبة (فتنحسب الضريبة مرة ثانية
// فوقها)، أو يقرأ صفوف المجاميع ("الإجمالي"، "الضريبة") كأصناف، أو يكرر نفس الصف.
// هنا نطابق حسابيًا مجموع الأصناف مع إجماليات الفاتورة نفسها ونرجّع أصنافًا
// صافية (قبل الضريبة) دائمًا + نسبة الضريبة الفعلية + تنبيهات لو ما تطابقت.

const num = v => { const n = parseFloat(String(v ?? '').replace(/[^\d.\-]/g, '')); return isFinite(n) ? n : 0; };
const r2 = n => Math.round(n * 100) / 100;
const near = (a, b) => Math.abs(a - b) <= Math.max(0.05, Math.abs(b) * 0.005);

// صفوف ملخّص تُقرأ أحيانًا كأصناف
const SUMMARY_ROW = /^\s*(المجموع|الإجمالي|اجمالي|إجمالي|الاجمالي|المجموع الفرعي|صافي|الصافي|ضريبة|الضريبة|القيمة المضافة|خصم|الخصم|المبلغ المستحق|total|sub ?total|grand ?total|vat|tax|discount|net|amount due)(?=$|[\s:%(\d\-])/i; // \b ما يعمل مع الحروف العربية

function normalizeExtractedInvoice(parsed) {
  // كل تنبيه بلغتين — الواجهة تعرض حسب لغة المستخدم
  const warnings = [], warningsEn = [];
  const warn = (ar, en) => { warnings.push(ar); warningsEn.push(en); };
  const out = { ...parsed };
  let items = (Array.isArray(parsed?.items) ? parsed.items : [])
    .map(it => {
      const qty = num(it.qty) || 1;
      let total = num(it.total);
      let unit = num(it.unit_price);
      if (!total && unit) total = qty * unit;
      if (!unit && total) unit = total / qty;
      return { description: String(it.description || '').trim(), qty, unit_price: unit, total };
    })
    .filter(it => it.total > 0);

  let S = num(parsed?.subtotal), V = num(parsed?.vat_amount), G = num(parsed?.grand_total);
  if (!S && G && V) S = G - V;
  if (!G && S) G = S + V;
  if (!V && G && S && G > S) V = G - S;
  // الثلاثة ما تتطابق (قبل الضريبة + الضريبة ≠ الإجمالي): النموذج غالبًا حسب
  // "قبل الضريبة" بنفسه وأخطأ — الإجمالي والضريبة هم الأوضح طباعةً، فنعتمدهم
  if (S && V && G && !near(S + V, G)) {
    warn(`صُحّح المبلغ قبل الضريبة من ${r2(S)} إلى ${r2(G - V)} (الإجمالي − الضريبة)`, `Subtotal corrected from ${r2(S)} to ${r2(G - V)} (total − VAT)`);
    S = G - V;
  }

  const sum = arr => arr.reduce((s, it) => s + it.total, 0);
  let L = sum(items);

  // صفوف تبدو مجاميع ("الإجمالي"، "الضريبة") تُحذف فقط لو حذفها يخلّي الأصناف
  // تطابق إجمالي الفاتورة — منتج حقيقي اسمه يبدأ بنفس الكلمة (مثل «صافي 330 مل»)
  // يبقى لأن الأرقام تثبت إنه صنف
  // وكذلك الصفوف المكررة حرفيًا. الخطآن ممكن يجون مع بعض بنفس الفاتورة، وكل
  // واحد لحاله ما يطابق الإجمالي — فنجرب التركيبات ونأخذ أول وحدة تطابق
  const fits = x => (S && near(x, S)) || (G && near(x, G));
  const dedupe = arr => { const seen = new Set(); return arr.filter(it => { const k = `${it.description}|${it.qty}|${r2(it.unit_price)}`; if (seen.has(k)) return false; seen.add(k); return true; }); };
  if ((S || G) && !fits(L)) {
    const ns = items.filter(it => !SUMMARY_ROW.test(it.description));
    // المطابقة مع "قبل الضريبة" أولًا: صف ضريبة مقروء كصنف ممكن يخلّي المجموع
    // يساوي الإجمالي بالصدفة
    const cands = [[ns, false], [dedupe(items), true], [dedupe(ns), true]].filter(([arr]) => arr.length && arr.length < items.length);
    const pick = cands.find(([arr]) => S && near(sum(arr), S)) || cands.find(([arr]) => G && near(sum(arr), G));
    if (pick) {
      const [arr, didDedupe] = pick;
      const nSum = items.length - ns.length, src = ns.length < items.length && arr.length <= ns.length && arr.every(it => ns.includes(it)) ? ns : items;
      if (src === ns && nSum) warn(`تجاهلنا ${nSum} صفوف إجماليات قرأها الذكاء الاصطناعي كأصناف`, `Ignored ${nSum} total rows the AI read as items`);
      if (didDedupe && arr.length < src.length) warn(`حُذفت ${src.length - arr.length} صفوف مكررة قرأها الذكاء الاصطناعي مرتين`, `Removed ${src.length - arr.length} duplicate rows the AI read twice`);
      items = arr; L = sum(items);
    }
  }

  // الأصناف قبل الضريبة أو شاملة لها؟ الحكم بالأرقام أولًا، ثم بإشارة النموذج
  let gross = false;
  if (S && near(L, S)) gross = false;
  else if (G && V > 0 && near(L, G)) gross = true;
  else if (parsed?.prices_include_vat === true && V > 0) gross = true;

  if (gross) {
    const f = S > 0 ? G / S : 1.15;
    items = items.map(it => ({ ...it, unit_price: it.unit_price / f, total: it.total / f }));
    L = sum(items);
  }

  if (!S) { S = L; G = G || S + V; }
  const vatRatio = S > 0 ? V / S : 0;

  if (items.length && !near(L, S)) {
    warn(`مجموع الأصناف (${r2(L)}) لا يطابق إجمالي الفاتورة قبل الضريبة (${r2(S)}) — راجع الأصناف والكميات قبل الحفظ`, `Items add up to ${r2(L)}, but the invoice subtotal is ${r2(S)} — check items and quantities before saving`);
  }
  if (V > 0 && Math.abs(vatRatio - 0.15) > 0.01) {
    warn(`ضريبة الفاتورة (${r2(V)}) ليست 15% من المبلغ قبل الضريبة (${r2(S)}) — تأكد من قراءة الإجماليات`, `Invoice VAT (${r2(V)}) isn’t 15% of the subtotal (${r2(S)}) — check the totals were read correctly`);
  }
  if (!items.length && S) items = [{ description: parsed?.vendor || 'بضاعة', qty: 1, unit_price: S, total: S }];

  out.items = items.map(it => ({ description: it.description, qty: it.qty, unit_price: Math.round(it.unit_price * 10000) / 10000, total: r2(it.total) }));
  out.subtotal = r2(S); out.vat_amount = r2(V); out.grand_total = r2(G);
  out.vat_ratio = vatRatio;
  out.prices_include_vat = false;   // الأصناف صارت صافية دائمًا بعد التطبيع
  out.lines_were_gross = gross;
  out.warnings = warnings;
  out.warnings_en = warningsEn;
  out.normalized = true;
  return out;
}

module.exports = { normalizeExtractedInvoice };
