const rateLimit = require('express-rate-limit');

exports.loginLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'محاولات كثيرة جداً، حاول بعد 10 دقائق' }
});

exports.apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'عدد كبير من الطلبات، حاول لاحقاً' }
});

exports.registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'تم تجاوز الحد المسموح لإنشاء الحسابات، حاول بعد ساعة' }
});
