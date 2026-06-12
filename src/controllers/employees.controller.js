const db = require('../config/db');

// حقول قائمة الموظفين — تُستثنى national_id وiqama_no وiban من قائمة الكل
const LIST_FIELDS = `id, company_id, employee_no, name, position, department,
  phone, email, salary, allowances, start_date, end_date, status, created_at`;

// ── EMPLOYEES ─────────────────────────────────────────────────

exports.list = async (req, res, next) => {
  try {
    const { status = 'active' } = req.query;
    let where  = [`company_id = $1`];
    let params = [req.user.company_id];
    if (status !== 'all') { where.push(`status = $2`); params.push(status); }
    const { rows } = await db.query(
      `SELECT ${LIST_FIELDS} FROM employees WHERE ${where.join(' AND ')} ORDER BY name`,
      params
    );
    res.json({ success: true, data: rows });
  } catch (err) { next(err); }
};

exports.getOne = async (req, res, next) => {
  try {
    const { rows: [e] } = await db.query(
      `SELECT id, company_id, employee_no, name, position, department, national_id, iqama_no,
              phone, email, salary, allowances, start_date, end_date, bank_name, iban, status, created_at
       FROM employees WHERE id = $1 AND company_id = $2`,
      [req.params.id, req.user.company_id]
    );
    if (!e) return res.status(404).json({ success: false, message: 'الموظف غير موجود' });
    res.json({ success: true, data: e });
  } catch (err) { next(err); }
};

exports.create = async (req, res, next) => {
  try {
    const { employee_no, name, position, department, national_id, iqama_no,
            phone, email, salary, allowances, start_date, bank_name, iban } = req.body;
    if (!name) return res.status(400).json({ success: false, message: 'اسم الموظف مطلوب' });

    const { rows } = await db.query(`
      INSERT INTO employees
        (company_id, employee_no, name, position, department, national_id, iqama_no,
         phone, email, salary, allowances, start_date, bank_name, iban)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      RETURNING id, company_id, employee_no, name, position, department,
        phone, email, salary, allowances, start_date, end_date, status, created_at
    `, [req.user.company_id, employee_no, name, position, department,
        national_id, iqama_no, phone, email,
        salary || 0, allowances || 0, start_date, bank_name, iban]);

    res.status(201).json({ success: true, data: rows[0] });
  } catch (err) { next(err); }
};

exports.update = async (req, res, next) => {
  try {
    const { name, position, department, phone, email,
            salary, allowances, status, bank_name, iban, end_date } = req.body;
    const { rows } = await db.query(`
      UPDATE employees SET
        name        = COALESCE($1,  name),
        position    = COALESCE($2,  position),
        department  = COALESCE($3,  department),
        phone       = COALESCE($4,  phone),
        email       = COALESCE($5,  email),
        salary      = COALESCE($6,  salary),
        allowances  = COALESCE($7,  allowances),
        status      = COALESCE($8,  status),
        bank_name   = COALESCE($9,  bank_name),
        iban        = COALESCE($10, iban),
        end_date    = COALESCE($11, end_date)
      WHERE id = $12 AND company_id = $13
      RETURNING *
    `, [name, position, department, phone, email, salary, allowances,
        status, bank_name, iban, end_date, req.params.id, req.user.company_id]);

    if (!rows[0]) return res.status(404).json({ success: false, message: 'الموظف غير موجود' });
    res.json({ success: true, data: rows[0] });
  } catch (err) { next(err); }
};

exports.remove = async (req, res, next) => {
  try {
    await db.query(
      `UPDATE employees SET status = 'terminated', end_date = CURRENT_DATE WHERE id = $1 AND company_id = $2`,
      [req.params.id, req.user.company_id]
    );
    res.json({ success: true });
  } catch (err) { next(err); }
};

// ── PAYROLL ───────────────────────────────────────────────────

exports.listPayroll = async (req, res, next) => {
  try {
    const { month, year } = req.query;
    let where  = [`p.company_id = $1`];
    let params = [req.user.company_id];
    let idx    = 2;

    if (month) { where.push(`p.period_month = $${idx++}`); params.push(month); }
    if (year)  { where.push(`p.period_year = $${idx++}`);  params.push(year); }

    const { rows } = await db.query(`
      SELECT p.*, e.name AS employee_name, e.position, e.iban
      FROM payroll p
      JOIN employees e ON e.id = p.employee_id
      WHERE ${where.join(' AND ')}
      ORDER BY p.period_year DESC, p.period_month DESC, e.name
    `, params);

    res.json({ success: true, data: rows });
  } catch (err) { next(err); }
};

exports.generatePayroll = async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const { month, year, overrides = [] } = req.body;
    if (!month || !year) {
      return res.status(400).json({ success: false, message: 'الشهر والسنة مطلوبان' });
    }

    // حذف كشف الراتب المؤقت لنفس الشهر
    await client.query(`
      DELETE FROM payroll WHERE company_id=$1 AND period_month=$2 AND period_year=$3 AND status='draft'
    `, [req.user.company_id, month, year]);

    const { rows: employees } = await client.query(
      `SELECT * FROM employees WHERE company_id = $1 AND status = 'active'`,
      [req.user.company_id]
    );

    const { rows: [seq] } = await client.query(`SELECT NEXTVAL('payroll_seq') AS n`);
    const payroll_prefix = `PAY-${year}${String(month).padStart(2,'0')}`;
    const seqBase = Number(seq.n);

    const created = [];
    for (let i = 0; i < employees.length; i++) {
      const emp = employees[i];
      const override = overrides.find(o => o.employee_id === emp.id) || {};
      const overtime   = parseFloat(override.overtime   || 0);
      const deductions = parseFloat(override.deductions || 0);
      const gosi_emp   = parseFloat(emp.salary) * 0.1;
      const gosi_er    = parseFloat(emp.salary) * 0.12;
      const net        = parseFloat(emp.salary) + parseFloat(emp.allowances) + overtime - deductions - gosi_emp;

      const { rows: [p] } = await client.query(`
        INSERT INTO payroll
          (company_id, payroll_no, period_month, period_year, employee_id,
           basic_salary, allowances, overtime, deductions,
           gosi_employee, gosi_employer, net_salary, status, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'draft',$13)
        RETURNING *
      `, [req.user.company_id, `${payroll_prefix}-${String(seqBase + i).padStart(6,'0')}`,
          month, year, emp.id,
          emp.salary, emp.allowances, overtime, deductions,
          gosi_emp, gosi_er, net, req.user.sub]);
      created.push(p);
    }

    await client.query('COMMIT');
    res.status(201).json({ success: true, data: created });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
};

exports.markPayrollPaid = async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const { account_id, payment_date } = req.body;
    const { rows: [p] } = await client.query(
      `SELECT * FROM payroll WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [req.params.id, req.user.company_id]
    );
    if (!p) return res.status(404).json({ success: false, message: 'كشف الراتب غير موجود' });
    if (p.status === 'paid') return res.status(400).json({ success: false, message: 'تم الدفع بالفعل' });

    await client.query(`
      UPDATE payroll SET status='paid', payment_date=$1, account_id=$2 WHERE id=$3
    `, [payment_date || new Date().toISOString().slice(0,10), account_id, p.id]);

    if (account_id) {
      const { rows: [acct] } = await client.query(
        `SELECT balance FROM treasury_accounts WHERE id = $1 FOR UPDATE`, [account_id]
      );
      const newBal = parseFloat(acct.balance) - parseFloat(p.net_salary);
      await client.query(`UPDATE treasury_accounts SET balance = $1 WHERE id = $2`, [newBal, account_id]);
      await client.query(`
        INSERT INTO treasury_moves
          (company_id, account_id, type, amount, balance_before, balance_after, description, created_by)
        VALUES ($1,$2,'out',$3,$4,$5,$6,$7)
      `, [req.user.company_id, account_id, p.net_salary, acct.balance, newBal,
          `راتب ${p.period_month}/${p.period_year} — ${p.payroll_no}`, req.user.sub]);
    }

    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
};

// ── SHIFTS ────────────────────────────────────────────────────

exports.listShifts = async (req, res, next) => {
  try {
    const { from, to } = req.query;
    let where  = [`s.company_id = $1`];
    let params = [req.user.company_id];
    let idx    = 2;
    if (from) { where.push(`s.start_time >= $${idx++}`); params.push(from); }
    if (to)   { where.push(`s.start_time <= $${idx++}`); params.push(to); }

    const { rows } = await db.query(`
      SELECT s.*, u.full_name FROM shifts s
      JOIN users u ON u.id = s.user_id
      WHERE ${where.join(' AND ')}
      ORDER BY s.start_time DESC
    `, params);
    res.json({ success: true, data: rows });
  } catch (err) { next(err); }
};

exports.openShift = async (req, res, next) => {
  try {
    const { opening_cash } = req.body;
    const { rows: [existing] } = await db.query(
      `SELECT id FROM shifts WHERE user_id = $1 AND status = 'open'`,
      [req.user.sub]
    );
    if (existing) return res.status(400).json({ success: false, message: 'لديك وردية مفتوحة بالفعل' });

    const { rows } = await db.query(`
      INSERT INTO shifts (company_id, user_id, opening_cash)
      VALUES ($1,$2,$3) RETURNING *
    `, [req.user.company_id, req.user.sub, opening_cash || 0]);

    res.status(201).json({ success: true, data: rows[0] });
  } catch (err) { next(err); }
};

exports.closeShift = async (req, res, next) => {
  try {
    const { closing_cash } = req.body;
    const { rows: [shift] } = await db.query(
      `SELECT * FROM shifts WHERE id = $1 AND company_id = $2 AND status = 'open'`,
      [req.params.id, req.user.company_id]
    );
    if (!shift) return res.status(404).json({ success: false, message: 'الوردية غير موجودة أو مغلقة' });

    // جمع مبيعات الوردية
    const { rows: [sales] } = await db.query(`
      SELECT
        COALESCE(SUM(CASE WHEN payment_method='cash'     THEN grand_total ELSE 0 END),0) AS cash,
        COALESCE(SUM(CASE WHEN payment_method='card'     THEN grand_total ELSE 0 END),0) AS card,
        COALESCE(SUM(CASE WHEN payment_method='transfer' THEN grand_total ELSE 0 END),0) AS transfer,
        COALESCE(SUM(CASE WHEN payment_method='credit'   THEN grand_total ELSE 0 END),0) AS credit,
        COUNT(*) AS cnt
      FROM invoices
      WHERE created_by = $1 AND created_at >= $2 AND company_id = $3
    `, [shift.user_id, shift.start_time, req.user.company_id]);

    await db.query(`
      UPDATE shifts SET
        status = 'closed', end_time = NOW(), closing_cash = $1,
        sales_cash = $2, sales_card = $3, sales_transfer = $4,
        sales_credit = $5, invoices_count = $6
      WHERE id = $7
    `, [closing_cash || 0,
        sales.cash, sales.card, sales.transfer, sales.credit, sales.cnt,
        shift.id]);

    res.json({ success: true });
  } catch (err) { next(err); }
};
