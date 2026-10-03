-- 101: a cancelled draft fabric process DC no longer holds its rolls (they showed as "on a draft DC").
-- Re-runnable.
UPDATE trx_fabric_process_roll_in ri
  JOIN trx_fabric_process_order o ON o.id = ri.fpo_id
   SET ri.status = 'CANCELLED'
 WHERE o.status = 'CANCELLED' AND ri.status = 'DRAFT';
