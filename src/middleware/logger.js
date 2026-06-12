const db = require('../config/db');

module.exports = async function logActivity({
  companyId, userId, username, action,
  entityType, entityId, oldValues, newValues, ip, details
}) {
  try {
    await db.query(`
      INSERT INTO activity_log
        (company_id, user_id, username, action, entity_type, entity_id,
         old_values, new_values, ip_address, details)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    `, [
      companyId, userId, username, action,
      entityType, entityId,
      oldValues  ? JSON.stringify(oldValues)  : null,
      newValues  ? JSON.stringify(newValues)  : null,
      ip, details
    ]);
  } catch (_) {
    // لا نوقف الطلب إذا فشل تسجيل النشاط
  }
};
