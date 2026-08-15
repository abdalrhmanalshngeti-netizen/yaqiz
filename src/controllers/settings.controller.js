const db = require('../config/db');

// إعدادات عامة على مستوى الشركة (مفتاح/قيمة) — تُقرأ لأي مستخدم مسجّل دخول
// بالشركة (مثلاً الموظف يحتاج يعرف هل الضريبة مفعّلة عشان يبني الفاتورة صح)،
// وتُكتب من المالك فقط لأنها إعدادات تمس كل الشركة (ضريبة، أرصدة افتتاحية).
exports.getAll = async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT key, value FROM settings WHERE company_id = $1`,
      [req.user.company_id]
    );
    const data = {};
    for (const r of rows) {
      try { data[r.key] = JSON.parse(r.value); } catch { data[r.key] = r.value; }
    }
    res.json({ success: true, data });
  } catch (err) { next(err); }
};

exports.upsert = async (req, res, next) => {
  try {
    if (req.user.role !== 'owner') {
      return res.status(403).json({ success: false, message: 'هذه الميزة للمالك فقط' });
    }
    const { settings } = req.body;
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      return res.status(400).json({ success: false, message: 'settings مطلوبة' });
    }
    const entries = Object.entries(settings);
    if (!entries.length) {
      return res.status(400).json({ success: false, message: 'لا توجد بيانات للحفظ' });
    }
    for (const [key, value] of entries) {
      await db.query(`
        INSERT INTO settings (company_id, key, value)
        VALUES ($1, $2, $3)
        ON CONFLICT (company_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
      `, [req.user.company_id, key, JSON.stringify(value)]);
    }
    res.json({ success: true });
  } catch (err) { next(err); }
};
