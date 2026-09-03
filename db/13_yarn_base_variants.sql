-- Migration 13: 2-Tier Yarn Base Master + Yarn Count Variants Architecture

-- 1. Standard Count Master
CREATE TABLE IF NOT EXISTS mst_yarn_count (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  count_value     VARCHAR(30) NOT NULL,              -- e.g. 10s, 20s, 30s, 40s, 60s, 75D/36F
  count_type      ENUM('Ne','Nm','Denier','Tex') NOT NULL DEFAULT 'Ne',
  description     VARCHAR(120),
  sort_order      INT NOT NULL DEFAULT 0,
  is_active       TINYINT(1) NOT NULL DEFAULT 1,
  is_deleted      TINYINT(1) NOT NULL DEFAULT 0,
  created_by      BIGINT UNSIGNED,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by      BIGINT UNSIGNED,
  updated_at      DATETIME ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_yarn_count (company_id, count_value, count_type),
  CONSTRAINT fk_ycount__company FOREIGN KEY (company_id) REFERENCES mst_company(id)
) ENGINE=InnoDB COMMENT='Standard yarn count specifications';

-- 2. Yarn Base Master (Parent identity: Composition, Certification, Fibre Type)
CREATE TABLE IF NOT EXISTS mst_yarn_base (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  base_code       VARCHAR(40) NOT NULL,              -- e.g. YB-00001
  base_name       VARCHAR(150) NOT NULL,             -- e.g. Organic Cotton Combed
  category_id     INT UNSIGNED,
  composition_id  INT UNSIGNED,
  yarn_type       ENUM('COMBED','CARDED','OE','COMPACT','MELANGE','SLUB','OTHER') DEFAULT 'COMBED',
  certification   VARCHAR(80) DEFAULT 'NONE',        -- GOTS, OEKO-TEX, BCI, GRS, NONE
  hsn_code        VARCHAR(10) DEFAULT '5205',
  base_uom        SMALLINT UNSIGNED NOT NULL,        -- KG
  description     VARCHAR(255),
  is_active       TINYINT(1) NOT NULL DEFAULT 1,
  is_deleted      TINYINT(1) NOT NULL DEFAULT 0,
  created_by      BIGINT UNSIGNED,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by      BIGINT UNSIGNED,
  updated_at      DATETIME ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_yarn_base (company_id, base_code),
  CONSTRAINT fk_ybase__company FOREIGN KEY (company_id)     REFERENCES mst_company(id),
  CONSTRAINT fk_ybase__cat     FOREIGN KEY (category_id)    REFERENCES mst_material_category(id),
  CONSTRAINT fk_ybase__comp    FOREIGN KEY (composition_id) REFERENCES mst_composition(id),
  CONSTRAINT fk_ybase__uom     FOREIGN KEY (base_uom)       REFERENCES cfg_uom(id)
) ENGINE=InnoDB COMMENT='Yarn base master without counts';

-- 3. Alter mst_yarn to link to Yarn Base and Count Master (Idempotent for MySQL 8)
SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mst_yarn' AND COLUMN_NAME = 'yarn_base_id');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE mst_yarn ADD COLUMN yarn_base_id BIGINT UNSIGNED NULL AFTER category_id', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mst_yarn' AND COLUMN_NAME = 'count_id');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE mst_yarn ADD COLUMN count_id BIGINT UNSIGNED NULL AFTER count_type', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mst_yarn' AND COLUMN_NAME = 'twist');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE mst_yarn ADD COLUMN twist VARCHAR(10) DEFAULT \'Z\' AFTER ply', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Add foreign key constraints if not exist
SET @fk_ybase_exists = (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_NAME = 'fk_yarn__base'
);
SET @sql = IF(@fk_ybase_exists = 0,
  'ALTER TABLE mst_yarn ADD CONSTRAINT fk_yarn__base FOREIGN KEY (yarn_base_id) REFERENCES mst_yarn_base(id) ON DELETE SET NULL',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @fk_ycount_exists = (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_NAME = 'fk_yarn__count'
);
SET @sql = IF(@fk_ycount_exists = 0,
  'ALTER TABLE mst_yarn ADD CONSTRAINT fk_yarn__count FOREIGN KEY (count_id) REFERENCES mst_yarn_count(id) ON DELETE SET NULL',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
