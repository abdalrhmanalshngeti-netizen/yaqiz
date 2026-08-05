const jwt = require('jsonwebtoken');
const db  = require('../config/db');

// يتحقق من هوية موظف لوحة الإدارة، ثم يجلب الدور/الصلاحيات/حالة التفعيل
// دائماً من القاعدة (لا نثق بما كان محفوظاً بالتوكن وقت تسجيل الدخول) — بهذا
// أي تعديل صلاحيات أو تعطيل حساب موظف يسري فوراً من أول طلب تالي، بدون
// انتظار انتهاء صلاحية التوكن.
module.exports = async function superAdminAuth(req, res, next) {
  const header = req.headers['authorization'];
  const token  = header?.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ success: false, message: 'يجب تسجيل الدخول كمدير المنصة' });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (!payload.is_super_admin) {
      return res.status(403).json({ success: false, message: 'هذه الصفحة للمدير العام فقط' });
    }

    const { rows: [admin] } = await db.query(
      `SELECT id, email, full_name, role, permissions, active, revoke_sessions_before
       FROM platform_admins WHERE id = $1`,
      [payload.sub]
    );
    if (!admin || !admin.active) {
      return res.status(401).json({ success: false, message: 'الحساب غير موجود أو مُعطَّل' });
    }
    if (admin.revoke_sessions_before && payload.iat < new Date(admin.revoke_sessions_before).getTime() / 1000) {
      return res.status(401).json({ success: false, code: 'SESSION_REVOKED', message: 'تم إبطال هذه الجلسة، يرجى تسجيل الدخول مجدداً' });
    }

    req.admin = {
      sub: admin.id, email: admin.email, name: admin.full_name,
      role: admin.role, permissions: admin.permissions || [],
      is_super_admin: true,
    };
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ success: false, code: 'TOKEN_EXPIRED', message: 'انتهت الجلسة' });
    }
    res.status(401).json({ success: false, message: 'توكن غير صالح' });
  }
};
