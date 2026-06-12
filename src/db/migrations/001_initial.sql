-- ============================================================
-- Yaqiz DATABASE — Complete Schema
-- ============================================================

-- ── Sequences ───────────────────────────────────────────────
CREATE SEQUENCE IF NOT EXISTS invoice_seq START 1;
CREATE SEQUENCE IF NOT EXISTS purchase_seq START 1;
CREATE SEQUENCE IF NOT EXISTS quote_seq START 1;
CREATE SEQUENCE IF NOT EXISTS po_seq START 1;
CREATE SEQUENCE IF NOT EXISTS grn_seq START 1;
CREATE SEQUENCE IF NOT EXISTS voucher_seq START 1;
CREATE SEQUENCE IF NOT EXISTS entry_seq START 1;
CREATE SEQUENCE IF NOT EXISTS return_seq START 1;
CREATE SEQUENCE IF NOT EXISTS payroll_seq START 1;

-- ============================================================
-- 1. SYSTEM & USERS
-- ============================================================

CREATE TABLE IF NOT EXISTS companies (
  id                SERIAL PRIMARY KEY,
  name              VARCHAR(200) NOT NULL,
  name_en           VARCHAR(200),
  vat_number        VARCHAR(20) UNIQUE,
  cr_number         VARCHAR(20),
  address           TEXT,
  city              VARCHAR(100),
  phone             VARCHAR(20),
  email             VARCHAR(100),
  logo_url          TEXT,
  zatca_env         VARCHAR(10) DEFAULT 'mock',
  fiscal_year_start DATE DEFAULT '2025-01-01',
  currency          VARCHAR(10) DEFAULT 'SAR',
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  company_id    INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  username      VARCHAR(50) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  full_name     VARCHAR(100) NOT NULL,
  email         VARCHAR(100),
  phone         VARCHAR(20),
  role          VARCHAR(20) NOT NULL DEFAULT 'cashier',
  permissions   TEXT[] DEFAULT '{}',
  pos_access    BOOLEAN DEFAULT false,
  shift_enabled BOOLEAN DEFAULT false,
  active        BOOLEAN DEFAULT true,
  last_login    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(username, company_id)
);

CREATE TABLE IF NOT EXISTS user_sessions (
  id          SERIAL PRIMARY KEY,
  user_id     INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  ip_address  INET,
  user_agent  TEXT,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS login_attempts (
  id           SERIAL PRIMARY KEY,
  username     VARCHAR(50),
  ip_address   INET,
  success      BOOLEAN DEFAULT false,
  attempted_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 2. PRODUCTS & INVENTORY
-- ============================================================

CREATE TABLE IF NOT EXISTS product_categories (
  id         SERIAL PRIMARY KEY,
  company_id INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name       VARCHAR(100) NOT NULL,
  parent_id  INT REFERENCES product_categories(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS units_of_measure (
  id              SERIAL PRIMARY KEY,
  company_id      INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name            VARCHAR(50) NOT NULL,
  base_unit_id    INT REFERENCES units_of_measure(id),
  conversion_rate DECIMAL(12,6) DEFAULT 1,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS products (
  id          SERIAL PRIMARY KEY,
  company_id  INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code        VARCHAR(50),
  barcode     VARCHAR(100),
  name        VARCHAR(200) NOT NULL,
  name_en     VARCHAR(200),
  category_id INT REFERENCES product_categories(id),
  unit_id     INT REFERENCES units_of_measure(id),
  buy_price   DECIMAL(12,2) DEFAULT 0,
  sell_price  DECIMAL(12,2) DEFAULT 0,
  qty         DECIMAL(12,3) DEFAULT 0,
  min_qty     DECIMAL(12,3) DEFAULT 0,
  max_qty     DECIMAL(12,3),
  tax_rate    DECIMAL(5,2) DEFAULT 15,
  is_active   BOOLEAN DEFAULT true,
  image_url   TEXT,
  notes       TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS stock_moves (
  id             SERIAL PRIMARY KEY,
  company_id     INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  product_id     INT NOT NULL REFERENCES products(id),
  type           VARCHAR(10) NOT NULL CHECK (type IN ('in','out')),
  qty            DECIMAL(12,3) NOT NULL,
  balance_before DECIMAL(12,3),
  balance_after  DECIMAL(12,3),
  reason         VARCHAR(100),
  source         VARCHAR(200),
  reference      VARCHAR(100),
  source_type    VARCHAR(30),
  source_id      INT,
  unit_cost      DECIMAL(12,2),
  created_by     INT REFERENCES users(id),
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 3. CUSTOMERS & SUPPLIERS
-- ============================================================

CREATE TABLE IF NOT EXISTS customers (
  id             SERIAL PRIMARY KEY,
  company_id     INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code           VARCHAR(50),
  name           VARCHAR(200) NOT NULL,
  name_en        VARCHAR(200),
  vat_number     VARCHAR(20),
  cr_number      VARCHAR(20),
  phone          VARCHAR(20),
  email          VARCHAR(100),
  address        TEXT,
  city           VARCHAR(100),
  credit_limit   DECIMAL(12,2) DEFAULT 0,
  payment_terms  INT DEFAULT 30,
  balance        DECIMAL(12,2) DEFAULT 0,
  loyalty_points INT DEFAULT 0,
  is_active      BOOLEAN DEFAULT true,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS suppliers (
  id            SERIAL PRIMARY KEY,
  company_id    INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code          VARCHAR(50),
  name          VARCHAR(200) NOT NULL,
  name_en       VARCHAR(200),
  vat_number    VARCHAR(20),
  cr_number     VARCHAR(20),
  phone         VARCHAR(20),
  email         VARCHAR(100),
  address       TEXT,
  city          VARCHAR(100),
  payment_terms INT DEFAULT 30,
  balance       DECIMAL(12,2) DEFAULT 0,
  is_active     BOOLEAN DEFAULT true,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 4. SALES
-- ============================================================

CREATE TABLE IF NOT EXISTS invoices (
  id               SERIAL PRIMARY KEY,
  company_id       INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  invoice_no       VARCHAR(50) NOT NULL,
  invoice_type     VARCHAR(20) DEFAULT 'simplified',
  customer_id      INT REFERENCES customers(id),
  customer_name    VARCHAR(200),
  customer_vat     VARCHAR(20),
  date             DATE NOT NULL,
  due_date         DATE,
  subtotal         DECIMAL(12,2) DEFAULT 0,
  discount_type    VARCHAR(10),
  discount_value   DECIMAL(12,2) DEFAULT 0,
  discount_amount  DECIMAL(12,2) DEFAULT 0,
  taxable_amount   DECIMAL(12,2) DEFAULT 0,
  vat_rate         DECIMAL(5,2) DEFAULT 15,
  vat_amount       DECIMAL(12,2) DEFAULT 0,
  grand_total      DECIMAL(12,2) DEFAULT 0,
  paid_amount      DECIMAL(12,2) DEFAULT 0,
  status           VARCHAR(20) DEFAULT 'issued',
  payment_method   VARCHAR(50),
  notes            TEXT,
  zatca_status     VARCHAR(20) DEFAULT 'pending',
  zatca_uuid       UUID,
  zatca_hash       TEXT,
  qr_code          TEXT,
  created_by       INT REFERENCES users(id),
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(invoice_no, company_id)
);

CREATE TABLE IF NOT EXISTS invoice_items (
  id           SERIAL PRIMARY KEY,
  invoice_id   INT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  product_id   INT REFERENCES products(id),
  product_name VARCHAR(200),
  product_code VARCHAR(50),
  qty          DECIMAL(12,3) NOT NULL,
  unit_price   DECIMAL(12,2) NOT NULL,
  discount     DECIMAL(12,2) DEFAULT 0,
  line_total   DECIMAL(12,2) NOT NULL,
  vat_amount   DECIMAL(12,2) DEFAULT 0,
  sort_order   INT DEFAULT 0
);

CREATE TABLE IF NOT EXISTS quotes (
  id                   SERIAL PRIMARY KEY,
  company_id           INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  quote_no             VARCHAR(50) NOT NULL,
  customer_id          INT REFERENCES customers(id),
  customer_name        VARCHAR(200),
  date                 DATE NOT NULL,
  valid_until          DATE,
  status               VARCHAR(20) DEFAULT 'draft',
  subtotal             DECIMAL(12,2) DEFAULT 0,
  discount_amount      DECIMAL(12,2) DEFAULT 0,
  vat_amount           DECIMAL(12,2) DEFAULT 0,
  grand_total          DECIMAL(12,2) DEFAULT 0,
  notes                TEXT,
  converted_invoice_id INT REFERENCES invoices(id),
  created_by           INT REFERENCES users(id),
  created_at           TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(quote_no, company_id)
);

CREATE TABLE IF NOT EXISTS quote_items (
  id           SERIAL PRIMARY KEY,
  quote_id     INT NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  product_id   INT REFERENCES products(id),
  product_name VARCHAR(200),
  qty          DECIMAL(12,3) NOT NULL,
  unit_price   DECIMAL(12,2) NOT NULL,
  discount     DECIMAL(12,2) DEFAULT 0,
  line_total   DECIMAL(12,2) NOT NULL,
  sort_order   INT DEFAULT 0
);

-- ============================================================
-- 5. PURCHASES (Full Cycle)
-- ============================================================

CREATE TABLE IF NOT EXISTS purchase_orders (
  id              SERIAL PRIMARY KEY,
  company_id      INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  po_no           VARCHAR(50) NOT NULL,
  supplier_id     INT REFERENCES suppliers(id),
  supplier_name   VARCHAR(200),
  date            DATE NOT NULL,
  expected_date   DATE,
  status          VARCHAR(20) DEFAULT 'draft',
  subtotal        DECIMAL(12,2) DEFAULT 0,
  vat_amount      DECIMAL(12,2) DEFAULT 0,
  grand_total     DECIMAL(12,2) DEFAULT 0,
  notes           TEXT,
  created_by      INT REFERENCES users(id),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(po_no, company_id)
);

CREATE TABLE IF NOT EXISTS purchase_order_items (
  id           SERIAL PRIMARY KEY,
  po_id        INT NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  product_id   INT REFERENCES products(id),
  product_name VARCHAR(200),
  ordered_qty  DECIMAL(12,3) NOT NULL,
  received_qty DECIMAL(12,3) DEFAULT 0,
  unit_price   DECIMAL(12,2) NOT NULL,
  line_total   DECIMAL(12,2) NOT NULL
);

CREATE TABLE IF NOT EXISTS goods_receipts (
  id            SERIAL PRIMARY KEY,
  company_id    INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  grn_no        VARCHAR(50) NOT NULL,
  po_id         INT REFERENCES purchase_orders(id),
  supplier_id   INT REFERENCES suppliers(id),
  supplier_name VARCHAR(200),
  received_date DATE NOT NULL,
  status        VARCHAR(20) DEFAULT 'draft',
  notes         TEXT,
  created_by    INT REFERENCES users(id),
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(grn_no, company_id)
);

CREATE TABLE IF NOT EXISTS goods_receipt_items (
  id           SERIAL PRIMARY KEY,
  grn_id       INT NOT NULL REFERENCES goods_receipts(id) ON DELETE CASCADE,
  po_item_id   INT REFERENCES purchase_order_items(id),
  product_id   INT REFERENCES products(id),
  product_name VARCHAR(200),
  ordered_qty  DECIMAL(12,3),
  received_qty DECIMAL(12,3) NOT NULL,
  unit_cost    DECIMAL(12,2)
);

CREATE TABLE IF NOT EXISTS purchases (
  id             SERIAL PRIMARY KEY,
  company_id     INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  purchase_no    VARCHAR(50) NOT NULL,
  supplier_id    INT REFERENCES suppliers(id),
  supplier_name  VARCHAR(200),
  supplier_ref   VARCHAR(100),
  grn_id         INT REFERENCES goods_receipts(id),
  purchase_type  VARCHAR(20) DEFAULT 'goods',
  category       VARCHAR(100),
  description    TEXT,
  date           DATE NOT NULL,
  amount         DECIMAL(12,2) DEFAULT 0,
  vat_amount     DECIMAL(12,2) DEFAULT 0,
  total          DECIMAL(12,2) DEFAULT 0,
  paid_amount    DECIMAL(12,2) DEFAULT 0,
  remaining      DECIMAL(12,2) DEFAULT 0,
  payment_method VARCHAR(50),
  status         VARCHAR(20) DEFAULT 'unpaid',
  deductible     BOOLEAN DEFAULT true,
  notes          TEXT,
  created_by     INT REFERENCES users(id),
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(purchase_no, company_id)
);

-- ============================================================
-- 6. TREASURY & ACCOUNTS
-- ============================================================

CREATE TABLE IF NOT EXISTS treasury_accounts (
  id             SERIAL PRIMARY KEY,
  company_id     INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name           VARCHAR(100) NOT NULL,
  type           VARCHAR(20) DEFAULT 'cash',
  bank_name      VARCHAR(100),
  account_number VARCHAR(50),
  iban           VARCHAR(50),
  balance        DECIMAL(12,2) DEFAULT 0,
  is_default     BOOLEAN DEFAULT false,
  is_active      BOOLEAN DEFAULT true,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS treasury_moves (
  id             SERIAL PRIMARY KEY,
  company_id     INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  account_id     INT NOT NULL REFERENCES treasury_accounts(id),
  type           VARCHAR(10) NOT NULL CHECK (type IN ('in','out','transfer')),
  amount         DECIMAL(12,2) NOT NULL,
  balance_before DECIMAL(12,2),
  balance_after  DECIMAL(12,2),
  description    TEXT,
  reference      VARCHAR(100),
  source_type    VARCHAR(30),
  source_id      INT,
  transfer_to_id INT REFERENCES treasury_accounts(id),
  created_by     INT REFERENCES users(id),
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS vouchers (
  id                 SERIAL PRIMARY KEY,
  company_id         INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  voucher_no         VARCHAR(50) NOT NULL,
  type               VARCHAR(20) NOT NULL CHECK (type IN ('receipt','payment')),
  party_type         VARCHAR(20),
  party_id           INT,
  party_name         VARCHAR(200),
  amount             DECIMAL(12,2) NOT NULL,
  account_id         INT REFERENCES treasury_accounts(id),
  payment_method     VARCHAR(50),
  description        TEXT,
  reference          VARCHAR(100),
  linked_invoice_id  INT REFERENCES invoices(id),
  linked_purchase_id INT REFERENCES purchases(id),
  date               DATE NOT NULL,
  created_by         INT REFERENCES users(id),
  created_at         TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(voucher_no, company_id)
);

CREATE TABLE IF NOT EXISTS chart_of_accounts (
  id         SERIAL PRIMARY KEY,
  company_id INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code       VARCHAR(20) NOT NULL,
  name       VARCHAR(200) NOT NULL,
  name_en    VARCHAR(200),
  type       VARCHAR(30) NOT NULL,
  is_group   BOOLEAN DEFAULT false,
  parent_id  INT REFERENCES chart_of_accounts(id),
  is_active  BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(code, company_id)
);

CREATE TABLE IF NOT EXISTS journal_entries (
  id          SERIAL PRIMARY KEY,
  company_id  INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  entry_no    VARCHAR(50) NOT NULL,
  date        DATE NOT NULL,
  description TEXT,
  source_type VARCHAR(30),
  source_id   INT,
  reference   VARCHAR(100),
  is_posted   BOOLEAN DEFAULT false,
  created_by  INT REFERENCES users(id),
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(entry_no, company_id)
);

CREATE TABLE IF NOT EXISTS journal_items (
  id           SERIAL PRIMARY KEY,
  entry_id     INT NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  account_id   INT NOT NULL REFERENCES chart_of_accounts(id),
  account_code VARCHAR(20),
  account_name VARCHAR(200),
  side         VARCHAR(10) NOT NULL CHECK (side IN ('debit','credit')),
  amount       DECIMAL(12,2) NOT NULL,
  description  TEXT
);

-- ============================================================
-- 7. HR
-- ============================================================

CREATE TABLE IF NOT EXISTS employees (
  id          SERIAL PRIMARY KEY,
  company_id  INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_no VARCHAR(50),
  name        VARCHAR(200) NOT NULL,
  position    VARCHAR(100),
  department  VARCHAR(100),
  national_id VARCHAR(20),
  iqama_no    VARCHAR(20),
  phone       VARCHAR(20),
  email       VARCHAR(100),
  salary      DECIMAL(12,2) DEFAULT 0,
  allowances  DECIMAL(12,2) DEFAULT 0,
  start_date  DATE,
  end_date    DATE,
  status      VARCHAR(20) DEFAULT 'active',
  bank_name   VARCHAR(100),
  iban        VARCHAR(50),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payroll (
  id             SERIAL PRIMARY KEY,
  company_id     INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  payroll_no     VARCHAR(50),
  period_month   INT NOT NULL,
  period_year    INT NOT NULL,
  employee_id    INT NOT NULL REFERENCES employees(id),
  basic_salary   DECIMAL(12,2) DEFAULT 0,
  allowances     DECIMAL(12,2) DEFAULT 0,
  overtime       DECIMAL(12,2) DEFAULT 0,
  deductions     DECIMAL(12,2) DEFAULT 0,
  gosi_employee  DECIMAL(12,2) DEFAULT 0,
  gosi_employer  DECIMAL(12,2) DEFAULT 0,
  net_salary     DECIMAL(12,2) DEFAULT 0,
  payment_date   DATE,
  account_id     INT REFERENCES treasury_accounts(id),
  status         VARCHAR(20) DEFAULT 'draft',
  created_by     INT REFERENCES users(id),
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS shifts (
  id              SERIAL PRIMARY KEY,
  company_id      INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id         INT NOT NULL REFERENCES users(id),
  start_time      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  end_time        TIMESTAMPTZ,
  opening_cash    DECIMAL(12,2) DEFAULT 0,
  closing_cash    DECIMAL(12,2),
  sales_cash      DECIMAL(12,2) DEFAULT 0,
  sales_card      DECIMAL(12,2) DEFAULT 0,
  sales_transfer  DECIMAL(12,2) DEFAULT 0,
  sales_credit    DECIMAL(12,2) DEFAULT 0,
  invoices_count  INT DEFAULT 0,
  status          VARCHAR(20) DEFAULT 'open',
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 8. MISC
-- ============================================================

CREATE TABLE IF NOT EXISTS returns (
  id                 SERIAL PRIMARY KEY,
  company_id         INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  return_no          VARCHAR(50) NOT NULL,
  type               VARCHAR(20) NOT NULL CHECK (type IN ('sales','purchases')),
  party_id           INT,
  party_name         VARCHAR(200),
  product_id         INT REFERENCES products(id),
  product_name       VARCHAR(200),
  qty                DECIMAL(12,3),
  base_amount        DECIMAL(12,2),
  vat_amount         DECIMAL(12,2),
  amount             DECIMAL(12,2),
  reason             TEXT,
  linked_invoice_id  INT REFERENCES invoices(id),
  linked_purchase_id INT REFERENCES purchases(id),
  date               DATE NOT NULL,
  created_by         INT REFERENCES users(id),
  created_at         TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(return_no, company_id)
);

CREATE TABLE IF NOT EXISTS obligations (
  id         SERIAL PRIMARY KEY,
  company_id INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name       VARCHAR(200) NOT NULL,
  category   VARCHAR(100),
  amount     DECIMAL(12,2),
  frequency  VARCHAR(30),
  next_due   DATE,
  vendor     VARCHAR(200),
  account_id INT REFERENCES treasury_accounts(id),
  status     VARCHAR(20) DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS activity_log (
  id          SERIAL PRIMARY KEY,
  company_id  INT REFERENCES companies(id),
  user_id     INT REFERENCES users(id),
  username    VARCHAR(50),
  action      VARCHAR(50),
  entity_type VARCHAR(50),
  entity_id   INT,
  old_values  JSONB,
  new_values  JSONB,
  ip_address  INET,
  details     TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS settings (
  id         SERIAL PRIMARY KEY,
  company_id INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  key        VARCHAR(100) NOT NULL,
  value      TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(key, company_id)
);

CREATE TABLE IF NOT EXISTS notifications (
  id         SERIAL PRIMARY KEY,
  company_id INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id    INT REFERENCES users(id),
  type       VARCHAR(50),
  title      VARCHAR(200),
  message    TEXT,
  link       VARCHAR(200),
  is_read    BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS zatca_submissions (
  id            SERIAL PRIMARY KEY,
  company_id    INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  invoice_id    INT REFERENCES invoices(id),
  uuid          UUID,
  invoice_hash  TEXT,
  qr_data       TEXT,
  xml_content   TEXT,
  status        VARCHAR(20) DEFAULT 'pending',
  response      JSONB,
  submitted_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- INDEXES
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_users_company       ON users(company_id);
CREATE INDEX IF NOT EXISTS idx_products_company    ON products(company_id);
CREATE INDEX IF NOT EXISTS idx_products_barcode    ON products(barcode);
CREATE INDEX IF NOT EXISTS idx_invoices_company    ON invoices(company_id);
CREATE INDEX IF NOT EXISTS idx_invoices_customer   ON invoices(customer_id);
CREATE INDEX IF NOT EXISTS idx_invoices_date       ON invoices(date);
CREATE INDEX IF NOT EXISTS idx_invoices_status     ON invoices(status);
CREATE INDEX IF NOT EXISTS idx_purchases_company   ON purchases(company_id);
CREATE INDEX IF NOT EXISTS idx_purchases_supplier  ON purchases(supplier_id);
CREATE INDEX IF NOT EXISTS idx_stock_moves_product ON stock_moves(product_id);
CREATE INDEX IF NOT EXISTS idx_treasury_moves_acc  ON treasury_moves(account_id);
CREATE INDEX IF NOT EXISTS idx_activity_log_date   ON activity_log(created_at);
CREATE INDEX IF NOT EXISTS idx_login_attempts_time ON login_attempts(attempted_at);
CREATE INDEX IF NOT EXISTS idx_sessions_expires    ON user_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_customers_company   ON customers(company_id);
CREATE INDEX IF NOT EXISTS idx_suppliers_company   ON suppliers(company_id);
CREATE INDEX IF NOT EXISTS idx_quotes_company      ON quotes(company_id);
CREATE INDEX IF NOT EXISTS idx_quotes_date         ON quotes(date);
CREATE INDEX IF NOT EXISTS idx_employees_company   ON employees(company_id);
CREATE INDEX IF NOT EXISTS idx_employees_status    ON employees(status);
CREATE INDEX IF NOT EXISTS idx_obligations_company ON obligations(company_id);
CREATE INDEX IF NOT EXISTS idx_obligations_due     ON obligations(next_due);
CREATE INDEX IF NOT EXISTS idx_payroll_company     ON payroll_runs(company_id);
CREATE INDEX IF NOT EXISTS idx_activity_company    ON activity_log(company_id);
CREATE INDEX IF NOT EXISTS idx_purchases_date      ON purchases(date);
CREATE INDEX IF NOT EXISTS idx_invoice_items_inv   ON invoice_items(invoice_id);
CREATE INDEX IF NOT EXISTS idx_purchase_items_pur  ON purchase_items(purchase_id);
