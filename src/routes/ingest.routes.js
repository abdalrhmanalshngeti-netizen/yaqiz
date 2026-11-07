const express = require('express');
const zlib = require('zlib');
const { promisify } = require('util');
const gunzip = promisify(zlib.gunzip);
const { ingestLimiter } = require('../middleware/rateLimiter');
const router = express.Router();

// وسيط تحليلات الاستخدام (PostHog، سيرفر أوروبا) — public/analytics.js يرسل
// إلى /ingest بدل posthog.com مباشرة، فيبقى connect-src بـCSP على 'self' فقط.
// لو سمحنا للمتصفح بالاتصال بـeu.i.posthog.com مباشرة، أي XSS مستقبلي يقدر
// يسرّب البيانات لمشروع PostHog خاص بالمهاجم (السماح بالنطاق لا يقيّد المفتاح).
// هنا نمرّر فقط الطلبات التي كل أحداثها تحمل مفتاح مشروعنا، ولمسارات محددة.
const PH_KEY = 'phc_Av8umGPL86JgGjE2tbgEhusiEj8gA47xkmXwAJmqFSx8';
const API_HOST = 'https://eu.i.posthog.com';
const ASSETS_HOST = 'https://eu-assets.i.posthog.com';
const POST_PATHS = /^\/(e|s|batch|flags|decide|i\/v0\/e)\/?$/;
// حماية من قنابل الضغط (gzip bomb): طلب مضغوط صغير قد ينفك لمئات الميغابايت
// ويحجز المعالج بـJSON.parse — نفس سقف express.json العام تقريبًا
const MAX_DECODED = 8 * 1024 * 1024;

async function decodeBody(buf, query) {
  let b = buf;
  // فك الضغط بخيط منفصل (غير متزامن) حتى لا يتجمّد السيرفر لبقية المستخدمين
  if (b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b) b = await gunzip(b, { maxOutputLength: MAX_DECODED });
  if (b.length > MAX_DECODED) throw new Error('too large');
  let s = b.toString('utf8');
  if (s.startsWith('data=')) s = Buffer.from(decodeURIComponent(s.slice(5)), 'base64').toString('utf8');
  else if (query.compression === 'base64') s = Buffer.from(s, 'base64').toString('utf8');
  return JSON.parse(s);
}

// كل الأحداث لازم تحمل مفتاح مشروعنا — أي مفتاح آخر (أو غيابه) يُرفض
function onlyOurKey(payload) {
  const items = Array.isArray(payload) ? payload : Array.isArray(payload.batch) ? payload.batch : [payload];
  const keys = [];
  if (!Array.isArray(payload)) keys.push(payload.api_key, payload.token);
  for (const e of items) if (e && typeof e === 'object') keys.push(e.api_key, e.token, e.properties && e.properties.token);
  const present = keys.filter(k => k !== undefined && k !== null);
  return present.length > 0 && present.every(k => k === PH_KEY);
}

async function forward(res, url, init) {
  try {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(10000) });
    const body = Buffer.from(await r.arrayBuffer());
    // دائمًا JSON — لا نسمح لرد طرف خارجي أن يُقدَّم كصفحة أو سكربت من نطاقنا
    res.status(r.status).type('application/json').send(body);
  } catch (e) {
    res.status(502).json({ status: 0 });
  }
}

router.use(ingestLimiter);

router.get('/array/:key/config', (req, res) => {
  if (req.params.key !== PH_KEY) return res.status(403).json({ status: 0 });
  forward(res, `${ASSETS_HOST}/array/${PH_KEY}/config`, { method: 'GET' });
});

router.post(/.*/, express.raw({ type: () => true, limit: '5mb' }), async (req, res) => {
  if (!POST_PATHS.test(req.path)) return res.status(404).json({ status: 0 });
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ status: 0 });
  let payload;
  try { payload = await decodeBody(req.body, req.query); } catch (e) { return res.status(400).json({ status: 0 }); }
  if (!onlyOurKey(payload)) return res.status(403).json({ status: 0 });
  const qs = new URLSearchParams(req.query).toString();
  forward(res, `${API_HOST}${req.path}${qs ? '?' + qs : ''}`, {
    method: 'POST',
    headers: {
      // express.raw يفك Content-Encoding تلقائيًا، فلا نمرّر الترويسة
      'Content-Type': req.headers['content-type'] || 'text/plain',
      'User-Agent': req.headers['user-agent'] || '',
      'X-Forwarded-For': req.ip,
    },
    body: req.body,
  });
});

router.all(/.*/, (req, res) => res.status(404).json({ status: 0 }));

module.exports = router;
