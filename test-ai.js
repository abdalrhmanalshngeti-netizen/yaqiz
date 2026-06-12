require('dotenv').config();
const https = require('https');

const key = process.env.OPENAI_API_KEY;
if (!key) { console.error('❌ OPENAI_API_KEY غير موجود في .env'); process.exit(1); }
console.log('🔑 المفتاح موجود:', key.slice(0,12) + '...');

const body = JSON.stringify({
  model: 'gpt-4o-mini',
  messages: [{ role: 'user', content: 'قل: يقظ يعمل بنجاح' }],
  max_tokens: 20,
});

const req = https.request({
  hostname: 'api.openai.com',
  path: '/v1/chat/completions',
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${key}`,
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  },
}, res => {
  let raw = '';
  res.on('data', c => raw += c);
  res.on('end', () => {
    const data = JSON.parse(raw);
    if (data.error) {
      console.error('❌ خطأ من OpenAI:', data.error.message);
      if (data.error.code === 'insufficient_quota') console.error('   → الرصيد منتهي أو الحساب غير مفعّل للدفع');
      if (data.error.code === 'invalid_api_key')    console.error('   → المفتاح غير صحيح');
    } else {
      const reply = data.choices?.[0]?.message?.content;
      console.log('✅ الذكاء الاصطناعي يعمل!');
      console.log('   الرد:', reply);
      console.log('   Tokens used:', data.usage?.total_tokens);
    }
  });
});
req.on('error', e => console.error('❌ خطأ في الاتصال:', e.message));
req.write(body);
req.end();
