const express = require('express');
const router = express.Router();

// المتصفح يرسل تقارير مخالفة CSP بـContent-Type مختلف عن application/json
// (application/csp-report بالتوجيه القديم report-uri المستخدَم هنا، أو
// application/reports+json بواجهة Reporting API الأحدث) — الـjson parser
// العام بـapp.js ما يتعرّف عليه فيتجاهل الجسم، فنحتاج parser خاص هنا يقبل كل
// الأنواع المحتملة صراحةً
router.post('/', express.json({ type: ['application/json', 'application/csp-report', 'application/reports+json'] }), (req, res) => {
  const body = req.body;
  const report = body?.['csp-report'] || (Array.isArray(body) ? body[0]?.body : null) || body;
  if (report) {
    console.warn('[CSP violation]', JSON.stringify({
      blockedUri: report['blocked-uri'] || report.blockedURL,
      violatedDirective: report['violated-directive'] || report.effectiveDirective,
      documentUri: report['document-uri'] || report.documentURL,
      sourceFile: report['source-file'] || report.sourceFile,
      lineNumber: report['line-number'] || report.lineNumber,
    }));
  }
  res.status(204).end();
});

module.exports = router;
