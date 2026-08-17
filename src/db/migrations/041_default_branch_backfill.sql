-- كل شركة بلا أي فرع (سواء قديمة من قبل ميزة الفروع، أو حتى بعدها لو فشل إنشاء
-- الفرع الصامت لأي سبب) تاخذ فرعًا رئيسيًا ضمنيًا تلقائيًا — بلا أي شاشة أو طلب
-- من أي أحد. طالما الشركة ما ضافت فرعًا ثانيًا، هذا الفرع يبقى غير مرئي تمامًا
-- بالواجهة (زي وضع الشركة قبل ميزة الفروع بالضبط).
DO $$
DECLARE
  c RECORD;
  new_branch_id INT;
  new_warehouse_id INT;
BEGIN
  FOR c IN SELECT id FROM companies WHERE NOT EXISTS (SELECT 1 FROM branches WHERE company_id = companies.id)
  LOOP
    INSERT INTO branches (company_id, name, branch_number, is_main, is_active)
    VALUES (c.id, 'الفرع الرئيسي', '1', true, true)
    RETURNING id INTO new_branch_id;

    INSERT INTO warehouses (company_id, branch_id, name)
    VALUES (c.id, new_branch_id, 'المستودع الرئيسي')
    RETURNING id INTO new_warehouse_id;

    INSERT INTO product_stock (company_id, product_id, warehouse_id, qty)
    SELECT company_id, id, new_warehouse_id, qty FROM products WHERE company_id = c.id AND qty <> 0;

    UPDATE treasury_accounts SET branch_id = new_branch_id
    WHERE company_id = c.id AND is_default = true AND type = 'cash' AND branch_id IS NULL;
  END LOOP;
END $$;
