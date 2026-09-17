-- =====================================================================
-- 27. PRODUCTION COSTING ENHANCEMENTS & DETAILED SUB-TABLES
-- Specification: Production_Costing_Developer_Document.docx
-- =====================================================================

-- 1. Extend trx_production_cost with required header fields
SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_production_cost' AND COLUMN_NAME = 'io_id');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_production_cost ADD COLUMN io_id BIGINT UNSIGNED NULL AFTER prod_order_id', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_production_cost' AND COLUMN_NAME = 'sales_order_id');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_production_cost ADD COLUMN sales_order_id BIGINT UNSIGNED NULL AFTER io_id', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_production_cost' AND COLUMN_NAME = 'merchandiser_costing_id');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_production_cost ADD COLUMN merchandiser_costing_id BIGINT UNSIGNED NULL AFTER sales_order_id', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_production_cost' AND COLUMN_NAME = 'good_qty');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_production_cost ADD COLUMN good_qty INT UNSIGNED DEFAULT 0 AFTER produced_qty', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_production_cost' AND COLUMN_NAME = 'rejection_qty');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_production_cost ADD COLUMN rejection_qty INT UNSIGNED DEFAULT 0 AFTER good_qty', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_production_cost' AND COLUMN_NAME = 'rework_qty');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_production_cost ADD COLUMN rework_qty INT UNSIGNED DEFAULT 0 AFTER rejection_qty', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_production_cost' AND COLUMN_NAME = 'cost_per_good_piece');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_production_cost ADD COLUMN cost_per_good_piece DECIMAL(18,4) DEFAULT 0 AFTER cost_per_piece', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_production_cost' AND COLUMN_NAME = 'currency_id');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_production_cost ADD COLUMN currency_id SMALLINT UNSIGNED DEFAULT 1 AFTER rework_qty', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_production_cost' AND COLUMN_NAME = 'approved_by');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_production_cost ADD COLUMN approved_by BIGINT UNSIGNED NULL AFTER finalized_by', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_production_cost' AND COLUMN_NAME = 'approved_at');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_production_cost ADD COLUMN approved_at DATETIME NULL AFTER approved_by', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 2. Sub-table: Material Issues & Returns (Fabric & Trims)
CREATE TABLE IF NOT EXISTS trx_production_costing_material (
  id                  BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  cost_id             BIGINT UNSIGNED NOT NULL,
  material_type       VARCHAR(30) NOT NULL COMMENT 'FABRIC, TRIM, YARN',
  item_id             BIGINT UNSIGNED NULL,
  item_code           VARCHAR(60) NULL,
  item_name           VARCHAR(150) NOT NULL,
  lot_no              VARCHAR(60) NULL,
  roll_no             VARCHAR(60) NULL,
  warehouse_name      VARCHAR(80) NULL,
  issue_no            VARCHAR(60) NULL,
  issue_date          DATE NULL,
  planned_qty         DECIMAL(18,4) DEFAULT 0,
  issue_qty           DECIMAL(18,4) NOT NULL DEFAULT 0,
  return_qty          DECIMAL(18,4) DEFAULT 0,
  net_qty             DECIMAL(18,4) NOT NULL DEFAULT 0,
  uom_code            VARCHAR(20) DEFAULT 'KG',
  rate                DECIMAL(18,4) NOT NULL DEFAULT 0,
  amount              DECIMAL(18,4) NOT NULL DEFAULT 0,
  supplier_name       VARCHAR(100) NULL,
  grn_no              VARCHAR(60) NULL,
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_pcm_cost FOREIGN KEY (cost_id) REFERENCES trx_production_cost(id) ON DELETE CASCADE
) ENGINE=InnoDB COMMENT='Production Costing Material Actual Lines';

-- 3. Sub-table: Process & Jobwork
CREATE TABLE IF NOT EXISTS trx_production_costing_process (
  id                  BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  cost_id             BIGINT UNSIGNED NOT NULL,
  process_name        VARCHAR(100) NOT NULL,
  vendor_name         VARCHAR(100) NULL,
  process_order_no    VARCHAR(60) NULL,
  challan_no          VARCHAR(60) NULL,
  grn_no              VARCHAR(60) NULL,
  input_qty           DECIMAL(18,4) DEFAULT 0,
  output_qty          DECIMAL(18,4) DEFAULT 0,
  loss_qty            DECIMAL(18,4) DEFAULT 0,
  uom_code            VARCHAR(20) DEFAULT 'PCS',
  rate                DECIMAL(18,4) NOT NULL DEFAULT 0,
  amount              DECIMAL(18,4) NOT NULL DEFAULT 0,
  remarks             VARCHAR(255) NULL,
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_pcp_cost FOREIGN KEY (cost_id) REFERENCES trx_production_cost(id) ON DELETE CASCADE
) ENGINE=InnoDB COMMENT='Production Costing Process & Jobwork Lines';

-- 4. Sub-table: Labour (Department & Direct/Indirect)
CREATE TABLE IF NOT EXISTS trx_production_costing_labour (
  id                  BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  cost_id             BIGINT UNSIGNED NOT NULL,
  department_name     VARCHAR(60) NOT NULL,
  labour_type         VARCHAR(30) DEFAULT 'DIRECT' COMMENT 'DIRECT, INDIRECT',
  employee_name       VARCHAR(100) NULL,
  hours               DECIMAL(10,2) NOT NULL DEFAULT 0,
  rate_per_hour       DECIMAL(10,2) NOT NULL DEFAULT 0,
  amount              DECIMAL(18,4) NOT NULL DEFAULT 0,
  remarks             VARCHAR(255) NULL,
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_pcl_cost FOREIGN KEY (cost_id) REFERENCES trx_production_cost(id) ON DELETE CASCADE
) ENGINE=InnoDB COMMENT='Production Costing Labour Lines';

-- 5. Sub-table: Machine Cost
CREATE TABLE IF NOT EXISTS trx_production_costing_machine (
  id                  BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  cost_id             BIGINT UNSIGNED NOT NULL,
  machine_name        VARCHAR(100) NOT NULL,
  department_name     VARCHAR(60) NULL,
  machine_hours       DECIMAL(10,2) NOT NULL DEFAULT 0,
  hourly_rate         DECIMAL(10,2) NOT NULL DEFAULT 0,
  electricity_cost    DECIMAL(18,4) DEFAULT 0,
  maintenance_cost    DECIMAL(18,4) DEFAULT 0,
  depreciation_cost   DECIMAL(18,4) DEFAULT 0,
  total_cost          DECIMAL(18,4) NOT NULL DEFAULT 0,
  remarks             VARCHAR(255) NULL,
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_pcmach_cost FOREIGN KEY (cost_id) REFERENCES trx_production_cost(id) ON DELETE CASCADE
) ENGINE=InnoDB COMMENT='Production Costing Machine Usage & Costs';

-- 6. Sub-table: Overhead Allocation
CREATE TABLE IF NOT EXISTS trx_production_costing_overhead (
  id                  BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  cost_id             BIGINT UNSIGNED NOT NULL,
  cost_center_name    VARCHAR(80) NULL,
  overhead_head       VARCHAR(100) NOT NULL,
  allocation_basis    VARCHAR(40) DEFAULT 'PER_PIECE' COMMENT 'PER_PIECE, PER_HOUR, MACHINE_HOUR, PERCENT_DIRECT, PERCENT_MATERIAL',
  allocation_qty      DECIMAL(18,4) DEFAULT 0,
  rate                DECIMAL(18,4) DEFAULT 0,
  amount              DECIMAL(18,4) NOT NULL DEFAULT 0,
  remarks             VARCHAR(255) NULL,
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_pcoh_cost FOREIGN KEY (cost_id) REFERENCES trx_production_cost(id) ON DELETE CASCADE
) ENGINE=InnoDB COMMENT='Production Costing Overhead Allocation Lines';
