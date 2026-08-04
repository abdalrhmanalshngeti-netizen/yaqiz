#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
# إعداد سيرفر Ubuntu للـ Yaqiz Backend
# نفّذ كـ root: bash setup-server.sh
# ═══════════════════════════════════════════════════════════════════
set -e

DOMAIN="yourdomain.com"
DB_USER="yaqiz_user"
DB_PASS="CHANGE_ME_STRONG_PASSWORD"
DB_NAME="yaqiz_db"
APP_DIR="/var/www/yaqiz"

echo "📦 تحديث الحزم..."
apt-get update -qq && apt-get upgrade -y -qq

echo "📦 تثبيت Node.js 22..."
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs

echo "📦 تثبيت PostgreSQL 17..."
sh -c 'echo "deb https://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" > /etc/apt/sources.list.d/pgdg.list'
wget -qO- https://www.postgresql.org/media/keys/ACCC4CF8.asc | apt-key add -
apt-get update -qq
apt-get install -y postgresql-17

echo "📦 تثبيت Nginx, Certbot, PM2..."
apt-get install -y nginx certbot python3-certbot-nginx
npm install -g pm2

echo "🔐 إعداد قاعدة البيانات..."
sudo -u postgres psql -c "CREATE USER $DB_USER WITH PASSWORD '$DB_PASS';"
sudo -u postgres psql -c "CREATE DATABASE $DB_NAME OWNER $DB_USER;"
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE $DB_NAME TO $DB_USER;"

echo "📁 إنشاء مجلد التطبيق..."
mkdir -p $APP_DIR/logs
mkdir -p /var/www/yaqiz/public

echo ""
echo "✅ اكتملت متطلبات السيرفر. الخطوات التالية:"
echo ""
echo "1. ارفع الملفات:"
echo "   rsync -avz ./yaqiz-backend/ root@$DOMAIN:$APP_DIR/"
echo "   scp ./VVIP.html root@$DOMAIN:/var/www/yaqiz/public/"
echo ""
echo "2. على السيرفر:"
echo "   cd $APP_DIR"
echo "   cp .env.production.example .env && nano .env  # عدّل القيم"
echo "   npm install --production"
echo "   node src/db/migrate.js"
echo "   node src/db/seeds/init.js"
echo "   pm2 start ecosystem.config.js --env production"
echo "   pm2 save && pm2 startup"
echo ""
echo "3. Nginx:"
echo "   cp deploy/nginx.conf /etc/nginx/sites-available/yaqiz"
echo "   # عدّل yourdomain.com في الملف"
echo "   ln -s /etc/nginx/sites-available/yaqiz /etc/nginx/sites-enabled/"
echo "   nginx -t && systemctl reload nginx"
echo ""
echo "4. SSL:"
echo "   certbot --nginx -d $DOMAIN -d www.$DOMAIN"
echo ""
echo "🎉 النظام جاهز على https://$DOMAIN"
