-- إضافة طريقة الدفع (نقدي/شبكة/تحويل) لكل حركة خزينة، لازمة للتسوية البنكية
ALTER TABLE treasury_moves ADD COLUMN IF NOT EXISTS payment_method VARCHAR(30);
CREATE INDEX IF NOT EXISTS idx_treasury_moves_method ON treasury_moves(payment_method);
