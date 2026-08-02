/**
 * Yaqiz API Client
 * أضف هذا الملف في VVIP.html قبل سكريبت النظام:
 * <script src="api-client.js"></script>
 */

const YaqizAPI = (() => {
  const BASE = 'http://localhost:3000';

  let _accessToken  = localStorage.getItem('yaqiz_access_token');
  let _refreshToken = localStorage.getItem('yaqiz_refresh_token');
  let _user         = JSON.parse(localStorage.getItem('yaqiz_user') || 'null');

  // ── طلب مع تجديد تلقائي للـ Token ─────────────────────────
  async function request(method, path, body) {
    const doFetch = (token) => fetch(BASE + path, {
      method,
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });

    let res = await doFetch(_accessToken);

    if (res.status === 401) {
      const data = await res.clone().json().catch(() => ({}));
      if (data.code === 'TOKEN_EXPIRED' && _refreshToken) {
        const r = await fetch(`${BASE}/api/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken: _refreshToken })
        });
        if (r.ok) {
          const refreshData = await r.json();
          _accessToken = refreshData.accessToken;
          localStorage.setItem('yaqiz_access_token', _accessToken);
          res = await doFetch(_accessToken);
        } else {
          _logout();
          return null;
        }
      } else {
        _logout();
        return null;
      }
    }

    if (!res.ok) {
      const err = await res.json().catch(() => ({ message: 'خطأ في الخادم' }));
      throw new Error(err.message || 'خطأ غير معروف');
    }
    return res.json();
  }

  function _logout() {
    localStorage.removeItem('yaqiz_access_token');
    localStorage.removeItem('yaqiz_refresh_token');
    localStorage.removeItem('yaqiz_user');
    _accessToken = _refreshToken = _user = null;
    // إعادة تحميل الصفحة لعرض شاشة تسجيل الدخول
    window.dispatchEvent(new Event('yaqiz:session-expired'));
  }

  // ── Auth ────────────────────────────────────────────────────
  async function login(username, password) {
    const res = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.message);

    _accessToken  = data.accessToken;
    _refreshToken = data.refreshToken;
    _user         = data.user;
    localStorage.setItem('yaqiz_access_token',  _accessToken);
    localStorage.setItem('yaqiz_refresh_token', _refreshToken);
    localStorage.setItem('yaqiz_user',          JSON.stringify(_user));
    return _user;
  }

  async function logout() {
    if (_refreshToken) {
      await fetch(`${BASE}/api/auth/logout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: _refreshToken })
      }).catch(() => {});
    }
    _logout();
  }

  const isLoggedIn = () => !!_accessToken;
  const getUser    = () => _user;

  // ── CRUD helpers ─────────────────────────────────────────────
  const get    = (path)       => request('GET',    path);
  const post   = (path, body) => request('POST',   path, body);
  const put    = (path, body) => request('PUT',    path, body);
  const del    = (path)       => request('DELETE', path);

  // ── Domain shortcuts ─────────────────────────────────────────
  const products = {
    list:       (q)     => get(`/api/products?${new URLSearchParams(q||{})}`),
    getOne:     (id)    => get(`/api/products/${id}`),
    create:     (data)  => post('/api/products', data),
    update:     (id, d) => put(`/api/products/${id}`, d),
    moves:      (id, q) => get(`/api/products/${id}/moves?${new URLSearchParams(q||{})}`),
    manualMove: (id, d) => post(`/api/products/${id}/move`, d),
  };

  const customers = {
    list:      (q)     => get(`/api/customers?${new URLSearchParams(q||{})}`),
    getOne:    (id)    => get(`/api/customers/${id}`),
    create:    (data)  => post('/api/customers', data),
    update:    (id, d) => put(`/api/customers/${id}`, d),
    statement: (id, q) => get(`/api/customers/${id}/statement?${new URLSearchParams(q||{})}`),
  };

  const suppliers = {
    list:      (q)     => get(`/api/suppliers?${new URLSearchParams(q||{})}`),
    getOne:    (id)    => get(`/api/suppliers/${id}`),
    create:    (data)  => post('/api/suppliers', data),
    update:    (id, d) => put(`/api/suppliers/${id}`, d),
    statement: (id, q) => get(`/api/suppliers/${id}/statement?${new URLSearchParams(q||{})}`),
  };

  const invoices = {
    list:       (q)     => get(`/api/invoices?${new URLSearchParams(q||{})}`),
    getOne:     (id)    => get(`/api/invoices/${id}`),
    create:     (data)  => post('/api/invoices', data),
    update:     (id, d) => put(`/api/invoices/${id}`, d),
    addPayment: (id, d) => post(`/api/invoices/${id}/payment`, d),
    cancel:     (id)    => post(`/api/invoices/${id}/cancel`, {}),
  };

  const purchases = {
    list:       (q)     => get(`/api/purchases?${new URLSearchParams(q||{})}`),
    getOne:     (id)    => get(`/api/purchases/${id}`),
    create:     (data)  => post('/api/purchases', data),
    addPayment: (id, d) => post(`/api/purchases/${id}/payment`, d),
  };

  const treasury = {
    accounts:      (q)     => get(`/api/treasury/accounts?${new URLSearchParams(q||{})}`),
    createAccount: (data)  => post('/api/treasury/accounts', data),
    transfer:      (data)  => post('/api/treasury/transfer', data),
    moves:         (q)     => get(`/api/treasury/moves?${new URLSearchParams(q||{})}`),
    vouchers:      (q)     => get(`/api/treasury/vouchers?${new URLSearchParams(q||{})}`),
    createVoucher: (data)  => post('/api/treasury/vouchers', data),
  };

  const employees = {
    list:           (q)     => get(`/api/employees?${new URLSearchParams(q||{})}`),
    create:         (data)  => post('/api/employees', data),
    update:         (id, d) => put(`/api/employees/${id}`, d),
    payroll:        (q)     => get(`/api/employees/payroll/list?${new URLSearchParams(q||{})}`),
    generatePayroll:(data)  => post('/api/employees/payroll/generate', data),
    markPaid:       (id, d) => put(`/api/employees/payroll/${id}/pay`, d),
    shifts:         (q)     => get(`/api/employees/shifts/list?${new URLSearchParams(q||{})}`),
    openShift:      (data)  => post('/api/employees/shifts/open', data),
    closeShift:     (id, d) => put(`/api/employees/shifts/${id}/close`, d),
  };

  const reports = {
    dashboard:       ()  => get('/api/reports/dashboard'),
    vat:             (q) => get(`/api/reports/vat?${new URLSearchParams(q||{})}`),
    incomeStatement: (q) => get(`/api/reports/income-statement?${new URLSearchParams(q||{})}`),
    balanceSheet:    ()  => get('/api/reports/balance-sheet'),
    customerAging:   ()  => get('/api/reports/aging/customers'),
    supplierAging:   ()  => get('/api/reports/aging/suppliers'),
    lowStock:        ()  => get('/api/reports/low-stock'),
  };

  const users = {
    list:           ()      => get('/api/users'),
    create:         (data)  => post('/api/users', data),
    update:         (id, d) => put(`/api/users/${id}`, d),
    changePassword: (id, d) => put(`/api/users/${id}/password`, d),
    remove:         (id)    => del(`/api/users/${id}`),
  };

  return {
    login, logout, isLoggedIn, getUser,
    get, post, put, del,
    products, customers, suppliers, invoices,
    purchases, treasury, employees, reports, users
  };
})();

// ── حدث انتهاء الجلسة ─────────────────────────────────────────
window.addEventListener('yaqiz:session-expired', () => {
  alert('انتهت جلستك. سيتم إعادة تسجيل الدخول.');
  location.reload();
});
