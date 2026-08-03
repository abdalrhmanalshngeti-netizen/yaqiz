-- cogs_total was only ever computed and stored in the browser's local
-- state (doCheckout/saveNewInvoice), never sent to or stored on the
-- server. Any fresh login/reload re-pulls invoices from the server via
-- invToFE(), which had no cogs_total field, silently resetting COGS to 0
-- and breaking Gross Profit / Net Profit on the Income Statement for any
-- invoice created before the current browser session.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS cogs_total DECIMAL(12,2) DEFAULT 0;
