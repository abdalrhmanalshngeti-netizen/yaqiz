-- دفعة العميل المقدمة (التزام 2160 — رصيد دائن للعميل) تُسوّى تلقائيًا من فواتيره
-- الآجلة اللاحقة بقيد تسوية مستقل: من حـ/ دفعات عملاء مقدمة إلى حـ/ الذمم المدينة.
-- advance_amount  = الجزء الزائد من سند القبض (ما له فاتورة ولا رصيد سابق) = دفعة مقدمة
-- advance_applied = ما سُوّي من الدفعات المقدمة على هذي الفاتورة (يُعكس لو انلغت)
ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS advance_amount NUMERIC(14,2) NOT NULL DEFAULT 0;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS advance_applied NUMERIC(14,2) NOT NULL DEFAULT 0;
