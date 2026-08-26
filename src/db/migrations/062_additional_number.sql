ALTER TABLE companies ADD COLUMN IF NOT EXISTS additional_number VARCHAR(4);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS additional_number VARCHAR(4);
