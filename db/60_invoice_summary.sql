-- =====================================================================
-- 60. COMMON INVOICE FINANCIAL SUMMARY
-- ---------------------------------------------------------------------
-- Client review 24-Sep-2026 (Bills Inward): one summary block on every
-- purchase / inward screen -- taxable, CGST+SGST or IGST, TDS (section +
-- %, deducted), TCS (% , added), other charges (+/- with a label), import
-- landed heads (freight, insurance, customs, clearing), round off and the
-- net payable. All fields optional, default 0.
--
-- Net payable is stored in the table's existing total column:
--   trx_supplier_bill.total_amount, trx_grn.grand_total,
--   trx_trim_grn.net_amount, trx_general_purchase.grand_total.
-- trx_grn keeps its existing tcs_rate / tcs_applicable (no tcs_pct).
-- Every statement is idempotent: the migrate runner re-applies files.
-- =====================================================================


-- trx_supplier_bill
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_supplier_bill' AND COLUMN_NAME='cgst_amount');
SET @s = IF(@x=0, 'ALTER TABLE trx_supplier_bill ADD COLUMN cgst_amount DECIMAL(18,4) NULL DEFAULT 0 COMMENT \'CGST total\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_supplier_bill' AND COLUMN_NAME='sgst_amount');
SET @s = IF(@x=0, 'ALTER TABLE trx_supplier_bill ADD COLUMN sgst_amount DECIMAL(18,4) NULL DEFAULT 0 COMMENT \'SGST total\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_supplier_bill' AND COLUMN_NAME='igst_amount');
SET @s = IF(@x=0, 'ALTER TABLE trx_supplier_bill ADD COLUMN igst_amount DECIMAL(18,4) NULL DEFAULT 0 COMMENT \'IGST total\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_supplier_bill' AND COLUMN_NAME='freight_charges');
SET @s = IF(@x=0, 'ALTER TABLE trx_supplier_bill ADD COLUMN freight_charges DECIMAL(18,4) NULL DEFAULT 0 COMMENT \'Freight / transport\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_supplier_bill' AND COLUMN_NAME='insurance');
SET @s = IF(@x=0, 'ALTER TABLE trx_supplier_bill ADD COLUMN insurance DECIMAL(18,4) NULL DEFAULT 0 COMMENT \'Insurance (imports)\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_supplier_bill' AND COLUMN_NAME='customs_duty');
SET @s = IF(@x=0, 'ALTER TABLE trx_supplier_bill ADD COLUMN customs_duty DECIMAL(18,4) NULL DEFAULT 0 COMMENT \'Customs / basic duty (imports)\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_supplier_bill' AND COLUMN_NAME='clearing_charges');
SET @s = IF(@x=0, 'ALTER TABLE trx_supplier_bill ADD COLUMN clearing_charges DECIMAL(18,4) NULL DEFAULT 0 COMMENT \'Clearing / CHA charges (imports)\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_supplier_bill' AND COLUMN_NAME='other_charges');
SET @s = IF(@x=0, 'ALTER TABLE trx_supplier_bill ADD COLUMN other_charges DECIMAL(18,4) NULL DEFAULT 0 COMMENT \'Other charges (magnitude)\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_supplier_bill' AND COLUMN_NAME='other_charges_label');
SET @s = IF(@x=0, 'ALTER TABLE trx_supplier_bill ADD COLUMN other_charges_label VARCHAR(80) NULL COMMENT \'Other charges caption\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_supplier_bill' AND COLUMN_NAME='other_charges_sign');
SET @s = IF(@x=0, 'ALTER TABLE trx_supplier_bill ADD COLUMN other_charges_sign TINYINT NOT NULL DEFAULT 1 COMMENT \'+1 = added, -1 = deducted\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_supplier_bill' AND COLUMN_NAME='tds_section');
SET @s = IF(@x=0, 'ALTER TABLE trx_supplier_bill ADD COLUMN tds_section VARCHAR(30) NULL COMMENT \'TDS section e.g. 194Q / 194C\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_supplier_bill' AND COLUMN_NAME='tds_pct');
SET @s = IF(@x=0, 'ALTER TABLE trx_supplier_bill ADD COLUMN tds_pct DECIMAL(6,4) NULL DEFAULT 0 COMMENT \'TDS % on taxable value\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_supplier_bill' AND COLUMN_NAME='tds_amount');
SET @s = IF(@x=0, 'ALTER TABLE trx_supplier_bill ADD COLUMN tds_amount DECIMAL(18,4) NULL DEFAULT 0 COMMENT \'TDS deducted\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_supplier_bill' AND COLUMN_NAME='tcs_section');
SET @s = IF(@x=0, 'ALTER TABLE trx_supplier_bill ADD COLUMN tcs_section VARCHAR(30) NULL COMMENT \'TCS section e.g. 206C(1H)\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_supplier_bill' AND COLUMN_NAME='tcs_pct');
SET @s = IF(@x=0, 'ALTER TABLE trx_supplier_bill ADD COLUMN tcs_pct DECIMAL(6,4) NULL DEFAULT 0 COMMENT \'TCS % on invoice value\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_supplier_bill' AND COLUMN_NAME='tcs_amount');
SET @s = IF(@x=0, 'ALTER TABLE trx_supplier_bill ADD COLUMN tcs_amount DECIMAL(18,4) NULL DEFAULT 0 COMMENT \'TCS collected\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_supplier_bill' AND COLUMN_NAME='round_off');
SET @s = IF(@x=0, 'ALTER TABLE trx_supplier_bill ADD COLUMN round_off DECIMAL(10,4) NULL DEFAULT 0 COMMENT \'Round off (+/-)\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- trx_grn
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_grn' AND COLUMN_NAME='cgst_amount');
SET @s = IF(@x=0, 'ALTER TABLE trx_grn ADD COLUMN cgst_amount DECIMAL(18,4) NULL DEFAULT 0 COMMENT \'CGST total\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_grn' AND COLUMN_NAME='sgst_amount');
SET @s = IF(@x=0, 'ALTER TABLE trx_grn ADD COLUMN sgst_amount DECIMAL(18,4) NULL DEFAULT 0 COMMENT \'SGST total\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_grn' AND COLUMN_NAME='igst_amount');
SET @s = IF(@x=0, 'ALTER TABLE trx_grn ADD COLUMN igst_amount DECIMAL(18,4) NULL DEFAULT 0 COMMENT \'IGST total\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_grn' AND COLUMN_NAME='freight_charges');
SET @s = IF(@x=0, 'ALTER TABLE trx_grn ADD COLUMN freight_charges DECIMAL(18,4) NULL DEFAULT 0 COMMENT \'Freight / transport\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_grn' AND COLUMN_NAME='insurance');
SET @s = IF(@x=0, 'ALTER TABLE trx_grn ADD COLUMN insurance DECIMAL(18,4) NULL DEFAULT 0 COMMENT \'Insurance (imports)\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_grn' AND COLUMN_NAME='customs_duty');
SET @s = IF(@x=0, 'ALTER TABLE trx_grn ADD COLUMN customs_duty DECIMAL(18,4) NULL DEFAULT 0 COMMENT \'Customs / basic duty (imports)\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_grn' AND COLUMN_NAME='clearing_charges');
SET @s = IF(@x=0, 'ALTER TABLE trx_grn ADD COLUMN clearing_charges DECIMAL(18,4) NULL DEFAULT 0 COMMENT \'Clearing / CHA charges (imports)\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_grn' AND COLUMN_NAME='other_charges');
SET @s = IF(@x=0, 'ALTER TABLE trx_grn ADD COLUMN other_charges DECIMAL(18,4) NULL DEFAULT 0 COMMENT \'Other charges (magnitude)\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_grn' AND COLUMN_NAME='other_charges_label');
SET @s = IF(@x=0, 'ALTER TABLE trx_grn ADD COLUMN other_charges_label VARCHAR(80) NULL COMMENT \'Other charges caption\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_grn' AND COLUMN_NAME='other_charges_sign');
SET @s = IF(@x=0, 'ALTER TABLE trx_grn ADD COLUMN other_charges_sign TINYINT NOT NULL DEFAULT 1 COMMENT \'+1 = added, -1 = deducted\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_grn' AND COLUMN_NAME='tds_section');
SET @s = IF(@x=0, 'ALTER TABLE trx_grn ADD COLUMN tds_section VARCHAR(30) NULL COMMENT \'TDS section e.g. 194Q / 194C\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_grn' AND COLUMN_NAME='tds_pct');
SET @s = IF(@x=0, 'ALTER TABLE trx_grn ADD COLUMN tds_pct DECIMAL(6,4) NULL DEFAULT 0 COMMENT \'TDS % on taxable value\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_grn' AND COLUMN_NAME='tds_amount');
SET @s = IF(@x=0, 'ALTER TABLE trx_grn ADD COLUMN tds_amount DECIMAL(18,4) NULL DEFAULT 0 COMMENT \'TDS deducted\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_grn' AND COLUMN_NAME='tcs_section');
SET @s = IF(@x=0, 'ALTER TABLE trx_grn ADD COLUMN tcs_section VARCHAR(30) NULL COMMENT \'TCS section e.g. 206C(1H)\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_grn' AND COLUMN_NAME='tcs_amount');
SET @s = IF(@x=0, 'ALTER TABLE trx_grn ADD COLUMN tcs_amount DECIMAL(18,4) NULL DEFAULT 0 COMMENT \'TCS collected\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_grn' AND COLUMN_NAME='round_off');
SET @s = IF(@x=0, 'ALTER TABLE trx_grn ADD COLUMN round_off DECIMAL(10,4) NULL DEFAULT 0 COMMENT \'Round off (+/-)\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- trx_trim_grn
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_trim_grn' AND COLUMN_NAME='cgst_amount');
SET @s = IF(@x=0, 'ALTER TABLE trx_trim_grn ADD COLUMN cgst_amount DECIMAL(18,4) NULL DEFAULT 0 COMMENT \'CGST total\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_trim_grn' AND COLUMN_NAME='sgst_amount');
SET @s = IF(@x=0, 'ALTER TABLE trx_trim_grn ADD COLUMN sgst_amount DECIMAL(18,4) NULL DEFAULT 0 COMMENT \'SGST total\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_trim_grn' AND COLUMN_NAME='igst_amount');
SET @s = IF(@x=0, 'ALTER TABLE trx_trim_grn ADD COLUMN igst_amount DECIMAL(18,4) NULL DEFAULT 0 COMMENT \'IGST total\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_trim_grn' AND COLUMN_NAME='freight_charges');
SET @s = IF(@x=0, 'ALTER TABLE trx_trim_grn ADD COLUMN freight_charges DECIMAL(18,4) NULL DEFAULT 0 COMMENT \'Freight / transport\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_trim_grn' AND COLUMN_NAME='insurance');
SET @s = IF(@x=0, 'ALTER TABLE trx_trim_grn ADD COLUMN insurance DECIMAL(18,4) NULL DEFAULT 0 COMMENT \'Insurance (imports)\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_trim_grn' AND COLUMN_NAME='customs_duty');
SET @s = IF(@x=0, 'ALTER TABLE trx_trim_grn ADD COLUMN customs_duty DECIMAL(18,4) NULL DEFAULT 0 COMMENT \'Customs / basic duty (imports)\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_trim_grn' AND COLUMN_NAME='clearing_charges');
SET @s = IF(@x=0, 'ALTER TABLE trx_trim_grn ADD COLUMN clearing_charges DECIMAL(18,4) NULL DEFAULT 0 COMMENT \'Clearing / CHA charges (imports)\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_trim_grn' AND COLUMN_NAME='other_charges');
SET @s = IF(@x=0, 'ALTER TABLE trx_trim_grn ADD COLUMN other_charges DECIMAL(18,4) NULL DEFAULT 0 COMMENT \'Other charges (magnitude)\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_trim_grn' AND COLUMN_NAME='other_charges_label');
SET @s = IF(@x=0, 'ALTER TABLE trx_trim_grn ADD COLUMN other_charges_label VARCHAR(80) NULL COMMENT \'Other charges caption\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_trim_grn' AND COLUMN_NAME='other_charges_sign');
SET @s = IF(@x=0, 'ALTER TABLE trx_trim_grn ADD COLUMN other_charges_sign TINYINT NOT NULL DEFAULT 1 COMMENT \'+1 = added, -1 = deducted\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_trim_grn' AND COLUMN_NAME='tds_section');
SET @s = IF(@x=0, 'ALTER TABLE trx_trim_grn ADD COLUMN tds_section VARCHAR(30) NULL COMMENT \'TDS section e.g. 194Q / 194C\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_trim_grn' AND COLUMN_NAME='tds_pct');
SET @s = IF(@x=0, 'ALTER TABLE trx_trim_grn ADD COLUMN tds_pct DECIMAL(6,4) NULL DEFAULT 0 COMMENT \'TDS % on taxable value\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_trim_grn' AND COLUMN_NAME='tds_amount');
SET @s = IF(@x=0, 'ALTER TABLE trx_trim_grn ADD COLUMN tds_amount DECIMAL(18,4) NULL DEFAULT 0 COMMENT \'TDS deducted\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_trim_grn' AND COLUMN_NAME='tcs_section');
SET @s = IF(@x=0, 'ALTER TABLE trx_trim_grn ADD COLUMN tcs_section VARCHAR(30) NULL COMMENT \'TCS section e.g. 206C(1H)\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_trim_grn' AND COLUMN_NAME='tcs_pct');
SET @s = IF(@x=0, 'ALTER TABLE trx_trim_grn ADD COLUMN tcs_pct DECIMAL(6,4) NULL DEFAULT 0 COMMENT \'TCS % on invoice value\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_trim_grn' AND COLUMN_NAME='tcs_amount');
SET @s = IF(@x=0, 'ALTER TABLE trx_trim_grn ADD COLUMN tcs_amount DECIMAL(18,4) NULL DEFAULT 0 COMMENT \'TCS collected\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_trim_grn' AND COLUMN_NAME='round_off');
SET @s = IF(@x=0, 'ALTER TABLE trx_trim_grn ADD COLUMN round_off DECIMAL(10,4) NULL DEFAULT 0 COMMENT \'Round off (+/-)\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- trx_general_purchase
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_general_purchase' AND COLUMN_NAME='cgst_amount');
SET @s = IF(@x=0, 'ALTER TABLE trx_general_purchase ADD COLUMN cgst_amount DECIMAL(18,4) NULL DEFAULT 0 COMMENT \'CGST total\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_general_purchase' AND COLUMN_NAME='sgst_amount');
SET @s = IF(@x=0, 'ALTER TABLE trx_general_purchase ADD COLUMN sgst_amount DECIMAL(18,4) NULL DEFAULT 0 COMMENT \'SGST total\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_general_purchase' AND COLUMN_NAME='igst_amount');
SET @s = IF(@x=0, 'ALTER TABLE trx_general_purchase ADD COLUMN igst_amount DECIMAL(18,4) NULL DEFAULT 0 COMMENT \'IGST total\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_general_purchase' AND COLUMN_NAME='freight_charges');
SET @s = IF(@x=0, 'ALTER TABLE trx_general_purchase ADD COLUMN freight_charges DECIMAL(18,4) NULL DEFAULT 0 COMMENT \'Freight / transport\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_general_purchase' AND COLUMN_NAME='insurance');
SET @s = IF(@x=0, 'ALTER TABLE trx_general_purchase ADD COLUMN insurance DECIMAL(18,4) NULL DEFAULT 0 COMMENT \'Insurance (imports)\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_general_purchase' AND COLUMN_NAME='customs_duty');
SET @s = IF(@x=0, 'ALTER TABLE trx_general_purchase ADD COLUMN customs_duty DECIMAL(18,4) NULL DEFAULT 0 COMMENT \'Customs / basic duty (imports)\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_general_purchase' AND COLUMN_NAME='clearing_charges');
SET @s = IF(@x=0, 'ALTER TABLE trx_general_purchase ADD COLUMN clearing_charges DECIMAL(18,4) NULL DEFAULT 0 COMMENT \'Clearing / CHA charges (imports)\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_general_purchase' AND COLUMN_NAME='other_charges');
SET @s = IF(@x=0, 'ALTER TABLE trx_general_purchase ADD COLUMN other_charges DECIMAL(18,4) NULL DEFAULT 0 COMMENT \'Other charges (magnitude)\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_general_purchase' AND COLUMN_NAME='other_charges_label');
SET @s = IF(@x=0, 'ALTER TABLE trx_general_purchase ADD COLUMN other_charges_label VARCHAR(80) NULL COMMENT \'Other charges caption\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_general_purchase' AND COLUMN_NAME='other_charges_sign');
SET @s = IF(@x=0, 'ALTER TABLE trx_general_purchase ADD COLUMN other_charges_sign TINYINT NOT NULL DEFAULT 1 COMMENT \'+1 = added, -1 = deducted\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_general_purchase' AND COLUMN_NAME='tds_section');
SET @s = IF(@x=0, 'ALTER TABLE trx_general_purchase ADD COLUMN tds_section VARCHAR(30) NULL COMMENT \'TDS section e.g. 194Q / 194C\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_general_purchase' AND COLUMN_NAME='tds_pct');
SET @s = IF(@x=0, 'ALTER TABLE trx_general_purchase ADD COLUMN tds_pct DECIMAL(6,4) NULL DEFAULT 0 COMMENT \'TDS % on taxable value\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_general_purchase' AND COLUMN_NAME='tds_amount');
SET @s = IF(@x=0, 'ALTER TABLE trx_general_purchase ADD COLUMN tds_amount DECIMAL(18,4) NULL DEFAULT 0 COMMENT \'TDS deducted\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_general_purchase' AND COLUMN_NAME='tcs_section');
SET @s = IF(@x=0, 'ALTER TABLE trx_general_purchase ADD COLUMN tcs_section VARCHAR(30) NULL COMMENT \'TCS section e.g. 206C(1H)\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_general_purchase' AND COLUMN_NAME='tcs_pct');
SET @s = IF(@x=0, 'ALTER TABLE trx_general_purchase ADD COLUMN tcs_pct DECIMAL(6,4) NULL DEFAULT 0 COMMENT \'TCS % on invoice value\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_general_purchase' AND COLUMN_NAME='tcs_amount');
SET @s = IF(@x=0, 'ALTER TABLE trx_general_purchase ADD COLUMN tcs_amount DECIMAL(18,4) NULL DEFAULT 0 COMMENT \'TCS collected\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_general_purchase' AND COLUMN_NAME='round_off');
SET @s = IF(@x=0, 'ALTER TABLE trx_general_purchase ADD COLUMN round_off DECIMAL(10,4) NULL DEFAULT 0 COMMENT \'Round off (+/-)\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- Bills saved before this change stored TDS only as an amount.
UPDATE trx_supplier_bill
   SET tds_pct = ROUND(tds_amount / subtotal * 100, 4)
 WHERE (tds_pct IS NULL OR tds_pct = 0) AND tds_amount > 0 AND subtotal > 0;
