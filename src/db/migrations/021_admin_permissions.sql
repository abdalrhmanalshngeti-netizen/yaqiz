-- صلاحيات دقيقة لموظفي لوحة الإدارة (بدل النموذج الحالي all-or-nothing)
-- role='owner' = تجاوز كامل دائم (المالك الأصلي)، role='staff' = مقيّد بـ permissions[]
ALTER TABLE platform_admins ADD COLUMN IF NOT EXISTS role VARCHAR(20) NOT NULL DEFAULT 'owner';
ALTER TABLE platform_admins ADD COLUMN IF NOT EXISTS permissions TEXT[] NOT NULL DEFAULT '{}';
-- إبطال فوري للجلسات النشطة عند تعديل صلاحيات موظف أو تعطيله
ALTER TABLE platform_admins ADD COLUMN IF NOT EXISTS revoke_sessions_before TIMESTAMPTZ;
ALTER TABLE platform_admins ADD COLUMN IF NOT EXISTS created_by INT REFERENCES platform_admins(id);

-- ملاحظة المعاينة: يكتبها الموظف قبل الدخول بحساب أي شركة (توثيق/مساءلة)
ALTER TABLE impersonation_codes ADD COLUMN IF NOT EXISTS reason TEXT;

-- استلام التذاكر: مين الموظف المسؤول عن التذكرة حالياً
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS assigned_to INT REFERENCES platform_admins(id);

-- ردود التذاكر (محادثة ثنائية الاتجاه: الموظف ⇄ العميل)
CREATE TABLE IF NOT EXISTS ticket_replies (
  id          SERIAL PRIMARY KEY,
  ticket_id   INT NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  author_type VARCHAR(10) NOT NULL CHECK (author_type IN ('admin','company')),
  author_name VARCHAR(200),
  admin_id    INT REFERENCES platform_admins(id),
  message     TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ticket_replies_ticket ON ticket_replies(ticket_id);

-- إشعارات داخل لوحة الإدارة لموظفي المنصة (تذاكر جديدة إلخ)
CREATE TABLE IF NOT EXISTS admin_notifications (
  id         SERIAL PRIMARY KEY,
  admin_id   INT NOT NULL REFERENCES platform_admins(id) ON DELETE CASCADE,
  type       VARCHAR(30) NOT NULL DEFAULT 'ticket',
  title      VARCHAR(200),
  message    TEXT,
  ticket_id  INT REFERENCES support_tickets(id) ON DELETE CASCADE,
  is_read    BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_admin_notif_admin ON admin_notifications(admin_id, is_read);
