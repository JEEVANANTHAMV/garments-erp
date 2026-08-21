-- =====================================================================
-- 4. BUSINESS PARTNERS
--    Customer / Buyer / Supplier / Vendor / Agent
--    Unified party model + role flags, plus contacts, addresses, banks
-- =====================================================================

-- A single party can act in multiple roles (buyer, supplier, agent).
CREATE TABLE mst_party (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  party_code      VARCHAR(30) NOT NULL,
  party_name      VARCHAR(200) NOT NULL,
  is_customer     TINYINT(1) NOT NULL DEFAULT 0,
  is_buyer        TINYINT(1) NOT NULL DEFAULT 0,
  is_supplier     TINYINT(1) NOT NULL DEFAULT 0,
  is_vendor       TINYINT(1) NOT NULL DEFAULT 0,  -- job-work / CMT contractor
  is_agent        TINYINT(1) NOT NULL DEFAULT 0,
  party_type      ENUM('DOMESTIC','EXPORT','BOTH') NOT NULL DEFAULT 'EXPORT',
  country_id      SMALLINT UNSIGNED,
  currency_id     SMALLINT UNSIGNED,             -- default trading currency
  gstin           VARCHAR(15),
  pan             VARCHAR(10),
  tax_id_foreign  VARCHAR(40),                   -- VAT/EIN for overseas
  payment_terms   VARCHAR(120),                  -- e.g. LC 60 DAYS, TT ADVANCE
  credit_limit    DECIMAL(18,2) DEFAULT 0,
  credit_days     INT DEFAULT 0,
  email           VARCHAR(120),
  phone           VARCHAR(40),
  website         VARCHAR(120),
  is_active       TINYINT(1) NOT NULL DEFAULT 1,
  is_deleted      TINYINT(1) NOT NULL DEFAULT 0,
  created_by      BIGINT UNSIGNED,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by      BIGINT UNSIGNED,
  updated_at      DATETIME ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_party (company_id,party_code),
  KEY ix_party_roles (company_id,is_buyer,is_supplier),
  CONSTRAINT fk_party__company  FOREIGN KEY (company_id)  REFERENCES mst_company(id),
  CONSTRAINT fk_party__country  FOREIGN KEY (country_id)  REFERENCES cfg_country(id),
  CONSTRAINT fk_party__currency FOREIGN KEY (currency_id) REFERENCES cfg_currency(id)
) ENGINE=InnoDB COMMENT='Unified business-partner master (role flags)';

CREATE TABLE mst_party_address (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  party_id        BIGINT UNSIGNED NOT NULL,
  address_type    ENUM('REGISTERED','BILLING','SHIPPING','FACTORY','WAREHOUSE') NOT NULL,
  address_line1   VARCHAR(200) NOT NULL,
  address_line2   VARCHAR(200),
  city            VARCHAR(80),
  state           VARCHAR(80),
  country_id      SMALLINT UNSIGNED,
  pincode         VARCHAR(12),
  is_default      TINYINT(1) NOT NULL DEFAULT 0,
  is_active       TINYINT(1) NOT NULL DEFAULT 1,
  CONSTRAINT fk_paddr__party   FOREIGN KEY (party_id)   REFERENCES mst_party(id),
  CONSTRAINT fk_paddr__country FOREIGN KEY (country_id) REFERENCES cfg_country(id)
) ENGINE=InnoDB COMMENT='Multiple addresses per party';

CREATE TABLE mst_party_contact (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  party_id        BIGINT UNSIGNED NOT NULL,
  contact_name    VARCHAR(120) NOT NULL,
  designation     VARCHAR(80),
  email           VARCHAR(120),
  phone           VARCHAR(40),
  mobile          VARCHAR(20),
  is_primary      TINYINT(1) NOT NULL DEFAULT 0,
  is_active       TINYINT(1) NOT NULL DEFAULT 1,
  CONSTRAINT fk_pcont__party FOREIGN KEY (party_id) REFERENCES mst_party(id)
) ENGINE=InnoDB COMMENT='Contact persons per party';

CREATE TABLE mst_party_bank (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  party_id        BIGINT UNSIGNED NOT NULL,
  bank_name       VARCHAR(150) NOT NULL,
  branch_name     VARCHAR(150),
  account_no      VARCHAR(40),
  ifsc_code       VARCHAR(15),
  swift_code      VARCHAR(15),
  iban            VARCHAR(40),
  currency_id     SMALLINT UNSIGNED,
  is_default      TINYINT(1) NOT NULL DEFAULT 0,
  CONSTRAINT fk_pbank__party FOREIGN KEY (party_id) REFERENCES mst_party(id)
) ENGINE=InnoDB COMMENT='Party bank accounts (for TT/LC/remittance)';

-- Agent-specific commission configuration
CREATE TABLE mst_agent_commission (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  party_id        BIGINT UNSIGNED NOT NULL,   -- must be is_agent=1
  commission_pct  DECIMAL(6,3) NOT NULL DEFAULT 0,
  applies_to      ENUM('ORDER_VALUE','FOB','QTY') NOT NULL DEFAULT 'FOB',
  currency_id     SMALLINT UNSIGNED,
  effective_from  DATE,
  effective_to    DATE,
  is_active       TINYINT(1) NOT NULL DEFAULT 1,
  CONSTRAINT fk_agcomm__party FOREIGN KEY (party_id) REFERENCES mst_party(id)
) ENGINE=InnoDB COMMENT='Agent commission structure';

-- Buyer-specific compliance / requirements (audits, COC, labels)
CREATE TABLE mst_buyer_requirement (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  party_id        BIGINT UNSIGNED NOT NULL,   -- must be is_buyer=1
  requirement_type ENUM('COMPLIANCE_AUDIT','SOCIAL_AUDIT','LAB_TEST','PACKAGING',
                        'LABELLING','CARTON_MARK','CERTIFICATION') NOT NULL,
  requirement_name VARCHAR(150) NOT NULL,
  description     TEXT,
  is_mandatory    TINYINT(1) NOT NULL DEFAULT 1,
  is_active       TINYINT(1) NOT NULL DEFAULT 1,
  CONSTRAINT fk_breq__party FOREIGN KEY (party_id) REFERENCES mst_party(id)
) ENGINE=InnoDB COMMENT='Buyer compliance & packing requirements';
