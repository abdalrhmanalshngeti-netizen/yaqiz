module.exports = function can(permission) {
  return (req, res, next) => {
    const { role, perms } = req.user;
    if (role === 'owner') return next();
    if (!perms || !perms.includes(permission)) {
      return res.status(403).json({
        success: false,
        message: 'ليس لديك صلاحية لهذه العملية'
      });
    }
    next();
  };
};
