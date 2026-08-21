const db = require('../config/db');

// GET /api/bank-recon — حالة موحّدة على مستوى الشركة (لا لكل جهاز)
exports.get = async (req, res, next) => {
  try {
    const { company_id } = req.user;
    const { rows: [row] } = await db.query(
      `SELECT to_char(from_date,'YYYY-MM-DD') AS from_date, to_char(to_date,'YYYY-MM-DD') AS to_date,
              bank_network_total, adjustments, imported_lines
       FROM bank_recon WHERE company_id = $1`,
      [company_id]
    );
    res.json({
      success: true,
      data: row
        ? {
            from: row.from_date || '',
            to: row.to_date || '',
            bankNetworkTotal: parseFloat(row.bank_network_total) || 0,
            adjustments: row.adjustments || [],
            importedLines: row.imported_lines,
          }
        : { from: '', to: '', bankNetworkTotal: 0, adjustments: [], importedLines: null },
    });
  } catch (err) { next(err); }
};

// PUT /api/bank-recon — استبدال الحالة الكاملة (نفس شكل db.bank_recon بالعميل)
exports.update = async (req, res, next) => {
  try {
    const { company_id } = req.user;
    const { from, to, bankNetworkTotal, adjustments, importedLines } = req.body;
    // نفرض شكل المصفوفات صراحةً قبل التخزين — قيمة غير مصفوفة تُخزَّن كـJSONB
    // بلا مشكلة بالسيرفر، لكنها تكسر renderBankRecon() بالعميل (يفترض مصفوفة
    // دائمًا) بشكل دائم لكل تحميل قادم لهذي الشركة إلى أن تُصحَّح يدويًا بقاعدة البيانات
    const safeAdjustments  = Array.isArray(adjustments) ? adjustments : [];
    const safeImportedLines = importedLines == null ? null : (Array.isArray(importedLines) ? importedLines : null);

    await db.query(`
      INSERT INTO bank_recon (company_id, from_date, to_date, bank_network_total, adjustments, imported_lines, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,NOW())
      ON CONFLICT (company_id) DO UPDATE SET
        from_date = $2, to_date = $3, bank_network_total = $4,
        adjustments = $5, imported_lines = $6, updated_at = NOW()
    `, [
      company_id,
      from || null,
      to || null,
      parseFloat(bankNetworkTotal) || 0,
      JSON.stringify(safeAdjustments),
      safeImportedLines === null ? null : JSON.stringify(safeImportedLines),
    ]);

    res.json({ success: true });
  } catch (err) { next(err); }
};
