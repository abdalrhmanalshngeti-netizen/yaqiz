const bcrypt = require('bcrypt');
const db     = require('../config/db');

const SAFE_FIELDS = `id, username, full_name, email, phone, role,
  permissions, pos_access, shift_enabled, active, last_login, created_at, tours_seen`;

// أقصى عدد مستخدمين (الحساب الرئيسي + التابعين) لكل باقة — null يعني بلا حد
const PLAN_USER_LIMITS = { basic: 3, growth: 5, pro: null };

exports.list = async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT ${SAFE_FIELDS} FROM users WHERE company_id = $1 ORDER BY created_at DESC`,
      [req.user.company_id]
    );
    res.json({ success: true, data: rows });
  } catch (err) { next(err); }
};

exports.getOne = async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT ${SAFE_FIELDS} FROM users WHERE id = $1 AND company_id = $2`,
      [req.params.id, req.user.company_id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'المستخدم غير موجود' });
    res.json({ success: true, data: rows[0] });
  } catch (err) { next(err); }
};

exports.create = async (req, res, next) => {
  try {
    const { username, password, full_name, email, phone,
            role, permissions, pos_access, shift_enabled } = req.body;

    if (!username || !password || !full_name) {
      return res.status(400).json({ success: false, message: 'اسم المستخدم وكلمة المرور والاسم الكامل مطلوبة' });
    }
    if (username.length < 6 || !/\d/.test(username)) {
      return res.status(400).json({ success: false, message: 'اسم المستخدم يجب أن يكون 6 أحرف على الأقل ويحتوي على رقم واحد على الأقل' });
    }
    if (password.length < 8 || !/[a-z]/.test(password) || !/[A-Z]/.test(password)) {
      return res.status(400).json({ success: false, message: 'كلمة المرور يجب أن تكون 8 أحرف على الأقل وتحتوي على حرف كبير وحرف صغير بالإنجليزية' });
    }

    const { rows: [co] } = await db.query(`SELECT plan FROM companies WHERE id = $1`, [req.user.company_id]);
    let plan = co?.plan || 'basic';
    if (plan === 'trial' || plan === 'free' || plan === 'starter') plan = 'basic';
    const limit = PLAN_USER_LIMITS[plan];
    if (limit) {
      const { rows: [{ count }] } = await db.query(
        `SELECT COUNT(*)::int AS count FROM users WHERE company_id = $1`,
        [req.user.company_id]
      );
      if (count >= limit) {
        return res.status(403).json({
          success: false,
          code: 'USER_LIMIT_REACHED',
          message: `باقتك الحالية تسمح بـ ${limit} مستخدمين كحد أقصى (شامل المالك). يرجى الترقية لإضافة المزيد.`
        });
      }
    }

    const hash = await bcrypt.hash(password, 12);
    const { rows } = await db.query(`
      INSERT INTO users
        (company_id, username, password_hash, full_name, email, phone,
         role, permissions, pos_access, shift_enabled)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      RETURNING ${SAFE_FIELDS}
    `, [
      req.user.company_id, username, hash, full_name, email, phone,
      role || 'cashier', permissions || [], pos_access || false, shift_enabled || false
    ]);

    db.query(`
      INSERT INTO platform_log (event_type, company_id, user_id, description)
      VALUES ('user_created', $1, $2, $3)
    `, [req.user.company_id, rows[0].id, `مستخدم جديد: ${rows[0].full_name} (${rows[0].role})`]).catch(() => {});

    res.status(201).json({ success: true, data: rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ success: false, message: 'اسم المستخدم مستخدم بالفعل' });
    }
    next(err);
  }
};

exports.update = async (req, res, next) => {
  try {
    const { full_name, email, phone, role, permissions, pos_access, shift_enabled, active } = req.body;
    const { rows } = await db.query(`
      UPDATE users SET
        full_name     = COALESCE($1, full_name),
        email         = COALESCE($2, email),
        phone         = COALESCE($3, phone),
        role          = COALESCE($4, role),
        permissions   = COALESCE($5, permissions),
        pos_access    = COALESCE($6, pos_access),
        shift_enabled = COALESCE($7, shift_enabled),
        active        = COALESCE($8, active)
      WHERE id = $9 AND company_id = $10
      RETURNING ${SAFE_FIELDS}
    `, [full_name, email, phone, role, permissions, pos_access, shift_enabled, active,
        req.params.id, req.user.company_id]);

    if (!rows[0]) return res.status(404).json({ success: false, message: 'المستخدم غير موجود' });
    res.json({ success: true, data: rows[0] });
  } catch (err) { next(err); }
};

exports.remove = async (req, res, next) => {
  try {
    if (parseInt(req.params.id) === req.user.sub) {
      return res.status(400).json({ success: false, message: 'لا يمكنك حذف حسابك الخاص' });
    }
    await db.query(
      `UPDATE users SET active = false WHERE id = $1 AND company_id = $2`,
      [req.params.id, req.user.company_id]
    );
    res.json({ success: true });
  } catch (err) { next(err); }
};

// وضع صفحة كـ "تمت مشاهدة جولتها التعليمية" لحساب المستخدم الحالي نفسه —
// بلا شرط صلاحية settings.edit عشان يشتغل لأي موظف مسجّل دخول، ويُزامَن عبر
// الحساب نفسه بغضّ النظر عن الجهاز (بدل الاعتماد على localStorage فقط)
exports.updateToursSeen = async (req, res, next) => {
  try {
    const { pageId } = req.body;
    if (!pageId || typeof pageId !== 'string') {
      return res.status(400).json({ success: false, message: 'pageId مطلوب' });
    }
    const { rows } = await db.query(`
      UPDATE users SET tours_seen = tours_seen || jsonb_build_object($1::text, true)
      WHERE id = $2 AND company_id = $3
      RETURNING tours_seen
    `, [pageId, req.user.sub, req.user.company_id]);
    if (!rows[0]) return res.status(404).json({ success: false, message: 'المستخدم غير موجود' });
    res.json({ success: true, data: rows[0].tours_seen });
  } catch (err) { next(err); }
};

exports.changePassword = async (req, res, next) => {
  try {
    const { new_password, old_password } = req.body;
    if (!new_password || new_password.length < 8 || !/[a-z]/.test(new_password) || !/[A-Z]/.test(new_password)) {
      return res.status(400).json({ success: false, message: 'كلمة المرور يجب أن تكون 8 أحرف على الأقل وتحتوي على حرف كبير وحرف صغير' });
    }

    const isSelf = String(req.params.id) === String(req.user.sub);
    const isOwner = req.user.role === 'owner';

    // المستخدم يغير كلمة مروره بنفسه → يجب إدخال القديمة
    if (isSelf) {
      if (!old_password) {
        return res.status(400).json({ success: false, message: 'يجب إدخال كلمة المرور الحالية' });
      }
      const { rows: [u] } = await db.query(
        `SELECT password_hash FROM users WHERE id = $1 AND company_id = $2`,
        [req.params.id, req.user.company_id]
      );
      if (!u || !(await bcrypt.compare(old_password, u.password_hash))) {
        return res.status(401).json({ success: false, message: 'كلمة المرور الحالية غير صحيحة' });
      }
    } else if (!isOwner) {
      // فقط الـ owner يمكنه تغيير كلمة مرور مستخدم آخر
      return res.status(403).json({ success: false, message: 'غير مسموح' });
    }

    const hash = await bcrypt.hash(new_password, 12);
    await db.query(
      `UPDATE users SET password_hash = $1 WHERE id = $2 AND company_id = $3`,
      [hash, req.params.id, req.user.company_id]
    );
    await db.query(`DELETE FROM user_sessions WHERE user_id = $1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) { next(err); }
};
