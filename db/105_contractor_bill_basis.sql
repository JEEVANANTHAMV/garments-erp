-- 105: Contractor bill basis (client voice note 06-Oct-2026): pay on the DC qty sent (ISSUED), on good PCS received (GOOD)
--      or on good + mistake PCS (GOOD_MISTAKE) — for outside job work and in-house subcontractors alike.
--      Default: job work order line → contractor → process (bill_include_mistake); fixed on the DC; changeable at bill passing.
-- Re-runnable; every ALTER is guarded.

SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='mst_party');
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='mst_party' AND COLUMN_NAME='jw_bill_basis');
SET @s = IF(@t=1 AND @x=0, 'ALTER TABLE mst_party ADD COLUMN jw_bill_basis VARCHAR(12) NULL COMMENT ''Contractor bill default: ISSUED (DC qty) / GOOD (received good) / GOOD_MISTAKE (good + mistake)''', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jw_order_line');
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jw_order_line' AND COLUMN_NAME='bill_basis');
SET @s = IF(@t=1 AND @x=0, 'ALTER TABLE trx_jw_order_line ADD COLUMN bill_basis VARCHAR(12) NULL COMMENT ''Bill basis for DCs of this line (else the contractor default)''', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_challan');
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_challan' AND COLUMN_NAME='bill_basis');
SET @s = IF(@t=1 AND @x=0, 'ALTER TABLE trx_jobwork_challan ADD COLUMN bill_basis VARCHAR(12) NULL COMMENT ''Bill basis fixed on the DC: ISSUED / GOOD / GOOD_MISTAKE (NULL = process setting)''', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_contractor_bill');
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_contractor_bill' AND COLUMN_NAME='bill_basis');
SET @s = IF(@t=1 AND @x=0, 'ALTER TABLE trx_contractor_bill ADD COLUMN bill_basis VARCHAR(12) NULL COMMENT ''Bill-level basis chosen at bill passing (NULL = as on each DC)''', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_contractor_bill_line');
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_contractor_bill_line' AND COLUMN_NAME='bill_basis');
SET @s = IF(@t=1 AND @x=0, 'ALTER TABLE trx_contractor_bill_line ADD COLUMN bill_basis VARCHAR(12) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_contractor_bill_line');
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_contractor_bill_line' AND COLUMN_NAME='short_loss_qty');
SET @s = IF(@t=1 AND @x=0, 'ALTER TABLE trx_contractor_bill_line ADD COLUMN short_loss_qty INT NOT NULL DEFAULT 0 COMMENT ''Shortage + loss PCS on the inward (paid only on the ISSUED basis)''', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- an inward is billable when it accounts for processed PCS (good, mistake, shortage or loss) — the basis decides what is paid
UPDATE trx_jobwork_receipt SET billable = 1 WHERE contractor_bill_id IS NULL AND billable = 0 AND received_qty + rejected_qty + shortage_qty + loss_qty > 0;
