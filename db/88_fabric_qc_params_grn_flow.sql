-- =====================================================================
-- 88: Fabric process GRN status flow + QC parameters, processed-yarn lots,
--     job-wise stock ledger (developer document §11, §16, §22; voice note 2)
--   • mst_fabric_process_qc_param — QC parameters per process type (min / max / target);
--     process types can require QC before a GRN is posted.
--   • trx_fabric_process_inward: Draft → QC Pending → Accepted / Partial / Rejected → Posted
--     (draft lines kept in draft_json; stock moves only on Post).
--   • trx_fabric_process_qc — QC results per output roll and parameter.
--   • trx_stock_ledger.so_id — job of the movement (job transfers post TRANSFER_OUT / IN).
--   • GRNs that carry the old fake IO 'IR-2026-0001' (no such job) lose it.
--   Idempotent.
-- =====================================================================

CREATE TABLE IF NOT EXISTS mst_fabric_process_qc_param (
  id            INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id    BIGINT UNSIGNED NOT NULL,
  process_code  VARCHAR(40) NOT NULL,
  param_name    VARCHAR(80) NOT NULL,
  uom           VARCHAR(20) NULL,
  min_value     DECIMAL(14,3) NULL,
  max_value     DECIMAL(14,3) NULL,
  target_value  DECIMAL(14,3) NULL,
  is_mandatory  TINYINT(1) NOT NULL DEFAULT 1,
  sort_order    INT NOT NULL DEFAULT 0,
  is_active     TINYINT(1) NOT NULL DEFAULT 1,
  UNIQUE KEY uq_fpqp (company_id, process_code, param_name)
) ENGINE=InnoDB COMMENT='QC parameters of a fabric process type';

-- sensible defaults for dyeing / compacting (editable on the Process Types master)
INSERT IGNORE INTO mst_fabric_process_qc_param (company_id, process_code, param_name, uom, min_value, max_value, target_value, is_mandatory, sort_order)
SELECT c.id, p.pc, p.pn, p.u, p.mn, p.mx, p.tg, p.md, p.so FROM mst_company c
JOIN (SELECT 'DYEING' pc, 'Shrinkage length' pn, '%' u, -5 mn, 5 mx, 0 tg, 1 md, 10 so UNION ALL
      SELECT 'DYEING', 'Shrinkage width', '%', -5, 5, 0, 1, 20 UNION ALL
      SELECT 'DYEING', 'Shade match (DE)', 'ΔE', 0, 1, 0, 1, 30 UNION ALL
      SELECT 'DYEING', 'GSM variation', '%', -5, 5, 0, 0, 40 UNION ALL
      SELECT 'COMPACTING', 'Shrinkage length', '%', -3, 3, 0, 1, 10 UNION ALL
      SELECT 'COMPACTING', 'Shrinkage width', '%', -3, 3, 0, 1, 20) p;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='mst_fabric_process_type' AND COLUMN_NAME='requires_qc');
SET @s = IF(@x=0, 'ALTER TABLE mst_fabric_process_type ADD COLUMN requires_qc TINYINT(1) NOT NULL DEFAULT 0 COMMENT ''GRN must pass QC before it is posted''', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_fabric_process_inward' AND COLUMN_NAME='draft_json');
SET @s = IF(@x=0, 'ALTER TABLE trx_fabric_process_inward ADD COLUMN draft_json JSON NULL COMMENT ''Lines (and QC) until the GRN is posted'', ADD COLUMN qc_by BIGINT UNSIGNED NULL, ADD COLUMN qc_at DATETIME NULL, ADD COLUMN qc_remarks VARCHAR(255) NULL, ADD COLUMN posted_by BIGINT UNSIGNED NULL, ADD COLUMN posted_at DATETIME NULL, MODIFY COLUMN grn_id BIGINT UNSIGNED NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

CREATE TABLE IF NOT EXISTS trx_fabric_process_qc (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  inward_id       BIGINT UNSIGNED NOT NULL,
  line_index      INT NOT NULL COMMENT 'Line of the GRN draft',
  output_roll_no  VARCHAR(60) NULL,
  param_id        INT UNSIGNED NULL,
  param_name      VARCHAR(80) NOT NULL,
  value           DECIMAL(14,3) NULL,
  min_value       DECIMAL(14,3) NULL,
  max_value       DECIMAL(14,3) NULL,
  result          VARCHAR(10) NOT NULL COMMENT 'PASS / FAIL / NA',
  created_by      BIGINT UNSIGNED NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_fpqc_inward (inward_id)
) ENGINE=InnoDB COMMENT='Fabric process GRN QC results';

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_stock_ledger' AND COLUMN_NAME='so_id');
SET @s = IF(@x=0, 'ALTER TABLE trx_stock_ledger ADD COLUMN so_id BIGINT UNSIGNED NULL COMMENT ''Job of the movement (job-wise stock)'', ADD KEY ix_ledger_so (so_id)', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- the old default IO 'IR-2026-0001' was never a real job
UPDATE trx_grn g SET g.internal_ir_no = NULL
 WHERE g.internal_ir_no = 'IR-2026-0001'
   AND NOT EXISTS (SELECT 1 FROM trx_sales_order so WHERE so.company_id = g.company_id AND (so.io_no = 'IR-2026-0001' OR so.so_no = 'IR-2026-0001'));
UPDATE trx_purchase_order po SET po.internal_ir_no = NULL
 WHERE po.internal_ir_no = 'IR-2026-0001'
   AND NOT EXISTS (SELECT 1 FROM trx_sales_order so WHERE so.company_id = po.company_id AND (so.io_no = 'IR-2026-0001' OR so.so_no = 'IR-2026-0001'));
