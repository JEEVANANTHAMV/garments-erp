-- =====================================================================
-- 57. NUMBER SERIES DE-DUPLICATION
-- ---------------------------------------------------------------------
-- cfg_number_series has UNIQUE (company_id, branch_id, doc_type, fy_id),
-- but company-wide series store branch_id / fy_id as NULL and NULLs never
-- collide in a UNIQUE key. The seed's ON DUPLICATE KEY insert therefore
-- added a fresh copy of every series on each deploy (88 copies on prod).
-- Keep the oldest row of each series, carry the highest counter onto it
-- and drop the copies. The seed and nextDocNumber() are fixed alongside.
-- Idempotent: once de-duplicated both statements affect no rows.
-- =====================================================================

UPDATE cfg_number_series keep
  JOIN (SELECT company_id, doc_type, MIN(id) AS keep_id, MAX(next_number) AS max_next
          FROM cfg_number_series
         WHERE branch_id IS NULL AND fy_id IS NULL
         GROUP BY company_id, doc_type
        HAVING COUNT(*) > 1) d ON d.keep_id = keep.id
   SET keep.next_number = GREATEST(keep.next_number, d.max_next);

DELETE dup FROM cfg_number_series dup
  JOIN (SELECT company_id, doc_type, MIN(id) AS keep_id
          FROM cfg_number_series
         WHERE branch_id IS NULL AND fy_id IS NULL
         GROUP BY company_id, doc_type
        HAVING COUNT(*) > 1) d
    ON d.company_id = dup.company_id AND d.doc_type = dup.doc_type AND dup.id <> d.keep_id
 WHERE dup.branch_id IS NULL AND dup.fy_id IS NULL;
