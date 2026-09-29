-- =====================================================================
-- 78 · Contractor piece rates per job, bill-rate check, advances, % deduction,
--      debit notes (client voice note 29-Sep-2026, "contract option").
--   * trx_job_op_rate      : for each job (IO no) only the operations it needs,
--                            picked from the Process & Operations master, with
--                            that job's piece rate (power table, singer, flatlock …)
--   * contractor bill line : contractor's billed rate vs our rate; excess is
--                            ALLOWed, kept as ADVANCE (recoverable) or must be REVISEd
--   * contractor bill      : % deduction, advance adjusted, debit notes adjusted
--   * trx_contractor_advance / trx_contractor_debit_note
-- Idempotent: the runner re-applies files >= 10 on every deploy.
-- =====================================================================

CREATE TABLE IF NOT EXISTS trx_job_op_rate (
  id            BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id    BIGINT UNSIGNED NOT NULL,
  io_no         VARCHAR(40) NOT NULL,
  style_id      BIGINT UNSIGNED NULL,
  stage_id      INT UNSIGNED NOT NULL,
  operation_id  BIGINT UNSIGNED NOT NULL,
  rate          DECIMAL(12,4) NOT NULL DEFAULT 0 COMMENT '₹ per PCS for this job',
  remarks       VARCHAR(255),
  created_by    BIGINT UNSIGNED,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_job_op_rate (company_id, io_no, operation_id),
  KEY ix_job_op_rate_stage (company_id, io_no, stage_id),
  CONSTRAINT fk_jor__company FOREIGN KEY (company_id) REFERENCES mst_company(id),
  CONSTRAINT fk_jor__op      FOREIGN KEY (operation_id) REFERENCES mst_process_operation(id)
) ENGINE=InnoDB COMMENT='Job-wise contractor piece rate per operation (only the operations the job needs)';

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_contractor_bill_line' AND COLUMN_NAME='bill_rate');
SET @s = IF(@x=0, 'ALTER TABLE trx_contractor_bill_line ADD COLUMN our_rate DECIMAL(12,4) NULL AFTER rate, ADD COLUMN bill_rate DECIMAL(12,4) NULL COMMENT ''Rate on the contractor invoice'' AFTER our_rate, ADD COLUMN variance_action ENUM(''NONE'',''ALLOW'',''ADVANCE'',''REVISE'') NOT NULL DEFAULT ''NONE'' AFTER bill_rate, ADD COLUMN excess_amount DECIMAL(14,2) NOT NULL DEFAULT 0 AFTER variance_action', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_contractor_bill' AND COLUMN_NAME='deduction_pct');
SET @s = IF(@x=0, 'ALTER TABLE trx_contractor_bill ADD COLUMN deduction_pct DECIMAL(6,2) NOT NULL DEFAULT 0 AFTER other_deduction, ADD COLUMN deduction_label VARCHAR(80) NULL AFTER deduction_pct, ADD COLUMN deduction_amount DECIMAL(14,2) NOT NULL DEFAULT 0 AFTER deduction_label, ADD COLUMN advance_adjusted DECIMAL(14,2) NOT NULL DEFAULT 0 AFTER deduction_amount, ADD COLUMN debit_note_amount DECIMAL(14,2) NOT NULL DEFAULT 0 AFTER advance_adjusted, ADD COLUMN excess_amount DECIMAL(14,2) NOT NULL DEFAULT 0 AFTER debit_note_amount, ADD COLUMN excess_as_advance DECIMAL(14,2) NOT NULL DEFAULT 0 AFTER excess_amount', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

CREATE TABLE IF NOT EXISTS trx_contractor_advance (
  id            BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id    BIGINT UNSIGNED NOT NULL,
  advance_no    VARCHAR(40) NOT NULL,
  advance_date  DATE NOT NULL,
  vendor_id     BIGINT UNSIGNED NOT NULL,
  amount        DECIMAL(14,2) NOT NULL,
  source        ENUM('PAYMENT','BILL_EXCESS') NOT NULL DEFAULT 'PAYMENT',
  bill_id       BIGINT UNSIGNED NULL COMMENT 'Bill whose excess rate was kept as advance',
  pay_mode      VARCHAR(30),
  ref_no        VARCHAR(60),
  remarks       VARCHAR(255),
  status        ENUM('ACTIVE','CANCELLED') NOT NULL DEFAULT 'ACTIVE',
  cancel_reason VARCHAR(255),
  created_by    BIGINT UNSIGNED,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_ctr_adv (company_id, advance_no),
  KEY ix_ctr_adv_vendor (company_id, vendor_id),
  CONSTRAINT fk_ctradv__company FOREIGN KEY (company_id) REFERENCES mst_company(id),
  CONSTRAINT fk_ctradv__vendor  FOREIGN KEY (vendor_id) REFERENCES mst_party(id)
) ENGINE=InnoDB COMMENT='Advance to a contractor, recovered from contractor bills';

CREATE TABLE IF NOT EXISTS trx_contractor_debit_note (
  id            BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id    BIGINT UNSIGNED NOT NULL,
  dn_no         VARCHAR(40) NOT NULL,
  dn_date       DATE NOT NULL,
  vendor_id     BIGINT UNSIGNED NOT NULL,
  receipt_id    BIGINT UNSIGNED NULL COMMENT 'Process inward the defect was found on',
  io_no         VARCHAR(40),
  reason        VARCHAR(255) NOT NULL,
  qty           INT UNSIGNED NOT NULL DEFAULT 0,
  rate          DECIMAL(12,4) NOT NULL DEFAULT 0,
  amount        DECIMAL(14,2) NOT NULL,
  status        ENUM('OPEN','ADJUSTED','CANCELLED') NOT NULL DEFAULT 'OPEN',
  bill_id       BIGINT UNSIGNED NULL COMMENT 'Contractor bill it was deducted on',
  cancel_reason VARCHAR(255),
  created_by    BIGINT UNSIGNED,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_ctr_dn (company_id, dn_no),
  KEY ix_ctr_dn_vendor (company_id, vendor_id, status),
  CONSTRAINT fk_ctrdn__company FOREIGN KEY (company_id) REFERENCES mst_company(id),
  CONSTRAINT fk_ctrdn__vendor  FOREIGN KEY (vendor_id) REFERENCES mst_party(id)
) ENGINE=InnoDB COMMENT='Debit note on a contractor for defective work (deducted on a bill)';

INSERT INTO cfg_number_series (company_id, branch_id, doc_type, fy_id, prefix, next_number, padding)
SELECT c.id, NULL, d.doc_type, NULL, d.prefix, 1, 5
  FROM mst_company c
  CROSS JOIN (SELECT 'CONTRACTOR_ADVANCE' AS doc_type, 'CADV-' AS prefix UNION ALL SELECT 'CONTRACTOR_DN', 'CDN-') d
 WHERE NOT EXISTS (SELECT 1 FROM cfg_number_series s WHERE s.company_id = c.id AND s.doc_type = d.doc_type);
