-- 97: purchase excess limit per job (client voice note 03-Oct-2026).
--   A job's POs (yarn / fabric / trims) may exceed the BOM requirement only by an allowed excess — e.g. a bag
--   round-off on yarn. Allowed = requirement × (1 + excess %) + excess qty. Company defaults per material type
--   (Admin › Settings, or the Purchase Excess Limits screen); a job can carry its own allowance.
--   PURCHASE_EXCESS_CONTROL: BLOCK (refuse the PO) / WARN (save, show the warning) / OFF.
-- Re-runnable.
CREATE TABLE IF NOT EXISTS trx_job_purchase_allowance (
  id             BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id     BIGINT UNSIGNED NOT NULL,
  so_id          BIGINT UNSIGNED NOT NULL,
  material_type  VARCHAR(10) NOT NULL COMMENT 'YARN / FABRIC / TRIM',
  excess_pct     DECIMAL(8,3) NOT NULL DEFAULT 0,
  excess_qty     DECIMAL(14,3) NOT NULL DEFAULT 0 COMMENT 'In the material''s BOM UOM (e.g. KG for yarn)',
  remarks        VARCHAR(255) NULL,
  updated_by     BIGINT UNSIGNED NULL,
  updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_jpa (company_id, so_id, material_type)
) ENGINE=InnoDB COMMENT='Job-wise purchase excess allowance over the BOM requirement';

INSERT IGNORE INTO cfg_system_setting (company_id, setting_key, setting_value, description)
SELECT c.id, k.k, k.v, k.d FROM mst_company c
  JOIN (SELECT 'PURCHASE_EXCESS_CONTROL' k, 'BLOCK' v, 'Job POs above the BOM requirement + allowed excess: BLOCK (refuse) / WARN (save with a warning) / OFF' d
        UNION ALL SELECT 'PURCHASE_EXCESS_YARN_PCT', '5', 'Yarn: % a job may buy above its BOM requirement (default; a job can have its own)'
        UNION ALL SELECT 'PURCHASE_EXCESS_YARN_QTY', '0', 'Yarn: extra KG a job may buy above requirement + % (e.g. bag round-off)'
        UNION ALL SELECT 'PURCHASE_EXCESS_FABRIC_PCT', '5', 'Fabric: % a job may buy above its BOM requirement'
        UNION ALL SELECT 'PURCHASE_EXCESS_FABRIC_QTY', '0', 'Fabric: extra qty a job may buy above requirement + %'
        UNION ALL SELECT 'PURCHASE_EXCESS_TRIM_PCT', '5', 'Trims / accessories / packing: % a job may buy above its BOM requirement'
        UNION ALL SELECT 'PURCHASE_EXCESS_TRIM_QTY', '0', 'Trims / accessories / packing: extra qty above requirement + %') k;
