-- =====================================================================
-- 85: Fabric processing linked to store stock (client voice note 30-Sep-2026)
--   Store roll (fabric GRN / knitting inward) → Processing DC (dyeing, washing,
--   printing …) → processed inward = a GRN + new store rolls (DYED / WASHED …) that
--   fabric issue to cutting picks up unchanged. Idempotent (re-runs every deploy).
-- =====================================================================

-- Store rolls: processing state, colour and the processing DC / grey roll they came from
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_fabric_roll' AND COLUMN_NAME='process_state');
SET @s = IF(@x=0, 'ALTER TABLE trx_fabric_roll ADD COLUMN process_state VARCHAR(20) NOT NULL DEFAULT ''GREY'' COMMENT ''GREY / DYED / WASHED / PRINTED / COMPACTED / FINISHED''', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_fabric_roll' AND COLUMN_NAME='color_name');
SET @s = IF(@x=0, 'ALTER TABLE trx_fabric_roll ADD COLUMN color_name VARCHAR(80) NULL COMMENT ''Colour after dyeing / printing''', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_fabric_roll' AND COLUMN_NAME='source_fpo_id');
SET @s = IF(@x=0, 'ALTER TABLE trx_fabric_roll ADD COLUMN source_fpo_id BIGINT UNSIGNED NULL COMMENT ''Processing DC the roll came back from''', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- Processing DC header: store / job links
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_fabric_process_order' AND COLUMN_NAME='so_id');
SET @s = IF(@x=0, 'ALTER TABLE trx_fabric_process_order ADD COLUMN so_id BIGINT UNSIGNED NULL COMMENT ''Job (sales order)'' AFTER io_no', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_fabric_process_order' AND COLUMN_NAME='expected_return_date');
SET @s = IF(@x=0, 'ALTER TABLE trx_fabric_process_order ADD COLUMN expected_return_date DATE NULL, ADD COLUMN vehicle_no VARCHAR(30) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- Input rolls: KG received back against each sent roll
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_fabric_process_roll_in' AND COLUMN_NAME='warehouse_id');
SET @s = IF(@x=0, 'ALTER TABLE trx_fabric_process_roll_in ADD COLUMN warehouse_id BIGINT UNSIGNED NULL COMMENT ''Store the roll left''', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- Output rolls: the store roll created on receipt + the receipt GRN
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_fabric_process_roll_out' AND COLUMN_NAME='fabric_roll_id');
SET @s = IF(@x=0, 'ALTER TABLE trx_fabric_process_roll_out ADD COLUMN fabric_roll_id BIGINT UNSIGNED NULL COMMENT ''Store roll created on receipt'', ADD COLUMN grn_id BIGINT UNSIGNED NULL COMMENT ''Processed-fabric GRN'', ADD COLUMN party_dc_no VARCHAR(60) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- customer_po_no is in the original DDL (25) but missing on databases where the table pre-existed
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_fabric_process_order' AND COLUMN_NAME='customer_po_no');
SET @s = IF(@x=0, 'ALTER TABLE trx_fabric_process_order ADD COLUMN customer_po_no VARCHAR(60) NULL AFTER io_no', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
