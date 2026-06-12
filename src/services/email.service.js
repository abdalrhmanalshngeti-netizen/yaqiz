const nodemailer = require('nodemailer');

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  transporter = nodemailer.createTransport({
    host:   process.env.SMTP_HOST || 'smtp-mail.outlook.com',
    port:   parseInt(process.env.SMTP_PORT) || 587,
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
    tls: { ciphers: 'SSLv3' }
  });
  return transporter;
}

async function sendMail({ to, subject, html }) {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.warn('[email] SMTP not configured — skipping send to:', to);
    return { skipped: true };
  }
  const info = await getTransporter().sendMail({
    from: `"يقظ للمحاسبة" <${process.env.SMTP_USER}>`,
    to,
    subject,
    html,
  });
  return info;
}

function resetPasswordTemplate(username, resetUrl) {
  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head><meta charset="UTF-8"><style>
  body { font-family:'Tajawal',Arial,sans-serif; background:#f1f5f9; margin:0; padding:0; }
  .wrap { max-width:520px; margin:40px auto; background:#fff; border-radius:12px; overflow:hidden; box-shadow:0 4px 16px rgba(0,0,0,.08); }
  .header { background:#0f172a; padding:28px 32px; text-align:center; }
  .header h1 { color:#fff; font-size:1.4rem; margin:0; }
  .header p  { color:#64748b; font-size:.85rem; margin:4px 0 0; }
  .body { padding:32px; }
  .body p { color:#374151; line-height:1.8; font-size:.97rem; }
  .btn-wrap { text-align:center; margin:28px 0; }
  .btn { background:#1d4ed8; color:#fff !important; text-decoration:none; padding:14px 32px; border-radius:8px; font-weight:700; font-size:1rem; display:inline-block; }
  .note { background:#f8fafc; border-radius:8px; padding:12px 16px; color:#64748b; font-size:.85rem; margin-top:20px; border:1px solid #e2e8f0; }
  .footer { text-align:center; padding:16px; color:#94a3b8; font-size:.8rem; border-top:1px solid #f1f5f9; }
</style></head>
<body>
<div class="wrap">
  <div class="header">
    <h1>يقظ — Yaqiz Accounting</h1>
    <p>نظام المحاسبة السعودي</p>
  </div>
  <div class="body">
    <p>مرحباً <strong>${username}</strong>،</p>
    <p>تلقّينا طلباً لإعادة تعيين كلمة المرور الخاصة بحسابك على منصة يقظ. اضغط على الزر أدناه لإتمام العملية:</p>
    <div class="btn-wrap">
      <a href="${resetUrl}" class="btn">إعادة تعيين كلمة المرور</a>
    </div>
    <div class="note">
      <strong>تنبيه:</strong> هذا الرابط صالح لمدة ساعة واحدة فقط.<br>
      إذا لم تطلب إعادة التعيين، يمكنك تجاهل هذه الرسالة بأمان.
    </div>
  </div>
  <div class="footer">يقظ — yaqiz.me</div>
</div>
</body></html>`;
}

module.exports = { sendMail, resetPasswordTemplate };
