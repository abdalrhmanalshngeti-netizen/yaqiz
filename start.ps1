# Yaqiz — تشغيل سريع
# شغّل هذا الملف في كل مرة تريد تشغيل النظام

$pgBin  = "C:\Program Files\PostgreSQL\17\bin"
$pgData = "C:\Users\abdal\pgdata"
$env:Path += ";$pgBin"

# تشغيل PostgreSQL إذا لم يكن يعمل
$pgStatus = & "$pgBin\pg_ctl.exe" -D $pgData status 2>&1
if ($pgStatus -notlike "*server is running*") {
    Write-Host "Starting PostgreSQL..." -ForegroundColor Yellow
    & "$pgBin\pg_ctl.exe" -D $pgData -l "$pgData\pg.log" start
    Start-Sleep -Seconds 2
} else {
    Write-Host "✅ PostgreSQL already running" -ForegroundColor Green
}

# إيقاف أي خادم سابق على 3000
$oldPid = (netstat -ano | Select-String ":3000.*LISTENING") -replace '.*\s+(\d+)$','$1' | Select-Object -First 1
if ($oldPid) {
    Stop-Process -Id $oldPid.Trim() -Force -ErrorAction SilentlyContinue
    Write-Host "Stopped old server (PID $oldPid)" -ForegroundColor Yellow
    Start-Sleep -Seconds 1
}

# تشغيل الخادم
Write-Host "Starting Yaqiz backend on http://localhost:3000" -ForegroundColor Cyan
Set-Location "C:\Users\abdal\yaqiz-backend"
npm run dev
