-- =====================================================================
-- 20. COSTING ENHANCEMENTS: PRODUCTION ACTUAL COSTING & PRE-COSTING V2
-- =====================================================================

-- 1. Ensure trx_production_cost has all enhanced fields
CREATE TABLE IF NOT EXISTS trx_production_cost (
  id                  BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id          BIGINT UNSIGNED NOT NULL,
  cost_no             VARCHAR(40) NOT NULL,
  cost_date           DATE NOT NULL,
  prod_order_id       BIGINT UNSIGNED NOT NULL,
  style_id            BIGINT UNSIGNED,
  produced_qty        INT UNSIGNED DEFAULT 0,
  material_cost       DECIMAL(18,4) DEFAULT 0,
  labour_cost         DECIMAL(18,4) DEFAULT 0,
  machine_cost        DECIMAL(18,4) DEFAULT 0,
  jobwork_cost        DECIMAL(18,4) DEFAULT 0,
  process_cost        DECIMAL(18,4) DEFAULT 0,
  overhead_cost       DECIMAL(18,4) DEFAULT 0,
  packing_cost        DECIMAL(18,4) DEFAULT 0,
  total_cost          DECIMAL(18,4) DEFAULT 0,
  cost_per_piece      DECIMAL(18,4) DEFAULT 0,
  estimated_cost      DECIMAL(18,4) DEFAULT 0,
  variance            DECIMAL(18,4) DEFAULT 0,
  variance_pct        DECIMAL(6,2)  DEFAULT 0,
  status              VARCHAR(30) DEFAULT 'DRAFT',
  remarks             VARCHAR(500),
  created_by          BIGINT UNSIGNED,
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_prod_cost (company_id, cost_no),
  CONSTRAINT fk_pcost__company FOREIGN KEY (company_id)    REFERENCES mst_company(id),
  CONSTRAINT fk_pcost__prod    FOREIGN KEY (prod_order_id) REFERENCES trx_production_order(id),
  CONSTRAINT fk_pcost__style   FOREIGN KEY (style_id)      REFERENCES mst_style(id)
) ENGINE=InnoDB;

-- Add extended columns to trx_production_cost
SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_production_cost' AND COLUMN_NAME = 'buyer_id');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_production_cost ADD COLUMN buyer_id BIGINT UNSIGNED NULL AFTER style_id', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_production_cost' AND COLUMN_NAME = 'unit_id');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_production_cost ADD COLUMN unit_id BIGINT UNSIGNED NULL AFTER buyer_id', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_production_cost' AND COLUMN_NAME = 'order_qty');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_production_cost ADD COLUMN order_qty INT UNSIGNED DEFAULT 0 AFTER unit_id', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_production_cost' AND COLUMN_NAME = 'planned_qty');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_production_cost ADD COLUMN planned_qty INT UNSIGNED DEFAULT 0 AFTER order_qty', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_production_cost' AND COLUMN_NAME = 'costing_period');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_production_cost ADD COLUMN costing_period VARCHAR(30) NULL AFTER produced_qty', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_production_cost' AND COLUMN_NAME = 'costing_type');
SET @sql = IF(@col_exist = 0, "ALTER TABLE trx_production_cost ADD COLUMN costing_type VARCHAR(30) DEFAULT 'ACTUAL' AFTER costing_period", 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_production_cost' AND COLUMN_NAME = 'version');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_production_cost ADD COLUMN version INT UNSIGNED DEFAULT 1 AFTER costing_type', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_production_cost' AND COLUMN_NAME = 'data_json');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_production_cost ADD COLUMN data_json LONGTEXT NULL AFTER remarks', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_production_cost' AND COLUMN_NAME = 'finalized_by');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_production_cost ADD COLUMN finalized_by BIGINT UNSIGNED NULL AFTER created_at', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_production_cost' AND COLUMN_NAME = 'finalized_at');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_production_cost ADD COLUMN finalized_at DATETIME NULL AFTER finalized_by', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Ensure status column supports the full workflow
ALTER TABLE trx_production_cost MODIFY COLUMN status VARCHAR(30) NOT NULL DEFAULT 'DRAFT';

-- 2. Ensure trx_production_cost_line has all enhanced fields
CREATE TABLE IF NOT EXISTS trx_production_cost_line (
  id                  BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  cost_id             BIGINT UNSIGNED NOT NULL,
  cost_head           VARCHAR(60) NOT NULL,
  cost_category       ENUM('MATERIAL','LABOUR','MACHINE','JOBWORK','PROCESS','OVERHEAD','PACKING','OTHER') NOT NULL,
  ref_type            VARCHAR(40),
  ref_id              BIGINT UNSIGNED,
  quantity            DECIMAL(18,5),
  uom_id              SMALLINT UNSIGNED,
  rate                DECIMAL(18,4),
  amount              DECIMAL(18,4) NOT NULL,
  remarks             VARCHAR(255),
  CONSTRAINT fk_pcostl__cost FOREIGN KEY (cost_id) REFERENCES trx_production_cost(id) ON DELETE CASCADE,
  CONSTRAINT fk_pcostl__uom  FOREIGN KEY (uom_id)  REFERENCES cfg_uom(id)
) ENGINE=InnoDB;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_production_cost_line' AND COLUMN_NAME = 'stage_name');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_production_cost_line ADD COLUMN stage_name VARCHAR(50) NULL AFTER cost_category', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_production_cost_line' AND COLUMN_NAME = 'item_description');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_production_cost_line ADD COLUMN item_description VARCHAR(255) NULL AFTER stage_name', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_production_cost_line' AND COLUMN_NAME = 'ref_doc_no');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_production_cost_line ADD COLUMN ref_doc_no VARCHAR(60) NULL AFTER ref_id', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 3. Extend trx_costing for Pre-Costing V2 Engine
SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_costing' AND COLUMN_NAME = 'season');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_costing ADD COLUMN season VARCHAR(40) DEFAULT NULL AFTER buyer_id', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_costing' AND COLUMN_NAME = 'buyer_ref');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_costing ADD COLUMN buyer_ref VARCHAR(80) DEFAULT NULL AFTER season', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_costing' AND COLUMN_NAME = 'unit_id');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_costing ADD COLUMN unit_id BIGINT UNSIGNED DEFAULT NULL AFTER buyer_ref', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_costing' AND COLUMN_NAME = 'price_basis');
SET @sql = IF(@col_exist = 0, "ALTER TABLE trx_costing ADD COLUMN price_basis VARCHAR(30) DEFAULT 'PER_PCS' AFTER unit_id", 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_costing' AND COLUMN_NAME = 'costing_type');
SET @sql = IF(@col_exist = 0, "ALTER TABLE trx_costing ADD COLUMN costing_type VARCHAR(30) DEFAULT 'PRE_COSTING' AFTER price_basis", 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_costing' AND COLUMN_NAME = 'smv');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_costing ADD COLUMN smv DECIMAL(10,2) DEFAULT NULL AFTER packing_cost', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_costing' AND COLUMN_NAME = 'smv_rate_per_min');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_costing ADD COLUMN smv_rate_per_min DECIMAL(10,4) DEFAULT NULL AFTER smv', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_costing' AND COLUMN_NAME = 'data_json');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_costing ADD COLUMN data_json LONGTEXT DEFAULT NULL AFTER remarks', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 4. Extend trx_costing_line with granular fields
SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_costing_line' AND COLUMN_NAME = 'component');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_costing_line ADD COLUMN component VARCHAR(60) DEFAULT NULL AFTER cost_head', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_costing_line' AND COLUMN_NAME = 'item_description');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_costing_line ADD COLUMN item_description VARCHAR(255) DEFAULT NULL AFTER component', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_costing_line' AND COLUMN_NAME = 'wastage_pct');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_costing_line ADD COLUMN wastage_pct DECIMAL(6,2) DEFAULT 0 AFTER quantity', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
