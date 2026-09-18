-- =============================================================================
-- Migration 33: Comprehensive Purchase Return Module per Developer Specification
-- Supports Yarn, Fabric, Trims, General Material returns with Returnable Qty, DC, and Allocations
-- =============================================================================

-- 1. Headers (trx_purchase_return)
SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_purchase_return' AND COLUMN_NAME = 'return_type');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_purchase_return ADD COLUMN return_type VARCHAR(40) NOT NULL DEFAULT \'FULL\' AFTER return_no', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_purchase_return' AND COLUMN_NAME = 'material_category');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_purchase_return ADD COLUMN material_category ENUM(\'YARN\', \'FABRIC\', \'TRIM\', \'GENERAL\') NOT NULL DEFAULT \'FABRIC\' AFTER return_type', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_purchase_return' AND COLUMN_NAME = 'source_po_id');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_purchase_return ADD COLUMN source_po_id BIGINT UNSIGNED NULL AFTER return_date', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_purchase_return' AND COLUMN_NAME = 'source_grn_id');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_purchase_return ADD COLUMN source_grn_id BIGINT UNSIGNED NULL AFTER source_po_id', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_purchase_return' AND COLUMN_NAME = 'return_dc_no');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_purchase_return ADD COLUMN return_dc_no VARCHAR(100) NULL AFTER debit_note_id', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_purchase_return' AND COLUMN_NAME = 'return_dc_date');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_purchase_return ADD COLUMN return_dc_date DATE NULL AFTER return_dc_no', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_purchase_return' AND COLUMN_NAME = 'transporter_name');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_purchase_return ADD COLUMN transporter_name VARCHAR(120) NULL AFTER return_dc_date', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_purchase_return' AND COLUMN_NAME = 'vehicle_no');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_purchase_return ADD COLUMN vehicle_no VARCHAR(40) NULL AFTER transporter_name', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_purchase_return' AND COLUMN_NAME = 'driver_name');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_purchase_return ADD COLUMN driver_name VARCHAR(100) NULL AFTER vehicle_no', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_purchase_return' AND COLUMN_NAME = 'eway_bill_no');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_purchase_return ADD COLUMN eway_bill_no VARCHAR(60) NULL AFTER driver_name', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_purchase_return' AND COLUMN_NAME = 'credit_note_ref');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_purchase_return ADD COLUMN credit_note_ref VARCHAR(100) NULL AFTER eway_bill_no', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_purchase_return' AND COLUMN_NAME = 'credit_note_date');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_purchase_return ADD COLUMN credit_note_date DATE NULL AFTER credit_note_ref', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_purchase_return' AND COLUMN_NAME = 'credit_note_amount');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_purchase_return ADD COLUMN credit_note_amount DECIMAL(14,4) DEFAULT 0 AFTER credit_note_date', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_purchase_return' AND COLUMN_NAME = 'approved_by');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_purchase_return ADD COLUMN approved_by BIGINT UNSIGNED NULL AFTER credit_note_amount', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_purchase_return' AND COLUMN_NAME = 'approved_at');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_purchase_return ADD COLUMN approved_at DATETIME NULL AFTER approved_by', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_purchase_return' AND COLUMN_NAME = 'posted_by');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_purchase_return ADD COLUMN posted_by BIGINT UNSIGNED NULL AFTER approved_at', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_purchase_return' AND COLUMN_NAME = 'posted_at');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_purchase_return ADD COLUMN posted_at DATETIME NULL AFTER posted_by', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_purchase_return' AND COLUMN_NAME = 'stock_posted');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_purchase_return ADD COLUMN stock_posted TINYINT(1) DEFAULT 0 AFTER posted_at', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

ALTER TABLE trx_purchase_return MODIFY COLUMN status VARCHAR(30) NOT NULL DEFAULT 'DRAFT';
ALTER TABLE trx_purchase_return MODIFY COLUMN return_reason VARCHAR(60) NOT NULL DEFAULT 'QUALITY_REJECTION';
ALTER TABLE trx_purchase_return MODIFY COLUMN grn_id BIGINT UNSIGNED NULL;

-- 2. Lines (trx_purchase_return_line)
SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_purchase_return_line' AND COLUMN_NAME = 'grn_qty');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_purchase_return_line ADD COLUMN grn_qty DECIMAL(14,4) DEFAULT 0 AFTER return_qty', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_purchase_return_line' AND COLUMN_NAME = 'prev_returned_qty');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_purchase_return_line ADD COLUMN prev_returned_qty DECIMAL(14,4) DEFAULT 0 AFTER grn_qty', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_purchase_return_line' AND COLUMN_NAME = 'issued_qty');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_purchase_return_line ADD COLUMN issued_qty DECIMAL(14,4) DEFAULT 0 AFTER prev_returned_qty', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_purchase_return_line' AND COLUMN_NAME = 'returnable_qty');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_purchase_return_line ADD COLUMN returnable_qty DECIMAL(14,4) DEFAULT 0 AFTER issued_qty', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_purchase_return_line' AND COLUMN_NAME = 'basic_amount');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_purchase_return_line ADD COLUMN basic_amount DECIMAL(14,4) DEFAULT 0 AFTER amount', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_purchase_return_line' AND COLUMN_NAME = 'taxable_amount');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_purchase_return_line ADD COLUMN taxable_amount DECIMAL(14,4) DEFAULT 0 AFTER basic_amount', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_purchase_return_line' AND COLUMN_NAME = 'gst_percent');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_purchase_return_line ADD COLUMN gst_percent DECIMAL(5,2) DEFAULT 0 AFTER taxable_amount', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_purchase_return_line' AND COLUMN_NAME = 'cgst_amount');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_purchase_return_line ADD COLUMN cgst_amount DECIMAL(14,4) DEFAULT 0 AFTER gst_percent', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_purchase_return_line' AND COLUMN_NAME = 'sgst_amount');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_purchase_return_line ADD COLUMN sgst_amount DECIMAL(14,4) DEFAULT 0 AFTER cgst_amount', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_purchase_return_line' AND COLUMN_NAME = 'igst_amount');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_purchase_return_line ADD COLUMN igst_amount DECIMAL(14,4) DEFAULT 0 AFTER sgst_amount', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_purchase_return_line' AND COLUMN_NAME = 'total_amount');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_purchase_return_line ADD COLUMN total_amount DECIMAL(14,4) DEFAULT 0 AFTER igst_amount', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_purchase_return_line' AND COLUMN_NAME = 'lot_no');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_purchase_return_line ADD COLUMN lot_no VARCHAR(80) NULL AFTER total_amount', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_purchase_return_line' AND COLUMN_NAME = 'dye_lot_no');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_purchase_return_line ADD COLUMN dye_lot_no VARCHAR(80) NULL AFTER lot_no', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_purchase_return_line' AND COLUMN_NAME = 'cone_count');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_purchase_return_line ADD COLUMN cone_count INT NULL AFTER dye_lot_no', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_purchase_return_line' AND COLUMN_NAME = 'bag_count');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_purchase_return_line ADD COLUMN bag_count INT NULL AFTER cone_count', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_purchase_return_line' AND COLUMN_NAME = 'roll_no');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_purchase_return_line ADD COLUMN roll_no VARCHAR(80) NULL AFTER bag_count', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_purchase_return_line' AND COLUMN_NAME = 'batch_no');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_purchase_return_line ADD COLUMN batch_no VARCHAR(80) NULL AFTER roll_no', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_purchase_return_line' AND COLUMN_NAME = 'gsm');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_purchase_return_line ADD COLUMN gsm VARCHAR(30) NULL AFTER batch_no', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_purchase_return_line' AND COLUMN_NAME = 'dia');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_purchase_return_line ADD COLUMN dia VARCHAR(30) NULL AFTER gsm', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_purchase_return_line' AND COLUMN_NAME = 'size');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_purchase_return_line ADD COLUMN size VARCHAR(30) NULL AFTER dia', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_purchase_return_line' AND COLUMN_NAME = 'department');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_purchase_return_line ADD COLUMN department VARCHAR(80) NULL AFTER size', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_purchase_return_line' AND COLUMN_NAME = 'expiry_date');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_purchase_return_line ADD COLUMN expiry_date DATE NULL AFTER department', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_purchase_return_line' AND COLUMN_NAME = 'job_no');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_purchase_return_line ADD COLUMN job_no VARCHAR(60) NULL AFTER expiry_date', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_purchase_return_line' AND COLUMN_NAME = 'style_no');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_purchase_return_line ADD COLUMN style_no VARCHAR(60) NULL AFTER job_no', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 3. Allocations Table
CREATE TABLE IF NOT EXISTS trx_purchase_return_allocation (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  return_id BIGINT UNSIGNED NOT NULL,
  return_line_id BIGINT UNSIGNED NOT NULL,
  job_no VARCHAR(60) NOT NULL,
  style_no VARCHAR(60) NOT NULL,
  allocated_qty DECIMAL(14,4) NOT NULL,
  remarks VARCHAR(255) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_ret_alloc_ret (return_id),
  INDEX idx_ret_alloc_line (return_line_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 4. Reason Master
CREATE TABLE IF NOT EXISTS mst_purchase_return_reason (
  id INT AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(50) NOT NULL UNIQUE,
  name VARCHAR(100) NOT NULL,
  material_category VARCHAR(30) NULL,
  requires_qc TINYINT(1) DEFAULT 0,
  requires_remarks TINYINT(1) DEFAULT 0,
  is_active TINYINT(1) DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO mst_purchase_return_reason (code, name, requires_qc, requires_remarks) VALUES
  ('QUALITY_REJECTION', 'Quality Rejection', 1, 0),
  ('WRONG_MATERIAL', 'Wrong Material Supplied', 0, 0),
  ('WRONG_SPECIFICATION', 'Wrong Specification / Count / Dia', 0, 0),
  ('WRONG_COLOUR', 'Wrong Shade / Colour Mismatch', 0, 0),
  ('EXCESS_SUPPLY', 'Excess Material Supplied', 0, 0),
  ('DAMAGED', 'Damaged in Transit / Wet / Stained', 0, 0),
  ('FAILED_INSPECTION', 'Failed QC Laboratory / GSM / Shrinkage Inspection', 1, 0),
  ('BUYER_REJECTION', 'Rejected by Buyer / Spec Discrepancy', 0, 0),
  ('WRONG_SIZE', 'Wrong Trims Size / Dimension', 0, 0),
  ('SUPPLIER_REPLACEMENT', 'Supplier Recall / Replacement', 0, 0),
  ('DUPLICATE_SUPPLY', 'Duplicate Shipment Received', 0, 0),
  ('EXPIRED', 'Expired Chemical / Auxiliary / Trims', 0, 0),
  ('OTHER', 'Other (Remarks Required)', 0, 1);
