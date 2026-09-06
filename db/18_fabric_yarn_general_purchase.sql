-- =============================================================================
-- Migration 18: Fabric Master, Yarn Master & General Purchase Enhancements
-- Aligns with Developer Handover Specifications:
--   1. Fabric Master: Structure, Effect, Finish, Printing, Decoration, Loss %,
--      Auto-Description formula, and Variant GSM/Width dimensions.
--   2. Yarn Master: Spinning System, Construction, Effect, Dyeing, Twist,
--      Technical parameters, Multi-component counts (30s/30s/10s).
--   3. General Purchase: General Purchase Header & Lines with Allocation Types
--      (Buyer Order, Prod Order, Sample, Job Work, Maintenance, Dept, Direct Expense)
--      and Direct Issue flag for immediate Order Costing.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. FABRIC MASTER ENHANCEMENTS (mst_fabric_base & mst_fabric)
-- -----------------------------------------------------------------------------

-- mst_fabric_base: Structure, Effect, Printing, Decoration, Loss %, Descriptions
SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mst_fabric_base' AND COLUMN_NAME = 'structure');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE mst_fabric_base ADD COLUMN structure VARCHAR(80) NULL AFTER knit_structure', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mst_fabric_base' AND COLUMN_NAME = 'effect');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE mst_fabric_base ADD COLUMN effect VARCHAR(80) NULL AFTER structure', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mst_fabric_base' AND COLUMN_NAME = 'printing');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE mst_fabric_base ADD COLUMN printing VARCHAR(80) NULL AFTER finish_type', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mst_fabric_base' AND COLUMN_NAME = 'decoration');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE mst_fabric_base ADD COLUMN decoration VARCHAR(80) NULL AFTER printing', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mst_fabric_base' AND COLUMN_NAME = 'loss_percent');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE mst_fabric_base ADD COLUMN loss_percent DECIMAL(5,2) NOT NULL DEFAULT 0.00 AFTER hsn_code', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mst_fabric_base' AND COLUMN_NAME = 'generated_description');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE mst_fabric_base ADD COLUMN generated_description TEXT NULL AFTER description', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mst_fabric_base' AND COLUMN_NAME = 'legacy_description');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE mst_fabric_base ADD COLUMN legacy_description TEXT NULL AFTER generated_description', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- mst_fabric (variants): min/max GSM, grey/finished/usable widths, width_uom, width_form
SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mst_fabric' AND COLUMN_NAME = 'min_gsm');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE mst_fabric ADD COLUMN min_gsm INT UNSIGNED NULL AFTER gsm_id', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mst_fabric' AND COLUMN_NAME = 'max_gsm');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE mst_fabric ADD COLUMN max_gsm INT UNSIGNED NULL AFTER min_gsm', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mst_fabric' AND COLUMN_NAME = 'grey_width');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE mst_fabric ADD COLUMN grey_width DECIMAL(8,2) NULL AFTER width_cm', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mst_fabric' AND COLUMN_NAME = 'finished_width');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE mst_fabric ADD COLUMN finished_width DECIMAL(8,2) NULL AFTER grey_width', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mst_fabric' AND COLUMN_NAME = 'usable_width');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE mst_fabric ADD COLUMN usable_width DECIMAL(8,2) NULL AFTER finished_width', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mst_fabric' AND COLUMN_NAME = 'width_uom');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE mst_fabric ADD COLUMN width_uom VARCHAR(20) NOT NULL DEFAULT \'INCH\' AFTER usable_width', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mst_fabric' AND COLUMN_NAME = 'width_form');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE mst_fabric ADD COLUMN width_form ENUM(\'TUBULAR\',\'OPEN_WIDTH\') NOT NULL DEFAULT \'TUBULAR\' AFTER width_uom', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;


-- -----------------------------------------------------------------------------
-- 2. YARN MASTER ENHANCEMENTS (mst_yarn_base & mst_yarn_component)
-- -----------------------------------------------------------------------------

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mst_yarn_base' AND COLUMN_NAME = 'spinning_system');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE mst_yarn_base ADD COLUMN spinning_system VARCHAR(60) NULL AFTER yarn_type', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mst_yarn_base' AND COLUMN_NAME = 'yarn_construction');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE mst_yarn_base ADD COLUMN yarn_construction VARCHAR(60) NULL AFTER spinning_system', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mst_yarn_base' AND COLUMN_NAME = 'effect');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE mst_yarn_base ADD COLUMN effect VARCHAR(80) NULL AFTER yarn_construction', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mst_yarn_base' AND COLUMN_NAME = 'dye_status');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE mst_yarn_base ADD COLUMN dye_status VARCHAR(60) NOT NULL DEFAULT \'Undyed\' AFTER effect', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mst_yarn_base' AND COLUMN_NAME = 'dyeing_method');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE mst_yarn_base ADD COLUMN dyeing_method VARCHAR(60) NULL AFTER dye_status', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mst_yarn_base' AND COLUMN_NAME = 'colour_id');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE mst_yarn_base ADD COLUMN colour_id BIGINT UNSIGNED NULL AFTER dyeing_method', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mst_yarn_base' AND COLUMN_NAME = 'twist_direction');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE mst_yarn_base ADD COLUMN twist_direction ENUM(\'S\',\'Z\') NOT NULL DEFAULT \'Z\' AFTER colour_id', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mst_yarn_base' AND COLUMN_NAME = 'tpi');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE mst_yarn_base ADD COLUMN tpi DECIMAL(8,2) NULL AFTER twist_direction', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mst_yarn_base' AND COLUMN_NAME = 'tpm');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE mst_yarn_base ADD COLUMN tpm DECIMAL(8,2) NULL AFTER tpi', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mst_yarn_base' AND COLUMN_NAME = 'strength');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE mst_yarn_base ADD COLUMN strength VARCHAR(40) NULL AFTER tpm', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mst_yarn_base' AND COLUMN_NAME = 'elongation_pct');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE mst_yarn_base ADD COLUMN elongation_pct DECIMAL(5,2) NULL AFTER strength', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mst_yarn_base' AND COLUMN_NAME = 'hairiness');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE mst_yarn_base ADD COLUMN hairiness DECIMAL(5,2) NULL AFTER elongation_pct', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mst_yarn_base' AND COLUMN_NAME = 'cv_pct');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE mst_yarn_base ADD COLUMN cv_pct DECIMAL(5,2) NULL AFTER hairiness', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mst_yarn_base' AND COLUMN_NAME = 'moisture_pct');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE mst_yarn_base ADD COLUMN moisture_pct DECIMAL(5,2) NULL AFTER cv_pct', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mst_yarn_base' AND COLUMN_NAME = 'generated_description');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE mst_yarn_base ADD COLUMN generated_description TEXT NULL AFTER description', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mst_yarn_base' AND COLUMN_NAME = 'legacy_description');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE mst_yarn_base ADD COLUMN legacy_description TEXT NULL AFTER generated_description', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Child Table for Multi-Component Yarn Counts (e.g. 30s/30s/10s, 34s/34s/10s)
CREATE TABLE IF NOT EXISTS mst_yarn_component (
  id               BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id       BIGINT UNSIGNED NULL,
  yarn_id          BIGINT UNSIGNED NOT NULL,
  seq_no           INT NOT NULL DEFAULT 1,
  component_count  VARCHAR(30) NOT NULL,
  count_system     VARCHAR(20) NOT NULL DEFAULT 'Ne',
  component_fibre  VARCHAR(80),
  component_role   VARCHAR(50),
  component_ply    INT DEFAULT 1,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_ycomp_yarn (yarn_id),
  CONSTRAINT fk_ycomp__yarn    FOREIGN KEY (yarn_id)    REFERENCES mst_yarn(id) ON DELETE CASCADE
) ENGINE=InnoDB COMMENT='Multi-component count specifications (e.g. 30s/30s/10s)';


-- -----------------------------------------------------------------------------
-- 3. GENERAL PURCHASE MODULE (trx_general_purchase & trx_general_purchase_line)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS trx_general_purchase (
  id                BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id        BIGINT UNSIGNED NOT NULL,
  branch_id         BIGINT UNSIGNED NULL,
  purchase_no       VARCHAR(40) NOT NULL,
  purchase_date     DATE NOT NULL,
  supplier_id       BIGINT UNSIGNED NOT NULL,
  purchase_type     ENUM('GENERAL','STOCK','ORDER_SPECIFIC','EMERGENCY','MAINTENANCE','SAMPLE') NOT NULL DEFAULT 'GENERAL',
  supplier_inv_no   VARCHAR(60),
  supplier_inv_date DATE,
  currency_id       SMALLINT UNSIGNED NOT NULL,
  exchange_rate     DECIMAL(18,6) DEFAULT 1.000000,
  payment_terms     VARCHAR(150),
  reference_po_id   BIGINT UNSIGNED NULL,
  subtotal          DECIMAL(18,4) DEFAULT 0.0000,
  discount_amount   DECIMAL(18,4) DEFAULT 0.0000,
  tax_amount        DECIMAL(18,4) DEFAULT 0.0000,
  grand_total       DECIMAL(18,4) DEFAULT 0.0000,
  status_id         INT UNSIGNED NULL,
  approval_state    ENUM('DRAFT','PENDING','APPROVED','REJECTED','POSTED','CANCELLED') DEFAULT 'DRAFT',
  remarks           TEXT,
  is_deleted        TINYINT(1) NOT NULL DEFAULT 0,
  created_by        BIGINT UNSIGNED,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by        BIGINT UNSIGNED,
  updated_at        DATETIME ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_gp (company_id, purchase_no),
  KEY ix_gp_supplier (supplier_id),
  KEY ix_gp_date (purchase_date),
  CONSTRAINT fk_gp__company  FOREIGN KEY (company_id)  REFERENCES mst_company(id),
  CONSTRAINT fk_gp__branch   FOREIGN KEY (branch_id)   REFERENCES mst_branch(id),
  CONSTRAINT fk_gp__supplier FOREIGN KEY (supplier_id) REFERENCES mst_party(id),
  CONSTRAINT fk_gp__currency FOREIGN KEY (currency_id) REFERENCES cfg_currency(id),
  CONSTRAINT fk_gp__status   FOREIGN KEY (status_id)   REFERENCES cfg_status(id)
) ENGINE=InnoDB COMMENT='General Purchase header';

CREATE TABLE IF NOT EXISTS trx_general_purchase_line (
  id                BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  purchase_id       BIGINT UNSIGNED NOT NULL,
  item_description  VARCHAR(255) NOT NULL,
  material_type     ENUM('TRIM','YARN','FABRIC','CONSUMABLE','EXPENSE','SPARE','OTHER') NOT NULL DEFAULT 'CONSUMABLE',
  material_id       BIGINT UNSIGNED NULL,
  qty               DECIMAL(18,5) NOT NULL,
  uom_id            SMALLINT UNSIGNED NOT NULL,
  rate              DECIMAL(18,4) NOT NULL,
  discount_pct      DECIMAL(5,2) DEFAULT 0.00,
  gst_rate          DECIMAL(5,2) DEFAULT 0.00,
  igst_rate         DECIMAL(5,2) DEFAULT 0.00,
  tax_amount        DECIMAL(18,4) DEFAULT 0.0000,
  amount            DECIMAL(18,4) NOT NULL,
  stock_type        ENUM('STOCK','CONSUMABLE','EXPENSE','SPARE') NOT NULL DEFAULT 'STOCK',
  allocation_type   ENUM('GENERAL_STOCK','BUYER_ORDER','PRODUCTION_ORDER','SAMPLE','JOB_WORK','MAINTENANCE','DEPARTMENT','DIRECT_EXPENSE') NOT NULL DEFAULT 'GENERAL_STOCK',
  buyer_id          BIGINT UNSIGNED NULL,
  so_id             BIGINT UNSIGNED NULL,
  prod_order_id     BIGINT UNSIGNED NULL,
  style_id          BIGINT UNSIGNED NULL,
  sample_id         BIGINT UNSIGNED NULL,
  sample_type       VARCHAR(60) NULL,
  jobwork_id        BIGINT UNSIGNED NULL,
  process_name      VARCHAR(60) NULL,
  machine_id        VARCHAR(60) NULL,
  department_id     BIGINT UNSIGNED NULL,
  cost_centre       VARCHAR(80) NULL,
  expense_head      VARCHAR(80) NULL,
  direct_issue      TINYINT(1) NOT NULL DEFAULT 0,
  warehouse_id      BIGINT UNSIGNED NULL,
  remarks           VARCHAR(255),
  KEY ix_gpl_purchase (purchase_id),
  KEY ix_gpl_so (so_id),
  KEY ix_gpl_alloc (allocation_type),
  CONSTRAINT fk_gpl__purchase FOREIGN KEY (purchase_id) REFERENCES trx_general_purchase(id) ON DELETE CASCADE,
  CONSTRAINT fk_gpl__uom      FOREIGN KEY (uom_id)      REFERENCES cfg_uom(id),
  CONSTRAINT fk_gpl__buyer    FOREIGN KEY (buyer_id)    REFERENCES mst_party(id),
  CONSTRAINT fk_gpl__so       FOREIGN KEY (so_id)       REFERENCES trx_sales_order(id),
  CONSTRAINT fk_gpl__style    FOREIGN KEY (style_id)    REFERENCES mst_style(id),
  CONSTRAINT fk_gpl__wh       FOREIGN KEY (warehouse_id) REFERENCES mst_warehouse(id)
) ENGINE=InnoDB COMMENT='General Purchase lines with allocation and direct issue';

-- Register Number Series for GENERAL_PURCHASE
INSERT INTO cfg_number_series (company_id, branch_id, doc_type, fy_id, prefix, next_number, padding)
SELECT c.id, NULL, 'GENERAL_PURCHASE', NULL, 'GP-', 1, 6
FROM mst_company c
WHERE NOT EXISTS (
  SELECT 1 FROM cfg_number_series s WHERE s.company_id = c.id AND s.doc_type = 'GENERAL_PURCHASE'
);
