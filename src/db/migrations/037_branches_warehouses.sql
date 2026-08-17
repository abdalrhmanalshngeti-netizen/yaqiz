CREATE TABLE IF NOT EXISTS branches (
  id             SERIAL PRIMARY KEY,
  company_id     INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name           VARCHAR(200) NOT NULL,
  branch_number  VARCHAR(50) NOT NULL,
  address        TEXT,
  phone          VARCHAR(20),
  is_main        BOOLEAN DEFAULT false,
  is_active      BOOLEAN DEFAULT true,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_id, branch_number)
);
CREATE INDEX IF NOT EXISTS idx_branches_company ON branches(company_id);

-- عمدًا بدون قيد UNIQUE يفرض علاقة واحد-لواحد بمستوى قاعدة البيانات — الفرض
-- الفعلي (مستودع نشط واحد لكل فرع حاليًا) يتم بمستوى التطبيق (warehouses.controller.js)
-- عشان يسهل لاحقًا دعم أكثر من مستودع لكل فرع بدون أي تعديل على الـ schema
CREATE TABLE IF NOT EXISTS warehouses (
  id             SERIAL PRIMARY KEY,
  company_id     INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  branch_id      INT NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  name           VARCHAR(200) NOT NULL,
  code           VARCHAR(50),
  is_active      BOOLEAN DEFAULT true,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_warehouses_company ON warehouses(company_id);
CREATE INDEX IF NOT EXISTS idx_warehouses_branch  ON warehouses(branch_id);

CREATE TABLE IF NOT EXISTS pos_points (
  id             SERIAL PRIMARY KEY,
  company_id     INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  warehouse_id   INT NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  name           VARCHAR(200) NOT NULL,
  code           VARCHAR(50),
  is_active      BOOLEAN DEFAULT true,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pos_points_company   ON pos_points(company_id);
CREATE INDEX IF NOT EXISTS idx_pos_points_warehouse ON pos_points(warehouse_id);

-- nullable: حسابات المالك ما تحتاج فرع محدد (يشوف كل الفروع)
ALTER TABLE users ADD COLUMN IF NOT EXISTS branch_id INT REFERENCES branches(id);
CREATE INDEX IF NOT EXISTS idx_users_branch ON users(branch_id);
