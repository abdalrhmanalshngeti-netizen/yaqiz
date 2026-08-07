-- الموظف يُقرّ عند إغلاق ورديته بالمبلغ الفعلي المعدود لكل طريقة دفع على حدة
-- (كاش، شبكة، تحويل بنكي) — لا يكفي عمود closing_cash وحده للمقارنة الصحيحة
-- مع ما سجّله النظام فعليًا لكل طريقة.
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS closing_card     NUMERIC DEFAULT 0;
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS closing_transfer NUMERIC DEFAULT 0;
