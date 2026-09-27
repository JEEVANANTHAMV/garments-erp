-- =====================================================================
-- 63. DIVISIONS (PRINTING / EMBROIDERY) FOR JOB WORK BILLING
-- ---------------------------------------------------------------------
-- Client review (transcript 32:55-34:35): printing and embroidery run as
-- DIVISIONS of the company. Outside companies send goods to be printed /
-- embroidered (Job Work In) and the division bills them. The bill header
-- shows "<Company> - Printing Division" / "<Company> - Embroidery Division".
-- Only printing and embroidery are divisions.
--
--  * mst_division: one row per division, with the billing name printed on
--    the invoice and optional GSTIN / address / phone / bank overrides
--    (blank = use the company's).
--  * trx_jobwork_in / trx_jobwork_invoice get division_id.
--  * Each division gets its own invoice number series (JW_INV_DIV_<id>).
-- Every statement is idempotent: the migrate runner re-applies files.
-- =====================================================================

CREATE TABLE IF NOT EXISTS mst_division (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  division_code   VARCHAR(20)  NOT NULL,
  division_name   VARCHAR(120) NOT NULL,
  billing_name    VARCHAR(200) NOT NULL COMMENT 'Name printed on the bill, e.g. CK Exports - Printing Division',
  process_type    ENUM('PRINTING','EMBROIDERY') NOT NULL COMMENT 'Job work process this division handles',
  invoice_prefix  VARCHAR(20)  NULL COMMENT 'Prefix of the division invoice number series',
  gstin           VARCHAR(15)  NULL COMMENT 'Override; blank = company GSTIN',
  address_line1   VARCHAR(200) NULL COMMENT 'Override; blank = company address',
  address_line2   VARCHAR(200) NULL,
  city            VARCHAR(80)  NULL,
  state           VARCHAR(80)  NULL,
  pincode         VARCHAR(12)  NULL,
  phone           VARCHAR(40)  NULL,
  email           VARCHAR(120) NULL,
  bank_name       VARCHAR(120) NULL,
  bank_account_no VARCHAR(40)  NULL,
  bank_ifsc       VARCHAR(20)  NULL,
  bank_branch     VARCHAR(120) NULL,
  remarks         VARCHAR(255) NULL,
  is_active       TINYINT(1) NOT NULL DEFAULT 1,
  is_deleted      TINYINT(1) NOT NULL DEFAULT 0,
  created_by      BIGINT UNSIGNED NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by      BIGINT UNSIGNED NULL,
  updated_at      DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_division_code (company_id, division_code),
  KEY ix_division_process (company_id, process_type),
  CONSTRAINT fk_division__company FOREIGN KEY (company_id) REFERENCES mst_company(id)
) ENGINE=InnoDB COMMENT='Company divisions that bill job work (Printing / Embroidery)';

-- Seed one Printing and one Embroidery division per company.
INSERT INTO mst_division (company_id, division_code, division_name, billing_name, process_type, invoice_prefix)
SELECT c.id, 'PRN', 'Printing Division',
       CONCAT(COALESCE(NULLIF(c.trade_name,''), c.legal_name), ' - Printing Division'),
       'PRINTING', 'PRN-'
  FROM mst_company c
 WHERE NOT EXISTS (SELECT 1 FROM mst_division d WHERE d.company_id = c.id AND d.division_code = 'PRN');

INSERT INTO mst_division (company_id, division_code, division_name, billing_name, process_type, invoice_prefix)
SELECT c.id, 'EMB', 'Embroidery Division',
       CONCAT(COALESCE(NULLIF(c.trade_name,''), c.legal_name), ' - Embroidery Division'),
       'EMBROIDERY', 'EMB-'
  FROM mst_company c
 WHERE NOT EXISTS (SELECT 1 FROM mst_division d WHERE d.company_id = c.id AND d.division_code = 'EMB');

-- trx_jobwork_in.division_id
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_in' AND COLUMN_NAME='division_id');
SET @s = IF(@x=0, 'ALTER TABLE trx_jobwork_in ADD COLUMN division_id BIGINT UNSIGNED NULL COMMENT \'Printing / Embroidery division doing the job\' AFTER customer_id', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_in' AND CONSTRAINT_NAME='fk_jwin__division');
SET @s = IF(@x=0, 'ALTER TABLE trx_jobwork_in ADD CONSTRAINT fk_jwin__division FOREIGN KEY (division_id) REFERENCES mst_division(id)', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- trx_jobwork_invoice.division_id
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_invoice' AND COLUMN_NAME='division_id');
SET @s = IF(@x=0, 'ALTER TABLE trx_jobwork_invoice ADD COLUMN division_id BIGINT UNSIGNED NULL COMMENT \'Billing division (header shows its billing name)\' AFTER party_id', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_invoice' AND CONSTRAINT_NAME='fk_jwi__division');
SET @s = IF(@x=0, 'ALTER TABLE trx_jobwork_invoice ADD CONSTRAINT fk_jwi__division FOREIGN KEY (division_id) REFERENCES mst_division(id)', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- Backfill: existing Job Work In rows take the division of their process.
UPDATE trx_jobwork_in j
  JOIN mst_division d ON d.company_id = j.company_id AND d.is_active = 1 AND d.is_deleted = 0
   AND d.process_type = CASE WHEN j.process_type LIKE '%print%' THEN 'PRINTING'
                             WHEN j.process_type LIKE '%embroid%' THEN 'EMBROIDERY' END
   SET j.division_id = d.id
 WHERE j.division_id IS NULL
   AND d.id = (SELECT MIN(d2.id) FROM mst_division d2
                WHERE d2.company_id = d.company_id AND d2.process_type = d.process_type
                  AND d2.is_active = 1 AND d2.is_deleted = 0);

-- Receivable invoices raised against a Job Work In take its division.
UPDATE trx_jobwork_invoice i
  JOIN trx_jobwork_in j ON j.id = i.jwin_id
   SET i.division_id = j.division_id
 WHERE i.division_id IS NULL AND j.division_id IS NOT NULL AND i.invoice_type = 'RECEIVABLE';

-- Invoice number series per division (JW_INV_DIV_<id>).
INSERT INTO cfg_number_series (company_id, branch_id, doc_type, fy_id, prefix, next_number, padding)
SELECT d.company_id, NULL, CONCAT('JW_INV_DIV_', d.id), NULL, COALESCE(NULLIF(d.invoice_prefix,''), CONCAT(d.division_code,'-')), 1, 5
  FROM mst_division d
 WHERE NOT EXISTS (SELECT 1 FROM cfg_number_series n
                    WHERE n.company_id = d.company_id AND n.doc_type = CONCAT('JW_INV_DIV_', d.id));
