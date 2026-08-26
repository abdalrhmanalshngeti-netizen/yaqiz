// كل العمليات تأخذ client (transaction) لضمان الـ ACID
//
// products.qty يبقى إجماليًا مُشتقًا (كل الاستعلامات/التقارير الحالية تقرأه
// مباشرة)، بينما product_stock هو مصدر الحقيقة الفعلي للكمية لكل مستودع —
// الاثنان يُحدَّثان دائمًا بنفس المعاملة، لا يجوز تحديث أحدهما بدون الآخر.
//
// stock_lots هو مصدر الحقيقة الوحيد لتكلفة البضاعة المباعة (FIFO حقيقي) —
// يحل محل الاعتماد على products.buy_price (كان "آخر سعر شراء" فقط، لا FIFO)
// وعلى مصفوفة lots المحلية بالمتصفح (كانت تُمحى بالكامل كل مزامنة دورية).
// ترتيب القفل ثابت دائمًا: products → product_stock → stock_lots، لمنع
// deadlock بين عمليتين متزامنتين على نفس الصنف/المستودع.

exports.deduct = async (client, { company_id, product_id, warehouse_id, qty, source_type, source_id, user_id, reason = 'بيع', reference, client_local_id }) => {
  if (!warehouse_id) throw Object.assign(new Error('المستودع مطلوب لتنفيذ عملية المخزون'), { status: 400 });

  const { rows: [p] } = await client.query(
    `SELECT qty, buy_price FROM products WHERE id = $1 AND company_id = $2 FOR UPDATE`,
    [product_id, company_id]
  );
  if (!p) throw Object.assign(new Error('المنتج غير موجود'), { status: 404 });

  const { rows: [ps] } = await client.query(
    `SELECT qty FROM product_stock WHERE product_id = $1 AND warehouse_id = $2 FOR UPDATE`,
    [product_id, warehouse_id]
  );
  const whQty = ps ? parseFloat(ps.qty) : 0;
  const deductQty = parseFloat(qty);
  if (whQty < deductQty) throw Object.assign(new Error('الكمية غير كافية في مخزون هذا المستودع'), { status: 400 });

  const newWhQty = whQty - deductQty;
  if (ps) {
    await client.query(`UPDATE product_stock SET qty = $1, updated_at = NOW() WHERE product_id = $2 AND warehouse_id = $3`,
      [newWhQty, product_id, warehouse_id]);
  } else {
    await client.query(`INSERT INTO product_stock (company_id, product_id, warehouse_id, qty) VALUES ($1,$2,$3,$4)`,
      [company_id, product_id, warehouse_id, newWhQty]);
  }

  const newQty = parseFloat(p.qty) - deductQty;
  await client.query(`UPDATE products SET qty = $1, updated_at = NOW() WHERE id = $2`, [newQty, product_id]);

  // استهلاك FIFO حقيقي — أقدم طبقة أولًا (ORDER BY received_at, id)، قفل كل
  // الطبقات المرشّحة دفعة واحدة قبل التعديل لتفادي قراءة قيمة تُعدَّل بمعاملة
  // أخرى متزامنة بينهما
  const { rows: lots } = await client.query(
    `SELECT id, qty_remaining, unit_cost FROM stock_lots
     WHERE product_id = $1 AND warehouse_id = $2 AND qty_remaining > 0
     ORDER BY received_at ASC, id ASC FOR UPDATE`,
    [product_id, warehouse_id]
  );
  let remaining = deductQty;
  let totalCost = 0;
  for (const lot of lots) {
    if (remaining <= 0) break;
    const lotQty = parseFloat(lot.qty_remaining);
    const take = Math.min(remaining, lotQty);
    totalCost += take * parseFloat(lot.unit_cost);
    remaining -= take;
    await client.query(`UPDATE stock_lots SET qty_remaining = $1 WHERE id = $2`, [lotQty - take, lot.id]);
  }
  // لا طبقات كافية (بيانات قديمة قبل هذا الإصلاح، أو حافة نادرة) — نكمل
  // الباقي بآخر سعر شراء معروف كاحتياط بدل رفض العملية، بلا إنشاء طبقة
  // جديدة (حساب حي لمرة واحدة فقط، لا حالة دائمة إضافية)
  if (remaining > 0) {
    totalCost += remaining * parseFloat(p.buy_price || 0);
  }
  totalCost = Math.round(totalCost * 100) / 100;
  const unitCostAvg = deductQty > 0 ? Math.round((totalCost / deductQty) * 100) / 100 : 0;

  const { rows: [move] } = await client.query(`
    INSERT INTO stock_moves
      (company_id, product_id, warehouse_id, type, qty, balance_before, balance_after,
       reason, source_type, source_id, unit_cost, reference, created_by, client_local_id)
    VALUES ($1,$2,$3,'out',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    RETURNING *
  `, [company_id, product_id, warehouse_id, qty, whQty, newWhQty, reason, source_type, source_id, unitCostAvg, reference, user_id, client_local_id || null]);
  return { move, totalCost, unitCostAvg };
};

exports.add = async (client, { company_id, product_id, warehouse_id, qty, unit_cost, source_type, source_id, user_id, reason = 'شراء', source, reference, client_local_id }) => {
  if (!warehouse_id) throw Object.assign(new Error('المستودع مطلوب لتنفيذ عملية المخزون'), { status: 400 });

  const { rows: [p] } = await client.query(
    `SELECT qty, buy_price FROM products WHERE id = $1 AND company_id = $2 FOR UPDATE`,
    [product_id, company_id]
  );
  if (!p) throw Object.assign(new Error('المنتج غير موجود'), { status: 404 });

  const { rows: [ps] } = await client.query(
    `SELECT qty FROM product_stock WHERE product_id = $1 AND warehouse_id = $2 FOR UPDATE`,
    [product_id, warehouse_id]
  );
  const whQty = ps ? parseFloat(ps.qty) : 0;
  const newWhQty = whQty + parseFloat(qty);
  if (ps) {
    await client.query(`UPDATE product_stock SET qty = $1, updated_at = NOW() WHERE product_id = $2 AND warehouse_id = $3`,
      [newWhQty, product_id, warehouse_id]);
  } else {
    await client.query(`INSERT INTO product_stock (company_id, product_id, warehouse_id, qty) VALUES ($1,$2,$3,$4)`,
      [company_id, product_id, warehouse_id, newWhQty]);
  }

  const newQty = parseFloat(p.qty) + parseFloat(qty);
  await client.query(`UPDATE products SET qty = $1, updated_at = NOW() WHERE id = $2`, [newQty, product_id]);

  // طبقة تكلفة جديدة — التكلفة الممرَّرة صراحة (سعر شراء فعلي، أو تكلفة
  // محفوظة من مصدر آخر كنقل/مرتجع) وإلا آخر سعر شراء معروف كاحتياط
  const lotCost = unit_cost !== undefined && unit_cost !== null ? parseFloat(unit_cost) : parseFloat(p.buy_price || 0);
  await client.query(`
    INSERT INTO stock_lots (company_id, product_id, warehouse_id, qty_remaining, unit_cost, source_type, source_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
  `, [company_id, product_id, warehouse_id, qty, lotCost, source_type || null, source_id || null]);

  const { rows: [move] } = await client.query(`
    INSERT INTO stock_moves
      (company_id, product_id, warehouse_id, type, qty, balance_before, balance_after,
       reason, source, source_type, source_id, unit_cost, reference, created_by, client_local_id)
    VALUES ($1,$2,$3,'in',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
    RETURNING *
  `, [company_id, product_id, warehouse_id, qty, whQty, newWhQty, reason, source, source_type, source_id, lotCost, reference, user_id, client_local_id || null]);
  return move;
};
