const db = require('../config/db');
const logAudit = require('../middleware/logger');

exports.list = async (req, res, next) => {
  try {
    const { search, active = 'true' } = req.query;
    let where  = [`company_id = $1`];
    let params = [req.user.company_id];
    let idx    = 2;

    if (active !== 'all') { where.push(`is_active = $${idx++}`); params.push(active === 'true'); }
    if (search) {
      where.push(`(name ILIKE $${idx} OR phone ILIKE $${idx} OR vat_number ILIKE $${idx++})`);
      params.push(`%${search}%`);
    }

    const { rows } = await db.query(
      `SELECT * FROM suppliers WHERE ${where.join(' AND ')} ORDER BY name`,
      params
    );
    res.json({ success: true, data: rows });
  } catch (err) { next(err); }
};

exports.getOne = async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT * FROM suppliers WHERE id = $1 AND company_id = $2`,
      [req.params.id, req.user.company_id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'المورد غير موجود' });
    res.json({ success: true, data: rows[0] });
  } catch (err) { next(err); }
};

exports.create = async (req, res, next) => {
  try {
    const { code, name, name_en, vat_number, cr_number,
            phone, email, address, city, payment_terms, balance, client_local_id } = req.body;

    if (!name) return res.status(400).json({ success: false, message: 'اسم المورد مطلوب' });

    // إعادة إرسال نفس الطلب (استجابة سابقة ضاعت بالشبكة) لا يجب أن تُنشئ موردًا
    // مكرَّرًا — نتعرّف على المحاولة السابقة عبر المعرّف المحلي بالمتصفح
    if (client_local_id) {
      const { rows: [existing] } = await db.query(
        `SELECT * FROM suppliers WHERE company_id = $1 AND client_local_id = $2`,
        [req.user.company_id, client_local_id]
      );
      if (existing) return res.status(201).json({ success: true, data: existing });
    }

    const { rows } = await db.query(`
      INSERT INTO suppliers
        (company_id, code, name, name_en, vat_number, cr_number,
         phone, email, address, city, payment_terms, balance, client_local_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      RETURNING *
    `, [req.user.company_id, code, name, name_en, vat_number, cr_number,
        phone, email, address, city, payment_terms || 30, parseFloat(balance) || 0, client_local_id || null]);

    res.status(201).json({ success: true, data: rows[0] });
  } catch (err) { next(err); }
};

exports.update = async (req, res, next) => {
  try {
    const { code, name, name_en, vat_number, cr_number,
            phone, email, address, city, payment_terms, is_active, balance,
            opening_balance_write } = req.body;

    // نفس منطق customers.controller.js: تجاهل balance بالمزامنة العامة، لا
    // يُكتَب إلا عبر معالج الأرصدة الافتتاحية صراحة (علامة opening_balance_write)
    const balanceParam = opening_balance_write === true && balance != null ? parseFloat(balance) : null;

    const { rows: [oldSup] } = balanceParam != null
      ? await db.query(`SELECT balance FROM suppliers WHERE id = $1 AND company_id = $2`, [req.params.id, req.user.company_id])
      : { rows: [null] };

    const { rows } = await db.query(`
      UPDATE suppliers SET
        code          = COALESCE($1,  code),
        name          = COALESCE($2,  name),
        name_en       = COALESCE($3,  name_en),
        vat_number    = COALESCE($4,  vat_number),
        cr_number     = COALESCE($5,  cr_number),
        phone         = COALESCE($6,  phone),
        email         = COALESCE($7,  email),
        address       = COALESCE($8,  address),
        city          = COALESCE($9,  city),
        payment_terms = COALESCE($10, payment_terms),
        is_active     = COALESCE($11, is_active),
        balance       = CASE WHEN $12::numeric IS NOT NULL THEN $12::numeric ELSE balance END
      WHERE id = $13 AND company_id = $14
      RETURNING *
    `, [code, name, name_en, vat_number, cr_number, phone, email,
        address, city, payment_terms, is_active,
        balanceParam,
        req.params.id, req.user.company_id]);

    if (!rows[0]) return res.status(404).json({ success: false, message: 'المورد غير موجود' });
    res.json({ success: true, data: rows[0] });

    if (balanceParam != null) {
      logAudit({
        companyId: req.user.company_id, userId: req.user.sub, action: 'supplier_balance_write',
        entityType: 'supplier', entityId: rows[0].id, ip: req.ip,
        oldValues: { balance: oldSup?.balance }, newValues: { balance: rows[0].balance },
        details: `تصحيح رصيد افتتاحي للمورد ${rows[0].name}: من ${oldSup?.balance} إلى ${rows[0].balance}`
      });
    }
  } catch (err) { next(err); }
};

exports.remove = async (req, res, next) => {
  try {
    const { rows: [sup] } = await db.query(
      `UPDATE suppliers SET is_active = false WHERE id = $1 AND company_id = $2 RETURNING name`,
      [req.params.id, req.user.company_id]
    );
    res.json({ success: true });

    if (sup) {
      logAudit({
        companyId: req.user.company_id, userId: req.user.sub, action: 'supplier_deactivate',
        entityType: 'supplier', entityId: req.params.id, ip: req.ip,
        details: `تعطيل مورد: ${sup.name}`
      });
    }
  } catch (err) { next(err); }
};

exports.statement = async (req, res, next) => {
  try {
    const { from, to } = req.query;
    let dateFilter = '';
    const params   = [req.params.id, req.user.company_id];
    let idx = 3;

    if (from) { dateFilter += ` AND date >= $${idx++}`; params.push(from); }
    if (to)   { dateFilter += ` AND date <= $${idx++}`; params.push(to); }

    const { rows: purchases } = await db.query(`
      SELECT purchase_no AS ref, date, 'فاتورة مشتريات' AS type,
             0 AS debit, total AS credit
      FROM purchases
      WHERE supplier_id = $1 AND company_id = $2 ${dateFilter}
    `, params);

    const { rows: payments } = await db.query(`
      SELECT voucher_no AS ref, date, 'سند صرف' AS type,
             amount AS debit, 0 AS credit
      FROM vouchers
      WHERE party_id = $1 AND party_type = 'supplier'
        AND company_id = $2 AND type = 'payment' ${dateFilter}
    `, params);

    const supplier = (await db.query(
      `SELECT name, phone, vat_number, balance FROM suppliers WHERE id = $1 AND company_id = $2`,
      [req.params.id, req.user.company_id]
    )).rows[0];

    const transactions = [...purchases, ...payments]
      .sort((a, b) => new Date(a.date) - new Date(b.date));

    let running = 0;
    const withBalance = transactions.map(t => {
      running += (t.credit - t.debit);
      return { ...t, running_balance: running };
    });

    res.json({ success: true, supplier, data: withBalance });
  } catch (err) { next(err); }
};
