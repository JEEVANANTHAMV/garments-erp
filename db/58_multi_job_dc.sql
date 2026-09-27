-- =====================================================================
-- 58. MULTI-JOB PROCESS DCs (OUTWARD / INWARD)
-- ---------------------------------------------------------------------
-- Client review 24-Sep-2026 + sample screens: one DC carries several
-- jobs (IO no / style / buyer PO), shown job-wise on outward and inward.
--
--  * DC line keeps the job (io_no) of its bundle, a physical weight and
--    remarks, so a mixed DC groups and totals per job without re-joining.
--  * DC header gets the party ref / SR no and from / to locations.
--  * Receipt (process inward) gets the party DC no / date, receiving
--    location and vehicle; receipt lines get a reject (mistake) reason
--    and received weight.
-- Every statement is idempotent: the migrate runner re-applies files.
-- =====================================================================


-- trx_jobwork_challan_line
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_challan_line' AND COLUMN_NAME='io_no');
SET @s = IF(@x=0, 'ALTER TABLE trx_jobwork_challan_line ADD COLUMN io_no VARCHAR(40) NULL COMMENT \'Job (internal order) of the bundle\' AFTER bundle_id', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_challan_line' AND COLUMN_NAME='weight_kg');
SET @s = IF(@x=0, 'ALTER TABLE trx_jobwork_challan_line ADD COLUMN weight_kg DECIMAL(12,3) NULL COMMENT \'Physical weight sent (KG)\' AFTER qty', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_challan_line' AND COLUMN_NAME='remarks');
SET @s = IF(@x=0, 'ALTER TABLE trx_jobwork_challan_line ADD COLUMN remarks VARCHAR(255) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_challan_line' AND INDEX_NAME='ix_jwcl_io');
SET @s = IF(@x=0, 'ALTER TABLE trx_jobwork_challan_line ADD KEY ix_jwcl_io (io_no)', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- Existing bundle lines take the job of their bundle.
UPDATE trx_jobwork_challan_line jl
  JOIN trx_cutting_bundle cb ON cb.id = jl.bundle_id
   SET jl.io_no = cb.io_no
 WHERE jl.io_no IS NULL AND cb.io_no IS NOT NULL;

-- trx_jobwork_challan
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_challan' AND COLUMN_NAME='ref_no');
SET @s = IF(@x=0, 'ALTER TABLE trx_jobwork_challan ADD COLUMN ref_no VARCHAR(60) NULL COMMENT \'Reference / SR no\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_challan' AND COLUMN_NAME='from_warehouse_id');
SET @s = IF(@x=0, 'ALTER TABLE trx_jobwork_challan ADD COLUMN from_warehouse_id BIGINT UNSIGNED NULL COMMENT \'From location (store)\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_challan' AND COLUMN_NAME='to_warehouse_id');
SET @s = IF(@x=0, 'ALTER TABLE trx_jobwork_challan ADD COLUMN to_warehouse_id BIGINT UNSIGNED NULL COMMENT \'To location (store)\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- trx_jobwork_receipt
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_receipt' AND COLUMN_NAME='party_dc_no');
SET @s = IF(@x=0, 'ALTER TABLE trx_jobwork_receipt ADD COLUMN party_dc_no VARCHAR(60) NULL COMMENT \'Contractor / party DC no (PDC no)\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_receipt' AND COLUMN_NAME='party_dc_date');
SET @s = IF(@x=0, 'ALTER TABLE trx_jobwork_receipt ADD COLUMN party_dc_date DATE NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_receipt' AND COLUMN_NAME='to_warehouse_id');
SET @s = IF(@x=0, 'ALTER TABLE trx_jobwork_receipt ADD COLUMN to_warehouse_id BIGINT UNSIGNED NULL COMMENT \'Receiving location (store)\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_receipt' AND COLUMN_NAME='vehicle_no');
SET @s = IF(@x=0, 'ALTER TABLE trx_jobwork_receipt ADD COLUMN vehicle_no VARCHAR(30) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- trx_jobwork_receipt_line
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_receipt_line' AND COLUMN_NAME='reject_reason');
SET @s = IF(@x=0, 'ALTER TABLE trx_jobwork_receipt_line ADD COLUMN reject_reason VARCHAR(255) NULL COMMENT \'Mistake / reject reason\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_receipt_line' AND COLUMN_NAME='weight_kg');
SET @s = IF(@x=0, 'ALTER TABLE trx_jobwork_receipt_line ADD COLUMN weight_kg DECIMAL(12,3) NULL COMMENT \'Physical weight received (KG)\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
