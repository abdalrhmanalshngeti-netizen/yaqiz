const jwt = require('jsonwebtoken');

module.exports = function superAdminAuth(req, res, next) {
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
    req.admin = payload;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ success: false, code: 'TOKEN_EXPIRED', message: 'انتهت الجلسة' });
    }
    res.status(401).json({ success: false, message: 'توكن غير صالح' });
  }
};
