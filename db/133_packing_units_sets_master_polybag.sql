-- =====================================================================
-- 133 · Packing units: single piece / set / master polybag (client calls 16-Oct-2026)
--   "Only three options: single piece (pant-only orders, or TOP and BOTTOM packed separately),
--    a set (one TOP + one BOTTOM of the same size — usually contrast colours — in one polybag;
--    TOP / BOTTOM move separately through cutting, stitching, ironing and are paired only at packing),
--    and a master polybag (rare, children's wear: N individually bagged pieces in one big bag, N per order)."
--
--   trx_fg_receipt_line.part_name     FG is held per part, so sets can be paired from it
--   mst_packing_rule / trx_packing    packing_unit, pieces_per_master_bag, master_bag_trim_id
--   trx_packing_set                   set pairing of a SET order: TOP colour → BOTTOM colour (same size)
--   trx_carton_fg_use                 what a carton posted from the FG store took, per part × colour × size
--                                      (a set takes a TOP and a BOTTOM) — FG on hand = received − these
--   trx_carton.master_bag_qty, trx_packing_consumption.material_kind += MASTER_POLYBAG
-- Idempotent: the runner re-applies files >= 10 on every deploy.
-- =====================================================================

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_fg_receipt_line' AND COLUMN_NAME='part_name');
SET @s = IF(@x=0, 'ALTER TABLE trx_fg_receipt_line ADD COLUMN part_name VARCHAR(20) NULL COMMENT ''Garment part (TOP / BOTTOM …) — sets are paired from parts'' AFTER fg_receipt_id', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='mst_packing_rule' AND COLUMN_NAME='packing_unit');
SET @s = IF(@x=0, 'ALTER TABLE mst_packing_rule
  ADD COLUMN packing_unit ENUM(''SINGLE'',''SET'',''MASTER_POLYBAG'') NOT NULL DEFAULT ''SINGLE'' COMMENT ''Single piece / set (TOP+BOTTOM) / master polybag'',
  ADD COLUMN pieces_per_master_bag INT NULL COMMENT ''Master polybag: individually bagged pieces per master bag'',
  ADD COLUMN master_bag_trim_id BIGINT UNSIGNED NULL COMMENT ''Master polybag packaging item''', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_packing' AND COLUMN_NAME='packing_unit');
SET @s = IF(@x=0, 'ALTER TABLE trx_packing
  ADD COLUMN packing_unit ENUM(''SINGLE'',''SET'',''MASTER_POLYBAG'') NOT NULL DEFAULT ''SINGLE'',
  ADD COLUMN pieces_per_master_bag INT NULL COMMENT ''Given by the buyer per order'',
  ADD COLUMN master_bag_trim_id BIGINT UNSIGNED NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

CREATE TABLE IF NOT EXISTS trx_packing_set (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  packing_id      BIGINT UNSIGNED NOT NULL,
  top_part        VARCHAR(20) NOT NULL DEFAULT 'TOP',
  top_color_id    BIGINT UNSIGNED NOT NULL COMMENT 'The set is known by its TOP colour (packing order / carton lines use it)',
  bottom_part     VARCHAR(20) NOT NULL DEFAULT 'BOTTOM',
  bottom_color_id BIGINT UNSIGNED NOT NULL,
  UNIQUE KEY uq_packing_set (packing_id, top_color_id),
  KEY ix_packing_set (packing_id)
) ENGINE=InnoDB COMMENT='Set packing order: TOP colour paired with BOTTOM colour, same size';

CREATE TABLE IF NOT EXISTS trx_carton_fg_use (
  id          BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  carton_id   BIGINT UNSIGNED NOT NULL,
  packing_id  BIGINT UNSIGNED NOT NULL,
  part_name   VARCHAR(20) NULL,
  color_id    BIGINT UNSIGNED NOT NULL,
  size_id     INT UNSIGNED NOT NULL,
  qty         INT NOT NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_cfu_carton (carton_id),
  KEY ix_cfu_pack (packing_id)
) ENGINE=InnoDB COMMENT='FG-store PCS a posted carton took (part × colour × size)';

-- cartons already posted from the FG store (migration 132) take what their contents say
INSERT INTO trx_carton_fg_use (carton_id, packing_id, part_name, color_id, size_id, qty)
SELECT c.id, c.packing_id, p.part_name, cc.color_id, cc.size_id, cc.qty
  FROM trx_carton c JOIN trx_packing p ON p.id = c.packing_id JOIN trx_carton_content cc ON cc.carton_id = c.id
 WHERE c.from_fg = 1 AND c.is_posted = 1
   AND NOT EXISTS (SELECT 1 FROM trx_carton_fg_use u WHERE u.carton_id = c.id);

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_carton' AND COLUMN_NAME='master_bag_qty');
SET @s = IF(@x=0, 'ALTER TABLE trx_carton ADD COLUMN master_bag_qty INT NOT NULL DEFAULT 0 COMMENT ''Master polybags in the carton''', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_packing_consumption' AND COLUMN_NAME='material_kind' AND COLUMN_TYPE LIKE '%MASTER_POLYBAG%');
SET @s = IF(@x=0, 'ALTER TABLE trx_packing_consumption MODIFY COLUMN material_kind ENUM(''POLYBAG'',''CARTON'',''MASTER_POLYBAG'') NOT NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
