-- =====================================================================
-- 53. FG RECEIPT SCHEMA ALIGNMENT
-- ---------------------------------------------------------------------
-- trx_fg_receipt / trx_fg_receipt_line are created by BOTH db/11 (prod
-- order + SKU shape) and db/23 (IO / style / colour-size shape). db/11
-- runs first, so every database — local and production — ended up with
-- the db/11 shape while the FG receipt API (/api/fg-receipts) writes the
-- db/23 columns (receipt_no, io_no, style_id, source_stage, source_ref,
-- total_reject; lines color_id, size_id, good_qty, reject_qty, batch_no)
-- and fails.
--
-- This file brings either shape to the union of both, without dropping
-- or rewriting any existing data:
--   * adds the missing columns,
--   * relaxes legacy NOT NULL columns the new API does not fill,
--   * widens status to cover both vocabularies,
--   * backfills receipt_no / good_qty / colour / size / IO / style for
--     legacy rows.
-- Every statement is idempotent (the runner re-applies it on each deploy)
-- and every column touch is guarded, so it works whichever shape exists.
-- =====================================================================

-- ─────────────────────────────────────────────────────────────────
-- 1. HEADER — new columns
-- ─────────────────────────────────────────────────────────────────
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_fg_receipt' AND COLUMN_NAME='receipt_no');
SET @s = IF(@x=0, 'ALTER TABLE trx_fg_receipt ADD COLUMN receipt_no VARCHAR(40) NULL AFTER company_id', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_fg_receipt' AND COLUMN_NAME='io_no');
SET @s = IF(@x=0, 'ALTER TABLE trx_fg_receipt ADD COLUMN io_no VARCHAR(40) NULL AFTER receipt_date', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_fg_receipt' AND COLUMN_NAME='style_id');
SET @s = IF(@x=0, 'ALTER TABLE trx_fg_receipt ADD COLUMN style_id BIGINT UNSIGNED NULL AFTER io_no', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_fg_receipt' AND COLUMN_NAME='source_stage');
SET @s = IF(@x=0, 'ALTER TABLE trx_fg_receipt ADD COLUMN source_stage VARCHAR(40) NULL DEFAULT \'FINISHING\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_fg_receipt' AND COLUMN_NAME='source_ref');
SET @s = IF(@x=0, 'ALTER TABLE trx_fg_receipt ADD COLUMN source_ref VARCHAR(60) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_fg_receipt' AND COLUMN_NAME='total_reject');
SET @s = IF(@x=0, 'ALTER TABLE trx_fg_receipt ADD COLUMN total_reject INT UNSIGNED NULL DEFAULT 0', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
-- db/11-only columns, so a db/23-shaped table also accepts the legacy API.
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_fg_receipt' AND COLUMN_NAME='fg_receipt_no');
SET @s = IF(@x=0, 'ALTER TABLE trx_fg_receipt ADD COLUMN fg_receipt_no VARCHAR(40) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_fg_receipt' AND COLUMN_NAME='packing_id');
SET @s = IF(@x=0, 'ALTER TABLE trx_fg_receipt ADD COLUMN packing_id BIGINT UNSIGNED NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_fg_receipt' AND COLUMN_NAME='qc_id');
SET @s = IF(@x=0, 'ALTER TABLE trx_fg_receipt ADD COLUMN qc_id BIGINT UNSIGNED NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- ─────────────────────────────────────────────────────────────────
-- 2. HEADER — relax legacy NOT NULLs the IO-based API does not fill
--    (prod_order_id / warehouse_id / fg_receipt_no from db/11,
--     io_no / style_id from db/23) and widen status.
-- ─────────────────────────────────────────────────────────────────
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_fg_receipt' AND COLUMN_NAME='prod_order_id' AND IS_NULLABLE='NO');
SET @s = IF(@x=1, 'ALTER TABLE trx_fg_receipt MODIFY COLUMN prod_order_id BIGINT UNSIGNED NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_fg_receipt' AND COLUMN_NAME='warehouse_id' AND IS_NULLABLE='NO');
SET @s = IF(@x=1, 'ALTER TABLE trx_fg_receipt MODIFY COLUMN warehouse_id BIGINT UNSIGNED NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_fg_receipt' AND COLUMN_NAME='fg_receipt_no' AND IS_NULLABLE='NO');
SET @s = IF(@x=1, 'ALTER TABLE trx_fg_receipt MODIFY COLUMN fg_receipt_no VARCHAR(40) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_fg_receipt' AND COLUMN_NAME='io_no' AND IS_NULLABLE='NO');
SET @s = IF(@x=1, 'ALTER TABLE trx_fg_receipt MODIFY COLUMN io_no VARCHAR(40) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_fg_receipt' AND COLUMN_NAME='style_id' AND IS_NULLABLE='NO');
SET @s = IF(@x=1, 'ALTER TABLE trx_fg_receipt MODIFY COLUMN style_id BIGINT UNSIGNED NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_fg_receipt' AND COLUMN_NAME='status' AND COLUMN_TYPE="enum('DRAFT','RECEIVED','CONFIRMED','CLOSED','CANCELLED')");
SET @s = IF(@x=0, 'ALTER TABLE trx_fg_receipt MODIFY COLUMN status ENUM(\'DRAFT\',\'RECEIVED\',\'CONFIRMED\',\'CLOSED\',\'CANCELLED\') DEFAULT \'DRAFT\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- ─────────────────────────────────────────────────────────────────
-- 3. HEADER — backfill legacy rows
-- ─────────────────────────────────────────────────────────────────
UPDATE trx_fg_receipt SET receipt_no = fg_receipt_no WHERE receipt_no IS NULL AND fg_receipt_no IS NOT NULL;
UPDATE trx_fg_receipt SET receipt_no = CONCAT('FGR-LEGACY-', id) WHERE receipt_no IS NULL;
UPDATE trx_fg_receipt SET total_reject = 0 WHERE total_reject IS NULL;
UPDATE trx_fg_receipt SET source_stage = 'FINISHING' WHERE source_stage IS NULL;

-- Style / IO of legacy receipts from their production order, then sales order.
UPDATE trx_fg_receipt fg
  JOIN trx_production_order po ON po.id = fg.prod_order_id
   SET fg.style_id = po.style_id
 WHERE fg.style_id IS NULL AND po.style_id IS NOT NULL;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_production_order' AND COLUMN_NAME='io_no');
SET @s = IF(@x=1, 'UPDATE trx_fg_receipt fg JOIN trx_production_order po ON po.id = fg.prod_order_id SET fg.io_no = po.io_no WHERE fg.io_no IS NULL AND po.io_no IS NOT NULL AND po.io_no <> \'\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
UPDATE trx_fg_receipt fg
  JOIN trx_sales_order so ON so.id = fg.so_id
   SET fg.io_no = so.io_no
 WHERE fg.io_no IS NULL AND so.io_no IS NOT NULL AND so.io_no <> '';

-- receipt_no is the document number the API numbers and searches on.
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_fg_receipt' AND COLUMN_NAME='receipt_no' AND IS_NULLABLE='YES');
SET @s = IF(@x=1, 'ALTER TABLE trx_fg_receipt MODIFY COLUMN receipt_no VARCHAR(40) NOT NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_fg_receipt' AND INDEX_NAME='uq_fg_receipt');
SET @s = IF(@x=0, 'ALTER TABLE trx_fg_receipt ADD UNIQUE KEY uq_fg_receipt (company_id, receipt_no)', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_fg_receipt' AND INDEX_NAME='ix_fgr_io');
SET @s = IF(@x=0, 'ALTER TABLE trx_fg_receipt ADD KEY ix_fgr_io (company_id, io_no)', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_fg_receipt' AND INDEX_NAME='ix_fgr_style');
SET @s = IF(@x=0, 'ALTER TABLE trx_fg_receipt ADD KEY ix_fgr_style (style_id)', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- ─────────────────────────────────────────────────────────────────
-- 4. LINES — new columns
-- ─────────────────────────────────────────────────────────────────
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_fg_receipt_line' AND COLUMN_NAME='color_id');
SET @s = IF(@x=0, 'ALTER TABLE trx_fg_receipt_line ADD COLUMN color_id BIGINT UNSIGNED NULL AFTER fg_receipt_id', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_fg_receipt_line' AND COLUMN_NAME='size_id');
SET @s = IF(@x=0, 'ALTER TABLE trx_fg_receipt_line ADD COLUMN size_id INT UNSIGNED NULL AFTER color_id', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_fg_receipt_line' AND COLUMN_NAME='good_qty');
SET @s = IF(@x=0, 'ALTER TABLE trx_fg_receipt_line ADD COLUMN good_qty INT UNSIGNED NULL DEFAULT 0', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_fg_receipt_line' AND COLUMN_NAME='reject_qty');
SET @s = IF(@x=0, 'ALTER TABLE trx_fg_receipt_line ADD COLUMN reject_qty INT UNSIGNED NULL DEFAULT 0', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_fg_receipt_line' AND COLUMN_NAME='batch_no');
SET @s = IF(@x=0, 'ALTER TABLE trx_fg_receipt_line ADD COLUMN batch_no VARCHAR(40) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_fg_receipt_line' AND COLUMN_NAME='carton_id');
SET @s = IF(@x=0, 'ALTER TABLE trx_fg_receipt_line ADD COLUMN carton_id BIGINT UNSIGNED NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_fg_receipt_line' AND COLUMN_NAME='qty');
SET @s = IF(@x=0, 'ALTER TABLE trx_fg_receipt_line ADD COLUMN qty INT UNSIGNED NULL DEFAULT 0', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- ─────────────────────────────────────────────────────────────────
-- 5. LINES — relax legacy NOT NULLs (db/11 sku_id / qty; db/23 colour / size)
-- ─────────────────────────────────────────────────────────────────
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_fg_receipt_line' AND COLUMN_NAME='sku_id' AND IS_NULLABLE='NO');
SET @s = IF(@x=1, 'ALTER TABLE trx_fg_receipt_line MODIFY COLUMN sku_id BIGINT UNSIGNED NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_fg_receipt_line' AND COLUMN_NAME='qty' AND (IS_NULLABLE='NO' OR COLUMN_DEFAULT IS NULL));
SET @s = IF(@x=1, 'ALTER TABLE trx_fg_receipt_line MODIFY COLUMN qty INT UNSIGNED NULL DEFAULT 0', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_fg_receipt_line' AND COLUMN_NAME='color_id' AND IS_NULLABLE='NO');
SET @s = IF(@x=1, 'ALTER TABLE trx_fg_receipt_line MODIFY COLUMN color_id BIGINT UNSIGNED NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_fg_receipt_line' AND COLUMN_NAME='size_id' AND IS_NULLABLE='NO');
SET @s = IF(@x=1, 'ALTER TABLE trx_fg_receipt_line MODIFY COLUMN size_id INT UNSIGNED NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- ─────────────────────────────────────────────────────────────────
-- 6. LINES — backfill legacy SKU lines into colour / size / good qty
--    and keep qty meaningful for readers of the old column.
-- ─────────────────────────────────────────────────────────────────
UPDATE trx_fg_receipt_line l
  JOIN mst_style_sku k ON k.id = l.sku_id
   SET l.color_id = COALESCE(l.color_id, k.color_id),
       l.size_id  = COALESCE(l.size_id, k.size_id)
 WHERE l.sku_id IS NOT NULL AND (l.color_id IS NULL OR l.size_id IS NULL);
UPDATE trx_fg_receipt_line SET good_qty = qty
 WHERE (good_qty IS NULL OR good_qty = 0) AND qty IS NOT NULL AND qty > 0;
UPDATE trx_fg_receipt_line SET qty = COALESCE(good_qty, 0)
 WHERE (qty IS NULL OR qty = 0) AND good_qty IS NOT NULL AND good_qty > 0;
UPDATE trx_fg_receipt_line SET reject_qty = 0 WHERE reject_qty IS NULL;
UPDATE trx_fg_receipt_line SET good_qty = 0 WHERE good_qty IS NULL;

-- Header style for legacy receipts that only had SKU lines.
UPDATE trx_fg_receipt fg
  JOIN (SELECT l.fg_receipt_id, MIN(k.style_id) AS style_id
          FROM trx_fg_receipt_line l
          JOIN mst_style_sku k ON k.id = l.sku_id
         GROUP BY l.fg_receipt_id
        HAVING COUNT(DISTINCT k.style_id) = 1) x ON x.fg_receipt_id = fg.id
   SET fg.style_id = x.style_id
 WHERE fg.style_id IS NULL;

-- Legacy header total_qty was the sum of line qty; keep it and add reject total.
UPDATE trx_fg_receipt fg
  JOIN (SELECT fg_receipt_id, SUM(COALESCE(reject_qty,0)) AS rej
          FROM trx_fg_receipt_line GROUP BY fg_receipt_id) x ON x.fg_receipt_id = fg.id
   SET fg.total_reject = x.rej
 WHERE COALESCE(fg.total_reject, 0) = 0 AND x.rej > 0;
