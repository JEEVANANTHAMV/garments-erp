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
