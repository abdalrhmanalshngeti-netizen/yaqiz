# Yaqiz — إعداد قاعدة البيانات
# شغّل هذا الملف بعد تثبيت PostgreSQL

$pgBin = "C:\Program Files\PostgreSQL\17\bin"
$env:PGPASSWORD = "postgres"   # كلمة مرور postgres الرئيسية

Write-Host "1. إنشاء المستخدم والقاعدة..." -ForegroundColor Cyan

& "$pgBin\psql.exe" -U postgres -c "CREATE USER qeema_user WITH PASSWORD 'Qeema@2026!';" 2>$null
& "$pgBin\psql.exe" -U postgres -c "CREATE DATABASE qeema_db OWNER qeema_user;" 2>$null
& "$pgBin\psql.exe" -U postgres -c "GRANT ALL PRIVILEGES ON DATABASE qeema_db TO qeema_user;" 2>$null

Write-Host "2. تشغيل الـ Migration (إنشاء الجداول)..." -ForegroundColor Cyan
Set-Location "C:\Users\abdal\yaqiz-backend"
node src/db/migrate.js

Write-Host "3. إضافة البيانات الأولية..." -ForegroundColor Cyan
node src/db/seeds/init.js

Write-Host ""
Write-Host "✅ قاعدة البيانات جاهزة!" -ForegroundColor Green
Write-Host "   شغّل الخادم بـ: npm run dev" -ForegroundColor Yellow
