-- =====================================================================
-- 69. UNUSED YARN RETURN FROM THE KNITTER
-- ---------------------------------------------------------------------
-- Yarn sent on a knitting DC that the knitter does not use comes back on
-- the knitter's own return DC. Each line goes back into the same yarn /
-- lot (batch) in yarn stock so it can be issued again, and the program's
-- reconciliation becomes: given - consumed - returned = balance at knitter.
--
-- trx_purchase_return / trx_fabric_return are supplier / cutting returns
-- with different keys, so the knitter return gets its own small pair.
-- Every statement is idempotent: the file is re-applied safely.
-- =====================================================================

CREATE TABLE IF NOT EXISTS trx_knitting_yarn_return (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  return_no       VARCHAR(40)  NOT NULL,
  return_date     DATE         NOT NULL,
  program_id      BIGINT UNSIGNED NOT NULL COMMENT 'trx_knitting_program',
  dc_no           VARCHAR(60)  NOT NULL COMMENT 'Our knitting DC the yarn went out on',
  party_dc_no     VARCHAR(60)  NULL COMMENT 'Knitter return DC no',
  vendor_id       BIGINT UNSIGNED NULL,
  vehicle_no      VARCHAR(30)  NULL,
  warehouse_id    BIGINT UNSIGNED NOT NULL COMMENT 'Receiving store',
  total_kg        DECIMAL(14,3) NOT NULL DEFAULT 0,
  total_cones     INT UNSIGNED NOT NULL DEFAULT 0,
  remarks         VARCHAR(500) NULL,
  created_by      BIGINT UNSIGNED NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_kyr_no (company_id, return_no),
  KEY ix_kyr_prog (company_id, program_id),
  KEY ix_kyr_dc (company_id, dc_no),
  CONSTRAINT fk_kyr__company FOREIGN KEY (company_id) REFERENCES mst_company (id),
  CONSTRAINT fk_kyr__program FOREIGN KEY (program_id) REFERENCES trx_knitting_program (id),
  CONSTRAINT fk_kyr__wh FOREIGN KEY (warehouse_id) REFERENCES mst_warehouse (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='Unused yarn returned by the knitter against a knitting DC';

CREATE TABLE IF NOT EXISTS trx_knitting_yarn_return_line (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  return_id       BIGINT UNSIGNED NOT NULL,
  issue_id        BIGINT UNSIGNED NULL COMMENT 'trx_process_issue line of the DC it returns against',
  program_yarn_id BIGINT UNSIGNED NULL COMMENT 'trx_knitting_program_yarns',
  yarn_id         BIGINT UNSIGNED NOT NULL,
  batch_id        BIGINT UNSIGNED NULL,
  lot_no          VARCHAR(80)  NULL,
  return_kg       DECIMAL(14,3) NOT NULL,
  no_of_cones     INT UNSIGNED NOT NULL DEFAULT 0,
  rate            DECIMAL(18,4) NOT NULL DEFAULT 0 COMMENT 'Rate of the original issue lot',
  PRIMARY KEY (id),
  KEY ix_kyrl_ret (return_id),
  KEY ix_kyrl_issue (issue_id),
  KEY ix_kyrl_yarn (yarn_id),
  CONSTRAINT fk_kyrl__ret FOREIGN KEY (return_id) REFERENCES trx_knitting_yarn_return (id) ON DELETE CASCADE,
  CONSTRAINT fk_kyrl__yarn FOREIGN KEY (yarn_id) REFERENCES mst_yarn (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Number series: knitting yarn return
INSERT INTO cfg_number_series (company_id, branch_id, doc_type, fy_id, prefix, next_number, padding)
SELECT c.id, NULL, 'KNIT_YARN_RETURN', NULL, 'KYR-', 1, 5
FROM mst_company c
WHERE NOT EXISTS (
  SELECT 1 FROM cfg_number_series s WHERE s.company_id = c.id AND s.doc_type = 'KNIT_YARN_RETURN'
);
