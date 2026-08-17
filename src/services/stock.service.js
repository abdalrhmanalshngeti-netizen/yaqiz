// كل العمليات تأخذ client (transaction) لضمان الـ ACID
//
// products.qty يبقى إجماليًا مُشتقًا (كل الاستعلامات/التقارير الحالية تقرأه
// مباشرة)، بينما product_stock هو مصدر الحقيقة الفعلي للكمية لكل مستودع —
// الاثنان يُحدَّثان دائمًا بنفس المعاملة، لا يجوز تحديث أحدهما بدون الآخر.

exports.deduct = async (client, { company_id, product_id, warehouse_id, qty, source_type, source_id, user_id, reason = 'بيع', reference }) => {
  if (!warehouse_id) throw Object.assign(new Error('المستودع مطلوب لتنفيذ عملية المخزون'), { status: 400 });

  const { rows: [p] } = await client.query(
    `SELECT qty FROM products WHERE id = $1 AND company_id = $2 FOR UPDATE`,
    [product_id, company_id]
  );
  if (!p) throw Object.assign(new Error('المنتج غير موجود'), { status: 404 });

  const { rows: [ps] } = await client.query(
    `SELECT qty FROM product_stock WHERE product_id = $1 AND warehouse_id = $2 FOR UPDATE`,
    [product_id, warehouse_id]
  );
  const whQty = ps ? parseFloat(ps.qty) : 0;
  if (whQty < parseFloat(qty)) throw Object.assign(new Error('الكمية غير كافية في مخزون هذا المستودع'), { status: 400 });

  const newWhQty = whQty - parseFloat(qty);
  if (ps) {
    await client.query(`UPDATE product_stock SET qty = $1, updated_at = NOW() WHERE product_id = $2 AND warehouse_id = $3`,
      [newWhQty, product_id, warehouse_id]);
  } else {
    await client.query(`INSERT INTO product_stock (company_id, product_id, warehouse_id, qty) VALUES ($1,$2,$3,$4)`,
      [company_id, product_id, warehouse_id, newWhQty]);
  }

  const newQty = parseFloat(p.qty) - parseFloat(qty);
  await client.query(`UPDATE products SET qty = $1, updated_at = NOW() WHERE id = $2`, [newQty, product_id]);

  const { rows: [move] } = await client.query(`
    INSERT INTO stock_moves
      (company_id, product_id, warehouse_id, type, qty, balance_before, balance_after,
       reason, source_type, source_id, reference, created_by)
    VALUES ($1,$2,$3,'out',$4,$5,$6,$7,$8,$9,$10,$11)
    RETURNING *
  `, [company_id, product_id, warehouse_id, qty, whQty, newWhQty, reason, source_type, source_id, reference, user_id]);
  return move;
};

exports.add = async (client, { company_id, product_id, warehouse_id, qty, unit_cost, source_type, source_id, user_id, reason = 'شراء', source, reference }) => {
  if (!warehouse_id) throw Object.assign(new Error('المستودع مطلوب لتنفيذ عملية المخزون'), { status: 400 });

  const { rows: [p] } = await client.query(
    `SELECT qty FROM products WHERE id = $1 AND company_id = $2 FOR UPDATE`,
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

  const { rows: [move] } = await client.query(`
    INSERT INTO stock_moves
      (company_id, product_id, warehouse_id, type, qty, balance_before, balance_after,
       reason, source, source_type, source_id, unit_cost, reference, created_by)
    VALUES ($1,$2,$3,'in',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    RETURNING *
  `, [company_id, product_id, warehouse_id, qty, whQty, newWhQty, reason, source, source_type, source_id, unit_cost, reference, user_id]);
  return move;
};
