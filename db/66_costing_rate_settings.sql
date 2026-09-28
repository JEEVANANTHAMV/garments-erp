-- =====================================================================
-- 66. IN-HOUSE COSTING RATES (actual production costing)
-- ---------------------------------------------------------------------
-- The actual cost sheet is built only from transactions. In-house cutting,
-- sewing (PCS not on a stitching DC) and factory overhead have no document
-- carrying a rate, so they come from these company settings (₹ per PC).
-- Left blank, the head shows NO_DATA instead of an assumed figure.
-- Idempotent: the migrate runner re-applies files.
-- =====================================================================
INSERT INTO cfg_system_setting (company_id, setting_key, setting_value, description, is_editable)
SELECT c.id, v.k, '', v.d, 1
  FROM mst_company c
  JOIN (SELECT 'COSTING_CUTTING_RATE_PER_PC' k, 'Actual costing: in-house cutting cost, ₹ per cut PC (blank = not costed)' d
        UNION ALL SELECT 'COSTING_SEWING_RATE_PER_PC', 'Actual costing: in-house sewing cost, ₹ per sewn PC not on a stitching DC (blank = not costed)'
        UNION ALL SELECT 'COSTING_OVERHEAD_PER_PC', 'Actual costing: factory overhead, ₹ per good PC (blank = not allocated)') v
 WHERE NOT EXISTS (SELECT 1 FROM cfg_system_setting s WHERE s.company_id = c.id AND s.setting_key = v.k);
