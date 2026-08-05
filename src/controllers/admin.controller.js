const bcrypt = require('bcrypt');
const jwt    = require('jsonwebtoken');
const db     = require('../config/db');

const ADMIN_PERMISSIONS = ['tickets', 'customers', 'impersonate'];

// ── تسجيل دخول المدير العام ─────────────────────────────
exports.login = async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'البريد الإلكتروني وكلمة المرور مطلوبان' });
    }

    const { rows } = await db.query(
      `SELECT * FROM platform_admins WHERE email = $1 AND active = true`,
      [email.toLowerCase().trim()]
    );
    const admin = rows[0];
    if (!admin || !(await bcrypt.compare(password, admin.password_hash))) {
      return res.status(401).json({ success: false, message: 'بيانات غير صحيحة' });
    }

    await db.query(
      `UPDATE platform_admins SET last_login = NOW() WHERE id = $1`,
      [admin.id]
    );

    const token = jwt.sign(
      { sub: admin.id, is_super_admin: true, email: admin.email, name: admin.full_name },
      process.env.JWT_SECRET,
      { expiresIn: '12h' }
    );
    res.json({
      success: true, token, email: admin.email, name: admin.full_name,
      role: admin.role, permissions: admin.permissions || [],
    });
  } catch (err) { next(err); }
};

// ── هوية الموظف الحالي (لأي موظف، بدون قيد صلاحية) ────────
exports.me = async (req, res, next) => {
  try {
    res.json({ success: true, data: { email: req.admin.email, name: req.admin.name, role: req.admin.role, permissions: req.admin.permissions } });
  } catch (err) { next(err); }
};

// ── إحصائيات المنصة ──────────────────────────────────────
exports.stats = async (req, res, next) => {
  try {
    const [companies, users, invoices, newToday, byStatus, daily, suspended, recentLog, recentRegistrations] = await Promise.all([
      db.query(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status='active')::int AS active FROM companies`),
      db.query(`SELECT COUNT(*)::int AS total FROM users WHERE is_super_admin = false`),
      db.query(`SELECT COUNT(*)::int AS total, COALESCE(SUM(grand_total),0)::numeric AS revenue FROM invoices`),
      db.query(`SELECT COUNT(*)::int AS total FROM companies WHERE created_at >= NOW() - INTERVAL '24 hours'`),
      db.query(`SELECT status, COUNT(*)::int AS count FROM companies GROUP BY status`),
      db.query(`
        SELECT TO_CHAR(created_at,'YYYY-MM-DD') AS day, COUNT(*)::int AS count
        FROM companies
        WHERE created_at >= NOW() - INTERVAL '30 days'
        GROUP BY day ORDER BY day
      `),
      db.query(`
        SELECT c.id, c.name, c.status, c.created_at,
          COUNT(DISTINCT u.id) FILTER (WHERE u.is_super_admin=false)::int AS user_count
        FROM companies c
        LEFT JOIN users u ON u.company_id = c.id
        WHERE c.status != 'active'
        GROUP BY c.id ORDER BY c.created_at DESC LIMIT 10
      `),
      db.query(`
        SELECT pl.event_type, pl.description, pl.created_at, c.name AS company_name
        FROM platform_log pl
        LEFT JOIN companies c ON c.id = pl.company_id
        ORDER BY pl.created_at DESC LIMIT 10
      `),
      db.query(`
        SELECT c.id, c.name, c.contact_email, c.contact_phone, c.city, c.plan, c.created_at,
               u.full_name, u.username
        FROM companies c
        LEFT JOIN users u ON u.company_id = c.id AND u.role = 'owner'
        ORDER BY c.created_at DESC LIMIT 10
      `),
    ]);

    const statusMap = {};
    byStatus.rows.forEach(r => { statusMap[r.status] = r.count; });

    res.json({
      success: true,
      data: {
        companies:              { ...companies.rows[0], by_status: statusMap },
        users:                  users.rows[0],
        invoices:               invoices.rows[0],
        new_today:              newToday.rows[0].total,
        daily_reg:              daily.rows,
        issues:                 suspended.rows,
        recent_log:             recentLog.rows,
        recent_registrations:   recentRegistrations.rows,
      }
    });
  } catch (err) { next(err); }
};

// ── قائمة الشركات ─────────────────────────────────────────
exports.companies = async (req, res, next) => {
  try {
    const { search, status, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;
    let where  = ['1=1'];
    let params = [];
    let idx    = 1;

    if (status) { where.push(`c.status = $${idx++}`); params.push(status); }
    if (search) {
      where.push(`(c.name ILIKE $${idx} OR c.vat_number ILIKE $${idx})`);
      params.push(`%${search}%`); idx++;
    }

    const { rows } = await db.query(`
      SELECT
        c.id, c.name, c.vat_number, c.status, c.plan,
        c.contact_email, c.contact_phone, c.city, c.created_at,
        c.subscription_expires_at,
        EXISTS(SELECT 1 FROM subscriptions s WHERE s.company_id = c.id) AS has_paid,
        COUNT(DISTINCT u.id) FILTER (WHERE u.is_super_admin = false)::int AS user_count,
        COUNT(DISTINCT i.id)::int  AS invoice_count,
        COALESCE(SUM(i.grand_total), 0)::numeric AS total_revenue,
        COUNT(*) OVER() AS total_count
      FROM companies c
      LEFT JOIN users u ON u.company_id = c.id
      LEFT JOIN invoices i ON i.company_id = c.id
      WHERE ${where.join(' AND ')}
      GROUP BY c.id
      ORDER BY c.created_at DESC
      LIMIT $${idx++} OFFSET $${idx}
    `, [...params, limit, offset]);

    res.json({
      success: true,
      data:  rows,
      total: parseInt(rows[0]?.total_count || 0),
      page:  parseInt(page)
    });
  } catch (err) { next(err); }
};

// ── تفاصيل شركة واحدة ─────────────────────────────────────
exports.companyDetails = async (req, res, next) => {
  try {
    const { rows: [company] } = await db.query(
      `SELECT c.*,
         COUNT(DISTINCT u.id) FILTER (WHERE u.is_super_admin=false)::int AS user_count,
         COUNT(DISTINCT i.id)::int AS invoice_count,
         COALESCE(SUM(i.grand_total),0)::numeric AS total_revenue
       FROM companies c
       LEFT JOIN users u ON u.company_id = c.id
       LEFT JOIN invoices i ON i.company_id = c.id
       WHERE c.id = $1
       GROUP BY c.id`,
      [req.params.id]
    );
    if (!company) return res.status(404).json({ success: false, message: 'الشركة غير موجودة' });

    const { rows: users } = await db.query(
      `SELECT id, username, full_name, role, active, last_login, created_at
       FROM users WHERE company_id = $1 AND is_super_admin = false ORDER BY created_at`,
      [req.params.id]
    );

    const { rows: recentInvoices } = await db.query(
      `SELECT invoice_no, customer_name, grand_total, status, created_at
       FROM invoices WHERE company_id = $1 ORDER BY created_at DESC LIMIT 5`,
      [req.params.id]
    );

    res.json({ success: true, data: { ...company, users, recent_invoices: recentInvoices } });
  } catch (err) { next(err); }
};

// ── تغيير حالة الشركة (تعليق / تفعيل) ────────────────────
exports.setCompanyStatus = async (req, res, next) => {
  try {
    const { status } = req.body;
    if (!['active', 'suspended', 'cancelled'].includes(status)) {
      return res.status(400).json({ success: false, message: 'حالة غير صالحة' });
    }
    await db.query(`UPDATE companies SET status = $1 WHERE id = $2`, [status, req.params.id]);

    await db.query(`
      INSERT INTO platform_log (event_type, company_id, description)
      VALUES ('status_changed', $1, $2)
    `, [req.params.id, `تغيير الحالة إلى: ${status}`]);

    res.json({ success: true, message: `تم تغيير الحالة إلى ${status}` });
  } catch (err) { next(err); }
};

// ── تحليل التكلفة لكل الشركات ────────────────────────────
exports.costAnalysis = async (req, res, next) => {
  try {
    const { rows } = await db.query(`
      SELECT
        c.id, c.name, c.status, c.plan, c.created_at,
        c.contact_email, c.contact_phone, c.vat_number, c.city,
        c.subscription_expires_at,
        EXISTS(SELECT 1 FROM subscriptions s WHERE s.company_id = c.id) AS has_paid,
        COUNT(DISTINCT u.id) FILTER (WHERE u.is_super_admin = false)::int AS user_count,
        COUNT(DISTINCT i.id)::int AS invoice_count,
        COALESCE(SUM(i.grand_total), 0)::numeric AS total_revenue
      FROM companies c
      LEFT JOIN users u ON u.company_id = c.id
      LEFT JOIN invoices i ON i.company_id = c.id
      GROUP BY c.id
      ORDER BY COUNT(DISTINCT i.id) DESC
    `);
    res.json({ success: true, data: rows });
  } catch (err) { next(err); }
};

// ── سجل نشاط المنصة ──────────────────────────────────────
exports.platformLog = async (req, res, next) => {
  try {
    const { rows } = await db.query(`
      SELECT pl.*, c.name AS company_name
      FROM platform_log pl
      LEFT JOIN companies c ON c.id = pl.company_id
      ORDER BY pl.created_at DESC
      LIMIT 100
    `);
    res.json({ success: true, data: rows });
  } catch (err) { next(err); }
};

// ── قائمة المستخدمين (الحسابات الرئيسية + التابعة) ────────
exports.listUsers = async (req, res, next) => {
  try {
    const { rows } = await db.query(`
      SELECT
        c.id   AS company_id,
        c.name AS company_name,
        c.status AS company_status,
        u.id, u.username, u.full_name, u.role, u.active, u.last_login, u.created_at,
        (
          SELECT COUNT(*)::int FROM users u2
          WHERE u2.company_id = c.id
            AND u2.is_super_admin = false
            AND u2.role <> 'owner'
        ) AS sub_count
      FROM users u
      JOIN companies c ON c.id = u.company_id
      WHERE u.is_super_admin = false AND u.role = 'owner'
      ORDER BY u.created_at DESC
    `);
    res.json({ success: true, data: rows });
  } catch (err) { next(err); }
};

// ── تصفح بصلاحيات مستخدم (Impersonation) ─────────────────
exports.impersonate = async (req, res, next) => {
  try {
    const reason = (req.body?.reason || '').trim();
    if (!reason) {
      return res.status(400).json({ success: false, message: 'ملاحظة المعاينة مطلوبة قبل الدخول بحساب أي شركة' });
    }

    const { rows } = await db.query(`
      SELECT u.*, c.name AS company_name
      FROM users u
      JOIN companies c ON c.id = u.company_id
      WHERE u.company_id = $1 AND u.role = 'owner' AND u.active = true AND u.is_super_admin = false
      LIMIT 1
    `, [req.params.company_id]);

    const user = rows[0];
    if (!user) return res.status(404).json({ success: false, message: 'لم يُعثر على حساب owner لهذه الشركة' });

    const crypto = require('crypto');
    const code = crypto.randomBytes(32).toString('hex');
    const actorName = req.admin.name || req.admin.email || 'المدير العام';

    // حذف الأكواد القديمة المنتهية أو المستخدمة لهذه الشركة
    await db.query(
      `DELETE FROM impersonation_codes WHERE company_id = $1 AND (expires_at < NOW() OR used = TRUE)`,
      [user.company_id]
    );

    await db.query(`
      INSERT INTO impersonation_codes (code, company_id, user_id, company_name, created_by, reason)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [code, user.company_id, user.id, user.company_name, actorName, reason]);

    await db.query(`
      INSERT INTO platform_log (event_type, company_id, description)
      VALUES ('impersonation', $1, $2)
    `, [user.company_id, `طلب دخول إداري: ${user.company_name} بواسطة ${actorName} — ملاحظة المعاينة: ${reason}`]);

    res.json({ success: true, code, company_name: user.company_name });
  } catch (err) { next(err); }
};

// ── إحصائيات الباقات ─────────────────────────────────────
exports.getPlans = async (req, res, next) => {
  try {
    const { rows } = await db.query(`
      SELECT
        c.id, c.name, c.plan, c.contact_email, c.subscription_expires_at,
        COUNT(DISTINCT u.id) FILTER (WHERE u.is_super_admin=false)::int AS user_count,
        COUNT(DISTINCT i.id)::int AS invoice_count
      FROM companies c
      LEFT JOIN users u ON u.company_id = c.id
      LEFT JOIN invoices i ON i.company_id = c.id
      GROUP BY c.id
      ORDER BY c.created_at DESC
    `);

    const plans = { basic: [], growth: [], pro: [] };
    rows.forEach(r => {
      const key = r.plan || 'basic';
      (plans[key] || (plans[key] = [])).push(r);
    });

    res.json({ success: true, data: { plans, companies: rows } });
  } catch (err) { next(err); }
};

// ── تغيير باقة شركة ──────────────────────────────────────
exports.setCompanyPlan = async (req, res, next) => {
  try {
    const { plan, expires_at } = req.body;
    const validPlans = ['basic', 'growth', 'pro'];
    if (!validPlans.includes(plan)) {
      return res.status(400).json({ success: false, message: 'باقة غير صالحة' });
    }

    if (expires_at) {
      const expDate = new Date(expires_at);
      if (isNaN(expDate.getTime())) {
        return res.status(400).json({ success: false, message: 'تاريخ انتهاء غير صالح' });
      }
      await db.query(
        `UPDATE companies SET plan = $1, subscription_expires_at = $2 WHERE id = $3`,
        [plan, expDate, req.params.id]
      );
    } else {
      const days = 30;
      await db.query(
        `UPDATE companies SET plan = $1, subscription_expires_at = NOW() + ($2 || ' days')::INTERVAL WHERE id = $3`,
        [plan, String(days), req.params.id]
      );
    }

    await db.query(`
      INSERT INTO platform_log (event_type, company_id, description)
      VALUES ('plan_changed', $1, $2)
    `, [req.params.id, `تغيير الباقة إلى: ${plan} بواسطة ${req.admin.email || req.admin.name}`]);

    res.json({ success: true, message: `تم تغيير الباقة إلى ${plan}` });
  } catch (err) { next(err); }
};

// ── عملاء جدد ومحتملون ────────────────────────────────────
exports.newClients = async (req, res, next) => {
  try {
    const { rows } = await db.query(`
      SELECT c.id, c.name, c.contact_email, c.contact_phone, c.city, c.plan,
             c.created_at, c.status,
             EXTRACT(DAY FROM NOW() - c.created_at)::int AS days_since,
             u.full_name, u.username
      FROM companies c
      LEFT JOIN users u ON u.company_id = c.id AND u.role = 'owner'
      WHERE c.created_at >= NOW() - INTERVAL '30 days'
        AND NOT EXISTS (SELECT 1 FROM platform_admins WHERE email = u.username)
      ORDER BY c.created_at DESC
    `);
    const newClients       = rows.filter(r => r.days_since <  15);
    const potentialClients = rows.filter(r => r.days_since >= 15);
    res.json({ success: true, new: newClients, potential: potentialClients });
  } catch (err) { next(err); }
};

// ── تذاكر الدعم — قائمة ──────────────────────────────────
exports.listTickets = async (req, res, next) => {
  try {
    const { status, company_id } = req.query;
    const params = [];
    const conditions = [];
    if (status && status !== 'all') {
      params.push(status);
      conditions.push(`t.status = $${params.length}`);
    }
    if (company_id) {
      params.push(company_id);
      conditions.push(`t.company_id = $${params.length}`);
    }
    const where = conditions.length ? conditions.join(' AND ') : '1=1';
    const { rows } = await db.query(`
      SELECT t.*, a.full_name AS assigned_name
      FROM support_tickets t
      LEFT JOIN platform_admins a ON a.id = t.assigned_to
      WHERE ${where}
      ORDER BY t.created_at DESC
      LIMIT 200
    `, params);
    res.json({ success: true, data: rows });
  } catch (err) { next(err); }
};

// ── تذكرة واحدة — تفاصيل + سجل الشركة + الردود ──────────
exports.getTicket = async (req, res, next) => {
  try {
    const { rows: [ticket] } = await db.query(`
      SELECT t.*, a.full_name AS assigned_name
      FROM support_tickets t
      LEFT JOIN platform_admins a ON a.id = t.assigned_to
      WHERE t.id = $1
    `, [req.params.id]);
    if (!ticket) return res.status(404).json({ success: false, message: 'التذكرة غير موجودة' });

    const { rows: replies } = await db.query(
      `SELECT id, author_type, author_name, message, created_at
       FROM ticket_replies WHERE ticket_id = $1 ORDER BY created_at`,
      [req.params.id]
    );

    let history = [];
    if (ticket.company_id) {
      const { rows } = await db.query(`
        SELECT id, department, sub_dept, description, status, created_at, resolved_at
        FROM support_tickets WHERE company_id = $1 ORDER BY created_at DESC LIMIT 50
      `, [ticket.company_id]);
      history = rows;
    }

    res.json({ success: true, data: ticket, replies, history });
  } catch (err) { next(err); }
};

// ── استلام التذكرة ────────────────────────────────────────
exports.claimTicket = async (req, res, next) => {
  try {
    const actor = req.admin.name || req.admin.email;
    const actionEntry = JSON.stringify([{
      status: null, label: `استلام بواسطة ${actor}`, actor, at: new Date().toISOString()
    }]);
    const { rows: [ticket] } = await db.query(`
      UPDATE support_tickets
      SET assigned_to = $1,
          status = CASE WHEN status = 'open' THEN 'in_progress' ELSE status END,
          actions = COALESCE(actions, '[]'::jsonb) || $2::jsonb
      WHERE id = $3
      RETURNING *
    `, [req.admin.sub, actionEntry, req.params.id]);
    if (!ticket) return res.status(404).json({ success: false, message: 'التذكرة غير موجودة' });
    res.json({ success: true, data: ticket });
  } catch (err) { next(err); }
};

// ── رد الموظف على العميل ──────────────────────────────────
exports.replyTicket = async (req, res, next) => {
  try {
    const message = (req.body?.message || '').trim();
    if (!message) return res.status(400).json({ success: false, message: 'نص الرد مطلوب' });

    const { rows: [ticket] } = await db.query(
      `SELECT * FROM support_tickets WHERE id = $1`, [req.params.id]
    );
    if (!ticket) return res.status(404).json({ success: false, message: 'التذكرة غير موجودة' });

    const actor = req.admin.name || req.admin.email;
    const { rows: [reply] } = await db.query(`
      INSERT INTO ticket_replies (ticket_id, author_type, author_name, admin_id, message)
      VALUES ($1, 'admin', $2, $3, $4)
      RETURNING *
    `, [ticket.id, actor, req.admin.sub, message]);

    // لو التذكرة لسا مفتوحة، الرد يعني بدأنا نشتغل عليها
    if (ticket.status === 'open') {
      await db.query(`UPDATE support_tickets SET status = 'in_progress' WHERE id = $1`, [ticket.id]);
    }

    // إشعار العميل داخل التطبيق (لو التذكرة مرتبطة بشركة حقيقية، مو تذكرة ضيف)
    if (ticket.company_id) {
      await db.query(`
        INSERT INTO notifications (company_id, title, message, type)
        VALUES ($1, $2, $3, 'support_reply')
      `, [ticket.company_id, `رد على تذكرتك #${ticket.id}`, message]).catch(() => {});

      const { rows: [co] } = await db.query(`SELECT contact_email FROM companies WHERE id = $1`, [ticket.company_id]);
      if (co?.contact_email) {
        const { sendMail } = require('../services/email.service');
        sendMail({
          to: co.contact_email,
          subject: `رد على تذكرة الدعم #${ticket.id} — يقظ`,
          html: `<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="UTF-8"></head><body style="font-family:Arial,sans-serif;background:#f1f5f9;padding:20px;">
            <div style="max-width:500px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.1);">
              <div style="background:#0f172a;padding:20px 28px;color:#fff;font-weight:700;">رد على تذكرة الدعم #${ticket.id}</div>
              <div style="padding:24px 28px;color:#1e293b;line-height:1.8;white-space:pre-wrap;">${message}</div>
              <div style="padding:14px 28px;color:#94a3b8;font-size:.8rem;border-top:1px solid #f1f5f9;">يقظ — yaqiz.me</div>
            </div>
          </body></html>`
        }).catch(e => console.warn('[ticket-reply] Email failed:', e.message));
      }
    }

    res.status(201).json({ success: true, data: reply });
  } catch (err) { next(err); }
};

// ── تذاكر الدعم — تحديث الحالة ───────────────────────────
exports.updateTicketStatus = async (req, res, next) => {
  try {
    const { status } = req.body;
    if (!['open', 'in_progress', 'resolved'].includes(status)) {
      return res.status(400).json({ success: false, message: 'حالة غير صالحة' });
    }
    const resolved_at = status === 'resolved' ? new Date() : null;
    const actionLabel = { open: 'إعادة فتح', in_progress: 'جارٍ المعالجة', resolved: 'محلولة' }[status];
    const actor = req.admin?.name || req.admin?.email || 'المدير';
    const actionEntry = JSON.stringify([{
      status, label: actionLabel, actor, at: new Date().toISOString()
    }]);

    const { rowCount } = await db.query(`
      UPDATE support_tickets
      SET status = $1, resolved_at = $2,
          actions = COALESCE(actions, '[]'::jsonb) || $3::jsonb
      WHERE id = $4
    `, [status, resolved_at, actionEntry, req.params.id]);

    if (!rowCount) return res.status(404).json({ success: false, message: 'التذكرة غير موجودة' });
    res.json({ success: true });
  } catch (err) { next(err); }
};

// ── إدارة موظفي لوحة الإدارة (خاص بالمالك فقط) ───────────

exports.listEmployees = async (req, res, next) => {
  try {
    const { rows } = await db.query(`
      SELECT id, email, full_name, role, permissions, active, last_login, created_at
      FROM platform_admins ORDER BY created_at
    `);
    res.json({ success: true, data: rows });
  } catch (err) { next(err); }
};

exports.createEmployee = async (req, res, next) => {
  try {
    const { email, password, full_name, permissions = [] } = req.body;
    if (!email || !password || !full_name) {
      return res.status(400).json({ success: false, message: 'البريد وكلمة المرور والاسم مطلوبة' });
    }
    const validPerms = permissions.filter(p => ADMIN_PERMISSIONS.includes(p));

    const hash = await bcrypt.hash(password, 12);
    const { rows: [emp] } = await db.query(`
      INSERT INTO platform_admins (email, password_hash, full_name, role, permissions, created_by)
      VALUES ($1, $2, $3, 'staff', $4, $5)
      RETURNING id, email, full_name, role, permissions, active, created_at
    `, [email.toLowerCase().trim(), hash, full_name, validPerms, req.admin.sub]);

    await db.query(`
      INSERT INTO platform_log (event_type, description)
      VALUES ('admin_employee_added', $1)
    `, [`إضافة موظف لوحة إدارة: ${full_name} (${email}) بواسطة ${req.admin.name || req.admin.email}`]);

    res.status(201).json({ success: true, data: emp });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ success: false, message: 'البريد الإلكتروني مستخدم بالفعل' });
    next(err);
  }
};

exports.updateEmployee = async (req, res, next) => {
  try {
    const { rows: [target] } = await db.query(`SELECT role FROM platform_admins WHERE id = $1`, [req.params.id]);
    if (!target) return res.status(404).json({ success: false, message: 'الموظف غير موجود' });
    if (target.role === 'owner') {
      return res.status(403).json({ success: false, message: 'لا يمكن تعديل حساب المالك' });
    }

    const { full_name, permissions, active } = req.body;
    const validPerms = Array.isArray(permissions) ? permissions.filter(p => ADMIN_PERMISSIONS.includes(p)) : null;

    const { rows: [emp] } = await db.query(`
      UPDATE platform_admins SET
        full_name  = COALESCE($1, full_name),
        permissions = COALESCE($2, permissions),
        active      = COALESCE($3, active),
        revoke_sessions_before = NOW()
      WHERE id = $4
      RETURNING id, email, full_name, role, permissions, active, created_at
    `, [full_name || null, validPerms, typeof active === 'boolean' ? active : null, req.params.id]);

    await db.query(`
      INSERT INTO platform_log (event_type, description)
      VALUES ('admin_employee_updated', $1)
    `, [`تعديل صلاحيات/حالة الموظف #${req.params.id} بواسطة ${req.admin.name || req.admin.email}`]);

    res.json({ success: true, data: emp });
  } catch (err) { next(err); }
};

// ── إشعارات لوحة الإدارة (لكل موظف منصة صلاحياته الخاصة) ──

exports.listNotifications = async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT * FROM admin_notifications WHERE admin_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [req.admin.sub]
    );
    res.json({ success: true, data: rows });
  } catch (err) { next(err); }
};

exports.unreadNotifCount = async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT COUNT(*)::int AS count FROM admin_notifications WHERE admin_id = $1 AND is_read = false`,
      [req.admin.sub]
    );
    res.json({ success: true, count: rows[0].count });
  } catch (err) { next(err); }
};

exports.markAllNotifRead = async (req, res, next) => {
  try {
    await db.query(
      `UPDATE admin_notifications SET is_read = true WHERE admin_id = $1 AND is_read = false`,
      [req.admin.sub]
    );
    res.json({ success: true });
  } catch (err) { next(err); }
};
