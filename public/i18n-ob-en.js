// الترجمة الإنجليزية لمعالج الأرصدة الافتتاحية (VVIP.html — showOpeningBalancesWizard).
// المعالج مبني بنصوص عربية كثيرة (منها الدليل التعليمي لكل خطوة)، فبالوضع
// الإنجليزي نترجم ما يظهر للمستخدم فقط بعد الرسم: النصوص والتلميحات
// (placeholder/title/aria-label) — لا قيم الحقول ولا value للخيارات، لأنها
// بيانات تُحفظ كما هي (مثل تكرار الالتزام «شهري»).
(function () {
  const D = {
    'أي مبلغ تكتبه هنا يُسجَّل فورًا كدَين كامل عليك بالميزانية من أول يوم — فأدخل فقط الجزء اللي فعلًا لم تسدده بعد حتى تاريخ اليوم. لا تكتب القيمة الإجمالية لالتزام مستقبلي متكرر (زي إيجار سنة كاملة) وأنت مسدد كل شهر أول بأول — هذا ليس دَينًا عليك فعليًا اليوم.':
      'Any amount you enter here is booked immediately as a liability on your balance sheet from day one — so enter only the part you genuinely haven’t paid as of today. Don’t enter the full value of a future recurring commitment (like a whole year’s rent) if you pay it month by month — that isn’t a debt you owe today.',
    'هذا رقم يُحسَب تلقائيًا من بقية الخطوات — لا تكتب فيه مبلغًا عشوائيًا أو تخمينيًا. عدّله يدويًا فقط لو عندك رقم دقيق موثّق من مصدر خارجي (مثلًا ميزانية سلّمك إياها محاسبك السابق)؛ النظام دائمًا يضمن توازن القيد حتى لو عدّلته لرقم لا يطابق الحساب تمامًا.':
      'This figure is calculated automatically from the other steps — don’t type in a guess. Change it only if you have an exact, documented figure from an outside source (e.g. a balance sheet from your previous accountant); the system always keeps the entry balanced even if you change it.',
    'سعر الشراء هو الرقم اللي يدخل في حساباتك المالية (الكمية × سعر الشراء = قيمة المخزون بالميزانية) — سعر البيع فقط يحدد كم بتبيع فيه هذا الصنف مستقبلًا، وما له أي أثر محاسبي على رصيدك الافتتاحي.':
      'The cost price is what goes into your books (quantity × cost price = inventory value on the balance sheet). The selling price only sets what you’ll sell the item for — it has no effect on your opening balance.',
    'راجع الأرقام قبل الحفظ. سيتم تحديث النقدية وأرصدة العملاء/الموردين والأصول الثابتة ورأس المال فقط — المنتجات والموظفون والالتزامات المُضافة سابقًا لا تتأثر (تُدار من صفحاتها الخاصة).':
      'Check the figures before saving. Only cash, customer/supplier balances, fixed assets and capital will be updated — products, employees and commitments added earlier are not affected (they’re managed from their own pages).',
    'لا تُدخل هنا مورد سددت له كامل مستحقاته — فقط المبلغ المتبقي غير المسدَّد حاليًا. لا تُدخل هنا أيضًا أي التزام دوري ثابت (إيجار، اشتراكات) — لذلك خطوة مستقلة (الالتزامات الدورية).':
      'Don’t add suppliers you’ve paid in full — only the amount still unpaid. Also don’t add recurring commitments (rent, subscriptions) here — they have their own step (Recurring commitments).',
    'لا تُدخل هنا أي مبلغ لعميل مدين لك (تلك خطوة العملاء) ولا أي مبلغ أنت مدين به لمورد (تلك خطوة الموردين) — هذا الحقل حصريًا ما تملكه فعليًا نقدًا أو بالبنك الآن، لا أكثر ولا أقل.':
      'Don’t enter money customers owe you (that’s the Customers step) or money you owe suppliers (that’s the Suppliers step) — this is strictly the cash and bank money you actually have right now.',
    'إذا احتجت لاحقًا تفصيل كل حساب بنكي على حدة (أكثر من بنك)، تقدر تضيف حسابات بنكية إضافية من صفحة «الخزينة» بعد إكمال المعالج — الخطوة هنا بترصد فقط الإجمالي كنقطة بداية.':
      'If you later need each bank account separately (more than one bank), you can add bank accounts from the Treasury page after finishing — this step only records the total as a starting point.',
    'حقلان بس: «رصيد البنك» (المبلغ الموجود بحسابك البنكي) و«رصيد الصندوق» (الكاش الموجود فعليًا لديك). اجمع أرصدة كل حساباتك البنكية برقم واحد إذا كان عندك أكثر من حساب.':
      'Just two fields: “Bank balance” (what’s in your bank account) and “Cash on hand” (the cash you actually have). If you have several bank accounts, add them up into one figure.',
    'لا تُدخل هنا أي بضاعة تُباع للعملاء (تلك خطوة المخزون) ولا أي أصل مستأجر لا تملكه فعليًا (لو تستأجر السيارة أو المعدات، لا تُدخلها هنا إطلاقًا — الملكية شرط أساسي).':
      'Don’t enter goods you sell to customers here (that’s the Inventory step) or anything you rent rather than own (a leased car or equipment doesn’t belong here — ownership is required).',
    'لا تُدخل هنا كامل مبيعاتك التاريخية للعميل — فقط الجزء غير المُسدَّد حاليًا. عميل مسدّد حسابه بالكامل لا يُذكَر هنا إطلاقًا (لا رصيد له = لا داعي لإضافته).':
      'Don’t enter a customer’s full sales history — only what’s still unpaid. A customer who has paid in full doesn’t belong here (no balance, no need to add them).',
    'غيّر الرقم المقترح يدويًا فقط لو كان عندك رقم دقيق من مصدر خارجي (مثلًا ميزانية سلّمك إياها محاسبك السابق). بغير ذلك، اترك الرقم المقترح كما هو.':
      'Change the suggested figure only if you have an exact figure from an outside source (e.g. a balance sheet from your previous accountant). Otherwise, leave it as suggested.',
    'أضف كل عميل عليه مبلغ لك لم يسدده بعد (مبيعات سابقة قبل استخدامك يقظ). المصطلح المحاسبي لهذا الرقم «الذمم المدينة» — فلوس مستحقة لك على الغير.':
      'Add every customer who still owes you money (sales made before you started using Yaqiz). The accounting term is “accounts receivable” — money others owe you.',
    'نفس فكرة خطوة العملاء لكن بالعكس: أضف كل مورد أنت مدين له بمبلغ لم تسدده بعد. المصطلح المحاسبي «الذمم الدائنة» — فلوس مستحقة عليك للغير.':
      'The reverse of the Customers step: add every supplier you still owe money to. The accounting term is “accounts payable” — money you owe others.',
    'رأس المال = إجمالي الأصول − إجمالي الالتزامات. النظام يحسب لك رقمًا مقترحًا تلقائيًا بناءً على كل ما أدخلته بالخطوات السابقة.':
      'Capital = total assets − total liabilities. The system suggests a figure automatically from everything you entered in the previous steps.',
    'يذهب لحساب 3000 «رأس المال الافتتاحي» (دائن) — أو مدين لو كانت التزاماتك أكبر من أصولك (عجز حقيقي، حالة نادرة لكن ممكنة)':
      'Posted to account 3000 “Opening capital” (credit) — or debit if your liabilities exceed your assets (a real deficit, rare but possible)',
    'شاشة أخيرة تلخّص كل شيء أدخلته: إجمالي الأصول، إجمالي الالتزامات، رأس المال، وقائمة تفصيلية بكل عميل ومورد وصنف ومبلغ.':
      'A final screen summarising everything you entered: total assets, total liabilities, capital, and a detailed list of every customer, supplier, item and amount.',
    'الالتزامات الدورية ميزة حصرية للباقة الاحترافية فقط. إذا كان اشتراكك على الأساسية أو النمو، هذي الخطوة لا تظهر لك.':
      'Recurring commitments are a Pro-plan feature. On the Basic or Growth plan, this step doesn’t appear.',
    'أدخل القيمة الدفترية الحالية للأصل (قيمته التقريبية اليوم)، وليس بالضرورة سعر شرائه الأصلي لو مضى عليه وقت طويل.':
      'Enter the asset’s current book value (roughly what it’s worth today), not necessarily its original price if you bought it long ago.',
    'هذي الخطوة لا تظهر لك لو كان اشتراكك على الباقة الأساسية — إدارة العملاء متاحة فقط بباقتَي النمو والاحترافية.':
      'This step doesn’t appear on the Basic plan — customer management is available on Growth and Pro.',
    'أضف موظفيك الحاليين (الاسم، المسمى الوظيفي، الراتب) لتسجيلهم بصفحة «الموظفون» مباشرة جاهزين لأول عملية رواتب.':
      'Add your current employees (name, job title, salary) so they’re ready on the Employees page for your first payroll.',
    'بعد الحفظ، تقدر ترجع تعدّل أي رقم من هذي الأرصدة لاحقًا من الإعدادات ← الأرصدة الافتتاحية ← تعديل، في أي وقت.':
      'After saving, you can change any of these balances later from Settings → Opening balances → Edit, at any time.',
    'أي ممتلكات طويلة الأجل تستخدمها بنشاطك ولا تُباع كبضاعة عادية: سيارة توصيل، أجهزة كمبيوتر، معدات، عقار...':
      'Long-term property you use in the business and don’t sell as stock: a delivery vehicle, computers, equipment, real estate…',
    'هذي الخطوة الوحيدة اللي ما تدخل بحساب رأس المال أو أي قيد محاسبي — فقط لتسجيل بيانات الموظفين.':
      'This is the only step that doesn’t affect capital or create any journal entry — it just records employee details.',
    'أضف كل صنف موجود فعليًا بمخزونك الآن: الاسم، الكمية، سعر الشراء (التكلفة)، وسعر البيع.':
      'Add every item you actually have in stock now: name, quantity, cost price and selling price.',
    'التزامات متكررة تدفعها بانتظام مثل إيجار المكتب أو اشتراك الكهرباء أو تأمين السيارة.':
      'Recurring payments you make regularly, like office rent, the electricity bill or car insurance.',
    'لا يوجد مخزون؟ اضغط «تخطّ» وانتقل للخطوة التالية بدون أي قلق — هذي خطوة اختيارية.':
      'No stock? Press “Skip” and move on — this step is optional.',
    'راجع جميع البيانات قبل الحفظ. بعد الحفظ ستُضاف كل البيانات للنظام تلقائياً.':
      'Review everything before saving. Once saved, all the data is added to the system automatically.',
    'مثال: إيجار الشهر الحالي غير المسدد بعد = 4,000 ريال (مو إيجار سنة كاملة)':
      'Example: this month’s unpaid rent = SAR 4,000 (not a whole year’s rent)',
    'هل تريد تخطّي الأرصدة الافتتاحية الآن؟ يمكنك إضافتها لاحقاً من الإعدادات.':
      'Skip opening balances for now? You can add them later from Settings.',
    'مثال: أصول 67,000 − التزامات 6,500 = رأس مال مقترح 60,500 ريال':
      'Example: assets 67,000 − liabilities 6,500 = suggested capital SAR 60,500',
    'هل تمتلك أصولاً ثابتة مثل سيارات أو أجهزة أو معدات أو عقارات؟':
      'Do you own fixed assets such as vehicles, devices, equipment or property?',
    'رأس المال هو المبلغ الذي استثمرته في المنشأة من مالك الخاص.':
      'Capital is the money you invested in the business from your own funds.',
    'راجع الأصناف المستوردة واضغط «إضافة الكل» أو «إلغاء» أولًا':
      'Review the imported items and press “Add all” or “Cancel” first',
    'مثال: 100 قطعة × 20 ريال سعر شراء = 2,000 ريال قيمة مخزون':
      'Example: 100 pcs × SAR 20 cost = SAR 2,000 inventory value',
    'أدخل الأرصدة النقدية الموجودة لديك في بداية تشغيل المنصة.':
      'Enter the cash balances you have as you start using the platform.',
    'تمام — تلقى خطوات البداية في لوحة التحكم متى ما بغيت':
      'Done — you’ll find the getting-started steps on your dashboard whenever you need them',
    'أدخل الالتزامات الدورية الثابتة التي تدفعها بانتظام.': 'Enter the fixed recurring commitments you pay regularly.',
    'لا يوجد موردون بمبالغ مستحقة — تخطّ إذا لم يكن هناك': 'No suppliers with amounts owed — skip if there are none',
    'لا يوجد عملاء بمبالغ مستحقة — تخطّ إذا لم يكن هناك': 'No customers with amounts owed — skip if there are none',
    'أضف موظفيك الحاليين مع مسمياتهم الوظيفية ورواتبهم.': 'Add your current employees with their job titles and salaries.',
    'مثال: سيارة توصيل بقيمة دفترية حالية 25,000 ريال': 'Example: delivery vehicle with a current book value of SAR 25,000',
    'لم تُضف أي موظفين — تخطّ إذا لم يكن لديك موظفون': 'No employees added — skip if you have none',
    'أدخل العملاء الذين عليهم مبالغ لم تُحصَّل بعد.': 'Enter customers who still owe you money.',
    'أدخل الموردين الذين عليك مبالغ لم تُسدَّد بعد.': 'Enter suppliers you still owe money to.',
    'أضف كل صنف في مخزونك الحالي مع كميته وأسعاره.': 'Add every item in your current stock with its quantity and prices.',
    'لا توجد التزامات دورية — تخطّ إذا لم يكن هناك': 'No recurring commitments — skip if there are none',
    'رصيد الصندوق 5,000 ريال = 35,000 ريال إجمالي': 'cash on hand SAR 5,000 = SAR 35,000 total',
    'مثال: رصيد البنك 30,000 ريال + رصيد الصندوق 5,000 ريال = 35,000 ريال إجمالي': 'Example: bank balance SAR 30,000 + cash on hand SAR 5,000 = SAR 35,000 total',
    'يذهب لحساب 2300 «الالتزامات الدورية» (دائن)': 'Posted to account 2300 “Recurring commitments” (credit)',
    'مثال: متجر الأمل يدين لك بمبلغ 3,000 ريال': 'Example: Al-Amal Store owes you SAR 3,000',
    'مثال: مصنع النور مستحق له مبلغ 2,500 ريال': 'Example: you owe Al-Noor Factory SAR 2,500',
    'مثال: أحمد سعيد — محاسب — راتب 5,000 ريال': 'Example: Ahmed Saeed — accountant — salary SAR 5,000',
    'لم تُضف أي أصناف — يمكنك تخطّي هذه الخطوة': 'No items added — you can skip this step',
    'لا يوجد أصول ثابتة — تخطّ إذا لم يكن هناك': 'No fixed assets — skip if there are none',
    'يذهب لحساب 1100 «النقدية والبنك» (مدين)': 'Posted to account 1100 “Cash and bank” (debit)',
    'يذهب لحساب 1500 «الأصول الثابتة» (مدين)': 'Posted to account 1500 “Fixed assets” (debit)',
    'يذهب لحساب 1200 «الذمم المدينة» (مدين)': 'Posted to account 1200 “Accounts receivable” (debit)',
    'يذهب لحساب 2100 «الذمم الدائنة» (دائن)': 'Posted to account 2100 “Accounts payable” (credit)',
    'يذهب لحساب 1300 «المخزون» (مدين)': 'Posted to account 1300 “Inventory” (debit)',
    'المبلغ الموجود في حسابك البنكي': 'The amount in your bank account',
    'إعداد المنشأة — أرصدة البداية': 'Business setup — opening balances',
    'من دليل الأرصدة الافتتاحية': 'From the opening balances guide',
    'مُضاف مسبقًا بهذه القائمة': 'Already in this list',
    'أدخل اسم الالتزام والمبلغ': 'Enter the commitment name and amount',
    'النقد الموجود لديك فعلياً': 'The cash you actually have',
    'رأس مالك الافتتاحي (ريال)': 'Your opening capital (SAR)',
    'القيمة الدفترية (ريال) *': 'Book value (SAR) *',
    'أدخل اسم العميل والمبلغ': 'Enter the customer name and amount',
    'أدخل اسم المورد والمبلغ': 'Enter the supplier name and amount',
    'المبلغ المستحق (ريال) *': 'Amount owed (SAR) *',
    'مثال: سيارة هايلكس 2022': 'e.g. Hilux 2022',
    'أدخل اسم الصنف والكمية': 'Enter the item name and quantity',
    'إجمالي الأصول الثابتة:': 'Total fixed assets:',
    'موظف — إجمالي الرواتب:': 'employees — total salaries:',
    'المخزون (أبرز الأصناف)': 'Inventory (top items)',
    'أدخل اسم الأصل وقيمته': 'Enter the asset name and value',
    'رصيد الصندوق (النقدي)': 'Cash on hand',
    'إجمالي الذمم المدينة:': 'Total receivables:',
    'إجمالي الذمم الدائنة:': 'Total payables:',
    'إجمالي قيمة المخزون:': 'Total inventory value:',
    'مثال: إيجار المستودع': 'e.g. Warehouse rent',
    'الموردون (ذمم دائنة)': 'Suppliers (payables)',
    'العملاء (ذمم مدينة)': 'Customers (receivables)',
    'الالتزامات الدورية': 'Recurring commitments',
    'إجمالي الالتزامات:': 'Total liabilities:',
    'رأس المال المقترح:': 'Suggested capital:',
    'ملخص المركز المالي': 'Financial position summary',
    'إجمالي الالتزامات': 'Total liabilities',
    'أصول − التزامات)': 'assets − liabilities)',
    'أدخل اسم الموظف': 'Enter the employee name',
    'حفظ والبدء الآن': 'Save and start now',
    'إجمالي النقدية:': 'Total cash:',
    'مثال: زيت زيتون': 'e.g. Olive oil',
    'المبلغ (ريال) *': 'Amount (SAR) *',
    'ملخص ما أدخلته:': 'Summary of what you entered:',
    'النقدية والبنك': 'Cash and bank',
    'الأصول الثابتة': 'Fixed assets',
    'المبلغ المستحق': 'Amount owed',
    'اسم الالتزام *': 'Commitment name *',
    'المسمى الوظيفي': 'Job title',
    'إجمالي الأصول:': 'Total assets:',
    'اقتراح النظام:': 'System suggestion:',
    'مراجعة وتأكيد': 'Review and confirm',
    'الراتب (ريال)': 'Salary (SAR)',
    'الذمم المدينة': 'Accounts receivable',
    'إجمالي الأصول': 'Total assets',
    'الذمم الدائنة': 'Accounts payable',
    'اسم العميل *': 'Customer name *',
    'اسم المورد *': 'Supplier name *',
    'اسم الموظف *': 'Employee name *',
    'الاسم الكامل': 'Full name',
    'قيمة المخزون': 'Inventory value',
    'اسم الصنف *': 'Item name *',
    'اسم الأصل *': 'Asset name *',
    'مثال: محاسب': 'e.g. Accountant',
    'تنبيه مهم:': 'Important:',
    'رصيد البنك': 'Bank balance',
    'سعر الشراء': 'Cost price',
    'اسم العميل': 'Customer name',
    'اسم المورد': 'Supplier name',
    'رأس المال:': 'Capital:',
    'الموظفون (': 'Employees (',
    'رأس المال': 'Capital',
    'تخطّ الآن': 'Skip for now',
    'سعر البيع': 'Selling price',
    'الموردون': 'Suppliers',
    'الموظفون': 'Employees',
    'التالي →': 'Next →',
    '← السابق': '← Back',
    'الكمية *': 'Quantity *',
    'ربع سنوي': 'Quarterly',
    'نصف سنوي': 'Semi-annual',
    'الالتزام': 'Commitment',
    'المخزون': 'Inventory',
    'العملاء': 'Customers',
    'التكرار': 'Frequency',
    'لا يوجد': 'None',
    'العميل': 'Customer',
    'المورد': 'Supplier',
    'الدليل': 'Guide',
    'الخطوة': 'Step',
    'السابق': 'Back',
    'الكمية': 'Quantity',
    'القيمة': 'Value',
    'أسبوعي': 'Weekly',
    'المبلغ': 'Amount',
    'الراتب': 'Salary',
    'رواتب:': 'Salaries:',
    'ملغاة': 'Cancelled',
    'الصنف': 'Item',
    'الأصل': 'Asset',
    'الاسم': 'Name',
    'شهري': 'Monthly',
    'تخطّ': 'Skip',
    'سنوي': 'Annual',
    'ريال': 'SAR',
    'من': 'of',
    '✓ حفظ والبدء الآن': '✓ Save and start now',
    '📖 الدليل': '📖 Guide',
    'مثال': 'Example',
    'الشرح': 'Explanation',
    'أين يذهب بالدفاتر': 'Where it goes in the books',
    'ما لا يُدخل هنا': 'What not to enter here',
    'إضافة': 'Add',
    'حذف': 'Remove',
    'إلغاء': 'Cancel',
    'إضافة الكل': 'Add all',
  };
  const AR = '؀-ۿ';
  const keys = Object.keys(D).sort((a, b) => b.length - a.length);
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // حدود الكلمة العربية: ما نبدّل جزءًا من كلمة أطول (مثل «من» داخل «ضمن»)
  const re = new RegExp(keys.map(k => `(?<![${AR}])${esc(k)}(?![${AR}])`).join('|'), 'g');
  function tr(text) { return text.replace(re, m => D[m] ?? m); }
  window.obLocalize = function (root) {
    if (typeof lang === 'undefined' || lang !== 'en' || !root) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const n of nodes) if (/[؀-ۿ]/.test(n.nodeValue)) n.nodeValue = tr(n.nodeValue);
    root.querySelectorAll('[placeholder],[title],[aria-label]').forEach(e => {
      for (const a of ['placeholder', 'title', 'aria-label']) { const v = e.getAttribute(a); if (v && /[؀-ۿ]/.test(v)) e.setAttribute(a, tr(v)); }
    });
  };
  window.obTr = function (s) { return (typeof lang !== 'undefined' && lang === 'en') ? tr(String(s)) : s; };
})();
