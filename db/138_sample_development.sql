-- =====================================================================
-- 138 · Sample development → order profitability (client 23-Oct-2026: "Sample-to-Order Profitability"
--   specification + voice note: "if a sample becomes a confirmed order, bring its cost into that order's P&L")
--
--   mst_sample_type / _workflow / _workflow_stage   sample types and their versioned stage templates
--   trx_sample (extended)                           request: priority, owner, workflow version, revision, status model
--   trx_sample_process (+ _log)                     stage instances: owner, start / hold / resume / complete / skip,
--                                                   good / reject / rework qty, labour minutes, rework link
--   trx_sample_cost                                 sample cost ledger (draft → submitted → approved → posted,
--                                                   reversal entries; one active entry per source line)
--   trx_sample_revision / _qc / _submission / _decision   QC, buyer submissions, internal / buyer decisions, revisions
--   trx_sample_alloc_batch / _alloc_line            allocation of posted sample cost to confirmed sales orders
--                                                   (analytical attribution — no GL journal; shows in order P&L)
--   trx_sample_audit                                sample timeline (who / when / what / why)
-- Idempotent: the runner re-applies files >= 10 on every deploy.
-- =====================================================================

-- ------------------------------------------------------------ sample types & workflow templates
CREATE TABLE IF NOT EXISTS mst_sample_type (
  id           BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id   BIGINT UNSIGNED NOT NULL,
  type_code    VARCHAR(30) NOT NULL,
  type_name    VARCHAR(80) NOT NULL,
  category     ENUM('DEVELOPMENT','FIT','SALES','PRE_PRODUCTION','OTHER') NOT NULL DEFAULT 'OTHER',
  description  VARCHAR(255) NULL,
  sort_order   INT NOT NULL DEFAULT 0,
  is_active    TINYINT(1) NOT NULL DEFAULT 1,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_sample_type (company_id, type_code)
) ENGINE=InnoDB COMMENT='Sample types (Proto, Fit, SMS, Size set, PP, TOP …)';

CREATE TABLE IF NOT EXISTS mst_sample_workflow (
  id             BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id     BIGINT UNSIGNED NOT NULL,
  sample_type_id BIGINT UNSIGNED NOT NULL,
  version_no     INT NOT NULL DEFAULT 1,
  is_current     TINYINT(1) NOT NULL DEFAULT 1 COMMENT 'The version new samples of the type start with',
  effective_from DATE NULL,
  remarks        VARCHAR(255) NULL,
  created_by     BIGINT UNSIGNED NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_sample_wf (sample_type_id, version_no),
  KEY ix_sample_wf_type (company_id, sample_type_id, is_current)
) ENGINE=InnoDB COMMENT='Versioned stage template of a sample type — a sample keeps the version it was created with';

CREATE TABLE IF NOT EXISTS mst_sample_workflow_stage (
  id            BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  workflow_id   BIGINT UNSIGNED NOT NULL,
  seq_no        INT NOT NULL,
  step_group    INT NOT NULL COMMENT 'Stages with the same group run in parallel; a group starts when every mandatory stage of the earlier groups is done',
  stage_code    VARCHAR(30) NOT NULL,
  stage_name    VARCHAR(80) NOT NULL,
  department_id BIGINT UNSIGNED NULL,
  is_mandatory  TINYINT(1) NOT NULL DEFAULT 1,
  sla_days      DECIMAL(6,2) NULL,
  needs_output  TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'Completion asks for good / reject / rework quantity',
  KEY ix_sample_wfs (workflow_id, seq_no)
) ENGINE=InnoDB;

-- ------------------------------------------------------------ sample request (extend the existing table)
SET @x = (SELECT DATA_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_sample' AND COLUMN_NAME='sample_type');
SET @s = IF(@x='enum', 'ALTER TABLE trx_sample MODIFY sample_type VARCHAR(30) NOT NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

DROP PROCEDURE IF EXISTS _smp_add_col;
CREATE PROCEDURE _smp_add_col(IN t VARCHAR(64), IN c VARCHAR(64), IN ddl VARCHAR(500))
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = t AND COLUMN_NAME = c) THEN
    SET @q = CONCAT('ALTER TABLE ', t, ' ADD COLUMN ', c, ' ', ddl);
    PREPARE s1 FROM @q; EXECUTE s1; DEALLOCATE PREPARE s1;
  END IF;
END;

CALL _smp_add_col('trx_sample', 'branch_id',       'BIGINT UNSIGNED NULL AFTER company_id');
CALL _smp_add_col('trx_sample', 'sample_type_id',  'BIGINT UNSIGNED NULL AFTER sample_type');
CALL _smp_add_col('trx_sample', 'workflow_id',     'BIGINT UNSIGNED NULL COMMENT ''Workflow version the sample was created with'' AFTER sample_type_id');
CALL _smp_add_col('trx_sample', 'status',          'VARCHAR(30) NOT NULL DEFAULT ''DRAFT'' COMMENT ''DRAFT / SUBMITTED / IN_PROGRESS / ON_HOLD / PENDING_INTERNAL_APPROVAL / INTERNALLY_APPROVED / SUBMITTED_TO_BUYER / REVISION_REQUIRED / APPROVED / REJECTED / COMPLETED / CANCELLED'' AFTER status_id');
CALL _smp_add_col('trx_sample', 'priority',        'VARCHAR(10) NOT NULL DEFAULT ''NORMAL'' COMMENT ''NORMAL / HIGH / CRITICAL'' AFTER qty');
CALL _smp_add_col('trx_sample', 'uom_id',          'SMALLINT UNSIGNED NULL AFTER qty');
CALL _smp_add_col('trx_sample', 'merchandiser_id', 'BIGINT UNSIGNED NULL');
CALL _smp_add_col('trx_sample', 'coordinator_id',  'BIGINT UNSIGNED NULL');
CALL _smp_add_col('trx_sample', 'instructions',    'TEXT NULL');
CALL _smp_add_col('trx_sample', 'revision_no',     'INT NOT NULL DEFAULT 0 COMMENT ''0 = first build; each resubmission adds 1''');
CALL _smp_add_col('trx_sample', 'buyer_decision',  'VARCHAR(20) NULL COMMENT ''Latest buyer decision: APPROVED / REJECTED / CHANGES_REQUESTED''');
CALL _smp_add_col('trx_sample', 'good_qty',        'DECIMAL(12,2) NULL COMMENT ''Good pieces (latest QC pass, else the last stage output)''');
CALL _smp_add_col('trx_sample', 'completed_date',  'DATE NULL COMMENT ''All stages of the current revision done''');
CALL _smp_add_col('trx_sample', 'closed_at',       'DATETIME NULL');
CALL _smp_add_col('trx_sample', 'recovered_amount','DECIMAL(19,4) NOT NULL DEFAULT 0 COMMENT ''Sample charge paid by the buyer (INR) — reduces the cost that can be allocated''');
CALL _smp_add_col('trx_sample', 'cancel_reason',   'VARCHAR(255) NULL');
CALL _smp_add_col('trx_sample', 'row_version',     'INT NOT NULL DEFAULT 1');
DROP PROCEDURE IF EXISTS _smp_add_col;

SET @x = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_sample' AND INDEX_NAME='ix_sample_status');
SET @s = IF(@x=0, 'ALTER TABLE trx_sample ADD KEY ix_sample_status (company_id, status, target_date)', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- ------------------------------------------------------------ process tracking
CREATE TABLE IF NOT EXISTS trx_sample_process (
  id                     BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  sample_id              BIGINT UNSIGNED NOT NULL,
  revision_no            INT NOT NULL DEFAULT 0,
  workflow_stage_id      BIGINT UNSIGNED NULL,
  seq_no                 INT NOT NULL,
  step_group             INT NOT NULL,
  stage_code             VARCHAR(30) NOT NULL,
  stage_name             VARCHAR(80) NOT NULL,
  department_id          BIGINT UNSIGNED NULL,
  is_mandatory           TINYINT(1) NOT NULL DEFAULT 1,
  sla_days               DECIMAL(6,2) NULL,
  needs_output           TINYINT(1) NOT NULL DEFAULT 0,
  assigned_user_id       BIGINT UNSIGNED NULL COMMENT 'Employee (ERP user)',
  assigned_contractor_id BIGINT UNSIGNED NULL COMMENT 'Contractor / job worker (party)',
  status                 VARCHAR(16) NOT NULL DEFAULT 'NOT_STARTED' COMMENT 'NOT_STARTED / IN_PROGRESS / ON_HOLD / COMPLETED / SKIPPED / CANCELLED',
  planned_date           DATE NULL,
  started_at             DATETIME NULL,
  completed_at           DATETIME NULL,
  hold_since             DATETIME NULL,
  hold_minutes           INT NOT NULL DEFAULT 0 COMMENT 'Time on hold (excluded from process age)',
  hold_reason            VARCHAR(255) NULL,
  skip_reason            VARCHAR(255) NULL,
  input_qty              DECIMAL(12,2) NULL,
  good_qty               DECIMAL(12,2) NULL,
  reject_qty             DECIMAL(12,2) NULL,
  rework_qty             DECIMAL(12,2) NULL,
  labour_minutes         DECIMAL(10,2) NULL,
  rework_of_process_id   BIGINT UNSIGNED NULL,
  remarks                VARCHAR(500) NULL,
  last_activity_at       DATETIME NULL,
  created_at             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_smp_proc (sample_id, revision_no, seq_no),
  KEY ix_smp_proc_owner (status, department_id, assigned_user_id)
) ENGINE=InnoDB COMMENT='Stage instances of a sample (snapshot of the workflow version)';

CREATE TABLE IF NOT EXISTS trx_sample_process_log (
  id          BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  sample_id   BIGINT UNSIGNED NOT NULL,
  process_id  BIGINT UNSIGNED NOT NULL,
  action      VARCHAR(16) NOT NULL COMMENT 'START / HOLD / RESUME / COMPLETE / REASSIGN / SKIP / REOPEN',
  from_status VARCHAR(16) NULL,
  to_status   VARCHAR(16) NULL,
  good_qty    DECIMAL(12,2) NULL,
  reject_qty  DECIMAL(12,2) NULL,
  rework_qty  DECIMAL(12,2) NULL,
  minutes     DECIMAL(10,2) NULL,
  reason      VARCHAR(255) NULL,
  details     JSON NULL,
  user_id     BIGINT UNSIGNED NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_smp_plog (process_id),
  KEY ix_smp_plog_s (sample_id)
) ENGINE=InnoDB;

-- ------------------------------------------------------------ cost ledger
CREATE TABLE IF NOT EXISTS trx_sample_cost (
  id               BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id       BIGINT UNSIGNED NOT NULL,
  sample_id        BIGINT UNSIGNED NOT NULL,
  process_id       BIGINT UNSIGNED NULL,
  revision_no      INT NOT NULL DEFAULT 0,
  cost_date        DATE NOT NULL,
  category         VARCHAR(16) NOT NULL COMMENT 'MATERIAL / LABOUR / CAD_PATTERN / SUBCONTRACT / CONSUMABLE / COURIER / REWORK / OVERHEAD / ADJUSTMENT',
  description      VARCHAR(255) NOT NULL,
  qty              DECIMAL(18,4) NULL,
  uom_id           SMALLINT UNSIGNED NULL,
  rate             DECIMAL(18,4) NULL,
  currency_id      SMALLINT UNSIGNED NULL,
  exchange_rate    DECIMAL(18,6) NOT NULL DEFAULT 1,
  amount_fc        DECIMAL(19,4) NOT NULL COMMENT 'Amount in the entry currency (signed: reversals are negative)',
  amount           DECIMAL(19,4) NOT NULL COMMENT 'Amount in INR (base currency)',
  basis            VARCHAR(10) NOT NULL DEFAULT 'ACTUAL' COMMENT 'ACTUAL / STANDARD / ALLOCATED (overhead)',
  source_type      VARCHAR(20) NOT NULL DEFAULT 'MANUAL' COMMENT 'MANUAL / GENERAL_PURCHASE / PROCESS_LABOUR / REVERSAL',
  source_id        BIGINT UNSIGNED NULL,
  source_line_id   BIGINT UNSIGNED NULL,
  source_ref       VARCHAR(80) NULL COMMENT 'Document no of the source (bill, DC, courier AWB …)',
  source_key       VARCHAR(80) NULL COMMENT 'Duplicate guard: one live entry per source line (cleared when rejected / reversed)',
  status           VARCHAR(12) NOT NULL DEFAULT 'DRAFT' COMMENT 'DRAFT / SUBMITTED / APPROVED / POSTED / REVERSED / REJECTED',
  reversal_of_id   BIGINT UNSIGNED NULL,
  reason           VARCHAR(255) NULL COMMENT 'Reject / reverse reason',
  created_by       BIGINT UNSIGNED NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  submitted_by     BIGINT UNSIGNED NULL,
  submitted_at     DATETIME NULL,
  approved_by      BIGINT UNSIGNED NULL,
  approved_at      DATETIME NULL,
  posted_by        BIGINT UNSIGNED NULL,
  posted_at        DATETIME NULL,
  updated_at       DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_smp_cost_src (company_id, source_key),
  KEY ix_smp_cost (sample_id, status, cost_date),
  KEY ix_smp_cost_date (company_id, cost_date)
) ENGINE=InnoDB COMMENT='Sample cost ledger — the single source of sample cost';

-- ------------------------------------------------------------ revisions, QC, submissions, decisions
CREATE TABLE IF NOT EXISTS trx_sample_revision (
  id            BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  sample_id     BIGINT UNSIGNED NOT NULL,
  revision_no   INT NOT NULL,
  revision_type VARCHAR(12) NOT NULL DEFAULT 'INITIAL' COMMENT 'INITIAL / BUYER / INTERNAL',
  comments      TEXT NULL COMMENT 'What has to change (buyer / internal comments)',
  status        VARCHAR(12) NOT NULL DEFAULT 'OPEN' COMMENT 'OPEN / SUBMITTED / APPROVED / REJECTED / SUPERSEDED',
  requested_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  requested_by  BIGINT UNSIGNED NULL,
  submitted_at  DATETIME NULL,
  closed_at     DATETIME NULL,
  UNIQUE KEY uq_smp_rev (sample_id, revision_no)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS trx_sample_qc (
  id                 BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  sample_id          BIGINT UNSIGNED NOT NULL,
  revision_no        INT NOT NULL DEFAULT 0,
  process_id         BIGINT UNSIGNED NULL,
  inspection_date    DATE NOT NULL,
  checked_qty        DECIMAL(12,2) NOT NULL DEFAULT 0,
  passed_qty         DECIMAL(12,2) NOT NULL DEFAULT 0,
  rejected_qty       DECIMAL(12,2) NOT NULL DEFAULT 0,
  rework_qty         DECIMAL(12,2) NOT NULL DEFAULT 0,
  measurement_result VARCHAR(16) NOT NULL DEFAULT 'NOT_CHECKED' COMMENT 'OK / OUT_OF_TOLERANCE / NOT_CHECKED',
  measurements       JSON NULL COMMENT '[{point, spec, actual, tolerance, ok}]',
  defects            JSON NULL COMMENT '[{defect_id, defect_name, severity, qty}]',
  result             VARCHAR(8) NOT NULL COMMENT 'PASS / FAIL',
  disposition        VARCHAR(8) NOT NULL COMMENT 'ACCEPT / REWORK / REJECT',
  rework_process_id  BIGINT UNSIGNED NULL COMMENT 'Rework stage created by this inspection',
  remarks            VARCHAR(500) NULL,
  inspected_by       BIGINT UNSIGNED NULL,
  created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_smp_qc (sample_id, revision_no)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS trx_sample_submission (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  sample_id       BIGINT UNSIGNED NOT NULL,
  revision_no     INT NOT NULL DEFAULT 0,
  submission_date DATE NOT NULL,
  qty             DECIMAL(12,2) NOT NULL,
  courier_name    VARCHAR(80) NULL,
  tracking_no     VARCHAR(60) NULL,
  sent_to         VARCHAR(120) NULL,
  evidence_url    VARCHAR(300) NULL,
  remarks         VARCHAR(500) NULL,
  recorded_by     BIGINT UNSIGNED NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_smp_sub (sample_id, revision_no)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS trx_sample_decision (
  id            BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  sample_id     BIGINT UNSIGNED NOT NULL,
  revision_no   INT NOT NULL DEFAULT 0,
  stage         VARCHAR(10) NOT NULL COMMENT 'INTERNAL / BUYER',
  decision      VARCHAR(20) NOT NULL COMMENT 'APPROVED / REJECTED / CHANGES_REQUESTED',
  decision_date DATE NOT NULL,
  comments      TEXT NULL,
  decided_by    BIGINT UNSIGNED NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_smp_dec (sample_id, revision_no)
) ENGINE=InnoDB;

-- ------------------------------------------------------------ allocation to orders
CREATE TABLE IF NOT EXISTS trx_sample_alloc_batch (
  id               BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id       BIGINT UNSIGNED NOT NULL,
  batch_no         VARCHAR(40) NOT NULL,
  sample_id        BIGINT UNSIGNED NOT NULL,
  method           VARCHAR(10) NOT NULL COMMENT 'PERCENT / QUANTITY / VALUE / EQUAL / MANUAL',
  accounting_mode  VARCHAR(12) NOT NULL DEFAULT 'ANALYTICAL' COMMENT 'ANALYTICAL = management P&L only, no GL journal',
  amount_to_allocate DECIMAL(19,4) NOT NULL COMMENT 'INR split across the orders (≤ unallocated balance when posted)',
  total_allocated  DECIMAL(19,4) NOT NULL DEFAULT 0,
  status           VARCHAR(20) NOT NULL DEFAULT 'DRAFT' COMMENT 'DRAFT / PENDING_APPROVAL / APPROVED / POSTED / PARTIALLY_REVERSED / REVERSED / REJECTED / CANCELLED',
  reason           VARCHAR(255) NOT NULL,
  override_reason  VARCHAR(255) NULL COMMENT 'Why an order of another buyer / style is included',
  reject_reason    VARCHAR(255) NULL,
  created_by       BIGINT UNSIGNED NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  submitted_by     BIGINT UNSIGNED NULL,
  submitted_at     DATETIME NULL,
  approved_by      BIGINT UNSIGNED NULL,
  approved_at      DATETIME NULL,
  posted_by        BIGINT UNSIGNED NULL,
  posted_at        DATETIME NULL,
  row_version      INT NOT NULL DEFAULT 1,
  updated_at       DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_smp_alloc_no (company_id, batch_no),
  KEY ix_smp_alloc (sample_id, status)
) ENGINE=InnoDB COMMENT='Sample cost allocation batch (sample → one or more confirmed orders)';

CREATE TABLE IF NOT EXISTS trx_sample_alloc_line (
  id               BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  batch_id         BIGINT UNSIGNED NOT NULL,
  so_id            BIGINT UNSIGNED NOT NULL,
  basis_pct        DECIMAL(9,4) NULL,
  basis_qty        DECIMAL(14,2) NULL COMMENT 'Order qty of the sample style on the order',
  basis_value      DECIMAL(19,4) NULL COMMENT 'Order value (INR) of the sample style on the order',
  manual_amount    DECIMAL(19,4) NULL,
  allocated_amount DECIMAL(19,4) NOT NULL DEFAULT 0,
  is_override      TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'Order of another buyer / without the sample style',
  status           VARCHAR(10) NOT NULL DEFAULT 'ACTIVE' COMMENT 'ACTIVE / REVERSED',
  reversed_by      BIGINT UNSIGNED NULL,
  reversed_at      DATETIME NULL,
  reverse_reason   VARCHAR(255) NULL,
  UNIQUE KEY uq_smp_alloc_line (batch_id, so_id),
  KEY ix_smp_alloc_so (so_id, status)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS trx_sample_audit (
  id          BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id  BIGINT UNSIGNED NOT NULL,
  sample_id   BIGINT UNSIGNED NOT NULL,
  entity      VARCHAR(20) NOT NULL COMMENT 'SAMPLE / PROCESS / COST / QC / SUBMISSION / DECISION / REVISION / ALLOCATION / ATTACHMENT',
  entity_id   BIGINT UNSIGNED NULL,
  action      VARCHAR(30) NOT NULL,
  old_values  JSON NULL,
  new_values  JSON NULL,
  reason      VARCHAR(500) NULL,
  user_id     BIGINT UNSIGNED NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_smp_audit (sample_id, id)
) ENGINE=InnoDB;

-- ------------------------------------------------------------ seed: sample types with a starting workflow (per company)
INSERT IGNORE INTO mst_sample_type (company_id, type_code, type_name, category, sort_order)
SELECT c.id, t.code, t.name, t.cat, t.ord FROM mst_company c
  JOIN (SELECT 'PROTO' code, 'Proto sample' name, 'DEVELOPMENT' cat, 1 ord UNION ALL
        SELECT 'FIT', 'Fit sample', 'FIT', 2 UNION ALL
        SELECT 'SIZE_SET', 'Size set', 'FIT', 3 UNION ALL
        SELECT 'SMS', 'Salesman sample (SMS)', 'SALES', 4 UNION ALL
        SELECT 'PHOTO', 'Photo sample', 'SALES', 5 UNION ALL
        SELECT 'PP', 'Pre-production (PP)', 'PRE_PRODUCTION', 6 UNION ALL
        SELECT 'TOP', 'Top of production (TOP)', 'PRE_PRODUCTION', 7 UNION ALL
        SELECT 'SHIPMENT', 'Shipment sample', 'OTHER', 8) t;

-- types already typed on samples (when types were a fixed list) stay valid
INSERT IGNORE INTO mst_sample_type (company_id, type_code, type_name, category, sort_order)
SELECT DISTINCT s.company_id, s.sample_type, s.sample_type, 'OTHER', 99 FROM trx_sample s WHERE COALESCE(s.sample_type, '') <> '';

INSERT INTO mst_sample_workflow (company_id, sample_type_id, version_no, is_current, effective_from, remarks)
SELECT t.company_id, t.id, 1, 1, CURDATE(), 'Starting template — edit in Sample types' FROM mst_sample_type t
 WHERE NOT EXISTS (SELECT 1 FROM mst_sample_workflow w WHERE w.sample_type_id = t.id);

-- default stages of a version-1 template that has none (development flow from the specification §5)
INSERT INTO mst_sample_workflow_stage (workflow_id, seq_no, step_group, stage_code, stage_name, is_mandatory, sla_days, needs_output)
SELECT w.id, s.seq, s.grp, s.code, s.name, s.mand, s.sla, s.outp
  FROM mst_sample_workflow w JOIN mst_sample_type t ON t.id = w.sample_type_id
  JOIN (SELECT 1 seq, 1 grp, 'MERCH_REVIEW' code, 'Merchandising review' name, 1 mand, 1.0 sla, 0 outp UNION ALL
        SELECT 2, 2, 'PATTERN', 'Pattern / CAD', 1, 2.0, 0 UNION ALL
        SELECT 3, 3, 'MATERIAL', 'Material issue', 1, 1.0, 0 UNION ALL
        SELECT 4, 4, 'CUTTING', 'Cutting', 1, 1.0, 1 UNION ALL
        SELECT 5, 5, 'EMB_PRINT', 'Embroidery / printing', 0, 2.0, 1 UNION ALL
        SELECT 6, 6, 'SEWING', 'Sewing', 1, 2.0, 1 UNION ALL
        SELECT 7, 7, 'FINISHING', 'Finishing / packing', 1, 1.0, 1 UNION ALL
        SELECT 8, 8, 'QC', 'QC / technical check', 1, 1.0, 1) s
 WHERE w.version_no = 1 AND t.category IN ('DEVELOPMENT','FIT','OTHER')
   AND NOT EXISTS (SELECT 1 FROM mst_sample_workflow_stage x WHERE x.workflow_id = w.id);
INSERT INTO mst_sample_workflow_stage (workflow_id, seq_no, step_group, stage_code, stage_name, is_mandatory, sla_days, needs_output)
SELECT w.id, s.seq, s.grp, s.code, s.name, s.mand, s.sla, s.outp
  FROM mst_sample_workflow w JOIN mst_sample_type t ON t.id = w.sample_type_id
  JOIN (SELECT 1 seq, 1 grp, 'MATERIAL' code, 'Material issue' name, 1 mand, 1.0 sla, 0 outp UNION ALL
        SELECT 2, 2, 'CUTTING', 'Cutting', 1, 1.0, 1 UNION ALL
        SELECT 3, 3, 'EMB_PRINT', 'Embroidery / printing', 0, 2.0, 1 UNION ALL
        SELECT 4, 4, 'SEWING', 'Sewing', 1, 2.0, 1 UNION ALL
        SELECT 5, 5, 'FINISHING', 'Finishing / packing', 1, 1.0, 1 UNION ALL
        SELECT 6, 6, 'QC', 'QC / technical check', 1, 1.0, 1) s
 WHERE w.version_no = 1 AND t.category IN ('SALES','PRE_PRODUCTION')
   AND NOT EXISTS (SELECT 1 FROM mst_sample_workflow_stage x WHERE x.workflow_id = w.id);

-- existing samples: link their type; the status follows the old status / approval fields
UPDATE trx_sample s JOIN mst_sample_type t ON t.company_id = s.company_id AND t.type_code = s.sample_type
   SET s.sample_type_id = t.id WHERE s.sample_type_id IS NULL;
UPDATE trx_sample s LEFT JOIN cfg_status cs ON cs.id = s.status_id
   SET s.status = CASE
         WHEN s.approval_status = 'APPROVED' OR s.approval_status = 'APPROVED_WITH_COMMENTS' THEN 'APPROVED'
         WHEN s.approval_status = 'REJECTED' THEN 'REJECTED'
         WHEN cs.code = 'SUBMITTED' OR s.submit_date IS NOT NULL THEN 'SUBMITTED_TO_BUYER'
         WHEN cs.code = 'IN_PROGRESS' THEN 'IN_PROGRESS'
         ELSE 'DRAFT' END
 WHERE s.status = 'DRAFT' AND s.row_version = 1 AND NOT EXISTS (SELECT 1 FROM trx_sample_process p WHERE p.sample_id = s.id)
   AND NOT EXISTS (SELECT 1 FROM trx_sample_audit a WHERE a.sample_id = s.id);

-- ------------------------------------------------------------ numbering & settings
INSERT INTO cfg_number_series (company_id, branch_id, doc_type, fy_id, prefix, next_number, padding)
SELECT c.id, NULL, 'SAMPLE', NULL, 'SMP-', 1, 5 FROM mst_company c
 WHERE NOT EXISTS (SELECT 1 FROM cfg_number_series ns WHERE ns.company_id = c.id AND ns.doc_type = 'SAMPLE' AND ns.branch_id IS NULL AND ns.fy_id IS NULL);
-- the series was never moved by samples saved before (SMP-00001 exists with next_number 1): start after the highest number
UPDATE cfg_number_series ns
   SET ns.next_number = GREATEST(ns.next_number, 1 + COALESCE((SELECT MAX(CAST(SUBSTRING(s.sample_no, LENGTH(ns.prefix) + 1) AS UNSIGNED)) FROM trx_sample s
                                                              WHERE s.company_id = ns.company_id AND s.sample_no LIKE CONCAT(ns.prefix, '%')
                                                                AND SUBSTRING(s.sample_no, LENGTH(ns.prefix) + 1) REGEXP '^[0-9]+$'), 0))
 WHERE ns.doc_type = 'SAMPLE' AND ns.branch_id IS NULL AND ns.fy_id IS NULL;
INSERT INTO cfg_number_series (company_id, branch_id, doc_type, fy_id, prefix, next_number, padding)
SELECT c.id, NULL, 'SAMPLE_ALLOC', NULL, 'SCA-', 1, 5 FROM mst_company c
 WHERE NOT EXISTS (SELECT 1 FROM cfg_number_series ns WHERE ns.company_id = c.id AND ns.doc_type = 'SAMPLE_ALLOC' AND ns.branch_id IS NULL AND ns.fy_id IS NULL);
INSERT IGNORE INTO cfg_system_setting (company_id, setting_key, setting_value, description)
SELECT id, 'SAMPLE_LABOUR_RATE_PER_MIN', '0', 'Samples: approved labour rate (₹ per minute) proposed when a stage is completed with labour minutes' FROM mst_company;
INSERT IGNORE INTO cfg_system_setting (company_id, setting_key, setting_value, description)
SELECT id, 'SAMPLE_ALLOC_CATEGORIES', 'MATERIAL,LABOUR,CAD_PATTERN,SUBCONTRACT,CONSUMABLE,COURIER,REWORK,OVERHEAD,ADJUSTMENT', 'Samples: cost categories that can be allocated to orders (finance policy)' FROM mst_company;
INSERT IGNORE INTO cfg_system_setting (company_id, setting_key, setting_value, description)
SELECT id, 'SAMPLE_SEGREGATION', '0', 'Samples: 1 = the person who enters a cost / allocation cannot approve or post it' FROM mst_company;
INSERT IGNORE INTO cfg_system_setting (company_id, setting_key, setting_value, description)
SELECT id, 'SAMPLE_IDLE_DAYS', '3', 'Samples: days without activity before a running sample shows as an exception' FROM mst_company;

-- ------------------------------------------------------------ permissions
INSERT INTO mst_permission (module_id, permission_code, permission_name)
SELECT m.id, t.code, t.name FROM mst_module m
  JOIN (SELECT 'SAMPLE.PROCESS' code, 'Update sample stages (start / hold / complete / reassign)' name UNION ALL
        SELECT 'SAMPLE.QC', 'Record sample QC inspections' UNION ALL
        SELECT 'SAMPLE.APPROVE', 'Internal / buyer approval, submissions, revisions, skip mandatory stage, cancel / reopen' UNION ALL
        SELECT 'SAMPLE.COST', 'Enter sample costs' UNION ALL
        SELECT 'SAMPLE.COST_APPROVE', 'Approve / post / reverse sample costs' UNION ALL
        SELECT 'SAMPLE.ALLOCATE', 'Prepare sample cost allocations to orders' UNION ALL
        SELECT 'SAMPLE.ALLOC_APPROVE', 'Approve / post / reverse sample cost allocations' UNION ALL
        SELECT 'SAMPLE.ADMIN', 'Sample types and workflow templates') t
 WHERE m.module_code = 'SAMPLE' AND NOT EXISTS (SELECT 1 FROM mst_permission x WHERE x.permission_code = t.code);

-- one-time grants (a later change on the Roles screen is not undone by the next deploy)
INSERT INTO map_role_permission (role_id, permission_id)
SELECT r.id, p.id FROM mst_role r JOIN mst_permission p ON p.permission_code LIKE 'SAMPLE.%'
 WHERE r.role_code IN ('SUPER_ADMIN','ADMIN')
   AND NOT EXISTS (SELECT 1 FROM cfg_system_setting g WHERE g.company_id = r.company_id AND g.setting_key = 'SAMPLE_PERMS_GRANTED')
   AND NOT EXISTS (SELECT 1 FROM map_role_permission m WHERE m.role_id = r.id AND m.permission_id = p.id);
-- whoever runs samples (SAMPLE.UPDATE — merchandisers) runs the stages, QC, approvals and enters costs / allocations
INSERT INTO map_role_permission (role_id, permission_id)
SELECT DISTINCT mrp.role_id, p.id FROM map_role_permission mrp
  JOIN mst_role r ON r.id = mrp.role_id
  JOIN mst_permission src ON src.id = mrp.permission_id AND src.permission_code = 'SAMPLE.UPDATE'
  JOIN mst_permission p ON p.permission_code IN ('SAMPLE.PROCESS','SAMPLE.QC','SAMPLE.APPROVE','SAMPLE.COST','SAMPLE.ALLOCATE')
 WHERE NOT EXISTS (SELECT 1 FROM cfg_system_setting g WHERE g.company_id = r.company_id AND g.setting_key = 'SAMPLE_PERMS_GRANTED')
   AND NOT EXISTS (SELECT 1 FROM map_role_permission m WHERE m.role_id = mrp.role_id AND m.permission_id = p.id);
-- finance (costing approvers / accountants) approve and post costs and allocations
INSERT INTO map_role_permission (role_id, permission_id)
SELECT DISTINCT r.id, p.id FROM mst_role r
  JOIN mst_permission p ON p.permission_code IN ('SAMPLE.VIEW','SAMPLE.COST','SAMPLE.COST_APPROVE','SAMPLE.ALLOCATE','SAMPLE.ALLOC_APPROVE')
 WHERE (r.role_code = 'ACCOUNTANT' OR EXISTS (SELECT 1 FROM map_role_permission x JOIN mst_permission xp ON xp.id = x.permission_id
                                              WHERE x.role_id = r.id AND xp.permission_code = 'COSTING.APPROVE'))
   AND NOT EXISTS (SELECT 1 FROM cfg_system_setting g WHERE g.company_id = r.company_id AND g.setting_key = 'SAMPLE_PERMS_GRANTED')
   AND NOT EXISTS (SELECT 1 FROM map_role_permission m WHERE m.role_id = r.id AND m.permission_id = p.id);
-- QC roles inspect; production roles run stages
INSERT INTO map_role_permission (role_id, permission_id)
SELECT DISTINCT r.id, p.id FROM mst_role r JOIN mst_permission p ON p.permission_code IN ('SAMPLE.VIEW','SAMPLE.QC')
 WHERE r.role_code IN ('QA','QC_INSPECTOR')
   AND NOT EXISTS (SELECT 1 FROM cfg_system_setting g WHERE g.company_id = r.company_id AND g.setting_key = 'SAMPLE_PERMS_GRANTED')
   AND NOT EXISTS (SELECT 1 FROM map_role_permission m WHERE m.role_id = r.id AND m.permission_id = p.id);
INSERT INTO map_role_permission (role_id, permission_id)
SELECT DISTINCT r.id, p.id FROM mst_role r JOIN mst_permission p ON p.permission_code IN ('SAMPLE.VIEW','SAMPLE.PROCESS')
 WHERE r.role_code IN ('PRODUCTION_MANAGER','PRODUCTION_USER')
   AND NOT EXISTS (SELECT 1 FROM cfg_system_setting g WHERE g.company_id = r.company_id AND g.setting_key = 'SAMPLE_PERMS_GRANTED')
   AND NOT EXISTS (SELECT 1 FROM map_role_permission m WHERE m.role_id = r.id AND m.permission_id = p.id);
INSERT IGNORE INTO cfg_system_setting (company_id, setting_key, setting_value, description)
SELECT id, 'SAMPLE_PERMS_GRANTED', '1', 'Sample module permissions granted to the standard roles (one time, migration 138)' FROM mst_company;
