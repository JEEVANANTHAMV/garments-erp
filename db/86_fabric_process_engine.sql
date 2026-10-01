-- =====================================================================
-- 86: Fabric Process engine (Garment_ERP_Fabric_Process_Developer_Document_v2)
--   One configurable engine for dyeing / washing / compacting / brushing / raising /
--   printing …: multi-job Outward DC → multi-job Inward GRN (input → output roll,
--   good / reject / loss) → Return → Reprocess (with billing treatment) → contractor
--   bill, with roll history for tracking. Reuses trx_fabric_process_order (DC header),
--   trx_fabric_process_roll_in (DC rolls) and trx_fabric_process_roll_out (GRN lines).
--   Idempotent: migrations >= 10 re-run on every deploy.
-- =====================================================================

-- ---------- Process Type master (drives the engine) ----------
CREATE TABLE IF NOT EXISTS mst_fabric_process_type (
  id               INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id       BIGINT UNSIGNED NOT NULL,
  code             VARCHAR(40) NOT NULL,
  name             VARCHAR(80) NOT NULL,
  output_state     VARCHAR(20) NOT NULL DEFAULT 'FINISHED' COMMENT 'Roll state after the process: DYED / WASHED / PRINTED / COMPACTED / FINISHED',
  changes_colour   TINYINT(1) NOT NULL DEFAULT 0,
  allow_reprocess  TINYINT(1) NOT NULL DEFAULT 1,
  allow_split      TINYINT(1) NOT NULL DEFAULT 1 COMMENT 'One input roll may become several output rolls',
  is_reprocess     TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'Re-dye / re-wash … types used by Reprocess',
  sort_order       INT NOT NULL DEFAULT 0,
  is_active        TINYINT(1) NOT NULL DEFAULT 1,
  UNIQUE KEY uq_fpt (company_id, code)
) ENGINE=InnoDB COMMENT='Fabric process types (configurable engine)';

INSERT IGNORE INTO mst_fabric_process_type (company_id, code, name, output_state, changes_colour, is_reprocess, sort_order)
SELECT c.id, t.code, t.name, t.state, t.colour, t.rp, t.so FROM mst_company c
JOIN (SELECT 'DYEING' code, 'Dyeing' name, 'DYED' state, 1 colour, 0 rp, 10 so UNION ALL
      SELECT 'WASHING', 'Washing', 'WASHED', 0, 0, 20 UNION ALL
      SELECT 'COMPACTING', 'Compacting', 'COMPACTED', 0, 0, 30 UNION ALL
      SELECT 'PRINTING', 'Printing', 'PRINTED', 1, 0, 40 UNION ALL
      SELECT 'BRUSHING', 'Brushing', 'FINISHED', 0, 0, 50 UNION ALL
      SELECT 'RAISING', 'Raising', 'FINISHED', 0, 0, 60 UNION ALL
      SELECT 'HEAT_SETTING', 'Heat setting', 'FINISHED', 0, 0, 70 UNION ALL
      SELECT 'STENTERING', 'Stentering', 'FINISHED', 0, 0, 80 UNION ALL
      SELECT 'RELAX_DRYER', 'Relax dryer', 'FINISHED', 0, 0, 90 UNION ALL
      SELECT 'TUMBLE_DRYER', 'Tumble dryer', 'FINISHED', 0, 0, 100 UNION ALL
      SELECT 'BITTING_SLITTING', 'Bitting / slitting', 'FINISHED', 0, 0, 110 UNION ALL
      SELECT 'COMMON_PROCESS', 'Common process', 'FINISHED', 0, 0, 120 UNION ALL
      SELECT 'RE_DYEING', 'Re-dyeing', 'DYED', 1, 1, 200 UNION ALL
      SELECT 'RE_WASHING', 'Re-washing', 'WASHED', 0, 1, 210 UNION ALL
      SELECT 'RE_COMPACTING', 'Re-compacting', 'COMPACTED', 0, 1, 220 UNION ALL
      SELECT 'RE_PRINTING', 'Re-printing', 'PRINTED', 1, 1, 230) t;

-- ---------- Reason master (return / reprocess / billing) ----------
CREATE TABLE IF NOT EXISTS mst_fabric_process_reason (
  id                INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id        BIGINT UNSIGNED NOT NULL,
  code              VARCHAR(20) NOT NULL,
  reason            VARCHAR(120) NOT NULL,
  kind              VARCHAR(20) NOT NULL DEFAULT 'BOTH' COMMENT 'RETURN / BILLING / BOTH',
  default_billing   VARCHAR(20) NULL COMMENT 'Typical billing treatment',
  is_active         TINYINT(1) NOT NULL DEFAULT 1,
  UNIQUE KEY uq_fpr (company_id, code)
) ENGINE=InnoDB COMMENT='Fabric process return / reprocess / billing reasons';

INSERT IGNORE INTO mst_fabric_process_reason (company_id, code, reason, kind, default_billing)
SELECT c.id, r.code, r.reason, r.kind, r.bill FROM mst_company c
JOIN (SELECT 'CR-01' code, 'Contractor process defect' reason, 'BOTH' kind, 'NON_BILLABLE' bill UNION ALL
      SELECT 'CR-02', 'Buyer / quality requirement', 'BOTH', 'BILLABLE' UNION ALL
      SELECT 'CR-03', 'Internal process error', 'BOTH', 'INTERNAL_COST' UNION ALL
      SELECT 'CR-04', 'Shade variation', 'BOTH', NULL UNION ALL
      SELECT 'CR-05', 'Washing failure', 'BOTH', NULL UNION ALL
      SELECT 'CR-06', 'Customer rework', 'BOTH', 'BILLABLE' UNION ALL
      SELECT 'CR-07', 'Uneven dyeing', 'RETURN', NULL UNION ALL
      SELECT 'CR-08', 'Holes / damage', 'RETURN', NULL UNION ALL
      SELECT 'CR-09', 'GSM / width out of tolerance', 'RETURN', NULL UNION ALL
      SELECT 'CR-99', 'Other', 'BOTH', NULL) r;

-- ---------- DC header: process from the master, store / location, draft → confirm ----------
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_fabric_process_order' AND COLUMN_NAME='sub_process' AND DATA_TYPE='enum');
SET @s = IF(@x=1, 'ALTER TABLE trx_fabric_process_order MODIFY COLUMN sub_process VARCHAR(40) NOT NULL DEFAULT ''DYEING''', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_fabric_process_order' AND COLUMN_NAME='status' AND COLUMN_TYPE NOT LIKE '%PARTIALLY_RECEIVED%');
SET @s = IF(@x=1, 'ALTER TABLE trx_fabric_process_order MODIFY COLUMN status ENUM(''DRAFT'',''DISPATCHED'',''IN_PROCESS'',''PARTIALLY_RECEIVED'',''COMPLETED'',''CLOSED'',''CANCELLED'') NOT NULL DEFAULT ''DRAFT''', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_fabric_process_order' AND COLUMN_NAME='from_warehouse_id');
SET @s = IF(@x=0, 'ALTER TABLE trx_fabric_process_order ADD COLUMN from_warehouse_id BIGINT UNSIGNED NULL, ADD COLUMN to_location VARCHAR(120) NULL, ADD COLUMN challan_no VARCHAR(60) NULL, ADD COLUMN is_reprocess TINYINT(1) NOT NULL DEFAULT 0, ADD COLUMN reprocess_id BIGINT UNSIGNED NULL, ADD COLUMN confirmed_by BIGINT UNSIGNED NULL, ADD COLUMN confirmed_at DATETIME NULL, ADD COLUMN cancel_reason VARCHAR(255) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- ---------- DC rolls: each roll carries its job ----------
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_fabric_process_roll_in' AND COLUMN_NAME='so_id');
SET @s = IF(@x=0, 'ALTER TABLE trx_fabric_process_roll_in ADD COLUMN so_id BIGINT UNSIGNED NULL, ADD COLUMN io_no VARCHAR(60) NULL, ADD COLUMN buyer_po_no VARCHAR(60) NULL, ADD COLUMN style_id BIGINT UNSIGNED NULL, ADD COLUMN fabric_id BIGINT UNSIGNED NULL, ADD COLUMN color_name VARCHAR(80) NULL, ADD COLUMN gsm VARCHAR(20) NULL, ADD COLUMN dia VARCHAR(20) NULL, ADD COLUMN good_kg DECIMAL(14,3) NOT NULL DEFAULT 0, ADD COLUMN reject_kg DECIMAL(14,3) NOT NULL DEFAULT 0, ADD COLUMN loss_kg DECIMAL(14,3) NOT NULL DEFAULT 0, ADD COLUMN status VARCHAR(20) NOT NULL DEFAULT ''AT_VENDOR''', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- ---------- Inward / GRN header ----------
CREATE TABLE IF NOT EXISTS trx_fabric_process_inward (
  id                   BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id           BIGINT UNSIGNED NOT NULL,
  inward_no            VARCHAR(50) NOT NULL,
  inward_date          DATE NOT NULL,
  fpo_id               BIGINT UNSIGNED NOT NULL,
  vendor_id            BIGINT UNSIGNED NULL,
  sub_process          VARCHAR(40) NOT NULL,
  challan_no           VARCHAR(60) NULL COMMENT 'Process unit challan',
  vehicle_no           VARCHAR(30) NULL,
  received_by          VARCHAR(80) NULL,
  warehouse_id         BIGINT UNSIGNED NOT NULL COMMENT 'Processed fabric store',
  reject_warehouse_id  BIGINT UNSIGNED NULL COMMENT 'Reject / rework store',
  grn_id               BIGINT UNSIGNED NULL COMMENT 'Stock GRN (trx_grn) the rolls hang off',
  input_kg             DECIMAL(14,3) NOT NULL DEFAULT 0,
  good_kg              DECIMAL(14,3) NOT NULL DEFAULT 0,
  reject_kg            DECIMAL(14,3) NOT NULL DEFAULT 0,
  loss_kg              DECIMAL(14,3) NOT NULL DEFAULT 0,
  is_reprocess         TINYINT(1) NOT NULL DEFAULT 0,
  bill_id              BIGINT UNSIGNED NULL COMMENT 'Contractor bill that charged this GRN',
  status               VARCHAR(20) NOT NULL DEFAULT 'POSTED',
  remarks              TEXT NULL,
  created_by           BIGINT UNSIGNED NULL,
  created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_fpi_no (company_id, inward_no),
  KEY ix_fpi_fpo (fpo_id)
) ENGINE=InnoDB COMMENT='Fabric process inward / GRN (multi-job)';

-- ---------- GRN lines (output rolls): input roll → output roll, good / reject / loss ----------
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_fabric_process_roll_out' AND COLUMN_NAME='inward_id');
SET @s = IF(@x=0, 'ALTER TABLE trx_fabric_process_roll_out ADD COLUMN inward_id BIGINT UNSIGNED NULL, ADD COLUMN roll_in_id BIGINT UNSIGNED NULL, ADD COLUMN so_id BIGINT UNSIGNED NULL, ADD COLUMN input_kg DECIMAL(14,3) NOT NULL DEFAULT 0, ADD COLUMN reject_kg DECIMAL(14,3) NOT NULL DEFAULT 0, ADD COLUMN loss_kg DECIMAL(14,3) NOT NULL DEFAULT 0, ADD COLUMN color_name VARCHAR(80) NULL, ADD COLUMN shade_no VARCHAR(40) NULL, ADD COLUMN reject_reason VARCHAR(120) NULL, ADD COLUMN reject_roll_id BIGINT UNSIGNED NULL, ADD KEY ix_fpro_inward (inward_id)', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- ---------- Store rolls: current job owner ----------
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_fabric_roll' AND COLUMN_NAME='so_id');
SET @s = IF(@x=0, 'ALTER TABLE trx_fabric_roll ADD COLUMN so_id BIGINT UNSIGNED NULL COMMENT ''Job the roll belongs to (GRN line / processing / transfer)'', ADD COLUMN parent_roll_id BIGINT UNSIGNED NULL COMMENT ''Roll it was processed / split from'', ADD KEY ix_froll_so (so_id)', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
-- backfill the job from the GRN line, else the GRN's IO no
UPDATE trx_fabric_roll fr JOIN trx_grn_line gl ON gl.id = fr.grn_line_id
   SET fr.so_id = gl.so_id WHERE fr.so_id IS NULL AND gl.so_id IS NOT NULL;
UPDATE trx_fabric_roll fr JOIN trx_grn g ON g.id = fr.grn_id
  JOIN trx_sales_order so ON so.company_id = g.company_id AND (so.io_no = g.internal_ir_no OR so.so_no = g.internal_ir_no)
   SET fr.so_id = so.id WHERE fr.so_id IS NULL AND g.internal_ir_no IS NOT NULL AND g.internal_ir_no <> '';

-- ---------- Process Return ----------
CREATE TABLE IF NOT EXISTS trx_fabric_process_return (
  id                 BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id         BIGINT UNSIGNED NOT NULL,
  return_no          VARCHAR(50) NOT NULL,
  return_date        DATE NOT NULL,
  inward_id          BIGINT UNSIGNED NULL COMMENT 'Original GRN',
  fpo_id             BIGINT UNSIGNED NULL,
  vendor_id          BIGINT UNSIGNED NULL,
  sub_process        VARCHAR(40) NULL,
  return_type        VARCHAR(20) NOT NULL DEFAULT 'QUALITY_REJECT' COMMENT 'QUALITY_REJECT / REPROCESS / OTHER',
  reason_id          INT UNSIGNED NULL,
  warehouse_id       BIGINT UNSIGNED NOT NULL COMMENT 'Return / reject store',
  total_kg           DECIMAL(14,3) NOT NULL DEFAULT 0,
  reprocessed_kg     DECIMAL(14,3) NOT NULL DEFAULT 0,
  status             VARCHAR(20) NOT NULL DEFAULT 'CONFIRMED' COMMENT 'CONFIRMED / SENT_TO_REPROCESS / CLOSED / CANCELLED',
  remarks            TEXT NULL,
  created_by         BIGINT UNSIGNED NULL,
  created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_fpr_no (company_id, return_no)
) ENGINE=InnoDB COMMENT='Fabric process return (reject / quality issue)';

CREATE TABLE IF NOT EXISTS trx_fabric_process_return_line (
  id               BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  return_id        BIGINT UNSIGNED NOT NULL,
  source_roll_id   BIGINT UNSIGNED NOT NULL COMMENT 'Processed store roll returned',
  return_roll_id   BIGINT UNSIGNED NULL COMMENT 'Roll created in the return store',
  so_id            BIGINT UNSIGNED NULL,
  roll_no          VARCHAR(60) NOT NULL,
  color_name       VARCHAR(80) NULL,
  qty_kg           DECIMAL(14,3) NOT NULL,
  meters           DECIMAL(14,2) NOT NULL DEFAULT 0,
  reprocessed_kg   DECIMAL(14,3) NOT NULL DEFAULT 0,
  defect_reason    VARCHAR(120) NULL,
  KEY ix_fprl_ret (return_id)
) ENGINE=InnoDB;

-- ---------- Reprocess (with billing treatment) ----------
CREATE TABLE IF NOT EXISTS trx_fabric_reprocess (
  id                   BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id           BIGINT UNSIGNED NOT NULL,
  reprocess_no         VARCHAR(50) NOT NULL,
  reprocess_date       DATE NOT NULL,
  source_type          VARCHAR(20) NOT NULL DEFAULT 'RETURN' COMMENT 'RETURN / STOCK',
  return_id            BIGINT UNSIGNED NULL,
  original_inward_id   BIGINT UNSIGNED NULL,
  sub_process          VARCHAR(40) NOT NULL,
  vendor_id            BIGINT UNSIGNED NOT NULL,
  color_name           VARCHAR(80) NULL,
  reason_id            INT UNSIGNED NULL,
  total_kg             DECIMAL(14,3) NOT NULL DEFAULT 0,
  billing_type         VARCHAR(20) NOT NULL DEFAULT 'NON_BILLABLE' COMMENT 'BILLABLE / NON_BILLABLE / INTERNAL_COST / FREE / RECOVERY',
  bill_required        TINYINT(1) NOT NULL DEFAULT 0,
  billing_reason_id    INT UNSIGNED NULL,
  cost_treatment       VARCHAR(30) NULL COMMENT 'CONTRACTOR_CHARGE / INTERNAL_COST / FREE / RECOVERY',
  rate_per_kg          DECIMAL(18,4) NOT NULL DEFAULT 0,
  bill_amount          DECIMAL(18,2) NOT NULL DEFAULT 0,
  internal_cost        DECIMAL(18,2) NOT NULL DEFAULT 0,
  billing_status       VARCHAR(20) NOT NULL DEFAULT 'PENDING' COMMENT 'PENDING / APPROVED / BILLED / EXCLUDED / REVERSED',
  billing_approved_by  BIGINT UNSIGNED NULL,
  billing_approved_at  DATETIME NULL,
  contractor_bill_id   BIGINT UNSIGNED NULL,
  billing_remarks      TEXT NULL,
  fpo_id               BIGINT UNSIGNED NULL COMMENT 'Reprocess DC created on confirm',
  status               VARCHAR(20) NOT NULL DEFAULT 'DRAFT' COMMENT 'DRAFT / IN_PROCESS / COMPLETED / CANCELLED',
  remarks              TEXT NULL,
  created_by           BIGINT UNSIGNED NULL,
  created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  confirmed_by         BIGINT UNSIGNED NULL,
  confirmed_at         DATETIME NULL,
  UNIQUE KEY uq_frp_no (company_id, reprocess_no)
) ENGINE=InnoDB COMMENT='Fabric reprocess (re-dye / re-wash …) with billing treatment';

CREATE TABLE IF NOT EXISTS trx_fabric_reprocess_line (
  id                BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  reprocess_id      BIGINT UNSIGNED NOT NULL,
  source_roll_id    BIGINT UNSIGNED NOT NULL,
  return_line_id    BIGINT UNSIGNED NULL,
  so_id             BIGINT UNSIGNED NULL,
  roll_no           VARCHAR(60) NOT NULL,
  qty_kg            DECIMAL(14,3) NOT NULL,
  KEY ix_frpl_rp (reprocess_id)
) ENGINE=InnoDB;

-- ---------- Roll history (every movement) ----------
CREATE TABLE IF NOT EXISTS trx_fabric_roll_history (
  id            BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id    BIGINT UNSIGNED NOT NULL,
  roll_id       BIGINT UNSIGNED NULL COMMENT 'trx_fabric_roll the event is about',
  roll_no       VARCHAR(60) NOT NULL,
  event         VARCHAR(30) NOT NULL COMMENT 'PROCESS_OUTWARD / PROCESS_INWARD / REJECT / RETURN / REPROCESS_OUTWARD / CANCEL …',
  ref_type      VARCHAR(30) NOT NULL,
  ref_id        BIGINT UNSIGNED NULL,
  ref_no        VARCHAR(60) NULL,
  sub_process   VARCHAR(40) NULL,
  from_place    VARCHAR(120) NULL,
  to_place      VARCHAR(120) NULL,
  qty_kg        DECIMAL(14,3) NOT NULL DEFAULT 0,
  so_id         BIGINT UNSIGNED NULL,
  related_roll_id BIGINT UNSIGNED NULL COMMENT 'Input roll of an output roll and vice versa',
  remarks       VARCHAR(255) NULL,
  user_id       BIGINT UNSIGNED NULL,
  event_time    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_frh_roll (roll_id),
  KEY ix_frh_rollno (company_id, roll_no)
) ENGINE=InnoDB COMMENT='Fabric roll movement history';

-- ---------- Contractor bill (fabric process, incl. billable reprocess) ----------
CREATE TABLE IF NOT EXISTS trx_fabric_process_bill (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  bill_no         VARCHAR(50) NOT NULL,
  bill_date       DATE NOT NULL,
  vendor_id       BIGINT UNSIGNED NOT NULL,
  party_bill_no   VARCHAR(60) NULL,
  from_date       DATE NULL,
  to_date         DATE NULL,
  gross_amount    DECIMAL(18,2) NOT NULL DEFAULT 0,
  recovery_amount DECIMAL(18,2) NOT NULL DEFAULT 0,
  discount_amount DECIMAL(18,2) NOT NULL DEFAULT 0,
  other_charges   DECIMAL(18,2) NOT NULL DEFAULT 0,
  gst_pct         DECIMAL(6,2) NOT NULL DEFAULT 0,
  gst_amount      DECIMAL(18,2) NOT NULL DEFAULT 0,
  net_amount      DECIMAL(18,2) NOT NULL DEFAULT 0,
  status          VARCHAR(20) NOT NULL DEFAULT 'POSTED' COMMENT 'POSTED / CANCELLED',
  remarks         TEXT NULL,
  created_by      BIGINT UNSIGNED NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_fpb_no (company_id, bill_no)
) ENGINE=InnoDB COMMENT='Fabric process contractor bill';

CREATE TABLE IF NOT EXISTS trx_fabric_process_bill_line (
  id            BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  bill_id       BIGINT UNSIGNED NOT NULL,
  line_type     VARCHAR(20) NOT NULL COMMENT 'GRN / REPROCESS / RECOVERY',
  ref_id        BIGINT UNSIGNED NOT NULL,
  doc_no        VARCHAR(60) NOT NULL,
  doc_date      DATE NULL,
  so_id         BIGINT UNSIGNED NULL,
  io_no         VARCHAR(60) NULL,
  sub_process   VARCHAR(40) NULL,
  qty_kg        DECIMAL(14,3) NOT NULL DEFAULT 0,
  rate          DECIMAL(18,4) NOT NULL DEFAULT 0,
  amount        DECIMAL(18,2) NOT NULL DEFAULT 0 COMMENT 'Negative for recovery',
  KEY ix_fpbl_bill (bill_id)
) ENGINE=InnoDB;

-- ---------- Document number series (distinct prefixes) ----------
UPDATE cfg_number_series SET prefix = 'FPO-' WHERE doc_type = 'FPO' AND prefix = 'F-';
INSERT INTO cfg_number_series (company_id, branch_id, doc_type, fy_id, prefix, next_number, padding)
SELECT c.id, NULL, t.dt, NULL, t.px, 1, 5 FROM mst_company c
JOIN (SELECT 'FPO' dt, 'FPO-' px UNION ALL SELECT 'FP_INWARD', 'FPI-' UNION ALL SELECT 'FP_RETURN', 'FPR-'
      UNION ALL SELECT 'FP_REPROCESS', 'FRP-' UNION ALL SELECT 'FP_BILL', 'FPB-') t
WHERE NOT EXISTS (SELECT 1 FROM cfg_number_series s WHERE s.company_id = c.id AND s.doc_type = t.dt AND s.branch_id IS NULL AND s.fy_id IS NULL);

-- ---------- Backfill DCs received before this engine (single-roll DCs): good / loss on the roll ----------
UPDATE trx_fabric_process_roll_in ri
  JOIN (SELECT fpo_id, SUM(weight_kg) g FROM trx_fabric_process_roll_out WHERE inward_id IS NULL GROUP BY fpo_id) x ON x.fpo_id = ri.fpo_id
  JOIN (SELECT fpo_id, COUNT(*) c FROM trx_fabric_process_roll_in GROUP BY fpo_id) cnt ON cnt.fpo_id = ri.fpo_id AND cnt.c = 1
  JOIN trx_fabric_process_order o ON o.id = ri.fpo_id
   SET ri.good_kg = LEAST(ri.weight_kg, x.g),
       ri.loss_kg = IF(o.status = 'COMPLETED', GREATEST(ri.weight_kg - x.g, 0), 0),
       ri.status = IF(o.status = 'COMPLETED', 'RECEIVED', 'PARTIAL')
 WHERE ri.good_kg = 0 AND ri.loss_kg = 0;
