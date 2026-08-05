// صلاحيات موظفي لوحة الإدارة — يُستخدم بعد superAdmin middleware (يملأ req.admin)
// role='owner' (المالك الأصلي) يتجاوز كل الفحوصات دائماً — نفس مبدأ owner بجانب المستأجرين
module.exports = function canAdmin(permission) {
  return (req, res, next) => {
    if (req.admin?.role === 'owner') return next();
    if (!req.admin?.permissions?.includes(permission)) {
      return res.status(403).json({ success: false, message: 'ليس لديك صلاحية لهذه العملية' });
    }
    next();
  };
};
