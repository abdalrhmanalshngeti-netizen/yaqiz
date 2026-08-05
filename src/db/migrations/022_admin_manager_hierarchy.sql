-- تسلسل إداري بين موظفي لوحة الإدارة: موظف يقدر يكون مديراً على موظف آخر
ALTER TABLE platform_admins ADD COLUMN IF NOT EXISTS manager_id INT REFERENCES platform_admins(id);

-- تتبّع أي موظف نفّذ كل حدث بسجل النشاط (كان يُسجَّل بالنص فقط بدون FK)
ALTER TABLE platform_log ADD COLUMN IF NOT EXISTS admin_id INT REFERENCES platform_admins(id);
