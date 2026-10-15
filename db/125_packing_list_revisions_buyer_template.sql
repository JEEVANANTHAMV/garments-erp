-- 125 · Packing list: controlled revisions, over-shipment approval, buyer default template
--   (client "ERP Packing List — Three Template Models" spec §2, §6, §8, §10, §13 cross-checked
--    against packinglist.xlsx, 15-Oct-2026). Idempotent.
--
--   trx_packing_list.revision_no      0 = original; +1 every time a confirmed list is revised
--   trx_packing_list.over_ship_note   reason given when the list was confirmed with shipped > order
--   trx_packing_list.ctn_numbering    SEQUENCE (1..N on the list, as on the buyer sheet) / CARTON_NO (physical numbers)
--   trx_packing_list_revision         frozen snapshot of each confirmed version before it was revised
--   cfg_packing_list_buyer_template   buyer default format (ASSORTED / SOLID / MIXED = Model 1 / 2 / 3) + layout defaults

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_packing_list' AND COLUMN_NAME='revision_no');
SET @s = IF(@x=0, 'ALTER TABLE trx_packing_list ADD COLUMN revision_no INT UNSIGNED NOT NULL DEFAULT 0 COMMENT ''0 = original, +1 per controlled revision''', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_packing_list' AND COLUMN_NAME='over_ship_note');
SET @s = IF(@x=0, 'ALTER TABLE trx_packing_list ADD COLUMN over_ship_note VARCHAR(255) NULL COMMENT ''Approval reason when confirmed with shipped qty above order qty''', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_packing_list' AND COLUMN_NAME='ctn_numbering');
SET @s = IF(@x=0, 'ALTER TABLE trx_packing_list ADD COLUMN ctn_numbering ENUM(''SEQUENCE'',''CARTON_NO'') NOT NULL DEFAULT ''SEQUENCE'' COMMENT ''How carton numbers were assigned when rows were built from cartons''', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

CREATE TABLE IF NOT EXISTS trx_packing_list_revision (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  company_id       BIGINT UNSIGNED NOT NULL,
  packing_list_id  BIGINT UNSIGNED NOT NULL,
  revision_no      INT UNSIGNED NOT NULL COMMENT 'Revision number of the frozen version kept here',
  pl_type          VARCHAR(20) NULL,
  total_cartons    INT UNSIGNED NULL,
  total_qty        INT UNSIGNED NULL,
  net_weight_kg    DECIMAL(12,3) NULL,
  gross_weight_kg  DECIMAL(12,3) NULL,
  total_cbm        DECIMAL(12,5) NULL,
  confirmed_by     BIGINT UNSIGNED NULL,
  confirmed_at     DATETIME NULL,
  reason           VARCHAR(255) NOT NULL COMMENT 'Why the confirmed version was revised',
  snapshot         JSON NOT NULL COMMENT 'Header, blocks / rows / items, totals, order summary of the frozen version',
  created_by       BIGINT UNSIGNED NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_plrev (packing_list_id, revision_no),
  KEY ix_plrev_company (company_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Frozen packing list versions (controlled revision history)';

CREATE TABLE IF NOT EXISTS cfg_packing_list_buyer_template (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  company_id       BIGINT UNSIGNED NOT NULL,
  buyer_id         BIGINT UNSIGNED NOT NULL,
  pl_type          ENUM('ASSORTED','SOLID','MIXED') NOT NULL COMMENT 'Default format: Model 1 / 2 / 3',
  size_headers     JSON NULL COMMENT 'Default size columns (NULL = from the style size group)',
  notify_label     VARCHAR(40) NULL COMMENT '"Notify Party :-" or "Goods Delivery address"',
  notify_details   TEXT NULL,
  other_references VARCHAR(500) NULL,
  ctn_numbering    ENUM('SEQUENCE','CARTON_NO') NOT NULL DEFAULT 'SEQUENCE',
  updated_by       BIGINT UNSIGNED NULL,
  updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_plbt (company_id, buyer_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Buyer default packing list template';
