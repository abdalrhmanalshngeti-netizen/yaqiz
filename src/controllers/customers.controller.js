const db = require('../config/db');

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
      `SELECT * FROM customers WHERE ${where.join(' AND ')} ORDER BY name`,
      params
    );
    res.json({ success: true, data: rows });
  } catch (err) { next(err); }
};

exports.getOne = async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT * FROM customers WHERE id = $1 AND company_id = $2`,
      [req.params.id, req.user.company_id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'العميل غير موجود' });
    res.json({ success: true, data: rows[0] });
  } catch (err) { next(err); }
};

exports.create = async (req, res, next) => {
  try {
    const { code, name, name_en, vat_number, cr_number, phone,
            email, address, city, credit_limit, payment_terms, balance,
            street_name, building_number, district, postal_code, country_code } = req.body;

    if (!name) return res.status(400).json({ success: false, message: 'اسم العميل مطلوب' });

    const { rows } = await db.query(`
      INSERT INTO customers
        (company_id, code, name, name_en, vat_number, cr_number,
         phone, email, address, city, credit_limit, payment_terms, balance,
         street_name, building_number, district, postal_code, country_code)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
      RETURNING *
    `, [req.user.company_id, code, name, name_en, vat_number, cr_number,
        phone, email, address, city, credit_limit || 0, payment_terms || 30, parseFloat(balance) || 0,
        street_name || null, building_number || null, district || null, postal_code || null, country_code || 'SA']);

    res.status(201).json({ success: true, data: rows[0] });
  } catch (err) { next(err); }
};

exports.update = async (req, res, next) => {
  try {
    const { code, name, name_en, vat_number, cr_number, phone,
            email, address, city, credit_limit, payment_terms, is_active, balance,
            street_name, building_number, district, postal_code, country_code } = req.body;

    const { rows } = await db.query(`
      UPDATE customers SET
        code             = COALESCE($1,  code),
        name             = COALESCE($2,  name),
        name_en          = COALESCE($3,  name_en),
        vat_number       = COALESCE($4,  vat_number),
        cr_number        = COALESCE($5,  cr_number),
        phone            = COALESCE($6,  phone),
        email            = COALESCE($7,  email),
        address          = COALESCE($8,  address),
        city             = COALESCE($9,  city),
        credit_limit     = COALESCE($10, credit_limit),
        payment_terms    = COALESCE($11, payment_terms),
        is_active        = COALESCE($12, is_active),
        balance          = CASE WHEN $13::numeric IS NOT NULL THEN $13::numeric ELSE balance END,
        street_name      = COALESCE($16, street_name),
        building_number  = COALESCE($17, building_number),
        district         = COALESCE($18, district),
        postal_code      = COALESCE($19, postal_code),
        country_code     = COALESCE($20, country_code)
      WHERE id = $14 AND company_id = $15
      RETURNING *
    `, [code, name, name_en, vat_number, cr_number, phone, email,
        address, city, credit_limit, payment_terms, is_active,
        balance != null ? parseFloat(balance) : null,
        req.params.id, req.user.company_id,
        street_name || null, building_number || null, district || null, postal_code || null, country_code || null]);

    if (!rows[0]) return res.status(404).json({ success: false, message: 'العميل غير موجود' });
    res.json({ success: true, data: rows[0] });
  } catch (err) { next(err); }
};

exports.remove = async (req, res, next) => {
  try {
    await db.query(
      `UPDATE customers SET is_active = false WHERE id = $1 AND company_id = $2`,
      [req.params.id, req.user.company_id]
    );
    res.json({ success: true });
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

    // الفواتير
    const { rows: invoices } = await db.query(`
      SELECT invoice_no AS ref, date, 'فاتورة مبيعات' AS type,
             grand_total AS debit, 0 AS credit, status
      FROM invoices
      WHERE customer_id = $1 AND company_id = $2 ${dateFilter}
    `, params);

    // المدفوعات (سندات قبض)
    const { rows: payments } = await db.query(`
      SELECT voucher_no AS ref, date, 'سند قبض' AS type,
             0 AS debit, amount AS credit, 'paid' AS status
      FROM vouchers
      WHERE party_id = $1 AND party_type = 'customer'
        AND company_id = $2 AND type = 'receipt' ${dateFilter}
    `, params);

    const customer = (await db.query(
      `SELECT name, phone, vat_number, balance FROM customers WHERE id = $1 AND company_id = $2`,
      [req.params.id, req.user.company_id]
    )).rows[0];

    const transactions = [...invoices, ...payments]
      .sort((a, b) => new Date(a.date) - new Date(b.date));

    let running = 0;
    const withBalance = transactions.map(t => {
      running += (t.debit - t.credit);
      return { ...t, running_balance: running };
    });

    res.json({ success: true, customer, data: withBalance });
  } catch (err) { next(err); }
};
