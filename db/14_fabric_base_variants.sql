-- Migration 14: 2-Tier Fabric Base Master + Fabric GSM/Width Variants Architecture

-- 1. Fabric Base Master (Parent identity: Structure, Fibre Composition, Yarn Feed, Finish, Cert)
CREATE TABLE IF NOT EXISTS mst_fabric_base (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  base_code       VARCHAR(40) NOT NULL,              -- e.g. FB-00001
  base_name       VARCHAR(150) NOT NULL,             -- e.g. Single Jersey 100% Combed Cotton
  category_id     INT UNSIGNED,
  fabric_type     ENUM('KNIT','WOVEN','NONWOVEN') NOT NULL DEFAULT 'KNIT',
  knit_structure  VARCHAR(60),                       -- Single Jersey, 1x1 Rib, Interlock, Fleece, Pique
  composition_id  INT UNSIGNED,
  yarn_id         BIGINT UNSIGNED,                   -- Primary yarn feed
  finish_type     VARCHAR(80) DEFAULT 'Bio-wash + Silicon',
  certification   VARCHAR(80) DEFAULT 'NONE',        -- GOTS, OEKO-TEX, BCI, GRS, NONE
  hsn_code        VARCHAR(10) DEFAULT '6006',
  base_uom        SMALLINT UNSIGNED NOT NULL,        -- KG / MTR
  image_url       VARCHAR(500),                      -- Fabric Swatch Photo
  description     VARCHAR(255),
  is_active       TINYINT(1) NOT NULL DEFAULT 1,
  is_deleted      TINYINT(1) NOT NULL DEFAULT 0,
  created_by      BIGINT UNSIGNED,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by      BIGINT UNSIGNED,
  updated_at      DATETIME ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_fabric_base (company_id, base_code),
  CONSTRAINT fk_fbase__company FOREIGN KEY (company_id)     REFERENCES mst_company(id),
  CONSTRAINT fk_fbase__cat     FOREIGN KEY (category_id)    REFERENCES mst_material_category(id),
  CONSTRAINT fk_fbase__comp    FOREIGN KEY (composition_id) REFERENCES mst_composition(id),
  CONSTRAINT fk_fbase__yarn    FOREIGN KEY (yarn_id)        REFERENCES mst_yarn(id),
  CONSTRAINT fk_fbase__uom     FOREIGN KEY (base_uom)       REFERENCES cfg_uom(id)
) ENGINE=InnoDB COMMENT='Fabric base master without GSM and width specifications';

-- 2. Alter mst_fabric to link to Fabric Base (Idempotent for MySQL 8)
SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mst_fabric' AND COLUMN_NAME = 'fabric_base_id');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE mst_fabric ADD COLUMN fabric_base_id BIGINT UNSIGNED NULL AFTER category_id', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mst_fabric' AND COLUMN_NAME = 'gauge');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE mst_fabric ADD COLUMN gauge VARCHAR(20) DEFAULT \'24 GG\' AFTER dia_inch', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Add foreign key constraint if not exist
SET @fk_fbase_exists = (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_NAME = 'fk_fabric__base'
);
SET @sql = IF(@fk_fbase_exists = 0,
  'ALTER TABLE mst_fabric ADD CONSTRAINT fk_fabric__base FOREIGN KEY (fabric_base_id) REFERENCES mst_fabric_base(id) ON DELETE SET NULL',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
