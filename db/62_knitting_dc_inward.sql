-- =====================================================================
-- 62. KNITTING DC (YARN OUTWARD) AND GREY FABRIC INWARD
-- ---------------------------------------------------------------------
-- Client review 27-Sep-2026: after a knitting program is released the
-- yarn goes out to the knitter on a DC, and grey fabric comes back in
-- against that DC (our ref + party DC no) into fabric roll stock, with a
-- yarn-vs-fabric reconciliation per program.
--
--  * trx_process_issue gets the DC grouping (one DC = many yarn lines),
--    vehicle, vendor and cones so a knitting DC prints from the issues.
--  * trx_process_receipt gets the party DC no, our knitting DC ref, the
--    grey fabric GRN it created and roll count.
--  * trx_fabric_process_roll_in can point at a grey roll in
--    trx_fabric_roll (knitting program inward) as well as a legacy KWO roll.
--  * trx_knitting_program.status accepts QC / STOCK_POSTED, which the
--    shared process engine already writes.
-- Every statement is idempotent: the migrate runner re-applies files.
-- =====================================================================


-- trx_process_issue — knitting DC header fields carried on each line
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_process_issue' AND COLUMN_NAME='dc_no');
SET @s = IF(@x=0, 'ALTER TABLE trx_process_issue ADD COLUMN dc_no VARCHAR(60) NULL COMMENT \'Knitting DC (yarn outward) this line belongs to\' AFTER issue_no', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_process_issue' AND COLUMN_NAME='vendor_id');
SET @s = IF(@x=0, 'ALTER TABLE trx_process_issue ADD COLUMN vendor_id BIGINT UNSIGNED NULL COMMENT \'Party the yarn was sent to\' AFTER dc_no', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_process_issue' AND COLUMN_NAME='vehicle_no');
SET @s = IF(@x=0, 'ALTER TABLE trx_process_issue ADD COLUMN vehicle_no VARCHAR(30) NULL AFTER vendor_id', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_process_issue' AND COLUMN_NAME='no_of_cones');
SET @s = IF(@x=0, 'ALTER TABLE trx_process_issue ADD COLUMN no_of_cones INT UNSIGNED NOT NULL DEFAULT 0 COMMENT \'Cones / bags sent\' AFTER issued_qty_kg', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_process_issue' AND INDEX_NAME='ix_pis_dc');
SET @s = IF(@x=0, 'ALTER TABLE trx_process_issue ADD KEY ix_pis_dc (company_id, dc_no)', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;


-- trx_process_receipt — grey fabric inward against a knitting DC
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_process_receipt' AND COLUMN_NAME='party_dc_no');
SET @s = IF(@x=0, 'ALTER TABLE trx_process_receipt ADD COLUMN party_dc_no VARCHAR(60) NULL COMMENT \'Knitter (party) DC no\' AFTER receipt_date', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_process_receipt' AND COLUMN_NAME='ref_dc_no');
SET @s = IF(@x=0, 'ALTER TABLE trx_process_receipt ADD COLUMN ref_dc_no VARCHAR(60) NULL COMMENT \'Our knitting DC (yarn outward) this inward is against\' AFTER party_dc_no', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_process_receipt' AND COLUMN_NAME='vehicle_no');
SET @s = IF(@x=0, 'ALTER TABLE trx_process_receipt ADD COLUMN vehicle_no VARCHAR(30) NULL AFTER ref_dc_no', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_process_receipt' AND COLUMN_NAME='grn_id');
SET @s = IF(@x=0, 'ALTER TABLE trx_process_receipt ADD COLUMN grn_id BIGINT UNSIGNED NULL COMMENT \'Grey fabric GRN that holds the received rolls\' AFTER warehouse_id', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_process_receipt' AND COLUMN_NAME='no_of_rolls');
SET @s = IF(@x=0, 'ALTER TABLE trx_process_receipt ADD COLUMN no_of_rolls INT UNSIGNED NOT NULL DEFAULT 0 AFTER grn_id', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_process_receipt' AND INDEX_NAME='ix_prc_grn');
SET @s = IF(@x=0, 'ALTER TABLE trx_process_receipt ADD KEY ix_prc_grn (grn_id)', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;


-- trx_fabric_process_roll_in — grey roll from roll stock (knitting program inward)
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_fabric_process_roll_in' AND COLUMN_NAME='fabric_roll_id');
SET @s = IF(@x=0, 'ALTER TABLE trx_fabric_process_roll_in ADD COLUMN fabric_roll_id BIGINT UNSIGNED NULL COMMENT \'Grey roll in trx_fabric_roll (knitting program inward)\' AFTER knitting_roll_id', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_fabric_process_roll_in' AND INDEX_NAME='ix_fpri_froll');
SET @s = IF(@x=0, 'ALTER TABLE trx_fabric_process_roll_in ADD KEY ix_fpri_froll (fabric_roll_id)', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;


-- trx_knitting_program.status — the shared engine writes QC and STOCK_POSTED
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_knitting_program' AND COLUMN_NAME='status' AND COLUMN_TYPE LIKE '%STOCK_POSTED%');
SET @s = IF(@x=0, 'ALTER TABLE trx_knitting_program MODIFY COLUMN status ENUM(\'DRAFT\',\'STOCK_CHECK\',\'RESERVED\',\'RELEASED\',\'MATERIAL_ISSUED\',\'IN_PROGRESS\',\'PRODUCTION_COMPLETED\',\'OUTPUT_RECEIPT\',\'QC\',\'STOCK_POSTED\',\'COMPLETED\',\'CANCELLED\') NOT NULL DEFAULT \'DRAFT\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;


-- Number series: knitting DC and grey fabric inward
INSERT INTO cfg_number_series (company_id, branch_id, doc_type, fy_id, prefix, next_number, padding)
SELECT c.id, NULL, d.doc_type, NULL, d.prefix, 1, 5
FROM mst_company c
JOIN (
  SELECT 'KNIT_DC' AS doc_type, 'KDC-' AS prefix UNION ALL
  SELECT 'KNIT_INWARD',          'KIN-'
) d
WHERE NOT EXISTS (
  SELECT 1 FROM cfg_number_series s WHERE s.company_id = c.id AND s.doc_type = d.doc_type
);
