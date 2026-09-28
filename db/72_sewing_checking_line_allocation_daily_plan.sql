-- =====================================================================
-- Sewing & Checking Line Allocation + Daily Plan — New Tables
-- Doc: Garment_ERP_Sewing_Checking_Line_Allocation_Daily_Plan
-- =====================================================================

-- 1. Checking Line Master (parallels cfg_sewing_line)
CREATE TABLE IF NOT EXISTS cfg_checking_line (
  id            INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id    BIGINT UNSIGNED NOT NULL,
  line_code     VARCHAR(20)  NOT NULL,
  line_name     VARCHAR(80)  NOT NULL,
  unit_id       BIGINT UNSIGNED,
  capacity_pcs  INT UNSIGNED DEFAULT 0,
  manpower      INT UNSIGNED DEFAULT 0,
  working_hours DECIMAL(4,1) DEFAULT 8.0,
  sam_per_pcs   DECIMAL(8,4) DEFAULT 0,
  is_active     TINYINT(1)   NOT NULL DEFAULT 1,
  UNIQUE KEY uq_checking_line (company_id, line_code),
  CONSTRAINT fk_chkline__company FOREIGN KEY (company_id) REFERENCES mst_company(id),
  CONSTRAINT fk_chkline__unit    FOREIGN KEY (unit_id)    REFERENCES mst_unit(id)
) ENGINE=InnoDB COMMENT='Checking line master with capacity';

-- 2. Add SAM field to sewing line if missing
SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cfg_sewing_line' AND COLUMN_NAME = 'sam_per_pcs');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE cfg_sewing_line ADD COLUMN sam_per_pcs DECIMAL(8,4) DEFAULT 0 AFTER working_hours', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 3. Sewing Line Allocation V2 — multi-line, multi-job, bundle-level
CREATE TABLE IF NOT EXISTS trx_sewing_line_allocation (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  allocation_no   VARCHAR(40) NOT NULL,
  allocation_date DATE NOT NULL,
  floor_name      VARCHAR(40),
  shift_id        INT UNSIGNED,
  plan_type       ENUM('LINE_WISE','JOB_WISE') DEFAULT 'LINE_WISE',
  total_jobs      INT UNSIGNED DEFAULT 0,
  total_bundles   INT UNSIGNED DEFAULT 0,
  pending_qty     INT UNSIGNED DEFAULT 0,
  allocated_qty   INT UNSIGNED DEFAULT 0,
  unallocated_qty INT UNSIGNED DEFAULT 0,
  status          ENUM('DRAFT','SAVED','CONFIRMED','CLOSED','CANCELLED') DEFAULT 'DRAFT',
  remarks         VARCHAR(500),
  created_by      BIGINT UNSIGNED,
  confirmed_by    BIGINT UNSIGNED,
  confirmed_at    DATETIME,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_sew_alloc (company_id, allocation_no),
  CONSTRAINT fk_sewalloc__company FOREIGN KEY (company_id) REFERENCES mst_company(id),
  CONSTRAINT fk_sewalloc__shift   FOREIGN KEY (shift_id)   REFERENCES cfg_shift(id)
) ENGINE=InnoDB COMMENT='Sewing line allocation header (multi-job, bundle-level)';

-- 4. Sewing Line Allocation Details — bundle → line mapping
CREATE TABLE IF NOT EXISTS trx_sewing_line_allocation_detail (
  id                    BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  allocation_id         BIGINT UNSIGNED NOT NULL,
  line_id               INT UNSIGNED NOT NULL,
  bundle_id             BIGINT UNSIGNED NOT NULL,
  job_id                BIGINT UNSIGNED,              -- trx_production_order
  style_id              BIGINT UNSIGNED,
  colour_id             BIGINT UNSIGNED,
  size_id               BIGINT UNSIGNED,
  po_no                 VARCHAR(40),
  allocated_qty         INT UNSIGNED NOT NULL,
  sam                   DECIMAL(8,4) DEFAULT 0,
  planned_qty           INT UNSIGNED DEFAULT 0,
  status                ENUM('ALLOCATED','COMPLETED','CANCELLED') DEFAULT 'ALLOCATED',
  remarks               VARCHAR(255),
  CONSTRAINT fk_sewallocd__alloc  FOREIGN KEY (allocation_id) REFERENCES trx_sewing_line_allocation(id),
  CONSTRAINT fk_sewallocd__line   FOREIGN KEY (line_id)       REFERENCES cfg_sewing_line(id),
  CONSTRAINT fk_sewallocd__bundle FOREIGN KEY (bundle_id)     REFERENCES trx_cutting_bundle(id),
  KEY ix_sewallocd_line (line_id),
  KEY ix_sewallocd_job (job_id)
) ENGINE=InnoDB COMMENT='Sewing line allocation detail — bundle to line mapping';

-- 5. Checking Line Allocation
CREATE TABLE IF NOT EXISTS trx_checking_line_allocation (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  allocation_no   VARCHAR(40) NOT NULL,
  allocation_date DATE NOT NULL,
  floor_name      VARCHAR(40),
  shift_id        INT UNSIGNED,
  plan_type       ENUM('LINE_WISE','JOB_WISE') DEFAULT 'LINE_WISE',
  total_bundles   INT UNSIGNED DEFAULT 0,
  total_qty       INT UNSIGNED DEFAULT 0,
  allocated_qty   INT UNSIGNED DEFAULT 0,
  unallocated_qty INT UNSIGNED DEFAULT 0,
  status          ENUM('DRAFT','SAVED','CONFIRMED','CLOSED','CANCELLED') DEFAULT 'DRAFT',
  remarks         VARCHAR(500),
  created_by      BIGINT UNSIGNED,
  confirmed_by    BIGINT UNSIGNED,
  confirmed_at    DATETIME,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_chk_alloc (company_id, allocation_no),
  CONSTRAINT fk_chkalloc__company FOREIGN KEY (company_id) REFERENCES mst_company(id),
  CONSTRAINT fk_chkalloc__shift   FOREIGN KEY (shift_id)   REFERENCES cfg_shift(id)
) ENGINE=InnoDB COMMENT='Checking line allocation header';

-- 6. Checking Line Allocation Details
CREATE TABLE IF NOT EXISTS trx_checking_line_allocation_detail (
  id                    BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  allocation_id         BIGINT UNSIGNED NOT NULL,
  line_id               INT UNSIGNED NOT NULL,
  bundle_id             BIGINT UNSIGNED NOT NULL,
  job_id                BIGINT UNSIGNED,
  style_id              BIGINT UNSIGNED,
  colour_id             BIGINT UNSIGNED,
  size_id               BIGINT UNSIGNED,
  po_no                 VARCHAR(40),
  allocated_qty         INT UNSIGNED NOT NULL,
  planned_qty           INT UNSIGNED DEFAULT 0,
  status                ENUM('ALLOCATED','COMPLETED','CANCELLED') DEFAULT 'ALLOCATED',
  remarks               VARCHAR(255),
  CONSTRAINT fk_chkallocd__alloc  FOREIGN KEY (allocation_id) REFERENCES trx_checking_line_allocation(id),
  CONSTRAINT fk_chkallocd__line   FOREIGN KEY (line_id)       REFERENCES cfg_checking_line(id),
  CONSTRAINT fk_chkallocd__bundle FOREIGN KEY (bundle_id)     REFERENCES trx_cutting_bundle(id),
  KEY ix_chkallocd_line (line_id),
  KEY ix_chkallocd_job (job_id)
) ENGINE=InnoDB COMMENT='Checking line allocation detail — bundle to line mapping';

-- 7. Checking Daily Plan
CREATE TABLE IF NOT EXISTS trx_checking_daily_plan (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  plan_no         VARCHAR(40) NOT NULL,
  plan_date       DATE NOT NULL,
  floor_name      VARCHAR(40),
  shift_id        INT UNSIGNED,
  plan_type       ENUM('LINE_WISE','JOB_WISE') DEFAULT 'LINE_WISE',
  total_bundles   INT UNSIGNED DEFAULT 0,
  total_qty       INT UNSIGNED DEFAULT 0,
  allocated_qty   INT UNSIGNED DEFAULT 0,
  unallocated_qty INT UNSIGNED DEFAULT 0,
  status          ENUM('DRAFT','SAVED','CONFIRMED','IN_PROGRESS','COMPLETED','CLOSED','CANCELLED') DEFAULT 'DRAFT',
  remarks         VARCHAR(500),
  created_by      BIGINT UNSIGNED,
  confirmed_by    BIGINT UNSIGNED,
  confirmed_at    DATETIME,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_chk_plan (company_id, plan_no),
  CONSTRAINT fk_chkplan__company FOREIGN KEY (company_id) REFERENCES mst_company(id),
  CONSTRAINT fk_chkplan__shift   FOREIGN KEY (shift_id)   REFERENCES cfg_shift(id)
) ENGINE=InnoDB COMMENT='Checking daily plan header';

-- 8. Checking Daily Plan Details
CREATE TABLE IF NOT EXISTS trx_checking_daily_plan_detail (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  plan_id         BIGINT UNSIGNED NOT NULL,
  line_id         INT UNSIGNED NOT NULL,
  bundle_id       BIGINT UNSIGNED,
  job_id          BIGINT UNSIGNED,
  style_id        BIGINT UNSIGNED,
  colour_id       BIGINT UNSIGNED,
  size_id         BIGINT UNSIGNED,
  po_no           VARCHAR(40),
  style_description VARCHAR(120),
  bundle_qty      INT UNSIGNED DEFAULT 0,
  planned_qty     INT UNSIGNED DEFAULT 0,
  priority        INT DEFAULT 0,
  status          ENUM('PLANNED','IN_PROGRESS','COMPLETED','CANCELLED') DEFAULT 'PLANNED',
  remarks         VARCHAR(255),
  CONSTRAINT fk_chkpland__plan   FOREIGN KEY (plan_id) REFERENCES trx_checking_daily_plan(id),
  CONSTRAINT fk_chkpland__line   FOREIGN KEY (line_id) REFERENCES cfg_checking_line(id),
  KEY ix_chkpland_line (line_id),
  KEY ix_chkpland_job (job_id)
) ENGINE=InnoDB COMMENT='Checking daily plan detail — bundle to line';

-- 9. Sewing Daily Plan V2 (bundle-level, multi-line)
CREATE TABLE IF NOT EXISTS trx_sewing_daily_plan (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  plan_no         VARCHAR(40) NOT NULL,
  plan_date       DATE NOT NULL,
  floor_name      VARCHAR(40),
  shift_id        INT UNSIGNED,
  plan_type       ENUM('LINE_WISE','JOB_WISE') DEFAULT 'LINE_WISE',
  total_bundles   INT UNSIGNED DEFAULT 0,
  total_qty       INT UNSIGNED DEFAULT 0,
  allocated_qty   INT UNSIGNED DEFAULT 0,
  unallocated_qty INT UNSIGNED DEFAULT 0,
  status          ENUM('DRAFT','SAVED','CONFIRMED','IN_PROGRESS','COMPLETED','CLOSED','CANCELLED') DEFAULT 'DRAFT',
  remarks         VARCHAR(500),
  created_by      BIGINT UNSIGNED,
  confirmed_by    BIGINT UNSIGNED,
  confirmed_at    DATETIME,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_sew_plan (company_id, plan_no),
  CONSTRAINT fk_sewplan__company FOREIGN KEY (company_id) REFERENCES mst_company(id),
  CONSTRAINT fk_sewplan__shift   FOREIGN KEY (shift_id)   REFERENCES cfg_shift(id)
) ENGINE=InnoDB COMMENT='Sewing daily plan header (v2 — bundle-level)';

-- 10. Sewing Daily Plan Details
CREATE TABLE IF NOT EXISTS trx_sewing_daily_plan_detail (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  plan_id         BIGINT UNSIGNED NOT NULL,
  line_id         INT UNSIGNED NOT NULL,
  bundle_id       BIGINT UNSIGNED,
  job_id          BIGINT UNSIGNED,
  style_id        BIGINT UNSIGNED,
  colour_id       BIGINT UNSIGNED,
  size_id         BIGINT UNSIGNED,
  po_no           VARCHAR(40),
  style_description VARCHAR(120),
  bundle_qty      INT UNSIGNED DEFAULT 0,
  planned_qty     INT UNSIGNED DEFAULT 0,
  sam             DECIMAL(8,4) DEFAULT 0,
  priority        INT DEFAULT 0,
  status          ENUM('PLANNED','IN_PROGRESS','COMPLETED','CANCELLED') DEFAULT 'PLANNED',
  remarks         VARCHAR(255),
  CONSTRAINT fk_sewpland__plan   FOREIGN KEY (plan_id) REFERENCES trx_sewing_daily_plan(id),
  CONSTRAINT fk_sewpland__line   FOREIGN KEY (line_id) REFERENCES cfg_sewing_line(id),
  KEY ix_sewpland_line (line_id),
  KEY ix_sewpland_job (job_id)
) ENGINE=InnoDB COMMENT='Sewing daily plan detail — bundle to line';

-- Seed default checking lines for existing companies
INSERT IGNORE INTO cfg_checking_line (company_id, line_code, line_name, unit_id, capacity_pcs, manpower, working_hours, sam_per_pcs, is_active)
SELECT c.id, d.line_code, d.line_name,
       (SELECT id FROM mst_unit WHERE company_id = c.id LIMIT 1),
       d.capacity_pcs, d.manpower, 8.0, d.sam_per_pcs, 1
  FROM mst_company c
  CROSS JOIN (
    SELECT 'CHK-01' AS line_code, 'Checking Line 01 - Table 1' AS line_name, 1500 AS capacity_pcs, 12 AS manpower, 0.3500 AS sam_per_pcs UNION ALL
    SELECT 'CHK-02', 'Checking Line 02 - Table 2', 1500, 12, 0.3500 UNION ALL
    SELECT 'CHK-03', 'Checking Line 03 - Table 3', 1200, 10, 0.3500 UNION ALL
    SELECT 'CHK-04', 'Checking Line 04 - Table 4', 1000, 8, 0.4000 UNION ALL
    SELECT 'CHK-05', 'Checking Line 05 - Short Run & QC', 600, 6, 0.4000
  ) d
 WHERE NOT EXISTS (
   SELECT 1 FROM cfg_checking_line cl WHERE cl.company_id = c.id AND cl.line_code = d.line_code
 );

-- Number series for the new documents
INSERT INTO cfg_number_series (company_id, branch_id, doc_type, fy_id, prefix, next_number, padding)
SELECT c.id, NULL, d.doc_type, NULL, d.prefix, 1, 5
  FROM mst_company c
  CROSS JOIN (
    SELECT 'SEW_LINE_ALLOC' AS doc_type, 'SLA-' AS prefix UNION ALL
    SELECT 'CHK_LINE_ALLOC', 'CLA-' UNION ALL
    SELECT 'SEW_DAILY_PLAN', 'SDP-' UNION ALL
    SELECT 'CHK_DAILY_PLAN', 'CDP-'
  ) d
 WHERE NOT EXISTS (
   SELECT 1 FROM cfg_number_series s
    WHERE s.company_id = c.id AND s.doc_type = d.doc_type
 );
