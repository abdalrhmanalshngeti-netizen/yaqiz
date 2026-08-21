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
    const { rows: pointRows } = await db.query(
      `SELECT customer_name, points FROM loyalty_points WHERE company_id = $1`,
      [company_id]
    );
    const points = {};
    pointRows.forEach(r => { points[r.customer_name] = r.points; });

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
    const delta = Math.round(parseFloat(req.body.delta) || 0);
    if (!customer_name || !delta) {
      return res.status(400).json({ success: false, message: 'customer_name و delta مطلوبان' });
    }

    const { rows: [row] } = await db.query(`
      INSERT INTO loyalty_points (company_id, customer_name, points, updated_at)
      VALUES ($1,$2,$3,NOW())
      ON CONFLICT (company_id, customer_name) DO UPDATE SET
        points = GREATEST(0, loyalty_points.points + $3), updated_at = NOW()
      RETURNING points
    `, [company_id, customer_name, delta]);

    res.json({ success: true, points: row.points });
  } catch (err) { next(err); }
};

// POST /api/loyalty/redeem — تصفير نقاط عميل (استرداد كامل الرصيد)
exports.redeem = async (req, res, next) => {
  try {
    const { company_id } = req.user;
    const customer_name = String(req.body.customer_name || '').trim();
    if (!customer_name) return res.status(400).json({ success: false, message: 'customer_name مطلوب' });

    await db.query(`
      UPDATE loyalty_points SET points = 0, updated_at = NOW()
      WHERE company_id = $1 AND customer_name = $2
    `, [company_id, customer_name]);

    res.json({ success: true });
  } catch (err) { next(err); }
};
