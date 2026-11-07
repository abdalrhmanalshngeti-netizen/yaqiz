-- client_local_id صار مفتاحًا فريدًا لكل جهاز (معرّف الجهاز × 2^23 + الرقم المحلي)
-- بدل الرقم المحلي وحده — جهازان لنفس الشركة كانا يولّدان نفس الرقم المحلي،
-- فيعتبر السيرفر سجل الجهاز الثاني إعادة إرسال للأول ويرميه بصمت.
-- المفتاح الجديد أكبر من حد INT، فالأعمدة تصير BIGINT (الفهارس الفريدة تبقى كما هي)
ALTER TABLE customers        ALTER COLUMN client_local_id TYPE BIGINT;
ALTER TABLE employees        ALTER COLUMN client_local_id TYPE BIGINT;
ALTER TABLE invoices         ALTER COLUMN client_local_id TYPE BIGINT;
ALTER TABLE journal_entries  ALTER COLUMN client_local_id TYPE BIGINT;
ALTER TABLE products         ALTER COLUMN client_local_id TYPE BIGINT;
ALTER TABLE purchase_orders  ALTER COLUMN client_local_id TYPE BIGINT;
ALTER TABLE purchases        ALTER COLUMN client_local_id TYPE BIGINT;
ALTER TABLE quotes           ALTER COLUMN client_local_id TYPE BIGINT;
ALTER TABLE returns          ALTER COLUMN client_local_id TYPE BIGINT;
ALTER TABLE stock_moves      ALTER COLUMN client_local_id TYPE BIGINT;
ALTER TABLE stock_transfers  ALTER COLUMN client_local_id TYPE BIGINT;
ALTER TABLE suppliers        ALTER COLUMN client_local_id TYPE BIGINT;
ALTER TABLE treasury_accounts ALTER COLUMN client_local_id TYPE BIGINT;
ALTER TABLE treasury_moves   ALTER COLUMN client_local_id TYPE BIGINT;
ALTER TABLE vouchers         ALTER COLUMN client_local_id TYPE BIGINT;
