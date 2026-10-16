-- =====================================================================
-- 130 · Merchandiser pre-costing currency + revisions, production costing SMV + overhead
-- (client audio 16-Oct-2026 + "Merchandiser & Production Costing" / "Pre-Costing, Production
--  Actual Costing & Variance" developer documents)
--
--   trx_costing          exchange_rate (₹ per 1 unit of the quote currency), fx_rate_date,
--                        fob_price_fc (quoted FOB in the quote currency; fob_price stays ₹),
--                        revised_from_id (revision chain), approved_by / approved_at
--   trx_job_op_rate      smv per operation (production enters SMV; rate = SMV × ₹ / min)
--   trx_job_rate_card    cost_per_min, production overhead (₹ / PC or % of conversion)
--   trx_job_rate_card_rev  overhead and ₹ / min at each lock (rates in force during a revision)
-- Idempotent: the runner re-applies files >= 10 on every deploy.
-- =====================================================================

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_costing' AND COLUMN_NAME='exchange_rate');
SET @s = IF(@x=0, 'ALTER TABLE trx_costing
  ADD COLUMN exchange_rate DECIMAL(18,6) NULL COMMENT ''₹ per 1 unit of the quote currency (rates on the sheet are ₹)'',
  ADD COLUMN fx_rate_date DATE NULL,
  ADD COLUMN fob_price_fc DECIMAL(18,4) NULL COMMENT ''Quoted FOB / PC in the quote currency (fob_price is ₹)'',
  ADD COLUMN revised_from_id BIGINT UNSIGNED NULL COMMENT ''Revision this one was created from'',
  ADD COLUMN approved_by BIGINT UNSIGNED NULL,
  ADD COLUMN approved_at DATETIME NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_job_op_rate' AND COLUMN_NAME='smv');
SET @s = IF(@x=0, 'ALTER TABLE trx_job_op_rate ADD COLUMN smv DECIMAL(10,4) NULL COMMENT ''Standard minutes; rate = smv × card cost_per_min'' AFTER rate', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_job_rate_card' AND COLUMN_NAME='cost_per_min');
SET @s = IF(@x=0, 'ALTER TABLE trx_job_rate_card
  ADD COLUMN cost_per_min DECIMAL(10,4) NULL COMMENT ''₹ per standard minute for SMV operations'',
  ADD COLUMN overhead_basis ENUM(''PER_PC'',''PCT'') NULL COMMENT ''Production overhead: ₹ / PC or % of the card conversion rate'',
  ADD COLUMN overhead_value DECIMAL(12,4) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_job_rate_card_rev' AND COLUMN_NAME='overhead_pc');
SET @s = IF(@x=0, 'ALTER TABLE trx_job_rate_card_rev
  ADD COLUMN overhead_pc DECIMAL(12,4) NULL COMMENT ''Production overhead ₹ / PC in force at this step'',
  ADD COLUMN cost_per_min DECIMAL(10,4) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- approval stamp of costings approved before this release (status APPROVED, no stamp yet)
UPDATE trx_costing c JOIN cfg_status s ON s.id = c.status_id
   SET c.approved_at = COALESCE(c.updated_at, c.created_at), c.approved_by = c.created_by
 WHERE s.code = 'APPROVED' AND c.approved_at IS NULL;
