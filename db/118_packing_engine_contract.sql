-- 118 · Packing engine contract (client call + "Garment Packing Module" developer document, 14-Oct-2026)
-- trx_packing becomes the PACKING ORDER header; trx_carton / trx_carton_content are the carton header / detail.
-- Shared by the packing screens (writes) and packing list / shipment (reads only posted cartons):
--   a carton is "ready" when is_posted = 1 AND carton_status IN ('VERIFIED','SEALED'); shipment dispatch sets 'DISPATCHED'.
-- Existing rows default to posted / SEALED so cartons made before this keep working.

-- ── trx_packing (packing order) ────────────────────────────────────
SET @t = 'trx_packing';
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=@t AND COLUMN_NAME='order_status');
SET @s = IF(@x=0, "ALTER TABLE trx_packing ADD COLUMN order_status ENUM('DRAFT','APPROVED','IN_PROGRESS','COMPLETED','CANCELLED') NOT NULL DEFAULT 'COMPLETED' AFTER status_id", 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=@t AND COLUMN_NAME='packing_mode');
SET @s = IF(@x=0, "ALTER TABLE trx_packing ADD COLUMN packing_mode ENUM('BUNDLE_QUANTITY','INDIVIDUAL_PIECE') NOT NULL DEFAULT 'BUNDLE_QUANTITY' AFTER pack_method", 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=@t AND COLUMN_NAME='packing_rule_id');
SET @s = IF(@x=0, 'ALTER TABLE trx_packing ADD COLUMN packing_rule_id BIGINT UNSIGNED NULL, ADD COLUMN rule_snapshot JSON NULL, ADD COLUMN planned_qty INT UNSIGNED NOT NULL DEFAULT 0, ADD COLUMN planned_polybags INT UNSIGNED NOT NULL DEFAULT 0, ADD COLUMN planned_cartons INT UNSIGNED NOT NULL DEFAULT 0, ADD COLUMN warehouse_id BIGINT UNSIGNED NULL, ADD COLUMN target_date DATE NULL, ADD COLUMN remarks VARCHAR(500) NULL, ADD COLUMN approved_by BIGINT UNSIGNED NULL, ADD COLUMN approved_at DATETIME NULL, ADD COLUMN cancel_reason VARCHAR(300) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- ── trx_carton (carton header) ─────────────────────────────────────
SET @t = 'trx_carton';
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=@t AND COLUMN_NAME='carton_status');
SET @s = IF(@x=0, "ALTER TABLE trx_carton ADD COLUMN carton_status ENUM('DRAFT','OPEN','VERIFIED','SEALED','DISPATCHED','VOID') NOT NULL DEFAULT 'SEALED', ADD COLUMN is_posted TINYINT(1) NOT NULL DEFAULT 1, ADD COLUMN posted_at DATETIME NULL", 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=@t AND COLUMN_NAME='pieces_total');
SET @s = IF(@x=0, 'ALTER TABLE trx_carton ADD COLUMN company_id BIGINT UNSIGNED NULL, ADD COLUMN carton_seq INT UNSIGNED NULL, ADD COLUMN pieces_total INT UNSIGNED NOT NULL DEFAULT 0, ADD COLUMN polybag_qty INT UNSIGNED NOT NULL DEFAULT 0, ADD COLUMN carton_trim_id BIGINT UNSIGNED NULL, ADD COLUMN polybag_trim_id BIGINT UNSIGNED NULL, ADD COLUMN is_partial TINYINT(1) NOT NULL DEFAULT 0, ADD COLUMN seal_no VARCHAR(60) NULL, ADD COLUMN remarks VARCHAR(300) NULL, ADD COLUMN verified_by BIGINT UNSIGNED NULL, ADD COLUMN verified_at DATETIME NULL, ADD COLUMN sealed_by BIGINT UNSIGNED NULL, ADD COLUMN sealed_at DATETIME NULL, ADD COLUMN created_by BIGINT UNSIGNED NULL, ADD COLUMN created_at DATETIME NULL DEFAULT CURRENT_TIMESTAMP', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=@t AND INDEX_NAME='ix_carton__status');
SET @s = IF(@x=0, 'ALTER TABLE trx_carton ADD INDEX ix_carton__status (carton_status, is_posted)', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=@t AND INDEX_NAME='ix_carton__barcode');
SET @s = IF(@x=0, 'ALTER TABLE trx_carton ADD INDEX ix_carton__barcode (barcode)', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- ── trx_carton_content (carton detail: size × colour × pieces) ────
SET @t = 'trx_carton_content';
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=@t AND COLUMN_NAME='color_id');
SET @s = IF(@x=0, 'ALTER TABLE trx_carton_content ADD COLUMN io_no VARCHAR(40) NULL, ADD COLUMN style_id BIGINT UNSIGNED NULL, ADD COLUMN color_id BIGINT UNSIGNED NULL, ADD COLUMN size_id INT UNSIGNED NULL, ADD COLUMN polybag_qty INT UNSIGNED NOT NULL DEFAULT 0', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
