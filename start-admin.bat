@echo off
chcp 65001 > nul
title يقظ - تشغيل لوحة المالك

echo جارٍ التحقق من الخادم...
curl -s http://localhost:3000/health > nul 2>&1
if %errorlevel% == 0 (
    echo الخادم يعمل بالفعل.
) else (
    echo بدء تشغيل الخادم...
    cd /d "%~dp0"
    start /B node src/app.js
    timeout /t 2 /nobreak > nul
)

echo فتح لوحة المالك...
start "" "http://localhost:3000/admin"
