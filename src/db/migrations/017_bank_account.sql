-- Auto-provision a "bank" type treasury account for existing companies that
-- don't have one yet, so card/transfer/cheque transactions can be routed
-- there separately from the cash account instead of all landing in one pool.
INSERT INTO treasury_accounts (company_id, name, type, balance, is_default)
SELECT c.id, 'الحساب البنكي', 'bank', 0, false
FROM companies c
WHERE NOT EXISTS (
  SELECT 1 FROM treasury_accounts ta WHERE ta.company_id = c.id AND ta.type = 'bank'
);
