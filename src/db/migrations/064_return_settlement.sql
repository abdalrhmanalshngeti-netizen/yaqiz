-- المرتجع الآجل يسوّي جزءًا من الفاتورة/فاتورة الشراء المرتبطة (إشعار دائن)
-- بدل ما يرجّع نقدًا للطرف وهو لسه مديون. نحفظ:
--  • تقسيم المرتجع (نقدي/آجل) بسجله — يظهر بنفس الأرقام على أي جهاز
--  • المبلغ المسوّى بمرتجعات على الفاتورة — المتبقي = الإجمالي − المدفوع − المسوّى
ALTER TABLE returns  ADD COLUMN IF NOT EXISTS cash_portion   NUMERIC(12,2);
ALTER TABLE returns  ADD COLUMN IF NOT EXISTS credit_portion NUMERIC(12,2);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS credited_amount NUMERIC(12,2) NOT NULL DEFAULT 0;
-- الالتزام الدوري: هل مبلغه شامل ضريبة 15% (فاتورة ضريبية من المورد)؟ كان يُفترض
-- دائمًا للشركة المسجّلة، فتُخصم ضريبة مدخلات على رسوم حكومية/أقساط/إيجار سكني
-- بلا فاتورة ضريبية تدعمها. الافتراضي الآن: غير شامل
ALTER TABLE obligations ADD COLUMN IF NOT EXISTS vat_included BOOLEAN NOT NULL DEFAULT false;
