-- =============================================================================
-- Migration 21: Fabric, Yarn, General Procurement & CAD Auto-Consumption
-- Aligns with:
--   1. Fabric Purchase (Quotation -> PO -> GRN -> Roll Stock) Spec v2
--   2. Yarn Purchase (Grey/Dyed, Direct KG / Pack-Bag, PO, GRN) Spec v2
--   3. CAD Requirement & Auto-Consumption Engine Spec v1
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. PURCHASE ORDER ENHANCEMENTS (trx_purchase_order & trx_purchase_order_line)
-- -----------------------------------------------------------------------------

-- trx_purchase_order: internal_ir_no, style_id, order_type, quotation_id
SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_purchase_order' AND COLUMN_NAME = 'internal_ir_no');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_purchase_order ADD COLUMN internal_ir_no VARCHAR(60) NULL AFTER po_no', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_purchase_order' AND COLUMN_NAME = 'style_id');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_purchase_order ADD COLUMN style_id BIGINT UNSIGNED NULL AFTER so_id, ADD CONSTRAINT fk_po__style FOREIGN KEY (style_id) REFERENCES mst_style(id)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_purchase_order' AND COLUMN_NAME = 'order_type');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_purchase_order ADD COLUMN order_type VARCHAR(40) NULL DEFAULT \'PRODUCTION\' AFTER po_type', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_purchase_order' AND COLUMN_NAME = 'quotation_id');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_purchase_order ADD COLUMN quotation_id BIGINT UNSIGNED NULL AFTER order_type, ADD CONSTRAINT fk_po__quotation FOREIGN KEY (quotation_id) REFERENCES trx_quotation(id)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- trx_purchase_order_line: Fabric & Yarn fields
SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_purchase_order_line' AND COLUMN_NAME = 'fabric_type');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_purchase_order_line ADD COLUMN fabric_type VARCHAR(40) NULL AFTER description', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_purchase_order_line' AND COLUMN_NAME = 'dia');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_purchase_order_line ADD COLUMN dia VARCHAR(40) NULL AFTER fabric_type', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_purchase_order_line' AND COLUMN_NAME = 'gsm');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_purchase_order_line ADD COLUMN gsm VARCHAR(30) NULL AFTER dia', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_purchase_order_line' AND COLUMN_NAME = 'composition');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_purchase_order_line ADD COLUMN composition VARCHAR(100) NULL AFTER gsm', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_purchase_order_line' AND COLUMN_NAME = 'shade_code');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_purchase_order_line ADD COLUMN shade_code VARCHAR(50) NULL AFTER composition', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_purchase_order_line' AND COLUMN_NAME = 'print_flag');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_purchase_order_line ADD COLUMN print_flag TINYINT(1) NOT NULL DEFAULT 0 AFTER shade_code', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_purchase_order_line' AND COLUMN_NAME = 'print_color');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_purchase_order_line ADD COLUMN print_color VARCHAR(60) NULL AFTER print_flag', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_purchase_order_line' AND COLUMN_NAME = 'finish');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_purchase_order_line ADD COLUMN finish VARCHAR(80) NULL AFTER print_color', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_purchase_order_line' AND COLUMN_NAME = 'mill_id');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_purchase_order_line ADD COLUMN mill_id BIGINT UNSIGNED NULL AFTER finish, ADD CONSTRAINT fk_pol__mill FOREIGN KEY (mill_id) REFERENCES mst_party(id)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_purchase_order_line' AND COLUMN_NAME = 'weight_kg');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_purchase_order_line ADD COLUMN weight_kg DECIMAL(18,3) NULL AFTER qty', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_purchase_order_line' AND COLUMN_NAME = 'no_of_rolls');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_purchase_order_line ADD COLUMN no_of_rolls INT UNSIGNED NULL AFTER weight_kg', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_purchase_order_line' AND COLUMN_NAME = 'discount_amount');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_purchase_order_line ADD COLUMN discount_amount DECIMAL(18,4) DEFAULT 0 AFTER amount', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_purchase_order_line' AND COLUMN_NAME = 'freight_amount');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_purchase_order_line ADD COLUMN freight_amount DECIMAL(18,4) DEFAULT 0 AFTER discount_amount', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_purchase_order_line' AND COLUMN_NAME = 'other_charges');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_purchase_order_line ADD COLUMN other_charges DECIMAL(18,4) DEFAULT 0 AFTER freight_amount', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_purchase_order_line' AND COLUMN_NAME = 'net_amount');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_purchase_order_line ADD COLUMN net_amount DECIMAL(18,4) DEFAULT 0 AFTER other_charges', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Yarn specific fields in line
SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_purchase_order_line' AND COLUMN_NAME = 'yarn_type');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_purchase_order_line ADD COLUMN yarn_type VARCHAR(40) NULL AFTER fabric_type', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_purchase_order_line' AND COLUMN_NAME = 'purchase_basis');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_purchase_order_line ADD COLUMN purchase_basis VARCHAR(30) NULL DEFAULT \'DIRECT_KG\' AFTER yarn_type', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_purchase_order_line' AND COLUMN_NAME = 'yarn_count_str');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_purchase_order_line ADD COLUMN yarn_count_str VARCHAR(50) NULL AFTER purchase_basis', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_purchase_order_line' AND COLUMN_NAME = 'yarn_category');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_purchase_order_line ADD COLUMN yarn_category VARCHAR(60) NULL AFTER yarn_count_str', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_purchase_order_line' AND COLUMN_NAME = 'dyeing_mill_id');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_purchase_order_line ADD COLUMN dyeing_mill_id BIGINT UNSIGNED NULL AFTER mill_id, ADD CONSTRAINT fk_pol__dyemill FOREIGN KEY (dyeing_mill_id) REFERENCES mst_party(id)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_purchase_order_line' AND COLUMN_NAME = 'packs');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_purchase_order_line ADD COLUMN packs INT UNSIGNED NULL AFTER no_of_rolls', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_purchase_order_line' AND COLUMN_NAME = 'pack_weight_kg');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_purchase_order_line ADD COLUMN pack_weight_kg DECIMAL(18,3) NULL AFTER packs', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- -----------------------------------------------------------------------------
-- 2. GOODS RECEIPT NOTE (GRN) ENHANCEMENTS (trx_grn & trx_grn_line)
-- -----------------------------------------------------------------------------

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_grn' AND COLUMN_NAME = 'internal_ir_no');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_grn ADD COLUMN internal_ir_no VARCHAR(60) NULL AFTER grn_no', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_grn' AND COLUMN_NAME = 'style_id');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_grn ADD COLUMN style_id BIGINT UNSIGNED NULL AFTER po_id, ADD CONSTRAINT fk_grn__style FOREIGN KEY (style_id) REFERENCES mst_style(id)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_grn' AND COLUMN_NAME = 'qc_status');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_grn ADD COLUMN qc_status ENUM(\'PENDING\',\'ACCEPTED\',\'PARTIAL_ACCEPTED\',\'HOLD\',\'REJECTED\') NOT NULL DEFAULT \'PENDING\' AFTER status_id', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- trx_grn_line: received_weight, no_of_rolls, hold_qty, lot_no, qc_status, balance_qty
SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_grn_line' AND COLUMN_NAME = 'received_weight');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_grn_line ADD COLUMN received_weight DECIMAL(18,3) NULL AFTER received_qty', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_grn_line' AND COLUMN_NAME = 'no_of_rolls');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_grn_line ADD COLUMN no_of_rolls INT UNSIGNED NULL AFTER received_weight', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_grn_line' AND COLUMN_NAME = 'hold_qty');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_grn_line ADD COLUMN hold_qty DECIMAL(18,5) DEFAULT 0 AFTER rejected_qty', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_grn_line' AND COLUMN_NAME = 'lot_no');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_grn_line ADD COLUMN lot_no VARCHAR(60) NULL AFTER batch_id', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_grn_line' AND COLUMN_NAME = 'qc_status');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_grn_line ADD COLUMN qc_status ENUM(\'PENDING\',\'ACCEPTED\',\'PARTIAL_ACCEPTED\',\'HOLD\',\'REJECTED\') NOT NULL DEFAULT \'PENDING\' AFTER lot_no', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_grn_line' AND COLUMN_NAME = 'balance_qty');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_grn_line ADD COLUMN balance_qty DECIMAL(18,5) DEFAULT 0 AFTER qc_status', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- -----------------------------------------------------------------------------
-- 3. FABRIC ROLL TRACEABILITY (trx_fabric_roll)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS trx_fabric_roll (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  grn_id          BIGINT UNSIGNED NOT NULL,
  grn_line_id     BIGINT UNSIGNED NOT NULL,
  fabric_id       BIGINT UNSIGNED NOT NULL,
  roll_no         VARCHAR(60) NOT NULL,
  lot_no          VARCHAR(60) NULL,
  meters          DECIMAL(18,3) NULL,
  weight_kg       DECIMAL(18,3) NULL,
  gsm             INT UNSIGNED NULL,
  dia             VARCHAR(30) NULL,
  shade           VARCHAR(50) NULL,
  warehouse_id    BIGINT UNSIGNED NOT NULL,
  location_bin    VARCHAR(50) NULL,
  qc_status       ENUM('PENDING','ACCEPTED','HOLD','REJECTED') NOT NULL DEFAULT 'PENDING',
  stock_status    ENUM('AVAILABLE','RESERVED','ISSUED','PARTIAL','CLOSED') NOT NULL DEFAULT 'AVAILABLE',
  remarks         VARCHAR(255) NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_froll_grn (grn_id),
  KEY ix_froll_fabric (fabric_id),
  KEY ix_froll_status (stock_status, qc_status),
  CONSTRAINT fk_froll__company   FOREIGN KEY (company_id)   REFERENCES mst_company(id),
  CONSTRAINT fk_froll__grn       FOREIGN KEY (grn_id)       REFERENCES trx_grn(id) ON DELETE CASCADE,
  CONSTRAINT fk_froll__grn_line  FOREIGN KEY (grn_line_id)  REFERENCES trx_grn_line(id) ON DELETE CASCADE,
  CONSTRAINT fk_froll__fabric    FOREIGN KEY (fabric_id)    REFERENCES mst_fabric(id),
  CONSTRAINT fk_froll__warehouse FOREIGN KEY (warehouse_id) REFERENCES mst_warehouse(id)
) ENGINE=InnoDB COMMENT='Physical fabric rolls for roll-level traceability';

-- -----------------------------------------------------------------------------
-- 4. CAD REQUIREMENT & AUTO-CONSUMPTION TABLES
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS trx_cad_requirement (
  id                  BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id          BIGINT UNSIGNED NOT NULL,
  req_no              VARCHAR(40) NOT NULL,
  req_date            DATE NOT NULL,
  internal_ir_no      VARCHAR(60) NOT NULL,
  style_id            BIGINT UNSIGNED NOT NULL,
  buyer_id            BIGINT UNSIGNED NULL,
  order_qty           INT UNSIGNED NOT NULL DEFAULT 1000,
  size_group_id       INT UNSIGNED NULL,
  cad_version         VARCHAR(30) NOT NULL DEFAULT 'V01',
  cad_file_name       VARCHAR(255) NULL,
  marker_file_name    VARCHAR(255) NULL,
  import_source       ENUM('MANUAL','CSV','EXCEL','CAD') NOT NULL DEFAULT 'MANUAL',
  consumption_source  ENUM('PIECE_AREA','MARKER_DATA','MANUAL') NOT NULL DEFAULT 'PIECE_AREA',
  marker_efficiency   DECIMAL(5,2) NOT NULL DEFAULT 85.00,
  status              ENUM('DRAFT','VALIDATED','APPROVED','OBSOLETE') NOT NULL DEFAULT 'DRAFT',
  remarks             TEXT NULL,
  data_json           LONGTEXT NULL COMMENT 'Structured JSON snapshot: sizes, components, pieces, stripeRules, mixRules, wastage, outputs',
  created_by          BIGINT UNSIGNED NULL,
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_cad_req (company_id, req_no),
  KEY ix_cad_style (style_id),
  KEY ix_cad_ir (internal_ir_no),
  CONSTRAINT fk_cad__company FOREIGN KEY (company_id) REFERENCES mst_company(id),
  CONSTRAINT fk_cad__style   FOREIGN KEY (style_id)   REFERENCES mst_style(id),
  CONSTRAINT fk_cad__buyer   FOREIGN KEY (buyer_id)   REFERENCES mst_party(id)
) ENGINE=InnoDB COMMENT='CAD requirement header with size breakdown and calculation versions';

CREATE TABLE IF NOT EXISTS trx_cad_piece (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  cad_req_id      BIGINT UNSIGNED NOT NULL,
  piece_id        VARCHAR(40) NOT NULL,
  piece_name      VARCHAR(80) NOT NULL,
  component       VARCHAR(50) NOT NULL DEFAULT 'BODY',
  size_name       VARCHAR(30) NULL,
  length_mm       DECIMAL(10,2) NULL,
  width_mm        DECIMAL(10,2) NULL,
  area_sqm        DECIMAL(10,4) NOT NULL DEFAULT 0.0000,
  piece_qty       INT UNSIGNED NOT NULL DEFAULT 1,
  marker_no       VARCHAR(50) NULL,
  material_type   VARCHAR(40) NOT NULL DEFAULT 'FABRIC',
  material_id     BIGINT UNSIGNED NULL,
  material_code   VARCHAR(60) NULL,
  color_name      VARCHAR(60) NULL,
  shade_code      VARCHAR(40) NULL,
  status          VARCHAR(30) NOT NULL DEFAULT 'MAPPED',
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_cpiece_req (cad_req_id),
  CONSTRAINT fk_cpiece__req FOREIGN KEY (cad_req_id) REFERENCES trx_cad_requirement(id) ON DELETE CASCADE
) ENGINE=InnoDB COMMENT='CAD geometry pieces mapped to ERP components and materials';

CREATE TABLE IF NOT EXISTS trx_cad_material_requirement (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  cad_req_id      BIGINT UNSIGNED NOT NULL,
  style_id        BIGINT UNSIGNED NOT NULL,
  so_id           BIGINT UNSIGNED NULL,
  version_no      VARCHAR(30) NOT NULL DEFAULT 'V01',
  status          ENUM('DRAFT','APPROVED','RELEASED_TO_PPC','CLOSED') NOT NULL DEFAULT 'DRAFT',
  total_fabric_kg DECIMAL(18,3) DEFAULT 0.000,
  total_yarn_kg   DECIMAL(18,3) DEFAULT 0.000,
  data_json       LONGTEXT NULL,
  created_by      BIGINT UNSIGNED NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME ON UPDATE CURRENT_TIMESTAMP,
  KEY ix_cmr_req (cad_req_id),
  CONSTRAINT fk_cmr__company FOREIGN KEY (company_id) REFERENCES mst_company(id),
  CONSTRAINT fk_cmr__req     FOREIGN KEY (cad_req_id) REFERENCES trx_cad_requirement(id) ON DELETE CASCADE,
  CONSTRAINT fk_cmr__style   FOREIGN KEY (style_id)   REFERENCES mst_style(id)
) ENGINE=InnoDB COMMENT='Material Requirement Output generated from CAD Auto-Consumption';

-- Number series for CAD Requirements
INSERT INTO cfg_number_series (company_id, branch_id, doc_type, fy_id, prefix, next_number, padding)
SELECT c.id, NULL, 'CAD_REQ', NULL, 'CAD-', 1, 6
FROM mst_company c
WHERE NOT EXISTS (
  SELECT 1 FROM cfg_number_series s WHERE s.company_id = c.id AND s.doc_type = 'CAD_REQ'
);
