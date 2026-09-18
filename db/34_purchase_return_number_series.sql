-- =============================================================================
-- Migration 34: PURCHASE_RETURN document number series
--
-- purchaseReturn.routes.ts calls nextDocNumber(..., 'PURCHASE_RETURN'). No such
-- series existed, so the on-demand fallback in numbering.ts created one that
-- always started at PR-00001 — which the seed data already uses. Every first
-- purchase return therefore failed with a duplicate key on uq_pr.
--
-- Creates the series per company and advances next_number past the highest
-- existing PR-xxxxx, so it is safe to re-run and safe on populated databases.
-- =============================================================================

INSERT INTO cfg_number_series (company_id, branch_id, doc_type, fy_id, prefix, suffix, next_number, padding)
SELECT c.id, NULL, 'PURCHASE_RETURN', NULL, 'PR-', '', 1, 5
  FROM mst_company c
 WHERE NOT EXISTS (
   SELECT 1 FROM cfg_number_series s
    WHERE s.company_id = c.id
      AND s.doc_type = 'PURCHASE_RETURN'
      AND s.branch_id IS NULL
      AND s.fy_id IS NULL
 );

-- Advance past any purchase return already present (seeded or real).
UPDATE cfg_number_series s
  JOIN (
    SELECT company_id,
           MAX(CAST(REGEXP_SUBSTR(return_no, '[0-9]+$') AS UNSIGNED)) AS max_seq
      FROM trx_purchase_return
     WHERE return_no REGEXP '^PR-[0-9]+$'
     GROUP BY company_id
  ) pr ON pr.company_id = s.company_id
   SET s.next_number = GREATEST(s.next_number, pr.max_seq + 1)
 WHERE s.doc_type = 'PURCHASE_RETURN'
   AND s.branch_id IS NULL
   AND s.fy_id IS NULL;
