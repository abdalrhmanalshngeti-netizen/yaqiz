// تاريخ اليوم بالتوقيت المحلي (يعتمد TZ=Asia/Riyadh المضبوط بالعملية — راجع
// .env) — بدل new Date().toISOString().slice(0,10) اللي يرجّع دائمًا التاريخ
// بتوقيت UTC بغض النظر عن TZ (toISOString لا يتأثر بها إطلاقًا). الفرق يظهر
// فعليًا بين الساعة 00:00 و02:59 بتوقيت السعودية (UTC+3)، حيث UTC لسه باليوم
// السابق — مستند "بلا تاريخ محدَّد" بهذي الساعات كان يُسجَّل بتاريخ الأمس خطأً.
function todayLocalDateStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

module.exports = { todayLocalDateStr };
