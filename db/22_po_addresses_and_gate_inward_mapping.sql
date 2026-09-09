-- =============================================================================
-- Migration 22: PO Billing & Shipping Addresses and Gate Inward Mapping in GRN
-- =============================================================================

-- 1. PURCHASE ORDER BILLING & SHIPPING ADDRESSES
SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_purchase_order' AND COLUMN_NAME = 'billing_address');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_purchase_order ADD COLUMN billing_address TEXT NULL AFTER remarks', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_purchase_order' AND COLUMN_NAME = 'shipping_address');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_purchase_order ADD COLUMN shipping_address TEXT NULL AFTER billing_address', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_purchase_order' AND COLUMN_NAME = 'shipping_to_party_id');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_purchase_order ADD COLUMN shipping_to_party_id BIGINT UNSIGNED NULL AFTER shipping_address, ADD CONSTRAINT fk_po__ship_party FOREIGN KEY (shipping_to_party_id) REFERENCES mst_party(id)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 2. ENSURE trx_grn.gate_inward_id EXISTS AND IS INDEXED
SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_grn' AND COLUMN_NAME = 'gate_inward_id');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_grn ADD COLUMN gate_inward_id BIGINT UNSIGNED NULL AFTER supplier_id, ADD CONSTRAINT fk_grn__gate_inward FOREIGN KEY (gate_inward_id) REFERENCES trx_gate_inward(id)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
