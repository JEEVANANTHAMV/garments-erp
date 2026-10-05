-- 103: client voice notes 05-Oct-2026 + "Size Master & Style Size Assignment" developer document.
--   * CAD marker files: the marker report PDF / CAD file per marker, with the extracted layout picture (kept by CAD +
--     marker no, because CAD markers are rewritten on every CAD save).
--   * Creatable masters for fibre / fabric type / construction / structure / effect / yarn type / yarn construction.
--   * Fabric and yarn types become free values (were ENUMs) so a new type can be created from the master.
--   * Style size assignment: the sizes valid for a style, picked one by one (a size group is only a shortcut), with log.
-- Re-runnable; every ALTER is guarded.

CREATE TABLE IF NOT EXISTS trx_cad_marker_file (
  id            BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id    BIGINT UNSIGNED NOT NULL,
  cad_req_id    BIGINT UNSIGNED NOT NULL,
  marker_ref    VARCHAR(50) NOT NULL,
  kind          VARCHAR(12) NOT NULL DEFAULT 'REPORT' COMMENT 'REPORT (marker report PDF) / CAD (CAD file) / IMAGE',
  file_name     VARCHAR(255) NOT NULL,
  file_url      VARCHAR(255) NOT NULL,
  file_size     INT UNSIGNED NULL,
  image_url     VARCHAR(255) NULL COMMENT 'Marker layout picture extracted from the report',
  image_w       INT NULL,
  image_h       INT NULL,
  parsed_json   LONGTEXT NULL COMMENT 'Figures read from the report (width, length, efficiency, ratio …)',
  is_active     TINYINT(1) NOT NULL DEFAULT 1,
  uploaded_by   BIGINT UNSIGNED NULL,
  uploaded_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_cmf_marker (cad_req_id, marker_ref, is_active)
) ENGINE=InnoDB COMMENT='Marker report PDF / CAD file and layout picture per CAD marker';

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_marker_version' AND COLUMN_NAME='marker_image_url');
SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_marker_version');
SET @s = IF(@t=1 AND @x=0, 'ALTER TABLE trx_marker_version ADD COLUMN marker_image_url VARCHAR(255) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- ---------------------------------------------------------------- creatable attribute masters
CREATE TABLE IF NOT EXISTS mst_material_attr (
  id          BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id  BIGINT UNSIGNED NOT NULL,
  attr_type   VARCHAR(30) NOT NULL COMMENT 'FIBRE / FABRIC_TYPE / KNIT_STRUCTURE / STRUCTURE / EFFECT / YARN_TYPE / YARN_CONSTRUCTION',
  attr_value  VARCHAR(80) NOT NULL,
  sort_order  INT NOT NULL DEFAULT 100,
  is_active   TINYINT(1) NOT NULL DEFAULT 1,
  created_by  BIGINT UNSIGNED NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_attr (company_id, attr_type, attr_value)
) ENGINE=InnoDB COMMENT='User-maintained lists for the fabric / yarn masters';

INSERT IGNORE INTO mst_material_attr (company_id, attr_type, attr_value, sort_order)
SELECT c.id, t.ty, t.val, t.so FROM mst_company c JOIN (
            SELECT 'FIBRE' ty, 'Cotton' val, 1 so UNION ALL SELECT 'FIBRE','Organic Cotton',2 UNION ALL SELECT 'FIBRE','BCI Cotton',3
  UNION ALL SELECT 'FIBRE','Polyester',4 UNION ALL SELECT 'FIBRE','Recycled Polyester',5 UNION ALL SELECT 'FIBRE','Elastane',6
  UNION ALL SELECT 'FIBRE','Spandex',7 UNION ALL SELECT 'FIBRE','Viscose',8 UNION ALL SELECT 'FIBRE','Modal',9
  UNION ALL SELECT 'FIBRE','Lyocell',10 UNION ALL SELECT 'FIBRE','Linen',11 UNION ALL SELECT 'FIBRE','Wool',12
  UNION ALL SELECT 'FIBRE','Nylon',13 UNION ALL SELECT 'FIBRE','Silk',14 UNION ALL SELECT 'FIBRE','Bamboo',15
  UNION ALL SELECT 'FABRIC_TYPE','KNIT',1 UNION ALL SELECT 'FABRIC_TYPE','WOVEN',2 UNION ALL SELECT 'FABRIC_TYPE','NONWOVEN',3
  UNION ALL SELECT 'KNIT_STRUCTURE','Single Jersey',1 UNION ALL SELECT 'KNIT_STRUCTURE','1x1 Rib',2 UNION ALL SELECT 'KNIT_STRUCTURE','2x2 Rib',3
  UNION ALL SELECT 'KNIT_STRUCTURE','Interlock',4 UNION ALL SELECT 'KNIT_STRUCTURE','Pique',5 UNION ALL SELECT 'KNIT_STRUCTURE','Honey Comb',6
  UNION ALL SELECT 'KNIT_STRUCTURE','French Terry',7 UNION ALL SELECT 'KNIT_STRUCTURE','Fleece',8 UNION ALL SELECT 'KNIT_STRUCTURE','Waffle',9
  UNION ALL SELECT 'KNIT_STRUCTURE','Pointelle',10 UNION ALL SELECT 'KNIT_STRUCTURE','Jacquard',11 UNION ALL SELECT 'KNIT_STRUCTURE','Auto Stripe',12
  UNION ALL SELECT 'KNIT_STRUCTURE','Velour',13 UNION ALL SELECT 'KNIT_STRUCTURE','Twill',14 UNION ALL SELECT 'KNIT_STRUCTURE','Poplin',15
  UNION ALL SELECT 'STRUCTURE','None / Standard',1 UNION ALL SELECT 'STRUCTURE','Plated',2 UNION ALL SELECT 'STRUCTURE','Double Layer',3
  UNION ALL SELECT 'EFFECT','None',1 UNION ALL SELECT 'EFFECT','Slub',2 UNION ALL SELECT 'EFFECT','Melange',3 UNION ALL SELECT 'EFFECT','Grindle',4
  UNION ALL SELECT 'EFFECT','Stripe',5 UNION ALL SELECT 'EFFECT','AOP',6 UNION ALL SELECT 'EFFECT','Neppy',7 UNION ALL SELECT 'EFFECT','Space Dyed',8
  UNION ALL SELECT 'YARN_TYPE','COMBED',1 UNION ALL SELECT 'YARN_TYPE','CARDED',2 UNION ALL SELECT 'YARN_TYPE','OE',3 UNION ALL SELECT 'YARN_TYPE','COMPACT',4
  UNION ALL SELECT 'YARN_TYPE','MELANGE',5 UNION ALL SELECT 'YARN_TYPE','SLUB',6 UNION ALL SELECT 'YARN_TYPE','OTHER',7
  UNION ALL SELECT 'YARN_CONSTRUCTION','Single',1 UNION ALL SELECT 'YARN_CONSTRUCTION','Plied',2 UNION ALL SELECT 'YARN_CONSTRUCTION','Cabled',3
  UNION ALL SELECT 'YARN_CONSTRUCTION','Core Spun',4 UNION ALL SELECT 'YARN_CONSTRUCTION','Covered',5 UNION ALL SELECT 'YARN_CONSTRUCTION','Twisted',6
  UNION ALL SELECT 'YARN_CONSTRUCTION','Textured Filament',7) t;

-- values already used in the masters stay selectable
INSERT IGNORE INTO mst_material_attr (company_id, attr_type, attr_value, sort_order)
SELECT DISTINCT company_id, 'KNIT_STRUCTURE', TRIM(knit_structure), 200 FROM mst_fabric_base WHERE COALESCE(TRIM(knit_structure),'') <> '';
INSERT IGNORE INTO mst_material_attr (company_id, attr_type, attr_value, sort_order)
SELECT DISTINCT company_id, 'STRUCTURE', TRIM(structure), 200 FROM mst_fabric_base WHERE COALESCE(TRIM(structure),'') <> '';
INSERT IGNORE INTO mst_material_attr (company_id, attr_type, attr_value, sort_order)
SELECT DISTINCT company_id, 'EFFECT', TRIM(effect), 200 FROM mst_fabric_base WHERE COALESCE(TRIM(effect),'') <> '';
INSERT IGNORE INTO mst_material_attr (company_id, attr_type, attr_value, sort_order)
SELECT DISTINCT company_id, 'YARN_CONSTRUCTION', TRIM(yarn_construction), 200 FROM mst_yarn_base WHERE COALESCE(TRIM(yarn_construction),'') <> '';
INSERT IGNORE INTO mst_material_attr (company_id, attr_type, attr_value, sort_order)
SELECT DISTINCT c.company_id, 'FIBRE', TRIM(d.fibre_name), 200 FROM mst_composition_detail d JOIN mst_composition c ON c.id = d.composition_id WHERE COALESCE(TRIM(d.fibre_name),'') <> '';

-- fabric / yarn types are master values now, not a fixed list
SET @s = IF((SELECT DATA_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='mst_fabric' AND COLUMN_NAME='fabric_type')='enum',
  'ALTER TABLE mst_fabric MODIFY COLUMN fabric_type VARCHAR(40) NOT NULL DEFAULT ''KNIT''', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = IF((SELECT DATA_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='mst_fabric_base' AND COLUMN_NAME='fabric_type')='enum',
  'ALTER TABLE mst_fabric_base MODIFY COLUMN fabric_type VARCHAR(40) NOT NULL DEFAULT ''KNIT''', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = IF((SELECT DATA_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='mst_yarn' AND COLUMN_NAME='yarn_type')='enum',
  'ALTER TABLE mst_yarn MODIFY COLUMN yarn_type VARCHAR(40) NULL DEFAULT ''COMBED''', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s = IF((SELECT DATA_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='mst_yarn_base' AND COLUMN_NAME='yarn_type')='enum',
  'ALTER TABLE mst_yarn_base MODIFY COLUMN yarn_type VARCHAR(40) NULL DEFAULT ''COMBED''', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- ---------------------------------------------------------------- style size assignment (size doc §6)
CREATE TABLE IF NOT EXISTS mst_style_size (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  style_id        BIGINT UNSIGNED NOT NULL,
  size_id         INT UNSIGNED NOT NULL,
  sequence_no     INT NOT NULL DEFAULT 1,
  is_default      TINYINT(1) NOT NULL DEFAULT 0,
  is_active       TINYINT(1) NOT NULL DEFAULT 1,
  source_type     VARCHAR(10) NOT NULL DEFAULT 'MANUAL' COMMENT 'GROUP / MANUAL / IMPORT / ORDER',
  source_group_id INT UNSIGNED NULL,
  created_by      BIGINT UNSIGNED NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_style_size (style_id, size_id),
  KEY ix_style_size_seq (style_id, sequence_no),
  CONSTRAINT fk_ss__style FOREIGN KEY (style_id) REFERENCES mst_style(id),
  CONSTRAINT fk_ss__size FOREIGN KEY (size_id) REFERENCES mst_size(id)
) ENGINE=InnoDB COMMENT='Sizes valid for a style (size doc §6); a size group only fills it';

CREATE TABLE IF NOT EXISTS trx_style_size_log (
  id          BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id  BIGINT UNSIGNED NOT NULL,
  style_id    BIGINT UNSIGNED NOT NULL,
  size_id     INT UNSIGNED NULL,
  action      VARCHAR(20) NOT NULL COMMENT 'ADD / REMOVE / REORDER / ADD_GROUP / ORDER_ADD',
  old_value   VARCHAR(255) NULL,
  new_value   VARCHAR(255) NULL,
  reason      VARCHAR(255) NULL,
  so_id       BIGINT UNSIGNED NULL,
  user_id     BIGINT UNSIGNED NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_ssl_style (style_id)
) ENGINE=InnoDB COMMENT='Style size changes: who, when, old / new, reason (size doc §18)';

-- backfill: a style's sizes are the sizes of its SKUs; a style without SKUs takes its size group
INSERT IGNORE INTO mst_style_size (style_id, size_id, sequence_no, source_type)
SELECT k.style_id, k.size_id, MIN(sz.sort_order), 'IMPORT' FROM mst_style_sku k JOIN mst_size sz ON sz.id = k.size_id
 WHERE k.is_active = 1 GROUP BY k.style_id, k.size_id;
INSERT IGNORE INTO mst_style_size (style_id, size_id, sequence_no, source_type, source_group_id)
SELECT st.id, sz.id, sz.sort_order, 'GROUP', st.size_group_id FROM mst_style st JOIN mst_size sz ON sz.size_group_id = st.size_group_id AND sz.is_active = 1
 WHERE NOT EXISTS (SELECT 1 FROM mst_style_sku k WHERE k.style_id = st.id);

INSERT IGNORE INTO cfg_system_setting (company_id, setting_key, setting_value, description)
SELECT id, 'SO_ALLOW_ADDITIONAL_SIZE', '1', 'Sales order may add a size that is not on the style (needs SALES_ORDER.ADD_SIZE and a reason; logged)' FROM mst_company;

INSERT INTO mst_permission (module_id, permission_code, permission_name)
SELECT m.id, 'SALES_ORDER.ADD_SIZE', 'Add a size not on the style to a sales order'
  FROM mst_module m WHERE m.module_code = 'SALES'
   AND NOT EXISTS (SELECT 1 FROM mst_permission x WHERE x.permission_code = 'SALES_ORDER.ADD_SIZE') LIMIT 1;
