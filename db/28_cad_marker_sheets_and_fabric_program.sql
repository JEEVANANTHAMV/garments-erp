-- =============================================================================
-- Migration 28: CAD Marker Sheets & Fabric Program / Cutting Lay Engine
-- Supports:
--   1. Knit SJ (Single Jersey) in KGS
--   2. Heavy Knits / Fleece with Flat Knits & Trims in KGS / Nos
--   3. Hoodies with Linings & Draw Cords
--   4. Woven Seersucker / Voile in Linear METERS (MTRS)
--   5. Multi-Marker Sheets (1A, 1B, 2A, etc.) with Lay & Table Width Buffers
--   6. Summary Fabric Program (F.PRGM) and Cutting Lay Sheet (CUT)
-- =============================================================================

-- 1. ENHANCE trx_cad_requirement
SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_cad_requirement' AND COLUMN_NAME = 'cad_type');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_cad_requirement ADD COLUMN cad_type ENUM(\'KNIT_SJ\',\'KNIT_FLEECE\',\'WOVEN\',\'MULTI_PART\') NOT NULL DEFAULT \'KNIT_SJ\' AFTER consumption_source', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_cad_requirement' AND COLUMN_NAME = 'uom');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_cad_requirement ADD COLUMN uom ENUM(\'KG\',\'MTR\') NOT NULL DEFAULT \'KG\' AFTER cad_type', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_cad_requirement' AND COLUMN_NAME = 'rejection_pct');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_cad_requirement ADD COLUMN rejection_pct DECIMAL(5,2) NOT NULL DEFAULT 3.00 AFTER marker_efficiency', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_cad_requirement' AND COLUMN_NAME = 'fabric_allowance_pct');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_cad_requirement ADD COLUMN fabric_allowance_pct DECIMAL(5,2) NOT NULL DEFAULT 10.00 AFTER rejection_pct', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_cad_requirement' AND COLUMN_NAME = 'special_notes');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_cad_requirement ADD COLUMN special_notes TEXT NULL AFTER remarks', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_cad_requirement' AND COLUMN_NAME = 'signoff_json');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_cad_requirement ADD COLUMN signoff_json LONGTEXT NULL AFTER special_notes', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 2. CREATE TABLE trx_cad_marker
CREATE TABLE IF NOT EXISTS trx_cad_marker (
  id                    BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  cad_req_id            BIGINT UNSIGNED NOT NULL,
  marker_ref            VARCHAR(50) NOT NULL DEFAULT '1A',
  marker_name           VARCHAR(100) NULL,
  length_mm             DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  width_mm              DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  fabric_dia_type       ENUM('OPEN','TUBE') NOT NULL DEFAULT 'OPEN',
  fabric_type           VARCHAR(150) NULL,
  gsm                   DECIMAL(8,2) NULL,
  direction             VARCHAR(40) NOT NULL DEFAULT 'ONEWAY',
  parts_in_lay          VARCHAR(255) NULL,
  lay_allowance_cm      DECIMAL(6,2) NOT NULL DEFAULT 10.00,
  width_allowance_in    DECIMAL(6,2) NOT NULL DEFAULT 2.00,
  lay_length_cm         DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  table_width_in        DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  fabric_wt_per_lay_g   DECIMAL(14,3) NOT NULL DEFAULT 0.000,
  no_of_pcs_lay         INT UNSIGNED NOT NULL DEFAULT 1,
  avg_wt_per_pc_g       DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  req_length_per_pc_cm  DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  total_req_qty         DECIMAL(14,3) NOT NULL DEFAULT 0.000,
  uom                   ENUM('KG','MTR') NOT NULL DEFAULT 'KG',
  sort_order            INT UNSIGNED NOT NULL DEFAULT 1,
  data_json             LONGTEXT NULL COMMENT 'Stores sizes, ratio, pcs/lay, order quantity matrix per colorway',
  created_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            DATETIME ON UPDATE CURRENT_TIMESTAMP,
  KEY ix_cmarker_req (cad_req_id),
  CONSTRAINT fk_cmarker__req FOREIGN KEY (cad_req_id) REFERENCES trx_cad_requirement(id) ON DELETE CASCADE
) ENGINE=InnoDB COMMENT='CAD physical marker lays (1A, 1B, 2A, etc.) with dimension buffers and lay calculations';

-- 3. CREATE TABLE trx_cad_fabric_program
CREATE TABLE IF NOT EXISTS trx_cad_fabric_program (
  id                    BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  cad_req_id            BIGINT UNSIGNED NOT NULL,
  sheet_type            ENUM('FABRIC_PROGRAM','CUTTING_LAY') NOT NULL DEFAULT 'FABRIC_PROGRAM',
  fabric_type           VARCHAR(150) NOT NULL,
  gsm                   DECIMAL(8,2) NULL,
  dia_spec              VARCHAR(100) NULL,
  color_name            VARCHAR(100) NOT NULL,
  order_qty_pcs         INT UNSIGNED NOT NULL DEFAULT 0,
  net_qty               DECIMAL(14,3) NOT NULL DEFAULT 0.000,
  buffer_qty            DECIMAL(14,3) NOT NULL DEFAULT 0.000,
  grand_total_qty       DECIMAL(14,3) NOT NULL DEFAULT 0.000,
  uom                   ENUM('KG','MTR','PCS','NOS') NOT NULL DEFAULT 'KG',
  remarks               VARCHAR(255) NULL,
  sort_order            INT UNSIGNED NOT NULL DEFAULT 1,
  created_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_cfprog_req (cad_req_id),
  CONSTRAINT fk_cfprog__req FOREIGN KEY (cad_req_id) REFERENCES trx_cad_requirement(id) ON DELETE CASCADE
) ENGINE=InnoDB COMMENT='Consolidated Fabric Request (F.PRGM) and Cutting Lay Sheet (CUT) outputs';
