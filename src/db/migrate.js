require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const db   = require('../config/db');

async function migrate() {
  const migrations = ['001_initial.sql', '002_saas.sql', '003_support_tickets.sql', '004_impersonation.sql', '005_indexes.sql', '006_payments.sql', '007_email.sql', '008_ai.sql', '009_ensure_core.sql', '010_platform_admins.sql', '011_purchase_items.sql', '012_plan_normalization.sql', '013_ticket_actions.sql', '014_dynamic_pricing.sql', '015_treasury_move_method.sql', '016_retroactive_trial.sql', '017_bank_account.sql', '018_invoice_cogs.sql', '019_journal_sync.sql', '020_returns_sync.sql', '021_admin_permissions.sql', '022_admin_manager_hierarchy.sql', '023_admin_password_recovery.sql', '024_session_management.sql', '025_admin_2fa.sql', '026_closed_periods.sql', '027_period_override_password.sql', '028_shift_closing_breakdown.sql', '029_ai_usage_user_id.sql', '030_ai_usage_question_text.sql', '031_ai_usage_answer_text.sql', '032_zatca_phase2_fields.sql', '033_zatca_credentials.sql', '034_zatca_qr_column.sql', '035_zatca_submission_status.sql', '036_user_tours_seen.sql', '037_branches_warehouses.sql', '038_warehouse_stock.sql', '039_branch_shifts_treasury.sql', '040_stock_transfers.sql', '041_default_branch_backfill.sql', '042_branch_limit_override.sql', '043_credit_notes.sql', '044_repair_chain_state_hash.sql', '045_credit_note_invoice_type.sql', '046_indexes_and_constraints.sql', '047_loyalty.sql', '048_bank_recon.sql', '049_per_company_doc_numbering.sql', '050_stock_lots.sql'];
  for (const file of migrations) {
    const filePath = path.join(__dirname, 'migrations', file);
    if (!fs.existsSync(filePath)) continue;
    console.log(`Running ${file}...`);
    const sql = fs.readFileSync(filePath, 'utf8');
    try {
      await db.query(sql);
      console.log(`✅ ${file} completed.`);
    } catch (err) {
      // تجاهل أخطاء "already exists" — تشير لتشغيل سابق ناجح
      if (err.message.includes('already exists') || err.code === '42P07' || err.code === '42701') {
        console.log(`⚠️  ${file} skipped (already applied): ${err.message}`);
      } else {
        console.error(`❌ ${file} failed:`, err.message);
        // لا نوقف التطبيق — نكمل باقي الـ migrations
      }
    }
  }
  await db.pool.end();
}

// timeout يضمن خروج العملية خلال 60 ثانية حتى لو تعلقت
const killer = setTimeout(() => {
  console.log('⏱ Migration timeout — continuing to app start');
  process.exit(0);
}, 60000);

migrate()
  .then(() => { clearTimeout(killer); process.exit(0); })
  .catch(err => { clearTimeout(killer); console.error('Migration fatal:', err.message); process.exit(0); });
