-- الحارس يفرّق بين نوعين:
--  system: خلل بالنظام نفسه (الدفاتر ≠ المخزون/الخزينة/الأرصدة) — للمطوّر فقط
--  user:   ملاحظة على بيانات الشركة نفسها (صندوق بالسالب، بضاعة لم تُدرج) — تصل
--          لصاحب المنشأة كإشعار مرة وحدة (notified_at)، لا لمالك المنصة
ALTER TABLE ledger_guard_findings ADD COLUMN IF NOT EXISTS category VARCHAR(10) NOT NULL DEFAULT 'system';
ALTER TABLE ledger_guard_findings ADD COLUMN IF NOT EXISTS notified_at TIMESTAMPTZ;
