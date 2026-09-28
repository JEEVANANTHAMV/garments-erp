-- =====================================================================
-- 74 · Checking QC entry, ironing / packing planning, yarn process DC
--   * bundle ledger: checking QC counters (pass / reject / rework)
--       rework goes back to the sewing line, reject leaves stock (doc §14)
--   * checking QC entry (same layout as Daily Output – Sewing)
--   * ironing & packing line master, line allocation and daily plan
--     (client call 28-Sep-2026: same bundle screens up to the FG store)
--   * number series for the new documents and the yarn process DC
-- Idempotent: the runner re-applies files >= 10 on every deploy.
-- =====================================================================

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_cutting_bundle' AND COLUMN_NAME='chk_pass_qty');
SET @s = IF(@x=0, 'ALTER TABLE trx_cutting_bundle ADD COLUMN chk_pass_qty INT UNSIGNED NOT NULL DEFAULT 0 COMMENT ''Checking QC passed PCS''', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_cutting_bundle' AND COLUMN_NAME='chk_reject_qty');
SET @s = IF(@x=0, 'ALTER TABLE trx_cutting_bundle ADD COLUMN chk_reject_qty INT UNSIGNED NOT NULL DEFAULT 0 COMMENT ''Checking QC rejected PCS''', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_cutting_bundle' AND COLUMN_NAME='chk_rework_qty');
SET @s = IF(@x=0, 'ALTER TABLE trx_cutting_bundle ADD COLUMN chk_rework_qty INT UNSIGNED NOT NULL DEFAULT 0 COMMENT ''Checking QC PCS sent back to sewing (cumulative)''', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- Checking QC entry (header + bundle rows), same shape as the sewing daily output
CREATE TABLE IF NOT EXISTS trx_checking_daily_output LIKE trx_sewing_daily_output;
CREATE TABLE IF NOT EXISTS trx_checking_daily_output_line LIKE trx_sewing_daily_output_line;

-- Ironing line master + line allocation + daily plan (same shape as checking)
CREATE TABLE IF NOT EXISTS cfg_ironing_line LIKE cfg_checking_line;
CREATE TABLE IF NOT EXISTS trx_ironing_line_allocation LIKE trx_checking_line_allocation;
CREATE TABLE IF NOT EXISTS trx_ironing_line_allocation_detail LIKE trx_checking_line_allocation_detail;
CREATE TABLE IF NOT EXISTS trx_ironing_daily_plan LIKE trx_checking_daily_plan;
CREATE TABLE IF NOT EXISTS trx_ironing_daily_plan_detail LIKE trx_checking_daily_plan_detail;
CREATE TABLE IF NOT EXISTS trx_ironing_daily_plan_line LIKE trx_checking_daily_plan_line;

-- Packing line master + line allocation + daily plan (same shape as checking)
CREATE TABLE IF NOT EXISTS cfg_packing_line LIKE cfg_checking_line;
CREATE TABLE IF NOT EXISTS trx_packing_line_allocation LIKE trx_checking_line_allocation;
CREATE TABLE IF NOT EXISTS trx_packing_line_allocation_detail LIKE trx_checking_line_allocation_detail;
CREATE TABLE IF NOT EXISTS trx_packing_daily_plan LIKE trx_checking_daily_plan;
CREATE TABLE IF NOT EXISTS trx_packing_daily_plan_detail LIKE trx_checking_daily_plan_detail;
CREATE TABLE IF NOT EXISTS trx_packing_daily_plan_line LIKE trx_checking_daily_plan_line;

-- Number series
INSERT INTO cfg_number_series (company_id, branch_id, doc_type, fy_id, prefix, next_number, padding)
SELECT c.id, NULL, d.doc_type, NULL, d.prefix, 1, 5
  FROM mst_company c
  CROSS JOIN (
    SELECT 'CHK_DAILY_OUT' AS doc_type, 'CQC-' AS prefix UNION ALL
    SELECT 'IRN_LINE_ALLOC', 'ILA-' UNION ALL
    SELECT 'PCK_LINE_ALLOC', 'PLA-' UNION ALL
    SELECT 'IRN_DAILY_PLAN', 'IDP-' UNION ALL
    SELECT 'PCK_DAILY_PLAN', 'PDP-' UNION ALL
    SELECT 'YARN_PROC_DC', 'YPDC-'
  ) d
 WHERE NOT EXISTS (SELECT 1 FROM cfg_number_series s WHERE s.company_id = c.id AND s.doc_type = d.doc_type);
