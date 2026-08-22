// عدّاد ترقيم مستقل لكل شركة ولكل نوع مستند — يحل محل التسلسلات العامة
// المشتركة (NEXTVAL('invoice_seq') وغيرها) التي كانت تجعل رقم مستند شركة
// يقفز حسب نشاط شركات أخرى. نفس نمط nextChainInfo() (zatcaHash.service.js):
// upsert ثم قفل الصف عبر FOR UPDATE ثم زيادة، داخل معاملة استدعاء الطرف
// المستدعي نفسها — فمستند فشل إنشاؤه (ROLLBACK) لا يستهلك رقمًا، بعكس
// NEXTVAL اللي لا يتراجع أبدًا مع فشل المعاملة.
async function nextDocNumber(client, companyId, docType) {
  await client.query(`
    INSERT INTO doc_number_counters (company_id, doc_type, last_number)
    VALUES ($1, $2, 0) ON CONFLICT (company_id, doc_type) DO NOTHING
  `, [companyId, docType]);
  const { rows: [row] } = await client.query(
    `SELECT last_number FROM doc_number_counters WHERE company_id = $1 AND doc_type = $2 FOR UPDATE`,
    [companyId, docType]
  );
  const next = row.last_number + 1;
  await client.query(
    `UPDATE doc_number_counters SET last_number = $1 WHERE company_id = $2 AND doc_type = $3`,
    [next, companyId, docType]
  );
  return next;
}

module.exports = { nextDocNumber };
