-- =====================================================================
-- 89: Yarn Process engine (Garment_ERP_Yarn_Process_Developer_Document)
--   One configurable engine for yarn dyeing / winding / twisting (+ re-dye / re-wind / re-twist):
--   • mst_yarn_process_type — process mode (cone→cone, one→many, many→one), ply, loss tolerance,
--     QC requirement, billing capability.
--   • Outward DC (multi job / lot / cone; draft → confirm issues the yarn lots),
--     Inward GRN (input cones → output cones with good / reject / loss; Draft → QC → Posted;
--     good output becomes a yarn GRN lot, reject goes to the reject store as a rejected lot),
--     Return, Reprocess (billable / non-billable + cost treatment), Contractor bill,
--     cone history (trx_yarn_cone_history).
--   Stock stays on yarn GRN lots (trx_grn_line); every lot that leaves is a trx_process_issue
--   line against its grn_line_id (src_type YARN_PROC_DC / YARN_LOT_MOVE).
--   Reasons and QC parameters are shared with the fabric process masters.
--   Idempotent.
-- =====================================================================

-- trx_process_issue.src_type: ENUM → VARCHAR so the engine can add its own sources
SET @x = (SELECT DATA_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_process_issue' AND COLUMN_NAME='src_type');
SET @s = IF(@x='enum', 'ALTER TABLE trx_process_issue MODIFY COLUMN src_type VARCHAR(30) NOT NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- yarn GRN lines: cone no + the lot it was made from + the process DC
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_grn_line' AND COLUMN_NAME='cone_no');
SET @s = IF(@x=0, 'ALTER TABLE trx_grn_line ADD COLUMN cone_no VARCHAR(60) NULL COMMENT ''Output cone (yarn process)'', ADD COLUMN parent_grn_line_id BIGINT UNSIGNED NULL COMMENT ''Lot this lot was made / split from'', ADD COLUMN source_ypo_id BIGINT UNSIGNED NULL COMMENT ''Yarn process DC that made it'', ADD KEY ix_gl_parent (parent_grn_line_id)', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

CREATE TABLE IF NOT EXISTS mst_yarn_process_type (
  id                 INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id         BIGINT UNSIGNED NOT NULL,
  code               VARCHAR(40) NOT NULL,
  name               VARCHAR(80) NOT NULL,
  base_process       VARCHAR(20) NOT NULL COMMENT 'YARN_DYEING / WINDING / TWISTING',
  process_mode       VARCHAR(20) NOT NULL DEFAULT 'CONE_TO_CONE' COMMENT 'CONE_TO_CONE / ONE_TO_MANY / MANY_TO_ONE',
  changes_shade      TINYINT(1) NOT NULL DEFAULT 0,
  default_ply        TINYINT UNSIGNED NULL,
  ply_options        VARCHAR(40) NULL COMMENT 'e.g. 2,3,4',
  loss_tolerance_pct DECIMAL(6,2) NOT NULL DEFAULT 0 COMMENT '0 = no check',
  requires_qc        TINYINT(1) NOT NULL DEFAULT 0,
  allow_reprocess    TINYINT(1) NOT NULL DEFAULT 1,
  is_reprocess       TINYINT(1) NOT NULL DEFAULT 0,
  billable           TINYINT(1) NOT NULL DEFAULT 1,
  sort_order         INT NOT NULL DEFAULT 0,
  is_active          TINYINT(1) NOT NULL DEFAULT 1,
  UNIQUE KEY uq_ypt (company_id, code)
) ENGINE=InnoDB COMMENT='Yarn process types (configurable engine)';

INSERT IGNORE INTO mst_yarn_process_type (company_id, code, name, base_process, process_mode, changes_shade, default_ply, ply_options, loss_tolerance_pct, is_reprocess, sort_order)
SELECT c.id, t.code, t.name, t.bp, t.pm, t.cs, t.ply, t.plo, t.tol, t.rp, t.so FROM mst_company c
JOIN (SELECT 'YARN_DYEING' code, 'Yarn Dyeing' name, 'YARN_DYEING' bp, 'CONE_TO_CONE' pm, 1 cs, NULL ply, NULL plo, 6.00 tol, 0 rp, 10 so UNION ALL
      SELECT 'WINDING', 'Winding', 'WINDING', 'ONE_TO_MANY', 0, NULL, NULL, 2.00, 0, 20 UNION ALL
      SELECT 'TWISTING', 'Twisting', 'TWISTING', 'MANY_TO_ONE', 0, 2, '2,3,4', 3.00, 0, 30 UNION ALL
      SELECT 'RE_YARN_DYEING', 'Re-Dyeing (yarn)', 'YARN_DYEING', 'CONE_TO_CONE', 1, NULL, NULL, 6.00, 1, 40 UNION ALL
      SELECT 'RE_WINDING', 'Re-Winding', 'WINDING', 'ONE_TO_MANY', 0, NULL, NULL, 2.00, 1, 50 UNION ALL
      SELECT 'RE_TWISTING', 'Re-Twisting', 'TWISTING', 'MANY_TO_ONE', 0, 2, '2,3,4', 3.00, 1, 60) t;

-- QC parameters for the yarn processes (shared QC parameter master)
INSERT IGNORE INTO mst_fabric_process_qc_param (company_id, process_code, param_name, uom, min_value, max_value, target_value, is_mandatory, sort_order)
SELECT c.id, p.pc, p.pn, p.u, p.mn, p.mx, p.tg, p.md, p.so FROM mst_company c
JOIN (SELECT 'YARN_DYEING' pc, 'Shade match (DE)' pn, 'ΔE' u, 0 mn, 1 mx, 0 tg, 1 md, 10 so UNION ALL
      SELECT 'YARN_DYEING', 'Colour fastness', 'grade', 3, 5, 4, 1, 20 UNION ALL
      SELECT 'WINDING', 'Cone weight variation', '%', -3, 3, 0, 1, 10 UNION ALL
      SELECT 'TWISTING', 'TPI variation', '%', -5, 5, 0, 1, 10 UNION ALL
      SELECT 'TWISTING', 'Strength (CSP)', 'CSP', 1800, NULL, 2200, 0, 20) p;

-- ---------- Outward DC ----------
CREATE TABLE IF NOT EXISTS trx_yarn_process_order (
  id                   BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id           BIGINT UNSIGNED NOT NULL,
  ypo_no               VARCHAR(50) NOT NULL,
  ypo_date             DATE NOT NULL,
  process_code         VARCHAR(40) NOT NULL,
  vendor_id            BIGINT UNSIGNED NOT NULL COMMENT 'Process unit / contractor',
  from_warehouse_id    BIGINT UNSIGNED NULL,
  to_location          VARCHAR(120) NULL,
  vehicle_no           VARCHAR(30) NULL,
  challan_no           VARCHAR(60) NULL,
  target_shade         VARCHAR(80) NULL,
  expected_return_date DATE NULL,
  status               VARCHAR(24) NOT NULL DEFAULT 'DRAFT' COMMENT 'DRAFT / CONFIRMED / PARTIALLY_RECEIVED / COMPLETED / CLOSED / CANCELLED',
  is_reprocess         TINYINT(1) NOT NULL DEFAULT 0,
  reprocess_id         BIGINT UNSIGNED NULL,
  total_kg             DECIMAL(14,3) NOT NULL DEFAULT 0,
  remarks              TEXT NULL,
  cancel_reason        VARCHAR(255) NULL,
  close_reason         VARCHAR(255) NULL,
  created_by           BIGINT UNSIGNED NULL,
  created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  confirmed_by         BIGINT UNSIGNED NULL,
  confirmed_at         DATETIME NULL,
  UNIQUE KEY uq_ypo (company_id, ypo_no),
  KEY ix_ypo_vendor (company_id, vendor_id)
) ENGINE=InnoDB COMMENT='Yarn process outward DC';

CREATE TABLE IF NOT EXISTS trx_yarn_process_order_line (
  id            BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  ypo_id        BIGINT UNSIGNED NOT NULL,
  so_id         BIGINT UNSIGNED NULL,
  io_no         VARCHAR(60) NULL,
  buyer_po_no   VARCHAR(80) NULL,
  style_id      BIGINT UNSIGNED NULL,
  process_id    BIGINT UNSIGNED NULL COMMENT 'Yarn process program of the job (optional)',
  yarn_id       BIGINT UNSIGNED NULL,
  grn_line_id   BIGINT UNSIGNED NOT NULL COMMENT 'Yarn lot issued',
  lot_no        VARCHAR(80) NULL,
  cone_no       VARCHAR(60) NULL,
  no_of_cones   INT NOT NULL DEFAULT 0,
  shade         VARCHAR(80) NULL COMMENT 'Original shade',
  target_shade  VARCHAR(80) NULL,
  qty_kg        DECIMAL(14,3) NOT NULL,
  good_kg       DECIMAL(14,3) NOT NULL DEFAULT 0,
  reject_kg     DECIMAL(14,3) NOT NULL DEFAULT 0,
  loss_kg       DECIMAL(14,3) NOT NULL DEFAULT 0,
  issue_id      BIGINT UNSIGNED NULL COMMENT 'trx_process_issue line once confirmed',
  status        VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
  KEY ix_ypol_ypo (ypo_id), KEY ix_ypol_lot (grn_line_id)
) ENGINE=InnoDB COMMENT='Yarn process DC lines (job / lot / cone)';

-- ---------- Inward / GRN ----------
CREATE TABLE IF NOT EXISTS trx_yarn_process_inward (
  id                  BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id          BIGINT UNSIGNED NOT NULL,
  inward_no           VARCHAR(50) NOT NULL,
  inward_date         DATE NOT NULL,
  ypo_id              BIGINT UNSIGNED NOT NULL,
  vendor_id           BIGINT UNSIGNED NULL,
  process_code        VARCHAR(40) NOT NULL,
  challan_no          VARCHAR(60) NULL,
  vehicle_no          VARCHAR(30) NULL,
  received_by         VARCHAR(80) NULL,
  warehouse_id        BIGINT UNSIGNED NOT NULL,
  reject_warehouse_id BIGINT UNSIGNED NULL,
  grn_id              BIGINT UNSIGNED NULL,
  reject_grn_id       BIGINT UNSIGNED NULL,
  input_kg            DECIMAL(14,3) NOT NULL DEFAULT 0,
  good_kg             DECIMAL(14,3) NOT NULL DEFAULT 0,
  reject_kg           DECIMAL(14,3) NOT NULL DEFAULT 0,
  loss_kg             DECIMAL(14,3) NOT NULL DEFAULT 0,
  is_reprocess        TINYINT(1) NOT NULL DEFAULT 0,
  bill_id             BIGINT UNSIGNED NULL,
  status              VARCHAR(20) NOT NULL DEFAULT 'DRAFT' COMMENT 'DRAFT / QC_PENDING / ACCEPTED / PARTIAL / REJECTED / POSTED / CANCELLED',
  draft_json          JSON NULL,
  qc_by               BIGINT UNSIGNED NULL,
  qc_at               DATETIME NULL,
  qc_remarks          VARCHAR(255) NULL,
  remarks             TEXT NULL,
  created_by          BIGINT UNSIGNED NULL,
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  posted_by           BIGINT UNSIGNED NULL,
  posted_at           DATETIME NULL,
  UNIQUE KEY uq_ypi (company_id, inward_no),
  KEY ix_ypi_ypo (ypo_id)
) ENGINE=InnoDB COMMENT='Yarn process inward / GRN';

CREATE TABLE IF NOT EXISTS trx_yarn_process_inward_out (
  id                  BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  inward_id           BIGINT UNSIGNED NOT NULL,
  ypo_id              BIGINT UNSIGNED NOT NULL,
  so_id               BIGINT UNSIGNED NULL,
  io_no               VARCHAR(60) NULL,
  yarn_id             BIGINT UNSIGNED NULL COMMENT 'Output yarn (twisting can make a new count / ply)',
  output_cone_no      VARCHAR(60) NULL,
  output_lot_no       VARCHAR(80) NULL,
  shade               VARCHAR(80) NULL,
  ply                 TINYINT UNSIGNED NULL,
  no_of_cones         INT NOT NULL DEFAULT 0,
  input_kg            DECIMAL(14,3) NOT NULL DEFAULT 0,
  good_kg             DECIMAL(14,3) NOT NULL DEFAULT 0,
  reject_kg           DECIMAL(14,3) NOT NULL DEFAULT 0,
  loss_kg             DECIMAL(14,3) NOT NULL DEFAULT 0,
  reject_reason       VARCHAR(160) NULL,
  qc_status           VARCHAR(12) NOT NULL DEFAULT 'ACCEPTED',
  grn_line_id         BIGINT UNSIGNED NULL COMMENT 'Good output lot',
  reject_grn_line_id  BIGINT UNSIGNED NULL,
  KEY ix_ypio_inward (inward_id), KEY ix_ypio_gl (grn_line_id)
) ENGINE=InnoDB COMMENT='Yarn process GRN output cones';

CREATE TABLE IF NOT EXISTS trx_yarn_process_inward_in (
  id            BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  out_id        BIGINT UNSIGNED NOT NULL,
  ypo_line_id   BIGINT UNSIGNED NOT NULL,
  cone_no       VARCHAR(60) NULL,
  input_kg      DECIMAL(14,3) NOT NULL,
  KEY ix_ypii_out (out_id), KEY ix_ypii_line (ypo_line_id)
) ENGINE=InnoDB COMMENT='Input cones consumed by a GRN output cone (one→many / many→one mapping)';

CREATE TABLE IF NOT EXISTS trx_yarn_process_qc (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  inward_id       BIGINT UNSIGNED NOT NULL,
  line_index      INT NOT NULL,
  output_cone_no  VARCHAR(60) NULL,
  param_id        INT UNSIGNED NULL,
  param_name      VARCHAR(80) NOT NULL,
  value           DECIMAL(14,3) NULL,
  min_value       DECIMAL(14,3) NULL,
  max_value       DECIMAL(14,3) NULL,
  result          VARCHAR(10) NOT NULL,
  created_by      BIGINT UNSIGNED NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_ypqc_inward (inward_id)
) ENGINE=InnoDB COMMENT='Yarn process GRN QC results per output cone';

-- ---------- Return ----------
CREATE TABLE IF NOT EXISTS trx_yarn_process_return (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  return_no       VARCHAR(50) NOT NULL,
  return_date     DATE NOT NULL,
  inward_id       BIGINT UNSIGNED NULL,
  ypo_id          BIGINT UNSIGNED NULL,
  vendor_id       BIGINT UNSIGNED NULL,
  process_code    VARCHAR(40) NULL,
  return_type     VARCHAR(20) NOT NULL DEFAULT 'QUALITY',
  reason_id       BIGINT UNSIGNED NULL,
  warehouse_id    BIGINT UNSIGNED NOT NULL,
  grn_id          BIGINT UNSIGNED NULL COMMENT 'Lots in the return store',
  total_kg        DECIMAL(14,3) NOT NULL DEFAULT 0,
  reprocessed_kg  DECIMAL(14,3) NOT NULL DEFAULT 0,
  rejected_kg     DECIMAL(14,3) NOT NULL DEFAULT 0,
  status          VARCHAR(20) NOT NULL DEFAULT 'CONFIRMED' COMMENT 'CONFIRMED / SENT_TO_REPROCESS / CLOSED',
  remarks         TEXT NULL,
  created_by      BIGINT UNSIGNED NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_ypr (company_id, return_no)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS trx_yarn_process_return_line (
  id                  BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  return_id           BIGINT UNSIGNED NOT NULL,
  source_grn_line_id  BIGINT UNSIGNED NOT NULL,
  return_grn_line_id  BIGINT UNSIGNED NULL,
  so_id               BIGINT UNSIGNED NULL,
  lot_no              VARCHAR(80) NULL,
  cone_no             VARCHAR(60) NULL,
  qty_kg              DECIMAL(14,3) NOT NULL,
  reprocessed_kg      DECIMAL(14,3) NOT NULL DEFAULT 0,
  defect_reason       VARCHAR(160) NULL,
  KEY ix_yprl_ret (return_id)
) ENGINE=InnoDB;

-- ---------- Reprocess ----------
CREATE TABLE IF NOT EXISTS trx_yarn_reprocess (
  id                  BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id          BIGINT UNSIGNED NOT NULL,
  reprocess_no        VARCHAR(50) NOT NULL,
  reprocess_date      DATE NOT NULL,
  source_type         VARCHAR(10) NOT NULL DEFAULT 'RETURN' COMMENT 'RETURN / REJECT (GRN reject lots)',
  return_id           BIGINT UNSIGNED NULL,
  original_inward_id  BIGINT UNSIGNED NULL,
  process_code        VARCHAR(40) NOT NULL,
  vendor_id           BIGINT UNSIGNED NOT NULL,
  target_shade        VARCHAR(80) NULL,
  reason_id           BIGINT UNSIGNED NULL,
  total_kg            DECIMAL(14,3) NOT NULL DEFAULT 0,
  billing_type        VARCHAR(16) NOT NULL COMMENT 'BILLABLE / NON_BILLABLE',
  cost_treatment      VARCHAR(16) NOT NULL COMMENT 'CONTRACTOR / INTERNAL / FREE / RECOVERY',
  billing_reason_id   BIGINT UNSIGNED NULL,
  rate_per_kg         DECIMAL(12,2) NOT NULL DEFAULT 0,
  bill_amount         DECIMAL(14,2) NOT NULL DEFAULT 0,
  internal_cost       DECIMAL(14,2) NOT NULL DEFAULT 0,
  billing_status      VARCHAR(12) NOT NULL DEFAULT 'PENDING' COMMENT 'PENDING / APPROVED / BILLED / EXCLUDED / REVERSED',
  billing_approved_by BIGINT UNSIGNED NULL,
  billing_approved_at DATETIME NULL,
  billing_remarks     TEXT NULL,
  contractor_bill_id  BIGINT UNSIGNED NULL,
  ypo_id              BIGINT UNSIGNED NULL COMMENT 'Reprocess DC',
  status              VARCHAR(16) NOT NULL DEFAULT 'DRAFT' COMMENT 'DRAFT / APPROVED / IN_PROCESS / INWARD_PENDING / COMPLETED / CANCELLED',
  remarks             TEXT NULL,
  created_by          BIGINT UNSIGNED NULL,
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  confirmed_by        BIGINT UNSIGNED NULL,
  confirmed_at        DATETIME NULL,
  UNIQUE KEY uq_yrp (company_id, reprocess_no)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS trx_yarn_reprocess_line (
  id                  BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  reprocess_id        BIGINT UNSIGNED NOT NULL,
  source_grn_line_id  BIGINT UNSIGNED NOT NULL,
  return_line_id      BIGINT UNSIGNED NULL,
  so_id               BIGINT UNSIGNED NULL,
  lot_no              VARCHAR(80) NULL,
  cone_no             VARCHAR(60) NULL,
  qty_kg              DECIMAL(14,3) NOT NULL,
  KEY ix_yrpl_rp (reprocess_id)
) ENGINE=InnoDB;

-- ---------- Contractor bill ----------
CREATE TABLE IF NOT EXISTS trx_yarn_process_bill (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  bill_no         VARCHAR(50) NOT NULL,
  bill_date       DATE NOT NULL,
  vendor_id       BIGINT UNSIGNED NOT NULL,
  party_bill_no   VARCHAR(60) NULL,
  from_date       DATE NULL,
  to_date         DATE NULL,
  gross_amount    DECIMAL(14,2) NOT NULL DEFAULT 0,
  recovery_amount DECIMAL(14,2) NOT NULL DEFAULT 0,
  discount_amount DECIMAL(14,2) NOT NULL DEFAULT 0,
  other_charges   DECIMAL(14,2) NOT NULL DEFAULT 0,
  gst_pct         DECIMAL(5,2) NOT NULL DEFAULT 0,
  gst_amount      DECIMAL(14,2) NOT NULL DEFAULT 0,
  net_amount      DECIMAL(14,2) NOT NULL DEFAULT 0,
  status          VARCHAR(12) NOT NULL DEFAULT 'POSTED',
  remarks         TEXT NULL,
  created_by      BIGINT UNSIGNED NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_ypb (company_id, bill_no)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS trx_yarn_process_bill_line (
  id            BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  bill_id       BIGINT UNSIGNED NOT NULL,
  line_type     VARCHAR(12) NOT NULL COMMENT 'GRN / REPROCESS / RECOVERY',
  ref_id        BIGINT UNSIGNED NOT NULL,
  doc_no        VARCHAR(50) NULL,
  doc_date      DATE NULL,
  io_no         VARCHAR(255) NULL,
  process_code  VARCHAR(40) NULL,
  qty_kg        DECIMAL(14,3) NOT NULL DEFAULT 0,
  rate          DECIMAL(12,2) NOT NULL DEFAULT 0,
  amount        DECIMAL(14,2) NOT NULL DEFAULT 0,
  KEY ix_ypbl_bill (bill_id)
) ENGINE=InnoDB;

-- ---------- Cone / lot history ----------
CREATE TABLE IF NOT EXISTS trx_yarn_cone_history (
  id                  BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id          BIGINT UNSIGNED NOT NULL,
  grn_line_id         BIGINT UNSIGNED NULL,
  lot_no              VARCHAR(80) NULL,
  cone_no             VARCHAR(60) NULL,
  event               VARCHAR(30) NOT NULL,
  ref_type            VARCHAR(10) NOT NULL,
  ref_id              BIGINT UNSIGNED NULL,
  ref_no              VARCHAR(50) NULL,
  process_code        VARCHAR(40) NULL,
  from_place          VARCHAR(160) NULL,
  to_place            VARCHAR(160) NULL,
  qty_kg              DECIMAL(14,3) NOT NULL DEFAULT 0,
  so_id               BIGINT UNSIGNED NULL,
  related_grn_line_id BIGINT UNSIGNED NULL,
  remarks             VARCHAR(255) NULL,
  user_id             BIGINT UNSIGNED NULL,
  event_time          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_ych_gl (grn_line_id), KEY ix_ych_rel (related_grn_line_id), KEY ix_ych_cone (company_id, cone_no)
) ENGINE=InnoDB COMMENT='Yarn lot / cone movement history (cone tracking)';

-- ---------- number series ----------
INSERT INTO cfg_number_series (company_id, branch_id, doc_type, fy_id, prefix, next_number, padding)
SELECT c.id, NULL, d.dt, NULL, d.px, 1, 5 FROM mst_company c
JOIN (SELECT 'YP_OUTWARD' dt, 'YPO-' px UNION ALL SELECT 'YP_INWARD', 'YPI-' UNION ALL SELECT 'YP_RETURN', 'YPR-'
      UNION ALL SELECT 'YP_REPROCESS', 'YRP-' UNION ALL SELECT 'YP_BILL', 'YPB-' UNION ALL SELECT 'YP_LOT_MOVE', 'YLM-') d
WHERE NOT EXISTS (SELECT 1 FROM cfg_number_series s WHERE s.company_id = c.id AND s.doc_type = d.dt AND s.branch_id IS NULL AND s.fy_id IS NULL);
