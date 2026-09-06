# nixpacks.toml (aptPkgs = ["postgresql-client"]) لم يوصل pg_dump فعليًا لصورة
# Railway رغم الصياغة الصحيحة موثّقة — بديل Dockerfile مباشر يضمن وجوده بلا
# لبس. باقي الإعداد (تثبيت npm، تشغيل migrate ثم app.js) مطابق تمامًا لما
# كان nixpacks يكتشفه تلقائيًا من package.json.
FROM node:20-bookworm-slim

# postgresql-client الافتراضي بـDebian bookworm نسخته 15 — وpg_dump يرفض
# صراحةً تفريغ سيرفر أحدث من نسخته (Railway Postgres فعليًا نسخة 18). لازم
# مستودع PGDG الرسمي عشان عميل يطابق نسخة السيرفر أو أحدث منها.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates wget gnupg \
    && apt-get install -y --no-install-recommends postgresql-common \
    && /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y \
    && apt-get install -y --no-install-recommends postgresql-client-18 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

CMD ["npm", "start"]
