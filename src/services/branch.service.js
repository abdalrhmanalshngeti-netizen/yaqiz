// يحل فرعًا (أو الفرع الرئيسي إن لم يُحدَّد) إلى مستودعه الوحيد الحالي —
// نقطة موحّدة يستخدمها كل من المشتريات والفواتير والتعديل اليدوي للمخزون
// بدل ما كل مسار يكرر نفس منطق الحل بنفسه.
//
// requireActive=false تُستخدم فقط عند إرجاع مخزون لعملية ماضية (مثل إلغاء فاتورة)
// حيث يجب استخدام نفس فرع/مستودع البيع الأصلي حتى لو أصبح الفرع غير نشط لاحقًا —
// خلاف ذلك يصبح إلغاء أي فاتورة مرتبطة بفرع مُعطَّل مستحيلاً للأبد (المخزون يُخصم
// وقت البيع من مستودع بعينه، فيجب إرجاعه لنفس المستودع بالضبط، لا لأي مستودع آخر)
exports.resolveWarehouseForBranch = async (client, company_id, branch_id, requireActive = true) => {
  let bId = branch_id;

  if (!bId) {
    const { rows: [main] } = await client.query(
      `SELECT id FROM branches WHERE company_id = $1 AND is_main = true AND is_active = true LIMIT 1`,
      [company_id]
    );
    if (!main) throw Object.assign(new Error('لا يوجد فرع نشط للشركة — يجب إعداد فرع أولاً'), { status: 400 });
    bId = main.id;
  } else {
    const { rows: [b] } = await client.query(
      `SELECT id FROM branches WHERE id = $1 AND company_id = $2` + (requireActive ? ` AND is_active = true` : ''),
      [bId, company_id]
    );
    if (!b) throw Object.assign(new Error('الفرع غير موجود'), { status: 404 });
  }

  const { rows: [wh] } = await client.query(
    `SELECT id FROM warehouses WHERE branch_id = $1` + (requireActive ? ` AND is_active = true` : '') + ` LIMIT 1`,
    [bId]
  );
  if (!wh) throw Object.assign(new Error('لا يوجد مستودع لهذا الفرع'), { status: 400 });

  return { branch_id: bId, warehouse_id: wh.id };
};

// يتأكد إن المستخدم مصرَّح له فعليًا يسجّل عملية على فرع مُحدَّد صراحة بالطلب —
// المالك يقدر لأي فرع بشركته، غيره فقط فرعه المخصَّص هو. بدون هذا، أي موظف
// عادي (كاشير مثلاً) يقدر يمرّر أي branch_id صحيح لنفس الشركة (تكفي معرفة رقمه
// فقط، لا صلاحية فعلية) ويسجّل فاتورة/شراء/مرتجع/حركة خزينة على فرع ثاني يمس
// مخزونه ورصيده المالي — يفسد تقارير أداء ذلك الفرع بحركات لا تخصه إطلاقًا
exports.assertBranchAuthorized = async (client, company_id, user_id, role, explicitBranchId) => {
  if (!explicitBranchId || role === 'owner') return;
  const { rows: [u] } = await client.query(
    `SELECT branch_id FROM users WHERE id = $1 AND company_id = $2`,
    [user_id, company_id]
  );
  if (String(u?.branch_id) !== String(explicitBranchId)) {
    throw Object.assign(new Error('لا يمكنك تسجيل عملية على فرع آخر غير فرعك المخصَّص'), { status: 403 });
  }
};

// يحل فرع الفاتورة: مصرَّح صراحة بالطلب أولًا (بعد التحقق من صلاحية المستخدم
// عليه)، وإلا فرع المستخدم نفسه — بقراءة طازجة من قاعدة البيانات دائمًا (لا
// نثق بأي شيء مخزَّن بالـ JWT لأن المالك يقدر يغيّر فرع الموظف في أي وقت
// والتوكن يبقى صالحًا ٨ ساعات).
exports.resolveWarehouseForUser = async (client, company_id, user_id, explicitBranchId, role) => {
  if (explicitBranchId) {
    await exports.assertBranchAuthorized(client, company_id, user_id, role, explicitBranchId);
    return exports.resolveWarehouseForBranch(client, company_id, explicitBranchId);
  }
  const { rows: [u] } = await client.query(
    `SELECT branch_id FROM users WHERE id = $1 AND company_id = $2`,
    [user_id, company_id]
  );
  return exports.resolveWarehouseForBranch(client, company_id, u?.branch_id || null);
};
