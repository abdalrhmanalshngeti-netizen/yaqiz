const db    = require('../config/db');
const stock = require('../services/stock.service');
const logAudit = require('../middleware/logger');

exports.list = async (req, res, next) => {
  try {
    const { search, category_id, low_stock, active = 'true' } = req.query;
    let where  = [`p.company_id = $1`];
    let params = [req.user.company_id];
    let idx    = 2;

    if (active !== 'all') { where.push(`p.is_active = $${idx++}`); params.push(active === 'true'); }
    if (category_id)      { where.push(`p.category_id = $${idx++}`); params.push(category_id); }
    if (low_stock === 'true') { where.push(`p.qty <= p.min_qty AND p.min_qty > 0`); }
    if (search) {
      where.push(`(p.name ILIKE $${idx} OR p.code ILIKE $${idx} OR p.barcode = $${idx++})`);
      params.push(`%${search}%`);
    }

    const { rows } = await db.query(`
      SELECT p.*, c.name AS category_name
      FROM products p
      LEFT JOIN product_categories c ON c.id = p.category_id
      WHERE ${where.join(' AND ')}
      ORDER BY p.name
    `, params);

    res.json({ success: true, data: rows });
  } catch (err) { next(err); }
};

exports.getOne = async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT * FROM products WHERE id = $1 AND company_id = $2`,
      [req.params.id, req.user.company_id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'المنتج غير موجود' });
    res.json({ success: true, data: rows[0] });
  } catch (err) { next(err); }
};

exports.create = async (req, res, next) => {
  try {
    const { code, barcode, name, name_en, category_id, unit_id,
            buy_price, sell_price, qty, min_qty, max_qty, tax_rate, notes } = req.body;

    if (!name) return res.status(400).json({ success: false, message: 'اسم المنتج مطلوب' });

    const { rows } = await db.query(`
      INSERT INTO products
        (company_id, code, barcode, name, name_en, category_id, unit_id,
         buy_price, sell_price, qty, min_qty, max_qty, tax_rate, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      RETURNING *
    `, [req.user.company_id, code, barcode, name, name_en, category_id, unit_id,
        buy_price || 0, sell_price || 0, qty || 0, min_qty || 0, max_qty, tax_rate ?? 15, notes]);

    res.status(201).json({ success: true, data: rows[0] });
  } catch (err) { next(err); }
};

exports.update = async (req, res, next) => {
  try {
    const { code, barcode, name, name_en, category_id, unit_id,
            buy_price, sell_price, min_qty, max_qty, tax_rate, notes, is_active } = req.body;

    const { rows: [before] } = await db.query(
      `SELECT name, buy_price, sell_price FROM products WHERE id = $1 AND company_id = $2`,
      [req.params.id, req.user.company_id]
    );
    if (!before) return res.status(404).json({ success: false, message: 'المنتج غير موجود' });

    const { rows } = await db.query(`
      UPDATE products SET
        code        = COALESCE($1,  code),
        barcode     = COALESCE($2,  barcode),
        name        = COALESCE($3,  name),
        name_en     = COALESCE($4,  name_en),
        category_id = COALESCE($5,  category_id),
        unit_id     = COALESCE($6,  unit_id),
        buy_price   = COALESCE($7,  buy_price),
        sell_price  = COALESCE($8,  sell_price),
        min_qty     = COALESCE($9,  min_qty),
        max_qty     = COALESCE($10, max_qty),
        tax_rate    = COALESCE($11, tax_rate),
        notes       = COALESCE($12, notes),
        is_active   = COALESCE($13, is_active),
        updated_at  = NOW()
      WHERE id = $14 AND company_id = $15
      RETURNING *
    `, [code, barcode, name, name_en, category_id, unit_id,
        buy_price, sell_price, min_qty, max_qty, tax_rate, notes, is_active,
        req.params.id, req.user.company_id]);

    if (!rows[0]) return res.status(404).json({ success: false, message: 'المنتج غير موجود' });
    res.json({ success: true, data: rows[0] });

    // نسجّل التعديل اليدوي على السعر بنفس جدول سجل التغييرات المستخدم أصلاً
    // للتسعير التلقائي — عشان تظهر كل تعديلات السعر (يدوية أو تلقائية) بنفس
    // شاشة «سجل التغييرات» الموجودة بالفعل بواجهة المنتج، بدون آلية موازية
    const buyChanged  = buy_price  != null && parseFloat(buy_price)  !== parseFloat(before.buy_price);
    const sellChanged = sell_price != null && parseFloat(sell_price) !== parseFloat(before.sell_price);
    if (buyChanged || sellChanged) {
      await db.query(`
        INSERT INTO product_price_history
          (company_id, product_id, old_buy_price, new_buy_price,
           old_sell_price, new_sell_price, changed_by, reason)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'manual_edit')
      `, [req.user.company_id, rows[0].id, before.buy_price, rows[0].buy_price,
          before.sell_price, rows[0].sell_price, req.user.sub]);
    }
  } catch (err) { next(err); }
};

exports.remove = async (req, res, next) => {
  try {
    await db.query(
      `UPDATE products SET is_active = false WHERE id = $1 AND company_id = $2`,
      [req.params.id, req.user.company_id]
    );
    res.json({ success: true });
  } catch (err) { next(err); }
};

exports.stockMoves = async (req, res, next) => {
  try {
    const { from, to, limit = 100 } = req.query;
    let where  = [`sm.product_id = $1`, `sm.company_id = $2`];
    let params = [req.params.id, req.user.company_id];
    let idx    = 3;

    if (from) { where.push(`sm.created_at >= $${idx++}`); params.push(from); }
    if (to)   { where.push(`sm.created_at <= $${idx++}`); params.push(to); }

    const { rows } = await db.query(`
      SELECT sm.*, u.full_name AS created_by_name
      FROM stock_moves sm
      LEFT JOIN users u ON u.id = sm.created_by
      WHERE ${where.join(' AND ')}
      ORDER BY sm.created_at DESC
      LIMIT $${idx}
    `, [...params, limit]);

    res.json({ success: true, data: rows });
  } catch (err) { next(err); }
};

exports.setPricingPolicy = async (req, res, next) => {
  try {
    const { profit_policy_type, profit_policy_value, auto_price_update } = req.body;

    const policyType = profit_policy_type || 'none';
    if (!['none', 'percentage_on_cost'].includes(policyType)) {
      return res.status(400).json({ success: false, message: 'نوع السياسة غير صحيح' });
    }

    const policyValue = parseFloat(profit_policy_value) || 0;
    if (policyValue < 0) {
      return res.status(400).json({ success: false, message: 'نسبة الربح لا يمكن أن تكون سالبة' });
    }

    const { rows } = await db.query(`
      UPDATE products SET
        profit_policy_type  = $1,
        profit_policy_value = $2,
        auto_price_update   = $3,
        updated_at          = NOW()
      WHERE id = $4 AND company_id = $5
      RETURNING *
    `, [policyType, policyValue, auto_price_update ?? false,
        req.params.id, req.user.company_id]);

    if (!rows[0]) return res.status(404).json({ success: false, message: 'المنتج غير موجود' });
    res.json({ success: true, data: rows[0] });
  } catch (err) { next(err); }
};

exports.getPriceHistory = async (req, res, next) => {
  try {
    const { rows } = await db.query(`
      SELECT h.*, u.full_name AS changed_by_name, pu.purchase_no
      FROM product_price_history h
      LEFT JOIN users u ON u.id = h.changed_by
      LEFT JOIN purchases pu ON pu.id = h.purchase_id
      WHERE h.product_id = $1 AND h.company_id = $2
      ORDER BY h.created_at DESC
      LIMIT 50
    `, [req.params.id, req.user.company_id]);
    res.json({ success: true, data: rows });
  } catch (err) { next(err); }
};

exports.manualMove = async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const { type, qty, reason, source, reference, warehouse_id } = req.body;

    if (!['in','out'].includes(type) || !qty || qty <= 0) {
      return res.status(400).json({ success: false, message: 'بيانات الحركة غير صحيحة' });
    }
    if (!warehouse_id) {
      return res.status(400).json({ success: false, message: 'المستودع مطلوب' });
    }
    const { rows: [wh] } = await client.query(
      `SELECT id FROM warehouses WHERE id = $1 AND company_id = $2 AND is_active = true`,
      [warehouse_id, req.user.company_id]
    );
    if (!wh) return res.status(404).json({ success: false, message: 'المستودع غير موجود' });

    const args = {
      company_id: req.user.company_id,
      product_id: req.params.id,
      warehouse_id,
      qty, reason, source, reference,
      source_type: 'manual', source_id: null,
      user_id: req.user.sub
    };

    let move;
    if (type === 'in')  move = await stock.add(client, args);
    if (type === 'out') move = await stock.deduct(client, args);

    await client.query('COMMIT');
    res.json({ success: true, data: move });

    logAudit({
      companyId: req.user.company_id, userId: req.user.sub, action: 'stock_manual_adjust',
      entityType: 'product', entityId: req.params.id, ip: req.ip,
      oldValues: { qty: move.balance_before }, newValues: { qty: move.balance_after },
      details: `تسوية مخزون يدوية (${type==='in'?'إضافة':'خصم'} ${qty}) — السبب: ${reason||'-'}`
    });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
};

// GET /api/products/stock-by-warehouse — كل صفوف الكمية لكل (منتج، مستودع)
// بالشركة، تُستخدم لتغذية db.productStock بالواجهة عند تحميل البيانات
exports.stockByWarehouse = async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT product_id, warehouse_id, qty::float FROM product_stock WHERE company_id = $1`,
      [req.user.company_id]
    );
    res.json({ success: true, data: rows });
  } catch (err) { next(err); }
};

exports.listAllMoves = async (req, res, next) => {
  try {
    const { from, to, limit = 500 } = req.query;
    // نرجّع فقط الحركات اليدوية (تسويات المخزون) — حركات الفواتير/المشتريات
    // التلقائية تبقى محلية عند كل جهاز لتفادي تكرارها مع نسخته المحلية
    let where  = [`sm.company_id = $1`, `sm.source_type = 'manual'`];
    let params = [req.user.company_id];
    let idx    = 2;

    // "مسؤول فرع": يرى فقط حركات مستودع فرعه — نفس تعميم المرحلة C على
    // الورديات (listShifts)، فرعه يُقرأ طازجًا من قاعدة البيانات دائمًا
    const perms = req.user.perms || [];
    const canSeeAll = req.user.role === 'owner' || perms.includes('settings.view');
    if (!canSeeAll && perms.includes('branch.manage')) {
      const { rows: [u] } = await db.query(`SELECT branch_id FROM users WHERE id = $1`, [req.user.sub]);
      if (u?.branch_id) {
        where.push(`sm.warehouse_id IN (SELECT id FROM warehouses WHERE branch_id = $${idx++})`);
        params.push(u.branch_id);
      }
    }

    if (from) { where.push(`sm.created_at >= $${idx++}`); params.push(from); }
    if (to)   { where.push(`sm.created_at <= $${idx++}`); params.push(to); }

    const { rows } = await db.query(`
      SELECT sm.*, p.name AS product_name, p.code AS product_code
      FROM stock_moves sm
      JOIN products p ON p.id = sm.product_id
      WHERE ${where.join(' AND ')}
      ORDER BY sm.created_at DESC
      LIMIT $${idx}
    `, [...params, limit]);

    res.json({ success: true, data: rows });
  } catch (err) { next(err); }
};
