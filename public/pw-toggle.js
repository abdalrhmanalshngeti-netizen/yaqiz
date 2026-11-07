// زر "إظهار كلمة المرور" (العين) لكل حقل كلمة مرور بالصفحة — يُضاف تلقائيًا،
// حتى للحقول اللي تنرسم لاحقًا داخل النوافذ. الحقول اللي لها زر خاص بها أصلًا
// (data-action="togglePw" بنفس الحاوية) تُترك كما هي
(function () {
  var EYE = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  var EYE_OFF = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.6 5.1A10.8 10.8 0 0 1 12 5c6.4 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.2M6.6 6.6C3.8 8.4 2 12 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/><path d="m3 3 18 18"/></svg>';

  function enhance(input) {
    if (input.dataset.pwEye || input.dataset.noEye !== undefined) return;
    input.dataset.pwEye = '1';
    var parent = input.parentElement;
    if (!parent || parent.querySelector('[data-action="togglePw"]')) return;

    var wrap = document.createElement('span');
    wrap.className = 'pw-eye-wrap';
    wrap.style.cssText = 'position:relative;display:block;';
    parent.insertBefore(wrap, input);
    wrap.appendChild(input);

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pw-eye-btn';
    btn.setAttribute('aria-label', 'إظهار كلمة المرور');
    btn.title = 'إظهار كلمة المرور';
    btn.innerHTML = EYE;
    // الزر بجهة نهاية الحقل (يسار بالعربي) — نفس مكان زر صفحة الدخول
    var rtl = getComputedStyle(input).direction === 'rtl';
    btn.style.cssText = 'position:absolute;top:50%;transform:translateY(-50%);' + (rtl ? 'left' : 'right') + ':8px;' +
      'background:none;border:0;padding:6px;cursor:pointer;color:inherit;opacity:.55;line-height:0;border-radius:6px;';
    var pad = rtl ? 'paddingLeft' : 'paddingRight';
    if ((parseFloat(getComputedStyle(input)[pad]) || 0) < 38) input.style[pad] = '40px';
    if (getComputedStyle(input).marginBottom !== '0px') {
      // الهامش السفلي ينتقل للحاوية حتى يبقى الزر بمنتصف الحقل نفسه
      wrap.style.marginBottom = getComputedStyle(input).marginBottom;
      input.style.marginBottom = '0';
    }
    btn.addEventListener('mousedown', function (e) { e.preventDefault(); }); // ما يسرق التركيز من الحقل
    btn.addEventListener('click', function () {
      var show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.innerHTML = show ? EYE_OFF : EYE;
      var label = show ? 'إخفاء كلمة المرور' : 'إظهار كلمة المرور';
      btn.setAttribute('aria-label', label); btn.title = label;
      btn.style.opacity = show ? '.9' : '.55';
    });
    wrap.appendChild(btn);
  }

  function scan(root) {
    if (root.nodeType !== 1) return;
    if (root.matches && root.matches('input[type="password"]')) enhance(root);
    var list = root.querySelectorAll ? root.querySelectorAll('input[type="password"]') : [];
    for (var i = 0; i < list.length; i++) enhance(list[i]);
  }

  function start() {
    scan(document.body);
    new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var added = muts[i].addedNodes;
        for (var j = 0; j < added.length; j++) scan(added[j]);
      }
    }).observe(document.body, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
