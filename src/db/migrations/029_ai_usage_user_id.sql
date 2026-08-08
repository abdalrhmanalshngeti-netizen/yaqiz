-- لتتبع أي مستخدم بالذات استخدم كل ميزة ذكاء اصطناعي (تفريغ فواتير، تحليل،
-- الشات المساعد) — مو بس إجمالي الشركة ككل، لأغراض لوحة الإدارة الداخلية
ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id);
