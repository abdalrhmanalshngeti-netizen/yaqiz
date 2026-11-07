// تحليلات سلوك الزوار والمستخدمين (PostHog — سيرفر أوروبا)
// - الصفحات العامة (الرئيسية، الاشتراك): تُسجَّل كاملة ما عدا الحقول
// - داخل التطبيق (VVIP.html): كل النصوص والأرقام والحقول مخفية بالتسجيل،
//   يظهر فقط وين ضغط المستخدم ووين تنقّل — بيانات المحل المالية لا تطلع أبدًا
// - لا يعمل على البيئة المحلية إلا لو localStorage.yaqiz_ph_local = '1'
(function () {
  var ph = window.posthog;
  // واجهة آمنة تستدعيها الصفحات حتى لو PostHog ما تحمّل أو محجوب
  window.yqTrack = function () {};
  window.yqIdentify = function () {};
  window.yqReset = function () {};
  window.yqPage = function () {};
  if (!ph || typeof ph.init !== 'function') return;

  var host = location.hostname;
  var isLocal = host === 'localhost' || host === '127.0.0.1';
  try { if (isLocal && localStorage.getItem('yaqiz_ph_local') !== '1') return; } catch (e) { if (isLocal) return; }

  var inApp = /^\/VVIP/.test(location.pathname);

  // حذف معاملات الروابط (قد تحمل رموزًا أو معرّفات) مع الإبقاء على utm_* لمعرفة مصدر الزائر
  function cleanUrl(u) {
    if (typeof u !== 'string' || u.indexOf('?') < 0 || !/^https?:\/\//.test(u)) return u;
    try {
      var x = new URL(u), keep = new URLSearchParams();
      x.searchParams.forEach(function (v, k) { if (/^utm_/.test(k)) keep.append(k, v); });
      x.search = keep.toString();
      return x.toString();
    } catch (e) { return u.split('?')[0]; }
  }
  function cleanObj(o, depth) {
    if (!o || typeof o !== 'object' || (depth || 0) > 4) return;
    for (var k in o) {
      if (typeof o[k] === 'string') o[k] = cleanUrl(o[k]);
      else if (o[k] && typeof o[k] === 'object' && k !== '$snapshot_data') cleanObj(o[k], (depth || 0) + 1);
    }
  }

  // تسجيل الجلسة يخفي النصوص والحقول، لكن خصائص العناصر تمر كما هي — وبالتطبيق
  // بعضها يحمل بيانات المحل (title فيه اسم المستخدم، data-args فيها أسماء
  // عملاء/أصناف…). نبقي فقط الخصائص اللازمة لرسم الشكل ونخفي الباقي.
  // وبكل الصفحات: أداة التسجيل تحوّل روابط مثل #features لروابط كاملة
  // بمعاملات الصفحة الحالية، فننظّف href/src أيضًا
  var SAFE_ATTR = /^(class|id|style|type|role|rel|href|src|width|height|viewBox|xmlns|fill|stroke|stroke-width|stroke-linecap|stroke-linejoin|stroke-dasharray|d|cx|cy|r|rx|ry|x|y|x1|y1|x2|y2|points|transform|offset|stop-color|stop-opacity|opacity|gradientUnits|preserveAspectRatio|disabled|checked|selected|readonly|multiple|hidden|open|colspan|rowspan|dir|lang|tabindex|for|name|media|charset|aria-hidden|aria-current|aria-modal|rr_\w+|_cssText)$/;
  function scrubAttrs(a) {
    if (!a) return;
    for (var k in a) {
      if (a[k] === null || typeof a[k] === 'object') continue;
      if (k === 'href' || k === 'src') a[k] = cleanUrl(a[k]);
      else if (inApp && !SAFE_ATTR.test(k)) a[k] = '*';
    }
  }
  function scrubNode(n) {
    if (!n) return;
    scrubAttrs(n.attributes);
    if (n.childNodes) n.childNodes.forEach(scrubNode);
  }
  function scrubSnapshot(e) {
    if (!e || !e.data) return;
    if (e.type === 2) scrubNode(e.data.node);                       // لقطة كاملة
    else if (e.type === 3 && e.data.source === 0) {                 // تغييرات DOM
      (e.data.adds || []).forEach(function (x) { scrubNode(x.node); });
      (e.data.attributes || []).forEach(function (x) { scrubAttrs(x.attributes); });
    }
  }

  ph.init('phc_Av8umGPL86JgGjE2tbgEhusiEj8gA47xkmXwAJmqFSx8', {
    // عبر وسيط السيرفر (src/routes/ingest.routes.js) — CSP يبقى 'self' فقط
    api_host: '/ingest',
    ui_host: 'https://eu.posthog.com',
    person_profiles: 'identified_only',
    disable_external_dependency_loading: true,
    disable_surveys: true,
    // مقفلة صراحةً بالكود: لوحة PostHog تقدر تشغّلها عن بُعد لو تُركت بلا قيمة،
    // وهي تلتقط ردود الـAPI وسجل الكونسول ورسائل الأخطاء — أي بيانات المحل نفسها
    capture_performance: false,
    enable_recording_console_log: false,
    capture_exceptions: false,
    // التطبيق صفحة واحدة: التنقل بين أقسامه يُرسَل يدويًا عبر yqPage
    capture_pageview: !inApp,
    capture_pageleave: true,
    mask_all_text: inApp,
    mask_all_element_attributes: inApp,
    session_recording: {
      maskAllInputs: true,
      recordHeaders: false,
      recordBody: false,
      maskTextSelector: inApp ? '*' : null,
      blockSelector: inApp ? 'img, canvas' : null,
      // اللقطات غير مضغوطة حتى يقدر before_send ينظّف خصائصها
      // (الطلب نفسه يُضغط عند الإرسال على أي حال)
      compress_events: false
    },
    before_send: function (ev) {
      if (!ev) return ev;
      // لو فشل التنظيف لأي سبب يُسقط الحدث بدل ما يُرسل بلا تنظيف
      try {
        // الروابط تظهر بأكثر من خاصية ($current_url، $session_entry_url، $initial_*…)
        cleanObj(ev.properties); cleanObj(ev.$set); cleanObj(ev.$set_once);
        var snaps = ev.properties && ev.properties.$snapshot_data;
        if (Array.isArray(snaps)) snaps.forEach(function (s) {
          if (s && s.data) cleanObj(s.data);
          scrubSnapshot(s);
        });
        return ev;
      } catch (e) { return null; }
    }
  });

  window.yqTrack = function (name, props) {
    try { ph.capture(name, props || {}); } catch (e) {}
  };
  window.yqPage = function (page) {
    try { ph.capture('$pageview', { $current_url: location.origin + location.pathname + '#' + page, page: page }); } catch (e) {}
  };
  // يربط الجلسة بالشركة والمستخدم (أرقام تعريف + الباقة + الدور فقط، بلا بيانات شخصية)
  window.yqIdentify = function (info) {
    try {
      if (!info || !info.user_id) return;
      var id = 'u' + info.user_id;
      if (ph.get_distinct_id && ph.get_distinct_id() === id) return;
      ph.identify(id, { company_id: info.company_id, role: info.role, plan: info.plan });
      if (info.company_id) ph.group('company', 'c' + info.company_id, { name: info.company_name || '', plan: info.plan });
    } catch (e) {}
  };
  window.yqReset = function () {
    try { ph.reset(); } catch (e) {}
  };

  // الصفحات تستدعي yq('Track', ...) قبل ما يتحمّل هذا الملف (يُحمَّل defer) —
  // نفرّغ الطابور المتراكم الآن، وأي نداء بعده يُنفَّذ فورًا
  window._yqFlush = function () {
    var q = window._yqQ || [];
    window._yqQ = [];
    q.forEach(function (c) { var fn = window['yq' + c[0]]; if (typeof fn === 'function') fn.apply(null, c[1]); });
  };
  window._yqFlush();
})();
