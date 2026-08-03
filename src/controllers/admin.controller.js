const bcrypt = require('bcrypt');
const jwt    = require('jsonwebtoken');
const db     = require('../config/db');

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
    res.json({ success: true, token, email: admin.email, name: admin.full_name });
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

    // حذف الأكواد القديمة المنتهية أو المستخدمة لهذه الشركة
    await db.query(
      `DELETE FROM impersonation_codes WHERE company_id = $1 AND (expires_at < NOW() OR used = TRUE)`,
      [user.company_id]
    );

    await db.query(`
      INSERT INTO impersonation_codes (code, company_id, user_id, company_name, created_by)
      VALUES ($1, $2, $3, $4, $5)
    `, [code, user.company_id, user.id, user.company_name, req.admin.name || req.admin.email || 'المدير العام']);

    await db.query(`
      INSERT INTO platform_log (event_type, company_id, description)
      VALUES ('impersonation', $1, $2)
    `, [user.company_id, `طلب دخول إداري: ${user.company_name} بواسطة ${req.admin.name || req.admin.email || 'المدير العام'}`]);

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
      conditions.push(`status = $${params.length}`);
    }
    if (company_id) {
      params.push(company_id);
      conditions.push(`company_id = $${params.length}`);
    }
    const where = conditions.length ? conditions.join(' AND ') : '1=1';
    const { rows } = await db.query(`
      SELECT * FROM support_tickets
      WHERE ${where}
      ORDER BY created_at DESC
      LIMIT 200
    `, params);
    res.json({ success: true, data: rows });
  } catch (err) { next(err); }
};

// ── تذكرة واحدة — تفاصيل + سجل الشركة ──────────────────
exports.getTicket = async (req, res, next) => {
  try {
    const { rows: [ticket] } = await db.query(
      `SELECT * FROM support_tickets WHERE id = $1`, [req.params.id]
    );
    if (!ticket) return res.status(404).json({ success: false, message: 'التذكرة غير موجودة' });

    let history = [];
    if (ticket.company_id) {
      const { rows } = await db.query(`
        SELECT id, department, sub_dept, description, status, created_at, resolved_at
        FROM support_tickets WHERE company_id = $1 ORDER BY created_at DESC LIMIT 50
      `, [ticket.company_id]);
      history = rows;
    }

    res.json({ success: true, data: ticket, history });
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
