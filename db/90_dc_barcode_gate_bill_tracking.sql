-- =====================================================================
-- 90: DC barcodes → gate scan, GRN bill tracking (client voice notes 01-Oct-2026)
--   • Gate entries remember the DC they were made from (scanning the DC barcode loads it):
--     trx_gate_outward.ref_no, trx_gate_inward.ref_type / ref_id / ref_no.
--   • Supplier bills can link trim GRNs (trim GRNs live in trx_trim_grn).
--   • BILL_PENDING_ALERT_DAYS — a GRN without a supplier bill after this many days is overdue.
--   Idempotent.
-- =====================================================================

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_gate_outward' AND COLUMN_NAME='ref_no');
SET @s = IF(@x=0, 'ALTER TABLE trx_gate_outward ADD COLUMN ref_no VARCHAR(60) NULL COMMENT ''DC no the pass was made from (barcode scan)'', ADD KEY ix_gout_ref (company_id, ref_type, ref_id)', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_gate_inward' AND COLUMN_NAME='ref_type');
SET @s = IF(@x=0, 'ALTER TABLE trx_gate_inward ADD COLUMN ref_type VARCHAR(40) NULL COMMENT ''Our outward DC the material is coming back against'', ADD COLUMN ref_id BIGINT UNSIGNED NULL, ADD COLUMN ref_no VARCHAR(60) NULL, ADD KEY ix_gin_ref (company_id, ref_type, ref_id)', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_supplier_bill' AND COLUMN_NAME='trim_grn_ids');
SET @s = IF(@x=0, 'ALTER TABLE trx_supplier_bill ADD COLUMN trim_grn_ids JSON NULL COMMENT ''Trim GRNs (trx_trim_grn) this bill is for''', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

INSERT IGNORE INTO cfg_system_setting (company_id, setting_key, setting_value, description)
SELECT id, 'BILL_PENDING_ALERT_DAYS', '7', 'Days after a GRN without the supplier bill before it shows as overdue in the bell / GRN bill status'
  FROM mst_company;
