-- =====================================================================
-- 131 · Department master (client audio 16-Oct-2026: "keep the department in the master — we create
-- it ourselves and it comes in the Bill Tracker dropdown")
--   mst_department: per company; Bill Tracker "from department" and "hand over department" pick from it.
--   Seeded only with the department names already typed on bill-tracker entries, so old bills match.
-- Idempotent: the runner re-applies files >= 10 on every deploy.
-- =====================================================================
CREATE TABLE IF NOT EXISTS mst_department (
  id          BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id  BIGINT UNSIGNED NOT NULL,
  dept_code   VARCHAR(30) NULL,
  dept_name   VARCHAR(80) NOT NULL,
  remarks     VARCHAR(255) NULL,
  is_active   TINYINT(1) NOT NULL DEFAULT 1,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_department (company_id, dept_name),
  CONSTRAINT fk_dept__company FOREIGN KEY (company_id) REFERENCES mst_company(id)
) ENGINE=InnoDB COMMENT='Departments (Bill Tracker hand-over / from department)';

INSERT IGNORE INTO mst_department (company_id, dept_name)
SELECT DISTINCT company_id, TRIM(received_from_dept) FROM trx_bill_tracker WHERE TRIM(COALESCE(received_from_dept, '')) <> ''
UNION
SELECT DISTINCT company_id, TRIM(handover_department) FROM trx_bill_tracker WHERE TRIM(COALESCE(handover_department, '')) <> '';
