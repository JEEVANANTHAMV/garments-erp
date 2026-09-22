-- =====================================================================
-- 43. KNITTING PROGRAM (Multi-Yarn, Stripe Pattern, Yarn Traceability)
--     AND PART NAME (TOP / BOTTOM / COLLAR / CUFF / FOLDING) TRACEABILITY
-- =====================================================================
-- Exclusions per business instruction:
--   ✗ Machine allocation / machine planning
--   ✗ Feeder allocation
--   ✗ Dye recipe master
-- =====================================================================

-- ─────────────────────────────────────────────────────────────────
-- 1. KNITTING PROGRAM HEADER
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS trx_knitting_program (
  id                BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id        BIGINT UNSIGNED NOT NULL,
  program_no        VARCHAR(60) NOT NULL,
  program_date      DATE NOT NULL,

  -- Traceability links (from Sale Order / Gate Conception)
  so_id             BIGINT UNSIGNED NULL,
  io_no             VARCHAR(60) NULL,
  buyer_po_no       VARCHAR(60) NULL,
  style_id          BIGINT UNSIGNED NULL,

  -- Garment part this program is knitting for
  part_name         VARCHAR(50) NULL DEFAULT 'TOP'
                    COMMENT 'TOP / BOTTOM / COLLAR / CUFF / FOLDING / OTHER',

  -- Fabric specification
  fabric_id         BIGINT UNSIGNED NULL,
  fabric_type       VARCHAR(80) NULL
                    COMMENT 'e.g. Single Jersey, Rib, Interlock, Fleece',
  knitting_type     ENUM('SOLID','STRIPE','FEEDER_STRIPE','ENGINEERED_STRIPE','MULTI_YARN','OTHER')
                    NOT NULL DEFAULT 'SOLID',

  gsm               VARCHAR(40) NULL    COMMENT 'Target GSM',
  dia               VARCHAR(40) NULL    COMMENT 'Target Dia (inches)',
  gauge             VARCHAR(40) NULL    COMMENT 'e.g. 24 GG',
  loop_length       VARCHAR(40) NULL,

  -- Quantities
  required_qty_kg   DECIMAL(14,3) NOT NULL DEFAULT 0
                    COMMENT 'Total fabric KG required',
  required_date     DATE NULL,

  -- Job-work flag
  job_work_type     ENUM('INTERNAL','JOB_WORK') NOT NULL DEFAULT 'INTERNAL',
  vendor_id         BIGINT UNSIGNED NULL
                    COMMENT 'Filled when job_work_type = JOB_WORK',

  -- Status workflow
  status            ENUM(
    'DRAFT','STOCK_CHECK','RESERVED','RELEASED',
    'MATERIAL_ISSUED','IN_PROGRESS','PRODUCTION_COMPLETED',
    'OUTPUT_RECEIPT','COMPLETED','CANCELLED'
  ) NOT NULL DEFAULT 'DRAFT',

  remarks           TEXT NULL,
  created_by        BIGINT UNSIGNED NULL,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME ON UPDATE CURRENT_TIMESTAMP,

  UNIQUE KEY uq_knit_prog_no (company_id, program_no),
  KEY ix_kp_io   (io_no),
  KEY ix_kp_so   (so_id),
  KEY ix_kp_style (style_id),
  KEY ix_kp_status (status),

  CONSTRAINT fk_kp__company FOREIGN KEY (company_id) REFERENCES mst_company(id),
  CONSTRAINT fk_kp__style   FOREIGN KEY (style_id)   REFERENCES mst_style(id),
  CONSTRAINT fk_kp__fabric  FOREIGN KEY (fabric_id)  REFERENCES mst_fabric(id),
  CONSTRAINT fk_kp__vendor  FOREIGN KEY (vendor_id)  REFERENCES mst_party(id)
) ENGINE=InnoDB COMMENT='Knitting Program header (multi-yarn, stripe support)';


-- ─────────────────────────────────────────────────────────────────
-- 2. KNITTING PROGRAM — YARN COMBINATION LINES
--    Unlimited yarn rows (no fixed Yarn A / Yarn B).
--    Holds Yarn PO No for full traceability: Buyer PO → SO → Knitting → Yarn Issue
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS trx_knitting_program_yarns (
  id                BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  program_id        BIGINT UNSIGNED NOT NULL,
  seq_no            INT NOT NULL DEFAULT 1   COMMENT 'Display order (1, 2, 3…)',

  -- Yarn details
  yarn_id           BIGINT UNSIGNED NULL,
  yarn_name_manual  VARCHAR(150) NULL
                    COMMENT 'Free-text when yarn is not in master',
  count_value       VARCHAR(30)  NULL         COMMENT 'e.g. 30s, 40/2 — auto-filled from yarn master',
  colour            VARCHAR(80)  NULL         COMMENT 'Colour description for this yarn in the program',

  -- Yarn PO traceability (Audio 2)
  yarn_po_no        VARCHAR(80)  NULL         COMMENT 'Yarn Purchase Order number for traceability',
  yarn_lot_no       VARCHAR(80)  NULL         COMMENT 'Yarn lot / GRN lot number',

  -- Quantities (KG)
  planning_ratio_pct DECIMAL(7,3) NULL        COMMENT 'Optional ratio % for multi-yarn / stripe split',
  planned_qty_kg    DECIMAL(14,3) NOT NULL DEFAULT 0,
  reserved_qty_kg   DECIMAL(14,3) NOT NULL DEFAULT 0,
  issued_qty_kg     DECIMAL(14,3) NOT NULL DEFAULT 0,

  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  KEY ix_kpy_program (program_id),
  KEY ix_kpy_yarn    (yarn_id),

  CONSTRAINT fk_kpy__program FOREIGN KEY (program_id)
    REFERENCES trx_knitting_program(id) ON DELETE CASCADE,
  CONSTRAINT fk_kpy__yarn FOREIGN KEY (yarn_id)
    REFERENCES mst_yarn(id) ON DELETE SET NULL
) ENGINE=InnoDB COMMENT='Multi-yarn combination lines per Knitting Program';


-- ─────────────────────────────────────────────────────────────────
-- 3. KNITTING PROGRAM — STRIPE / PATTERN SEQUENCE
--    Used when knitting_type IN ('STRIPE','FEEDER_STRIPE','ENGINEERED_STRIPE')
--    Course-based repeating pattern. Pattern repeats continuously.
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS trx_knitting_program_stripes (
  id                BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  program_id        BIGINT UNSIGNED NOT NULL,
  seq_no            INT NOT NULL DEFAULT 1   COMMENT 'Repeat sequence order',

  -- Reference to a yarn line in trx_knitting_program_yarns
  program_yarn_id   BIGINT UNSIGNED NULL,
  yarn_label        VARCHAR(80) NULL          COMMENT 'Display label, e.g. Yarn A / Navy 30s',
  colour            VARCHAR(80) NULL,

  -- Pattern definition
  courses           INT NOT NULL DEFAULT 0   COMMENT 'Number of courses for this stripe segment',
  notes             VARCHAR(255) NULL,

  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  KEY ix_kps_program (program_id),

  CONSTRAINT fk_kps__program FOREIGN KEY (program_id)
    REFERENCES trx_knitting_program(id) ON DELETE CASCADE,
  CONSTRAINT fk_kps__yarn FOREIGN KEY (program_yarn_id)
    REFERENCES trx_knitting_program_yarns(id) ON DELETE SET NULL
) ENGINE=InnoDB COMMENT='Stripe / pattern course sequence per Knitting Program';


-- ─────────────────────────────────────────────────────────────────
-- 4. KNITTING PROGRAM — YARN ISSUE
--    Issues yarn against a knitting program (per yarn line)
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS trx_knitting_program_yarn_issues (
  id                BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id        BIGINT UNSIGNED NOT NULL,
  program_id        BIGINT UNSIGNED NOT NULL,
  program_yarn_id   BIGINT UNSIGNED NULL       COMMENT 'Link to the yarn combination row',
  issue_no          VARCHAR(60) NOT NULL,
  issue_date        DATE NOT NULL,
  yarn_id           BIGINT UNSIGNED NULL,
  yarn_lot_no       VARCHAR(80) NULL,
  yarn_po_no        VARCHAR(80) NULL,
  issued_qty_kg     DECIMAL(14,3) NOT NULL DEFAULT 0,
  remarks           TEXT NULL,
  created_by        BIGINT UNSIGNED NULL,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  KEY ix_kpyi_prog  (program_id),
  KEY ix_kpyi_yarn  (yarn_id),

  CONSTRAINT fk_kpyi__company FOREIGN KEY (company_id) REFERENCES mst_company(id),
  CONSTRAINT fk_kpyi__prog    FOREIGN KEY (program_id)
    REFERENCES trx_knitting_program(id) ON DELETE CASCADE,
  CONSTRAINT fk_kpyi__prog_yarn FOREIGN KEY (program_yarn_id)
    REFERENCES trx_knitting_program_yarns(id) ON DELETE SET NULL,
  CONSTRAINT fk_kpyi__yarn    FOREIGN KEY (yarn_id)
    REFERENCES mst_yarn(id) ON DELETE SET NULL
) ENGINE=InnoDB COMMENT='Yarn issues against a Knitting Program';


-- ─────────────────────────────────────────────────────────────────
-- 5. ADD part_name TO trx_sales_order_line
--    (Audio 5: TOP one colour, BOTTOM another colour — carry forward)
-- ─────────────────────────────────────────────────────────────────
SET @col_exist = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME   = 'trx_sales_order_line'
    AND COLUMN_NAME  = 'part_name'
);
SET @sql = IF(
  @col_exist = 0,
  'ALTER TABLE trx_sales_order_line ADD COLUMN part_name VARCHAR(50) NULL DEFAULT NULL AFTER color_id',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;


-- ─────────────────────────────────────────────────────────────────
-- 6. ADD part_name TO trx_knitting_order (existing KWO table)
--    Carry forward from SO line
-- ─────────────────────────────────────────────────────────────────
SET @col_exist = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME   = 'trx_knitting_order'
    AND COLUMN_NAME  = 'part_name'
);
SET @sql = IF(
  @col_exist = 0,
  'ALTER TABLE trx_knitting_order ADD COLUMN part_name VARCHAR(50) NULL DEFAULT NULL AFTER yarn_lot_no',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;


-- ─────────────────────────────────────────────────────────────────
-- 7. Number series for Knitting Programs (KNP)
-- ─────────────────────────────────────────────────────────────────
INSERT IGNORE INTO cfg_number_series (doc_type, prefix, next_number, padding)
VALUES ('KNP', 'KNP', 1, 5);
