-- =====================================================================
-- 75 · Strict checking before ironing (developer doc §14)
--   1 = only checking-QC passed PCS can go to ironing / finishing
--       (Process DC to an ironing / finishing stage, sewing-floor finishing
--        input, ironing line allocation)
--   0 = any sewn good PCS can go (e.g. garments washed / ironed outside
--       before the final internal checking)
-- Editable per company under Admin › Settings. Idempotent.
-- =====================================================================
INSERT IGNORE INTO cfg_system_setting (company_id, setting_key, setting_value, description)
SELECT id, 'STRICT_CHECKING_BEFORE_IRONING', '1',
       '1 = only checking QC passed PCS go to ironing / finishing; 0 = any sewn good PCS (outside washing / ironing before checking)'
  FROM mst_company;
