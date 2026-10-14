-- 121 · Packing engine (client call 14-Oct-2026 + "Garment Packing Module Developer Document")
-- Builds on 118 (trx_packing = packing order, trx_carton = carton header, trx_carton_content = carton detail).
--   mst_packing_rule            buyer / style / PO packing rules (§4)
--   trx_packing (+cols)         engine flag, buyer, rule revision, variance approval
--   trx_packing_order_line      planned colour × size quantities (§5)
--   trx_packing_polybag         piece / polybag entry (Screen B, §6)
--   trx_packing_polybag_use     which posted carton consumed which polybag entry
--   trx_carton_no_registry      carton numbers are never reused (§7)
--   trx_carton_event            create / verify / seal / reopen / void / post / reverse history (§8, §19)
--   trx_packing_consumption     actual polybag / carton consumption per posted carton, by trim stock lot (§10)
--   trx_carton_content          sku_id relaxed to NULL (colour × size lines without a style SKU), bundle_id added
-- Settings: PACKING_ALLOW_NEGATIVE_PACKAGING (0), PACKING_VARIANCE_TOLERANCE_PCT (2). Permission PACKING.APPROVE.

-- ── packing rules ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mst_packing_rule (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  company_id BIGINT UNSIGNED NOT NULL,
  rule_code VARCHAR(40) NOT NULL,
  rule_name VARCHAR(150) NOT NULL,
  buyer_id BIGINT UNSIGNED NULL,
  style_id BIGINT UNSIGNED NULL,
  so_id BIGINT UNSIGNED NULL COMMENT 'PO / job specific rule',
  packing_mode ENUM('BUNDLE_QUANTITY','INDIVIDUAL_PIECE') NOT NULL DEFAULT 'BUNDLE_QUANTITY',
  pieces_per_polybag INT UNSIGNED NOT NULL DEFAULT 1,
  polybag_trim_id BIGINT UNSIGNED NULL,
  carton_trim_id BIGINT UNSIGNED NULL,
  standard_pieces_per_carton INT UNSIGNED NOT NULL DEFAULT 50,
  allow_mixed_sizes TINYINT(1) NOT NULL DEFAULT 0,
  allow_mixed_colours TINYINT(1) NOT NULL DEFAULT 0,
  allow_partial_carton TINYINT(1) NOT NULL DEFAULT 1,
  allow_overpack TINYINT(1) NOT NULL DEFAULT 0,
  label_template VARCHAR(60) NULL,
  effective_from DATE NULL,
  effective_to DATE NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  revision INT UNSIGNED NOT NULL DEFAULT 1,
  remarks VARCHAR(300) NULL,
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by BIGINT UNSIGNED NULL,
  updated_at DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_pkrule (company_id, rule_code),
  KEY ix_pkrule__scope (company_id, so_id, style_id, buyer_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Buyer / style / PO packing rules';

-- ── packing order header extras ────────────────────────────────────
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_packing' AND COLUMN_NAME='is_engine');
SET @s = IF(@x=0, 'ALTER TABLE trx_packing ADD COLUMN is_engine TINYINT(1) NOT NULL DEFAULT 0, ADD COLUMN buyer_id BIGINT UNSIGNED NULL, ADD COLUMN rule_revision INT UNSIGNED NULL, ADD COLUMN variance_approved_by BIGINT UNSIGNED NULL, ADD COLUMN variance_approved_at DATETIME NULL, ADD COLUMN variance_note VARCHAR(300) NULL, ADD COLUMN completed_at DATETIME NULL, ADD COLUMN updated_at DATETIME NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_packing' AND INDEX_NAME='ix_pack__engine');
SET @s = IF(@x=0, 'ALTER TABLE trx_packing ADD INDEX ix_pack__engine (company_id, is_engine, order_status)', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

CREATE TABLE IF NOT EXISTS trx_packing_order_line (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  packing_id BIGINT UNSIGNED NOT NULL,
  color_id BIGINT UNSIGNED NOT NULL,
  size_id INT UNSIGNED NOT NULL,
  sku_id BIGINT UNSIGNED NULL,
  order_qty INT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Buyer order qty (SO SKU)',
  eligible_at_create INT UNSIGNED NOT NULL DEFAULT 0,
  planned_qty INT UNSIGNED NOT NULL DEFAULT 0,
  UNIQUE KEY uq_pol (packing_id, color_id, size_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Packing order planned colour x size';

-- ── piece / polybag entry ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS trx_packing_polybag (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  company_id BIGINT UNSIGNED NOT NULL,
  packing_id BIGINT UNSIGNED NOT NULL,
  entry_mode ENUM('BUNDLE_QUANTITY','INDIVIDUAL_PIECE') NOT NULL DEFAULT 'BUNDLE_QUANTITY',
  bundle_id BIGINT UNSIGNED NOT NULL,
  io_no VARCHAR(60) NULL,
  style_id BIGINT UNSIGNED NULL,
  color_id BIGINT UNSIGNED NULL,
  size_id INT UNSIGNED NULL,
  pieces INT UNSIGNED NOT NULL,
  pieces_per_polybag INT UNSIGNED NOT NULL DEFAULT 1,
  polybag_qty INT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Actual bags used',
  polybag_trim_id BIGINT UNSIGNED NULL,
  cartoned_qty INT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Pieces of this entry inside posted cartons',
  operator_name VARCHAR(100) NULL,
  status ENUM('OPEN','CARTONED','VOID') NOT NULL DEFAULT 'OPEN',
  void_reason VARCHAR(300) NULL,
  remarks VARCHAR(300) NULL,
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_ppb__order (packing_id, status),
  KEY ix_ppb__bundle (bundle_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Piece / polybag entry (Screen B)';

CREATE TABLE IF NOT EXISTS trx_packing_polybag_use (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  polybag_id BIGINT UNSIGNED NOT NULL,
  carton_id BIGINT UNSIGNED NOT NULL,
  qty INT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_ppu__carton (carton_id),
  KEY ix_ppu__bag (polybag_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── carton numbers are never reused (even after VOID) ──────────────
CREATE TABLE IF NOT EXISTS trx_carton_no_registry (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  company_id BIGINT UNSIGNED NOT NULL,
  carton_no VARCHAR(40) NOT NULL,
  carton_id BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_cnr (company_id, carton_no)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
-- legacy carton numbers are taken too (first one wins if older data repeated a number)
INSERT IGNORE INTO trx_carton_no_registry (company_id, carton_no, carton_id)
SELECT p.company_id, c.carton_no, MIN(c.id) FROM trx_carton c JOIN trx_packing p ON p.id = c.packing_id GROUP BY p.company_id, c.carton_no;

CREATE TABLE IF NOT EXISTS trx_carton_event (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  company_id BIGINT UNSIGNED NOT NULL,
  carton_id BIGINT UNSIGNED NOT NULL,
  packing_id BIGINT UNSIGNED NOT NULL,
  event_type ENUM('CREATE','UPDATE','VERIFY','SEAL','REOPEN','VOID','POST','REVERSE','PRINT') NOT NULL,
  from_status VARCHAR(20) NULL,
  to_status VARCHAR(20) NULL,
  reason VARCHAR(300) NULL,
  detail JSON NULL,
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_cev__carton (carton_id),
  KEY ix_cev__order (packing_id, event_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Carton verify / seal / reopen / void / post history';

CREATE TABLE IF NOT EXISTS trx_packing_consumption (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  company_id BIGINT UNSIGNED NOT NULL,
  packing_id BIGINT UNSIGNED NOT NULL,
  carton_id BIGINT UNSIGNED NOT NULL,
  post_seq INT UNSIGNED NOT NULL DEFAULT 1,
  material_kind ENUM('POLYBAG','CARTON') NOT NULL,
  trim_id BIGINT UNSIGNED NOT NULL,
  trim_stock_id BIGINT UNSIGNED NOT NULL,
  warehouse_id BIGINT UNSIGNED NULL,
  lot_no VARCHAR(80) NULL,
  qty DECIMAL(18,4) NOT NULL,
  std_qty DECIMAL(18,4) NULL COMMENT 'Standard (rule) consumption for the carton',
  uom_id SMALLINT UNSIGNED NULL,
  reversed_at DATETIME NULL,
  reversed_by BIGINT UNSIGNED NULL,
  reverse_reason VARCHAR(300) NULL,
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_pcons (carton_id, post_seq, material_kind, trim_stock_id),
  KEY ix_pcons__order (packing_id),
  KEY ix_pcons__trim (trim_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Actual packaging consumption on carton posting';

-- ── carton header / detail extras ──────────────────────────────────
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_carton' AND COLUMN_NAME='post_seq');
SET @s = IF(@x=0, 'ALTER TABLE trx_carton ADD COLUMN post_seq INT UNSIGNED NOT NULL DEFAULT 0, ADD COLUMN posted_by BIGINT UNSIGNED NULL, ADD COLUMN std_polybag_qty INT UNSIGNED NOT NULL DEFAULT 0, ADD COLUMN void_reason VARCHAR(300) NULL, ADD COLUMN updated_at DATETIME NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_carton_content' AND COLUMN_NAME='sku_id' AND IS_NULLABLE='NO');
SET @s = IF(@x=1, 'ALTER TABLE trx_carton_content MODIFY COLUMN sku_id BIGINT UNSIGNED NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_carton_content' AND COLUMN_NAME='bundle_id');
SET @s = IF(@x=0, 'ALTER TABLE trx_carton_content ADD COLUMN bundle_id BIGINT UNSIGNED NULL COMMENT ''Optional source bundle chosen at carton entry''', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
-- legacy lines: fill colour / size / style from their SKU
UPDATE trx_carton_content cc JOIN mst_style_sku k ON k.id = cc.sku_id
   SET cc.color_id = k.color_id, cc.size_id = k.size_id, cc.style_id = COALESCE(cc.style_id, k.style_id)
 WHERE cc.color_id IS NULL;
UPDATE trx_carton c SET c.pieces_total = (SELECT COALESCE(SUM(cc.qty),0) FROM trx_carton_content cc WHERE cc.carton_id = c.id)
 WHERE c.pieces_total = 0;

-- ── settings, numbering, permission ────────────────────────────────
INSERT IGNORE INTO cfg_system_setting (company_id, setting_key, setting_value, description)
SELECT id, 'PACKING_ALLOW_NEGATIVE_PACKAGING', '0', 'Packing: 1 = carton posting may take polybag / carton trim stock below zero; 0 = posting is blocked when packaging stock is short' FROM mst_company;
INSERT IGNORE INTO cfg_system_setting (company_id, setting_key, setting_value, description)
SELECT id, 'PACKING_VARIANCE_TOLERANCE_PCT', '2', 'Packing: polybag / carton variance above this % of standard needs a supervisor (PACKING.APPROVE) to approve before posting' FROM mst_company;

INSERT INTO cfg_number_series (company_id, branch_id, doc_type, fy_id, prefix, next_number, padding)
SELECT c.id, NULL, t.doc_type, NULL, t.prefix, 1, 5
  FROM mst_company c
  JOIN (SELECT 'PACKING_ORDER' AS doc_type, 'PKO-' AS prefix UNION ALL SELECT 'PACKING_CARTON', 'CTN' UNION ALL SELECT 'PACKING_RULE', 'PKR-') t
 WHERE NOT EXISTS (SELECT 1 FROM cfg_number_series ns WHERE ns.company_id = c.id AND ns.doc_type = t.doc_type AND ns.branch_id IS NULL AND ns.fy_id IS NULL);
-- carton numbers start after the legacy CTN-#### numbers so they never collide
UPDATE cfg_number_series SET padding = 7 WHERE doc_type = 'PACKING_CARTON' AND padding = 5 AND next_number = 1;

INSERT INTO mst_permission (module_id, permission_code, permission_name)
SELECT m.id, 'PACKING.APPROVE', 'Approve packing (orders, variance, reopen / void / reverse cartons)'
  FROM mst_module m
 WHERE m.module_code = 'PACKING'
   AND NOT EXISTS (SELECT 1 FROM mst_permission x WHERE x.permission_code = 'PACKING.APPROVE');

INSERT INTO map_role_permission (role_id, permission_id)
SELECT r.id, p.id FROM mst_role r JOIN mst_permission p ON p.permission_code = 'PACKING.APPROVE'
 WHERE r.role_code IN ('SUPER_ADMIN','ADMIN','EXPORT_EXECUTIVE')
   AND NOT EXISTS (SELECT 1 FROM map_role_permission m WHERE m.role_id = r.id AND m.permission_id = p.id);
