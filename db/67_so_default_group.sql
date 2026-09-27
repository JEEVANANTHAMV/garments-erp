-- =====================================================================
-- 67. DEFAULT MERCHANDISER GROUP FOR SO NUMBERS
-- ---------------------------------------------------------------------
-- SO numbers start with the merchandiser group (G11E26CAPE0570). The group
-- comes from the order, else the merchandiser, else this company default,
-- so an order is never blocked just because a group was not set up.
-- Editable in Settings. Idempotent: the migrate runner re-applies files.
-- =====================================================================
INSERT INTO cfg_system_setting (company_id, setting_key, setting_value, description, is_editable)
SELECT c.id, 'SO_DEFAULT_GROUP', 'G01',
       'Merchandiser group used in the SO number when neither the order nor the merchandiser has one (G + 2 digits)', 1
  FROM mst_company c
 WHERE NOT EXISTS (SELECT 1 FROM cfg_system_setting s WHERE s.company_id = c.id AND s.setting_key = 'SO_DEFAULT_GROUP');
