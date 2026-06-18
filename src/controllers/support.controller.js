const db          = require('../config/db');
const { sendMail } = require('../services/email.service');

const PLATFORM_OWNER_EMAIL = 'abdalrhmanalshngeti@gmail.com';

// POST /api/support/public — بدون مصادقة (من شاشة الدخول)
exports.createPublicTicket = async (req, res, next) => {
  try {
    const { phone, username, company_name, message } = req.body;
    if (!phone || !message) {
      return res.status(400).json({ success: false, message: 'رقم الجوال ووصف المشكلة مطلوبان' });
    }

    const userName    = username ? `${phone} / ${username}` : phone;
    const companyName = company_name || '—';

    const { rows: [ticket] } = await db.query(`
      INSERT INTO support_tickets
        (company_id, company_name, user_name, user_role, department, sub_dept, description, note)
      VALUES (NULL,$1,$2,'guest','public','login-screen',$3,$4)
      RETURNING id, created_at
    `, [companyName, userName, message, `📞 ${phone}${username ? ' — @'+username : ''}`]);

    sendMail({
      to: PLATFORM_OWNER_EMAIL,
      subject: `📞 طلب دعم من شاشة الدخول — ${phone}`,
      html: `<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="UTF-8"><style>
        body{font-family:Arial,sans-serif;background:#f1f5f9;margin:0;padding:20px;}
        .wrap{max-width:500px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.1);}
        .header{background:#0f172a;padding:20px 28px;color:#fff;font-size:1.1rem;font-weight:700;}
        .body{padding:24px 28px;}
        .row{padding:8px 0;border-bottom:1px solid #f1f5f9;font-size:.92rem;display:flex;justify-content:space-between;}
        .label{color:#64748b;font-weight:600;}.val{color:#1e293b;font-weight:700;}
        .msg{background:#f8fafc;border-radius:8px;padding:14px;margin-top:14px;font-size:.92rem;line-height:1.7;border:1px solid #e2e8f0;white-space:pre-wrap;}
      </style></head><body>
      <div class="wrap">
        <div class="header">📞 طلب دعم فني — شاشة الدخول</div>
        <div class="body">
          <div class="row"><span class="label">رقم الجوال</span><span class="val">${phone}</span></div>
          ${username ? `<div class="row"><span class="label">اسم المستخدم</span><span class="val">${username}</span></div>` : ''}
          ${company_name ? `<div class="row"><span class="label">اسم الشركة</span><span class="val">${company_name}</span></div>` : ''}
          <div class="row"><span class="label">رقم التذكرة</span><span class="val">#${ticket.id}</span></div>
          <div class="msg">${message}</div>
        </div>
      </div></body></html>`
    }).catch(e => console.warn('[support-public] Email failed:', e.message));

    res.status(201).json({ success: true, id: ticket.id });
  } catch (err) { next(err); }
};

// GET /api/support/tickets — المالك يجلب كل تذاكر شركته
exports.listCompanyTickets = async (req, res, next) => {
  try {
    if (req.user.role !== 'owner' && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'المالك فقط يمكنه عرض التذاكر' });
    }
    const { rows } = await db.query(
      `SELECT * FROM support_tickets WHERE company_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [req.user.company_id]
    );
    res.json({ success: true, data: rows });
  } catch (err) { next(err); }
};

// PUT /api/support/tickets/:id/status — المالك يحدّث حالة التذكرة
exports.updateCompanyTicketStatus = async (req, res, next) => {
  try {
    if (req.user.role !== 'owner' && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'المالك فقط يمكنه تحديث التذاكر' });
    }
    const { status } = req.body;
    if (!['open', 'in_progress', 'resolved'].includes(status)) {
      return res.status(400).json({ success: false, message: 'حالة غير صالحة' });
    }
    const resolved_at = status === 'resolved' ? new Date() : null;
    const { rowCount } = await db.query(
      `UPDATE support_tickets SET status = $1, resolved_at = $2
       WHERE id = $3 AND company_id = $4`,
      [status, resolved_at, req.params.id, req.user.company_id]
    );
    if (!rowCount) return res.status(404).json({ success: false, message: 'التذكرة غير موجودة' });
    res.json({ success: true });
  } catch (err) { next(err); }
};

// POST /api/support/ticket — المستخدم يرسل تذكرة
exports.createTicket = async (req, res, next) => {
  try {
    const { department, sub_dept, description, note } = req.body;
    const { sub: userId, company_id, role } = req.user;

    // جلب بيانات المستخدم والشركة معاً
    const [userRow, coRow] = await Promise.all([
      db.query(`SELECT username, full_name FROM users WHERE id = $1`, [userId]),
      db.query(`SELECT name FROM companies WHERE id = $1`, [company_id])
    ]);
    const u  = userRow.rows[0];
    const co = coRow.rows[0];
    const userName    = u?.full_name || u?.username || 'مستخدم';
    const companyName = co?.name || '';

    const { rows: [ticket] } = await db.query(`
      INSERT INTO support_tickets
        (company_id, company_name, user_name, user_role, department, sub_dept, description, note)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING id, created_at
    `, [
      company_id,
      companyName,
      userName,
      role,
      department || '',
      sub_dept   || '',
      description || '',
      note || ''
    ]);

    // إشعار فوري بالبريد الإلكتروني لمالك النظام
    sendMail({
      to: PLATFORM_OWNER_EMAIL,
      subject: `🎧 تذكرة دعم جديدة — ${companyName}`,
      html: `<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="UTF-8"><style>
        body{font-family:'Tajawal',Arial,sans-serif;background:#f1f5f9;margin:0;padding:0;}
        .wrap{max-width:520px;margin:40px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 16px rgba(0,0,0,.08);}
        .header{background:#0f172a;padding:24px 32px;text-align:center;}
        .header h1{color:#fff;font-size:1.3rem;margin:0;}
        .body{padding:28px 32px;}
        .row{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #f1f5f9;font-size:.93rem;}
        .label{color:#64748b;font-weight:600;}
        .val{color:#1e293b;font-weight:700;text-align:right;max-width:300px;}
        .note-box{background:#f8fafc;border-radius:8px;padding:14px;color:#374151;font-size:.93rem;line-height:1.8;margin-top:16px;border:1px solid #e2e8f0;white-space:pre-wrap;}
        .footer{text-align:center;padding:14px;color:#94a3b8;font-size:.8rem;border-top:1px solid #f1f5f9;}
      </style></head><body>
      <div class="wrap">
        <div class="header"><h1>🎧 تذكرة دعم جديدة</h1></div>
        <div class="body">
          <div class="row"><span class="label">الشركة</span><span class="val">${companyName}</span></div>
          <div class="row"><span class="label">المستخدم</span><span class="val">${userName} (${role})</span></div>
          <div class="row"><span class="label">القسم</span><span class="val">${department || '—'}</span></div>
          <div class="row"><span class="label">القضية</span><span class="val">${sub_dept || description || '—'}</span></div>
          <div class="row"><span class="label">رقم التذكرة</span><span class="val">#${ticket.id}</span></div>
          <div class="row"><span class="label">التاريخ</span><span class="val">${new Date(ticket.created_at).toLocaleString('ar-SA')}</span></div>
          ${note ? `<div class="note-box">${note}</div>` : ''}
        </div>
        <div class="footer">يقظ — yaqiz.me | لوحة المالك ← تذاكر الدعم</div>
      </div></body></html>`
    }).catch(e => console.warn('[support] Email notification failed:', e.message));

    res.status(201).json({ success: true, id: ticket.id, created_at: ticket.created_at });
  } catch (err) { next(err); }
};
