-- =====================================================================
-- 73 · Line allocation / daily plan hardening + Sewing Daily Output Entry
-- Client call 28-Sep-2026 + Sewing/Checking Line Allocation developer doc.
--   * sewing & checking tables get the same columns (one generic API)
--   * plan detail ← allocation detail link, achieved / completed counters
--   * per-line plan settings (supervisor, operators, target)
--   * Daily Output Entry – Sewing (bundle-wise, posts to the bundle ledger)
-- Every statement is idempotent: the runner re-applies files >= 10 on deploy.
-- =====================================================================

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='cfg_sewing_line' AND COLUMN_NAME='floor_name');
SET @s = IF(@x=0, 'ALTER TABLE cfg_sewing_line ADD COLUMN floor_name VARCHAR(40) NULL AFTER unit_id', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='cfg_sewing_line' AND COLUMN_NAME='supervisor_name');
SET @s = IF(@x=0, 'ALTER TABLE cfg_sewing_line ADD COLUMN supervisor_name VARCHAR(80) NULL AFTER floor_name', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='cfg_sewing_line' AND COLUMN_NAME='efficiency_pct');
SET @s = IF(@x=0, 'ALTER TABLE cfg_sewing_line ADD COLUMN efficiency_pct DECIMAL(5,2) NOT NULL DEFAULT 100 AFTER sam_per_pcs', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='cfg_checking_line' AND COLUMN_NAME='floor_name');
SET @s = IF(@x=0, 'ALTER TABLE cfg_checking_line ADD COLUMN floor_name VARCHAR(40) NULL AFTER unit_id', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='cfg_checking_line' AND COLUMN_NAME='supervisor_name');
SET @s = IF(@x=0, 'ALTER TABLE cfg_checking_line ADD COLUMN supervisor_name VARCHAR(80) NULL AFTER floor_name', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='cfg_checking_line' AND COLUMN_NAME='efficiency_pct');
SET @s = IF(@x=0, 'ALTER TABLE cfg_checking_line ADD COLUMN efficiency_pct DECIMAL(5,2) NOT NULL DEFAULT 100 AFTER sam_per_pcs', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_sewing_line_allocation' AND COLUMN_NAME='total_qty');
SET @s = IF(@x=0, 'ALTER TABLE trx_sewing_line_allocation ADD COLUMN total_qty INT UNSIGNED DEFAULT 0 AFTER total_bundles', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_sewing_line_allocation' AND COLUMN_NAME='cancel_reason');
SET @s = IF(@x=0, 'ALTER TABLE trx_sewing_line_allocation ADD COLUMN cancel_reason VARCHAR(255) NULL AFTER remarks', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_sewing_line_allocation' AND COLUMN_NAME='capacity_override');
SET @s = IF(@x=0, 'ALTER TABLE trx_sewing_line_allocation ADD COLUMN capacity_override TINYINT(1) NOT NULL DEFAULT 0 AFTER cancel_reason', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_checking_line_allocation' AND COLUMN_NAME='total_jobs');
SET @s = IF(@x=0, 'ALTER TABLE trx_checking_line_allocation ADD COLUMN total_jobs INT UNSIGNED DEFAULT 0 AFTER plan_type', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_checking_line_allocation' AND COLUMN_NAME='pending_qty');
SET @s = IF(@x=0, 'ALTER TABLE trx_checking_line_allocation ADD COLUMN pending_qty INT UNSIGNED DEFAULT 0 AFTER total_qty', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_checking_line_allocation' AND COLUMN_NAME='cancel_reason');
SET @s = IF(@x=0, 'ALTER TABLE trx_checking_line_allocation ADD COLUMN cancel_reason VARCHAR(255) NULL AFTER remarks', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_checking_line_allocation' AND COLUMN_NAME='capacity_override');
SET @s = IF(@x=0, 'ALTER TABLE trx_checking_line_allocation ADD COLUMN capacity_override TINYINT(1) NOT NULL DEFAULT 0 AFTER cancel_reason', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_sewing_line_allocation_detail' AND COLUMN_NAME='io_no');
SET @s = IF(@x=0, 'ALTER TABLE trx_sewing_line_allocation_detail ADD COLUMN io_no VARCHAR(40) NULL AFTER bundle_id', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_sewing_line_allocation_detail' AND COLUMN_NAME='completed_qty');
SET @s = IF(@x=0, 'ALTER TABLE trx_sewing_line_allocation_detail ADD COLUMN completed_qty INT UNSIGNED NOT NULL DEFAULT 0 AFTER planned_qty', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_checking_line_allocation_detail' AND COLUMN_NAME='io_no');
SET @s = IF(@x=0, 'ALTER TABLE trx_checking_line_allocation_detail ADD COLUMN io_no VARCHAR(40) NULL AFTER bundle_id', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_checking_line_allocation_detail' AND COLUMN_NAME='sam');
SET @s = IF(@x=0, 'ALTER TABLE trx_checking_line_allocation_detail ADD COLUMN sam DECIMAL(8,4) DEFAULT 0 AFTER allocated_qty', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_checking_line_allocation_detail' AND COLUMN_NAME='completed_qty');
SET @s = IF(@x=0, 'ALTER TABLE trx_checking_line_allocation_detail ADD COLUMN completed_qty INT UNSIGNED NOT NULL DEFAULT 0 AFTER planned_qty', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_sewing_daily_plan' AND COLUMN_NAME='cancel_reason');
SET @s = IF(@x=0, 'ALTER TABLE trx_sewing_daily_plan ADD COLUMN cancel_reason VARCHAR(255) NULL AFTER remarks', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_checking_daily_plan' AND COLUMN_NAME='cancel_reason');
SET @s = IF(@x=0, 'ALTER TABLE trx_checking_daily_plan ADD COLUMN cancel_reason VARCHAR(255) NULL AFTER remarks', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_sewing_daily_plan_detail' AND COLUMN_NAME='allocation_detail_id');
SET @s = IF(@x=0, 'ALTER TABLE trx_sewing_daily_plan_detail ADD COLUMN allocation_detail_id BIGINT UNSIGNED NULL AFTER plan_id', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_sewing_daily_plan_detail' AND COLUMN_NAME='io_no');
SET @s = IF(@x=0, 'ALTER TABLE trx_sewing_daily_plan_detail ADD COLUMN io_no VARCHAR(40) NULL AFTER bundle_id', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_sewing_daily_plan_detail' AND COLUMN_NAME='achieved_qty');
SET @s = IF(@x=0, 'ALTER TABLE trx_sewing_daily_plan_detail ADD COLUMN achieved_qty INT UNSIGNED NOT NULL DEFAULT 0 AFTER planned_qty', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_checking_daily_plan_detail' AND COLUMN_NAME='allocation_detail_id');
SET @s = IF(@x=0, 'ALTER TABLE trx_checking_daily_plan_detail ADD COLUMN allocation_detail_id BIGINT UNSIGNED NULL AFTER plan_id', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_checking_daily_plan_detail' AND COLUMN_NAME='io_no');
SET @s = IF(@x=0, 'ALTER TABLE trx_checking_daily_plan_detail ADD COLUMN io_no VARCHAR(40) NULL AFTER bundle_id', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_checking_daily_plan_detail' AND COLUMN_NAME='sam');
SET @s = IF(@x=0, 'ALTER TABLE trx_checking_daily_plan_detail ADD COLUMN sam DECIMAL(8,4) DEFAULT 0 AFTER planned_qty', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_checking_daily_plan_detail' AND COLUMN_NAME='achieved_qty');
SET @s = IF(@x=0, 'ALTER TABLE trx_checking_daily_plan_detail ADD COLUMN achieved_qty INT UNSIGNED NOT NULL DEFAULT 0 AFTER planned_qty', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @x = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_sewing_daily_plan_detail' AND INDEX_NAME='ix_sewpland_allocd');
SET @s = IF(@x=0, 'ALTER TABLE trx_sewing_daily_plan_detail ADD KEY ix_sewpland_allocd (allocation_detail_id)', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @x = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_checking_daily_plan_detail' AND INDEX_NAME='ix_chkpland_allocd');
SET @s = IF(@x=0, 'ALTER TABLE trx_checking_daily_plan_detail ADD KEY ix_chkpland_allocd (allocation_detail_id)', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @x = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_sewing_line_allocation_detail' AND INDEX_NAME='ix_sewallocd_bundle');
SET @s = IF(@x=0, 'ALTER TABLE trx_sewing_line_allocation_detail ADD KEY ix_sewallocd_bundle (bundle_id)', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @x = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_checking_line_allocation_detail' AND INDEX_NAME='ix_chkallocd_bundle');
SET @s = IF(@x=0, 'ALTER TABLE trx_checking_line_allocation_detail ADD KEY ix_chkallocd_bundle (bundle_id)', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- Per-line settings of a sewing daily plan (Line Plan grid: supervisor, operators, target)
CREATE TABLE IF NOT EXISTS trx_sewing_daily_plan_line (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  plan_id         BIGINT UNSIGNED NOT NULL,
  line_id         INT UNSIGNED NOT NULL,
  supervisor_name VARCHAR(80),
  operators       INT UNSIGNED DEFAULT 0,
  target_qty      INT UNSIGNED DEFAULT 0,
  remarks         VARCHAR(255),
  UNIQUE KEY uq_sewing_plan_line (plan_id, line_id),
  CONSTRAINT fk_sewing_planline__plan FOREIGN KEY (plan_id) REFERENCES trx_sewing_daily_plan(id),
  CONSTRAINT fk_sewing_planline__line FOREIGN KEY (line_id) REFERENCES cfg_sewing_line(id)
) ENGINE=InnoDB COMMENT='Sewing daily plan — per-line target / supervisor / operators';

-- Per-line settings of a checking daily plan (Line Plan grid: supervisor, operators, target)
CREATE TABLE IF NOT EXISTS trx_checking_daily_plan_line (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  plan_id         BIGINT UNSIGNED NOT NULL,
  line_id         INT UNSIGNED NOT NULL,
  supervisor_name VARCHAR(80),
  operators       INT UNSIGNED DEFAULT 0,
  target_qty      INT UNSIGNED DEFAULT 0,
  remarks         VARCHAR(255),
  UNIQUE KEY uq_checking_plan_line (plan_id, line_id),
  CONSTRAINT fk_checking_planline__plan FOREIGN KEY (plan_id) REFERENCES trx_checking_daily_plan(id),
  CONSTRAINT fk_checking_planline__line FOREIGN KEY (line_id) REFERENCES cfg_checking_line(id)
) ENGINE=InnoDB COMMENT='Checking daily plan — per-line target / supervisor / operators';

-- Daily Output Entry – Sewing (header per date / shift / line)
CREATE TABLE IF NOT EXISTS trx_sewing_daily_output (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  output_no       VARCHAR(40) NOT NULL,
  output_date     DATE NOT NULL,
  shift_id        INT UNSIGNED,
  floor_name      VARCHAR(40),
  line_id         INT UNSIGNED NOT NULL,
  plan_id         BIGINT UNSIGNED,
  supervisor_name VARCHAR(80),
  target_qty      INT UNSIGNED DEFAULT 0,
  input_qty       INT UNSIGNED DEFAULT 0,
  good_qty        INT UNSIGNED DEFAULT 0,
  rework_qty      INT UNSIGNED DEFAULT 0,
  reject_qty      INT UNSIGNED DEFAULT 0,
  status          ENUM('DRAFT','CONFIRMED','CANCELLED') NOT NULL DEFAULT 'DRAFT',
  remarks         VARCHAR(500),
  cancel_reason   VARCHAR(255),
  created_by      BIGINT UNSIGNED,
  confirmed_by    BIGINT UNSIGNED,
  confirmed_at    DATETIME,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_sew_dout (company_id, output_no),
  KEY ix_sew_dout_date (company_id, output_date),
  CONSTRAINT fk_sewdout__company FOREIGN KEY (company_id) REFERENCES mst_company(id),
  CONSTRAINT fk_sewdout__line    FOREIGN KEY (line_id)    REFERENCES cfg_sewing_line(id),
  CONSTRAINT fk_sewdout__shift   FOREIGN KEY (shift_id)   REFERENCES cfg_shift(id),
  CONSTRAINT fk_sewdout__plan    FOREIGN KEY (plan_id)    REFERENCES trx_sewing_daily_plan(id)
) ENGINE=InnoDB COMMENT='Daily Output Entry – Sewing (header)';

CREATE TABLE IF NOT EXISTS trx_sewing_daily_output_line (
  id               BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  output_id        BIGINT UNSIGNED NOT NULL,
  bundle_id        BIGINT UNSIGNED NOT NULL,
  plan_detail_id   BIGINT UNSIGNED,
  io_no            VARCHAR(40),
  style_id         BIGINT UNSIGNED,
  color_id         BIGINT UNSIGNED,
  size_id          INT UNSIGNED,
  input_qty        INT UNSIGNED NOT NULL DEFAULT 0,
  good_qty         INT UNSIGNED NOT NULL DEFAULT 0,
  rework_qty       INT UNSIGNED NOT NULL DEFAULT 0,
  reject_qty       INT UNSIGNED NOT NULL DEFAULT 0,
  defect_id        INT UNSIGNED,
  operator_name    VARCHAR(80),
  start_time       TIME,
  end_time         TIME,
  remarks          VARCHAR(255),
  UNIQUE KEY uq_sew_dout_bundle (output_id, bundle_id),
  KEY ix_sew_doutl_plan (plan_detail_id),
  CONSTRAINT fk_sewdoutl__out    FOREIGN KEY (output_id) REFERENCES trx_sewing_daily_output(id),
  CONSTRAINT fk_sewdoutl__bundle FOREIGN KEY (bundle_id) REFERENCES trx_cutting_bundle(id),
  CONSTRAINT fk_sewdoutl__defect FOREIGN KEY (defect_id) REFERENCES mst_defect(id)
) ENGINE=InnoDB COMMENT='Daily Output Entry – Sewing (bundle rows)';

-- Number series for the output entry
INSERT INTO cfg_number_series (company_id, branch_id, doc_type, fy_id, prefix, next_number, padding)
SELECT c.id, NULL, 'SEW_DAILY_OUT', NULL, 'SDO-', 1, 5
  FROM mst_company c
 WHERE NOT EXISTS (SELECT 1 FROM cfg_number_series s WHERE s.company_id = c.id AND s.doc_type = 'SEW_DAILY_OUT');
