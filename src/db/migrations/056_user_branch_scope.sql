-- يسمح بمنح موظف غير المالك صلاحية العمل على كل فروع الشركة (بدل فرع واحد
-- ثابت فقط) — false افتراضيًا يحافظ على سلوك كل مستخدم حالي بلا أي تغيير.
ALTER TABLE users ADD COLUMN IF NOT EXISTS all_branches BOOLEAN NOT NULL DEFAULT false;
