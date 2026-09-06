// ── نسخ احتياطي تلقائي لقاعدة البيانات ─────────────────────
// سياسة الخصوصية (public/privacy.html) تنص فعليًا على "نسخ احتياطية منتظمة
// لقاعدة البيانات" — هذي الخدمة تُنفّذ هذا الالتزام فعليًا بدل ما يكون بند
// غير مطبَّق. تشغّل pg_dump يوميًا وتحتفظ بآخر BACKUP_RETENTION_DAYS نسخة
// فقط (افتراضيًا 14) لتفادي امتلاء القرص.
// الإنتاج يشتغل على Railway ويوصّل عبر DATABASE_URL (نفس src/config/db.js
// بالضبط) وليس متغيرات DB_HOST/DB_USER المنفصلة (تلك للتطوير المحلي فقط) —
// لازم نتبع نفس منطق db.js هنا وإلا الأمر يفشل بصمت بالإنتاج بمتغيرات undefined.
// ملاحظة مهمة: نظام ملفات حاويات Railway غير دائم بين عمليات النشر (redeploy)
// ما لم يُربَط Volume فعلي بمسار BACKUP_DIR — بدونه، كل نسخة تُمحى تلقائيًا
// عند أي نشر جديد (وهذا يحصل كثيرًا بهذا المشروع). هذا قرار بنية تحتية خارج
// نطاق الكود، يحتاج تفعيله من لوحة Railway مباشرة.
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

const isProduction = process.env.NODE_ENV === 'production';
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(__dirname, '..', '..', 'backups');
const RETENTION_DAYS = parseInt(process.env.BACKUP_RETENTION_DAYS || '14', 10);

function ensureDir() {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

function runPgDump() {
  return new Promise((resolve, reject) => {
    ensureDir();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outFile = path.join(BACKUP_DIR, `yaqiz-${stamp}.dump`);

    const args = ['-F', 'c', '-f', outFile]; // custom format — مضغوط ويدعم استرجاع جزئي بـpg_restore
    const env = { ...process.env };

    if (process.env.DATABASE_URL) {
      args.push(process.env.DATABASE_URL);
      // "require" = تشفير TLS بدون التحقق من الشهادة — نفس مبدأ rejectUnauthorized:false
      // المستخدَم بـdb.js تمامًا لنفس شهادة Railway الموقَّعة ذاتيًا
      if (isProduction) env.PGSSLMODE = env.PGSSLMODE || 'require';
    } else {
      args.push(
        '-h', process.env.DB_HOST || '127.0.0.1',
        '-p', process.env.DB_PORT || '5432',
        '-U', process.env.DB_USER,
        process.env.DB_NAME,
      );
      env.PGPASSWORD = process.env.DB_PASSWORD;
    }

    execFile('pg_dump', args, { env }, (err) => {
      if (err) return reject(err);
      resolve(outFile);
    });
  });
}

// تحقّق فعلي إن ملف النسخة سليم وقابل للاستعادة — بدون هذا، نسخة تالفة (كتابة
// ناقصة بسبب انقطاع، قرص ممتلئ، ...) تمر بصمت وتُكتشف فقط يوم تحتاجها فعلاً.
// pg_restore --list يقرأ فهرس المحتويات (TOC) بالكامل بدون لمس أي قاعدة بيانات
// — يكشف أي تلف بالبنية الداخلية للملف بسرعة وبأمان تام
function verifyBackup(outFile) {
  return new Promise((resolve, reject) => {
    execFile('pg_restore', ['--list', outFile], (err, stdout) => {
      if (err) return reject(new Error(`الملف تالف أو غير قابل للقراءة: ${err.message}`));
      const entryCount = stdout.split('\n').filter(l => l.trim()).length;
      if (entryCount < 5) return reject(new Error(`محتوى النسخة فارغ أو ناقص (${entryCount} سطر فقط بالفهرس)`));
      resolve(entryCount);
    });
  });
}

function pruneOldBackups() {
  ensureDir();
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  for (const f of fs.readdirSync(BACKUP_DIR)) {
    const full = path.join(BACKUP_DIR, f);
    const stat = fs.statSync(full);
    if (stat.isFile() && stat.mtimeMs < cutoff) fs.unlinkSync(full);
  }
}

async function runBackup() {
  const outFile = await runPgDump();
  const entryCount = await verifyBackup(outFile);
  pruneOldBackups();
  return { outFile, entryCount };
}

module.exports = { runBackup, BACKUP_DIR };
