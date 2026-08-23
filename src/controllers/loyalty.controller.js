const db = require('../config/db');

// GET /api/loyalty — الإعدادات + كل نقاط العملاء دفعة واحدة (حالة موحّدة على
// مستوى الشركة، لا لكل جهاز — يستبدل بها العميل نسخته المحلية بالكامل بثقة)
exports.get = async (req, res, next) => {
  try {
    const { company_id } = req.user;
    const { rows: [settings] } = await db.query(
      `SELECT enabled, points_per_sar, sar_per_point FROM loyalty_settings WHERE company_id = $1`,
      [company_id]
    );
    // الاسم الحالي (c.name) لا الاسم المخزَّن وقت آخر تحديث (lp.customer_name) —
    // بدون هذا، تغيير اسم عميل يُرجع نقاطه للواجهة تحت اسمه القديم فتظهر "مفقودة"
    const { rows: pointRows } = await db.query(
      `SELECT lp.customer_id, lp.customer_name, lp.points, c.name AS current_name
       FROM loyalty_points lp
       LEFT JOIN customers c ON c.id = lp.customer_id AND c.company_id = lp.company_id
       WHERE lp.company_id = $1`,
      [company_id]
    );
    const points = {};
    pointRows.forEach(r => { points[r.current_name || r.customer_name] = r.points; });

    res.json({
      success: true,
      settings: settings || { enabled: false, points_per_sar: 1, sar_per_point: 0.1 },
      points,
    });
  } catch (err) { next(err); }
};

// PUT /api/loyalty/settings
exports.updateSettings = async (req, res, next) => {
  try {
    const { company_id } = req.user;
    const enabled        = !!req.body.enabled;
    const points_per_sar = parseFloat(req.body.points_per_sar) || 1;
    const sar_per_point   = parseFloat(req.body.sar_per_point) || 0.1;

    await db.query(`
      INSERT INTO loyalty_settings (company_id, enabled, points_per_sar, sar_per_point, updated_at)
      VALUES ($1,$2,$3,$4,NOW())
      ON CONFLICT (company_id) DO UPDATE SET
        enabled = $2, points_per_sar = $3, sar_per_point = $4, updated_at = NOW()
    `, [company_id, enabled, points_per_sar, sar_per_point]);

    res.json({ success: true, settings: { enabled, points_per_sar, sar_per_point } });
  } catch (err) { next(err); }
};

// POST /api/loyalty/points — إضافة/خصم نقاط لعميل (فرق delta موجب أو سالب)
// يُستخدَم لكل من كسب النقاط التلقائي بعد البيع والإضافة اليدوية من الشاشة
exports.addPoints = async (req, res, next) => {
  try {
    const { company_id } = req.user;
    const customer_name = String(req.body.customer_name || '').trim();
    const customer_id   = req.body.customer_id || null;
    const delta = Math.round(parseFloat(req.body.delta) || 0);
    if (!customer_name || !delta) {
      return res.status(400).json({ success: false, message: 'customer_name و delta مطلوبان' });
    }

    // نطابق بالمعرّف أولًا لو مُرسَل — يمنع فقدان النقاط عند تغيير الاسم لاحقًا،
    // وإلا سجل قديم بنفس الاسم بلا معرّف بعد (يُلحَق به المعرّف الآن إن وُجد)
    let row = null;
    if (customer_id) {
      ({ rows: [row] } = await db.query(
        `SELECT id FROM loyalty_points WHERE company_id = $1 AND customer_id = $2`,
        [company_id, customer_id]
      ));
    }
    if (!row) {
      ({ rows: [row] } = await db.query(
        `SELECT id FROM loyalty_points WHERE company_id = $1 AND customer_id IS NULL AND customer_name = $2`,
        [company_id, customer_name]
      ));
    }

    let result;
    if (row) {
      ({ rows: [result] } = await db.query(`
        UPDATE loyalty_points SET
          points = GREATEST(0, points + $1), customer_name = $2,
          customer_id = COALESCE(customer_id, $3), updated_at = NOW()
        WHERE id = $4
        RETURNING points
      `, [delta, customer_name, customer_id, row.id]));
    } else {
      ({ rows: [result] } = await db.query(`
        INSERT INTO loyalty_points (company_id, customer_id, customer_name, points, updated_at)
        VALUES ($1,$2,$3,GREATEST(0,$4),NOW())
        RETURNING points
      `, [company_id, customer_id, customer_name, delta]));
    }

    res.json({ success: true, points: result.points });
  } catch (err) { next(err); }
};

// POST /api/loyalty/redeem — تصفير نقاط عميل (استرداد كامل الرصيد)
exports.redeem = async (req, res, next) => {
  try {
    const { company_id } = req.user;
    const customer_name = String(req.body.customer_name || '').trim();
    const customer_id   = req.body.customer_id || null;
    if (!customer_name && !customer_id) return res.status(400).json({ success: false, message: 'customer_name مطلوب' });

    if (customer_id) {
      await db.query(
        `UPDATE loyalty_points SET points = 0, updated_at = NOW() WHERE company_id = $1 AND customer_id = $2`,
        [company_id, customer_id]
      );
    } else {
      await db.query(
        `UPDATE loyalty_points SET points = 0, updated_at = NOW() WHERE company_id = $1 AND customer_name = $2`,
        [company_id, customer_name]
      );
    }

    res.json({ success: true });
  } catch (err) { next(err); }
};
