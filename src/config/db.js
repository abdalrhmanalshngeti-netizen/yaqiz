require('dotenv').config();
const { Pool, types } = require('pg');

const isProduction = process.env.NODE_ENV === 'production';

// عمود DATE (بلا وقت) لازم يبقى نصًا خامًا 'YYYY-MM-DD' — التحويل الافتراضي لـpg
// يحوّله لكائن JS Date بمنتصف ليل *محلي* (يعتمد TZ بالعملية)، وأي تسلسل JSON
// لاحق (res.json()) يستخدم toISOString() اللي دائمًا UTC، فيُزاح التاريخ للخلف
// بمقدار فرق التوقيت (مثلاً 2026-08-22 محليًا يصير "2026-08-21T21:00:00.000Z"
// بتوقيت +3) — يُقرَأ خطأً كتاريخ اليوم السابق لو المستهلك يقتطع أول 10 أحرف
// كالمعتاد بكل الكود الحالي. إبقاؤه نصًا خامًا يتفادى هذا الالتباس تمامًا.
types.setTypeParser(1082, (val) => val); // 1082 = OID لنوع DATE بـPostgreSQL

// توقيت جلسة Postgres — بدون هذا، NOW()/CURRENT_DATE/date_trunc() بكل الاستعلامات
// تعتمد توقيت خادم قاعدة البيانات الافتراضي (UTC غالبًا)، لا التوقيت السعودي
// الفعلي؛ يؤثر هذا على حدود الشهر/اليوم بكل تقرير وحد استخدام يومي، وعلى التاريخ
// الافتراضي لأي مستند يعتمد DEFAULT CURRENT_DATE بقاعدة البيانات. متغير TZ
// بالعملية نفسها لا يؤثر على جلسة Postgres إطلاقًا. نضبطها عبر معامل بدء
// الاتصال (options) نفسه — لا عبر استعلام SET TIME ZONE لاحق بحدث 'connect'،
// لأن ذاك الاستعلام غير مُنتظَر قبل تسليم العميل الجاهز، فيسبب تضاربًا حقيقيًا
// مع أول استعلام فعلي على نفس الاتصال تحت حمل حقيقي (نفس تحذير pg بشأن
// "client.query() أثناء تنفيذ استعلام آخر بنفس العميل")
const PG_OPTIONS = '-c TimeZone=Asia/Riyadh';

// تشفير الاتصال بقاعدة البيانات بالإنتاج:
//  • DATABASE_CA_CERT (نص الشهادة PEM، أو base64 لها): اتصال مشفّر مع التحقق من
//    هوية الخادم — يمنع انتحال قاعدة البيانات (الأفضل لو الاتصال يمر بشبكة عامة)
//  • DB_SSL=disable: بلا تشفير — فقط لو الاتصال بشبكة خاصة داخلية (مثل
//    postgres.railway.internal)
//  • غير ذلك (الافتراضي الحالي): مشفّر بلا تحقق من الشهادة — قواعد البيانات
//    المُدارة غالبًا بشهادة موقّعة ذاتيًا، فالتحقق بدون شهادتها يقطع الاتصال
function sslConfig() {
  if (!isProduction) return false;
  if (String(process.env.DB_SSL || '').toLowerCase() === 'disable') return false;
  let ca = process.env.DATABASE_CA_CERT || '';
  if (ca && !ca.includes('BEGIN CERTIFICATE')) {
    try { ca = Buffer.from(ca, 'base64').toString('utf8'); } catch { ca = ''; }
  }
  // لوحات الاستضافة كثيرًا تحفظ الأسطر الجديدة كنص حرفي «\n»
  if (ca.includes('BEGIN CERTIFICATE')) return { ca: ca.replace(/\\n/g, '\n'), rejectUnauthorized: true };
  console.warn('[db] الاتصال بقاعدة البيانات مشفّر بدون تحقق من الشهادة — أضف DATABASE_CA_CERT للتحقق الكامل');
  return { rejectUnauthorized: false };
}
const SSL = sslConfig();

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      options: PG_OPTIONS,
      ssl: SSL,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    })
  : new Pool({
      host:     process.env.DB_HOST,
      port:     parseInt(process.env.DB_PORT) || 5432,
      database: process.env.DB_NAME,
      user:     process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      options:  PG_OPTIONS,
      ssl:      SSL,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });

pool.on('error', (err) => {
  console.error('PostgreSQL pool error:', err);
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool,
};
