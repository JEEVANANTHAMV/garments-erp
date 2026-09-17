-- =============================================================================
-- Migration 28: Procurement Tax Breakdown (IGST/CGST/SGST), Amounts, Gate Entry & Multi-Job Linking
-- =============================================================================

-- 1. PURCHASE ORDER LINE: Multiple Jobs & Tax Breakdowns
SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_purchase_order_line' AND COLUMN_NAME = 'so_id');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_purchase_order_line ADD COLUMN so_id BIGINT UNSIGNED NULL AFTER po_id', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_purchase_order_line' AND COLUMN_NAME = 'style_id');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_purchase_order_line ADD COLUMN style_id BIGINT UNSIGNED NULL AFTER so_id', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_purchase_order_line' AND COLUMN_NAME = 'hsn_code');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_purchase_order_line ADD COLUMN hsn_code VARCHAR(30) NULL AFTER description', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_purchase_order_line' AND COLUMN_NAME = 'taxable_amount');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_purchase_order_line ADD COLUMN taxable_amount DECIMAL(18,4) DEFAULT 0 AFTER amount', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_purchase_order_line' AND COLUMN_NAME = 'tax_amount');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_purchase_order_line ADD COLUMN tax_amount DECIMAL(18,4) DEFAULT 0 AFTER gst_rate', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_purchase_order_line' AND COLUMN_NAME = 'cgst_rate');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_purchase_order_line ADD COLUMN cgst_rate DECIMAL(6,2) DEFAULT 0 AFTER tax_amount', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_purchase_order_line' AND COLUMN_NAME = 'cgst_amount');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_purchase_order_line ADD COLUMN cgst_amount DECIMAL(18,4) DEFAULT 0 AFTER cgst_rate', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_purchase_order_line' AND COLUMN_NAME = 'sgst_rate');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_purchase_order_line ADD COLUMN sgst_rate DECIMAL(6,2) DEFAULT 0 AFTER cgst_amount', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_purchase_order_line' AND COLUMN_NAME = 'sgst_amount');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_purchase_order_line ADD COLUMN sgst_amount DECIMAL(18,4) DEFAULT 0 AFTER sgst_rate', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_purchase_order_line' AND COLUMN_NAME = 'igst_rate');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_purchase_order_line ADD COLUMN igst_rate DECIMAL(6,2) DEFAULT 0 AFTER sgst_amount', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_purchase_order_line' AND COLUMN_NAME = 'igst_amount');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_purchase_order_line ADD COLUMN igst_amount DECIMAL(18,4) DEFAULT 0 AFTER igst_rate', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 2. PURCHASE ORDER HEADER: Tax Breakdown
SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_purchase_order' AND COLUMN_NAME = 'is_interstate');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_purchase_order ADD COLUMN is_interstate TINYINT(1) DEFAULT 0 AFTER payment_terms', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_purchase_order' AND COLUMN_NAME = 'cgst_amount');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_purchase_order ADD COLUMN cgst_amount DECIMAL(18,4) DEFAULT 0 AFTER tax_amount', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_purchase_order' AND COLUMN_NAME = 'sgst_amount');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_purchase_order ADD COLUMN sgst_amount DECIMAL(18,4) DEFAULT 0 AFTER cgst_amount', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_purchase_order' AND COLUMN_NAME = 'igst_amount');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_purchase_order ADD COLUMN igst_amount DECIMAL(18,4) DEFAULT 0 AFTER sgst_amount', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 3. GRN LINE: Amount Details, Tax & Multi-Job Linking
SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_grn_line' AND COLUMN_NAME = 'so_id');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_grn_line ADD COLUMN so_id BIGINT UNSIGNED NULL AFTER po_line_id', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_grn_line' AND COLUMN_NAME = 'style_id');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_grn_line ADD COLUMN style_id BIGINT UNSIGNED NULL AFTER so_id', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_grn_line' AND COLUMN_NAME = 'rate');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_grn_line ADD COLUMN rate DECIMAL(18,4) DEFAULT 0 AFTER balance_qty', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_grn_line' AND COLUMN_NAME = 'taxable_amount');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_grn_line ADD COLUMN taxable_amount DECIMAL(18,4) DEFAULT 0 AFTER rate', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_grn_line' AND COLUMN_NAME = 'gst_rate');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_grn_line ADD COLUMN gst_rate DECIMAL(6,2) DEFAULT 0 AFTER taxable_amount', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_grn_line' AND COLUMN_NAME = 'tax_amount');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_grn_line ADD COLUMN tax_amount DECIMAL(18,4) DEFAULT 0 AFTER gst_rate', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_grn_line' AND COLUMN_NAME = 'cgst_amount');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_grn_line ADD COLUMN cgst_amount DECIMAL(18,4) DEFAULT 0 AFTER tax_amount', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_grn_line' AND COLUMN_NAME = 'sgst_amount');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_grn_line ADD COLUMN sgst_amount DECIMAL(18,4) DEFAULT 0 AFTER cgst_amount', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_grn_line' AND COLUMN_NAME = 'igst_amount');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_grn_line ADD COLUMN igst_amount DECIMAL(18,4) DEFAULT 0 AFTER sgst_amount', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_grn_line' AND COLUMN_NAME = 'total_amount');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_grn_line ADD COLUMN total_amount DECIMAL(18,4) DEFAULT 0 AFTER igst_amount', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 4. GRN HEADER: Tax & Amount Details
SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_grn' AND COLUMN_NAME = 'is_interstate');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_grn ADD COLUMN is_interstate TINYINT(1) DEFAULT 0 AFTER vehicle_no', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_grn' AND COLUMN_NAME = 'taxable_amount');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_grn ADD COLUMN taxable_amount DECIMAL(18,4) DEFAULT 0 AFTER is_interstate', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_grn' AND COLUMN_NAME = 'tax_amount');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_grn ADD COLUMN tax_amount DECIMAL(18,4) DEFAULT 0 AFTER taxable_amount', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_grn' AND COLUMN_NAME = 'cgst_amount');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_grn ADD COLUMN cgst_amount DECIMAL(18,4) DEFAULT 0 AFTER tax_amount', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_grn' AND COLUMN_NAME = 'sgst_amount');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_grn ADD COLUMN sgst_amount DECIMAL(18,4) DEFAULT 0 AFTER cgst_amount', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_grn' AND COLUMN_NAME = 'igst_amount');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_grn ADD COLUMN igst_amount DECIMAL(18,4) DEFAULT 0 AFTER sgst_amount', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_grn' AND COLUMN_NAME = 'net_amount');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_grn ADD COLUMN net_amount DECIMAL(18,4) DEFAULT 0 AFTER igst_amount', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 5. TRIM PO & TRIM GRN: IGST, Amounts & Gate Entry
SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_trim_po' AND COLUMN_NAME = 'is_interstate');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_trim_po ADD COLUMN is_interstate TINYINT(1) DEFAULT 0 AFTER payment_terms', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_trim_po' AND COLUMN_NAME = 'igst_amount');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_trim_po ADD COLUMN igst_amount DECIMAL(18,4) DEFAULT 0 AFTER tax_amount', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_trim_po' AND COLUMN_NAME = 'cgst_amount');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_trim_po ADD COLUMN cgst_amount DECIMAL(18,4) DEFAULT 0 AFTER igst_amount', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_trim_po' AND COLUMN_NAME = 'sgst_amount');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_trim_po ADD COLUMN sgst_amount DECIMAL(18,4) DEFAULT 0 AFTER cgst_amount', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_trim_po_line' AND COLUMN_NAME = 'so_id');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_trim_po_line ADD COLUMN so_id BIGINT UNSIGNED NULL AFTER po_id', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_trim_po_line' AND COLUMN_NAME = 'style_id');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_trim_po_line ADD COLUMN style_id BIGINT UNSIGNED NULL AFTER so_id', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_trim_po_line' AND COLUMN_NAME = 'igst_rate');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_trim_po_line ADD COLUMN igst_rate DECIMAL(6,2) DEFAULT 0 AFTER gst_rate', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_trim_po_line' AND COLUMN_NAME = 'igst_amount');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_trim_po_line ADD COLUMN igst_amount DECIMAL(18,4) DEFAULT 0 AFTER tax_amount', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 6. TRIM GRN: Gate Entry & Amounts
SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_trim_grn' AND COLUMN_NAME = 'gate_inward_id');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_trim_grn ADD COLUMN gate_inward_id BIGINT UNSIGNED NULL AFTER vehicle_no, ADD CONSTRAINT fk_tgrn__gate_inward FOREIGN KEY (gate_inward_id) REFERENCES trx_gate_inward(id)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_trim_grn' AND COLUMN_NAME = 'is_interstate');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_trim_grn ADD COLUMN is_interstate TINYINT(1) DEFAULT 0 AFTER gate_inward_id', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_trim_grn' AND COLUMN_NAME = 'taxable_amount');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_trim_grn ADD COLUMN taxable_amount DECIMAL(18,4) DEFAULT 0 AFTER is_interstate', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_trim_grn' AND COLUMN_NAME = 'tax_amount');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_trim_grn ADD COLUMN tax_amount DECIMAL(18,4) DEFAULT 0 AFTER taxable_amount', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_trim_grn' AND COLUMN_NAME = 'igst_amount');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_trim_grn ADD COLUMN igst_amount DECIMAL(18,4) DEFAULT 0 AFTER tax_amount', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_trim_grn' AND COLUMN_NAME = 'net_amount');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_trim_grn ADD COLUMN net_amount DECIMAL(18,4) DEFAULT 0 AFTER igst_amount', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_trim_grn_line' AND COLUMN_NAME = 'so_id');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_trim_grn_line ADD COLUMN so_id BIGINT UNSIGNED NULL AFTER po_line_id', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_trim_grn_line' AND COLUMN_NAME = 'style_id');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_trim_grn_line ADD COLUMN style_id BIGINT UNSIGNED NULL AFTER so_id', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_trim_grn_line' AND COLUMN_NAME = 'rate');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_trim_grn_line ADD COLUMN rate DECIMAL(18,4) DEFAULT 0 AFTER hold_qty', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_trim_grn_line' AND COLUMN_NAME = 'taxable_amount');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_trim_grn_line ADD COLUMN taxable_amount DECIMAL(18,4) DEFAULT 0 AFTER rate', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_trim_grn_line' AND COLUMN_NAME = 'gst_rate');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_trim_grn_line ADD COLUMN gst_rate DECIMAL(6,2) DEFAULT 0 AFTER taxable_amount', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_trim_grn_line' AND COLUMN_NAME = 'tax_amount');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_trim_grn_line ADD COLUMN tax_amount DECIMAL(18,4) DEFAULT 0 AFTER gst_rate', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_trim_grn_line' AND COLUMN_NAME = 'total_amount');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_trim_grn_line ADD COLUMN total_amount DECIMAL(18,4) DEFAULT 0 AFTER tax_amount', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
