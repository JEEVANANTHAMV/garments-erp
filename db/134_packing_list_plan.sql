-- =====================================================================
-- 134 · Packing list as the plan (client call 16-Oct-2026)
--   "The buyer gives the packing list — carton-wise, with the ratio; for a few buyers we make it
--    (assorted). Some buyers give a separate list per country / selling point. Shortage: either we
--    make it and send it later, or the buyer debits it."
--
--   trx_packing_list.list_mode     DOCUMENT (built from packed cartons, as before) / PLAN (the buyer's list
--                                  entered first; cartons are packed against its carton numbers)
--   status += PLANNED              plan released to the packing floor (rows frozen)
--   plan_json                      the released plan: blocks / rows + per carton number the colour × size
--                                  quantities (size ids resolved) — kept after the list becomes the document
--   short_action / short_reason    on finish: shortage TO_FOLLOW (a follow-up plan list is made) or DEBIT
--   follow_of_id                   the follow-up plan list points at the list it completes
--   trx_carton.pl_plan_id / pl_ctn_no   the plan list + carton number a carton was packed for
-- Idempotent: the runner re-applies files >= 10 on every deploy.
-- =====================================================================

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_packing_list' AND COLUMN_NAME='list_mode');
SET @s = IF(@x=0, 'ALTER TABLE trx_packing_list
  ADD COLUMN list_mode ENUM(''DOCUMENT'',''PLAN'') NOT NULL DEFAULT ''DOCUMENT'' COMMENT ''PLAN = buyer packing list entered first, cartons packed against it'',
  ADD COLUMN plan_json JSON NULL COMMENT ''Released plan: rows + per carton no colour x size qty'',
  ADD COLUMN plan_released_at DATETIME NULL,
  ADD COLUMN plan_released_by BIGINT UNSIGNED NULL,
  ADD COLUMN plan_finished_at DATETIME NULL,
  ADD COLUMN plan_finished_by BIGINT UNSIGNED NULL,
  ADD COLUMN short_qty INT NOT NULL DEFAULT 0 COMMENT ''Planned pcs not packed when the plan was finished'',
  ADD COLUMN short_action ENUM(''NONE'',''TO_FOLLOW'',''DEBIT'') NULL COMMENT ''Shortage: sent later on a follow-up list, or debited by the buyer'',
  ADD COLUMN short_reason VARCHAR(255) NULL,
  ADD COLUMN follow_of_id BIGINT UNSIGNED NULL COMMENT ''Follow-up plan: the list whose shortage it ships''', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_packing_list' AND COLUMN_NAME='status' AND COLUMN_TYPE LIKE '%PLANNED%');
SET @s = IF(@x=0, 'ALTER TABLE trx_packing_list MODIFY COLUMN status ENUM(''DRAFT'',''PLANNED'',''CONFIRMED'',''CLOSED'') DEFAULT ''DRAFT''', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_carton' AND COLUMN_NAME='pl_plan_id');
SET @s = IF(@x=0, 'ALTER TABLE trx_carton
  ADD COLUMN pl_plan_id BIGINT UNSIGNED NULL COMMENT ''Packing list (plan) this carton was packed for'',
  ADD COLUMN pl_ctn_no INT NULL COMMENT ''Carton number on that packing list'',
  ADD KEY ix_carton_plan (pl_plan_id, pl_ctn_no)', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
