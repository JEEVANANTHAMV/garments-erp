-- 124 · Packing list & shipment consume posted cartons (client call 14-Oct-2026, developer doc §17 / §20)
--   trx_packing_list_carton : which physical carton is on which packing list (one list per carton)
--   trx_shipment.package_basis : CARTONS (physical cartons allocated) / PACKING_LIST (hand-made list, totals from rows)
--   trx_shipment_plan : packing_list_id / so_id / io_no / net weight / basis so a plan from a list converts with them

CREATE TABLE IF NOT EXISTS trx_packing_list_carton (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  company_id BIGINT UNSIGNED NOT NULL,
  packing_list_id BIGINT UNSIGNED NOT NULL,
  carton_id BIGINT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_plc__carton (carton_id),
  KEY ix_plc__pl (packing_list_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- backfill from rows built from cartons before this migration (first list wins)
INSERT IGNORE INTO trx_packing_list_carton (company_id, packing_list_id, carton_id)
SELECT r.company_id, r.packing_list_id, j.cid
  FROM trx_packing_list_row r
  JOIN JSON_TABLE(r.source_carton_ids, '$[*]' COLUMNS (cid BIGINT UNSIGNED PATH '$')) j
  JOIN trx_carton c ON c.id = j.cid
 WHERE r.source_carton_ids IS NOT NULL
 ORDER BY r.packing_list_id;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_shipment' AND COLUMN_NAME='package_basis');
SET @s = IF(@x=0, "ALTER TABLE trx_shipment ADD COLUMN package_basis ENUM('CARTONS','PACKING_LIST') NOT NULL DEFAULT 'CARTONS'", 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_shipment_plan' AND COLUMN_NAME='packing_list_id');
SET @s = IF(@x=0, "ALTER TABLE trx_shipment_plan ADD COLUMN packing_list_id BIGINT UNSIGNED NULL, ADD COLUMN so_id BIGINT UNSIGNED NULL, ADD COLUMN io_no VARCHAR(40) NULL, ADD COLUMN net_weight_kg DECIMAL(12,3) NULL, ADD COLUMN package_basis ENUM('CARTONS','PACKING_LIST') NOT NULL DEFAULT 'CARTONS'", 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @x = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_shipment' AND INDEX_NAME='ix_shipment__pl');
SET @s = IF(@x=0, 'ALTER TABLE trx_shipment ADD INDEX ix_shipment__pl (packing_list_id)', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
