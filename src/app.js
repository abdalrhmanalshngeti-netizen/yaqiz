require('dotenv').config();
const express     = require('express');
const helmet      = require('helmet');
const cors        = require('cors');
const compression = require('compression');
const { apiLimiter } = require('./middleware/rateLimiter');

const app = express();

// ── Security & parsing ────────────────────────────────────────
const isProduction = process.env.NODE_ENV === 'production';
app.set('trust proxy', 1);

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
      scriptSrc:     ["'self'", "'unsafe-inline'", "'unsafe-eval'",
                      "https://unpkg.com", "https://cdnjs.cloudflare.com", "https://cdn.jsdelivr.net"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc:      ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc:       ["'self'", "https://fonts.gstatic.com", "data:"],
      imgSrc:        ["'self'", "data:", "blob:", "https:"],
      connectSrc:    ["'self'", "https://api.openai.com", "https:"],
      workerSrc:     ["'self'", "blob:", "https://cdnjs.cloudflare.com"],
      frameSrc:      ["'none'"],
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
app.get('/', (_, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(require('path').join(staticPath, 'index.html'));
});
app.get('/privacy',          (_, res) => res.sendFile(require('path').join(staticPath, 'privacy.html')));
app.get('/terms',            (_, res) => res.sendFile(require('path').join(staticPath, 'terms.html')));
app.get('/subscribe', (_, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(require('path').join(staticPath, 'subscribe.html'));
});
app.get('/reset-password',   (_, res) => res.sendFile(require('path').join(staticPath, 'reset-password.html')));
app.get('/payment/callback', require('./controllers/payments.controller').verifyCallback);
app.get('/VVIP.html',(_, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Frame-Options', 'DENY');
  res.sendFile(require('path').join(staticPath, 'VVIP.html'));
});
// /admin — لا يُعاد توجيهه للخارج، التحقق من المصادقة يتم داخل الصفحة عبر JWT
app.get('/admin', (_, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.sendFile(require('path').join(staticPath, 'admin.html'));
});

// ── Error handler ────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(`[${new Date().toISOString()}] ${req.method} ${req.path}:`, err.message);
  res.status(err.status || 500).json({
    success: false,
    message: isProduction ? 'خطأ داخلي في الخادم' : (err.message || 'خطأ داخلي في الخادم')
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

module.exports = app;
