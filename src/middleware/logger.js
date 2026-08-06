const db = require('../config/db');

// سجل تدقيق حقيقي متزامن مع السيرفر — بخلاف سجل النشاط المحلي بالواجهة
// (يبقى بمتصفح المستخدم فقط ومحدود بآخر 200 عملية)، هذا يُخزَّن بجدول
// activity_log ويُستعلَم عنه من أي جهاز، لكل عملية محاسبية حساسة.
module.exports = async function logActivity({
  companyId, userId, username, action,
  entityType, entityId, oldValues, newValues, ip, details
}) {
  try {
    let uname = username;
    if (!uname && userId) {
      const { rows } = await db.query(`SELECT username FROM users WHERE id = $1`, [userId]);
      uname = rows[0]?.username || null;
    }
    await db.query(`
      INSERT INTO activity_log
        (company_id, user_id, username, action, entity_type, entity_id,
         old_values, new_values, ip_address, details)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    `, [
      companyId, userId, uname, action,
      entityType, entityId,
      oldValues  ? JSON.stringify(oldValues)  : null,
      newValues  ? JSON.stringify(newValues)  : null,
      ip, details
    ]);
  } catch (_) {
    // لا نوقف الطلب إذا فشل تسجيل النشاط
  }
};
