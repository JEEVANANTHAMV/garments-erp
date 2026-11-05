-- =====================================================================
-- 155 · Supplier bill (Bills Inward) payment reference (client voice note 05-Nov-2026)
--   "Once the bill is approved its values must NOT change (auto-posted to Tally). After approval the only
--    thing is: when we pay, mark it paid and save the bank reference / UTR number."
--   An APPROVED bill is marked paid on the Bills Inward screen (POST /supplier-bills/:id/mark-paid) with the
--   paid date, payment mode, bank reference / UTR, paid amount (= bill total) and our bank account.
--   A paid bill's payment details are not edited — the payment is reversed back to APPROVED with a reason
--   (POST /supplier-bills/:id/reverse-payment, kept in payment_reversal_* + log_audit) and marked paid again.
-- Idempotent: the runner re-applies files >= 10 on every deploy.
-- =====================================================================
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_supplier_bill' AND COLUMN_NAME='paid_date');
SET @s = IF(@x=0, 'ALTER TABLE trx_supplier_bill ADD COLUMN paid_date DATE NULL COMMENT \'Date the bill was paid\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_supplier_bill' AND COLUMN_NAME='payment_mode');
SET @s = IF(@x=0, 'ALTER TABLE trx_supplier_bill ADD COLUMN payment_mode VARCHAR(10) NULL COMMENT \'NEFT / RTGS / IMPS / CHEQUE / CASH / UPI / OTHER\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_supplier_bill' AND COLUMN_NAME='payment_ref');
SET @s = IF(@x=0, 'ALTER TABLE trx_supplier_bill ADD COLUMN payment_ref VARCHAR(30) NULL COMMENT \'Bank reference / UTR / cheque no (unique per company among paid bills)\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_supplier_bill' AND COLUMN_NAME='paid_amount');
SET @s = IF(@x=0, 'ALTER TABLE trx_supplier_bill ADD COLUMN paid_amount DECIMAL(18,4) NULL COMMENT \'Amount paid (= bill total)\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_supplier_bill' AND COLUMN_NAME='paid_bank_account_id');
SET @s = IF(@x=0, 'ALTER TABLE trx_supplier_bill ADD COLUMN paid_bank_account_id BIGINT UNSIGNED NULL COMMENT \'Our bank account paid from (mst_company_bank_account)\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_supplier_bill' AND COLUMN_NAME='payment_remarks');
SET @s = IF(@x=0, 'ALTER TABLE trx_supplier_bill ADD COLUMN payment_remarks VARCHAR(300) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_supplier_bill' AND COLUMN_NAME='paid_by');
SET @s = IF(@x=0, 'ALTER TABLE trx_supplier_bill ADD COLUMN paid_by BIGINT UNSIGNED NULL, ADD COLUMN paid_at DATETIME NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_supplier_bill' AND COLUMN_NAME='payment_reversal_reason');
SET @s = IF(@x=0, 'ALTER TABLE trx_supplier_bill ADD COLUMN payment_reversal_reason VARCHAR(300) NULL COMMENT \'Last payment reversal (history in log_audit)\', ADD COLUMN payment_reversed_by BIGINT UNSIGNED NULL, ADD COLUMN payment_reversed_at DATETIME NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @x = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_supplier_bill' AND INDEX_NAME='idx_sb_payment_ref');
SET @s = IF(@x=0, 'ALTER TABLE trx_supplier_bill ADD INDEX idx_sb_payment_ref (company_id, payment_ref)', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
