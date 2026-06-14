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
  const systemPrompt = `أنت نظام استخراج بيانات محاسبية متخصص في الفواتير السعودية والعربية.
اقرأ الصورة بعناية شديدة واستخرج كل الأرقام والنصوص بدقة تامة.
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
6. إذا كانت هناك أصناف متعددة أدرجها كلها — لا تدمج الأصناف
7. إذا لم تظهر أصناف محددة: أنشئ صنفاً واحداً باسم vendor وسعره = subtotal
8. لا تضع null أبداً — ضع قيمة افتراضية منطقية ("" للنصوص، 0 للأرقام)`;

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
  const systemPrompt = `أنت مساعد محاسبي ذكي لمنصة يقظ للمحاسبة. أجب على أسئلة المستخدم بناءً على بياناته.
كن دقيقاً، موجزاً، ومفيداً. إذا لم تجد إجابة في البيانات قل ذلك بوضوح. أجب بالعربية دائماً.

بيانات الشركة الحالية:
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

async function extractFromPDF(pdfBuffer) {
  let text = '';
  try {
    const pdfParse = require('pdf-parse');
    const data = await pdfParse(pdfBuffer);
    text = data.text?.trim() || '';
  } catch { text = ''; }

  if (!text || text.length < 20) {
    throw new Error('ملف PDF لا يحتوي على نص قابل للقراءة — يُرجى رفع صورة للفاتورة بدلاً من ذلك');
  }

  const systemPrompt = `أنت نظام استخراج بيانات محاسبية. استخرج البيانات من نص الفاتورة وأعد JSON فقط بدون أي نص إضافي.
التنسيق المطلوب:
{
  "vendor": "اسم المورد أو الشركة البائعة",
  "date": "YYYY-MM-DD",
  "invoice_no": "رقم الفاتورة",
  "items": [{"description": "اسم الصنف", "qty": 1, "unit_price": 0.00, "total": 0.00}],
  "subtotal": 0.00,
  "vat_amount": 0.00,
  "grand_total": 0.00
}
قواعد: الأرقام بدون رموز عملة، التاريخ ميلادي، JSON فقط لا شيء آخر.`;

  return callAI([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `استخرج بيانات هذه الفاتورة:\n\n${text.slice(0, 4000)}` },
  ], { model: 'gpt-4o-mini', maxTokens: 1000 });
}

module.exports = { extractDocument, extractFromPDF, analyzeFinancials, askAssistant };
