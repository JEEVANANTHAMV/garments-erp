-- 92: knitting DC — approved process quotation per job (client voice note 02-Oct-2026, follow-up).
-- One knitting DC carries several jobs (programs); each job can have its own knitting quotation / rate
-- (small variations job to job), so the quotation is kept per job of the DC, not once per DC.
-- Re-runnable.

CREATE TABLE IF NOT EXISTS trx_knitting_dc_job (
  id                 BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id         BIGINT UNSIGNED NOT NULL,
  dc_no              VARCHAR(60) NOT NULL,
  program_id         BIGINT UNSIGNED NOT NULL,
  so_id              BIGINT UNSIGNED NULL,
  io_no              VARCHAR(60) NULL,
  quotation_id       BIGINT UNSIGNED NULL,
  quotation_line_id  BIGINT UNSIGNED NULL,
  rate_per_kg        DECIMAL(12,2) NULL COMMENT 'Knitting charge per KG for this job from its approved quotation',
  created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_kdcj (company_id, dc_no, program_id),
  KEY ix_kdcj_prog (program_id)
) ENGINE=InnoDB COMMENT='Knitting DC — one row per job (program) on the DC with its quotation and rate';

-- existing DCs: every job gets the DC-level quotation / rate it went out on
INSERT IGNORE INTO trx_knitting_dc_job (company_id, dc_no, program_id, so_id, io_no, quotation_id, quotation_line_id, rate_per_kg)
SELECT i.company_id, i.dc_no, i.src_id, MAX(i.so_id), MAX(i.io_no), MAX(kd.quotation_id), MAX(kd.quotation_line_id), MAX(kd.rate_per_kg)
  FROM trx_process_issue i
  LEFT JOIN trx_knitting_dc kd ON kd.company_id = i.company_id AND kd.dc_no = i.dc_no
 WHERE i.src_type = 'KNITTING_PROGRAM' AND i.dc_no IS NOT NULL
 GROUP BY i.company_id, i.dc_no, i.src_id;

-- Receipt status per job: on a multi-job DC, a FINAL receipt / short close of one job must not close the other jobs.
-- The DC header status is derived: CLOSED only when every job on it is closed.
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_knitting_dc_job' AND COLUMN_NAME='status');
SET @s = IF(@x=0, 'ALTER TABLE trx_knitting_dc_job ADD COLUMN status VARCHAR(20) NOT NULL DEFAULT ''OPEN'' COMMENT ''OPEN / PARTIALLY_RECEIVED / CLOSED'', ADD COLUMN close_type VARCHAR(20) NULL, ADD COLUMN close_reason VARCHAR(255) NULL, ADD COLUMN closed_by BIGINT UNSIGNED NULL, ADD COLUMN closed_at DATETIME NULL, ADD COLUMN status_backfilled TINYINT NOT NULL DEFAULT 0', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- one-time backfill (rows not yet backfilled): a job is CLOSED when the DC was short closed, when it had a FINAL
-- receipt on the DC, or when it is the only job of a closed DC; part received when it has any receipt on the DC.
UPDATE trx_knitting_dc_job j
  JOIN trx_knitting_dc kd ON kd.company_id = j.company_id AND kd.dc_no = j.dc_no
  JOIN (SELECT company_id, dc_no, COUNT(*) n FROM trx_knitting_dc_job GROUP BY company_id, dc_no) cnt ON cnt.company_id = j.company_id AND cnt.dc_no = j.dc_no
   SET j.status = CASE
         WHEN kd.status = 'CLOSED' AND (kd.close_type = 'SHORT_CLOSE'
              OR EXISTS (SELECT 1 FROM trx_knitting_inward_dc m JOIN trx_process_receipt r ON r.id = m.receipt_id WHERE m.dc_no = j.dc_no AND m.program_id = j.program_id AND r.receipt_type = 'FINAL')
              OR cnt.n = 1) THEN 'CLOSED'
         WHEN EXISTS (SELECT 1 FROM trx_knitting_inward_dc m WHERE m.dc_no = j.dc_no AND m.program_id = j.program_id) THEN 'PARTIALLY_RECEIVED'
         ELSE 'OPEN' END,
       j.close_type = IF(kd.status = 'CLOSED', kd.close_type, NULL),
       j.closed_at = IF(kd.status = 'CLOSED', kd.closed_at, NULL),
       j.status_backfilled = 1
 WHERE j.status_backfilled = 0;
UPDATE trx_knitting_dc_job SET close_type = NULL, closed_at = NULL WHERE status <> 'CLOSED' AND close_type IS NOT NULL;

-- header follows its jobs (DCs wrongly closed by one job's final receipt open up again for the other jobs)
UPDATE trx_knitting_dc kd
  JOIN (SELECT company_id, dc_no, COUNT(*) n, SUM(status = 'CLOSED') c, SUM(status <> 'OPEN') moved FROM trx_knitting_dc_job GROUP BY company_id, dc_no) x
    ON x.company_id = kd.company_id AND x.dc_no = kd.dc_no
   SET kd.status = IF(x.c = x.n, 'CLOSED', IF(x.moved > 0, 'PARTIALLY_RECEIVED', 'OPEN')),
       kd.close_type = IF(x.c = x.n, kd.close_type, NULL),
       kd.closed_at = IF(x.c = x.n, kd.closed_at, NULL);
