const https = require('https');

function openAIRequest(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const options = {
      hostname: 'api.openai.com',
      path:     '/v1/chat/completions',
      method:   'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(options, res => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function callAI(messages, opts = {}) {
  const { model = 'gpt-4o-mini', maxTokens = 1000, temperature = 0.2 } = opts;
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not configured');

  const res = await openAIRequest({ model, messages, max_tokens: maxTokens, temperature });
  if (res.status !== 200) {
    const err = res.body?.error?.message || JSON.stringify(res.body);
    throw new Error(`OpenAI error ${res.status}: ${err}`);
  }
  const choice = res.body.choices?.[0];
  return {
    content:    choice?.message?.content || '',
    tokens_in:  res.body.usage?.prompt_tokens    || 0,
    tokens_out: res.body.usage?.completion_tokens || 0,
  };
}

async function extractDocument(imageBase64, mimeType = 'image/jpeg') {
  const systemPrompt = `أنت نظام استخراج بيانات محاسبية متخصص في الفواتير السعودية والعربية،
بما فيها إيصالات الجملة الحرارية الطويلة، والصور الملتقطة بزاوية أو إضاءة غير مثالية.
اقرأ الصورة بعناية شديدة، سطراً سطراً وعموداً عموداً، واستخرج كل الأرقام والنصوص بدقة تامة.
أعد JSON فقط — لا تكتب أي كلام قبله أو بعده، لا شرح، لا ملاحظات.

التنسيق المطلوب بالضبط:
{
  "vendor": "اسم المورد أو الشركة البائعة كما يظهر في الفاتورة",
  "date": "YYYY-MM-DD",
  "invoice_no": "رقم الفاتورة",
  "items": [
    {"description": "اسم الصنف أو الخدمة", "qty": 1, "unit_price": 0.00, "total": 0.00}
  ],
  "subtotal": 0.00,
  "vat_amount": 0.00,
  "grand_total": 0.00
}

قواعد مهمة جداً:
1. اقرأ الأرقام بدقة — لا تضيف أصفاراً ولا تحذف أرقاماً
2. الأرقام يجب أن تكون أرقاماً فقط بدون "ر.س" أو "$" أو فراغات
3. إذا ظهر التاريخ هجرياً: اجمع 621 للسنة الهجرية للحصول على الميلادي تقريباً
4. إذا كانت الضريبة مدمجة في المجموع: احسب vat_amount = grand_total × 15 / 115
5. grand_total هو المبلغ الأخير النهائي في الفاتورة (شامل الضريبة)
6. عدّ صفوف الأصناف بعناية قبل البدء — لازم يطابق عدد الأصناف بالـ JSON عدد الصفوف الظاهرة بالجدول بالضبط. لا تدمج صفّين ببعض ولا تحذف أي صف حتى لو كان النص بجنبه صغيراً أو غير واضح
7. لكل صنف: اقرأ الكمية (QTY) من عمودها الخاص بها بجانب ذاك الصنف تحديداً — لا تفترض أبداً أن الكمية = 1 افتراضياً، اقرأها فعلياً من الجدول حتى لو كانت كسرية (مثل 0.5)
8. رقم الفاتورة غالباً سلسلة أرقام/حروف طويلة قرب أعلى الفاتورة — اقرأه رقماً رقماً بعناية، لا تُدخل أو تحذف أي رقم منه
9. إذا لم تظهر أصناف محددة: أنشئ صنفاً واحداً باسم vendor وسعره = subtotal
10. لا تضع null أبداً — ضع قيمة افتراضية منطقية ("" للنصوص، 0 للأرقام)`;

  return callAI([
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}`, detail: 'high' } },
        { type: 'text', text: 'استخرج بيانات هذه الفاتورة واعد JSON فقط.' },
      ],
    },
  ], { model: 'gpt-4o-mini', maxTokens: 1200 });
}

async function analyzeFinancials(summary) {
  const systemPrompt = `أنت محلل مالي خبير بالمحاسبة السعودية. قدّم تحليلاً مالياً واضحاً ومفيداً بالعربية.
ركّز على: الإيرادات، المصاريف، الربحية، التحصيل، التوصيات العملية.
أبقِ الردّ في 250 كلمة أو أقل. استخدم تنسيقاً منظماً بالنقاط.`;

  return callAI([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `بيانات الشركة للفترة المحددة:\n${JSON.stringify(summary, null, 2)}\n\nحلّل هذه البيانات وقدّم توصيات.` },
  ], { model: 'gpt-4o-mini', maxTokens: 600, temperature: 0.4 });
}

async function askAssistant(question, context, history = []) {
  const systemPrompt = `أنت مساعد محاسبي ذكي لمنصة يقظ للمحاسبة السحابية (yaqiz.me). مهمتك الإجابة على أسئلة المستخدم بدقة تامة بناءً على بيانات شركته، وتوجيهه داخل المنصة عند الحاجة.

═══ معرفة المنصة — الصفحات والميزات ═══
المنصة تحتوي على الأقسام التالية (الشريط الجانبي):
• لوحة التحكم (dashboard) — ملخص يومي: إيرادات، مصاريف، تنبيهات المخزون
• المبيعات (sales) — إنشاء فواتير مبيعات جديدة، عرض قائمة الفواتير، تحصيل الديون
• نقطة البيع / الكاشير (pos) — شاشة كاشير للبيع السريع مع سلة وباركود
• المشتريات (purchases) — تسجيل فواتير الشراء وتحديث المخزون تلقائياً
• المخزون (inventory) — إدارة المنتجات والكميات وتحديد حد الحد الأدنى
• العملاء (customers) — قائمة العملاء وأرصدتهم وسجل معاملاتهم
• الموردون (suppliers) — قائمة الموردين وأرصدتهم المستحقة
• الخزينة (treasury) — إدارة الحسابات النقدية والبنكية والتحويلات
• الموظفون (employees) — الرواتب والمستحقات
• الالتزامات (obligations) — الدفعات الدورية (إيجار، اشتراكات، خ.)
• التقارير (reports) — تقارير مالية: الميزانية، حركة المخزون، ضريبة القيمة
• عروض الأسعار (quotes) — إنشاء عروض سعر وتحويلها لفواتير
• المستخدمون (users) — إضافة كاشير أو موظف بصلاحيات محدودة
• الإعدادات (settings) — بيانات الشركة، الضريبة، التسعير الديناميكي، النسخ الاحتياطي

═══ الإعدادات المهمة وكيفية الوصول إليها ═══
• تفعيل/تعطيل ضريبة القيمة المضافة 15%: الإعدادات ← الإعدادات العامة ← مفتاح "ضريبة القيمة المضافة"
• رقم الضريبي (VAT number): الإعدادات ← الإعدادات العامة ← حقل "الرقم الضريبي"
• التسعير الديناميكي (نسبة ربح تلقائية): الإعدادات ← سياسات التسعير ← أو عند تعديل المنتج في المخزون
• هدف المبيعات اليومي للكاشير: الإعدادات ← أهداف المبيعات
• النسخ الاحتياطي: الإعدادات ← نسخة احتياطية

═══ قواعد الإجابة ═══
1. إذا سأل المستخدم "كيف أفعل X في المنصة" → وجّهه بخطوات واضحة (اذهب إلى → ثم → ثم)
2. إذا سأل عن بيانات (أرقام مبيعات، مخزون، خ.) → استخدم context فقط، لا تخترع.
3. التاريخ الحالي في today. استخدمه للأسئلة الزمنية.
4. إذا لم تجد البيانات في context → قل ذلك وأضف "يمكنك التحقق من [الصفحة المناسبة] في المنصة"
5. أجب بالعربية دائماً. كن موجزاً ومفيداً. لا تطوّل بدون حاجة.

بيانات الشركة:
${JSON.stringify(context, null, 2)}`;

  const messages = [{ role: 'system', content: systemPrompt }];

  // أضف سجل المحادثة السابقة (آخر 5 أسئلة فقط لتوفير الـ tokens)
  for (const h of history.slice(-5)) {
    if (h.question && h.answer) {
      messages.push({ role: 'user',      content: h.question });
      messages.push({ role: 'assistant', content: h.answer   });
    }
  }

  messages.push({ role: 'user', content: question });

  return callAI(messages, { model: 'gpt-4o-mini', maxTokens: 800, temperature: 0.3 });
}

// نحوّل أول صفحة من الـ PDF لصورة ونمررها لنفس محرك قراءة الصور (extractDocument).
// استخراج النص الخام من PDF (pdf-parse) غير موثوق مع النصوص العربية — يطلع فارغاً
// أو مشوّهاً حتى مع ملفات نصية حقيقية، فنعتمد على الرؤية البصرية دائماً بدلاً منه.
async function extractFromPDF(pdfBuffer) {
  const { PDFiumLibrary } = require('@hyzyla/pdfium');
  const sharp = require('sharp');

  let library;
  try {
    library = await PDFiumLibrary.init();
    const document = await library.loadDocument(pdfBuffer);

    let firstPage = null;
    for (const page of document.pages()) { firstPage = page; break; }
    if (!firstPage) throw new Error('empty');

    const image = await firstPage.render({
      scale: 3,
      render: async (options) => sharp(options.data, {
        raw: { width: options.width, height: options.height, channels: 4 },
      }).png().toBuffer(),
    });

    const imageBase64 = Buffer.from(image.data).toString('base64');
    document.destroy();

    return await extractDocument(imageBase64, 'image/png');
  } catch (err) {
    throw new Error('تعذّرت قراءة ملف PDF — يُرجى رفع صورة للفاتورة بدلاً من ذلك');
  } finally {
    if (library) library.destroy();
  }
}

module.exports = { extractDocument, extractFromPDF, analyzeFinancials, askAssistant };
