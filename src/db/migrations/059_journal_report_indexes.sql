-- تقارير الميزانية/الدخل/الضريبة تفحص journal_items/journal_entries بالكامل
-- كل استدعاء (لا رصيد افتتاحي مُرحَّل لأي فترة مُقفَلة بالمنصة حاليًا — إعادة
-- هيكلة أكبر خارج نطاق هذا الإصلاح). هذا فهرسان يُسرِّعان الاستعلامات الحالية
-- كما هي، بلا أي تغيير منطقي: فهرس مركّب على (company_id, date) يخدم فلاتر
-- التاريخ بـincomeStatement/vatReport (كان الفهرس السابق company_id فقط)،
-- وفهرس account_code يخدم فلتر vatReport's account_code IN ('2200','2210')
-- الذي بلا أي فهرس داعم إطلاقًا حتى الآن
CREATE INDEX IF NOT EXISTS idx_journal_entries_company_date ON journal_entries(company_id, date);
CREATE INDEX IF NOT EXISTS idx_journal_items_account_code   ON journal_items(account_code);
