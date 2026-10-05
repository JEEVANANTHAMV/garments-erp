-- 104: External job work / subcontracting engine (client document + voice note 05-Oct-2026), built on the bundle DC:
--   * Job Work Order with a process route (lines: process, input / output, planned qty, loss tolerance, rate, basis)
--   * DC lines and inwards carry process loss, unprocessed return and rework (rework PCS stay with the contractor)
--   * inward QC status (billing only from accepted inward), tolerance per process / order line
--   * fabric job work: fabric rolls out to a contractor (cutting + packing), garments in, fabric back
--   * process rate master (contractor + process + style + buyer + UOM, dated), contractor credit notes and payments
-- Re-runnable; every ALTER is guarded.

SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_challan_line');
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_challan_line' AND COLUMN_NAME='loss_qty');
SET @s = IF(@t=1 AND @x=0, 'ALTER TABLE trx_jobwork_challan_line ADD COLUMN loss_qty INT NOT NULL DEFAULT 0', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_challan_line');
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_challan_line' AND COLUMN_NAME='returned_qty');
SET @s = IF(@t=1 AND @x=0, 'ALTER TABLE trx_jobwork_challan_line ADD COLUMN returned_qty INT NOT NULL DEFAULT 0', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_challan_line');
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_challan_line' AND COLUMN_NAME='rework_qty');
SET @s = IF(@t=1 AND @x=0, 'ALTER TABLE trx_jobwork_challan_line ADD COLUMN rework_qty INT NOT NULL DEFAULT 0 COMMENT ''PCS sent back for rework (cumulative)''', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_challan_line');
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_challan_line' AND COLUMN_NAME='rework_open_qty');
SET @s = IF(@t=1 AND @x=0, 'ALTER TABLE trx_jobwork_challan_line ADD COLUMN rework_open_qty INT NOT NULL DEFAULT 0 COMMENT ''Rework PCS still to come back''', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_receipt_line');
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_receipt_line' AND COLUMN_NAME='loss_qty');
SET @s = IF(@t=1 AND @x=0, 'ALTER TABLE trx_jobwork_receipt_line ADD COLUMN loss_qty INT NOT NULL DEFAULT 0', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_receipt_line');
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_receipt_line' AND COLUMN_NAME='return_qty');
SET @s = IF(@t=1 AND @x=0, 'ALTER TABLE trx_jobwork_receipt_line ADD COLUMN return_qty INT NOT NULL DEFAULT 0', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_receipt_line');
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_receipt_line' AND COLUMN_NAME='rework_qty');
SET @s = IF(@t=1 AND @x=0, 'ALTER TABLE trx_jobwork_receipt_line ADD COLUMN rework_qty INT NOT NULL DEFAULT 0', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_receipt_line');
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_receipt_line' AND COLUMN_NAME='rework_reason');
SET @s = IF(@t=1 AND @x=0, 'ALTER TABLE trx_jobwork_receipt_line ADD COLUMN rework_reason VARCHAR(255) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_receipt_line');
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_receipt_line' AND COLUMN_NAME='rework_ref_line_id');
SET @s = IF(@t=1 AND @x=0, 'ALTER TABLE trx_jobwork_receipt_line ADD COLUMN rework_ref_line_id BIGINT UNSIGNED NULL COMMENT ''Receipt line that sent these PCS back for rework''', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_receipt_line');
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_receipt_line' AND COLUMN_NAME='rework_received_qty');
SET @s = IF(@t=1 AND @x=0, 'ALTER TABLE trx_jobwork_receipt_line ADD COLUMN rework_received_qty INT NOT NULL DEFAULT 0', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_receipt');
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_receipt' AND COLUMN_NAME='loss_qty');
SET @s = IF(@t=1 AND @x=0, 'ALTER TABLE trx_jobwork_receipt ADD COLUMN loss_qty INT NOT NULL DEFAULT 0', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_receipt');
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_receipt' AND COLUMN_NAME='return_qty');
SET @s = IF(@t=1 AND @x=0, 'ALTER TABLE trx_jobwork_receipt ADD COLUMN return_qty INT NOT NULL DEFAULT 0', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_receipt');
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_receipt' AND COLUMN_NAME='qc_status');
SET @s = IF(@t=1 AND @x=0, 'ALTER TABLE trx_jobwork_receipt ADD COLUMN qc_status VARCHAR(10) NOT NULL DEFAULT ''ACCEPTED'' COMMENT ''PENDING / ACCEPTED / REJECTED''', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_receipt');
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_receipt' AND COLUMN_NAME='qc_by');
SET @s = IF(@t=1 AND @x=0, 'ALTER TABLE trx_jobwork_receipt ADD COLUMN qc_by BIGINT UNSIGNED NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_receipt');
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_receipt' AND COLUMN_NAME='qc_at');
SET @s = IF(@t=1 AND @x=0, 'ALTER TABLE trx_jobwork_receipt ADD COLUMN qc_at DATETIME NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_receipt');
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_receipt' AND COLUMN_NAME='qc_remarks');
SET @s = IF(@t=1 AND @x=0, 'ALTER TABLE trx_jobwork_receipt ADD COLUMN qc_remarks VARCHAR(255) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_receipt');
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_receipt' AND COLUMN_NAME='billable');
SET @s = IF(@t=1 AND @x=0, 'ALTER TABLE trx_jobwork_receipt ADD COLUMN billable TINYINT(1) NOT NULL DEFAULT 1', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_challan');
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_challan' AND COLUMN_NAME='jw_order_id');
SET @s = IF(@t=1 AND @x=0, 'ALTER TABLE trx_jobwork_challan ADD COLUMN jw_order_id BIGINT UNSIGNED NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_challan');
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_challan' AND COLUMN_NAME='jw_order_line_id');
SET @s = IF(@t=1 AND @x=0, 'ALTER TABLE trx_jobwork_challan ADD COLUMN jw_order_line_id BIGINT UNSIGNED NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_challan');
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_challan' AND COLUMN_NAME='outward_override_reason');
SET @s = IF(@t=1 AND @x=0, 'ALTER TABLE trx_jobwork_challan ADD COLUMN outward_override_reason VARCHAR(255) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_challan');
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_challan' AND COLUMN_NAME='variance_reason');
SET @s = IF(@t=1 AND @x=0, 'ALTER TABLE trx_jobwork_challan ADD COLUMN variance_reason VARCHAR(255) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_challan');
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_challan' AND COLUMN_NAME='variance_approved_by');
SET @s = IF(@t=1 AND @x=0, 'ALTER TABLE trx_jobwork_challan ADD COLUMN variance_approved_by BIGINT UNSIGNED NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_challan');
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_challan' AND COLUMN_NAME='dc_kind');
SET @s = IF(@t=1 AND @x=0, 'ALTER TABLE trx_jobwork_challan ADD COLUMN dc_kind VARCHAR(10) NOT NULL DEFAULT ''BUNDLE'' COMMENT ''BUNDLE / FABRIC''', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='cfg_process_stage');
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='cfg_process_stage' AND COLUMN_NAME='loss_tolerance_pct');
SET @s = IF(@t=1 AND @x=0, 'ALTER TABLE cfg_process_stage ADD COLUMN loss_tolerance_pct DECIMAL(6,2) NULL COMMENT ''Allowed reject + shortage + loss % on a DC''', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

CREATE TABLE IF NOT EXISTS trx_jw_order (
  id                    BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id            BIGINT UNSIGNED NOT NULL,
  jw_no                 VARCHAR(40) NOT NULL,
  so_id                 BIGINT UNSIGNED NULL,
  io_no                 VARCHAR(60) NULL,
  buyer_po_no           VARCHAR(60) NULL,
  style_id              BIGINT UNSIGNED NULL,
  buyer_id              BIGINT UNSIGNED NULL,
  vendor_id             BIGINT UNSIGNED NOT NULL COMMENT 'Contractor',
  order_date            DATE NOT NULL,
  expected_return_date  DATE NULL,
  currency_id           SMALLINT UNSIGNED NULL,
  status                VARCHAR(16) NOT NULL DEFAULT 'DRAFT' COMMENT 'DRAFT / APPROVED / PARTIAL_OUTWARD / IN_PROCESS / PARTIAL_INWARD / COMPLETED / CLOSED / CANCELLED',
  remarks               VARCHAR(500) NULL,
  approved_by           BIGINT UNSIGNED NULL,
  approved_at           DATETIME NULL,
  closed_by             BIGINT UNSIGNED NULL,
  closed_at             DATETIME NULL,
  close_reason          VARCHAR(255) NULL,
  cancelled_by          BIGINT UNSIGNED NULL,
  cancelled_at          DATETIME NULL,
  cancel_reason         VARCHAR(255) NULL,
  created_by            BIGINT UNSIGNED NULL,
  created_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by            BIGINT UNSIGNED NULL,
  updated_at            DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_jw_no (company_id, jw_no),
  KEY ix_jw_vendor (company_id, vendor_id, status),
  KEY ix_jw_so (so_id)
) ENGINE=InnoDB COMMENT='Job Work Order: what a contractor does for a job, by process route';

CREATE TABLE IF NOT EXISTS trx_jw_order_line (
  id                   BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  order_id             BIGINT UNSIGNED NOT NULL,
  seq_no               INT NOT NULL DEFAULT 10,
  stage_id             BIGINT UNSIGNED NOT NULL COMMENT 'Process (cfg_process_stage)',
  input_kind           VARCHAR(10) NOT NULL DEFAULT 'BUNDLE' COMMENT 'BUNDLE / GARMENT / FABRIC / OTHER',
  input_desc           VARCHAR(160) NULL,
  input_uom            VARCHAR(10) NOT NULL DEFAULT 'PCS',
  output_kind          VARCHAR(10) NOT NULL DEFAULT 'GARMENT' COMMENT 'GARMENT / PACKED / PANEL / FABRIC / OTHER',
  output_desc          VARCHAR(160) NULL,
  output_uom           VARCHAR(10) NOT NULL DEFAULT 'PCS',
  planned_input_qty    DECIMAL(14,3) NOT NULL DEFAULT 0,
  expected_output_qty  DECIMAL(14,3) NOT NULL DEFAULT 0,
  loss_tolerance_pct   DECIMAL(6,2) NULL,
  rate                 DECIMAL(12,4) NULL,
  rate_basis           VARCHAR(10) NOT NULL DEFAULT 'PCS' COMMENT 'PCS / KG / M / BUNDLE / CARTON',
  status               VARCHAR(12) NOT NULL DEFAULT 'OPEN',
  remarks              VARCHAR(255) NULL,
  KEY ix_jwl_order (order_id)
) ENGINE=InnoDB COMMENT='Process route of a job work order';

CREATE TABLE IF NOT EXISTS trx_jw_fabric_issue (
  id               BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id       BIGINT UNSIGNED NOT NULL,
  challan_id       BIGINT UNSIGNED NOT NULL COMMENT 'Fabric DC (trx_jobwork_challan, dc_kind FABRIC)',
  jw_order_line_id BIGINT UNSIGNED NULL,
  fabric_roll_id   BIGINT UNSIGNED NOT NULL,
  roll_no          VARCHAR(60) NOT NULL,
  lot_no           VARCHAR(60) NULL,
  issue_kg         DECIMAL(12,4) NOT NULL,
  issue_m          DECIMAL(12,3) NULL,
  consumed_kg      DECIMAL(12,4) NOT NULL DEFAULT 0,
  returned_kg      DECIMAL(12,4) NOT NULL DEFAULT 0,
  waste_kg         DECIMAL(12,4) NOT NULL DEFAULT 0,
  created_by       BIGINT UNSIGNED NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_jfi_dc (challan_id),
  KEY ix_jfi_roll (fabric_roll_id)
) ENGINE=InnoDB COMMENT='Fabric rolls sent to a contractor on a fabric job work DC';

CREATE TABLE IF NOT EXISTS trx_jw_fabric_inward (
  id               BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id       BIGINT UNSIGNED NOT NULL,
  inward_no        VARCHAR(40) NOT NULL,
  inward_date      DATE NOT NULL,
  challan_id       BIGINT UNSIGNED NOT NULL,
  receipt_id       BIGINT UNSIGNED NULL COMMENT 'The garment receipt (trx_jobwork_receipt) — billing',
  fg_receipt_id    BIGINT UNSIGNED NULL,
  good_qty         INT NOT NULL DEFAULT 0,
  reject_qty       INT NOT NULL DEFAULT 0,
  consumed_kg      DECIMAL(12,4) NOT NULL DEFAULT 0,
  returned_kg      DECIMAL(12,4) NOT NULL DEFAULT 0,
  waste_kg         DECIMAL(12,4) NOT NULL DEFAULT 0,
  remarks          VARCHAR(500) NULL,
  created_by       BIGINT UNSIGNED NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_jfin_dc (challan_id)
) ENGINE=InnoDB COMMENT='Garments in + fabric back on a fabric job work DC';

CREATE TABLE IF NOT EXISTS mst_jw_rate (
  id             BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id     BIGINT UNSIGNED NOT NULL,
  vendor_id      BIGINT UNSIGNED NOT NULL,
  stage_id       BIGINT UNSIGNED NOT NULL,
  style_id       BIGINT UNSIGNED NULL,
  buyer_id       BIGINT UNSIGNED NULL,
  uom            VARCHAR(10) NOT NULL DEFAULT 'PCS',
  rate           DECIMAL(12,4) NOT NULL,
  effective_from DATE NULL,
  effective_to   DATE NULL,
  is_active      TINYINT(1) NOT NULL DEFAULT 1,
  remarks        VARCHAR(255) NULL,
  created_by     BIGINT UNSIGNED NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_jwr (company_id, vendor_id, stage_id, is_active)
) ENGINE=InnoDB COMMENT='Process rate: contractor + process (+ style / buyer) + UOM, dated (doc §17)';

CREATE TABLE IF NOT EXISTS trx_contractor_credit_note (
  id          BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id  BIGINT UNSIGNED NOT NULL,
  cn_no       VARCHAR(40) NOT NULL,
  cn_date     DATE NOT NULL,
  vendor_id   BIGINT UNSIGNED NOT NULL,
  jw_order_id BIGINT UNSIGNED NULL,
  io_no       VARCHAR(60) NULL,
  reason      VARCHAR(255) NOT NULL,
  amount      DECIMAL(14,2) NOT NULL,
  tax         DECIMAL(14,2) NOT NULL DEFAULT 0,
  status      VARCHAR(10) NOT NULL DEFAULT 'OPEN' COMMENT 'OPEN / CANCELLED',
  created_by  BIGINT UNSIGNED NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  cancelled_by BIGINT UNSIGNED NULL,
  cancel_reason VARCHAR(255) NULL,
  UNIQUE KEY uq_ccn (company_id, cn_no),
  KEY ix_ccn_vendor (company_id, vendor_id)
) ENGINE=InnoDB COMMENT='Credit to a contractor (approved additional work / adjustment)';

CREATE TABLE IF NOT EXISTS trx_contractor_payment (
  id          BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id  BIGINT UNSIGNED NOT NULL,
  payment_no  VARCHAR(40) NOT NULL,
  payment_date DATE NOT NULL,
  vendor_id   BIGINT UNSIGNED NOT NULL,
  bill_id     BIGINT UNSIGNED NULL,
  amount      DECIMAL(14,2) NOT NULL,
  mode        VARCHAR(20) NULL COMMENT 'BANK / CASH / UPI / CHEQUE',
  reference_no VARCHAR(60) NULL,
  remarks     VARCHAR(255) NULL,
  status      VARCHAR(10) NOT NULL DEFAULT 'POSTED' COMMENT 'POSTED / CANCELLED',
  created_by  BIGINT UNSIGNED NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  cancelled_by BIGINT UNSIGNED NULL,
  cancel_reason VARCHAR(255) NULL,
  UNIQUE KEY uq_cpay (company_id, payment_no),
  KEY ix_cpay_vendor (company_id, vendor_id)
) ENGINE=InnoDB COMMENT='Payments to contractors (for the contractor statement)';

INSERT IGNORE INTO cfg_system_setting (company_id, setting_key, setting_value, description)
SELECT id, 'JW_LOSS_TOLERANCE_PCT', '2', 'Job work: reject + shortage + loss above this % of a DC needs a manager to approve the variance' FROM mst_company;
INSERT IGNORE INTO cfg_system_setting (company_id, setting_key, setting_value, description)
SELECT id, 'JW_INWARD_QC_REQUIRED', '0', 'Job work: 1 = an inward waits for QC acceptance before it can be billed; 0 = accepted when posted' FROM mst_company;

INSERT INTO cfg_number_series (company_id, branch_id, doc_type, fy_id, prefix, next_number, padding)
SELECT c.id, NULL, t.doc_type, NULL, t.prefix, 1, 5
  FROM mst_company c
  JOIN (SELECT 'JW_ORDER' AS doc_type, 'JWO-' AS prefix UNION ALL SELECT 'JW_FAB_INWARD', 'JFI-' UNION ALL SELECT 'CONTR_CN', 'CCN-' UNION ALL SELECT 'CONTR_PAY', 'CPY-') t
 WHERE NOT EXISTS (SELECT 1 FROM cfg_number_series ns WHERE ns.company_id = c.id AND ns.doc_type = t.doc_type AND ns.branch_id IS NULL AND ns.fy_id IS NULL);

INSERT INTO mst_permission (module_id, permission_code, permission_name)
SELECT m.id, p.code, p.name FROM mst_module m
  JOIN (SELECT 'JOBWORK.PLAN' AS code, 'Plan / create job work orders' AS name UNION ALL
        SELECT 'JOBWORK.APPROVE', 'Approve job work orders, variance and close' UNION ALL
        SELECT 'JOBWORK.QC', 'QC of job work inwards' UNION ALL
        SELECT 'JOBWORK.ACCOUNTS', 'Contractor credit notes, payments and statement') p
 WHERE m.module_code = 'PRODUCTION' AND NOT EXISTS (SELECT 1 FROM mst_permission x WHERE x.permission_code = p.code);
