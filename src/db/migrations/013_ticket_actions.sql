-- إضافة سجل الإجراءات لكل تذكرة (من يغيّر الحالة ومتى)
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS actions JSONB DEFAULT '[]'::jsonb;
