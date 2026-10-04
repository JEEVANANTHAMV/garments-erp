-- 102: CAD marker → automatic lay calculation → roll allocation → spreading → cutting (client doc + voice notes 04-Oct-2026),
--      and Partial / Final per GRN line (a PO carries several jobs; one job may come in half).
-- Re-runnable. Every ALTER is guarded by table + column existence (a fresh install creates the tables later in the run).

SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_grn_line');
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_grn_line' AND COLUMN_NAME='receipt_type');
SET @s = IF(@t=1 AND @x=0, 'ALTER TABLE trx_grn_line ADD COLUMN receipt_type VARCHAR(10) NULL COMMENT ''PARTIAL / FINAL for this PO line (client 04-Oct-2026)''', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_trim_grn_line');
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_trim_grn_line' AND COLUMN_NAME='receipt_type');
SET @s = IF(@t=1 AND @x=0, 'ALTER TABLE trx_trim_grn_line ADD COLUMN receipt_type VARCHAR(10) NULL COMMENT ''PARTIAL / FINAL for this PO line''', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_cutting_plan');
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_cutting_plan' AND COLUMN_NAME='cad_req_id');
SET @s = IF(@t=1 AND @x=0, 'ALTER TABLE trx_cutting_plan ADD COLUMN cad_req_id BIGINT UNSIGNED NULL COMMENT ''CAD (cutting program) the cut order was loaded from''', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_cutting_plan');
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_cutting_plan' AND COLUMN_NAME='buyer_po_no');
SET @s = IF(@t=1 AND @x=0, 'ALTER TABLE trx_cutting_plan ADD COLUMN buyer_po_no VARCHAR(60) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_marker_version');
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_marker_version' AND COLUMN_NAME='status');
SET @s = IF(@t=1 AND @x=0, 'ALTER TABLE trx_marker_version ADD COLUMN status VARCHAR(12) NOT NULL DEFAULT ''DRAFT'' COMMENT ''DRAFT / IMPORTED / REVIEW / APPROVED / REJECTED / OBSOLETE''', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_marker_version');
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_marker_version' AND COLUMN_NAME='so_id');
SET @s = IF(@t=1 AND @x=0, 'ALTER TABLE trx_marker_version ADD COLUMN so_id BIGINT UNSIGNED NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_marker_version');
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_marker_version' AND COLUMN_NAME='io_no');
SET @s = IF(@t=1 AND @x=0, 'ALTER TABLE trx_marker_version ADD COLUMN io_no VARCHAR(60) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_marker_version');
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_marker_version' AND COLUMN_NAME='buyer_po_no');
SET @s = IF(@t=1 AND @x=0, 'ALTER TABLE trx_marker_version ADD COLUMN buyer_po_no VARCHAR(60) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_marker_version');
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_marker_version' AND COLUMN_NAME='efficiency_pct');
SET @s = IF(@t=1 AND @x=0, 'ALTER TABLE trx_marker_version ADD COLUMN efficiency_pct DECIMAL(6,2) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_marker_version');
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_marker_version' AND COLUMN_NAME='cad_source');
SET @s = IF(@t=1 AND @x=0, 'ALTER TABLE trx_marker_version ADD COLUMN cad_source VARCHAR(40) NULL COMMENT ''CAD system / ERP_CAD / MANUAL''', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_marker_version');
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_marker_version' AND COLUMN_NAME='import_hash');
SET @s = IF(@t=1 AND @x=0, 'ALTER TABLE trx_marker_version ADD COLUMN import_hash CHAR(64) NULL COMMENT ''Duplicate protection for imported rows''', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_marker_version');
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_marker_version' AND COLUMN_NAME='import_batch');
SET @s = IF(@t=1 AND @x=0, 'ALTER TABLE trx_marker_version ADD COLUMN import_batch VARCHAR(64) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_marker_version');
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_marker_version' AND COLUMN_NAME='size_quantities');
SET @s = IF(@t=1 AND @x=0, 'ALTER TABLE trx_marker_version ADD COLUMN size_quantities JSON NULL COMMENT ''Size-wise output per marker''', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_marker_version');
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_marker_version' AND COLUMN_NAME='consumption_m_per_pc');
SET @s = IF(@t=1 AND @x=0, 'ALTER TABLE trx_marker_version ADD COLUMN consumption_m_per_pc DECIMAL(12,5) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_marker_version');
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_marker_version' AND COLUMN_NAME='reviewed_by');
SET @s = IF(@t=1 AND @x=0, 'ALTER TABLE trx_marker_version ADD COLUMN reviewed_by BIGINT UNSIGNED NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_marker_version');
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_marker_version' AND COLUMN_NAME='reviewed_at');
SET @s = IF(@t=1 AND @x=0, 'ALTER TABLE trx_marker_version ADD COLUMN reviewed_at DATETIME NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_marker_version');
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_marker_version' AND COLUMN_NAME='rejected_by');
SET @s = IF(@t=1 AND @x=0, 'ALTER TABLE trx_marker_version ADD COLUMN rejected_by BIGINT UNSIGNED NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_marker_version');
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_marker_version' AND COLUMN_NAME='rejected_at');
SET @s = IF(@t=1 AND @x=0, 'ALTER TABLE trx_marker_version ADD COLUMN rejected_at DATETIME NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_marker_version');
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_marker_version' AND COLUMN_NAME='reject_reason');
SET @s = IF(@t=1 AND @x=0, 'ALTER TABLE trx_marker_version ADD COLUMN reject_reason VARCHAR(255) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_marker_version');
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_marker_version' AND COLUMN_NAME='obsoleted_by');
SET @s = IF(@t=1 AND @x=0, 'ALTER TABLE trx_marker_version ADD COLUMN obsoleted_by BIGINT UNSIGNED NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_marker_version');
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_marker_version' AND COLUMN_NAME='obsoleted_at');
SET @s = IF(@t=1 AND @x=0, 'ALTER TABLE trx_marker_version ADD COLUMN obsoleted_at DATETIME NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_lay_plan');
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_lay_plan' AND COLUMN_NAME='lay_seq');
SET @s = IF(@t=1 AND @x=0, 'ALTER TABLE trx_lay_plan ADD COLUMN lay_seq INT NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_lay_plan');
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_lay_plan' AND COLUMN_NAME='so_id');
SET @s = IF(@t=1 AND @x=0, 'ALTER TABLE trx_lay_plan ADD COLUMN so_id BIGINT UNSIGNED NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_lay_plan');
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_lay_plan' AND COLUMN_NAME='gen_batch');
SET @s = IF(@t=1 AND @x=0, 'ALTER TABLE trx_lay_plan ADD COLUMN gen_batch VARCHAR(40) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_lay_plan');
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_lay_plan' AND COLUMN_NAME='planned_length_m');
SET @s = IF(@t=1 AND @x=0, 'ALTER TABLE trx_lay_plan ADD COLUMN planned_length_m DECIMAL(12,3) NULL COMMENT ''Marker length × ply''', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_lay_plan');
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_lay_plan' AND COLUMN_NAME='size_output');
SET @s = IF(@t=1 AND @x=0, 'ALTER TABLE trx_lay_plan ADD COLUMN size_output JSON NULL COMMENT ''Planned size-wise output''', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_lay_plan');
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_lay_plan' AND COLUMN_NAME='table_id');
SET @s = IF(@t=1 AND @x=0, 'ALTER TABLE trx_lay_plan ADD COLUMN table_id BIGINT UNSIGNED NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_lay_plan');
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_lay_plan' AND COLUMN_NAME='plan_approved_by');
SET @s = IF(@t=1 AND @x=0, 'ALTER TABLE trx_lay_plan ADD COLUMN plan_approved_by BIGINT UNSIGNED NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_lay_plan');
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_lay_plan' AND COLUMN_NAME='plan_approved_at');
SET @s = IF(@t=1 AND @x=0, 'ALTER TABLE trx_lay_plan ADD COLUMN plan_approved_at DATETIME NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_lay_plan');
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_lay_plan' AND COLUMN_NAME='fabric_issue_id');
SET @s = IF(@t=1 AND @x=0, 'ALTER TABLE trx_lay_plan ADD COLUMN fabric_issue_id BIGINT UNSIGNED NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_lay_plan');
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_lay_plan' AND COLUMN_NAME='issued_at');
SET @s = IF(@t=1 AND @x=0, 'ALTER TABLE trx_lay_plan ADD COLUMN issued_at DATETIME NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_lay_plan');
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_lay_plan' AND COLUMN_NAME='received_by');
SET @s = IF(@t=1 AND @x=0, 'ALTER TABLE trx_lay_plan ADD COLUMN received_by BIGINT UNSIGNED NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_lay_plan');
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_lay_plan' AND COLUMN_NAME='received_at');
SET @s = IF(@t=1 AND @x=0, 'ALTER TABLE trx_lay_plan ADD COLUMN received_at DATETIME NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_lay_plan');
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_lay_plan' AND COLUMN_NAME='actual_ply');
SET @s = IF(@t=1 AND @x=0, 'ALTER TABLE trx_lay_plan ADD COLUMN actual_ply INT NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_lay_plan');
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_lay_plan' AND COLUMN_NAME='actual_length_m');
SET @s = IF(@t=1 AND @x=0, 'ALTER TABLE trx_lay_plan ADD COLUMN actual_length_m DECIMAL(12,3) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_lay_plan');
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_lay_plan' AND COLUMN_NAME='end_loss_m');
SET @s = IF(@t=1 AND @x=0, 'ALTER TABLE trx_lay_plan ADD COLUMN end_loss_m DECIMAL(10,3) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_lay_plan');
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_lay_plan' AND COLUMN_NAME='splice_loss_m');
SET @s = IF(@t=1 AND @x=0, 'ALTER TABLE trx_lay_plan ADD COLUMN splice_loss_m DECIMAL(10,3) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_lay_plan');
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_lay_plan' AND COLUMN_NAME='variance_reason');
SET @s = IF(@t=1 AND @x=0, 'ALTER TABLE trx_lay_plan ADD COLUMN variance_reason VARCHAR(255) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_lay_plan');
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_lay_plan' AND COLUMN_NAME='variance_by');
SET @s = IF(@t=1 AND @x=0, 'ALTER TABLE trx_lay_plan ADD COLUMN variance_by BIGINT UNSIGNED NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_lay_plan');
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_lay_plan' AND COLUMN_NAME='variance_at');
SET @s = IF(@t=1 AND @x=0, 'ALTER TABLE trx_lay_plan ADD COLUMN variance_at DATETIME NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_lay_plan');
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_lay_plan' AND COLUMN_NAME='override_reason');
SET @s = IF(@t=1 AND @x=0, 'ALTER TABLE trx_lay_plan ADD COLUMN override_reason VARCHAR(255) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_lay_plan');
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_lay_plan' AND COLUMN_NAME='override_by');
SET @s = IF(@t=1 AND @x=0, 'ALTER TABLE trx_lay_plan ADD COLUMN override_by BIGINT UNSIGNED NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_lay_plan');
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_lay_plan' AND COLUMN_NAME='table_no');
SET @s = IF(@t=1 AND @x=0, 'ALTER TABLE trx_lay_plan ADD COLUMN table_no VARCHAR(40) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_lay_plan');
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_lay_plan' AND COLUMN_NAME='cancelled_by');
SET @s = IF(@t=1 AND @x=0, 'ALTER TABLE trx_lay_plan ADD COLUMN cancelled_by BIGINT UNSIGNED NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_lay_plan');
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_lay_plan' AND COLUMN_NAME='cancelled_at');
SET @s = IF(@t=1 AND @x=0, 'ALTER TABLE trx_lay_plan ADD COLUMN cancelled_at DATETIME NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_spreading');
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_spreading' AND COLUMN_NAME='status');
SET @s = IF(@t=1 AND @x=0, 'ALTER TABLE trx_spreading ADD COLUMN status VARCHAR(12) NOT NULL DEFAULT ''COMPLETED'' COMMENT ''PLANNED / IN_PROGRESS / COMPLETED / VERIFIED''', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_spreading');
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_spreading' AND COLUMN_NAME='ply_planned');
SET @s = IF(@t=1 AND @x=0, 'ALTER TABLE trx_spreading ADD COLUMN ply_planned INT NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_spreading');
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_spreading' AND COLUMN_NAME='planned_length_m');
SET @s = IF(@t=1 AND @x=0, 'ALTER TABLE trx_spreading ADD COLUMN planned_length_m DECIMAL(12,3) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_spreading');
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_spreading' AND COLUMN_NAME='actual_length_m');
SET @s = IF(@t=1 AND @x=0, 'ALTER TABLE trx_spreading ADD COLUMN actual_length_m DECIMAL(12,3) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_spreading');
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_spreading' AND COLUMN_NAME='planned_kg');
SET @s = IF(@t=1 AND @x=0, 'ALTER TABLE trx_spreading ADD COLUMN planned_kg DECIMAL(12,4) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_spreading');
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_spreading' AND COLUMN_NAME='actual_kg');
SET @s = IF(@t=1 AND @x=0, 'ALTER TABLE trx_spreading ADD COLUMN actual_kg DECIMAL(12,4) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_spreading');
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_spreading' AND COLUMN_NAME='end_loss_m');
SET @s = IF(@t=1 AND @x=0, 'ALTER TABLE trx_spreading ADD COLUMN end_loss_m DECIMAL(10,3) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_spreading');
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_spreading' AND COLUMN_NAME='splice_loss_m');
SET @s = IF(@t=1 AND @x=0, 'ALTER TABLE trx_spreading ADD COLUMN splice_loss_m DECIMAL(10,3) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_spreading');
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_spreading' AND COLUMN_NAME='start_time');
SET @s = IF(@t=1 AND @x=0, 'ALTER TABLE trx_spreading ADD COLUMN start_time DATETIME NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_spreading');
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_spreading' AND COLUMN_NAME='end_time');
SET @s = IF(@t=1 AND @x=0, 'ALTER TABLE trx_spreading ADD COLUMN end_time DATETIME NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_spreading');
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_spreading' AND COLUMN_NAME='table_no');
SET @s = IF(@t=1 AND @x=0, 'ALTER TABLE trx_spreading ADD COLUMN table_no VARCHAR(40) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_spreading');
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_spreading' AND COLUMN_NAME='completed_by');
SET @s = IF(@t=1 AND @x=0, 'ALTER TABLE trx_spreading ADD COLUMN completed_by BIGINT UNSIGNED NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_spreading');
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_spreading' AND COLUMN_NAME='completed_at');
SET @s = IF(@t=1 AND @x=0, 'ALTER TABLE trx_spreading ADD COLUMN completed_at DATETIME NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_spreading');
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_spreading' AND COLUMN_NAME='verified_by');
SET @s = IF(@t=1 AND @x=0, 'ALTER TABLE trx_spreading ADD COLUMN verified_by BIGINT UNSIGNED NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_spreading');
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_spreading' AND COLUMN_NAME='verified_at');
SET @s = IF(@t=1 AND @x=0, 'ALTER TABLE trx_spreading ADD COLUMN verified_at DATETIME NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_spreading');
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_spreading' AND COLUMN_NAME='variance_reason');
SET @s = IF(@t=1 AND @x=0, 'ALTER TABLE trx_spreading ADD COLUMN variance_reason VARCHAR(255) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_fabric_issue');
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_fabric_issue' AND COLUMN_NAME='lay_id');
SET @s = IF(@t=1 AND @x=0, 'ALTER TABLE trx_fabric_issue ADD COLUMN lay_id BIGINT UNSIGNED NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_fabric_issue');
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_fabric_issue' AND COLUMN_NAME='marker_version_id');
SET @s = IF(@t=1 AND @x=0, 'ALTER TABLE trx_fabric_issue ADD COLUMN marker_version_id BIGINT UNSIGNED NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_fabric_issue');
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_fabric_issue' AND COLUMN_NAME='received_by');
SET @s = IF(@t=1 AND @x=0, 'ALTER TABLE trx_fabric_issue ADD COLUMN received_by BIGINT UNSIGNED NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_fabric_issue');
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_fabric_issue' AND COLUMN_NAME='received_at');
SET @s = IF(@t=1 AND @x=0, 'ALTER TABLE trx_fabric_issue ADD COLUMN received_at DATETIME NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_fabric_issue_roll');
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_fabric_issue_roll' AND COLUMN_NAME='lay_alloc_id');
SET @s = IF(@t=1 AND @x=0, 'ALTER TABLE trx_fabric_issue_roll ADD COLUMN lay_alloc_id BIGINT UNSIGNED NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- Lay statuses (doc §21). Migration 52 carries the same list — it re-runs on every deploy, so it must never narrow it.

SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_lay_plan');
SET @s = IF(@t=1, 'ALTER TABLE trx_lay_plan MODIFY COLUMN status ENUM(''GENERATED'',''ROLL_RESERVED'',''PLAN_APPROVED'',''ISSUED'',''RECEIVED'',''SPREADING'',''READY_FOR_CUTTING'',''PLANNED'',''SPREAD'',''CUT'',''APPROVED'',''CLOSED'',''CANCELLED'') DEFAULT ''PLANNED''', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_fabric_issue');
SET @s = IF(@t=1, 'ALTER TABLE trx_fabric_issue MODIFY COLUMN status ENUM(''DRAFT'',''ISSUED'',''CONFIRMED'',''RETURNED'',''RECEIVED'',''CANCELLED'') DEFAULT ''DRAFT''', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- Backfill: Partial / Final per line from the GRN header (purchase GRNs against a PO only).
SET @t = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_grn_line' AND COLUMN_NAME='receipt_type');
SET @s = IF(@t=1, 'UPDATE trx_grn_line gl JOIN trx_grn g ON g.id = gl.grn_id SET gl.receipt_type = g.receipt_type WHERE gl.receipt_type IS NULL AND gl.po_line_id IS NOT NULL AND g.receipt_type IN (''PARTIAL'',''FINAL'')', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @t = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_trim_grn_line' AND COLUMN_NAME='receipt_type');
SET @s = IF(@t=1, 'UPDATE trx_trim_grn_line gl JOIN trx_trim_grn g ON g.id = gl.grn_id SET gl.receipt_type = g.receipt_type WHERE gl.receipt_type IS NULL AND gl.po_line_id IS NOT NULL AND g.receipt_type IN (''PARTIAL'',''FINAL'')', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- Backfill: marker status from the old approval stamp.
SET @t = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_marker_version' AND COLUMN_NAME='status');
SET @s = IF(@t=1, 'UPDATE trx_marker_version SET status = ''APPROVED'' WHERE approved_at IS NOT NULL AND status = ''DRAFT''', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @t = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_marker_version' AND INDEX_NAME='ix_mv_import');
SET @u = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_marker_version' AND COLUMN_NAME='import_hash');
SET @s = IF(@t=0 AND @u=1, 'ALTER TABLE trx_marker_version ADD KEY ix_mv_import (company_id, import_hash)', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @t = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_lay_plan' AND INDEX_NAME='ix_lay_plan_status');
SET @u = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_lay_plan');
SET @s = IF(@t=0 AND @u=1, 'ALTER TABLE trx_lay_plan ADD KEY ix_lay_plan_status (cutting_plan_id, status)', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- Lay roll allocation / reservation (doc §9, §10, §17 lay_roll_allocations + fabric_roll_reservations).
-- A reservation holds KG of a roll for a lay without consuming it; the roll keeps its balance (partial roll).
CREATE TABLE IF NOT EXISTS trx_lay_roll_alloc (
  id                   BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id           BIGINT UNSIGNED NOT NULL,
  lay_id               BIGINT UNSIGNED NOT NULL,
  cutting_plan_id      BIGINT UNSIGNED NOT NULL,
  fabric_roll_id       BIGINT UNSIGNED NOT NULL COMMENT 'Parent roll — the balance stays on it',
  roll_no              VARCHAR(60) NOT NULL,
  lot_no               VARCHAR(60) NULL,
  shade                VARCHAR(50) NULL,
  seq                  INT NOT NULL DEFAULT 1,
  alloc_kg             DECIMAL(12,4) NOT NULL,
  alloc_m              DECIMAL(12,3) NULL,
  roll_balance_kg      DECIMAL(12,4) NULL COMMENT 'Roll KG left after this allocation, at reservation time',
  status               ENUM('RESERVED','ISSUED','CONSUMED','RELEASED') NOT NULL DEFAULT 'RESERVED',
  fabric_issue_roll_id BIGINT UNSIGNED NULL,
  method               VARCHAR(10) NOT NULL DEFAULT 'AUTO' COMMENT 'AUTO / MANUAL',
  created_by           BIGINT UNSIGNED NULL,
  created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  released_by          BIGINT UNSIGNED NULL,
  released_at          DATETIME NULL,
  release_reason       VARCHAR(255) NULL,
  KEY ix_lra_lay (lay_id),
  KEY ix_lra_roll (fabric_roll_id, status),
  KEY ix_lra_plan (cutting_plan_id),
  CONSTRAINT chk_lra_kg CHECK (alloc_kg > 0)
) ENGINE=InnoDB COMMENT='Roll reservations of a lay (doc §9–§10)';

-- Spreading roll lines (doc §13: planned vs actual length / KG, plies, end + splice loss per roll).
CREATE TABLE IF NOT EXISTS trx_spreading_roll (
  id                   BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id           BIGINT UNSIGNED NOT NULL,
  spreading_id         BIGINT UNSIGNED NOT NULL,
  lay_id               BIGINT UNSIGNED NOT NULL,
  fabric_roll_id       BIGINT UNSIGNED NULL,
  fabric_issue_roll_id BIGINT UNSIGNED NULL,
  roll_no              VARCHAR(60) NULL,
  lot_no               VARCHAR(60) NULL,
  shade                VARCHAR(50) NULL,
  plies                INT NOT NULL DEFAULT 0,
  planned_m            DECIMAL(12,3) NULL,
  actual_m             DECIMAL(12,3) NULL,
  planned_kg           DECIMAL(12,4) NULL,
  actual_kg            DECIMAL(12,4) NULL,
  end_loss_m           DECIMAL(10,3) NOT NULL DEFAULT 0,
  splice_loss_m        DECIMAL(10,3) NOT NULL DEFAULT 0,
  created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_spr_spreading (spreading_id),
  KEY ix_spr_lay (lay_id),
  KEY ix_spr_roll (fabric_roll_id)
) ENGINE=InnoDB COMMENT='Roll-wise spreading (doc §13)';

-- Cutting tables (doc §1, §20: max / min ply and table constraints).
CREATE TABLE IF NOT EXISTS mst_cutting_table (
  id          BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id  BIGINT UNSIGNED NOT NULL,
  table_code  VARCHAR(30) NOT NULL,
  table_name  VARCHAR(80) NULL,
  length_m    DECIMAL(8,2) NULL COMMENT 'Longest marker the table takes',
  width_in    DECIMAL(8,2) NULL,
  max_ply     INT NOT NULL DEFAULT 60,
  min_ply     INT NOT NULL DEFAULT 1,
  is_active   TINYINT(1) NOT NULL DEFAULT 1,
  created_by  BIGINT UNSIGNED NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_cut_table (company_id, table_code)
) ENGINE=InnoDB COMMENT='Cutting tables and their ply / length limits';

-- Settings (editable under Admin › Settings).
INSERT IGNORE INTO cfg_system_setting (company_id, setting_key, setting_value, description)
SELECT id, 'CUT_MAX_PLY', '60', 'Lay engine: most plies in one lay when no cutting table is chosen' FROM mst_company;
INSERT IGNORE INTO cfg_system_setting (company_id, setting_key, setting_value, description)
SELECT id, 'CUT_MIN_PLY', '1', 'Lay engine: fewest plies in a lay (a smaller last lay is spread evenly over the lays)' FROM mst_company;
INSERT IGNORE INTO cfg_system_setting (company_id, setting_key, setting_value, description)
SELECT id, 'CUT_SIZE_TOLERANCE_PCT', '2', 'Lay engine: a size may be planned this % over its requirement; more needs a reason' FROM mst_company;
INSERT IGNORE INTO cfg_system_setting (company_id, setting_key, setting_value, description)
SELECT id, 'CUT_MIN_REUSABLE_M', '0.5', 'Roll eligibility: a roll balance shorter than this (metres) is not offered for a lay' FROM mst_company;
INSERT IGNORE INTO cfg_system_setting (company_id, setting_key, setting_value, description)
SELECT id, 'CUT_FABRIC_VARIANCE_PCT', '3', 'Spreading: actual fabric above plan by more than this %, or a ply change, needs a reason' FROM mst_company;
INSERT IGNORE INTO cfg_system_setting (company_id, setting_key, setting_value, description)
SELECT id, 'CUT_REQUIRE_APPROVED_MARKER', '1', 'Lays only from an APPROVED marker version (doc §23). 0 = drafts allowed' FROM mst_company;

-- Permissions (doc §26). Endpoints accept either these or the broad PRODUCTION.* codes, so nobody loses access.
INSERT INTO mst_permission (module_id, permission_code, permission_name)
SELECT m.id, p.code, p.name
  FROM mst_module m
  JOIN (SELECT 'CAD_MARKER.IMPORT' AS code, 'Import / snapshot CAD markers' AS name UNION ALL
        SELECT 'CAD_MARKER.APPROVE', 'Review, approve or reject CAD marker versions' UNION ALL
        SELECT 'CUTTING.PLAN', 'Plan lays and allocate / reserve rolls' UNION ALL
        SELECT 'CUTTING.SUPERVISE', 'Approve lay plans, verify spreading and cutting' UNION ALL
        SELECT 'CUTTING.STORE', 'Issue / receive fabric to cutting' UNION ALL
        SELECT 'CUTTING.EXECUTE', 'Spreading and cutting entry') p
 WHERE m.module_code = 'PRODUCTION'
   AND NOT EXISTS (SELECT 1 FROM mst_permission x WHERE x.permission_code = p.code);

INSERT INTO mst_role (company_id, role_code, role_name, description, is_system)
SELECT c.id, t.code, t.name, t.descr, 0
  FROM mst_company c
  JOIN (SELECT 'CAD_OPERATOR' AS code, 'CAD Operator' AS name, 'Imports and views CAD markers' AS descr
        UNION ALL SELECT 'CAD_APPROVER', 'CAD Approver', 'Approves / rejects CAD marker versions'
        UNION ALL SELECT 'CUTTING_PLANNER', 'Cutting Planner', 'Plans cut orders and lays, allocates rolls') t
 WHERE NOT EXISTS (SELECT 1 FROM mst_role r WHERE r.company_id = c.id AND r.role_code = t.code);

INSERT INTO map_role_permission (role_id, permission_id)
SELECT r.id, p.id
  FROM mst_role r
  JOIN (SELECT 'CAD_OPERATOR' AS role_code, 'PRODUCTION.VIEW' AS perm
        UNION ALL SELECT 'CAD_OPERATOR', 'CAD_MARKER.IMPORT'
        UNION ALL SELECT 'CAD_OPERATOR', 'DASHBOARD.VIEW'
        UNION ALL SELECT 'CAD_OPERATOR', 'STYLE.VIEW'
        UNION ALL SELECT 'CAD_APPROVER', 'PRODUCTION.VIEW'
        UNION ALL SELECT 'CAD_APPROVER', 'CAD_MARKER.IMPORT'
        UNION ALL SELECT 'CAD_APPROVER', 'CAD_MARKER.APPROVE'
        UNION ALL SELECT 'CAD_APPROVER', 'DASHBOARD.VIEW'
        UNION ALL SELECT 'CUTTING_PLANNER', 'PRODUCTION.VIEW'
        UNION ALL SELECT 'CUTTING_PLANNER', 'PRODUCTION.CREATE'
        UNION ALL SELECT 'CUTTING_PLANNER', 'CUTTING.PLAN'
        UNION ALL SELECT 'CUTTING_PLANNER', 'DASHBOARD.VIEW'
        UNION ALL SELECT 'CUTTING_PLANNER', 'STYLE.VIEW'
        UNION ALL SELECT 'CUTTING_PLANNER', 'MATERIAL.VIEW'
        UNION ALL SELECT 'CUTTING_PLANNER', 'INVENTORY.VIEW'
        UNION ALL SELECT 'CUTTING_SUPERVISOR', 'CUTTING.SUPERVISE'
        UNION ALL SELECT 'CUTTING_SUPERVISOR', 'CUTTING.PLAN'
        UNION ALL SELECT 'CUTTING_SUPERVISOR', 'CUTTING.EXECUTE'
        UNION ALL SELECT 'CUTTING_OPERATOR', 'CUTTING.EXECUTE'
        UNION ALL SELECT 'FABRIC_STORE', 'CUTTING.STORE') g ON g.role_code = r.role_code
  JOIN mst_permission p ON p.permission_code = g.perm
 WHERE NOT EXISTS (SELECT 1 FROM map_role_permission m WHERE m.role_id = r.id AND m.permission_id = p.id);
