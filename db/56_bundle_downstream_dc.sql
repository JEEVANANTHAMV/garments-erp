-- =====================================================================
-- 56. BUNDLE DOWNSTREAM LEDGER, PROCESS DCs WITH BUNDLES, TRACEABILITY
-- ---------------------------------------------------------------------
-- Traceability doc §14, §15, §19, §20, §23 and client voice note 1
-- ("after cutting we make DCs for stitching, ironing, packing — in those
-- DCs the bundle numbers must all come").
--
--  * trx_cutting_bundle gets stage counters so every downstream stage can
--    only consume what the previous stage produced (row-locked updates):
--      cut balance (balance_qty) → sewing in/good/reject → finishing
--      in/good/reject → final QC pass/reject → packed; plus PCS currently
--      out on round-trip job-work DCs (print/embroidery, washing, packing).
--  * finishing input/output and final QC reference the bundle (old rows
--    without a bundle keep working).
--  * job-work challans (DCs) carry bundle-wise lines with receipt tallies,
--    vehicle/driver, issue/cancel/close audit columns.
--  * bundle merge source table (merge keeps every source bundle's history).
--  * Ironing process stage for every company.
-- Every statement is idempotent: the migrate runner re-applies files.
-- =====================================================================


-- trx_cutting_bundle
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_cutting_bundle' AND COLUMN_NAME='sew_in_qty');
SET @s = IF(@x=0, 'ALTER TABLE trx_cutting_bundle ADD COLUMN sew_in_qty INT NOT NULL DEFAULT 0 COMMENT \'PCS issued to sewing (line input or stitching DC)\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_cutting_bundle' AND COLUMN_NAME='sew_good_qty');
SET @s = IF(@x=0, 'ALTER TABLE trx_cutting_bundle ADD COLUMN sew_good_qty INT NOT NULL DEFAULT 0 COMMENT \'Good PCS out of sewing\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_cutting_bundle' AND COLUMN_NAME='sew_reject_qty');
SET @s = IF(@x=0, 'ALTER TABLE trx_cutting_bundle ADD COLUMN sew_reject_qty INT NOT NULL DEFAULT 0 COMMENT \'Sewing reject + shortage PCS\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_cutting_bundle' AND COLUMN_NAME='fin_in_qty');
SET @s = IF(@x=0, 'ALTER TABLE trx_cutting_bundle ADD COLUMN fin_in_qty INT NOT NULL DEFAULT 0 COMMENT \'PCS issued to finishing / ironing\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_cutting_bundle' AND COLUMN_NAME='fin_good_qty');
SET @s = IF(@x=0, 'ALTER TABLE trx_cutting_bundle ADD COLUMN fin_good_qty INT NOT NULL DEFAULT 0 COMMENT \'Finished good PCS\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_cutting_bundle' AND COLUMN_NAME='fin_reject_qty');
SET @s = IF(@x=0, 'ALTER TABLE trx_cutting_bundle ADD COLUMN fin_reject_qty INT NOT NULL DEFAULT 0 COMMENT \'Finishing reject + shortage PCS\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_cutting_bundle' AND COLUMN_NAME='qc_pass_qty');
SET @s = IF(@x=0, 'ALTER TABLE trx_cutting_bundle ADD COLUMN qc_pass_qty INT NOT NULL DEFAULT 0 COMMENT \'Final QC passed PCS\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_cutting_bundle' AND COLUMN_NAME='qc_reject_qty');
SET @s = IF(@x=0, 'ALTER TABLE trx_cutting_bundle ADD COLUMN qc_reject_qty INT NOT NULL DEFAULT 0 COMMENT \'Final QC rejected PCS\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_cutting_bundle' AND COLUMN_NAME='packed_qty');
SET @s = IF(@x=0, 'ALTER TABLE trx_cutting_bundle ADD COLUMN packed_qty INT NOT NULL DEFAULT 0 COMMENT \'PCS packed into cartons\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_cutting_bundle' AND COLUMN_NAME='cut_loss_qty');
SET @s = IF(@x=0, 'ALTER TABLE trx_cutting_bundle ADD COLUMN cut_loss_qty INT NOT NULL DEFAULT 0 COMMENT \'Cut-panel PCS lost at a pre-sewing job-work process\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_cutting_bundle' AND COLUMN_NAME='sewn_loss_qty');
SET @s = IF(@x=0, 'ALTER TABLE trx_cutting_bundle ADD COLUMN sewn_loss_qty INT NOT NULL DEFAULT 0 COMMENT \'Sewn PCS lost at a post-sewing job-work process\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_cutting_bundle' AND COLUMN_NAME='pack_loss_qty');
SET @s = IF(@x=0, 'ALTER TABLE trx_cutting_bundle ADD COLUMN pack_loss_qty INT NOT NULL DEFAULT 0 COMMENT \'Finished PCS lost at a packing job-work process\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_cutting_bundle' AND COLUMN_NAME='out_cut_qty');
SET @s = IF(@x=0, 'ALTER TABLE trx_cutting_bundle ADD COLUMN out_cut_qty INT NOT NULL DEFAULT 0 COMMENT \'Cut panels currently out on a pre-sewing DC (print/embroidery)\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_cutting_bundle' AND COLUMN_NAME='out_sewn_qty');
SET @s = IF(@x=0, 'ALTER TABLE trx_cutting_bundle ADD COLUMN out_sewn_qty INT NOT NULL DEFAULT 0 COMMENT \'Sewn PCS currently out on a post-sewing DC (washing)\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_cutting_bundle' AND COLUMN_NAME='out_pack_qty');
SET @s = IF(@x=0, 'ALTER TABLE trx_cutting_bundle ADD COLUMN out_pack_qty INT NOT NULL DEFAULT 0 COMMENT \'Finished PCS currently out on a packing DC\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- trx_finishing_input
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_finishing_input' AND COLUMN_NAME='bundle_id');
SET @s = IF(@x=0, 'ALTER TABLE trx_finishing_input ADD COLUMN bundle_id BIGINT UNSIGNED NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- trx_finishing_output
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_finishing_output' AND COLUMN_NAME='bundle_id');
SET @s = IF(@x=0, 'ALTER TABLE trx_finishing_output ADD COLUMN bundle_id BIGINT UNSIGNED NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- trx_final_qc
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_final_qc' AND COLUMN_NAME='bundle_id');
SET @s = IF(@x=0, 'ALTER TABLE trx_final_qc ADD COLUMN bundle_id BIGINT UNSIGNED NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_final_qc' AND COLUMN_NAME='hold_qty');
SET @s = IF(@x=0, 'ALTER TABLE trx_final_qc ADD COLUMN hold_qty INT UNSIGNED NOT NULL DEFAULT 0', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- trx_sewing_input
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_sewing_input' AND COLUMN_NAME='work_center');
SET @s = IF(@x=0, 'ALTER TABLE trx_sewing_input ADD COLUMN work_center VARCHAR(80) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_sewing_input' AND COLUMN_NAME='cancel_reason');
SET @s = IF(@x=0, 'ALTER TABLE trx_sewing_input ADD COLUMN cancel_reason VARCHAR(255) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_sewing_input' AND COLUMN_NAME='cancelled_by');
SET @s = IF(@x=0, 'ALTER TABLE trx_sewing_input ADD COLUMN cancelled_by BIGINT UNSIGNED NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_sewing_input' AND COLUMN_NAME='cancelled_at');
SET @s = IF(@x=0, 'ALTER TABLE trx_sewing_input ADD COLUMN cancelled_at DATETIME NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- trx_finishing_input
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_finishing_input' AND COLUMN_NAME='work_center');
SET @s = IF(@x=0, 'ALTER TABLE trx_finishing_input ADD COLUMN work_center VARCHAR(80) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_finishing_input' AND COLUMN_NAME='cancel_reason');
SET @s = IF(@x=0, 'ALTER TABLE trx_finishing_input ADD COLUMN cancel_reason VARCHAR(255) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_finishing_input' AND COLUMN_NAME='cancelled_by');
SET @s = IF(@x=0, 'ALTER TABLE trx_finishing_input ADD COLUMN cancelled_by BIGINT UNSIGNED NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_finishing_input' AND COLUMN_NAME='cancelled_at');
SET @s = IF(@x=0, 'ALTER TABLE trx_finishing_input ADD COLUMN cancelled_at DATETIME NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_finishing_input' AND COLUMN_NAME='line_name');
SET @s = IF(@x=0, 'ALTER TABLE trx_finishing_input ADD COLUMN line_name VARCHAR(60) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- trx_jobwork_challan
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_challan' AND COLUMN_NAME='io_no');
SET @s = IF(@x=0, 'ALTER TABLE trx_jobwork_challan ADD COLUMN io_no VARCHAR(40) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_challan' AND COLUMN_NAME='cutting_plan_id');
SET @s = IF(@x=0, 'ALTER TABLE trx_jobwork_challan ADD COLUMN cutting_plan_id BIGINT UNSIGNED NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_challan' AND COLUMN_NAME='style_id');
SET @s = IF(@x=0, 'ALTER TABLE trx_jobwork_challan ADD COLUMN style_id BIGINT UNSIGNED NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_challan' AND COLUMN_NAME='is_bundle_dc');
SET @s = IF(@x=0, 'ALTER TABLE trx_jobwork_challan ADD COLUMN is_bundle_dc TINYINT(1) NOT NULL DEFAULT 0', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_challan' AND COLUMN_NAME='vehicle_no');
SET @s = IF(@x=0, 'ALTER TABLE trx_jobwork_challan ADD COLUMN vehicle_no VARCHAR(30) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_challan' AND COLUMN_NAME='driver_name');
SET @s = IF(@x=0, 'ALTER TABLE trx_jobwork_challan ADD COLUMN driver_name VARCHAR(80) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_challan' AND COLUMN_NAME='transporter');
SET @s = IF(@x=0, 'ALTER TABLE trx_jobwork_challan ADD COLUMN transporter VARCHAR(120) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_challan' AND COLUMN_NAME='issued_by');
SET @s = IF(@x=0, 'ALTER TABLE trx_jobwork_challan ADD COLUMN issued_by BIGINT UNSIGNED NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_challan' AND COLUMN_NAME='issued_at');
SET @s = IF(@x=0, 'ALTER TABLE trx_jobwork_challan ADD COLUMN issued_at DATETIME NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_challan' AND COLUMN_NAME='cancel_reason');
SET @s = IF(@x=0, 'ALTER TABLE trx_jobwork_challan ADD COLUMN cancel_reason VARCHAR(255) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_challan' AND COLUMN_NAME='cancelled_by');
SET @s = IF(@x=0, 'ALTER TABLE trx_jobwork_challan ADD COLUMN cancelled_by BIGINT UNSIGNED NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_challan' AND COLUMN_NAME='cancelled_at');
SET @s = IF(@x=0, 'ALTER TABLE trx_jobwork_challan ADD COLUMN cancelled_at DATETIME NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_challan' AND COLUMN_NAME='close_reason');
SET @s = IF(@x=0, 'ALTER TABLE trx_jobwork_challan ADD COLUMN close_reason VARCHAR(255) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_challan' AND COLUMN_NAME='closed_by');
SET @s = IF(@x=0, 'ALTER TABLE trx_jobwork_challan ADD COLUMN closed_by BIGINT UNSIGNED NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_challan' AND COLUMN_NAME='closed_at');
SET @s = IF(@x=0, 'ALTER TABLE trx_jobwork_challan ADD COLUMN closed_at DATETIME NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- trx_jobwork_challan_line
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_challan_line' AND COLUMN_NAME='style_id');
SET @s = IF(@x=0, 'ALTER TABLE trx_jobwork_challan_line ADD COLUMN style_id BIGINT UNSIGNED NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_challan_line' AND COLUMN_NAME='color_id');
SET @s = IF(@x=0, 'ALTER TABLE trx_jobwork_challan_line ADD COLUMN color_id BIGINT UNSIGNED NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_challan_line' AND COLUMN_NAME='size_id');
SET @s = IF(@x=0, 'ALTER TABLE trx_jobwork_challan_line ADD COLUMN size_id BIGINT UNSIGNED NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_challan_line' AND COLUMN_NAME='part_name');
SET @s = IF(@x=0, 'ALTER TABLE trx_jobwork_challan_line ADD COLUMN part_name VARCHAR(50) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_challan_line' AND COLUMN_NAME='source_level');
SET @s = IF(@x=0, 'ALTER TABLE trx_jobwork_challan_line ADD COLUMN source_level VARCHAR(10) NULL COMMENT \'CUT/SEWN/PACK — bundle stock the qty was drawn from\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_challan_line' AND COLUMN_NAME='received_qty');
SET @s = IF(@x=0, 'ALTER TABLE trx_jobwork_challan_line ADD COLUMN received_qty INT NOT NULL DEFAULT 0', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_challan_line' AND COLUMN_NAME='rejected_qty');
SET @s = IF(@x=0, 'ALTER TABLE trx_jobwork_challan_line ADD COLUMN rejected_qty INT NOT NULL DEFAULT 0', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_challan_line' AND COLUMN_NAME='shortage_qty');
SET @s = IF(@x=0, 'ALTER TABLE trx_jobwork_challan_line ADD COLUMN shortage_qty INT NOT NULL DEFAULT 0', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- trx_jobwork_receipt_line
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_receipt_line' AND COLUMN_NAME='challan_line_id');
SET @s = IF(@x=0, 'ALTER TABLE trx_jobwork_receipt_line ADD COLUMN challan_line_id BIGINT UNSIGNED NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_receipt_line' AND COLUMN_NAME='bundle_id');
SET @s = IF(@x=0, 'ALTER TABLE trx_jobwork_receipt_line ADD COLUMN bundle_id BIGINT UNSIGNED NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- indexes
SET @x = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_finishing_input' AND INDEX_NAME='ix_finishing_input_bundle');
SET @s = IF(@x=0, 'ALTER TABLE trx_finishing_input ADD KEY ix_finishing_input_bundle (bundle_id)', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_finishing_output' AND INDEX_NAME='ix_finishing_output_bundle');
SET @s = IF(@x=0, 'ALTER TABLE trx_finishing_output ADD KEY ix_finishing_output_bundle (bundle_id)', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_final_qc' AND INDEX_NAME='ix_final_qc_bundle');
SET @s = IF(@x=0, 'ALTER TABLE trx_final_qc ADD KEY ix_final_qc_bundle (bundle_id)', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_challan' AND INDEX_NAME='ix_jwc_stage_status');
SET @s = IF(@x=0, 'ALTER TABLE trx_jobwork_challan ADD KEY ix_jwc_stage_status (company_id, stage_id, status)', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_receipt_line' AND INDEX_NAME='ix_jwrl_bundle');
SET @s = IF(@x=0, 'ALTER TABLE trx_jobwork_receipt_line ADD KEY ix_jwrl_bundle (bundle_id)', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_receipt_line' AND INDEX_NAME='ix_jwrl_cline');
SET @s = IF(@x=0, 'ALTER TABLE trx_jobwork_receipt_line ADD KEY ix_jwrl_cline (challan_line_id)', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- Bundle statuses: keep 52's list (ISSUED is used for bundles out on a
-- pre-sewing DC, CLOSED for merge sources).
-- Merge history: one merged bundle ← many source bundles (doc §14).
CREATE TABLE IF NOT EXISTS trx_bundle_merge_source (
  id                   BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id           BIGINT UNSIGNED NOT NULL,
  merged_bundle_id     BIGINT UNSIGNED NOT NULL,
  source_bundle_id     BIGINT UNSIGNED NOT NULL,
  qty                  INT UNSIGNED NOT NULL,
  allocated_kg         DECIMAL(12,5) NULL,
  reason               VARCHAR(255) NULL,
  created_by           BIGINT UNSIGNED NULL,
  created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_bms (merged_bundle_id, source_bundle_id),
  KEY ix_bms_source (source_bundle_id),
  CONSTRAINT fk_bms__merged FOREIGN KEY (merged_bundle_id) REFERENCES trx_cutting_bundle(id),
  CONSTRAINT fk_bms__source FOREIGN KEY (source_bundle_id) REFERENCES trx_cutting_bundle(id)
) ENGINE=InnoDB COMMENT='Source bundles of a merged bundle (doc §14)';

-- Company on bundles made by older generators.
UPDATE trx_cutting_bundle b JOIN trx_cutting c ON c.id = b.cutting_id
   SET b.company_id = c.company_id WHERE b.company_id IS NULL;
UPDATE trx_cutting_bundle SET balance_qty = qty WHERE balance_qty IS NULL;

-- Backfill counters from legacy sewing input/output rows (only rows whose
-- counters are still zero, so re-running is a no-op).
UPDATE trx_cutting_bundle b
  JOIN (SELECT bundle_id, SUM(COALESCE(input_qty,0)) AS q
          FROM trx_sewing_input WHERE status <> 'CANCELLED' GROUP BY bundle_id) x ON x.bundle_id = b.id
   SET b.balance_qty = GREATEST(CAST(b.balance_qty AS SIGNED) - x.q, 0), b.sew_in_qty = x.q
 WHERE b.sew_in_qty = 0 AND x.q > 0;
UPDATE trx_cutting_bundle b
  JOIN (SELECT bundle_id, SUM(COALESCE(output_qty,0)) AS g, SUM(COALESCE(reject_qty,0)) AS r
          FROM trx_sewing_output WHERE bundle_id IS NOT NULL GROUP BY bundle_id) x ON x.bundle_id = b.id
   SET b.sew_good_qty = LEAST(x.g, b.sew_in_qty), b.sew_reject_qty = LEAST(x.r, GREATEST(b.sew_in_qty - LEAST(x.g, b.sew_in_qty), 0))
 WHERE b.sew_good_qty = 0 AND b.sew_reject_qty = 0 AND (x.g > 0 OR x.r > 0);

-- Ironing is a job-work process the client sends bundles out for (voice note 1).
INSERT IGNORE INTO cfg_process_stage (company_id, stage_code, stage_name, is_outsourceable, sort_order, is_active)
SELECT c.id, 'IRON', 'Ironing', 1,
       COALESCE((SELECT MAX(ps.sort_order) FROM cfg_process_stage ps WHERE ps.company_id = c.id AND ps.stage_code = 'WASH'), 70) + 1, 1
  FROM mst_company c;

-- 1 = cartons may only take Final-QC passed PCS; 0 = finished PCS (QC rejects excluded).
INSERT IGNORE INTO cfg_system_setting (company_id, setting_key, setting_value, description)
SELECT id, 'PACKING_REQUIRES_FINAL_QC', '0', '1 = only Final QC passed PCS can be packed into cartons; 0 = finished PCS less QC rejects'
  FROM mst_company;
