// كل العمليات تأخذ client (transaction) لضمان الـ ACID

exports.deduct = async (client, { company_id, product_id, qty, source_type, source_id, user_id, reason = 'بيع', reference }) => {
  const { rows: [p] } = await client.query(
    `SELECT qty FROM products WHERE id = $1 AND company_id = $2 FOR UPDATE`,
    [product_id, company_id]
  );
  if (!p) throw Object.assign(new Error('المنتج غير موجود'), { status: 404 });
  if (p.qty < qty) throw Object.assign(new Error(`الكمية غير كافية في المخزون`), { status: 400 });

  const newQty = parseFloat(p.qty) - parseFloat(qty);
  await client.query(`UPDATE products SET qty = $1, updated_at = NOW() WHERE id = $2`, [newQty, product_id]);
  const { rows: [move] } = await client.query(`
    INSERT INTO stock_moves
      (company_id, product_id, type, qty, balance_before, balance_after,
       reason, source_type, source_id, reference, created_by)
    VALUES ($1,$2,'out',$3,$4,$5,$6,$7,$8,$9,$10)
    RETURNING *
  `, [company_id, product_id, qty, p.qty, newQty, reason, source_type, source_id, reference, user_id]);
  return move;
};

exports.add = async (client, { company_id, product_id, qty, unit_cost, source_type, source_id, user_id, reason = 'شراء', source, reference }) => {
  const { rows: [p] } = await client.query(
    `SELECT qty FROM products WHERE id = $1 AND company_id = $2 FOR UPDATE`,
    [product_id, company_id]
  );
  if (!p) throw Object.assign(new Error('المنتج غير موجود'), { status: 404 });

  const newQty = parseFloat(p.qty) + parseFloat(qty);
  await client.query(`UPDATE products SET qty = $1, updated_at = NOW() WHERE id = $2`, [newQty, product_id]);
  const { rows: [move] } = await client.query(`
    INSERT INTO stock_moves
      (company_id, product_id, type, qty, balance_before, balance_after,
       reason, source, source_type, source_id, unit_cost, reference, created_by)
    VALUES ($1,$2,'in',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    RETURNING *
  `, [company_id, product_id, qty, p.qty, newQty, reason, source, source_type, source_id, unit_cost, reference, user_id]);
  return move;
};
