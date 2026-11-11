const db     = require('../config/db');
const stock  = require('../services/stock.service');
const branch = require('../services/branch.service');
const { nextDocNumber } = require('../services/docNumber.service');
const periodClose = require('../services/periodClose.service');
const { todayLocalDateStr } = require('../utils/date.util');
const logAudit = require('../middleware/logger');

exports.list = async (req, res, next) => {
  try {
    const { status, supplier_id, from, to, page = 1, limit = 50 } = req.query;
    const offset = (page - 1) * limit;
    let where  = [`p.company_id = $1`];
    let params = [req.user.company_id];
    let idx    = 2;

    if (status)      { where.push(`p.status = $${idx++}`);       params.push(status); }
    if (supplier_id) { where.push(`p.supplier_id = $${idx++}`);  params.push(supplier_id); }
    if (from)        { where.push(`p.date >= $${idx++}`);         params.push(from); }
    if (to)          { where.push(`p.date <= $${idx++}`);         params.push(to); }

    const { rows } = await db.query(`
      SELECT p.*, s.name AS supplier_name_db,
        COALESCE(
          (SELECT json_agg(json_build_object('name', pi.product_name, 'qty', pi.qty::float, 'price', pi.unit_price::float, 'line_total', pi.line_total::float, 'product_id', pi.product_id) ORDER BY pi.sort_order)
           FROM purchase_items pi WHERE pi.purchase_id = p.id),
          '[]'::json
        ) AS items_json,
        COUNT(*) OVER() AS total_count
      FROM purchases p
      LEFT JOIN suppliers s ON s.id = p.supplier_id
      WHERE ${where.join(' AND ')}
      ORDER BY p.created_at DESC
      LIMIT $${idx++} OFFSET $${idx}
    `, [...params, limit, offset]);

    res.json({
      success: true,
      data: rows,
      total: parseInt(rows[0]?.total_count || 0),
      page: parseInt(page)
    });
  } catch (err) { next(err); }
};

exports.getOne = async (req, res, next) => {
  try {
    const { rows: [purchase] } = await db.query(
      `SELECT p.*, s.name AS supplier_name_db
       FROM purchases p LEFT JOIN suppliers s ON s.id = p.supplier_id
       WHERE p.id = $1 AND p.company_id = $2`,
      [req.params.id, req.user.company_id]
    );
    if (!purchase) return res.status(404).json({ success: false, message: 'المشتريات غير موجودة' });
    const { rows: items } = await db.query(
      `SELECT product_name AS name, qty::float, unit_price::float AS price, line_total::float FROM purchase_items WHERE purchase_id = $1 ORDER BY sort_order`,
      [req.params.id]
    );
    res.json({ success: true, data: { ...purchase, items_json: items } });
  } catch (err) { next(err); }
};

exports.create = async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const { company_id, sub: user_id } = req.user;
    const {
      supplier_id, supplier_name, supplier_ref,
      purchase_type, category, description,
      date, amount, vat_amount, payment_method,
      deductible, notes,
      items = [], client_local_id
    } = req.body;

    if (!amount && !items.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'المبلغ أو البنود مطلوبة' });
    }

    // إعادة إرسال نفس الطلب (استجابة سابقة ضاعت بالشبكة) لا يجب أن تُنشئ فاتورة
    // شراء مكرَّرة (وتخصم المخزون مرتين) — نتعرّف على المحاولة السابقة عبر
    // المعرّف المحلي بالمتصفح
    if (client_local_id) {
      const { rows: [existing] } = await client.query(
        `SELECT * FROM purchases WHERE company_id = $1 AND client_local_id = $2`,
        [company_id, client_local_id]
      );
      if (existing) { await client.query('COMMIT'); return res.status(201).json({ success: true, data: existing }); }
    }

    const periodCheck = await periodClose.assertPeriodNotClosed(
      client, company_id, date || todayLocalDateStr(), req.headers['x-period-override-token']
    );
    if (periodCheck.blocked) {
      await client.query('ROLLBACK');
      return res.status(periodCheck.status).json({ success: false, code: periodCheck.code, message: periodCheck.message });
    }

    // يُحل دائمًا (حتى لمشتريات opex بلا بنود) عشان تُنسب فاتورة المشتريات
    // لفرع معيّن بالتقارير — لكن المستودع المُستخرَج منه لا يُستخدم إلا لو
    // كانت مشتريات بضاعة فعلية (أدناه). هذا المسار يستدعي resolveWarehouseForBranch
    // مباشرة (لا resolveWarehouseForUser) فكان يقبل أي branch_id من أي مستخدم
    // بلا أي تحقق صلاحية إطلاقًا — نتحقق صراحة هنا قبل الحل
    let resolvedBranchId, resolvedWarehouseId;
    try {
      await branch.assertBranchAuthorized(client, company_id, req.user.sub, req.user.role, req.body.branch_id);
      ({ branch_id: resolvedBranchId, warehouse_id: resolvedWarehouseId } =
        await branch.resolveWarehouseForBranch(client, company_id, req.body.branch_id));
    } catch (branchErr) {
      await client.query('ROLLBACK');
      // هذا المسار يصل غالبًا من مزامنة خلفية لا انتظار فوري لرد المستخدم
      // (المشتريات محفوظة محليًا مسبقًا) — لازم صاحب الشركة يُبلَّغ صراحة،
      // راجع تعليق notifyBranchAuthFailure لتفصيل السبب
      await branch.notifyBranchAuthFailure(company_id, user_id, 'مشترى', branchErr.message).catch(() => {});
      return res.status(branchErr.status || 400).json({ success: false, message: branchErr.message });
    }

    if (supplier_id) {
      const { rows: [supRow] } = await client.query(
        `SELECT id FROM suppliers WHERE id = $1 AND company_id = $2`,
        [supplier_id, company_id]
      );
      if (!supRow) { await client.query('ROLLBACK'); return res.status(404).json({ success: false, message: 'المورد غير موجود' }); }
    }

    // الشركة غير المسجّلة ضريبيًا (vat_enabled=false) كانت تعتمد كليًا على
    // العميل لإرسال vat_amount=0 — لا فحص سيرفري، بعكس invoices.controller.js/
    // quotes.controller.js المُصلَحتين لهذا بالضبط. عميل قديم مخزَّن محليًا (كاش)
    // أو مسار مزامنة لم يُحدَّث يقدر يرسل ضريبة رغم تعطيلها لاحقًا بإعدادات الشركة
    const { rows: [vatSetting] } = await client.query(
      `SELECT value FROM settings WHERE company_id = $1 AND key = 'vat_enabled'`,
      [company_id]
    );
    let companyVatEnabled = true;
    try { companyVatEnabled = vatSetting ? JSON.parse(vatSetting.value) !== false : true; } catch { companyVatEnabled = true; }

    const baseAmount = parseFloat(amount || 0);
    const vatAmount  = companyVatEnabled ? parseFloat(vat_amount ?? baseAmount * 0.15) : 0;
    const total      = baseAmount + vatAmount;

    const CASH_METHODS = ['cash', 'نقدي', 'شبكة', 'bank', 'بنك', 'تحويل', 'بطاقة', 'network', 'card'];
    const isPaid      = CASH_METHODS.includes(payment_method);
    const remaining   = isPaid ? 0 : total;
    const purchStatus = isPaid ? 'paid' : 'unpaid';

    const purSeqN = await nextDocNumber(client, company_id, 'purchase');
    const purchase_no = `PUR-${String(purSeqN).padStart(6, '0')}`;

    const { rows: [purchase] } = await client.query(`
      INSERT INTO purchases
        (company_id, purchase_no, supplier_id, supplier_name, supplier_ref,
         purchase_type, category, description, date, amount, vat_amount, total,
         remaining, payment_method, status, deductible, notes, created_by, branch_id, client_local_id, paid_amount)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
      RETURNING *
    `, [company_id, purchase_no, supplier_id, supplier_name, supplier_ref,
        purchase_type || 'goods', category, description, date,
        baseAmount, vatAmount, total,
        remaining, payment_method, purchStatus, deductible !== false, notes, user_id, resolvedBranchId, client_local_id || null,
        // المدفوعة نقدًا كانت تُحفظ بمدفوع = 0 — فتظهر بالجهاز بعد المزامنة كأنها غير مسددة
        isPaid ? total : 0]);

    // إضافة المخزون لو كانت مشتريات بضاعة مع بنود
    if (purchase_type !== 'opex' && items.length) {
      for (const item of items) {
        if (!item.product_id) continue;
        try {
          await client.query('SAVEPOINT sp_stock_add');
          await stock.add(client, {
            company_id, product_id: item.product_id, warehouse_id: resolvedWarehouseId, qty: item.qty,
            unit_cost: item.unit_cost || item.unit_price,
            reason: 'شراء', source: supplier_name,
            source_type: 'purchase', source_id: purchase.id,
            reference: purchase_no, user_id
          });
          if (item.unit_cost) {
            const newBuyPrice = parseFloat(item.unit_cost);

            // جلب بيانات المنتج للتحقق من سياسة التسعير
            const { rows: [prod] } = await client.query(
              `SELECT id, name, buy_price, sell_price, tax_rate,
                      profit_policy_type, profit_policy_value, auto_price_update
               FROM products WHERE id = $1 AND company_id = $2`,
              [item.product_id, company_id]
            );

            if (prod) {
              const oldBuyPrice  = parseFloat(prod.buy_price)  || 0;
              const oldSellPrice = parseFloat(prod.sell_price) || 0;

              await client.query(
                `UPDATE products SET buy_price = $1, updated_at = NOW() WHERE id = $2`,
                [newBuyPrice, prod.id]
              );

              // تطبيق التسعير الديناميكي إذا كان مفعّلاً
              if (prod.auto_price_update && prod.profit_policy_type === 'percentage_on_cost') {
                const policyValue  = parseFloat(prod.profit_policy_value) || 0;
                // سعر البيع = تكلفة الشراء × (1 + نسبة الربح%)  — قبل الضريبة
                const newSellPrice = Math.round(newBuyPrice * (1 + policyValue / 100) * 100) / 100;

                if (Math.abs(newSellPrice - oldSellPrice) >= 0.01) {
                  await client.query(
                    `UPDATE products SET sell_price = $1, updated_at = NOW() WHERE id = $2`,
                    [newSellPrice, prod.id]
                  );

                  // تسجيل في سجل التغييرات
                  await client.query(`
                    INSERT INTO product_price_history
                      (company_id, product_id, old_buy_price, new_buy_price,
                       old_sell_price, new_sell_price, policy_type, policy_value,
                       purchase_id, changed_by, reason)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'auto_pricing')
                  `, [company_id, prod.id, oldBuyPrice, newBuyPrice,
                      oldSellPrice, newSellPrice,
                      prod.profit_policy_type, prod.profit_policy_value,
                      purchase.id, user_id]);

                  // إرسال إشعار للمالك وأصحاب صلاحية التسعير
                  const taxRate  = parseFloat(prod.tax_rate) || 15;
                  const withVat  = Math.round(newSellPrice * (1 + taxRate / 100) * 100) / 100;
                  const msg = `تم تحديث سعر بيع "${prod.name}" تلقائياً من ${oldSellPrice} إلى ${newSellPrice} ر.س (شامل ضريبة: ${withVat} ر.س) بناءً على فاتورة شراء ${purchase_no}`;

                  const { rows: notifUsers } = await client.query(`
                    SELECT id FROM users
                    WHERE company_id = $1 AND active = true
                      AND (role = 'owner' OR 'pricing.manage' = ANY(permissions))
                  `, [company_id]);

                  for (const nu of notifUsers) {
                    await client.query(`
                      INSERT INTO notifications (company_id, user_id, type, title, message, link)
                      VALUES ($1,$2,'price_update','تحديث سعر تلقائي',$3,'/VVIP.html#inventory')
                    `, [company_id, nu.id, msg]);
                  }
                }
              }
            }
          }
          await client.query('RELEASE SAVEPOINT sp_stock_add');
        } catch (stockErr) {
          await client.query('ROLLBACK TO sp_stock_add');
          console.warn(`stock add skipped [${purchase_no}] product ${item.product_id}:`, stockErr.message);
        }
      }
    }

    // حفظ بنود الشراء في purchase_items
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const itemName  = item.name || item.product_name || '';
      const itemQty   = parseFloat(item.qty) || 1;
      const itemPrice = parseFloat(item.unit_cost || item.unit_price || 0);
      if (!itemName && !item.product_id) continue;
      try {
        await client.query('SAVEPOINT sp_pitem');
        await client.query(`
          INSERT INTO purchase_items (purchase_id, product_id, product_name, qty, unit_price, line_total, sort_order)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [purchase.id, item.product_id || null, itemName, itemQty, itemPrice, itemQty * itemPrice, i]);
        await client.query('RELEASE SAVEPOINT sp_pitem');
      } catch (itemErr) {
        await client.query('ROLLBACK TO sp_pitem');
        console.warn(`purchase_item insert skipped [${purchase_no}]:`, itemErr.message);
      }
    }

    // تحديث رصيد المورد (فقط للمشتريات الآجلة)
    if (supplier_id && !isPaid) {
      await client.query(
        `UPDATE suppliers SET balance = balance + $1 WHERE id = $2`,
        [total, supplier_id]
      );
    }

    await client.query('COMMIT');
    res.status(201).json({ success: true, data: purchase });

    logAudit({
      companyId: company_id, userId: user_id, action: 'purchase_create',
      entityType: 'purchase', entityId: purchase.id, ip: req.ip,
      newValues: { purchase_no: purchase.purchase_no, total, supplier_id, status: purchStatus },
      details: `فاتورة شراء جديدة: ${purchase.purchase_no} — ${Number(total).toFixed(2)} ر.س`
    });

  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
};

exports.update = async (req, res, next) => {
  try {
    const { notes, category, description } = req.body;
    const { rows: [updated] } = await db.query(`
      UPDATE purchases SET
        notes       = COALESCE($1, notes),
        category    = COALESCE($2, category),
        description = COALESCE($3, description)
      WHERE id = $4 AND company_id = $5
      RETURNING *
    `, [notes, category, description, req.params.id, req.user.company_id]);

    if (!updated) return res.status(404).json({ success: false, message: 'المشتريات غير موجودة' });
    res.json({ success: true, data: updated });
  } catch (err) { next(err); }
};

exports.addPayment = async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const { amount, account_id } = req.body;
    const { rows: [pur] } = await client.query(
      `SELECT * FROM purchases WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [req.params.id, req.user.company_id]
    );
    if (!pur) { await client.query('ROLLBACK'); return res.status(404).json({ success: false, message: 'المشتريات غير موجودة' }); }

    const paying    = Math.min(parseFloat(amount), parseFloat(pur.remaining));
    const newPaid   = parseFloat(pur.paid_amount) + paying;
    // من المتبقي الحالي (لا الإجمالي − المدفوع) — يحفظ أي تسوية بمرتجع آجل
    const newRem    = Math.round((parseFloat(pur.remaining) - paying) * 100) / 100;
    const newStatus = newRem <= 0 ? 'paid' : 'partial';

    await client.query(`
      UPDATE purchases SET paid_amount=$1, remaining=$2, status=$3 WHERE id=$4
    `, [newPaid, newRem, newStatus, pur.id]);

    if (pur.supplier_id) {
      await client.query(`UPDATE suppliers SET balance = balance - $1 WHERE id = $2`, [paying, pur.supplier_id]);
    }

    if (account_id) {
      const { rows: [acct] } = await client.query(
        `SELECT balance, branch_id FROM treasury_accounts WHERE id = $1 AND company_id = $2 FOR UPDATE`,
        [account_id, req.user.company_id]
      );
      if (!acct) { await client.query('ROLLBACK'); return res.status(404).json({ success: false, message: 'حساب الخزينة غير موجود' }); }
      // حساب مخصَّص لفرع آخر غير فرع فاتورة الشراء هذي — رفض بدل سداد من
      // صندوق فرع لا يخصها (حساب مشترك بلا فرع مسموح دائمًا)
      if (acct.branch_id && pur.branch_id && acct.branch_id !== pur.branch_id) {
        await client.query('ROLLBACK');
        return res.status(400).json({ success: false, message: 'حساب الخزينة المُحدَّد يخص فرعًا آخر غير فرع فاتورة الشراء' });
      }
      const newBal = parseFloat(acct.balance) - paying;
      await client.query(`UPDATE treasury_accounts SET balance = $1 WHERE id = $2`, [newBal, account_id]);
      await client.query(`
        INSERT INTO treasury_moves
          (company_id, account_id, type, amount, balance_before, balance_after,
           description, source_type, source_id, created_by)
        VALUES ($1,$2,'out',$3,$4,$5,$6,'purchase',$7,$8)
      `, [req.user.company_id, account_id, paying, acct.balance, newBal,
          `سداد مشتريات ${pur.purchase_no}`, pur.id, req.user.sub]);
    }

    await client.query('COMMIT');
    res.json({ success: true, paid: paying, remaining: newRem, status: newStatus });

    logAudit({
      companyId: req.user.company_id, userId: req.user.sub, action: 'purchase_payment',
      entityType: 'purchase', entityId: pur.id, ip: req.ip,
      oldValues: { paid_amount: pur.paid_amount, status: pur.status },
      newValues: { paid_amount: newPaid, status: newStatus },
      details: `سداد ${paying.toFixed(2)} ر.س على فاتورة شراء ${pur.purchase_no}`
    });

  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
};

// عكس دفعة على فاتورة شراء (حذف سند صرف مطبَّق عليها) — نفس فجوة الفواتير
exports.reversePayment = async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const amount = parseFloat(req.body.amount);
    if (!amount || amount <= 0) { await client.query('ROLLBACK'); return res.status(400).json({ success: false, message: 'المبلغ غير صحيح' }); }
    const { rows: [pur] } = await client.query(
      `SELECT * FROM purchases WHERE id = $1 AND company_id = $2 FOR UPDATE`, [req.params.id, req.user.company_id]);
    if (!pur) { await client.query('ROLLBACK'); return res.status(404).json({ success: false, message: 'المشتريات غير موجودة' }); }
    const rev = Math.min(amount, parseFloat(pur.paid_amount));
    const newPaid = Math.round((parseFloat(pur.paid_amount) - rev) * 100) / 100;
    const newRem = Math.round((parseFloat(pur.remaining) + rev) * 100) / 100;
    const newStatus = newRem <= 0.005 ? 'paid' : (newPaid > 0 ? 'partial' : 'unpaid');
    await client.query(`UPDATE purchases SET paid_amount = $1, remaining = $2, status = $3 WHERE id = $4`, [newPaid, newRem, newStatus, pur.id]);
    if (pur.supplier_id && rev > 0) await client.query(`UPDATE suppliers SET balance = balance + $1 WHERE id = $2`, [rev, pur.supplier_id]);
    await client.query('COMMIT');
    res.json({ success: true, data: { paid_amount: newPaid, remaining: newRem, status: newStatus } });
  } catch (err) { await client.query('ROLLBACK'); next(err); } finally { client.release(); }
};

// تصحيح فاتورة شراء/مصروف مسجّلة بالغلط — بقيد عكسي، لا حذف ولا تعديل (الأصل يبقى
// بحالة reversed). السيرفر مسؤول عن الشق اللي يملكه هو: المخزون (طبقة هذي الفاتورة
// بالذات)، رصيد المورد، وحالة الفاتورة. القيد العكسي وحركة الخزينة يُنشآن بالجهاز
// ويتزامنان مثل أي قيد/حركة، ويُحسبان من الأصناف اللي يرجّعها هذا الطلب.
// بضاعة انباع منها شي → رفض: التصحيح وقتها مرتجع مشتريات بالكمية الباقية
exports.reverse = async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const { company_id, sub: user_id } = req.user;
    const reason = String(req.body.reason || '').trim().slice(0, 500);
    if (!reason) { await client.query('ROLLBACK'); return res.status(400).json({ success: false, message: 'سبب التصحيح مطلوب' }); }

    const { rows: [pur] } = await client.query(
      `SELECT * FROM purchases WHERE id = $1 AND company_id = $2 FOR UPDATE`, [req.params.id, company_id]);
    if (!pur) { await client.query('ROLLBACK'); return res.status(404).json({ success: false, message: 'الفاتورة غير موجودة' }); }
    if (pur.status === 'reversed') { await client.query('ROLLBACK'); return res.status(409).json({ success: false, code: 'ALREADY', message: 'الفاتورة معكوسة مسبقًا' }); }
    if (pur.status === 'cancelled') { await client.query('ROLLBACK'); return res.status(400).json({ success: false, message: 'الفاتورة ملغاة' }); }

    // القيد العكسي بتاريخ اليوم — فالفترة المعنية هي فترة اليوم لا فترة الأصل
    const periodCheck = await periodClose.assertPeriodNotClosed(
      client, company_id, todayLocalDateStr(), req.headers['x-period-override-token']);
    if (periodCheck.blocked) {
      await client.query('ROLLBACK');
      return res.status(periodCheck.status).json({ success: false, code: periodCheck.code, message: periodCheck.message });
    }

    const { rows: [ret] } = await client.query(
      `SELECT 1 FROM returns WHERE company_id = $1 AND linked_purchase_id = $2 LIMIT 1`, [company_id, pur.id]);
    if (ret) {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, code: 'HAS_RETURNS', message: 'على هذي الفاتورة مرتجع مسجّل — صحّح الفرق بمرتجع مشتريات بدل عكس الفاتورة كاملة' });
    }
    const { rows: [vch] } = await client.query(
      `SELECT 1 FROM vouchers WHERE company_id = $1 AND linked_purchase_id = $2 LIMIT 1`, [company_id, pur.id]);
    if (vch) {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, code: 'HAS_PAYMENTS', message: 'على هذي الفاتورة سند صرف — احذف السند أول (ينعكس أثره)، ثم اعكس الفاتورة' });
    }

    const removed = [];
    if (pur.purchase_type !== 'opex') {
      const { warehouse_id } = await branch.resolveWarehouseForBranch(client, company_id, pur.branch_id, false);
      const { rows: items } = await client.query(`SELECT * FROM purchase_items WHERE purchase_id = $1 ORDER BY sort_order`, [pur.id]);
      for (const it of items) {
        let pid = it.product_id;
        // صنف أُنشئ منتجه بعد حفظ الفاتورة (إدراج لاحق) — ما انربط بالفاتورة، نوصله بالاسم
        if (!pid && it.product_name) {
          const { rows: [p] } = await client.query(
            `SELECT id FROM products WHERE company_id = $1 AND name = $2 ORDER BY id LIMIT 1`, [company_id, it.product_name]);
          pid = p?.id || null;
        }
        if (!pid) continue; // ما دخل المخزون أصلًا (بضاعة بالطريق)
        const qty = parseFloat(it.qty) || 0;
        if (qty <= 0) continue;
        // كمية هذي الفاتورة لازم تكون كاملة بطبقتها — لو نقصت يعني انباع منها
        const { rows: [lot] } = await client.query(
          `SELECT COALESCE(SUM(qty_remaining),0)::float AS rem, COUNT(*)::int AS n FROM stock_lots
           WHERE company_id = $1 AND product_id = $2 AND source_type = 'purchase' AND source_id = $3`, [company_id, pid, pur.id]);
        const { rows: [ps] } = await client.query(
          `SELECT COALESCE(qty,0)::float AS qty FROM product_stock WHERE product_id = $1 AND warehouse_id = $2`, [pid, warehouse_id]);
        const available = lot.n ? lot.rem : (ps?.qty || 0);
        if (available + 1e-6 < qty) {
          await client.query('ROLLBACK');
          return res.status(409).json({ success: false, code: 'SOLD',
            message: `انباع جزء من «${it.product_name}» من هذي الفاتورة — صحّحها بمرتجع مشتريات بالكمية الباقية بدل العكس` });
        }
        await stock.deduct(client, {
          company_id, product_id: pid, warehouse_id, qty,
          source_type: 'purchase_reversal', source_id: pur.id, user_id,
          reason: 'عكس فاتورة شراء مسجّلة بالخطأ', reference: pur.purchase_no,
          preferLot: { source_type: 'purchase', source_id: pur.id },
        });
        removed.push({ product_id: pid, name: it.product_name, qty });
      }
    }

    // المتبقي على الفاتورة يرجع من رصيد المورد (المدفوع يرجع للخزينة بالجهاز)
    const remaining = parseFloat(pur.remaining) || 0;
    if (pur.supplier_id && remaining > 0) {
      await client.query(`UPDATE suppliers SET balance = balance - $1 WHERE id = $2 AND company_id = $3`, [remaining, pur.supplier_id, company_id]);
    }
    await client.query(
      `UPDATE purchases SET status = 'reversed', remaining = 0, reversed_at = NOW(), reversed_by = $1, reversal_reason = $2 WHERE id = $3`,
      [user_id, reason, pur.id]);
    await client.query('COMMIT');
    res.json({ success: true, data: { removed, paid_amount: parseFloat(pur.paid_amount) || 0, remaining } });

    logAudit({
      companyId: company_id, userId: user_id, action: 'purchase_reverse',
      entityType: 'purchase', entityId: pur.id, ip: req.ip,
      oldValues: { status: pur.status, remaining: pur.remaining }, newValues: { status: 'reversed' },
      details: `عكس فاتورة شراء ${pur.purchase_no} — ${Number(pur.total).toFixed(2)} ر.س — السبب: ${reason}`
    });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
};
