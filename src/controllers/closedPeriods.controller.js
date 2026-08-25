const db     = require('../config/db');
const bcrypt = require('bcrypt');
const { nextDocNumber } = require('../services/docNumber.service');
const periodClose = require('../services/periodClose.service');

// يرجّع حساب "أرباح مرحّلة" (3100) بدليل حسابات الشركة، ينشئه تلقائياً تحت
// مجموعة 3000 لو لسه ما وصلته migration 054 (نفس نمط resolveAccountId
// بـjournal.controller.js — ذاتي الإصلاح لأي شركة قديمة لسبب ما)
async function resolveRetainedEarningsAccount(client, companyId) {
  const { rows: [existing] } = await client.query(
    `SELECT id, code, name FROM chart_of_accounts WHERE company_id = $1 AND code = '3100'`,
    [companyId]
  );
  if (existing) return existing;
  const { rows: [created] } = await client.query(`
    INSERT INTO chart_of_accounts (company_id, code, name, name_en, type, is_group, parent_id)
    VALUES ($1, '3100', 'أرباح مرحّلة', 'Retained Earnings', 'حقوق الملكية', false,
      (SELECT id FROM chart_of_accounts WHERE company_id = $1 AND code = '3000'))
    RETURNING id, code, name
  `, [companyId]);
  return created;
}

// إقفال محاسبي حقيقي لنهاية السنة: يصفّر كل حساب إيرادات (4xxx)/مصروفات (5xxx)
// له نشاط حتى نهاية السنة، وينقل صافي الفرق لحساب الأرباح المرحّلة (3100).
// بما إن كل التقارير تُحسب بمسح حي كامل لدفتر اليومية بلا أي لقطة، نشر هذا
// القيد وحده يكفي ليصفّر الرصيد التراكمي لهذي الحسابات تلقائياً من هذي اللحظة
// فصاعداً — بلا أي حاجة لتعديل منطق حساب التقارير إطلاقاً (انظر ميزان
// المراجعة/الميزانية/قائمة الدخل، بالكلاينت والسيرفر على حدٍ سواء)
async function postYearClosingEntry(client, companyId, userId, yearKey, closedPeriodId) {
  const yearEndDate = `${yearKey}-12-31`;

  const { rows: accounts } = await client.query(`
    SELECT ji.account_id, ji.account_code, ji.account_name,
           SUM(CASE WHEN ji.side = 'debit'  THEN ji.amount ELSE 0 END)::float AS debit,
           SUM(CASE WHEN ji.side = 'credit' THEN ji.amount ELSE 0 END)::float AS credit
    FROM journal_items ji
    JOIN journal_entries je   ON je.id = ji.entry_id
    JOIN chart_of_accounts coa ON coa.id = ji.account_id
    WHERE je.company_id = $1 AND je.date <= $2
      AND (ji.account_code LIKE '4%' OR ji.account_code LIKE '5%')
      AND coa.is_group = false
    GROUP BY ji.account_id, ji.account_code, ji.account_name
  `, [companyId, yearEndDate]);

  const lines = [];
  let netToRetained = 0; // موجب = صافي ربح (يُقيَّد دائناً بـ3100)، سالب = خسارة (مديناً)
  for (const a of accounts) {
    const isRevenue = a.account_code.startsWith('4');
    const balance = isRevenue ? (a.credit - a.debit) : (a.debit - a.credit);
    const cents = Math.round(balance * 100);
    if (cents === 0) continue;
    const amount = Math.abs(cents) / 100;
    if (isRevenue) {
      // حساب إيراد برصيد دائن طبيعي (balance>0) → يُصفَّر بقيد مدين، والعكس
      lines.push({ account_id: a.account_id, account_code: a.account_code, account_name: a.account_name,
        side: balance > 0 ? 'debit' : 'credit', amount });
      netToRetained += balance;
    } else {
      // حساب مصروف برصيد مدين طبيعي (balance>0) → يُصفَّر بقيد دائن، والعكس
      lines.push({ account_id: a.account_id, account_code: a.account_code, account_name: a.account_name,
        side: balance > 0 ? 'credit' : 'debit', amount });
      netToRetained -= balance;
    }
  }
  if (!lines.length) return null; // ما فيه أي نشاط إيرادات/مصروفات لهذي السنة أصلاً

  const netCents = Math.round(netToRetained * 100);
  if (netCents !== 0) {
    const retained = await resolveRetainedEarningsAccount(client, companyId);
    lines.push({ account_id: retained.id, account_code: retained.code, account_name: retained.name,
      side: netCents > 0 ? 'credit' : 'debit', amount: Math.abs(netCents) / 100 });
  }

  const entrySeqN = await nextDocNumber(client, companyId, 'entry');
  const entry_no = `JE-${String(entrySeqN).padStart(6, '0')}`;
  const { rows: [entry] } = await client.query(`
    INSERT INTO journal_entries (company_id, entry_no, description, date, source_type, source_id, created_by)
    VALUES ($1,$2,$3,$4,'period_close',$5,$6) RETURNING id, entry_no
  `, [companyId, entry_no, `قيد إقفال السنة المالية ${yearKey}`, yearEndDate, closedPeriodId, userId]);

  for (const l of lines) {
    await client.query(`
      INSERT INTO journal_items (entry_id, account_id, account_code, account_name, side, amount)
      VALUES ($1,$2,$3,$4,$5,$6)
    `, [entry.id, l.account_id, l.account_code, l.account_name, l.side, l.amount]);
  }
  return { id: entry.id, entry_no: entry.entry_no, lines_count: lines.length };
}

exports.list = async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT * FROM closed_periods WHERE company_id = $1 ORDER BY period_key DESC`,
      [req.user.company_id]
    );
    res.json({ success: true, data: rows });
  } catch (err) { next(err); }
};

exports.create = async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const { company_id, sub: user_id } = req.user;
    const { period_type, period_key, closed_by_name } = req.body;
    if (!['month', 'year'].includes(period_type) || !period_key) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'بيانات الفترة غير صحيحة' });
    }
    const { rows: [row] } = await client.query(`
      INSERT INTO closed_periods (company_id, period_type, period_key, closed_by, closed_by_name)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (company_id, period_type, period_key) DO NOTHING
      RETURNING *
    `, [company_id, period_type, period_key, user_id, closed_by_name || '']);

    if (!row) { // مُقفَلة أصلاً (ON CONFLICT DO NOTHING) — بلا أي أثر إضافي
      await client.query('COMMIT');
      return res.status(201).json({ success: true, data: null });
    }

    let closingEntry = null;
    if (period_type === 'year') {
      // إقفال سنة أقدم بعد ما سنة أحدث منها مُقفَلة أصلاً يضاعف احتساب الربح/الخسارة
      // بالأرباح المرحّلة: قيد إقفال السنة الأحدث يُحسَب تراكميًا (كل ما قبل نهايتها)
      // فيشمل نشاط السنة الأقدم أصلاً ضمنيًا؛ إقفالها لاحقًا بشكل منفصل يُصفّر نفس
      // الأرصدة مرة ثانية وينقل نفس الربح/الخسارة لحساب 3100 مرتين. نفس منطق فحص
      // الترتيب المستخدم أصلًا بفتح الفترات (exports.remove أدناه) لكن بالاتجاه المعاكس
      const { rows: [laterClosedYear] } = await client.query(
        `SELECT 1 FROM closed_periods WHERE company_id = $1 AND period_type = 'year' AND period_key > $2 LIMIT 1`,
        [company_id, period_key]
      );
      if (laterClosedYear) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          success: false,
          message: 'لا يمكن إقفال هذه السنة — توجد سنة مالية أحدث مُقفَلة بالفعل. افتح السنوات الأحدث أولاً قبل إقفال سنة أقدم.'
        });
      }
      closingEntry = await postYearClosingEntry(client, company_id, user_id, period_key, row.id);
    }

    await client.query('COMMIT');
    res.status(201).json({ success: true, data: row, closingEntry });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
};

exports.remove = async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [period] } = await client.query(
      `SELECT * FROM closed_periods WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [req.params.id, req.user.company_id]
    );
    if (!period) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'الفترة غير موجودة' });
    }

    if (period.period_type === 'year') {
      // منطقي: لا تفتح سنة قديمة وسنة أحدث منها لا تزال مقفلة (ترتيب زمني)
      const { rows: [later] } = await client.query(
        `SELECT 1 FROM closed_periods WHERE company_id = $1 AND period_type = 'year' AND period_key > $2 LIMIT 1`,
        [req.user.company_id, period.period_key]
      );
      if (later) {
        await client.query('ROLLBACK');
        return res.status(400).json({ success: false, message: 'يجب فتح السنوات المالية الأحدث أولاً' });
      }
      // يعكس قيد التصفير المرتبط (لو وُجد) قبل حذف صف القفل — cascade يحذف journal_items تلقائياً
      await client.query(
        `DELETE FROM journal_entries WHERE company_id = $1 AND source_type = 'period_close' AND source_id = $2`,
        [req.user.company_id, period.id]
      );
    }

    await client.query(`DELETE FROM closed_periods WHERE id = $1 AND company_id = $2`, [req.params.id, req.user.company_id]);
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
};

// حالة كلمة مرور التجاوز — هل تم تعيينها لهذه الشركة أصلاً؟ (بدون كشف أي شيء عنها)
exports.overridePasswordStatus = async (req, res, next) => {
  try {
    const { rows: [co] } = await db.query(
      `SELECT (period_override_password_hash IS NOT NULL) AS is_set FROM companies WHERE id = $1`,
      [req.user.company_id]
    );
    res.json({ success: true, is_set: !!co?.is_set });
  } catch (err) { next(err); }
};

// تعيين/تغيير كلمة مرور التجاوز — مالك الحساب فقط، ويتطلب كلمة مرور دخوله
// الحقيقية كتأكيد (حتى لا يقدر أي شخص بجلسة مسروقة يغيّرها بدون معرفة كلمة
// مرور المالك الفعلية). هذه الكلمة منفصلة تمامًا عن كلمة مرور الدخول.
exports.setOverridePassword = async (req, res, next) => {
  try {
    if (req.user.role !== 'owner') {
      return res.status(403).json({ success: false, message: 'هذا الإجراء لمالك الحساب فقط' });
    }
    const { current_login_password, new_override_password } = req.body;
    if (!current_login_password || !new_override_password) {
      return res.status(400).json({ success: false, message: 'كلمة مرور الدخول الحالية وكلمة مرور التجاوز الجديدة مطلوبتان' });
    }
    if (new_override_password.length < 6) {
      return res.status(400).json({ success: false, message: 'كلمة مرور التجاوز يجب أن تكون 6 أحرف على الأقل' });
    }
    const { rows: [owner] } = await db.query(
      `SELECT password_hash FROM users WHERE id = $1 AND company_id = $2`,
      [req.user.sub, req.user.company_id]
    );
    if (!owner || !(await bcrypt.compare(current_login_password, owner.password_hash))) {
      return res.status(401).json({ success: false, message: 'كلمة مرور الدخول الحالية غير صحيحة' });
    }
    const hash = await bcrypt.hash(new_override_password, 12);
    await db.query(`UPDATE companies SET period_override_password_hash = $1 WHERE id = $2`, [hash, req.user.company_id]);
    res.json({ success: true });
  } catch (err) { next(err); }
};

// تحقق من كلمة مرور التجاوز (منفصلة عن كلمة مرور دخول المالك) — يُستخدم لتجاوز
// إقفال فترة محاسبية استثنائياً أو فتحها. لا يغيّر شيئاً بقاعدة البيانات؛ عند
// النجاح فقط يوقّع توكن قصير الأجل (10 دقائق) يربط التجاوز فعلياً بعملية
// الحفظ اللي بعده مباشرة — قبل هذا كان النجاح يرجع {success:true} بلا أي ربط
// تشفيري بالكتابة الفعلية اللي تلي التحقق
exports.verifyOverridePassword = async (req, res, next) => {
  try {
    const { password } = req.body;
    if (!password) return res.status(400).json({ success: false, message: 'كلمة المرور مطلوبة' });
    const { rows: [co] } = await db.query(
      `SELECT period_override_password_hash FROM companies WHERE id = $1`,
      [req.user.company_id]
    );
    if (!co?.period_override_password_hash) {
      return res.status(400).json({ success: false, code: 'NOT_SET', message: 'لم يُعيَّن مالك الحساب كلمة مرور تجاوز بعد' });
    }
    if (!(await bcrypt.compare(password, co.period_override_password_hash))) {
      return res.status(401).json({ success: false, message: 'كلمة مرور التجاوز غير صحيحة' });
    }
    const overrideToken = periodClose.signPeriodOverrideToken(req.user.company_id);
    res.json({ success: true, overrideToken });
  } catch (err) { next(err); }
};
