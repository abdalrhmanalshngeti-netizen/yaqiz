# nixpacks.toml (aptPkgs = ["postgresql-client"]) لم يوصل pg_dump فعليًا لصورة
# Railway رغم الصياغة الصحيحة موثّقة — بديل Dockerfile مباشر يضمن وجوده بلا
# لبس. باقي الإعداد (تثبيت npm، تشغيل migrate ثم app.js) مطابق تمامًا لما
# كان nixpacks يكتشفه تلقائيًا من package.json.
FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends postgresql-client \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

CMD ["npm", "start"]
