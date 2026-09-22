-- =====================================================================
-- 44. FIX: Knitting Program number series
-- ---------------------------------------------------------------------
-- Migration 43 seeded cfg_number_series without company_id (a NOT NULL
-- column with an FK), so that statement failed and the KNP / KNP_YI
-- series were never created. Programs therefore fell back to the
-- auto-generated prefixes "K-" / "KY-" instead of the intended numbers.
-- This migration seeds the series for every company, idempotently.
-- =====================================================================

INSERT INTO cfg_number_series (company_id, branch_id, doc_type, fy_id, prefix, next_number, padding)
SELECT c.id, NULL, 'KNP', NULL, 'KNP-', 1, 5
FROM mst_company c
WHERE NOT EXISTS (
  SELECT 1 FROM cfg_number_series s WHERE s.company_id = c.id AND s.doc_type = 'KNP'
);

INSERT INTO cfg_number_series (company_id, branch_id, doc_type, fy_id, prefix, next_number, padding)
SELECT c.id, NULL, 'KNP_YI', NULL, 'KNPYI-', 1, 5
FROM mst_company c
WHERE NOT EXISTS (
  SELECT 1 FROM cfg_number_series s WHERE s.company_id = c.id AND s.doc_type = 'KNP_YI'
);
