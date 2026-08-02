// Yaqiz Service Worker — App Shell strategy
const CACHE_NAME = 'yaqiz-v1';
const SHELL_URLS = ['/VVIP.html', '/public/api-client.js', '/public/manifest.json'];

// تثبيت: تحميل App Shell
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(SHELL_URLS).catch(() => {/* ignore individual failures */});
    })
  );
  self.skipWaiting();
});

// تفعيل: حذف الـ cache القديمة
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// طلبات الشبكة
self.addEventListener('fetch', e => {
  const { request } = e;
  const url = new URL(request.url);

  // API calls → دائماً من الشبكة (لا نخزّنها)
  if (url.pathname.startsWith('/api/') || url.pathname === '/health') {
    e.respondWith(fetch(request).catch(() =>
      new Response(JSON.stringify({ success: false, message: 'غير متصل بالإنترنت' }),
        { status: 503, headers: { 'Content-Type': 'application/json' } })
    ));
    return;
  }

  // الـ App Shell → Network first, ثم Cache (يضمن دائماً آخر إصدار)
  if (SHELL_URLS.includes(url.pathname)) {
    e.respondWith(
      fetch(request).then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(request, clone));
        }
        return res;
      }).catch(() => caches.match(request))
    );
    return;
  }

  // باقي الطلبات (خطوط، أيقونات) → Network first
  e.respondWith(
    fetch(request).catch(() => caches.match(request))
  );
});
