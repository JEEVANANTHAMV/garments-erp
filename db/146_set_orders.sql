-- =====================================================================
-- 146 · Set orders (client 28/29-Oct-2026 + "Top / Bottom Set Matching & Packing" spec)
--   A set style is sold as a SET (1 TOP + 1 BOTTOM, 2 TOP + 1 BOTTOM, TOP + BOTTOM + DUPATTA …). The order may be
--   entered in sets; the factory still cuts / sews / checks each part as pieces, and sets are formed at packing.
--
--   mst_style_set_part            the set composition of a style: part + pieces per set (2+ parts = a set style)
--   trx_sales_order_line          a set entered on the order is stored as one line per part, linked by set_group;
--                                  set_qty / qty_per_set / set_rate keep the set view, set_color_map the contrast
--                                  colour of the part per set colour ({"<set colour id>": <part colour id>})
--   trx_sales_order.qty_unit      PCS / SET — what the buyer is sold (SET when the order lines are sets)
--   trx_packing_set.components_json  every part of a packed set: [{part, color_id, qty}] (TOP/BOTTOM columns kept)
-- Idempotent: the runner re-applies files >= 10 on every deploy.
-- =====================================================================
CREATE TABLE IF NOT EXISTS mst_style_set_part (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  company_id   BIGINT UNSIGNED NOT NULL,
  style_id     BIGINT UNSIGNED NOT NULL,
  part_name    VARCHAR(20) NOT NULL COMMENT 'TOP / BOTTOM / DUPATTA / JACKET …',
  qty_per_set  INT NOT NULL DEFAULT 1 COMMENT 'Pieces of this part in one set',
  sort_order   INT NOT NULL DEFAULT 0 COMMENT 'The first part names the set colour',
  created_by   BIGINT UNSIGNED NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_style_set_part (style_id, part_name),
  KEY ix_style_set_part_co (company_id, style_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Set composition of a style (parts and pieces per set)';

DROP PROCEDURE IF EXISTS _set146_add_col;
CREATE PROCEDURE _set146_add_col(IN t VARCHAR(64), IN c VARCHAR(64), IN ddl VARCHAR(500))
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = t AND COLUMN_NAME = c) THEN
    SET @q = CONCAT('ALTER TABLE ', t, ' ADD COLUMN ', c, ' ', ddl);
    PREPARE s1 FROM @q; EXECUTE s1; DEALLOCATE PREPARE s1;
  END IF;
END;
CALL _set146_add_col('trx_sales_order_line', 'set_group', 'VARCHAR(20) NULL COMMENT ''Lines of one set entry share it (S1, S2 …)''');
CALL _set146_add_col('trx_sales_order_line', 'set_qty', 'INT NULL COMMENT ''Sets of the set entry''');
CALL _set146_add_col('trx_sales_order_line', 'qty_per_set', 'INT NULL COMMENT ''Pieces of this part per set''');
CALL _set146_add_col('trx_sales_order_line', 'set_rate', 'DECIMAL(14,4) NULL COMMENT ''Price per set (unit_price = set_rate / pieces per set)''');
CALL _set146_add_col('trx_sales_order_line', 'set_color_map', 'JSON NULL COMMENT ''{"<set colour id>": <this part colour id>} — contrast colours''');
CALL _set146_add_col('trx_sales_order', 'qty_unit', 'VARCHAR(4) NOT NULL DEFAULT ''PCS'' COMMENT ''PCS / SET — sold to the buyer in''');
CALL _set146_add_col('trx_packing_set', 'components_json', 'JSON NULL COMMENT ''[{part, color_id, qty}] every part of the set; NULL = top_* + bottom_* 1:1''');
DROP PROCEDURE IF EXISTS _set146_add_col;

SET @x = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_sales_order_line' AND INDEX_NAME='ix_sol_set_group');
SET @s = IF(@x = 0, 'ALTER TABLE trx_sales_order_line ADD KEY ix_sol_set_group (so_id, set_group)', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
