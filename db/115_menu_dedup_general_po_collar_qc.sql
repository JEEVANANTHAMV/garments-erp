-- 115 · Menu de-duplication (14-Oct-2026)
-- 1. General purchase: one menu item with PO / GRN tabs. A row now says which it is, so the PO tab lists only POs
--    and the GRN tab only GRNs (both menus used to show the same list).
-- 2. Collar output is received only on Collar Knitting (trx_collar_receipt, PCS by size); the collar QC on
--    "Collar – Yarn Issue / QC" is recorded against that receipt.

-- 1. trx_general_purchase.doc_kind — back-filled once, when the column is first added:
--    a row with a GRN no, a gate entry or a posted state is a GRN; anything else was raised as a PO.
SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_general_purchase' AND COLUMN_NAME = 'doc_kind');
SET @sql = IF(@col_exist = 0, "ALTER TABLE trx_general_purchase ADD COLUMN doc_kind ENUM('PO','GRN') NOT NULL DEFAULT 'GRN' AFTER grn_no", 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @sql = IF(@col_exist = 0, "UPDATE trx_general_purchase SET doc_kind = 'PO' WHERE grn_no IS NULL AND gate_inward_id IS NULL AND COALESCE(approval_state, '') <> 'POSTED'", 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @idx_exist = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_general_purchase' AND INDEX_NAME = 'ix_gp__kind');
SET @sql = IF(@idx_exist = 0, 'ALTER TABLE trx_general_purchase ADD INDEX ix_gp__kind (company_id, doc_kind)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 2. trx_process_qc.collar_receipt_id
SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_process_qc' AND COLUMN_NAME = 'collar_receipt_id');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_process_qc ADD COLUMN collar_receipt_id BIGINT UNSIGNED NULL AFTER receipt_id', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @fk_exist = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_process_qc' AND CONSTRAINT_NAME = 'fk_pqc__collar_receipt');
SET @sql = IF(@fk_exist = 0, 'ALTER TABLE trx_process_qc ADD CONSTRAINT fk_pqc__collar_receipt FOREIGN KEY (collar_receipt_id) REFERENCES trx_collar_receipt(id) ON DELETE CASCADE', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
