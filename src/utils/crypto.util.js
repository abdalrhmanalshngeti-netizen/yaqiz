// تشفير عام لبيانات حساسة تُخزَّن بقاعدة البيانات (مفاتيح ZATCA الخاصة وكلمات سر
// الوصول لكل شركة) — AES-256-GCM (تشفير موثّق يمنع أيضًا العبث بالمحتوى المشفَّر).
//
// يتطلب متغير بيئة ZATCA_ENCRYPTION_KEY (32 بايت بصيغة base64). عمدًا لا نولّد
// مفتاحًا افتراضيًا بالكود — تخزين مفاتيح خاصة تخص شركات بمفتاح تشفير معروف أو
// عشوائي بكل تشغيل يُبطل الغرض من التشفير بالكامل.

const crypto = require('crypto');

function getMasterKey() {
  const b64 = process.env.ZATCA_ENCRYPTION_KEY;
  if (!b64) {
    throw new Error('ZATCA_ENCRYPTION_KEY غير معرَّف بالبيئة — لا يمكن تخزين مفاتيح ZATCA الخاصة بأمان بدونه');
  }
  const key = Buffer.from(b64, 'base64');
  if (key.length !== 32) {
    throw new Error('ZATCA_ENCRYPTION_KEY يجب أن يكون 32 بايت (256 بت) بصيغة base64');
  }
  return key;
}

function encrypt(plaintext) {
  const key = getMasterKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    encrypted: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
  };
}

function decrypt({ encrypted, iv, tag }) {
  const key = getMasterKey();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encrypted, 'base64')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}

module.exports = { encrypt, decrypt };
