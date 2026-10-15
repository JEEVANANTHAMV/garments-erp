-- =====================================================================
-- 129 · Production costing – rate fixing per job, approve & lock
-- (client audio 15-Oct-2026: "where does production fix and lock the rate of
--  each process — stitching … — so it carries forward everywhere; then show
--  merchandiser costing vs production costing vs actual, with the variance")
--
--   * trx_job_rate_card      : one header per job (IO no) over its trx_job_op_rate
--                              rows: DRAFT → SUBMITTED → LOCKED, revision no
--   * trx_job_rate_card_rev  : history — every lock / revise / reject with reason
--                              and the rates at that moment (JSON)
--   * a default "Cutting" operation on cutting stages the client has not set up,
--     so cutting can be costed on the card like every other process
-- Idempotent: the runner re-applies files >= 10 on every deploy.
-- =====================================================================

CREATE TABLE IF NOT EXISTS trx_job_rate_card (
  id            BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id    BIGINT UNSIGNED NOT NULL,
  io_no         VARCHAR(40) NOT NULL,
  style_id      BIGINT UNSIGNED NULL,
  status        ENUM('DRAFT','SUBMITTED','LOCKED') NOT NULL DEFAULT 'DRAFT',
  revision_no   INT NOT NULL DEFAULT 0,
  costing_id    BIGINT UNSIGNED NULL COMMENT 'merchandiser pre-costing it was compared with at lock',
  submitted_by  BIGINT UNSIGNED NULL,
  submitted_at  DATETIME NULL,
  locked_by     BIGINT UNSIGNED NULL,
  locked_at     DATETIME NULL,
  remarks       VARCHAR(255),
  created_by    BIGINT UNSIGNED,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_job_rate_card (company_id, io_no),
  KEY ix_job_rate_card_status (company_id, status),
  CONSTRAINT fk_jrc__company FOREIGN KEY (company_id) REFERENCES mst_company(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS trx_job_rate_card_rev (
  id            BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  card_id       BIGINT UNSIGNED NOT NULL,
  company_id    BIGINT UNSIGNED NOT NULL,
  io_no         VARCHAR(40) NOT NULL,
  revision_no   INT NOT NULL,
  action        ENUM('SUBMIT','LOCK','REJECT','REVISE') NOT NULL,
  reason        VARCHAR(500),
  total_rate    DECIMAL(12,4) NOT NULL DEFAULT 0,
  rates_json    JSON NULL,
  created_by    BIGINT UNSIGNED,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_jrc_rev_card (card_id, id),
  CONSTRAINT fk_jrc_rev__card FOREIGN KEY (card_id) REFERENCES trx_job_rate_card(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- headers for jobs that already have a rate card (start as DRAFT — nothing locked silently)
INSERT INTO trx_job_rate_card (company_id, io_no, style_id, status, created_by)
SELECT j.company_id, j.io_no, MAX(j.style_id), 'DRAFT', MIN(j.created_by)
  FROM trx_job_op_rate j
 WHERE NOT EXISTS (SELECT 1 FROM trx_job_rate_card c WHERE c.company_id = j.company_id AND c.io_no = j.io_no)
 GROUP BY j.company_id, j.io_no;

-- default Cutting operation (same rule as 116: only stages the client has not set up themselves)
INSERT INTO mst_process_operation (company_id, stage_id, op_code, op_name, sort_order)
SELECT ps.company_id, ps.id, CONCAT(LEFT(UPPER(ps.stage_code), 14), '-CUTTING'), 'Cutting', 10
  FROM cfg_process_stage ps
 WHERE UPPER(ps.stage_code) IN ('CUT','CUTTING')
   AND NOT EXISTS (SELECT 1 FROM mst_process_operation o
                    WHERE o.company_id = ps.company_id AND o.op_code = CONCAT(LEFT(UPPER(ps.stage_code), 14), '-CUTTING'))
   AND NOT EXISTS (SELECT 1 FROM mst_process_operation o2
                    WHERE o2.stage_id = ps.id AND o2.op_code NOT LIKE CONCAT(LEFT(UPPER(ps.stage_code), 14), '-%'));

-- in-house unit DCs must also take the locked rate (setting; 1 = locked card rates cannot be typed over anywhere)
INSERT INTO cfg_system_setting (company_id, setting_key, setting_value, description)
SELECT c.id, 'PRODUCTION_RATE_LOCK_ENFORCED', '1',
       'Production rate card: once a job''s card is Approved & Locked, every DC (contractor and in-house), bill and costing uses only its rates'
  FROM mst_company c
 WHERE NOT EXISTS (SELECT 1 FROM cfg_system_setting s WHERE s.company_id = c.id AND s.setting_key = 'PRODUCTION_RATE_LOCK_ENFORCED');
