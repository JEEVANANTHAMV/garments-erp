-- =====================================================================
-- 91: Knitting flow (Full_Knitting_Module_Developer_Document + client voice note 02-Oct-2026)
--   • Knitting DC header (trx_knitting_dc): status OPEN / PARTIALLY_RECEIVED / CLOSED, the approved
--     process quotation + rate it went out on.
--   • Knitting inward: one GRN for several DCs (trx_knitting_inward_dc), PARTIAL / FINAL receipt,
--     gate entry, bill link.
--   • Process DCs (fabric / yarn process outward) carry the approved quotation + rate.
--   • Gate entry on every process inward (fabric / yarn process GRN, knitting yarn return).
--   • Job transfer approval (status DRAFT → PENDING_APPROVAL → POSTED / REJECTED).
--   • Yarn substitution rules + requests (approval, never rewrites the original requirement).
--   • Knitting job-work bill (billed from knitting GRNs, in Bills Inward).
--   • Settings: PROCESS_QUOTATION_REQUIRED, GATE_ENTRY_REQUIRED_FOR_INWARD, JOB_TRANSFER_APPROVAL.
--   Idempotent.
-- =====================================================================

-- ---------- Knitting DC header ----------
CREATE TABLE IF NOT EXISTS trx_knitting_dc (
  id                 BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id         BIGINT UNSIGNED NOT NULL,
  dc_no              VARCHAR(60) NOT NULL,
  dc_date            DATE NULL,
  vendor_id          BIGINT UNSIGNED NULL,
  status             VARCHAR(20) NOT NULL DEFAULT 'OPEN' COMMENT 'OPEN / PARTIALLY_RECEIVED / CLOSED',
  quotation_id       BIGINT UNSIGNED NULL,
  quotation_line_id  BIGINT UNSIGNED NULL,
  rate_per_kg        DECIMAL(12,2) NULL COMMENT 'Knitting charge per KG from the approved quotation',
  closed_by          BIGINT UNSIGNED NULL,
  closed_at          DATETIME NULL,
  close_type         VARCHAR(20) NULL COMMENT 'FINAL_RECEIPT / SHORT_CLOSE',
  close_reason       VARCHAR(255) NULL,
  created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_kdc (company_id, dc_no)
) ENGINE=InnoDB COMMENT='Knitting DC header (lines stay in trx_process_issue)';

INSERT IGNORE INTO trx_knitting_dc (company_id, dc_no, dc_date, vendor_id, status)
SELECT i.company_id, i.dc_no, MIN(i.issue_date), MAX(i.vendor_id), 'OPEN'
  FROM trx_process_issue i WHERE i.src_type = 'KNITTING_PROGRAM' AND i.dc_no IS NOT NULL GROUP BY i.company_id, i.dc_no;

-- ---------- Knitting inward: PARTIAL / FINAL, gate entry, bill ----------
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_process_receipt' AND COLUMN_NAME='receipt_type');
SET @s = IF(@x=0, 'ALTER TABLE trx_process_receipt ADD COLUMN receipt_type VARCHAR(10) NOT NULL DEFAULT ''PARTIAL'' COMMENT ''PARTIAL (more to come) / FINAL (DC closed) / ADJUST'', ADD COLUMN gate_inward_id BIGINT UNSIGNED NULL, ADD COLUMN bill_id BIGINT UNSIGNED NULL COMMENT ''Knitting job-work bill''', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

CREATE TABLE IF NOT EXISTS trx_knitting_inward_dc (
  id           BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  receipt_id   BIGINT UNSIGNED NOT NULL,
  program_id   BIGINT UNSIGNED NOT NULL,
  dc_no        VARCHAR(60) NOT NULL,
  consumed_kg  DECIMAL(14,3) NOT NULL DEFAULT 0 COMMENT 'Yarn of this DC used for the GRN',
  fabric_kg    DECIMAL(14,3) NOT NULL DEFAULT 0,
  KEY ix_kidc_r (receipt_id), KEY ix_kidc_dc (dc_no)
) ENGINE=InnoDB COMMENT='Knitting GRN ↔ DCs (one GRN may consolidate several DCs)';

-- existing single-DC inwards
INSERT INTO trx_knitting_inward_dc (receipt_id, program_id, dc_no, consumed_kg, fabric_kg)
SELECT r.id, r.src_id, r.ref_dc_no, r.input_qty, r.output_qty FROM trx_process_receipt r
 WHERE r.src_type = 'KNITTING_PROGRAM' AND r.ref_dc_no IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM trx_knitting_inward_dc m WHERE m.receipt_id = r.id);

-- DCs that already had fabric back are part received
UPDATE trx_knitting_dc d SET d.status = 'PARTIALLY_RECEIVED'
 WHERE d.status = 'OPEN' AND EXISTS (SELECT 1 FROM trx_knitting_inward_dc m WHERE m.dc_no = d.dc_no);

-- ---------- Gate entry on process inwards ----------
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_fabric_process_inward' AND COLUMN_NAME='gate_inward_id');
SET @s = IF(@x=0, 'ALTER TABLE trx_fabric_process_inward ADD COLUMN gate_inward_id BIGINT UNSIGNED NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_yarn_process_inward' AND COLUMN_NAME='gate_inward_id');
SET @s = IF(@x=0, 'ALTER TABLE trx_yarn_process_inward ADD COLUMN gate_inward_id BIGINT UNSIGNED NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_knitting_yarn_return' AND COLUMN_NAME='gate_inward_id');
SET @s = IF(@x=0, 'ALTER TABLE trx_knitting_yarn_return ADD COLUMN gate_inward_id BIGINT UNSIGNED NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- ---------- Approved process quotation on process DCs ----------
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_fabric_process_order' AND COLUMN_NAME='quotation_id');
SET @s = IF(@x=0, 'ALTER TABLE trx_fabric_process_order ADD COLUMN quotation_id BIGINT UNSIGNED NULL, ADD COLUMN quotation_line_id BIGINT UNSIGNED NULL, ADD COLUMN rate_per_kg DECIMAL(12,2) NULL COMMENT ''Process charge from the approved quotation''', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_yarn_process_order' AND COLUMN_NAME='quotation_id');
SET @s = IF(@x=0, 'ALTER TABLE trx_yarn_process_order ADD COLUMN quotation_id BIGINT UNSIGNED NULL, ADD COLUMN quotation_line_id BIGINT UNSIGNED NULL, ADD COLUMN rate_per_kg DECIMAL(12,2) NULL COMMENT ''Process charge from the approved quotation''', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- ---------- Job transfer approval ----------
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_job_transfer' AND COLUMN_NAME='priority');
SET @s = IF(@x=0, 'ALTER TABLE trx_job_transfer ADD COLUMN priority VARCHAR(10) NOT NULL DEFAULT ''NORMAL'', ADD COLUMN lines_json JSON NULL COMMENT ''Requested lines until posted'', ADD COLUMN approved_by BIGINT UNSIGNED NULL, ADD COLUMN approved_at DATETIME NULL, ADD COLUMN posted_at DATETIME NULL, ADD COLUMN decision_remarks VARCHAR(255) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- ---------- Yarn substitution ----------
CREATE TABLE IF NOT EXISTS mst_yarn_substitution_rule (
  id                  INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id          BIGINT UNSIGNED NOT NULL,
  required_yarn_id    BIGINT UNSIGNED NOT NULL,
  substitute_yarn_id  BIGINT UNSIGNED NOT NULL,
  fabric_id           BIGINT UNSIGNED NULL COMMENT 'Only for this fabric (blank = any)',
  gsm_from            DECIMAL(8,2) NULL,
  gsm_to              DECIMAL(8,2) NULL,
  buyer_id            BIGINT UNSIGNED NULL,
  style_id            BIGINT UNSIGNED NULL,
  max_pct             DECIMAL(6,2) NOT NULL DEFAULT 10 COMMENT 'Max % of the requirement that may be substituted',
  conversion_ratio    DECIMAL(10,4) NOT NULL DEFAULT 1 COMMENT 'Substitute KG × ratio = required-yarn KG covered',
  effective_from      DATE NULL,
  effective_to        DATE NULL,
  remarks             VARCHAR(255) NULL,
  is_active           TINYINT(1) NOT NULL DEFAULT 1,
  created_by          BIGINT UNSIGNED NULL,
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_ysr (company_id, required_yarn_id)
) ENGINE=InnoDB COMMENT='Allowed alternate yarns (yarn substitution rule master)';

CREATE TABLE IF NOT EXISTS trx_yarn_substitution (
  id                   BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id           BIGINT UNSIGNED NOT NULL,
  request_no           VARCHAR(50) NOT NULL,
  request_date         DATE NOT NULL,
  so_id                BIGINT UNSIGNED NULL,
  program_id           BIGINT UNSIGNED NOT NULL,
  program_yarn_id      BIGINT UNSIGNED NOT NULL COMMENT 'Required yarn line of the program',
  required_yarn_id     BIGINT UNSIGNED NOT NULL,
  substitute_yarn_id   BIGINT UNSIGNED NOT NULL,
  rule_id              INT UNSIGNED NULL,
  grn_line_id          BIGINT UNSIGNED NULL COMMENT 'Substitute yarn lot',
  from_so_id           BIGINT UNSIGNED NULL COMMENT 'Job holding the substitute lot (NULL = general)',
  qty_kg               DECIMAL(14,3) NOT NULL COMMENT 'Substitute KG',
  conversion_ratio     DECIMAL(10,4) NOT NULL DEFAULT 1,
  equivalent_kg        DECIMAL(14,3) NOT NULL COMMENT 'Required-yarn KG it covers',
  issued_kg            DECIMAL(14,3) NOT NULL DEFAULT 0 COMMENT 'Substitute KG gone out on knitting DCs',
  reason               VARCHAR(255) NOT NULL,
  status               VARCHAR(20) NOT NULL DEFAULT 'PENDING_APPROVAL' COMMENT 'DRAFT / PENDING_APPROVAL / APPROVED / POSTED / REJECTED / SEND_BACK / CANCELLED',
  transfer_id          BIGINT UNSIGNED NULL COMMENT 'Job transfer made when the lot belonged to another job',
  approved_by          BIGINT UNSIGNED NULL,
  approved_at          DATETIME NULL,
  posted_at            DATETIME NULL,
  decision_remarks     VARCHAR(255) NULL,
  created_by           BIGINT UNSIGNED NULL,
  created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_ysub (company_id, request_no),
  KEY ix_ysub_prog (program_id)
) ENGINE=InnoDB COMMENT='Yarn substitution requests (original requirement is never rewritten)';

CREATE TABLE IF NOT EXISTS trx_yarn_approval_history (
  id           BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id   BIGINT UNSIGNED NOT NULL,
  doc_type     VARCHAR(20) NOT NULL COMMENT 'JOB_TRANSFER / SUBSTITUTION',
  doc_id       BIGINT UNSIGNED NOT NULL,
  action       VARCHAR(20) NOT NULL,
  from_status  VARCHAR(20) NULL,
  to_status    VARCHAR(20) NOT NULL,
  remarks      VARCHAR(255) NULL,
  user_id      BIGINT UNSIGNED NULL,
  at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_yah (doc_type, doc_id)
) ENGINE=InnoDB COMMENT='Approval history of job transfers and yarn substitutions';

-- ---------- Knitting job-work bill ----------
CREATE TABLE IF NOT EXISTS trx_knitting_bill (
  id               BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id       BIGINT UNSIGNED NOT NULL,
  bill_no          VARCHAR(50) NOT NULL,
  bill_date        DATE NOT NULL,
  vendor_id        BIGINT UNSIGNED NOT NULL,
  party_bill_no    VARCHAR(60) NULL,
  gate_inward_id   BIGINT UNSIGNED NULL,
  gross_amount     DECIMAL(14,2) NOT NULL DEFAULT 0,
  discount_amount  DECIMAL(14,2) NOT NULL DEFAULT 0,
  debit_amount     DECIMAL(14,2) NOT NULL DEFAULT 0 COMMENT 'Debit / recovery from the knitter',
  other_charges    DECIMAL(14,2) NOT NULL DEFAULT 0,
  gst_pct          DECIMAL(5,2) NOT NULL DEFAULT 0,
  gst_amount       DECIMAL(14,2) NOT NULL DEFAULT 0,
  net_amount       DECIMAL(14,2) NOT NULL DEFAULT 0,
  status           VARCHAR(12) NOT NULL DEFAULT 'POSTED',
  remarks          TEXT NULL,
  created_by       BIGINT UNSIGNED NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_knb (company_id, bill_no)
) ENGINE=InnoDB COMMENT='Knitting job-work bill (from knitting GRNs)';

CREATE TABLE IF NOT EXISTS trx_knitting_bill_line (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  bill_id         BIGINT UNSIGNED NOT NULL,
  receipt_id      BIGINT UNSIGNED NOT NULL,
  receipt_no      VARCHAR(50) NULL,
  receipt_date    DATE NULL,
  program_no      VARCHAR(60) NULL,
  io_no           VARCHAR(60) NULL,
  dc_nos          VARCHAR(255) NULL,
  fabric_kg       DECIMAL(14,3) NOT NULL DEFAULT 0,
  quotation_rate  DECIMAL(12,2) NULL,
  rate            DECIMAL(12,2) NOT NULL DEFAULT 0,
  amount          DECIMAL(14,2) NOT NULL DEFAULT 0,
  KEY ix_knbl (bill_id)
) ENGINE=InnoDB;

-- ---------- number series ----------
INSERT INTO cfg_number_series (company_id, branch_id, doc_type, fy_id, prefix, next_number, padding)
SELECT c.id, NULL, d.dt, NULL, d.px, 1, 5 FROM mst_company c
JOIN (SELECT 'YARN_SUBSTITUTION' dt, 'YSR-' px UNION ALL SELECT 'KNIT_BILL', 'KNB-') d
WHERE NOT EXISTS (SELECT 1 FROM cfg_number_series s WHERE s.company_id = c.id AND s.doc_type = d.dt AND s.branch_id IS NULL AND s.fy_id IS NULL);

-- ---------- settings ----------
INSERT IGNORE INTO cfg_system_setting (company_id, setting_key, setting_value, description)
SELECT c.id, t.k, t.v, t.d FROM mst_company c
JOIN (SELECT 'PROCESS_QUOTATION_REQUIRED' k, '1' v, '1 = a knitting / fabric process / yarn process DC can go out only against an accepted process quotation of the vendor (its rate is used for the bill)' d UNION ALL
      SELECT 'GATE_ENTRY_REQUIRED_FOR_INWARD', '1', '1 = every process inward (knitting GRN, fabric / yarn process GRN, yarn return) must be mapped to its gate entry' UNION ALL
      SELECT 'JOB_TRANSFER_APPROVAL', '1', '1 = job-to-job stock transfers wait for approval (users with the approve right post them directly)') t;
