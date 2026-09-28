-- =====================================================================
-- 70. PROCESS DC FIELD COMPLETION (client review 24-Sep-2026 + sample screens)
-- ---------------------------------------------------------------------
--  * Per bundle: the operation completed and the operator / line
--    (sample "Sewing process outward": Process Completed, Operator / Line).
--  * Inward: reference / SR no, excess PCS (recorded, never moved into
--    the bundle ledger), a group no when one inward covers several DCs.
--  * Contractor bill: optional GST (TDS stays on the value before GST).
--  * Checking process (sewing → checking → ironing) for every company.
--  * Document attachments (party DC scans, photos) for DCs / inwards.
-- Every statement is idempotent: the migrate runner re-applies files.
-- =====================================================================

-- trx_jobwork_challan_line
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_challan_line' AND COLUMN_NAME='operation_id');
SET @s = IF(@x=0, 'ALTER TABLE trx_jobwork_challan_line ADD COLUMN operation_id BIGINT UNSIGNED NULL COMMENT \'Operation completed on the bundle (mst_process_operation)\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_challan_line' AND COLUMN_NAME='operator_line');
SET @s = IF(@x=0, 'ALTER TABLE trx_jobwork_challan_line ADD COLUMN operator_line VARCHAR(60) NULL COMMENT \'Operator / line\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- trx_jobwork_receipt_line
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_receipt_line' AND COLUMN_NAME='operation_id');
SET @s = IF(@x=0, 'ALTER TABLE trx_jobwork_receipt_line ADD COLUMN operation_id BIGINT UNSIGNED NULL COMMENT \'Operation the contractor completed\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_receipt_line' AND COLUMN_NAME='operator_line');
SET @s = IF(@x=0, 'ALTER TABLE trx_jobwork_receipt_line ADD COLUMN operator_line VARCHAR(60) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_receipt_line' AND COLUMN_NAME='excess_qty');
SET @s = IF(@x=0, 'ALTER TABLE trx_jobwork_receipt_line ADD COLUMN excess_qty INT NOT NULL DEFAULT 0 COMMENT \'PCS returned beyond the DC qty — recorded only\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- trx_jobwork_receipt
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_receipt' AND COLUMN_NAME='ref_no');
SET @s = IF(@x=0, 'ALTER TABLE trx_jobwork_receipt ADD COLUMN ref_no VARCHAR(60) NULL COMMENT \'Reference / SR no\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_receipt' AND COLUMN_NAME='inward_group_no');
SET @s = IF(@x=0, 'ALTER TABLE trx_jobwork_receipt ADD COLUMN inward_group_no VARCHAR(40) NULL COMMENT \'One inward covering several DCs\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_receipt' AND COLUMN_NAME='excess_qty');
SET @s = IF(@x=0, 'ALTER TABLE trx_jobwork_receipt ADD COLUMN excess_qty INT NOT NULL DEFAULT 0', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_receipt' AND INDEX_NAME='ix_jwr_group');
SET @s = IF(@x=0, 'ALTER TABLE trx_jobwork_receipt ADD KEY ix_jwr_group (company_id, inward_group_no)', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- trx_contractor_bill: optional GST
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_contractor_bill' AND COLUMN_NAME='gst_pct');
SET @s = IF(@x=0, 'ALTER TABLE trx_contractor_bill ADD COLUMN gst_pct DECIMAL(6,3) NOT NULL DEFAULT 0 AFTER gross_amount', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_contractor_bill' AND COLUMN_NAME='gst_amount');
SET @s = IF(@x=0, 'ALTER TABLE trx_contractor_bill ADD COLUMN gst_amount DECIMAL(18,2) NOT NULL DEFAULT 0 AFTER gst_pct', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_contractor_bill' AND COLUMN_NAME='is_interstate');
SET @s = IF(@x=0, 'ALTER TABLE trx_contractor_bill ADD COLUMN is_interstate TINYINT(1) NOT NULL DEFAULT 0 AFTER gst_amount', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- Checking process between stitching and ironing (round trip on sewn PCS)
INSERT INTO cfg_process_stage (company_id, stage_code, stage_name, sort_order, is_outsourceable, is_active)
SELECT c.id, 'CHECK', 'Checking', 7, 1, 1 FROM mst_company c
 WHERE NOT EXISTS (SELECT 1 FROM cfg_process_stage s WHERE s.company_id = c.id AND s.stage_code IN ('CHECK','CHECKING'));

CREATE TABLE IF NOT EXISTS trx_document_attachment (
  id           BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id   BIGINT UNSIGNED NOT NULL,
  ref_table    VARCHAR(60) NOT NULL,
  ref_id       BIGINT UNSIGNED NOT NULL,
  doc_type     VARCHAR(30) NOT NULL DEFAULT 'OTHER' COMMENT 'PARTY_DC / PHOTO / OTHER',
  file_url     VARCHAR(300) NOT NULL,
  file_name    VARCHAR(200) NULL,
  mime_type    VARCHAR(80) NULL,
  size_bytes   INT UNSIGNED NULL,
  remarks      VARCHAR(255) NULL,
  uploaded_by  BIGINT UNSIGNED NULL,
  uploaded_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_doc_ref (company_id, ref_table, ref_id)
) ENGINE=InnoDB COMMENT='Files attached to documents (DCs, inwards …)';
