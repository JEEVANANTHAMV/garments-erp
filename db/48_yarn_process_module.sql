-- =====================================================================
-- 48. YARN PROCESS MODULE
--     Process Route Master, Yarn Dyeing, Winding, Twisting,
--     Collar Knitting (KG -> PCS dual UOM), reservations, lot
--     allocation, issues, receipts and QC.
--
--     Per developer document sections 4, 5, 7, 8, 9, 12, 16-20.
--     Excluded by business instruction (audio): dye recipe master,
--     machine allocation / machine planning, feeder allocation.
-- =====================================================================

-- ─────────────────────────────────────────────────────────────────
-- 1. PROCESS ROUTE MASTER  (doc §4)
--    The process sequence is configurable — never hard-coded.
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mst_process_route (
  id            BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id    BIGINT UNSIGNED NOT NULL,
  route_code    VARCHAR(40)  NOT NULL,
  route_name    VARCHAR(150) NOT NULL,
  yarn_id       BIGINT UNSIGNED NULL COMMENT 'Applicable yarn, NULL = any',
  fabric_id     BIGINT UNSIGNED NULL,
  remarks       VARCHAR(500) NULL,
  is_active     TINYINT(1) NOT NULL DEFAULT 1,
  created_by    BIGINT UNSIGNED NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_route (company_id, route_code),
  CONSTRAINT fk_route__company FOREIGN KEY (company_id) REFERENCES mst_company(id),
  CONSTRAINT fk_route__yarn    FOREIGN KEY (yarn_id)    REFERENCES mst_yarn(id),
  CONSTRAINT fk_route__fabric  FOREIGN KEY (fabric_id)  REFERENCES mst_fabric(id)
) ENGINE=InnoDB COMMENT='Process route master (configurable sequence)';

CREATE TABLE IF NOT EXISTS mst_process_route_line (
  id            BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  route_id      BIGINT UNSIGNED NOT NULL,
  seq_no        INT NOT NULL DEFAULT 1,
  process_type  ENUM('YARN_DYEING','WINDING','TWISTING','KNITTING','COLLAR_KNITTING') NOT NULL,
  is_mandatory  TINYINT(1) NOT NULL DEFAULT 1,
  default_loss_pct DECIMAL(7,3) NOT NULL DEFAULT 0,
  allowed_unit  ENUM('INTERNAL','JOB_WORK','BOTH') NOT NULL DEFAULT 'BOTH',
  is_active     TINYINT(1) NOT NULL DEFAULT 1,
  KEY ix_prl_route (route_id),
  CONSTRAINT fk_prl__route FOREIGN KEY (route_id)
    REFERENCES mst_process_route(id) ON DELETE CASCADE
) ENGINE=InnoDB COMMENT='Process route sequence lines';

-- ─────────────────────────────────────────────────────────────────
-- 2. COMMON PROCESS HEADER  (doc §5, §6)
--    One table backs Dyeing / Winding / Twisting so the shared
--    engine (reserve -> issue -> produce -> receipt -> QC) is
--    written once. Process-specific columns live in the extension
--    tables below; the screens stay separate.
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS trx_yarn_process (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  process_no      VARCHAR(60) NOT NULL,
  process_date    DATE NOT NULL,
  process_type    ENUM('YARN_DYEING','WINDING','TWISTING') NOT NULL,

  route_id        BIGINT UNSIGNED NULL,
  route_seq_no    INT NULL,

  -- Order linkage / traceability
  so_id           BIGINT UNSIGNED NULL,
  so_line_id      BIGINT UNSIGNED NULL,
  io_no           VARCHAR(60) NULL,
  buyer_po_no     VARCHAR(60) NULL,
  style_id        BIGINT UNSIGNED NULL,
  part_name       VARCHAR(50) NULL COMMENT 'Carried from SO line',

  -- Input material
  yarn_id         BIGINT UNSIGNED NULL,
  input_qty_kg    DECIMAL(14,3) NOT NULL DEFAULT 0,
  expected_loss_pct DECIMAL(7,3) NOT NULL DEFAULT 0,
  expected_output DECIMAL(14,3) NOT NULL DEFAULT 0
                  COMMENT 'Output UOM: KG for dyeing/twisting, KG for winding (cones tracked separately)',

  required_date   DATE NULL,
  priority        ENUM('NORMAL','URGENT','HOLD') NOT NULL DEFAULT 'NORMAL',
  job_work_type   ENUM('INTERNAL','JOB_WORK') NOT NULL DEFAULT 'INTERNAL',
  vendor_id       BIGINT UNSIGNED NULL,
  warehouse_id    BIGINT UNSIGNED NULL,

  status          ENUM('DRAFT','STOCK_CHECK','RESERVED','RELEASED','MATERIAL_ISSUED',
                       'IN_PROGRESS','PRODUCTION_COMPLETED','OUTPUT_RECEIPT','QC',
                       'STOCK_POSTED','COMPLETED','CANCELLED') NOT NULL DEFAULT 'DRAFT',
  remarks         TEXT NULL,
  created_by      BIGINT UNSIGNED NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME ON UPDATE CURRENT_TIMESTAMP,

  UNIQUE KEY uq_yproc_no (company_id, process_no),
  KEY ix_yp_type (process_type), KEY ix_yp_status (status),
  KEY ix_yp_yarn (yarn_id), KEY ix_yp_soline (so_line_id),
  CONSTRAINT fk_yp__company FOREIGN KEY (company_id) REFERENCES mst_company(id),
  CONSTRAINT fk_yp__yarn    FOREIGN KEY (yarn_id)    REFERENCES mst_yarn(id),
  CONSTRAINT fk_yp__style   FOREIGN KEY (style_id)   REFERENCES mst_style(id),
  CONSTRAINT fk_yp__vendor  FOREIGN KEY (vendor_id)  REFERENCES mst_party(id),
  CONSTRAINT fk_yp__route   FOREIGN KEY (route_id)   REFERENCES mst_process_route(id)
) ENGINE=InnoDB COMMENT='Common yarn process header (dyeing / winding / twisting)';

-- Dyeing-specific attributes (doc §7.1). Dye recipe excluded per audio.
CREATE TABLE IF NOT EXISTS trx_yarn_process_dyeing (
  process_id    BIGINT UNSIGNED PRIMARY KEY,
  colour_code   VARCHAR(60)  NULL,
  colour_name   VARCHAR(120) NULL,
  shade_code    VARCHAR(60)  NULL,
  shade_name    VARCHAR(120) NULL,
  batch_no      VARCHAR(60)  NULL,
  temperature   VARCHAR(40)  NULL,
  duration_min  INT NULL,
  liquor_ratio  VARCHAR(40)  NULL,
  CONSTRAINT fk_ypd__proc FOREIGN KEY (process_id)
    REFERENCES trx_yarn_process(id) ON DELETE CASCADE
) ENGINE=InnoDB COMMENT='Yarn dyeing attributes';

-- Winding-specific attributes (doc §8.1)
CREATE TABLE IF NOT EXISTS trx_yarn_process_winding (
  process_id        BIGINT UNSIGNED PRIMARY KEY,
  cone_type         VARCHAR(60) NULL,
  target_cone_wt_kg DECIMAL(10,3) NULL,
  target_cone_count INT NULL COMMENT 'Calculated: input / target cone weight',
  speed_rpm         VARCHAR(40) NULL,
  operator          VARCHAR(120) NULL,
  shift             VARCHAR(40) NULL,
  CONSTRAINT fk_ypw__proc FOREIGN KEY (process_id)
    REFERENCES trx_yarn_process(id) ON DELETE CASCADE
) ENGINE=InnoDB COMMENT='Winding attributes';

-- Twisting-specific attributes (doc §9.1)
CREATE TABLE IF NOT EXISTS trx_yarn_process_twisting (
  process_id    BIGINT UNSIGNED PRIMARY KEY,
  twist_type    ENUM('S','Z') NULL,
  ply           INT NULL,
  target_count  VARCHAR(40) NULL COMMENT 'e.g. 40/2',
  tpi           DECIMAL(10,3) NULL,
  spindle_speed VARCHAR(40) NULL,
  operator      VARCHAR(120) NULL,
  shift         VARCHAR(40) NULL,
  CONSTRAINT fk_ypt__proc FOREIGN KEY (process_id)
    REFERENCES trx_yarn_process(id) ON DELETE CASCADE
) ENGINE=InnoDB COMMENT='Twisting attributes';

-- ─────────────────────────────────────────────────────────────────
-- 3. SHARED ENGINE: reservation, lot allocation, issue, receipt, QC
--    (doc §5, §12, §18, §19, §20)
--
--    These tables are polymorphic over the source document so the
--    same engine serves yarn processes, knitting programs and collar
--    programs. src_type says which document src_id points at.
-- ─────────────────────────────────────────────────────────────────

-- Reservation does NOT reduce physical stock (doc §12).
CREATE TABLE IF NOT EXISTS trx_process_reservation (
  id            BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id    BIGINT UNSIGNED NOT NULL,
  src_type      ENUM('YARN_PROCESS','KNITTING_PROGRAM','COLLAR_PROGRAM') NOT NULL,
  src_id        BIGINT UNSIGNED NOT NULL,
  src_line_id   BIGINT UNSIGNED NULL COMMENT 'e.g. knitting program yarn line',
  yarn_id       BIGINT UNSIGNED NULL,
  required_qty_kg DECIMAL(14,3) NOT NULL DEFAULT 0,
  reserved_qty_kg DECIMAL(14,3) NOT NULL DEFAULT 0,
  released_qty_kg DECIMAL(14,3) NOT NULL DEFAULT 0
                  COMMENT 'Reservation consumed by issue',
  status        ENUM('ACTIVE','PARTIAL','CONSUMED','CANCELLED') NOT NULL DEFAULT 'ACTIVE',
  created_by    BIGINT UNSIGNED NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME ON UPDATE CURRENT_TIMESTAMP,
  KEY ix_pres_src (src_type, src_id),
  KEY ix_pres_yarn (yarn_id),
  CONSTRAINT fk_pres__company FOREIGN KEY (company_id) REFERENCES mst_company(id),
  CONSTRAINT fk_pres__yarn    FOREIGN KEY (yarn_id)    REFERENCES mst_yarn(id)
) ENGINE=InnoDB COMMENT='Yarn reservations (no physical stock movement)';

-- Lot / cone allocation against a reservation (doc §12)
CREATE TABLE IF NOT EXISTS trx_process_lot_allocation (
  id             BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  reservation_id BIGINT UNSIGNED NOT NULL,
  batch_id       BIGINT UNSIGNED NULL,
  lot_no         VARCHAR(80) NULL,
  cone_id        BIGINT UNSIGNED NULL COMMENT 'trx_winding_cone.id when sourced from winding',
  allocated_qty_kg DECIMAL(14,3) NOT NULL DEFAULT 0,
  issued_qty_kg  DECIMAL(14,3) NOT NULL DEFAULT 0,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_pla_res (reservation_id),
  CONSTRAINT fk_pla__res FOREIGN KEY (reservation_id)
    REFERENCES trx_process_reservation(id) ON DELETE CASCADE,
  CONSTRAINT fk_pla__batch FOREIGN KEY (batch_id) REFERENCES mst_batch(id)
) ENGINE=InnoDB COMMENT='Lot / cone allocation per reservation';

-- Material issue. Issue DOES move stock (doc §18) — posts to trx_stock_ledger.
CREATE TABLE IF NOT EXISTS trx_process_issue (
  id            BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id    BIGINT UNSIGNED NOT NULL,
  issue_no      VARCHAR(60) NOT NULL,
  issue_date    DATE NOT NULL,
  src_type      ENUM('YARN_PROCESS','KNITTING_PROGRAM','COLLAR_PROGRAM') NOT NULL,
  src_id        BIGINT UNSIGNED NOT NULL,
  src_line_id   BIGINT UNSIGNED NULL,
  reservation_id BIGINT UNSIGNED NULL,
  yarn_id       BIGINT UNSIGNED NULL,
  batch_id      BIGINT UNSIGNED NULL,
  lot_no        VARCHAR(80) NULL,
  yarn_po_no    VARCHAR(80) NULL COMMENT 'Traceability back to the yarn PO',
  warehouse_id  BIGINT UNSIGNED NULL,
  issued_qty_kg DECIMAL(14,3) NOT NULL DEFAULT 0,
  is_override   TINYINT(1) NOT NULL DEFAULT 0
                COMMENT 'Set when issue exceeded available/reserved with authorisation',
  override_reason VARCHAR(255) NULL,
  remarks       TEXT NULL,
  created_by    BIGINT UNSIGNED NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_pissue (company_id, issue_no),
  KEY ix_pis_src (src_type, src_id),
  CONSTRAINT fk_pis__company FOREIGN KEY (company_id) REFERENCES mst_company(id),
  CONSTRAINT fk_pis__yarn    FOREIGN KEY (yarn_id)    REFERENCES mst_yarn(id),
  CONSTRAINT fk_pis__batch   FOREIGN KEY (batch_id)   REFERENCES mst_batch(id),
  CONSTRAINT fk_pis__res     FOREIGN KEY (reservation_id)
    REFERENCES trx_process_reservation(id)
) ENGINE=InnoDB COMMENT='Material issue against a process (moves stock)';

-- Process receipt / output (doc §19). Output UOM varies by process.
CREATE TABLE IF NOT EXISTS trx_process_receipt (
  id            BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id    BIGINT UNSIGNED NOT NULL,
  receipt_no    VARCHAR(60) NOT NULL,
  receipt_date  DATE NOT NULL,
  src_type      ENUM('YARN_PROCESS','KNITTING_PROGRAM','COLLAR_PROGRAM') NOT NULL,
  src_id        BIGINT UNSIGNED NOT NULL,

  input_qty     DECIMAL(14,3) NOT NULL DEFAULT 0 COMMENT 'Source UOM (KG)',
  output_qty    DECIMAL(14,3) NOT NULL DEFAULT 0 COMMENT 'Process output UOM',
  output_uom_id SMALLINT UNSIGNED NULL,
  loss_qty      DECIMAL(14,3) NOT NULL DEFAULT 0,
  rejected_qty  DECIMAL(14,3) NOT NULL DEFAULT 0,

  output_lot_no VARCHAR(80) NULL COMMENT 'Generated destination lot',
  output_batch_id BIGINT UNSIGNED NULL,
  warehouse_id  BIGINT UNSIGNED NULL,
  qc_status     ENUM('PENDING','PASSED','HOLD','REJECTED') NOT NULL DEFAULT 'PENDING',
  is_stock_posted TINYINT(1) NOT NULL DEFAULT 0,
  remarks       TEXT NULL,
  created_by    BIGINT UNSIGNED NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_precpt (company_id, receipt_no),
  KEY ix_prc_src (src_type, src_id),
  CONSTRAINT fk_prc__company FOREIGN KEY (company_id) REFERENCES mst_company(id),
  CONSTRAINT fk_prc__uom     FOREIGN KEY (output_uom_id) REFERENCES cfg_uom(id),
  CONSTRAINT fk_prc__batch   FOREIGN KEY (output_batch_id) REFERENCES mst_batch(id)
) ENGINE=InnoDB COMMENT='Process output receipt';

-- Winding cone traceability (doc §8.2, §8.3)
CREATE TABLE IF NOT EXISTS trx_winding_cone (
  id            BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  receipt_id    BIGINT UNSIGNED NOT NULL,
  process_id    BIGINT UNSIGNED NOT NULL,
  cone_no       VARCHAR(60) NOT NULL,
  source_lot_no VARCHAR(80) NULL COMMENT 'Yarn lot this cone was wound from',
  weight_kg     DECIMAL(10,3) NOT NULL DEFAULT 0,
  status        ENUM('GOOD','REJECTED') NOT NULL DEFAULT 'GOOD',
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_cone_receipt (receipt_id), KEY ix_cone_proc (process_id),
  CONSTRAINT fk_cone__receipt FOREIGN KEY (receipt_id)
    REFERENCES trx_process_receipt(id) ON DELETE CASCADE,
  CONSTRAINT fk_cone__proc FOREIGN KEY (process_id)
    REFERENCES trx_yarn_process(id) ON DELETE CASCADE
) ENGINE=InnoDB COMMENT='Individual wound cones (yarn lot -> cone traceability)';

-- Process QC (doc §20). Points differ per process; stored as rows.
CREATE TABLE IF NOT EXISTS trx_process_qc (
  id            BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id    BIGINT UNSIGNED NOT NULL,
  src_type      ENUM('YARN_PROCESS','KNITTING_PROGRAM','COLLAR_PROGRAM') NOT NULL,
  src_id        BIGINT UNSIGNED NOT NULL,
  receipt_id    BIGINT UNSIGNED NULL,
  qc_date       DATE NOT NULL,
  process_type  VARCHAR(40) NULL,
  overall_status ENUM('PENDING','PASSED','HOLD','REJECTED') NOT NULL DEFAULT 'PENDING',
  checked_by    BIGINT UNSIGNED NULL,
  remarks       TEXT NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_pqc_src (src_type, src_id),
  CONSTRAINT fk_pqc__company FOREIGN KEY (company_id) REFERENCES mst_company(id),
  CONSTRAINT fk_pqc__receipt FOREIGN KEY (receipt_id)
    REFERENCES trx_process_receipt(id) ON DELETE CASCADE
) ENGINE=InnoDB COMMENT='Process QC header';

CREATE TABLE IF NOT EXISTS trx_process_qc_line (
  id            BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  qc_id         BIGINT UNSIGNED NOT NULL,
  parameter     VARCHAR(80) NOT NULL COMMENT 'e.g. Shade, TPI, GSM, Cone Weight',
  expected_value VARCHAR(80) NULL,
  actual_value  VARCHAR(80) NULL,
  result        ENUM('PASS','FAIL','NA') NOT NULL DEFAULT 'NA',
  remarks       VARCHAR(255) NULL,
  KEY ix_pqcl_qc (qc_id),
  CONSTRAINT fk_pqcl__qc FOREIGN KEY (qc_id)
    REFERENCES trx_process_qc(id) ON DELETE CASCADE
) ENGINE=InnoDB COMMENT='Process QC parameter lines';

-- ─────────────────────────────────────────────────────────────────
-- 4. COLLAR KNITTING  (doc §16, §17)
--    Separate process: output is PCS while yarn consumption is KG.
--    Standard weight is for PLANNING only — actual production records
--    actual KG and actual PCS, and the actual gm/pc is derived from
--    them. Never a fixed KG->PCS conversion (doc §17, §29).
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mst_collar (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  collar_code     VARCHAR(40) NOT NULL,
  style_id        BIGINT UNSIGNED NULL,
  collar_type     VARCHAR(60) NULL COMMENT 'e.g. 1x1 Rib',
  construction    VARCHAR(60) NULL,
  size_id         INT UNSIGNED NULL,
  colour          VARCHAR(80) NULL,
  yarn_id         BIGINT UNSIGNED NULL,
  std_weight_gm   DECIMAL(10,3) NOT NULL DEFAULT 0 COMMENT 'Standard grams per piece (planning)',
  is_active       TINYINT(1) NOT NULL DEFAULT 1,
  created_by      BIGINT UNSIGNED NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_collar (company_id, collar_code),
  KEY ix_collar_style (style_id),
  CONSTRAINT fk_collar__company FOREIGN KEY (company_id) REFERENCES mst_company(id),
  CONSTRAINT fk_collar__style   FOREIGN KEY (style_id)   REFERENCES mst_style(id),
  CONSTRAINT fk_collar__size    FOREIGN KEY (size_id)    REFERENCES mst_size(id),
  CONSTRAINT fk_collar__yarn    FOREIGN KEY (yarn_id)    REFERENCES mst_yarn(id)
) ENGINE=InnoDB COMMENT='Collar master / collar BOM';

CREATE TABLE IF NOT EXISTS trx_collar_program (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  program_no      VARCHAR(60) NOT NULL,
  program_date    DATE NOT NULL,

  so_id           BIGINT UNSIGNED NULL,
  so_line_id      BIGINT UNSIGNED NULL,
  io_no           VARCHAR(60) NULL,
  buyer_po_no     VARCHAR(60) NULL,
  style_id        BIGINT UNSIGNED NULL,
  part_name       VARCHAR(50) NULL DEFAULT 'COLLAR',

  collar_id       BIGINT UNSIGNED NULL,
  collar_type     VARCHAR(60) NULL,
  colour          VARCHAR(80) NULL,
  yarn_id         BIGINT UNSIGNED NULL,
  gauge_needle    VARCHAR(40) NULL,

  planned_yarn_kg DECIMAL(14,3) NOT NULL DEFAULT 0,
  expected_pcs    INT NOT NULL DEFAULT 0
                  COMMENT 'Planning figure derived from size-wise standard weights',
  required_date   DATE NULL,
  job_work_type   ENUM('INTERNAL','JOB_WORK') NOT NULL DEFAULT 'INTERNAL',
  vendor_id       BIGINT UNSIGNED NULL,

  status          ENUM('DRAFT','STOCK_CHECK','RESERVED','RELEASED','MATERIAL_ISSUED',
                       'IN_PROGRESS','PRODUCTION_COMPLETED','OUTPUT_RECEIPT','QC',
                       'STOCK_POSTED','COMPLETED','CANCELLED') NOT NULL DEFAULT 'DRAFT',
  remarks         TEXT NULL,
  created_by      BIGINT UNSIGNED NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_collar_prog (company_id, program_no),
  KEY ix_cp_status (status), KEY ix_cp_soline (so_line_id),
  CONSTRAINT fk_cprog__company FOREIGN KEY (company_id) REFERENCES mst_company(id),
  CONSTRAINT fk_cprog__collar  FOREIGN KEY (collar_id)  REFERENCES mst_collar(id),
  CONSTRAINT fk_cprog__style   FOREIGN KEY (style_id)   REFERENCES mst_style(id),
  CONSTRAINT fk_cprog__yarn    FOREIGN KEY (yarn_id)    REFERENCES mst_yarn(id),
  CONSTRAINT fk_cprog__vendor  FOREIGN KEY (vendor_id)  REFERENCES mst_party(id)
) ENGINE=InnoDB COMMENT='Collar knitting program (PCS output, KG consumption)';

-- Size-wise planning (doc §16.3)
CREATE TABLE IF NOT EXISTS trx_collar_program_size (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  program_id      BIGINT UNSIGNED NOT NULL,
  size_id         INT UNSIGNED NULL,
  size_code       VARCHAR(40) NULL,
  std_weight_gm   DECIMAL(10,3) NOT NULL DEFAULT 0,
  planned_pcs     INT NOT NULL DEFAULT 0,
  std_yarn_kg     DECIMAL(14,3) NOT NULL DEFAULT 0
                  COMMENT 'planned_pcs * std_weight_gm / 1000 (planning only)',
  produced_pcs    INT NOT NULL DEFAULT 0,
  KEY ix_cps_prog (program_id),
  CONSTRAINT fk_colps__prog FOREIGN KEY (program_id)
    REFERENCES trx_collar_program(id) ON DELETE CASCADE,
  CONSTRAINT fk_colps__size FOREIGN KEY (size_id) REFERENCES mst_size(id)
) ENGINE=InnoDB COMMENT='Collar program size-wise PCS planning';

-- Collar production entry (doc §16.4). Actual KG and actual PCS both recorded.
CREATE TABLE IF NOT EXISTS trx_collar_production (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  program_id      BIGINT UNSIGNED NOT NULL,
  entry_no        VARCHAR(60) NOT NULL,
  production_date DATE NOT NULL,
  size_id         INT UNSIGNED NULL,
  shift           VARCHAR(40) NULL,
  planned_pcs     INT NOT NULL DEFAULT 0,
  produced_pcs    INT NOT NULL DEFAULT 0,
  rejected_pcs    INT NOT NULL DEFAULT 0,
  good_pcs        INT NOT NULL DEFAULT 0,
  actual_yarn_kg  DECIMAL(14,3) NOT NULL DEFAULT 0,
  -- Derived, never assumed: actual grams per piece from actual KG / actual PCS.
  actual_wt_gm_pc DECIMAL(10,3) GENERATED ALWAYS AS (
    CASE WHEN produced_pcs > 0 THEN (actual_yarn_kg * 1000) / produced_pcs ELSE NULL END
  ) STORED,
  remarks         TEXT NULL,
  created_by      BIGINT UNSIGNED NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_cprod (company_id, entry_no),
  KEY ix_cprod_prog (program_id),
  CONSTRAINT fk_cprod__company FOREIGN KEY (company_id) REFERENCES mst_company(id),
  CONSTRAINT fk_cprod__prog FOREIGN KEY (program_id)
    REFERENCES trx_collar_program(id) ON DELETE CASCADE,
  CONSTRAINT fk_cprod__size FOREIGN KEY (size_id) REFERENCES mst_size(id)
) ENGINE=InnoDB COMMENT='Collar production (actual PCS + actual KG)';

-- ─────────────────────────────────────────────────────────────────
-- 5. KNITTING PRODUCTION & FABRIC ROLL RECEIPT  (doc §14, §15)
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS trx_knitting_production (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  program_id      BIGINT UNSIGNED NOT NULL,
  entry_no        VARCHAR(60) NOT NULL,
  production_date DATE NOT NULL,
  shift           VARCHAR(40) NULL,
  production_qty_kg DECIMAL(14,3) NOT NULL DEFAULT 0,
  wastage_kg      DECIMAL(14,3) NOT NULL DEFAULT 0,
  rejection_kg    DECIMAL(14,3) NOT NULL DEFAULT 0,
  remarks         TEXT NULL,
  created_by      BIGINT UNSIGNED NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_kprod (company_id, entry_no),
  KEY ix_kprod_prog (program_id),
  CONSTRAINT fk_kprod__company FOREIGN KEY (company_id) REFERENCES mst_company(id),
  CONSTRAINT fk_kprod__prog FOREIGN KEY (program_id)
    REFERENCES trx_knitting_program(id) ON DELETE CASCADE
) ENGINE=InnoDB COMMENT='Knitting production entry';

-- Actual yarn consumption per production entry, yarn-wise (doc §14)
CREATE TABLE IF NOT EXISTS trx_knitting_production_yarn (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  production_id   BIGINT UNSIGNED NOT NULL,
  program_yarn_id BIGINT UNSIGNED NULL,
  yarn_id         BIGINT UNSIGNED NULL,
  used_qty_kg     DECIMAL(14,3) NOT NULL DEFAULT 0,
  KEY ix_kpy2_prod (production_id),
  CONSTRAINT fk_kpy2__prod FOREIGN KEY (production_id)
    REFERENCES trx_knitting_production(id) ON DELETE CASCADE,
  CONSTRAINT fk_kpy2__yarn FOREIGN KEY (yarn_id) REFERENCES mst_yarn(id)
) ENGINE=InnoDB COMMENT='Actual yarn consumption per knitting production entry';

CREATE TABLE IF NOT EXISTS trx_knitting_roll (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  program_id      BIGINT UNSIGNED NULL,
  production_id   BIGINT UNSIGNED NULL,
  receipt_no      VARCHAR(60) NULL,
  roll_no         VARCHAR(60) NOT NULL,
  receipt_date    DATE NOT NULL,
  gross_weight_kg DECIMAL(12,3) NOT NULL DEFAULT 0,
  tare_kg         DECIMAL(12,3) NOT NULL DEFAULT 0,
  net_weight_kg   DECIMAL(12,3) GENERATED ALWAYS AS (gross_weight_kg - tare_kg) STORED,
  meters          DECIMAL(12,3) NULL,
  actual_gsm      VARCHAR(40) NULL,
  actual_dia      VARCHAR(40) NULL,
  qc_status       ENUM('PENDING','PASSED','HOLD','REJECTED') NOT NULL DEFAULT 'PENDING',
  warehouse_id    BIGINT UNSIGNED NULL,
  is_stock_posted TINYINT(1) NOT NULL DEFAULT 0,
  created_by      BIGINT UNSIGNED NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_kroll (company_id, roll_no),
  KEY ix_kroll_prog (program_id),
  CONSTRAINT fk_kroll__company FOREIGN KEY (company_id) REFERENCES mst_company(id),
  CONSTRAINT fk_kroll__prog FOREIGN KEY (program_id)
    REFERENCES trx_knitting_program(id) ON DELETE SET NULL,
  CONSTRAINT fk_kroll__prod FOREIGN KEY (production_id)
    REFERENCES trx_knitting_production(id) ON DELETE SET NULL
) ENGINE=InnoDB COMMENT='Knitting output roll receipt (doc §15)';

-- ─────────────────────────────────────────────────────────────────
-- 6. NUMBER SERIES for the new documents
-- ─────────────────────────────────────────────────────────────────
INSERT INTO cfg_number_series (company_id, branch_id, doc_type, fy_id, prefix, next_number, padding)
SELECT c.id, NULL, d.doc_type, NULL, d.prefix, 1, 5
FROM mst_company c
JOIN (
  SELECT 'YARN_DYEING'   AS doc_type, 'DYE-'  AS prefix UNION ALL
  SELECT 'WINDING',        'WND-'  UNION ALL
  SELECT 'TWISTING',       'TWS-'  UNION ALL
  SELECT 'COLLAR_PROGRAM', 'CKP-'  UNION ALL
  SELECT 'COLLAR_PROD',    'CPR-'  UNION ALL
  SELECT 'KNIT_PROD',      'KPR-'  UNION ALL
  SELECT 'FABRIC_ROLL',    'ROLL-' UNION ALL
  SELECT 'PROC_ISSUE',     'PIS-'  UNION ALL
  SELECT 'PROC_RECEIPT',   'PRC-'
) d
WHERE NOT EXISTS (
  SELECT 1 FROM cfg_number_series s WHERE s.company_id = c.id AND s.doc_type = d.doc_type
);
