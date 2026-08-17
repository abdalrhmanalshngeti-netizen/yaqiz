const db = require('../config/db');

exports.list = async (req, res, next) => {
  try {
    const { active = 'true' } = req.query;
    let where  = [`company_id = $1`];
    let params = [req.user.company_id];
    if (active !== 'all') { where.push(`is_active = $2`); params.push(active === 'true'); }

    const { rows } = await db.query(
      `SELECT * FROM branches WHERE ${where.join(' AND ')} ORDER BY is_main DESC, name`,
      params
    );
    res.json({ success: true, data: rows });
  } catch (err) { next(err); }
};

exports.getOne = async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT * FROM branches WHERE id = $1 AND company_id = $2`,
      [req.params.id, req.user.company_id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'الفرع غير موجود' });
    res.json({ success: true, data: rows[0] });
  } catch (err) { next(err); }
};

// إنشاء فرع + مستودعه المرتبط تلقائيًا (يحقق "واحد لواحد" بدون خطوة إضافية
// من المالك) + حساب خزينة نقدي منفصل له — بمعاملة واحدة. المالك فقط.
exports.create = async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    if (req.user.role !== 'owner') {
      return res.status(403).json({ success: false, message: 'إضافة فرع للمالك فقط' });
    }
    const { name, branch_number, address, phone } = req.body;
    if (!name || !branch_number) {
      return res.status(400).json({ success: false, message: 'اسم الفرع ورقمه مطلوبان' });
    }

    await client.query('BEGIN');

    const { rows: [{ count }] } = await client.query(
      `SELECT COUNT(*)::int AS count FROM branches WHERE company_id = $1`,
      [req.user.company_id]
    );
    const isFirstBranch = count === 0;

    const { rows: [branch] } = await client.query(`
      INSERT INTO branches (company_id, name, branch_number, address, phone, is_main)
      VALUES ($1,$2,$3,$4,$5,$6)
      RETURNING *
    `, [req.user.company_id, name, branch_number, address || null, phone || null, isFirstBranch]);

    const { rows: [warehouse] } = await client.query(`
      INSERT INTO warehouses (company_id, branch_id, name)
      VALUES ($1,$2,$3)
      RETURNING *
    `, [req.user.company_id, branch.id, `مستودع ${name}`]);

    // ترحيل بنيوي بحت (مو "ترحيل تلقائي للفروع" المرفوض): أول فرع لشركة قائمة
    // عندها مخزون بالفعل بـ products.qty بلا أي مستودع — ننسخه لمستودع الفرع
    // الجديد عشان ما يبدأ الجرد صفرًا فجأة عند تفعيل ميزة الفروع
    if (isFirstBranch) {
      await client.query(`
        INSERT INTO product_stock (company_id, product_id, warehouse_id, qty)
        SELECT company_id, id, $2, qty FROM products WHERE company_id = $1 AND qty <> 0
      `, [req.user.company_id, warehouse.id]);
    }

    // حساب خزينة نقدي منفصل لكل فرع — البنكي يبقى مشتركًا على مستوى الشركة
    // افتراضيًا (treasury_accounts.branch_id=NULL) إلا لو المالك خصّص حسابًا
    // بنكيًا منفصلًا بنفسه لاحقًا من صفحة الخزينة. أول فرع يرث "الصندوق الرئيسي"
    // الموجود أصلًا من التسجيل (فيه الرصيد التاريخي قبل تفعيل الفروع) بدل ما
    // نُنشئ له صندوقًا فارغًا مكررًا ونترك الرصيد القديم يتيمًا بلا فرع
    if (isFirstBranch) {
      await client.query(`
        UPDATE treasury_accounts SET branch_id = $1
        WHERE company_id = $2 AND is_default = true AND type = 'cash' AND branch_id IS NULL
      `, [branch.id, req.user.company_id]);
    } else {
      await client.query(`
        INSERT INTO treasury_accounts (company_id, branch_id, name, type, balance, is_default)
        VALUES ($1,$2,$3,'cash',0,false)
      `, [req.user.company_id, branch.id, `صندوق ${name}`]);
    }

    await client.query('COMMIT');
    res.status(201).json({ success: true, data: { ...branch, warehouse } });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
};

exports.update = async (req, res, next) => {
  try {
    if (req.user.role !== 'owner') {
      return res.status(403).json({ success: false, message: 'تعديل الفروع للمالك فقط' });
    }
    const { name, branch_number, address, phone, is_active } = req.body;
    const { rows } = await db.query(`
      UPDATE branches SET
        name          = COALESCE($1, name),
        branch_number = COALESCE($2, branch_number),
        address       = COALESCE($3, address),
        phone         = COALESCE($4, phone),
        is_active     = COALESCE($5, is_active)
      WHERE id = $6 AND company_id = $7
      RETURNING *
    `, [name, branch_number, address, phone, is_active, req.params.id, req.user.company_id]);

    if (!rows[0]) return res.status(404).json({ success: false, message: 'الفرع غير موجود' });
    res.json({ success: true, data: rows[0] });
  } catch (err) { next(err); }
};

exports.remove = async (req, res, next) => {
  try {
    if (req.user.role !== 'owner') {
      return res.status(403).json({ success: false, message: 'حذف الفروع للمالك فقط' });
    }
    const { rows: [branch] } = await db.query(
      `SELECT is_main FROM branches WHERE id = $1 AND company_id = $2`,
      [req.params.id, req.user.company_id]
    );
    if (!branch) return res.status(404).json({ success: false, message: 'الفرع غير موجود' });
    if (branch.is_main) {
      return res.status(400).json({ success: false, message: 'لا يمكن تعطيل الفرع الرئيسي' });
    }
    const { rows: [{ count }] } = await db.query(
      `SELECT COUNT(*)::int AS count FROM branches WHERE company_id = $1 AND is_active = true`,
      [req.user.company_id]
    );
    if (count <= 1) {
      return res.status(400).json({ success: false, message: 'لا يمكن تعطيل آخر فرع نشط بالشركة' });
    }

    await db.query(`UPDATE branches SET is_active = false WHERE id = $1 AND company_id = $2`,
      [req.params.id, req.user.company_id]);
    res.json({ success: true });
  } catch (err) { next(err); }
};

// GET /api/branches/exists — يُستخدم من بوابة إعداد الفرع الإجبارية (لا يتطلب
// صلاحية معيّنة غير تسجيل الدخول، عشان يشتغل لأي دور قبل ما يكون له أي صلاحيات)
exports.checkExists = async (req, res, next) => {
  try {
    const { rows: [{ exists: hasAny }] } = await db.query(
      `SELECT EXISTS(SELECT 1 FROM branches WHERE company_id = $1 AND is_active = true) AS exists`,
      [req.user.company_id]
    );
    res.json({ success: true, exists: hasAny });
  } catch (err) { next(err); }
};
