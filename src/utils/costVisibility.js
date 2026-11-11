// التكلفة (سعر الشراء، سياسة الربح، قيمة المخزون بالتكلفة) لمن يحتاجها فقط — الكاشير
// ملزوم بنقطة البيع: يشوف سعر البيع والكمية، وما توصله التكلفة لا بالشاشة ولا بالبيانات
const COST_PERMS = ['purchases.view', 'reports.view', 'accounts.view', 'inventory.manage'];
const canSeeCost = user => user?.role === 'owner' || (user?.perms || []).some(p => COST_PERMS.includes(p));
const COST_FIELDS = ['buy_price', 'profit_policy_type', 'profit_policy_value', 'auto_price_update'];
const stripCost = (user, row) => {
  if (!row || canSeeCost(user)) return row;
  const out = { ...row };
  for (const k of COST_FIELDS) delete out[k];
  return out;
};
// الفاتورة: تكلفتها (cogs_total وتكلفة كل بند) من نفس الحساسية — تُحذف بالقراءة لمن ما يشوف
// التكلفة. رد إنشاء الفاتورة يبقيها (الجهاز يحتاجها لقيد التكلفة الفعلي FIFO)
const stripInvoiceCost = (user, inv) => {
  if (!inv || canSeeCost(user)) return inv;
  const out = { ...inv };
  delete out.cogs_total;
  if (Array.isArray(out.items)) out.items = out.items.map(it => { const x = { ...it }; delete x.unit_cost; return x; });
  return out;
};
const stripReturnCost = (user, r) => {
  if (!r || canSeeCost(user)) return r;
  const out = { ...r }; delete out.cogs_reversal; return out;
};
// قطاع المستخدم للسندات والمرتجعات: المبيعات تشوف جهة العملاء، والمشتريات جهة الموردين،
// ومن له الحسابات/الخزينة (والمالك) يشوف الكل
const partySector = user => {
  const p = user?.perms || [];
  if (user?.role === 'owner' || p.includes('accounts.view') || p.includes('treasury.view')) return 'all';
  const s = ['sales.view', 'sales.create', 'customers.view', 'pos.access'].some(x => p.includes(x));
  const b = ['purchases.view', 'purchases.create', 'suppliers.view'].some(x => p.includes(x));
  return s && b ? 'all' : s ? 'customers' : b ? 'suppliers' : 'all';
};
module.exports = { canSeeCost, stripCost, stripInvoiceCost, stripReturnCost, partySector, COST_PERMS };
