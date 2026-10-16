-- =====================================================================
-- 132 · FG receipt is the gate into packing (client call 16-Oct-2026)
--   "Whatever we make — in-house bundles or garments back from job work — only after the FG receipt
--    entry does it come to packing (packing order, individual piece / polybag entry). Then the FG store
--    stock report (qty and value) is correct automatically."
--
--   trx_fg_receipt         source_type (IN_HOUSE / JOB_WORK / RETURN / SURPLUS), cancel stamp
--   trx_fg_receipt_bundle  in-house receipts: which bundles the pieces came from (good / reject)
--   trx_cutting_bundle     fg_qty = PCS received into the FG store, not yet in a posted carton
--   trx_carton / trx_carton_bundle  from_fg: the carton took its pieces from the FG store
--   trx_packing_polybag    bundle_id optional (job-work garments have no bundle)
--   trx_stock_ledger       FG receipt = FINISHED qty in (sku, job, ₹ standard cost); dispatch = FINISHED out
--   settings               PACKING_FROM_FG_RECEIPT (1 = packing only from FG-received PCS),
--                          FG_RECEIPT_OVER_ORDER_PCT (job-work receipts over the order qty)
-- Idempotent: the runner re-applies files >= 10 on every deploy.
-- =====================================================================

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_fg_receipt' AND COLUMN_NAME='source_type');
SET @s = IF(@x=0, 'ALTER TABLE trx_fg_receipt
  ADD COLUMN source_type VARCHAR(20) NOT NULL DEFAULT ''IN_HOUSE'' COMMENT ''IN_HOUSE (bundles) / JOB_WORK / RETURN / SURPLUS'',
  ADD COLUMN fg_posted TINYINT(1) NOT NULL DEFAULT 0 COMMENT ''1 = posted into the FG store (receipts before the gate stay history only)'',
  ADD COLUMN cancelled_at DATETIME NULL, ADD COLUMN cancelled_by BIGINT UNSIGNED NULL, ADD COLUMN cancel_reason VARCHAR(255) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
-- receipts the job-work inward created are job-work receipts
UPDATE trx_fg_receipt SET source_type = 'JOB_WORK' WHERE source_stage = 'JOBWORK' AND source_type = 'IN_HOUSE';

CREATE TABLE IF NOT EXISTS trx_fg_receipt_bundle (
  id            BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  fg_receipt_id BIGINT UNSIGNED NOT NULL,
  line_id       BIGINT UNSIGNED NULL,
  bundle_id     BIGINT UNSIGNED NOT NULL,
  good_qty      INT NOT NULL DEFAULT 0,
  reject_qty    INT NOT NULL DEFAULT 0,
  KEY ix_fgrb_receipt (fg_receipt_id),
  KEY ix_fgrb_bundle (bundle_id)
) ENGINE=InnoDB COMMENT='FG receipt (in-house) ← bundles it took the PCS from';

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_cutting_bundle' AND COLUMN_NAME='fg_qty');
SET @s = IF(@x=0, 'ALTER TABLE trx_cutting_bundle ADD COLUMN fg_qty INT NOT NULL DEFAULT 0 COMMENT ''PCS received into the FG store, not yet in a posted carton''', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_carton' AND COLUMN_NAME='from_fg');
SET @s = IF(@x=0, 'ALTER TABLE trx_carton ADD COLUMN from_fg TINYINT(1) NOT NULL DEFAULT 0 COMMENT ''Posted from FG-received PCS''', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_carton_bundle' AND COLUMN_NAME='from_fg');
SET @s = IF(@x=0, 'ALTER TABLE trx_carton_bundle ADD COLUMN from_fg TINYINT(1) NOT NULL DEFAULT 0', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_packing_polybag' AND COLUMN_NAME='bundle_id' AND IS_NULLABLE='NO');
SET @s = IF(@x=1, 'ALTER TABLE trx_packing_polybag MODIFY COLUMN bundle_id BIGINT UNSIGNED NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

INSERT INTO cfg_system_setting (company_id, setting_key, setting_value, description)
SELECT c.id, 'PACKING_FROM_FG_RECEIPT', '1', 'Packing (orders, polybag, cartons) takes only PCS received into the FG store by an FG receipt'
  FROM mst_company c
 WHERE NOT EXISTS (SELECT 1 FROM cfg_system_setting s WHERE s.company_id = c.id AND s.setting_key = 'PACKING_FROM_FG_RECEIPT');
INSERT INTO cfg_system_setting (company_id, setting_key, setting_value, description)
SELECT c.id, 'FG_RECEIPT_OVER_ORDER_PCT', '5', 'Job-work / return FG receipts: % over the order qty allowed per colour / size'
  FROM mst_company c
 WHERE NOT EXISTS (SELECT 1 FROM cfg_system_setting s WHERE s.company_id = c.id AND s.setting_key = 'FG_RECEIPT_OVER_ORDER_PCT');
