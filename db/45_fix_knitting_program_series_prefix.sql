-- =====================================================================
-- 45. FIX: correct the KNP / KNP_YI number-series prefixes
-- ---------------------------------------------------------------------
-- Because migration 43's seed failed (missing company_id), the first
-- Knitting Program created its series row on demand via nextDocNumber(),
-- which derives a prefix from the doc_type initials -> "K-" / "KY-".
-- Migration 44 then skipped those rows (WHERE NOT EXISTS), so the
-- intended prefixes were never applied. "K-" also collides with the KWO
-- series, so programs and work orders share a number space.
--
-- Repoint the prefixes only for the auto-generated values, leaving any
-- deliberately customised prefix untouched.
-- =====================================================================

UPDATE cfg_number_series
   SET prefix = 'KNP-'
 WHERE doc_type = 'KNP' AND prefix = 'K-';

UPDATE cfg_number_series
   SET prefix = 'KNPYI-'
 WHERE doc_type = 'KNP_YI' AND prefix = 'KY-';
