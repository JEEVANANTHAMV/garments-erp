-- =====================================================================
-- 80 · Client review follow-ups
--   (1) Party address country: mst_party_address.country_id already exists
--       (02_partners) — no schema change; the UI now captures it.
--   (2) Sales order size-wise excess: per-size (SKU) excess % and the
--       resulting plan-cut qty. excess_pct NULL = inherit line / header %.
--   (4) BOM line specification (poly bag measurement, care label text …),
--       printed on the BOM.
--   Idempotent — re-applied on every deploy.
-- =====================================================================

-- (2) trx_sales_order_sku.excess_pct
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_sales_order_sku' AND COLUMN_NAME='excess_pct');
SET @s = IF(@x=0, 'ALTER TABLE trx_sales_order_sku ADD COLUMN excess_pct DECIMAL(6,2) NULL COMMENT ''Size-wise excess %; NULL = use line / header excess %'' AFTER qty', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- (2) trx_sales_order_sku.plan_cut_qty
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_sales_order_sku' AND COLUMN_NAME='plan_cut_qty');
SET @s = IF(@x=0, 'ALTER TABLE trx_sales_order_sku ADD COLUMN plan_cut_qty INT UNSIGNED NULL COMMENT ''qty x (1 + effective excess %/100), rounded'' AFTER excess_pct', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- (4) trx_bom_line.specification
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_bom_line' AND COLUMN_NAME='specification');
SET @s = IF(@x=0, 'ALTER TABLE trx_bom_line ADD COLUMN specification VARCHAR(255) NULL COMMENT ''Free-text spec typed next to the material; printed on the BOM'' AFTER item_description', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
