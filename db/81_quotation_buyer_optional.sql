-- =====================================================================
-- 81 · Purchase quotations have a supplier, not a buyer: trx_quotation.buyer_id
--   becomes optional (the resource requires a buyer only on buyer quotations
--   and a supplier on fabric / yarn / trims / general quotations). Idempotent.
-- =====================================================================
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_quotation' AND COLUMN_NAME='buyer_id' AND IS_NULLABLE='NO');
SET @s = IF(@x=1, 'ALTER TABLE trx_quotation MODIFY COLUMN buyer_id BIGINT UNSIGNED NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
