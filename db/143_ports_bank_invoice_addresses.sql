-- =====================================================================
-- 143 · Commercial invoice round 2 (client voice notes 24-Oct-2026)
--   1. Port master (client: "ports we use — pick from a dropdown, add more later"): CHENNAI, BANGALORE, MUMBAI,
--      TUTICORIN, COCHIN, COIMBATORE, TIRUPPUR, HYDERABAD; one row per port + mode (SEA / AIR / ROAD) with its
--      ICEGATE code where known. The invoice / shipping bill pick the port and the mode.
--   2. Our bank accounts (client: "bank details come from the master, not typed"): the invoice's OUR BANK DETAILS
--      block is printed from the account picked (default account first). Export benefit receipts post to these too.
--   3. Invoice: transport mode, bank account, REX no, consignee / buyer (other than consignee) / delivery address —
--      only the filled ones are printed; size-wise quantities per line (one line "all sizes" or a line per size).
--   4. IEC / REX: one-time on the company master + settings, never typed per invoice.
-- Idempotent: the runner re-applies files >= 10 on every deploy.
-- =====================================================================

CREATE TABLE IF NOT EXISTS mst_port (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  company_id  BIGINT UNSIGNED NOT NULL,
  port_name   VARCHAR(80) NOT NULL,
  mode        VARCHAR(4) NULL COMMENT 'SEA / AIR / ROAD (blank = any mode)',
  port_code   VARCHAR(10) NULL COMMENT 'ICEGATE / UN-LOCODE port code, e.g. INMAA1',
  country_id  SMALLINT UNSIGNED NULL COMMENT 'Blank = India (port of loading)',
  remarks     VARCHAR(255) NULL,
  is_active   TINYINT(1) NOT NULL DEFAULT 1,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_port (company_id, port_name, mode),
  KEY ix_port_active (company_id, is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Ports of loading (port + mode → ICEGATE code)';

-- the client's list (WhatsApp 24-Oct-2026); codes only where the ICEGATE code is certain — the rest are filled in the master
INSERT IGNORE INTO mst_port (company_id, port_name, mode, port_code)
SELECT c.id, p.port_name, p.mode, p.port_code FROM mst_company c
CROSS JOIN (
  SELECT 'CHENNAI' port_name, 'SEA' mode, 'INMAA1' port_code UNION ALL SELECT 'CHENNAI', 'AIR', 'INMAA4' UNION ALL SELECT 'CHENNAI', 'ROAD', NULL
  UNION ALL SELECT 'BANGALORE', 'AIR', 'INBLR4' UNION ALL SELECT 'BANGALORE', 'ROAD', NULL
  UNION ALL SELECT 'MUMBAI', 'SEA', 'INNSA1' UNION ALL SELECT 'MUMBAI', 'AIR', 'INBOM4'
  UNION ALL SELECT 'TUTICORIN', 'SEA', 'INTUT1' UNION ALL SELECT 'TUTICORIN', 'ROAD', NULL
  UNION ALL SELECT 'COCHIN', 'SEA', 'INCOK1' UNION ALL SELECT 'COCHIN', 'AIR', 'INCOK4'
  UNION ALL SELECT 'COIMBATORE', 'AIR', 'INCJB4' UNION ALL SELECT 'COIMBATORE', 'ROAD', NULL
  UNION ALL SELECT 'TIRUPPUR', 'SEA', 'INTUP6' UNION ALL SELECT 'TIRUPPUR', 'ROAD', NULL
  UNION ALL SELECT 'HYDERABAD', 'AIR', 'INHYD4'
) p
WHERE NOT EXISTS (SELECT 1 FROM cfg_system_setting g WHERE g.company_id = c.id AND g.setting_key = 'PORTS_SEEDED');
INSERT IGNORE INTO cfg_system_setting (company_id, setting_key, setting_value, description)
SELECT id, 'PORTS_SEEDED', '1', 'Port master seeded with the client port list (migration 143, one time)' FROM mst_company;

CREATE TABLE IF NOT EXISTS mst_company_bank_account (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  company_id     BIGINT UNSIGNED NOT NULL,
  account_label  VARCHAR(80) NOT NULL COMMENT 'Short name for dropdowns, e.g. CANARA CA 2133',
  bank_name      VARCHAR(150) NOT NULL,
  branch_name    VARCHAR(150) NULL,
  branch_address VARCHAR(300) NULL COMMENT 'Printed under the bank name (one line per line break)',
  account_type   VARCHAR(10) NOT NULL DEFAULT 'CURRENT' COMMENT 'CURRENT / EEFC / CC / OD / SAVINGS',
  account_no     VARCHAR(40) NOT NULL,
  ifsc_code      VARCHAR(15) NULL,
  swift_code     VARCHAR(15) NULL,
  ad_code        VARCHAR(20) NULL COMMENT 'Authorised dealer code (shipping bill)',
  beneficiary    VARCHAR(150) NULL,
  intermediary   VARCHAR(300) NULL COMMENT 'Intermediary / correspondent bank (optional)',
  currency_id    SMALLINT UNSIGNED NULL,
  is_default     TINYINT(1) NOT NULL DEFAULT 0,
  is_active      TINYINT(1) NOT NULL DEFAULT 1,
  remarks        VARCHAR(255) NULL,
  created_by     BIGINT UNSIGNED NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by     BIGINT UNSIGNED NULL,
  updated_at     DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_cba_acno (company_id, account_no),
  KEY ix_cba_company (company_id, is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Our bank accounts (invoice bank details, benefit receipts)';

DROP PROCEDURE IF EXISTS _ci2_add_col;
CREATE PROCEDURE _ci2_add_col(IN t VARCHAR(64), IN c VARCHAR(64), IN ddl VARCHAR(500))
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = t AND COLUMN_NAME = c) THEN
    SET @q = CONCAT('ALTER TABLE ', t, ' ADD COLUMN ', c, ' ', ddl);
    PREPARE s1 FROM @q; EXECUTE s1; DEALLOCATE PREPARE s1;
  END IF;
END;
CALL _ci2_add_col('trx_commercial_invoice', 'transport_mode',   'VARCHAR(4) NULL COMMENT ''SEA / AIR / ROAD''');
CALL _ci2_add_col('trx_commercial_invoice', 'port_loading_id',  'BIGINT UNSIGNED NULL COMMENT ''mst_port of the port of loading''');
CALL _ci2_add_col('trx_commercial_invoice', 'bank_account_id',  'BIGINT UNSIGNED NULL COMMENT ''mst_company_bank_account printed as OUR BANK DETAILS''');
CALL _ci2_add_col('trx_commercial_invoice', 'delivery_details', 'TEXT NULL COMMENT ''Delivery address other than the consignee / buyer (printed only when filled)''');
CALL _ci2_add_col('trx_commercial_invoice_line', 'size_qty', 'JSON NULL COMMENT ''{"S":120,"M":240} — size-wise quantity of the line (all-sizes line or a single size)''');
CALL _ci2_add_col('mst_company', 'rex_no', 'VARCHAR(40) NULL COMMENT ''Registered Exporter (REX) number — printed in the REX declaration''');
CALL _ci2_add_col('trx_shipping_bill', 'port_id', 'BIGINT UNSIGNED NULL');
DROP PROCEDURE IF EXISTS _ci2_add_col;

SET @x = (SELECT CHARACTER_MAXIMUM_LENGTH FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_shipping_bill' AND COLUMN_NAME='mode');
SET @s = IF(@x IS NOT NULL AND @x < 4, 'ALTER TABLE trx_shipping_bill MODIFY mode VARCHAR(4) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- IEC on the company master once, taken from the invoices already made ("IEC NO : 3291005848")
UPDATE mst_company c
   JOIN (SELECT company_id, MAX(TRIM(REGEXP_SUBSTR(exporter_ref, '[0-9A-Z]{10}$'))) iec FROM trx_commercial_invoice
          WHERE exporter_ref REGEXP 'IEC[^0-9A-Z]*[0-9A-Z]{10}$' GROUP BY company_id) x ON x.company_id = c.id
   SET c.iec_code = x.iec
 WHERE COALESCE(c.iec_code, '') = '' AND x.iec IS NOT NULL;

-- REX declaration: the FK-087 wording, with the exporter and REX no filled in when printed
INSERT IGNORE INTO cfg_system_setting (company_id, setting_key, setting_value, description)
SELECT id, 'CI_REX_TEMPLATE',
  'THE EXPORTER {EXPORTER_NAME}, {EXPORTER_ADDRESS} REX NO: {REX_NO} OF THE PRODUCTS COVERED BY THIS DOCUMENT DECLARES THAT, EXCEPT WHERE OTHERWISE CLEARLY INDICATED, THESE PRODUCTS ARE OF INDIAN PREFERENTIAL ORIGIN ACCORDING TO RULES OF ORIGIN OF THE GENERALIZED SYSTEM OF PREFERENCES OF THE EUROPEAN UNION AND THAT THE ORIGIN CRITERION MET IS “P”',
  'Commercial invoice (buyer copy): REX declaration — {EXPORTER_NAME} {EXPORTER_ADDRESS} {REX_NO} are filled in' FROM mst_company;

-- the client's export company (FK-087 BUYER INVOICE: bank, REX no) on the company that makes the FASHION KNITS invoices
UPDATE mst_company c SET c.rex_no = 'INREX3291005848TC025'
 WHERE COALESCE(c.rex_no, '') = '' AND c.iec_code = '3291005848';
INSERT INTO mst_company_bank_account (company_id, account_label, bank_name, branch_name, branch_address, account_type, account_no, ifsc_code, swift_code, beneficiary, is_default)
SELECT c.id, 'CANARA CA 2133', 'CANARA BANK', 'MID CORPORATE BRANCH(2344)', '70 / 74, J G NAGAR, 2nd STREET,\n60 FEET ROAD, Tiruppur, Tamil Nadu 641602 INDIA',
       'CURRENT', '1510201012133', 'CNRB0002344', 'CNRBINBBBFD', 'FASHION KNITS', 1
  FROM mst_company c
 WHERE c.iec_code = '3291005848'
   AND NOT EXISTS (SELECT 1 FROM mst_company_bank_account b WHERE b.company_id = c.id);

-- permissions: the bank / port masters use the EXPORT and FINANCE rights already held (no new codes)
