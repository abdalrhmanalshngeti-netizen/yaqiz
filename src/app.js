require('dotenv').config();
const express     = require('express');
const helmet      = require('helmet');
const cors        = require('cors');
const compression = require('compression');
const crypto      = require('crypto');
const { apiLimiter } = require('./middleware/rateLimiter');

const app = express();

// ── Security & parsing ────────────────────────────────────────
const isProduction = process.env.NODE_ENV === 'production';
app.set('trust proxy', 1);

// nonce عشوائي جديد لكل طلب — يسمح للسكربتات المضمّنة الحقيقية بـVVIP.html
// بالتنفيذ (تحمل نفس الـnonce بوسم <script>) بينما أي سكربت مُحقَن عبر XSS
// (لا يعرف الـnonce الصحيح مسبقًا) يُرفَض تلقائيًا — يُستخدَم بكل من CSP أدناه
// وراوت VVIP.html نفسه (injectScriptNonce)
app.use((req, res, next) => {
  res.locals.cspNonce = crypto.randomBytes(16).toString('base64');
  next();
});

// إعادة توجيه HTTP → HTTPS في الإنتاج
if (isProduction) {
  app.use((req, res, next) => {
    if (req.header('x-forwarded-proto') !== 'https') {
      return res.redirect(301, `https://${req.header('host')}${req.url}`);
    }
    next();
  });
}

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:    ["'self'"],
      // إزالة unpkg.com — غير مُستخدَم إطلاقًا بأي صفحة (تأكَّد بالبحث بكل public/)،
      // كان سماحًا زائدًا بلا أي فائدة فعلية. cdnjs/jsdelivr لا تزالان مطلوبتان
      // فعليًا (JsBarcode، qrcodejs، xlsx).
      // 'unsafe-inline' أُزيلت من scriptSrc واستُبدلت بـnonce عشوائي لكل طلب
      // (يُحقَن بوسم <script> الفعلية عبر راوت VVIP.html) — أي متصفح حديث يتجاهل
      // 'unsafe-inline' تلقائيًا لو وُجد nonce بنفس التوجيه (سلوك موثّق بمواصفة
      // CSP)، فهذا يغلق فعليًا احتمال تنفيذ <script> خارجي يُحقَن عبر XSS مستقبلي
      // (لا يعرف الـnonce الصحيح مسبقًا) بلا أي تعديل على onclick="" إطلاقًا.
      // scriptSrcAttr: كل خصائص onclick=""/onchange=""/... (663 بـVVIP.html +
      // مثيلاتها بـadmin.html) حُوِّلت لنمط data-action مع مستمع تفويض مركزي
      // واحد (document.addEventListener) بدل التنفيذ المضمّن، فصار ممكنًا حذف
      // 'unsafe-inline' هنا فعليًا — يمنع أي onclick="" يُحقَن عبر XSS مستقبلي
      // من التنفيذ إطلاقًا (المتصفح يرفضه بلا استثناء بمجرد إزالة هذا التوجيه)
      scriptSrc:     ["'self'", (req, res) => `'nonce-${res.locals.cspNonce}'`, "'unsafe-eval'",
                      "https://cdnjs.cloudflare.com", "https://cdn.jsdelivr.net"],
      scriptSrcAttr: ["'none'"],
      styleSrc:      ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc:       ["'self'", "https://fonts.gstatic.com", "data:"],
      imgSrc:        ["'self'", "data:", "blob:", "https:"],
      // تقييد لـ'self' فقط — الواجهة لا تتصل بأي شيء خارجي مباشرة إطلاقًا (كل
      // نداءات الذكاء الاصطناعي تمر عبر السيرفر بمفتاح API لا يصل للمتصفح أبدًا)،
      // فالسماح العام بأي https: كان يُبطل الغرض الحقيقي من connect-src (منع
      // تسريب بيانات لخادم خارجي لو حصل XSS يومًا) — api.openai.com لم تُستخدَم
      // من المتصفح أصلًا (تأكَّد بالبحث)، كانت سماحًا زائدًا بلا فائدة
      connectSrc:    ["'self'"],
      workerSrc:     ["'self'", "blob:", "https://cdnjs.cloudflare.com"],
      frameSrc:      ["'none'"],
      // Phase 4: السياسة أعلاه مُفعَّلة (enforce) بالفعل منذ المراحل 1-2، لا
      // Report-Only — هذا التوجيه إضافة مراقبة فوقها فقط: أي مخالفة تحصل
      // بترافيك إنتاج حقيقي (متصفحات/إضافات لم تغطّها Playwright) تُسجَّل
      // بلوجات السيرفر بدل المرور بصمت، دون إضعاف الحظر الفعلي القائم أصلًا
      reportUri:     ['/api/csp-report'],
    }
  },
  hsts: isProduction ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false,
  frameguard: { action: 'deny' },
}));
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // Postman أو server-to-server
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return cb(null, true);
    if (origin.startsWith('file://')) return cb(null, true);
    const productionOrigins = ['https://yaqiz-production.up.railway.app', 'https://yaqiz.me', 'https://www.yaqiz.me'];
    if (productionOrigins.includes(origin)) return cb(null, true);
    const allowed = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
    if (allowed.includes(origin) || allowed.includes('*')) return cb(null, true);
    cb(new Error('CORS not allowed for: ' + origin));
  },
  credentials: true
}));

// ── خدمة الـ public files (api-client.js, manifest.json, sw.js) ──
const staticPath = require('path').join(__dirname, '..', 'public');
app.use('/public', require('express').static(staticPath));

// يرسل صفحة HTML ثابتة بعد حقن الـnonce الخاص بهذا الطلب بكل وسم <script>
// مضمَّن فعليًا (بلا src) — أي صفحة فيها سكربت مضمّن ولا تمرّ من هنا ستنكسر
// تحت CSP الجديد (scriptSrc ما عاد فيه 'unsafe-inline'). يُخزَّن محتوى كل ملف
// بالذاكرة بعد أول قراءة (الملفات لا تتغيّر أثناء تشغيل السيرفر، وأي تعديل
// فعلي يحتاج إعادة تشغيل على أي حال — نفس افتراض res.sendFile السابق تمامًا)
const fs = require('fs');
const htmlTemplateCache = new Map();
function sendHtmlWithNonce(filePath, req, res) {
  let template = htmlTemplateCache.get(filePath);
  if (!template) {
    template = fs.readFileSync(filePath, 'utf8');
    htmlTemplateCache.set(filePath, template);
  }
  const html = template.replace(/<script(?![^>]*\bsrc=)/g, `<script nonce="${res.locals.cspNonce}"`);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
}

// sw.js يجب أن يُقدَّم من / لأن scope يعتمد على المسار
app.get('/sw.js', (_, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Service-Worker-Allowed', '/');
  res.sendFile(require('path').join(staticPath, 'sw.js'));
});
app.use(compression());
app.use(express.json({ limit: '5mb' }));
app.use(apiLimiter);

// ── Health check ─────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ status: 'ok', time: new Date() }));

// ── Routes ───────────────────────────────────────────────────
app.use('/api/csp-report', require('./routes/cspReport.routes'));
app.use('/api/register',  require('./routes/register.routes'));
app.use('/api/admin',     require('./routes/admin.routes'));
app.use('/api/print',     require('./routes/print.routes'));
app.use('/api/auth',      require('./routes/auth.routes'));
app.use('/api/zatca',     require('./routes/zatca.routes'));
app.use('/api/users',     require('./routes/users.routes'));
app.use('/api/products',  require('./routes/products.routes'));
app.use('/api/customers', require('./routes/customers.routes'));
app.use('/api/suppliers', require('./routes/suppliers.routes'));
app.use('/api/invoices',  require('./routes/invoices.routes'));
app.use('/api/credit-notes', require('./routes/creditNotes.routes'));
app.use('/api/quotes',    require('./routes/quotes.routes'));
app.use('/api/purchases', require('./routes/purchases.routes'));
app.use('/api/treasury',  require('./routes/treasury.routes'));
app.use('/api/employees', require('./routes/employees.routes'));
app.use('/api/reports',   require('./routes/reports.routes'));
app.use('/api/support',   require('./routes/support.routes'));
app.use('/api/payment',   require('./routes/payments.routes'));
app.use('/api/ai',            require('./routes/ai.routes'));
app.use('/api/notifications', require('./routes/notifications.routes'));
app.use('/api/obligations',   require('./routes/obligations.routes'));
app.use('/api/journal',       require('./routes/journal.routes'));
app.use('/api/returns',       require('./routes/returns.routes'));
app.use('/api/purchase-orders', require('./routes/purchaseOrders.routes'));
app.use('/api/vouchers',      require('./routes/vouchers.routes'));
app.use('/api/closed-periods', require('./routes/closedPeriods.routes'));
app.use('/api/loyalty',       require('./routes/loyalty.routes'));
app.use('/api/bank-recon',    require('./routes/bankRecon.routes'));
app.use('/api/activity-log',  require('./routes/activityLog.routes'));
app.use('/api/settings',      require('./routes/settings.routes'));
app.use('/api/branches',      require('./routes/branches.routes'));
app.use('/api/warehouses',    require('./routes/warehouses.routes'));
app.use('/api/pos-points',    require('./routes/posPoints.routes'));
app.use('/api/stock-transfers', require('./routes/stockTransfers.routes'));

// ── Static Pages ─────────────────────────────────────────────
app.get('/robots.txt', (_, res) => {
  res.setHeader('Content-Type', 'text/plain');
  res.sendFile(require('path').join(staticPath, 'robots.txt'));
});
app.get('/sitemap.xml', (_, res) => {
  res.setHeader('Content-Type', 'application/xml');
  res.sendFile(require('path').join(staticPath, 'sitemap.xml'));
});
app.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  sendHtmlWithNonce(require('path').join(staticPath, 'index.html'), req, res);
});
app.get('/privacy',          (_, res) => res.sendFile(require('path').join(staticPath, 'privacy.html')));
app.get('/terms',            (_, res) => res.sendFile(require('path').join(staticPath, 'terms.html')));
app.get('/subscribe', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  sendHtmlWithNonce(require('path').join(staticPath, 'subscribe.html'), req, res);
});
app.get('/reset-password',   (req, res) => sendHtmlWithNonce(require('path').join(staticPath, 'reset-password.html'), req, res));
app.get('/payment/callback', require('./controllers/payments.controller').verifyCallback);
app.get('/VVIP.html',(req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Frame-Options', 'DENY');
  sendHtmlWithNonce(require('path').join(staticPath, 'VVIP.html'), req, res);
});
// /admin — لا يُعاد توجيهه للخارج، التحقق من المصادقة يتم داخل الصفحة عبر JWT
app.get('/admin', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  sendHtmlWithNonce(require('path').join(staticPath, 'admin.html'), req, res);
});

// ── Error handler ────────────────────────────────────────────
// كان يُخفي رسالة الخطأ الحقيقية بالإنتاج دائمًا (أي err.message)، بصرف النظر
// عن مصدرها — يشمل هذا مئات الرسائل العربية الآمنة والمقصودة أصلًا لتظهر
// للمستخدم (مثل "لا يمكنك تسجيل عملية على فرع آخر غير فرعك المخصَّص"، "الفترة
// مقفلة محاسبياً"، "ليس لديك صلاحية"...) المرمية عمدًا بـerr.status محدَّد
// (403/400/423...) من عشرات نقاط الكود المختلفة. كل هذي كانت تصير "خطأ داخلي
// في الخادم" المبهم بالإنتاج، فيستحيل تشخيص أي مشكلة إعداد حقيقية (فرع موظف
// غير مُعيَّن مثلاً) بدون وصول مباشر لسجلّات السيرفر. الإخفاء بالإنتاج يبقى
// مفيدًا فقط لاستثناء غير متوقَّع فعليًا (بلا err.status، قد يحمل تفاصيل
// داخلية حسّاسة) — لا لرسالة صيغت عمدًا لتكون آمنة وواضحة للمستخدم النهائي
app.use((err, req, res, next) => {
  console.error(`[${new Date().toISOString()}] ${req.method} ${req.path}:`, err.message);
  const isDeliberateError = !!err.status && err.status < 500;
  res.status(err.status || 500).json({
    success: false,
    message: (isDeliberateError || !isProduction) ? (err.message || 'خطأ داخلي في الخادم') : 'خطأ داخلي في الخادم'
  });
});

process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
  process.exit(1);
});

async function seedPlatformAdmin() {
  const email = (process.env.ADMIN_EMAIL || '').trim();
  const pass  = (process.env.ADMIN_PASS  || '').trim();
  if (!email || !pass) return;
  try {
    const db     = require('./config/db');
    const bcrypt = require('bcrypt');
    const { rows } = await db.query('SELECT COUNT(*)::int AS cnt FROM platform_admins');
    if (rows[0].cnt > 0) return;
    const hash = await bcrypt.hash(pass, 12);
    await db.query(
      `INSERT INTO platform_admins (email, password_hash, full_name) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [email.toLowerCase(), hash, 'مالك المنصة']
    );
    console.log(`✅ Platform admin created: ${email}`);
  } catch (err) {
    console.error('⚠️  seedPlatformAdmin:', err.message);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Yaqiz Backend running on port ${PORT}`);
  console.log(`   Environment: ${process.env.NODE_ENV}`);
  seedPlatformAdmin();
});

// إرسال دوري تلقائي لمستندات الهيئة المعلَّقة/المرفوضة (فواتير مبسّطة بلا أي
// مسار إرسال تلقائي سابقًا، ومستندات فشلت مرة ولم تُعَد محاولتها أبدًا) — كل
// 20 دقيقة هامش أمان واسع لمهلة الـ24 ساعة الإلزامية لإبلاغ الفواتير المبسّطة.
// لا حاجة لمكتبة جدولة خارجية لعملية Node واحدة، setInterval كافية.
const { runPendingZatcaSubmissions } = require('./services/zatcaScheduler.service');
setInterval(() => {
  runPendingZatcaSubmissions().catch(err => console.error('[ZATCA scheduler]', err.message));
}, 20 * 60 * 1000);

// نسخة احتياطية تلقائية يومية لقاعدة البيانات (راجع src/services/backup.service.js).
// أول نسخة بعد 5 دقائق من الإقلاع (تفادي التنافس مع تحميل السيرفر)، ثم كل 24 ساعة.
const { runBackup } = require('./services/backup.service');
setTimeout(() => {
  runBackup().then(f => console.log('[Backup] ✅', f)).catch(err => console.error('[Backup]', err.message));
  setInterval(() => {
    runBackup().then(f => console.log('[Backup] ✅', f)).catch(err => console.error('[Backup]', err.message));
  }, 24 * 60 * 60 * 1000);
}, 5 * 60 * 1000);

module.exports = app;
