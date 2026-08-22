-- سندات القبض/الصرف كانت تقبل voucher_no من المتصفح مباشرة (عدّاد محلي لكل
-- جهاز، لا عدّاد سيرفري موحّد لكل شركة) — بعكس كل مستند آخر بالمنصة بعد إصلاح
-- الترقيم المستقل لكل شركة (doc_number_counters). يصير الآن voucher_no يُولَّد
-- بالسيرفر حصريًا عبر nextDocNumber، وclient_local_id يحل محل voucher_no كمفتاح
-- تمييز إعادة الإرسال (استجابة سابقة ضاعت بالشبكة، مثلاً) بدل الاعتماد على رقم
-- كان المتصفح يولّده.
ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS client_local_id INT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_vouchers_client_local_id
  ON vouchers(company_id, client_local_id) WHERE client_local_id IS NOT NULL;
