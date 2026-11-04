-- =====================================================================
-- 152 · Lab management — washing, garment sample & textile testing (client spec "C-ONE ERP Lab Management",
--   v1.0 02-Nov-2026, Phase 1: masters, request, sample inward + ledger, trials + wash recipe, measurements,
--   server-side calculation / evaluation, dual approval (Lab In-charge → QA Manager), immutable report revisions,
--   release + production reference).
--
--   masters      mst_lab_test_category · mst_lab_unit · mst_lab_test_method · mst_lab_test_parameter
--                mst_lab_test_plan (versioned) · mst_lab_test_plan_param · mst_lab_machine · mst_lab_wash_process
--   request      trx_lab_request · trx_lab_request_item
--   sample       trx_lab_sample (Sample ID + secure QR token) · trx_lab_sample_txn (custody / quantity ledger)
--   trial        trx_lab_trial · trx_lab_trial_stage · trx_lab_trial_chemical · trx_lab_trial_measurement
--                trx_lab_trial_result · trx_lab_trial_deviation
--   report       trx_lab_report (revisioned, snapshot JSON + sha256) · trx_lab_report_approval
--                trx_lab_production_ref
--   shared       trx_lab_attachment (private files) · trx_lab_audit (before / after timeline)
--
-- Idempotent and non-destructive: the runner re-applies files >= 10 on every deploy. No cascade deletes.
-- =====================================================================

-- ------------------------------------------------------------ masters
CREATE TABLE IF NOT EXISTS mst_lab_test_category (
  id          BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id  BIGINT UNSIGNED NOT NULL,
  code        VARCHAR(30) NOT NULL,
  name        VARCHAR(80) NOT NULL,
  description VARCHAR(255) NULL,
  sort_order  INT NOT NULL DEFAULT 0,
  is_active   TINYINT(1) NOT NULL DEFAULT 1,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_lab_cat (company_id, code)
) ENGINE=InnoDB COMMENT='Lab: test categories (Washing, Garment, Physical, Chemical, Buyer-specific)';

CREATE TABLE IF NOT EXISTS mst_lab_unit (
  id          BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id  BIGINT UNSIGNED NOT NULL,
  code        VARCHAR(20) NOT NULL,
  name        VARCHAR(60) NOT NULL,
  symbol      VARCHAR(20) NULL,
  dimension   VARCHAR(30) NULL COMMENT 'LENGTH / MASS / RATIO / GRADE / FORCE / PRESSURE / COUNT / TEMPERATURE / TIME / VOLUME / CONCENTRATION / OTHER',
  is_active   TINYINT(1) NOT NULL DEFAULT 1,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_lab_unit (company_id, code)
) ENGINE=InnoDB COMMENT='Lab: measurement units';

CREATE TABLE IF NOT EXISTS mst_lab_test_method (
  id                 BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id         BIGINT UNSIGNED NOT NULL,
  method_code        VARCHAR(40) NOT NULL,
  name               VARCHAR(120) NOT NULL,
  standard_reference VARCHAR(120) NULL COMMENT 'e.g. the buyer / ISO / AATCC standard the method follows',
  revision           VARCHAR(20) NULL,
  instructions       TEXT NULL COMMENT 'Work instruction',
  is_active          TINYINT(1) NOT NULL DEFAULT 1,
  created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_lab_method (company_id, method_code)
) ENGINE=InnoDB COMMENT='Lab: test methods';

CREATE TABLE IF NOT EXISTS mst_lab_test_parameter (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  category_id     BIGINT UNSIGNED NULL,
  code            VARCHAR(40) NOT NULL,
  name            VARCHAR(120) NOT NULL,
  description     VARCHAR(255) NULL,
  input_type      VARCHAR(20) NOT NULL DEFAULT 'NUMERIC' COMMENT 'NUMERIC / BEFORE_AFTER / MULTI_READING / GRADE / PASS_FAIL / DROPDOWN / TEXT / PHOTO',
  data_type       VARCHAR(10) NOT NULL DEFAULT 'DECIMAL' COMMENT 'DECIMAL / TEXT',
  formula_code    VARCHAR(20) NOT NULL DEFAULT 'DIRECT' COMMENT 'DIRECT / SHRINKAGE_PCT / CHANGE_PCT / AVERAGE / MIN / MAX / NONE',
  unit_id         BIGINT UNSIGNED NULL COMMENT 'Unit of the result',
  reading_unit_id BIGINT UNSIGNED NULL COMMENT 'Unit of the raw readings (e.g. CM for shrinkage %)',
  precision_dp    TINYINT UNSIGNED NOT NULL DEFAULT 2,
  allowed_values  VARCHAR(500) NULL COMMENT 'Dropdown / grade choices, comma separated',
  default_method_id BIGINT UNSIGNED NULL,
  is_active       TINYINT(1) NOT NULL DEFAULT 1,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_lab_param (company_id, code),
  KEY ix_lab_param_cat (company_id, category_id),
  CONSTRAINT ck_lab_param_dp CHECK (precision_dp <= 6)
) ENGINE=InnoDB COMMENT='Lab: test parameters (what is measured, how it is calculated)';

CREATE TABLE IF NOT EXISTS mst_lab_test_plan (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  plan_code       VARCHAR(40) NOT NULL,
  version_no      INT NOT NULL DEFAULT 1,
  name            VARCHAR(120) NOT NULL,
  buyer_id        BIGINT UNSIGNED NULL,
  product_id      BIGINT UNSIGNED NULL COMMENT 'Product category',
  fabric_type     VARCHAR(40) NULL,
  composition_id  INT UNSIGNED NULL,
  style_id        BIGINT UNSIGNED NULL,
  test_scope      VARCHAR(120) NULL COMMENT 'Request types this plan applies to (comma list); NULL = any',
  effective_from  DATE NULL,
  effective_to    DATE NULL,
  status          VARCHAR(12) NOT NULL DEFAULT 'DRAFT' COMMENT 'DRAFT / ACTIVE / INACTIVE / SUPERSEDED',
  remarks         VARCHAR(255) NULL,
  created_by      BIGINT UNSIGNED NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_lab_plan (company_id, plan_code, version_no),
  KEY ix_lab_plan_appl (company_id, status, buyer_id, style_id)
) ENGINE=InnoDB COMMENT='Lab: versioned test plans — a version used by a request is never changed';

CREATE TABLE IF NOT EXISTS mst_lab_test_plan_param (
  id                BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  plan_id           BIGINT UNSIGNED NOT NULL,
  parameter_id      BIGINT UNSIGNED NOT NULL,
  method_id         BIGINT UNSIGNED NULL,
  seq_no            INT NOT NULL DEFAULT 0,
  is_mandatory      TINYINT(1) NOT NULL DEFAULT 1,
  repeat_count      TINYINT UNSIGNED NOT NULL DEFAULT 1 COMMENT 'Readings (pairs) required',
  min_value         DECIMAL(18,6) NULL,
  max_value         DECIMAL(18,6) NULL,
  target_value      DECIMAL(18,6) NULL,
  tolerance         DECIMAL(18,6) NULL COMMENT 'target ± tolerance when min / max are not given',
  borderline_band   DECIMAL(18,6) NULL COMMENT 'Within the limits but this close to a limit = BORDERLINE',
  pass_values       VARCHAR(500) NULL COMMENT 'Qualitative pass criteria (comma list)',
  evidence_required TINYINT(1) NOT NULL DEFAULT 0,
  remarks           VARCHAR(255) NULL,
  UNIQUE KEY uq_lab_plan_param (plan_id, parameter_id),
  KEY ix_lab_plan_param (plan_id, seq_no),
  CONSTRAINT fk_lab_pp_plan FOREIGN KEY (plan_id) REFERENCES mst_lab_test_plan (id),
  CONSTRAINT fk_lab_pp_param FOREIGN KEY (parameter_id) REFERENCES mst_lab_test_parameter (id),
  CONSTRAINT ck_lab_pp_repeat CHECK (repeat_count BETWEEN 1 AND 20)
) ENGINE=InnoDB COMMENT='Lab: parameters, methods and acceptance limits of a plan version';

CREATE TABLE IF NOT EXISTS mst_lab_machine (
  id            BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id    BIGINT UNSIGNED NOT NULL,
  machine_code  VARCHAR(30) NOT NULL,
  name          VARCHAR(80) NOT NULL,
  machine_type  VARCHAR(40) NULL COMMENT 'Washer / tumble dryer / crockmeter / pilling tester …',
  capacity      DECIMAL(12,3) NULL,
  capacity_uom  VARCHAR(10) NULL,
  status        VARCHAR(12) NOT NULL DEFAULT 'AVAILABLE' COMMENT 'AVAILABLE / IN_USE / MAINTENANCE / OUT_OF_ORDER',
  is_active     TINYINT(1) NOT NULL DEFAULT 1,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_lab_machine (company_id, machine_code)
) ENGINE=InnoDB COMMENT='Lab: machines';

CREATE TABLE IF NOT EXISTS mst_lab_wash_process (
  id          BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id  BIGINT UNSIGNED NOT NULL,
  code        VARCHAR(30) NOT NULL,
  name        VARCHAR(80) NOT NULL,
  sort_order  INT NOT NULL DEFAULT 0,
  is_active   TINYINT(1) NOT NULL DEFAULT 1,
  UNIQUE KEY uq_lab_wash (company_id, code)
) ENGINE=InnoDB COMMENT='Lab: wash / treatment processes (configurable)';

-- ------------------------------------------------------------ request
CREATE TABLE IF NOT EXISTS trx_lab_request (
  id                 BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id         BIGINT UNSIGNED NOT NULL,
  request_no         VARCHAR(30) NOT NULL,
  request_date       DATE NOT NULL,
  required_date      DATE NOT NULL,
  source             VARCHAR(20) NOT NULL DEFAULT 'MERCHANDISING' COMMENT 'MERCHANDISING / PRODUCTION / QA / BUYER / OTHER',
  buyer_id           BIGINT UNSIGNED NULL,
  so_id              BIGINT UNSIGNED NULL COMMENT 'Order (I/O / sales order)',
  buyer_po_no        VARCHAR(60) NULL,
  style_id           BIGINT UNSIGNED NULL,
  color_id           BIGINT UNSIGNED NULL,
  size_id            INT UNSIGNED NULL,
  item_description   VARCHAR(200) NULL COMMENT 'Sample descriptor',
  fabric_id          BIGINT UNSIGNED NULL,
  composition        VARCHAR(120) NULL,
  gsm                DECIMAL(10,2) NULL,
  fabric_lot         VARCHAR(60) NULL COMMENT 'Actual lot / batch / dye lot',
  test_scope         VARCHAR(120) NOT NULL COMMENT 'WASHING,GARMENT,TEXTILE_PHYSICAL,TEXTILE_CHEMICAL,BUYER_SPECIFIC,COMBINED',
  test_plan_id       BIGINT UNSIGNED NULL,
  test_plan_version  INT NULL,
  plan_snapshot      LONGTEXT NULL COMMENT 'Plan version + acceptance criteria frozen at submission',
  priority           VARCHAR(10) NOT NULL DEFAULT 'NORMAL',
  is_development     TINYINT(1) NOT NULL DEFAULT 0,
  development_ref    VARCHAR(60) NULL,
  development_reason VARCHAR(255) NULL,
  buyer_standard     VARCHAR(255) NULL,
  remarks            VARCHAR(500) NULL,
  status             VARCHAR(30) NOT NULL DEFAULT 'DRAFT' COMMENT 'DRAFT / SUBMITTED / CLARIFICATION_REQUIRED / SAMPLE_RECEIVED / IN_TESTING / PENDING_LAB_REVIEW / PENDING_QA_APPROVAL / APPROVED / REJECTED / RETEST_REQUIRED / CANCELLED / CLOSED',
  requester_id       BIGINT UNSIGNED NULL,
  submitted_at       DATETIME NULL,
  status_reason      VARCHAR(255) NULL COMMENT 'Return / cancel / close reason',
  row_version        INT NOT NULL DEFAULT 1,
  created_by         BIGINT UNSIGNED NULL,
  created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by         BIGINT UNSIGNED NULL,
  updated_at         DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_lab_request_no (company_id, request_no),
  KEY ix_lab_req_status (company_id, status, required_date),
  KEY ix_lab_req_bsc (company_id, buyer_id, style_id, color_id),
  CONSTRAINT ck_lab_req_priority CHECK (priority IN ('NORMAL','URGENT')),
  CONSTRAINT ck_lab_req_source CHECK (source IN ('MERCHANDISING','PRODUCTION','QA','BUYER','OTHER'))
) ENGINE=InnoDB COMMENT='Lab: test requests';

CREATE TABLE IF NOT EXISTS trx_lab_request_item (
  id               BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  request_id       BIGINT UNSIGNED NOT NULL,
  item_description VARCHAR(200) NULL,
  size_id          INT UNSIGNED NULL,
  sample_type      VARCHAR(20) NOT NULL,
  requested_qty    DECIMAL(18,6) NOT NULL,
  uom              VARCHAR(10) NOT NULL DEFAULT 'PCS',
  due_date         DATE NULL,
  remarks          VARCHAR(255) NULL,
  KEY ix_lab_req_item (request_id),
  CONSTRAINT fk_lab_ri_req FOREIGN KEY (request_id) REFERENCES trx_lab_request (id),
  CONSTRAINT ck_lab_ri_qty CHECK (requested_qty > 0)
) ENGINE=InnoDB COMMENT='Lab: sample requirement lines of a request';

-- ------------------------------------------------------------ sample inward + custody ledger
CREATE TABLE IF NOT EXISTS trx_lab_sample (
  id               BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id       BIGINT UNSIGNED NOT NULL,
  sample_no        VARCHAR(30) NOT NULL COMMENT 'Sample ID',
  qr_token         CHAR(24) NOT NULL COMMENT 'Random identifier printed in the QR — no business data',
  request_id       BIGINT UNSIGNED NOT NULL,
  request_item_id  BIGINT UNSIGNED NULL,
  received_at      DATETIME NOT NULL,
  sample_type      VARCHAR(20) NOT NULL COMMENT 'FABRIC_SWATCH / CUT_PANEL / GARMENT / TRIM / WASHED_GARMENT / CONTROL',
  received_qty     DECIMAL(18,6) NOT NULL,
  uom              VARCHAR(10) NOT NULL COMMENT 'PCS / KG / MTR / SWATCH',
  sample_weight_g  DECIMAL(18,6) NULL,
  dimensions_json  VARCHAR(500) NULL,
  color_id         BIGINT UNSIGNED NULL,
  lot_reference    VARCHAR(60) NULL,
  sample_condition VARCHAR(255) NULL,
  received_by      BIGINT UNSIGNED NULL,
  handed_over_by   VARCHAR(100) NULL,
  storage_location VARCHAR(100) NULL,
  retention_until  DATE NULL,
  reuse_allowed    TINYINT(1) NOT NULL DEFAULT 1 COMMENT 'May be issued to more than one trial',
  status           VARCHAR(20) NOT NULL DEFAULT 'RECEIVED' COMMENT 'RECEIVED / ISSUED / PARTIALLY_CONSUMED / CONSUMED / RETAINED / DISPOSED (derived from the ledger)',
  remarks          VARCHAR(255) NULL,
  row_version      INT NOT NULL DEFAULT 1,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_lab_sample_no (company_id, sample_no),
  UNIQUE KEY uq_lab_sample_qr (qr_token),
  KEY ix_lab_sample_req (request_id, received_at),
  CONSTRAINT fk_lab_s_req FOREIGN KEY (request_id) REFERENCES trx_lab_request (id),
  CONSTRAINT ck_lab_s_qty CHECK (received_qty > 0)
) ENGINE=InnoDB COMMENT='Lab: sample inward receipts';

CREATE TABLE IF NOT EXISTS trx_lab_sample_txn (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  sample_id       BIGINT UNSIGNED NOT NULL,
  trial_id        BIGINT UNSIGNED NULL,
  txn_type        VARCHAR(10) NOT NULL COMMENT 'INWARD / ISSUE / CONSUME / RETURN / RETAIN / DISPOSE',
  quantity        DECIMAL(18,6) NOT NULL,
  uom             VARCHAR(10) NOT NULL,
  from_bucket     VARCHAR(10) NULL COMMENT 'DISPOSE: AVAILABLE or RETAINED',
  txn_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  issued_by       BIGINT UNSIGNED NULL,
  received_by     VARCHAR(100) NULL,
  reason          VARCHAR(255) NULL,
  idempotency_key VARCHAR(64) NULL,
  KEY ix_lab_stx_sample (sample_id, txn_type),
  KEY ix_lab_stx_trial (trial_id),
  UNIQUE KEY uq_lab_stx_idem (company_id, idempotency_key),
  CONSTRAINT fk_lab_stx_sample FOREIGN KEY (sample_id) REFERENCES trx_lab_sample (id),
  CONSTRAINT ck_lab_stx_qty CHECK (quantity > 0),
  CONSTRAINT ck_lab_stx_type CHECK (txn_type IN ('INWARD','ISSUE','CONSUME','RETURN','RETAIN','DISPOSE'))
) ENGINE=InnoDB COMMENT='Lab: sample quantity / custody ledger (balances never negative — checked under row lock)';

-- ------------------------------------------------------------ trials
CREATE TABLE IF NOT EXISTS trx_lab_trial (
  id                  BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id          BIGINT UNSIGNED NOT NULL,
  request_id          BIGINT UNSIGNED NOT NULL,
  trial_seq           INT NOT NULL,
  trial_no            VARCHAR(20) NOT NULL COMMENT 'TRIAL-01, TRIAL-02 … within the request',
  sample_id           BIGINT UNSIGNED NULL,
  trial_type          VARCHAR(20) NOT NULL DEFAULT 'INITIAL' COMMENT 'INITIAL / RECIPE_REVISION / RETEST / CONFIRMATION / BUYER_REPEAT',
  parent_trial_id     BIGINT UNSIGNED NULL,
  revises_report_id   BIGINT UNSIGNED NULL COMMENT 'Set when the trial revises an approved report (new report revision)',
  recipe_revision     INT NOT NULL DEFAULT 1,
  technician_id       BIGINT UNSIGNED NOT NULL,
  machine_id          BIGINT UNSIGNED NULL,
  planned_at          DATETIME NULL,
  started_at          DATETIME NULL,
  completed_at        DATETIME NULL,
  submitted_at        DATETIME NULL,
  status              VARCHAR(20) NOT NULL DEFAULT 'DRAFT' COMMENT 'DRAFT / PLANNED / IN_PROGRESS / COMPLETED / SUBMITTED / LAB_REVIEWED / APPROVED / REJECTED / RETEST_REQUIRED / CANCELLED',
  reason              VARCHAR(255) NULL COMMENT 'Purpose of variation / reason for retest',
  remarks             VARCHAR(500) NULL,
  wash_process_code   VARCHAR(30) NULL,
  batch_ref           VARCHAR(40) NULL,
  load_weight_kg      DECIMAL(18,6) NULL,
  water_qty_l         DECIMAL(18,6) NULL,
  liquor_ratio        DECIMAL(18,6) NULL COMMENT '1 : n (server-calculated from water / load when both are given)',
  drying_method       VARCHAR(20) NULL COMMENT 'TUMBLE / LINE / FLAT / DRIP / NONE',
  drying_temp         DECIMAL(10,2) NULL,
  drying_duration_min DECIMAL(10,2) NULL,
  finish_notes        VARCHAR(255) NULL COMMENT 'Softener / finish / pressing / conditioning',
  operator_name       VARCHAR(100) NULL,
  verified_by         BIGINT UNSIGNED NULL,
  plan_snapshot       LONGTEXT NULL COMMENT 'Acceptance criteria copied from the request when the trial was made',
  overall_result      VARCHAR(12) NULL COMMENT 'PASS / FAIL (server evaluated)',
  evaluated_at        DATETIME NULL,
  results_by          BIGINT UNSIGNED NULL COMMENT 'Last user who entered measurements (maker-checker)',
  submitted_by        BIGINT UNSIGNED NULL,
  lab_approved_by     BIGINT UNSIGNED NULL,
  row_version         INT NOT NULL DEFAULT 1,
  created_by          BIGINT UNSIGNED NULL,
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_lab_trial_no (request_id, trial_no),
  KEY ix_lab_trial_status (company_id, status),
  KEY ix_lab_trial_req (request_id, status),
  CONSTRAINT fk_lab_t_req FOREIGN KEY (request_id) REFERENCES trx_lab_request (id),
  CONSTRAINT ck_lab_t_rev CHECK (recipe_revision >= 1)
) ENGINE=InnoDB COMMENT='Lab: wash / treatment / test trials (never overwritten — retest and revision make a new linked trial)';

CREATE TABLE IF NOT EXISTS trx_lab_trial_stage (
  id                  BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  trial_id            BIGINT UNSIGNED NOT NULL,
  stage_no            INT NOT NULL,
  process_code        VARCHAR(30) NOT NULL COMMENT 'PRE_WET / ENZYME / RINSE / SOFTENER / EXTRACTION / DRYING …',
  target_temp         DECIMAL(10,2) NULL,
  actual_temp         DECIMAL(10,2) NULL,
  target_duration_min DECIMAL(10,2) NULL,
  actual_duration_min DECIMAL(10,2) NULL,
  water_qty_l         DECIMAL(18,6) NULL,
  liquor_ratio        DECIMAL(18,6) NULL,
  ph_start            DECIMAL(5,2) NULL,
  ph_end              DECIMAL(5,2) NULL,
  water_hardness      DECIMAL(10,2) NULL,
  rpm                 DECIMAL(10,2) NULL,
  rinse_count         INT NULL,
  notes               VARCHAR(255) NULL,
  UNIQUE KEY uq_lab_stage (trial_id, stage_no),
  CONSTRAINT fk_lab_st_trial FOREIGN KEY (trial_id) REFERENCES trx_lab_trial (id)
) ENGINE=InnoDB COMMENT='Lab: wash recipe stage rows (target and actual)';

CREATE TABLE IF NOT EXISTS trx_lab_trial_chemical (
  id             BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  trial_id       BIGINT UNSIGNED NOT NULL,
  stage_no       INT NULL,
  trim_id        BIGINT UNSIGNED NULL COMMENT 'ERP item (trim / chemical master), optional',
  chemical_name  VARCHAR(120) NOT NULL,
  chemical_lot   VARCHAR(60) NULL,
  target_dosage  DECIMAL(18,6) NULL,
  actual_dosage  DECIMAL(18,6) NULL,
  dosage_uom     VARCHAR(10) NOT NULL DEFAULT 'G_L' COMMENT 'G_L / ML_L / PCT_OWG / G / ML / KG / L',
  added_at       VARCHAR(40) NULL COMMENT 'Addition stage / time',
  remarks        VARCHAR(255) NULL,
  KEY ix_lab_chem_trial (trial_id),
  CONSTRAINT fk_lab_ch_trial FOREIGN KEY (trial_id) REFERENCES trx_lab_trial (id),
  CONSTRAINT ck_lab_ch_dose CHECK ((target_dosage IS NULL OR target_dosage >= 0) AND (actual_dosage IS NULL OR actual_dosage >= 0))
) ENGINE=InnoDB COMMENT='Lab: chemicals and dosage per trial / stage (no stock issue — reference only)';

CREATE TABLE IF NOT EXISTS trx_lab_trial_measurement (
  id            BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  trial_id      BIGINT UNSIGNED NOT NULL,
  parameter_id  BIGINT UNSIGNED NOT NULL,
  reading_stage VARCHAR(8) NOT NULL DEFAULT 'SINGLE' COMMENT 'BEFORE / AFTER / SINGLE',
  reading_no    INT NOT NULL DEFAULT 1,
  numeric_value DECIMAL(18,6) NULL,
  text_value    VARCHAR(255) NULL,
  measured_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  measured_by   BIGINT UNSIGNED NULL,
  remarks       VARCHAR(255) NULL,
  UNIQUE KEY uq_lab_meas (trial_id, parameter_id, reading_stage, reading_no),
  CONSTRAINT fk_lab_m_trial FOREIGN KEY (trial_id) REFERENCES trx_lab_trial (id)
) ENGINE=InnoDB COMMENT='Lab: raw readings (kept apart from the calculated result)';

CREATE TABLE IF NOT EXISTS trx_lab_trial_result (
  id                   BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  trial_id             BIGINT UNSIGNED NOT NULL,
  parameter_id         BIGINT UNSIGNED NOT NULL,
  is_mandatory         TINYINT(1) NOT NULL DEFAULT 1,
  raw_before           DECIMAL(18,6) NULL COMMENT 'Average of BEFORE readings',
  raw_after            DECIMAL(18,6) NULL COMMENT 'Average of AFTER readings',
  calculated_value     DECIMAL(24,10) NULL COMMENT 'Full precision',
  display_value        VARCHAR(40) NULL COMMENT 'Rounded to the parameter precision',
  result_text          VARCHAR(255) NULL,
  unit_code            VARCHAR(20) NULL,
  acceptance_snapshot  TEXT NULL,
  evaluation_status    VARCHAR(16) NOT NULL DEFAULT 'PENDING' COMMENT 'PASS / FAIL / BORDERLINE / NOT_APPLICABLE / PENDING / INVALID',
  calc_status          VARCHAR(16) NULL COMMENT 'Server-evaluated status before any override',
  evaluation_note      VARCHAR(255) NULL,
  formula_code         VARCHAR(20) NULL,
  formula_version      INT NULL,
  is_override          TINYINT(1) NOT NULL DEFAULT 0,
  override_reason      VARCHAR(255) NULL,
  overridden_by        BIGINT UNSIGNED NULL,
  overridden_at        DATETIME NULL,
  result_source        VARCHAR(10) NOT NULL DEFAULT 'INTERNAL' COMMENT 'INTERNAL / EXTERNAL',
  external_lab_name    VARCHAR(120) NULL,
  certificate_no       VARCHAR(60) NULL,
  certificate_date     DATE NULL,
  certificate_attachment_id BIGINT UNSIGNED NULL,
  observation          VARCHAR(500) NULL,
  evaluated_at         DATETIME NULL,
  UNIQUE KEY uq_lab_result (trial_id, parameter_id),
  CONSTRAINT fk_lab_r_trial FOREIGN KEY (trial_id) REFERENCES trx_lab_trial (id)
) ENGINE=InnoDB COMMENT='Lab: calculated results and evaluation';

CREATE TABLE IF NOT EXISTS trx_lab_trial_deviation (
  id                BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  trial_id          BIGINT UNSIGNED NOT NULL,
  stage_no          INT NULL,
  deviation_type    VARCHAR(30) NOT NULL COMMENT 'TEMPERATURE / TIME / DOSAGE / LIQUOR / PH / MACHINE / OTHER',
  target_value      VARCHAR(40) NULL,
  actual_value      VARCHAR(40) NULL,
  reason            VARCHAR(255) NOT NULL,
  corrective_action VARCHAR(255) NULL,
  reported_by       BIGINT UNSIGNED NULL,
  reported_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_by       BIGINT UNSIGNED NULL,
  resolved_at       DATETIME NULL,
  KEY ix_lab_dev_trial (trial_id),
  CONSTRAINT fk_lab_d_trial FOREIGN KEY (trial_id) REFERENCES trx_lab_trial (id)
) ENGINE=InnoDB COMMENT='Lab: target vs actual deviations';

-- ------------------------------------------------------------ reports + approvals
CREATE TABLE IF NOT EXISTS trx_lab_report (
  id                   BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id           BIGINT UNSIGNED NOT NULL,
  report_no            VARCHAR(30) NOT NULL,
  revision_no          INT NOT NULL DEFAULT 1,
  request_id           BIGINT UNSIGNED NOT NULL,
  trial_id             BIGINT UNSIGNED NOT NULL,
  report_status        VARCHAR(20) NOT NULL DEFAULT 'PENDING_LAB' COMMENT 'PENDING_LAB / PENDING_QA / APPROVED / RELEASED / RETURNED / REJECTED / RETEST_REQUIRED / SUPERSEDED',
  overall_result       VARCHAR(12) NULL COMMENT 'PASS / FAIL / CONDITIONAL',
  disposition          VARCHAR(20) NULL COMMENT 'APPROVED / CONDITIONAL / REJECTED / RETEST_REQUIRED',
  conditional_reason   VARCHAR(255) NULL,
  conditional_scope    VARCHAR(255) NULL,
  conditional_expiry   DATE NULL,
  recommendation       VARCHAR(500) NULL,
  revision_reason      VARCHAR(255) NULL,
  supersedes_report_id BIGINT UNSIGNED NULL,
  prepared_by          BIGINT UNSIGNED NULL,
  prepared_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  lab_approved_by      BIGINT UNSIGNED NULL,
  lab_approved_at      DATETIME NULL,
  qa_approved_by       BIGINT UNSIGNED NULL,
  qa_approved_at       DATETIME NULL,
  released_by          BIGINT UNSIGNED NULL,
  released_at          DATETIME NULL,
  report_file_key      VARCHAR(120) NULL COMMENT 'Released PDF (private file)',
  report_file_sha256   CHAR(64) NULL,
  snapshot_json        LONGTEXT NOT NULL COMMENT 'Frozen at submission — PDF and approvals read only this',
  snapshot_hash        CHAR(64) NOT NULL,
  row_version          INT NOT NULL DEFAULT 1,
  created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_lab_report_rev (company_id, report_no, revision_no),
  KEY ix_lab_report_status (company_id, report_status, released_at),
  KEY ix_lab_report_req (request_id),
  KEY ix_lab_report_trial (trial_id),
  CONSTRAINT fk_lab_rp_req FOREIGN KEY (request_id) REFERENCES trx_lab_request (id),
  CONSTRAINT fk_lab_rp_trial FOREIGN KEY (trial_id) REFERENCES trx_lab_trial (id),
  CONSTRAINT ck_lab_rp_rev CHECK (revision_no >= 1)
) ENGINE=InnoDB COMMENT='Lab: report revisions (immutable snapshot; only a dual-approved revision can be released)';

CREATE TABLE IF NOT EXISTS trx_lab_report_approval (
  id               BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id       BIGINT UNSIGNED NOT NULL,
  report_id        BIGINT UNSIGNED NOT NULL,
  approval_level   VARCHAR(10) NOT NULL COMMENT 'LAB / QA / RELEASE',
  approver_user_id BIGINT UNSIGNED NOT NULL,
  approver_name    VARCHAR(120) NULL,
  approver_roles   VARCHAR(255) NULL,
  decision         VARCHAR(12) NOT NULL COMMENT 'APPROVE / RETURN / REJECT / RETEST / CONDITIONAL / RELEASE',
  remarks          VARCHAR(500) NULL,
  decided_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  report_revision  INT NOT NULL,
  snapshot_hash    CHAR(64) NOT NULL COMMENT 'Revision hash the decision was made on',
  override_used    TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'Maker-checker emergency override',
  idempotency_key  VARCHAR(64) NULL,
  KEY ix_lab_appr_report (report_id),
  UNIQUE KEY uq_lab_appr_idem (company_id, idempotency_key),
  CONSTRAINT fk_lab_ap_report FOREIGN KEY (report_id) REFERENCES trx_lab_report (id)
) ENGINE=InnoDB COMMENT='Lab: approval decisions (user, role, time, decision, revision hash)';

CREATE TABLE IF NOT EXISTS trx_lab_production_ref (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  report_id       BIGINT UNSIGNED NOT NULL,
  so_id           BIGINT UNSIGNED NULL,
  buyer_po_no     VARCHAR(60) NULL,
  style_id        BIGINT UNSIGNED NULL,
  color_id        BIGINT UNSIGNED NULL,
  fabric_lot      VARCHAR(60) NULL,
  process_code    VARCHAR(30) NULL,
  valid_from      DATE NULL,
  valid_to        DATE NULL,
  status          VARCHAR(10) NOT NULL DEFAULT 'ACTIVE' COMMENT 'ACTIVE / REVOKED',
  remarks         VARCHAR(255) NULL,
  acknowledged_by BIGINT UNSIGNED NULL,
  acknowledged_at DATETIME NULL,
  created_by      BIGINT UNSIGNED NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_by      BIGINT UNSIGNED NULL,
  revoked_at      DATETIME NULL,
  revoke_reason   VARCHAR(255) NULL,
  KEY ix_lab_pref_report (report_id),
  KEY ix_lab_pref_ctx (company_id, style_id, color_id, status),
  CONSTRAINT fk_lab_pr_report FOREIGN KEY (report_id) REFERENCES trx_lab_report (id)
) ENGINE=InnoDB COMMENT='Lab: approved report → production context (a controlled reference, not a wash instruction)';

-- ------------------------------------------------------------ files + timeline
CREATE TABLE IF NOT EXISTS trx_lab_attachment (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  request_id      BIGINT UNSIGNED NULL,
  sample_id       BIGINT UNSIGNED NULL,
  trial_id        BIGINT UNSIGNED NULL,
  parameter_id    BIGINT UNSIGNED NULL COMMENT 'Evidence for one test parameter',
  attachment_type VARCHAR(20) NOT NULL DEFAULT 'OTHER' COMMENT 'BUYER_PROTOCOL / SAMPLE_PHOTO / BEFORE_PHOTO / AFTER_PHOTO / EVIDENCE / CERTIFICATE / OTHER',
  storage_key     VARCHAR(120) NOT NULL,
  original_name   VARCHAR(200) NOT NULL,
  mime_type       VARCHAR(80) NOT NULL,
  byte_size       INT UNSIGNED NOT NULL,
  sha256          CHAR(64) NOT NULL,
  caption         VARCHAR(200) NULL,
  uploaded_by     BIGINT UNSIGNED NULL,
  uploaded_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  is_removed      TINYINT(1) NOT NULL DEFAULT 0,
  removed_by      BIGINT UNSIGNED NULL,
  removed_at      DATETIME NULL,
  KEY ix_lab_att_req (company_id, request_id),
  KEY ix_lab_att_trial (trial_id),
  KEY ix_lab_att_sample (sample_id)
) ENGINE=InnoDB COMMENT='Lab: private files (photos, certificates, buyer protocols) — downloaded only through the API';

CREATE TABLE IF NOT EXISTS trx_lab_audit (
  id          BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id  BIGINT UNSIGNED NOT NULL,
  request_id  BIGINT UNSIGNED NULL,
  entity_type VARCHAR(20) NOT NULL COMMENT 'REQUEST / SAMPLE / TRIAL / RESULT / REPORT / PLAN / MASTER / PRODUCTION_REF',
  entity_id   BIGINT UNSIGNED NOT NULL,
  action      VARCHAR(40) NOT NULL,
  before_json LONGTEXT NULL,
  after_json  LONGTEXT NULL,
  remarks     VARCHAR(500) NULL,
  actor_user_id BIGINT UNSIGNED NULL,
  ip_address  VARCHAR(45) NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_lab_audit_req (company_id, request_id, created_at),
  KEY ix_lab_audit_ent (entity_type, entity_id)
) ENGINE=InnoDB COMMENT='Lab: immutable audit / timeline';

-- ------------------------------------------------------------ number series (per year — the code adds later years on demand)
INSERT INTO cfg_number_series (company_id, branch_id, doc_type, fy_id, prefix, suffix, next_number, padding)
SELECT c.id, NULL, t.doc_type, NULL, t.prefix, '', 1, 6 FROM mst_company c
  JOIN (SELECT 'LAB_REQUEST_2026' doc_type, 'LBR-2026-' prefix UNION ALL
        SELECT 'LAB_SAMPLE_2026', 'LBS-2026-' UNION ALL
        SELECT 'LAB_REPORT_2026', 'LRP-2026-') t
 WHERE NOT EXISTS (SELECT 1 FROM cfg_number_series x WHERE x.company_id = c.id AND x.branch_id IS NULL AND x.doc_type = t.doc_type AND x.fy_id IS NULL);

-- ------------------------------------------------------------ default masters (once per company — only what the spec names)
INSERT INTO mst_lab_test_category (company_id, code, name, sort_order)
SELECT c.id, t.code, t.name, t.so FROM mst_company c
  JOIN (SELECT 'WASHING' code, 'Washing' name, 1 so UNION ALL
        SELECT 'GARMENT', 'Garment', 2 UNION ALL
        SELECT 'PHYSICAL', 'Textile physical', 3 UNION ALL
        SELECT 'CHEMICAL', 'Textile chemical', 4 UNION ALL
        SELECT 'BUYER_SPECIFIC', 'Buyer-specific', 5) t
 WHERE NOT EXISTS (SELECT 1 FROM cfg_system_setting g WHERE g.company_id = c.id AND g.setting_key = 'LAB_DEFAULTS_SEEDED')
   AND NOT EXISTS (SELECT 1 FROM mst_lab_test_category x WHERE x.company_id = c.id AND x.code = t.code);

INSERT INTO mst_lab_unit (company_id, code, name, symbol, dimension)
SELECT c.id, t.code, t.name, t.sym, t.dim FROM mst_company c
  JOIN (SELECT 'CM' code, 'Centimetre' name, 'cm' sym, 'LENGTH' dim UNION ALL
        SELECT 'MM', 'Millimetre', 'mm', 'LENGTH' UNION ALL
        SELECT 'PCT', 'Percent', '%', 'RATIO' UNION ALL
        SELECT 'GSM', 'Grams per square metre', 'g/m²', 'MASS' UNION ALL
        SELECT 'G', 'Gram', 'g', 'MASS' UNION ALL
        SELECT 'KG', 'Kilogram', 'kg', 'MASS' UNION ALL
        SELECT 'N', 'Newton', 'N', 'FORCE' UNION ALL
        SELECT 'KPA', 'Kilopascal', 'kPa', 'PRESSURE' UNION ALL
        SELECT 'CYCLES', 'Cycles', 'cycles', 'COUNT' UNION ALL
        SELECT 'GRADE', 'Grade (grey scale)', 'grade', 'GRADE' UNION ALL
        SELECT 'PH', 'pH', 'pH', 'CONCENTRATION' UNION ALL
        SELECT 'MG_KG', 'Milligram per kilogram', 'mg/kg', 'CONCENTRATION' UNION ALL
        SELECT 'DEG_C', 'Degree Celsius', '°C', 'TEMPERATURE' UNION ALL
        SELECT 'MIN', 'Minute', 'min', 'TIME' UNION ALL
        SELECT 'L', 'Litre', 'L', 'VOLUME') t
 WHERE NOT EXISTS (SELECT 1 FROM cfg_system_setting g WHERE g.company_id = c.id AND g.setting_key = 'LAB_DEFAULTS_SEEDED')
   AND NOT EXISTS (SELECT 1 FROM mst_lab_unit x WHERE x.company_id = c.id AND x.code = t.code);

INSERT INTO mst_lab_wash_process (company_id, code, name, sort_order)
SELECT c.id, t.code, t.name, t.so FROM mst_company c
  JOIN (SELECT 'NORMAL' code, 'Normal wash' name, 1 so UNION ALL SELECT 'ENZYME', 'Enzyme wash', 2 UNION ALL
        SELECT 'STONE', 'Stone wash', 3 UNION ALL SELECT 'BLEACH', 'Bleach wash', 4 UNION ALL SELECT 'ACID', 'Acid wash', 5 UNION ALL
        SELECT 'SILICONE', 'Silicone wash', 6 UNION ALL SELECT 'SOFTENER', 'Softener wash', 7 UNION ALL
        SELECT 'BIO_POLISH', 'Bio-polish', 8 UNION ALL SELECT 'PIGMENT', 'Pigment wash', 9 UNION ALL
        SELECT 'GARMENT_DYE', 'Garment dye', 10 UNION ALL SELECT 'OTHER', 'Other', 99) t
 WHERE NOT EXISTS (SELECT 1 FROM cfg_system_setting g WHERE g.company_id = c.id AND g.setting_key = 'LAB_DEFAULTS_SEEDED')
   AND NOT EXISTS (SELECT 1 FROM mst_lab_wash_process x WHERE x.company_id = c.id AND x.code = t.code);

-- parameters named in spec §4.6 (dimensional stability, GSM, colour fastness, appearance, garment performance,
-- physical textile, chemical). No acceptance limits here — limits belong to the buyer / style test plan.
INSERT INTO mst_lab_test_parameter (company_id, category_id, code, name, input_type, data_type, formula_code, unit_id, reading_unit_id, precision_dp, allowed_values)
SELECT c.id, (SELECT k.id FROM mst_lab_test_category k WHERE k.company_id = c.id AND k.code = t.cat),
       t.code, t.name, t.it, IF(t.it IN ('TEXT','DROPDOWN','PASS_FAIL','PHOTO'), 'TEXT', 'DECIMAL'), t.f,
       (SELECT u.id FROM mst_lab_unit u WHERE u.company_id = c.id AND u.code = t.u),
       (SELECT u.id FROM mst_lab_unit u WHERE u.company_id = c.id AND u.code = t.ru), t.dp, t.av
  FROM mst_company c
  JOIN (SELECT 'WASHING' cat, 'LENGTH_SHRINKAGE' code, 'Dimensional stability — length shrinkage' name, 'BEFORE_AFTER' it, 'SHRINKAGE_PCT' f, 'PCT' u, 'CM' ru, 1 dp, NULL av UNION ALL
        SELECT 'WASHING', 'WIDTH_SHRINKAGE', 'Dimensional stability — width shrinkage', 'BEFORE_AFTER', 'SHRINKAGE_PCT', 'PCT', 'CM', 1, NULL UNION ALL
        SELECT 'GARMENT', 'BODY_LENGTH', 'Body length shrinkage', 'BEFORE_AFTER', 'SHRINKAGE_PCT', 'PCT', 'CM', 1, NULL UNION ALL
        SELECT 'WASHING', 'GSM_CHANGE', 'GSM change after wash', 'BEFORE_AFTER', 'CHANGE_PCT', 'PCT', 'GSM', 1, NULL UNION ALL
        SELECT 'PHYSICAL', 'GSM', 'GSM (fabric weight)', 'MULTI_READING', 'AVERAGE', 'GSM', 'GSM', 0, NULL UNION ALL
        SELECT 'WASHING', 'CF_WASH_SHADE', 'Colour fastness to washing — shade change', 'GRADE', 'DIRECT', 'GRADE', NULL, 1, '1,1-2,2,2-3,3,3-4,4,4-5,5' UNION ALL
        SELECT 'WASHING', 'CF_WASH_STAIN', 'Colour fastness to washing — staining', 'GRADE', 'DIRECT', 'GRADE', NULL, 1, '1,1-2,2,2-3,3,3-4,4,4-5,5' UNION ALL
        SELECT 'PHYSICAL', 'CF_RUB_DRY', 'Colour fastness to rubbing — dry', 'GRADE', 'DIRECT', 'GRADE', NULL, 1, '1,1-2,2,2-3,3,3-4,4,4-5,5' UNION ALL
        SELECT 'PHYSICAL', 'CF_RUB_WET', 'Colour fastness to rubbing — wet', 'GRADE', 'DIRECT', 'GRADE', NULL, 1, '1,1-2,2,2-3,3,3-4,4,4-5,5' UNION ALL
        SELECT 'PHYSICAL', 'CF_WATER', 'Colour fastness to water', 'GRADE', 'DIRECT', 'GRADE', NULL, 1, '1,1-2,2,2-3,3,3-4,4,4-5,5' UNION ALL
        SELECT 'PHYSICAL', 'CF_LIGHT', 'Colour fastness to light', 'GRADE', 'DIRECT', 'GRADE', NULL, 1, '1,2,3,4,5,6,7,8' UNION ALL
        SELECT 'GARMENT', 'SHADE_CHANGE', 'Appearance — shade change', 'GRADE', 'DIRECT', 'GRADE', NULL, 1, '1,1-2,2,2-3,3,3-4,4,4-5,5' UNION ALL
        SELECT 'GARMENT', 'SEAM_PUCKERING', 'Appearance — seam puckering', 'GRADE', 'DIRECT', 'GRADE', NULL, 1, '1,2,3,4,5' UNION ALL
        SELECT 'GARMENT', 'SURFACE_APPEARANCE', 'Appearance — surface after wash', 'DROPDOWN', 'NONE', NULL, NULL, 0, 'Acceptable,Not acceptable' UNION ALL
        SELECT 'GARMENT', 'HAND_FEEL', 'Hand feel', 'TEXT', 'NONE', NULL, NULL, 0, NULL UNION ALL
        SELECT 'GARMENT', 'SPIRALITY', 'Spirality / twisting', 'MULTI_READING', 'AVERAGE', 'PCT', 'PCT', 1, NULL UNION ALL
        SELECT 'GARMENT', 'TORQUE', 'Torque', 'MULTI_READING', 'AVERAGE', 'PCT', 'PCT', 1, NULL UNION ALL
        SELECT 'GARMENT', 'SEAM_SLIPPAGE', 'Seam slippage', 'MULTI_READING', 'AVERAGE', 'MM', 'MM', 1, NULL UNION ALL
        SELECT 'GARMENT', 'SEAM_STRENGTH', 'Seam strength', 'MULTI_READING', 'AVERAGE', 'N', 'N', 0, NULL UNION ALL
        SELECT 'PHYSICAL', 'PILLING', 'Pilling', 'GRADE', 'DIRECT', 'GRADE', NULL, 1, '1,1-2,2,2-3,3,3-4,4,4-5,5' UNION ALL
        SELECT 'PHYSICAL', 'TENSILE_STRENGTH', 'Tensile strength', 'MULTI_READING', 'AVERAGE', 'N', 'N', 0, NULL UNION ALL
        SELECT 'PHYSICAL', 'TEAR_STRENGTH', 'Tear strength', 'MULTI_READING', 'AVERAGE', 'N', 'N', 0, NULL UNION ALL
        SELECT 'PHYSICAL', 'BURSTING_STRENGTH', 'Bursting strength', 'MULTI_READING', 'AVERAGE', 'KPA', 'KPA', 0, NULL UNION ALL
        SELECT 'PHYSICAL', 'ABRASION', 'Abrasion resistance', 'NUMERIC', 'DIRECT', 'CYCLES', NULL, 0, NULL UNION ALL
        SELECT 'PHYSICAL', 'STRETCH', 'Stretch', 'MULTI_READING', 'AVERAGE', 'PCT', 'PCT', 1, NULL UNION ALL
        SELECT 'PHYSICAL', 'RECOVERY', 'Recovery', 'MULTI_READING', 'AVERAGE', 'PCT', 'PCT', 1, NULL UNION ALL
        SELECT 'CHEMICAL', 'PH', 'pH value', 'MULTI_READING', 'AVERAGE', 'PH', 'PH', 1, NULL UNION ALL
        SELECT 'CHEMICAL', 'FORMALDEHYDE', 'Formaldehyde', 'NUMERIC', 'DIRECT', 'MG_KG', NULL, 0, NULL) t
 WHERE NOT EXISTS (SELECT 1 FROM cfg_system_setting g WHERE g.company_id = c.id AND g.setting_key = 'LAB_DEFAULTS_SEEDED')
   AND NOT EXISTS (SELECT 1 FROM mst_lab_test_parameter x WHERE x.company_id = c.id AND x.code = t.code);

-- ------------------------------------------------------------ permissions: module LAB under Quality
INSERT INTO mst_module (module_code, module_name, parent_id, sort_order)
SELECT 'LAB', 'Lab (Washing & Testing)', (SELECT id FROM (SELECT id FROM mst_module WHERE module_code = 'QUALITY') x), 285
 WHERE NOT EXISTS (SELECT 1 FROM mst_module WHERE module_code = 'LAB');
INSERT INTO mst_permission (module_id, permission_code, permission_name)
SELECT m.id, t.code, t.name FROM mst_module m
  JOIN (SELECT 'LAB.VIEW' code, 'View lab requests, samples, trials and reports' name UNION ALL
        SELECT 'LAB.CREATE', 'Create lab requests' UNION ALL
        SELECT 'LAB.UPDATE', 'Lab technician: sample inward / issue, trials, recipe, measurements, submit' UNION ALL
        SELECT 'LAB.APPROVE', 'Lab In-charge review: approve to QA / return / reject / retest' UNION ALL
        SELECT 'LAB.QA_APPROVE', 'QA Manager final approval, release, production reference' UNION ALL
        SELECT 'LAB.OVERRIDE', 'Result override, conditional approval, maker-checker emergency override (audited)' UNION ALL
        SELECT 'LAB.ADMIN', 'Lab masters: parameters, methods, units, plans, machines') t
 WHERE m.module_code = 'LAB' AND NOT EXISTS (SELECT 1 FROM mst_permission x WHERE x.permission_code = t.code);

-- one-time grants (a later change on the Roles screen is not undone by the next deploy)
INSERT INTO map_role_permission (role_id, permission_id)
SELECT r.id, p.id FROM mst_role r JOIN mst_permission p ON p.permission_code LIKE 'LAB.%'
 WHERE r.role_code IN ('SUPER_ADMIN','ADMIN')
   AND NOT EXISTS (SELECT 1 FROM cfg_system_setting g WHERE g.company_id = r.company_id AND g.setting_key = 'LAB_PERMS_GRANTED')
   AND NOT EXISTS (SELECT 1 FROM map_role_permission m WHERE m.role_id = r.id AND m.permission_id = p.id);
-- QA: lab technician + In-charge work; QC inspectors: technician work; merchandisers raise requests; production reads
INSERT INTO map_role_permission (role_id, permission_id)
SELECT r.id, p.id FROM mst_role r JOIN mst_permission p ON p.permission_code IN ('LAB.VIEW','LAB.CREATE','LAB.UPDATE','LAB.APPROVE')
 WHERE r.role_code = 'QA'
   AND NOT EXISTS (SELECT 1 FROM cfg_system_setting g WHERE g.company_id = r.company_id AND g.setting_key = 'LAB_PERMS_GRANTED')
   AND NOT EXISTS (SELECT 1 FROM map_role_permission m WHERE m.role_id = r.id AND m.permission_id = p.id);
INSERT INTO map_role_permission (role_id, permission_id)
SELECT r.id, p.id FROM mst_role r JOIN mst_permission p ON p.permission_code IN ('LAB.VIEW','LAB.UPDATE')
 WHERE r.role_code = 'QC_INSPECTOR'
   AND NOT EXISTS (SELECT 1 FROM cfg_system_setting g WHERE g.company_id = r.company_id AND g.setting_key = 'LAB_PERMS_GRANTED')
   AND NOT EXISTS (SELECT 1 FROM map_role_permission m WHERE m.role_id = r.id AND m.permission_id = p.id);
INSERT INTO map_role_permission (role_id, permission_id)
SELECT r.id, p.id FROM mst_role r JOIN mst_permission p ON p.permission_code IN ('LAB.VIEW','LAB.CREATE')
 WHERE r.role_code = 'MERCHANDISER'
   AND NOT EXISTS (SELECT 1 FROM cfg_system_setting g WHERE g.company_id = r.company_id AND g.setting_key = 'LAB_PERMS_GRANTED')
   AND NOT EXISTS (SELECT 1 FROM map_role_permission m WHERE m.role_id = r.id AND m.permission_id = p.id);
INSERT INTO map_role_permission (role_id, permission_id)
SELECT r.id, p.id FROM mst_role r JOIN mst_permission p ON p.permission_code IN ('LAB.VIEW','LAB.CREATE')
 WHERE r.role_code IN ('PRODUCTION_MANAGER','PRODUCTION_USER')
   AND NOT EXISTS (SELECT 1 FROM cfg_system_setting g WHERE g.company_id = r.company_id AND g.setting_key = 'LAB_PERMS_GRANTED')
   AND NOT EXISTS (SELECT 1 FROM map_role_permission m WHERE m.role_id = r.id AND m.permission_id = p.id);

INSERT IGNORE INTO cfg_system_setting (company_id, setting_key, setting_value, description)
SELECT id, 'LAB_PERMS_GRANTED', '1', 'Lab module permissions granted to the standard roles (one time, migration 152)' FROM mst_company;
INSERT IGNORE INTO cfg_system_setting (company_id, setting_key, setting_value, description)
SELECT id, 'LAB_DEFAULTS_SEEDED', '1', 'Lab default categories, units, wash processes and parameters seeded (one time, migration 152)' FROM mst_company;
INSERT IGNORE INTO cfg_system_setting (company_id, setting_key, setting_value, description)
SELECT id, 'LAB_PROD_ACK_REQUIRED', '0', 'Lab: 1 = production must acknowledge an approved lab reference before bulk wash' FROM mst_company;
