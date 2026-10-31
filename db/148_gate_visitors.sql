-- =====================================================================
-- 148 · Visitor / contractor gate register (C-ONE UI v1.1 dashboard, 31-Oct-2026)
--   The dashboard's "Gate Entry (Today)" panel shows Inward, Outward, Visitors and Contractors. Inward and
--   outward come from trx_gate_inward / trx_gate_outward; people coming through the gate had no register.
--   trx_gate_visitor   one row per person / party through the gate: VISITOR (buyer QA, auditor, guest) or
--                      CONTRACTOR (job-work, maintenance, labour contractor), with in / out time.
-- Idempotent: the runner re-applies files >= 10 on every deploy.
-- =====================================================================
CREATE TABLE IF NOT EXISTS trx_gate_visitor (
  id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  company_id      BIGINT UNSIGNED NOT NULL,
  entry_no        VARCHAR(40) NULL,
  visit_date      DATE NOT NULL,
  in_time         VARCHAR(10) NULL,
  out_time        VARCHAR(10) NULL,
  visitor_type    ENUM('VISITOR','CONTRACTOR') NOT NULL DEFAULT 'VISITOR',
  person_name     VARCHAR(120) NOT NULL,
  organisation    VARCHAR(160) NULL,
  party_id        BIGINT UNSIGNED NULL,
  phone           VARCHAR(30) NULL,
  person_count    INT NOT NULL DEFAULT 1,
  purpose         VARCHAR(255) NULL,
  whom_to_meet    VARCHAR(120) NULL,
  vehicle_no      VARCHAR(30) NULL,
  id_proof        VARCHAR(80) NULL,
  status          ENUM('IN','OUT','CANCELLED') NOT NULL DEFAULT 'IN',
  security_guard  VARCHAR(80) NULL,
  remarks         VARCHAR(500) NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
  KEY ix_gv_company_date (company_id, visit_date),
  KEY ix_gv_type (company_id, visitor_type, visit_date)
) ENGINE=InnoDB;

INSERT INTO cfg_number_series (company_id, branch_id, doc_type, fy_id, prefix, next_number, padding)
SELECT c.id, NULL, 'GATE_VISITOR', NULL, 'GV-', 1, 5 FROM mst_company c
WHERE NOT EXISTS (SELECT 1 FROM cfg_number_series s WHERE s.company_id = c.id AND s.doc_type = 'GATE_VISITOR' AND s.branch_id IS NULL AND s.fy_id IS NULL);
