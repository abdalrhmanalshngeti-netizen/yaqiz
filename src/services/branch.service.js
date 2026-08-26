const db = require('../config/db');

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
    `SELECT branch_id, all_branches FROM users WHERE id = $1 AND company_id = $2`,
    [user_id, company_id]
  );
  // موظف "كل الفروع" مصرَّح له لأي فرع فعلي بنفس شركته — لا مقارنة بفرع ثابت
  if (u?.all_branches) {
    const { rows: [b] } = await client.query(
      `SELECT id FROM branches WHERE id = $1 AND company_id = $2`,
      [explicitBranchId, company_id]
    );
    if (!b) throw Object.assign(new Error('الفرع غير موجود'), { status: 404 });
    return;
  }
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

// المشتريات والمرتجعات تُحفَظ محليًا بالمتصفح فورًا وتُزامَن مع السيرفر لاحقًا
// بخلفية منفصلة (لا انتظار فوري لرد السيرفر، بعكس الفواتير) — فلو رُفض
// الفرع هنا (403/404)، المستخدم اللي أنشأ العملية شافها "ناجحة" بجهازه ولا
// يعرف إنها لم تصل السيرفر إطلاقًا، ونفس الفرع الخاطئ يتكرر رفضه بكل محاولة
// إعادة مزامنة لاحقة فلا تتعافى تلقائيًا أبدًا. صاحب الشركة (الوحيد اللي
// يقدر يصلّح فرع الموظف أو حالة الفرع) لازم يُبلَّغ صراحة، لا مجرد console.warn
// (نفس نمط notifyIncompleteSellerData بـzatca.service.js: إشعار واحد لكل
// مالك، بلا تكرار طالما فيه إشعار سابق من نفس النوع غير مقروء)
exports.notifyBranchAuthFailure = async (companyId, actingUserId, docTypeLabel, reasonMessage) => {
  try {
    const { rows: [existing] } = await db.query(
      `SELECT id FROM notifications WHERE company_id = $1 AND type = 'branch_sync_rejected' AND is_read = false LIMIT 1`,
      [companyId]
    );
    if (existing) return;
    const { rows: owners } = await db.query(
      `SELECT id FROM users WHERE company_id = $1 AND role = 'owner' AND active = true`,
      [companyId]
    );
    if (!owners.length) return;
    const { rows: [actor] } = await db.query(
      `SELECT full_name, username FROM users WHERE id = $1 AND company_id = $2`,
      [actingUserId, companyId]
    );
    const actorName = actor?.full_name || actor?.username || 'مستخدم';
    const message = `عملية (${docTypeLabel}) أنشأها "${actorName}" لم تصل للسيرفر بسبب مشكلة بالفرع (${reasonMessage}) — ستبقى ظاهرة "ناجحة" بجهاز "${actorName}" لكنها لن تُزامَن تلقائيًا أبدًا بهذا الفرع. تحقق من فرع الموظف أو حالة الفرع من الإعدادات، وأعد إدخال العملية يدويًا إذا لزم.`;
    for (const owner of owners) {
      await db.query(
        `INSERT INTO notifications (company_id, user_id, type, title, message, link)
         VALUES ($1,$2,'branch_sync_rejected','عملية لم تُزامَن بسبب الفرع',$3,'/VVIP.html#settings')`,
        [companyId, owner.id, message]
      );
    }
  } catch (e) {
    console.error('[branch] failed to notify owner of branch sync rejection:', e.message);
  }
};
