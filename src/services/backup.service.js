// ── نسخ احتياطي تلقائي لقاعدة البيانات ─────────────────────
// سياسة الخصوصية (public/privacy.html) تنص فعليًا على "نسخ احتياطية منتظمة
// لقاعدة البيانات" — هذي الخدمة تُنفّذ هذا الالتزام فعليًا بدل ما يكون بند
// غير مطبَّق. تشغّل pg_dump يوميًا وتحتفظ بآخر BACKUP_RETENTION_DAYS نسخة
// فقط (افتراضيًا 14) لتفادي امتلاء القرص. التخزين محلي على نفس السيرفر —
// هذا لا يحمي من عطل كامل بالسيرفر نفسه، فلو توفّر تخزين خارجي (S3 أو ما
// شابه) يُفضَّل رفع النسخة له أيضًا بخطوة إضافية لاحقًا.
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

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
    const args = [
      '-h', process.env.DB_HOST || '127.0.0.1',
      '-p', process.env.DB_PORT || '5432',
      '-U', process.env.DB_USER,
      '-F', 'c', // custom format — مضغوط ويدعم استرجاع جزئي بـpg_restore
      '-f', outFile,
      process.env.DB_NAME,
    ];
    execFile('pg_dump', args, { env: { ...process.env, PGPASSWORD: process.env.DB_PASSWORD } }, (err) => {
      if (err) return reject(err);
      resolve(outFile);
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
  pruneOldBackups();
  return outFile;
}

module.exports = { runBackup, BACKUP_DIR };
