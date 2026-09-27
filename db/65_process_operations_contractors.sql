-- =====================================================================
-- 65. PROCESS OPERATIONS, CONTRACTOR RATES, IN-HOUSE CONTRACTOR BILLS
-- ---------------------------------------------------------------------
-- Client review 24-Sep-2026:
--  * Stitching has many operations (power table, singer, overlock, neck
--    folding, rope attaching, stickering …) and each has its own rate for
--    a contractor. Operations are a master so any new one can be added.
--  * A DC names the operations it is sent for; its rate / PCS comes from
--    the contractor's operation rates (else the operation default rate).
--  * In-house contractors work inside the company on contract: they get
--    DCs / inwards like job workers and are paid by contractor bills.
--  * Process master flag "bill passing includes mistake qty" (legacy).
-- Every statement is idempotent: the migrate runner re-applies files.
-- =====================================================================

CREATE TABLE IF NOT EXISTS mst_process_operation (
  id            BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id    BIGINT UNSIGNED NOT NULL,
  stage_id      BIGINT UNSIGNED NOT NULL COMMENT 'Parent process (cfg_process_stage)',
  op_code       VARCHAR(30) NOT NULL,
  op_name       VARCHAR(80) NOT NULL,
  default_rate  DECIMAL(12,4) NOT NULL DEFAULT 0 COMMENT '₹ per PCS when the contractor has no rate',
  sort_order    INT NOT NULL DEFAULT 0,
  is_active     TINYINT(1) NOT NULL DEFAULT 1,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_proc_op (company_id, op_code),
  KEY ix_proc_op_stage (stage_id)
) ENGINE=InnoDB COMMENT='Operations inside a process (power table, singer, overlock …)';

CREATE TABLE IF NOT EXISTS mst_contractor_op_rate (
  id             BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id     BIGINT UNSIGNED NOT NULL,
  vendor_id      BIGINT UNSIGNED NOT NULL COMMENT 'Contractor / job worker (mst_party)',
  operation_id   BIGINT UNSIGNED NOT NULL,
  rate           DECIMAL(12,4) NOT NULL DEFAULT 0 COMMENT '₹ per PCS',
  effective_from DATE NULL,
  remarks        VARCHAR(255) NULL,
  is_active      TINYINT(1) NOT NULL DEFAULT 1,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_cor_vendor (company_id, vendor_id, operation_id)
) ENGINE=InnoDB COMMENT='Contractor rate per operation';

CREATE TABLE IF NOT EXISTS trx_jobwork_challan_op (
  id            BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  challan_id    BIGINT UNSIGNED NOT NULL,
  operation_id  BIGINT UNSIGNED NOT NULL,
  rate          DECIMAL(12,4) NOT NULL DEFAULT 0,
  UNIQUE KEY uq_jwc_op (challan_id, operation_id)
) ENGINE=InnoDB COMMENT='Operations a DC is sent for, with the agreed rate';

CREATE TABLE IF NOT EXISTS trx_contractor_bill (
  id                    BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id            BIGINT UNSIGNED NOT NULL,
  bill_no               VARCHAR(40) NOT NULL,
  bill_date             DATE NOT NULL,
  vendor_id             BIGINT UNSIGNED NOT NULL,
  period_from           DATE NULL,
  period_to             DATE NULL,
  billed_qty            INT NOT NULL DEFAULT 0,
  gross_amount          DECIMAL(18,2) NOT NULL DEFAULT 0,
  tds_pct               DECIMAL(6,3) NOT NULL DEFAULT 0,
  tds_amount            DECIMAL(18,2) NOT NULL DEFAULT 0,
  other_deduction_label VARCHAR(80) NULL,
  other_deduction       DECIMAL(18,2) NOT NULL DEFAULT 0,
  round_off             DECIMAL(10,2) NOT NULL DEFAULT 0,
  net_amount            DECIMAL(18,2) NOT NULL DEFAULT 0,
  status                ENUM('DRAFT','APPROVED','CANCELLED') NOT NULL DEFAULT 'DRAFT',
  remarks               VARCHAR(500) NULL,
  cancel_reason         VARCHAR(255) NULL,
  created_by            BIGINT UNSIGNED NULL,
  created_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  approved_by           BIGINT UNSIGNED NULL,
  approved_at           DATETIME NULL,
  UNIQUE KEY uq_contractor_bill (company_id, bill_no),
  KEY ix_cb_vendor (company_id, vendor_id)
) ENGINE=InnoDB COMMENT='Contractor bill for process inwards (in-house contractors / job workers)';

CREATE TABLE IF NOT EXISTS trx_contractor_bill_line (
  id           BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  bill_id      BIGINT UNSIGNED NOT NULL,
  receipt_id   BIGINT UNSIGNED NOT NULL,
  challan_id   BIGINT UNSIGNED NOT NULL,
  good_qty     INT NOT NULL DEFAULT 0,
  mistake_qty  INT NOT NULL DEFAULT 0,
  billed_qty   INT NOT NULL DEFAULT 0,
  rate         DECIMAL(12,4) NOT NULL DEFAULT 0,
  amount       DECIMAL(18,2) NOT NULL DEFAULT 0,
  KEY ix_cbl_receipt (receipt_id),
  KEY ix_cbl_bill (bill_id)
) ENGINE=InnoDB COMMENT='One process inward per bill line';

-- A cancelled bill frees its inwards, so receipt_id is not unique on bill lines.
SET @x = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_contractor_bill_line' AND INDEX_NAME='uq_cbl_receipt');
SET @s = IF(@x>0, 'ALTER TABLE trx_contractor_bill_line DROP INDEX uq_cbl_receipt, ADD KEY ix_cbl_receipt (receipt_id)', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- mst_party: in-house contractor role
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='mst_party' AND COLUMN_NAME='is_contractor');
SET @s = IF(@x=0, 'ALTER TABLE mst_party ADD COLUMN is_contractor TINYINT(1) NOT NULL DEFAULT 0 COMMENT \'In-house contractor (works inside the company on contract)\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- cfg_process_stage: legacy "Bill passing (include mistake qty)"
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='cfg_process_stage' AND COLUMN_NAME='bill_include_mistake');
SET @s = IF(@x=0, 'ALTER TABLE cfg_process_stage ADD COLUMN bill_include_mistake TINYINT(1) NOT NULL DEFAULT 0 COMMENT \'Contractor is paid for mistake (reject) PCS too\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- trx_jobwork_receipt: bill it was passed on
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_receipt' AND COLUMN_NAME='contractor_bill_id');
SET @s = IF(@x=0, 'ALTER TABLE trx_jobwork_receipt ADD COLUMN contractor_bill_id BIGINT UNSIGNED NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- Default stitching operations (rates 0 — set per contractor).
INSERT INTO mst_process_operation (company_id, stage_id, op_code, op_name, sort_order)
SELECT ps.company_id, ps.id, v.op_code, v.op_name, v.sort_order
  FROM cfg_process_stage ps
  JOIN (SELECT 'POWER_TABLE' op_code, 'Power Table' op_name, 10 sort_order
        UNION ALL SELECT 'SINGER', 'Singer', 20
        UNION ALL SELECT 'OVERLOCK', 'Overlock', 30
        UNION ALL SELECT 'FLATLOCK', 'Flatlock', 40
        UNION ALL SELECT 'NECK_FOLDING', 'Neck Folding', 50
        UNION ALL SELECT 'ROPE_ATTACH', 'Rope Attaching', 60
        UNION ALL SELECT 'STICKERING', 'Stickering', 70
        UNION ALL SELECT 'TRIMMING', 'Trimming', 80
        UNION ALL SELECT 'FINAL_SEWING', 'Final Sewing', 90) v
 WHERE ps.stage_code IN ('STITCH','STITCHING')
   AND NOT EXISTS (SELECT 1 FROM mst_process_operation o WHERE o.company_id = ps.company_id AND o.op_code = v.op_code);
