-- =====================================================================
--  GARMENT MANUFACTURING & EXPORT ERP  —  MASTER DATABASE SCHEMA
--  Target : MySQL 8.0+ / MariaDB 10.6+   (InnoDB, utf8mb4)
--  Scope  : Tiruppur export-house end-to-end lifecycle
--  Design : Multi-company / branch / unit / user-role / currency / country
--  Author : Generated for Jeeva (L&T AI CoE)
-- =====================================================================
--  CONVENTIONS
--    * Table names   : snake_case, singular domain noun (e.g. sales_order)
--    * Master tables : mst_<name>      Transaction : trx_<name>
--    * Junction/map  : map_<a>_<b>     Config/lookup: cfg_<name>
--    * PK            : id  BIGINT UNSIGNED AUTO_INCREMENT
--    * Audit cols    : created_by, created_at, updated_by, updated_at,
--                      is_active, is_deleted (soft delete)
--    * FK naming     : fk_<child>__<parent>
--    * Every business table carries company_id for multi-tenant isolation
-- =====================================================================

DROP DATABASE IF EXISTS garment_erp;
CREATE DATABASE garment_erp
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_0900_ai_ci;
USE garment_erp;

SET FOREIGN_KEY_CHECKS = 1;
SET sql_mode = 'STRICT_ALL_TABLES,NO_ENGINE_SUBSTITUTION';

-- =====================================================================
-- 0. GLOBAL LOOKUPS  (country / currency / uom / generic status)
-- =====================================================================

CREATE TABLE cfg_country (
  id            SMALLINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  iso2          CHAR(2)  NOT NULL UNIQUE,          -- IN, US, DE
  iso3          CHAR(3)  NOT NULL UNIQUE,          -- IND, USA
  name          VARCHAR(100) NOT NULL,
  dial_code     VARCHAR(8),
  is_active     TINYINT(1) NOT NULL DEFAULT 1
) ENGINE=InnoDB COMMENT='Master list of countries for buyers/exports';

CREATE TABLE cfg_currency (
  id            SMALLINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  code          CHAR(3) NOT NULL UNIQUE,           -- USD, EUR, INR
  name          VARCHAR(60) NOT NULL,
  symbol        VARCHAR(8),
  decimal_place TINYINT NOT NULL DEFAULT 2,
  is_active     TINYINT(1) NOT NULL DEFAULT 1
) ENGINE=InnoDB COMMENT='ISO currencies for multi-currency txns';

CREATE TABLE trx_exchange_rate (
  id            BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  from_currency SMALLINT UNSIGNED NOT NULL,
  to_currency   SMALLINT UNSIGNED NOT NULL,
  rate          DECIMAL(18,6) NOT NULL,
  rate_date     DATE NOT NULL,
  source        VARCHAR(40) DEFAULT 'RBI',
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_rate (from_currency,to_currency,rate_date),
  CONSTRAINT fk_rate__from FOREIGN KEY (from_currency) REFERENCES cfg_currency(id),
  CONSTRAINT fk_rate__to   FOREIGN KEY (to_currency)   REFERENCES cfg_currency(id)
) ENGINE=InnoDB COMMENT='Daily FX rates; supports realization/invoicing';

CREATE TABLE cfg_uom (
  id            SMALLINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  code          VARCHAR(12) NOT NULL UNIQUE,       -- PCS, KG, MTR, DZN, CONE
  name          VARCHAR(40) NOT NULL,
  uom_type      ENUM('QTY','WEIGHT','LENGTH','AREA','VOLUME','TIME') NOT NULL,
  is_active     TINYINT(1) NOT NULL DEFAULT 1
) ENGINE=InnoDB COMMENT='Units of measure';

CREATE TABLE cfg_uom_conversion (
  id            SMALLINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  from_uom      SMALLINT UNSIGNED NOT NULL,
  to_uom        SMALLINT UNSIGNED NOT NULL,
  factor        DECIMAL(18,6) NOT NULL,            -- from * factor = to
  UNIQUE KEY uq_conv (from_uom,to_uom),
  CONSTRAINT fk_conv__from FOREIGN KEY (from_uom) REFERENCES cfg_uom(id),
  CONSTRAINT fk_conv__to   FOREIGN KEY (to_uom)   REFERENCES cfg_uom(id)
) ENGINE=InnoDB COMMENT='UOM inter-conversion factors';

-- Generic, reusable status catalog (keeps status logic data-driven)
CREATE TABLE cfg_status (
  id            INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  domain        VARCHAR(40) NOT NULL,   -- e.g. SALES_ORDER, PROD_ORDER, SAMPLE
  code          VARCHAR(40) NOT NULL,   -- DRAFT, APPROVED, IN_PROGRESS...
  label         VARCHAR(80) NOT NULL,
  sort_order    INT DEFAULT 0,
  is_terminal   TINYINT(1) NOT NULL DEFAULT 0,
  is_active     TINYINT(1) NOT NULL DEFAULT 1,
  UNIQUE KEY uq_status (domain,code)
) ENGINE=InnoDB COMMENT='Data-driven status master shared across modules';

-- =====================================================================
-- 1. ORGANIZATION SETUP  (company / branch / unit / financial year)
-- =====================================================================

CREATE TABLE mst_company (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_code    VARCHAR(20) NOT NULL UNIQUE,
  legal_name      VARCHAR(200) NOT NULL,
  trade_name      VARCHAR(200),
  gstin           VARCHAR(15),
  pan             VARCHAR(10),
  iec_code        VARCHAR(20)  COMMENT 'Import Export Code (DGFT)',
  cin             VARCHAR(30),
  base_currency   SMALLINT UNSIGNED NOT NULL,
  country_id      SMALLINT UNSIGNED NOT NULL,
  address_line1   VARCHAR(200),
  address_line2   VARCHAR(200),
  city            VARCHAR(80),
  state           VARCHAR(80),
  state_gst_code  VARCHAR(2),
  pincode         VARCHAR(12),
  phone           VARCHAR(40),
  email           VARCHAR(120),
  website         VARCHAR(120),
  logo_path       VARCHAR(255),
  is_active       TINYINT(1) NOT NULL DEFAULT 1,
  is_deleted      TINYINT(1) NOT NULL DEFAULT 0,
  created_by      BIGINT UNSIGNED,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by      BIGINT UNSIGNED,
  updated_at      DATETIME ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_company__cur     FOREIGN KEY (base_currency) REFERENCES cfg_currency(id),
  CONSTRAINT fk_company__country FOREIGN KEY (country_id)    REFERENCES cfg_country(id)
) ENGINE=InnoDB COMMENT='Top-level legal entity (multi-company root)';

CREATE TABLE mst_branch (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  branch_code     VARCHAR(20) NOT NULL,
  branch_name     VARCHAR(150) NOT NULL,
  gstin           VARCHAR(15),
  address_line1   VARCHAR(200),
  city            VARCHAR(80),
  state           VARCHAR(80),
  pincode         VARCHAR(12),
  phone           VARCHAR(40),
  is_head_office  TINYINT(1) NOT NULL DEFAULT 0,
  is_active       TINYINT(1) NOT NULL DEFAULT 1,
  is_deleted      TINYINT(1) NOT NULL DEFAULT 0,
  created_by      BIGINT UNSIGNED,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by      BIGINT UNSIGNED,
  updated_at      DATETIME ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_branch (company_id,branch_code),
  CONSTRAINT fk_branch__company FOREIGN KEY (company_id) REFERENCES mst_company(id)
) ENGINE=InnoDB COMMENT='Branch / office under a company';

CREATE TABLE mst_unit (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  branch_id       BIGINT UNSIGNED,
  unit_code       VARCHAR(20) NOT NULL,
  unit_name       VARCHAR(150) NOT NULL,
  unit_type       ENUM('CUTTING','STITCHING','PRINTING','EMBROIDERY','WASHING',
                       'FINISHING','PACKING','INTEGRATED','WAREHOUSE') NOT NULL,
  capacity_per_day INT UNSIGNED,
  address_line1   VARCHAR(200),
  city            VARCHAR(80),
  is_active       TINYINT(1) NOT NULL DEFAULT 1,
  is_deleted      TINYINT(1) NOT NULL DEFAULT 0,
  created_by      BIGINT UNSIGNED,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by      BIGINT UNSIGNED,
  updated_at      DATETIME ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_unit (company_id,unit_code),
  CONSTRAINT fk_unit__company FOREIGN KEY (company_id) REFERENCES mst_company(id),
  CONSTRAINT fk_unit__branch  FOREIGN KEY (branch_id)  REFERENCES mst_branch(id)
) ENGINE=InnoDB COMMENT='Factory / production or warehouse unit';

CREATE TABLE mst_financial_year (
  id              INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  fy_code         VARCHAR(12) NOT NULL,   -- 2025-26
  start_date      DATE NOT NULL,
  end_date        DATE NOT NULL,
  is_current      TINYINT(1) NOT NULL DEFAULT 0,
  is_closed       TINYINT(1) NOT NULL DEFAULT 0,
  UNIQUE KEY uq_fy (company_id,fy_code),
  CONSTRAINT fk_fy__company FOREIGN KEY (company_id) REFERENCES mst_company(id)
) ENGINE=InnoDB COMMENT='Financial year definition per company';

-- Document numbering series (per company/branch/doc-type/FY)
CREATE TABLE cfg_number_series (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  branch_id       BIGINT UNSIGNED,
  doc_type        VARCHAR(40) NOT NULL,   -- SALES_ORDER, INVOICE, PO...
  fy_id           INT UNSIGNED,
  prefix          VARCHAR(20) DEFAULT '',
  suffix          VARCHAR(20) DEFAULT '',
  next_number     BIGINT UNSIGNED NOT NULL DEFAULT 1,
  padding         TINYINT NOT NULL DEFAULT 5,
  UNIQUE KEY uq_series (company_id,branch_id,doc_type,fy_id),
  CONSTRAINT fk_series__company FOREIGN KEY (company_id) REFERENCES mst_company(id)
) ENGINE=InnoDB COMMENT='Auto document-number generator config';

-- =====================================================================
-- 2. USER & ROLE MANAGEMENT  (RBAC)
-- =====================================================================

CREATE TABLE mst_user (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  username        VARCHAR(60) NOT NULL,
  password_hash   VARCHAR(255) NOT NULL,     -- bcrypt/argon2
  full_name       VARCHAR(150) NOT NULL,
  email           VARCHAR(120),
  mobile          VARCHAR(20),
  employee_code   VARCHAR(30),
  default_branch  BIGINT UNSIGNED,
  is_locked       TINYINT(1) NOT NULL DEFAULT 0,
  last_login_at   DATETIME,
  password_expiry DATE,
  is_active       TINYINT(1) NOT NULL DEFAULT 1,
  is_deleted      TINYINT(1) NOT NULL DEFAULT 0,
  created_by      BIGINT UNSIGNED,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by      BIGINT UNSIGNED,
  updated_at      DATETIME ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_user (company_id,username),
  CONSTRAINT fk_user__company FOREIGN KEY (company_id)     REFERENCES mst_company(id),
  CONSTRAINT fk_user__branch  FOREIGN KEY (default_branch) REFERENCES mst_branch(id)
) ENGINE=InnoDB COMMENT='Application users';

CREATE TABLE mst_role (
  id              INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  role_code       VARCHAR(40) NOT NULL,
  role_name       VARCHAR(100) NOT NULL,
  description     VARCHAR(255),
  is_system       TINYINT(1) NOT NULL DEFAULT 0,
  is_active       TINYINT(1) NOT NULL DEFAULT 1,
  UNIQUE KEY uq_role (company_id,role_code),
  CONSTRAINT fk_role__company FOREIGN KEY (company_id) REFERENCES mst_company(id)
) ENGINE=InnoDB COMMENT='Roles for RBAC';

CREATE TABLE mst_module (
  id              INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  module_code     VARCHAR(40) NOT NULL UNIQUE,   -- SALES, PRODUCTION, EXPORT...
  module_name     VARCHAR(100) NOT NULL,
  parent_id       INT UNSIGNED,
  sort_order      INT DEFAULT 0,
  CONSTRAINT fk_module__parent FOREIGN KEY (parent_id) REFERENCES mst_module(id)
) ENGINE=InnoDB COMMENT='Functional modules (menu tree)';

CREATE TABLE mst_permission (
  id              INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  module_id       INT UNSIGNED NOT NULL,
  permission_code VARCHAR(60) NOT NULL,   -- SALES_ORDER.CREATE, .APPROVE...
  permission_name VARCHAR(120) NOT NULL,
  UNIQUE KEY uq_perm (permission_code),
  CONSTRAINT fk_perm__module FOREIGN KEY (module_id) REFERENCES mst_module(id)
) ENGINE=InnoDB COMMENT='Granular permissions';

CREATE TABLE map_role_permission (
  role_id         INT UNSIGNED NOT NULL,
  permission_id   INT UNSIGNED NOT NULL,
  PRIMARY KEY (role_id,permission_id),
  CONSTRAINT fk_rp__role FOREIGN KEY (role_id)       REFERENCES mst_role(id),
  CONSTRAINT fk_rp__perm FOREIGN KEY (permission_id) REFERENCES mst_permission(id)
) ENGINE=InnoDB COMMENT='Role→Permission mapping';

CREATE TABLE map_user_role (
  user_id         BIGINT UNSIGNED NOT NULL,
  role_id         INT UNSIGNED NOT NULL,
  PRIMARY KEY (user_id,role_id),
  CONSTRAINT fk_ur__user FOREIGN KEY (user_id) REFERENCES mst_user(id),
  CONSTRAINT fk_ur__role FOREIGN KEY (role_id) REFERENCES mst_role(id)
) ENGINE=InnoDB COMMENT='User→Role mapping';

-- Row-level access: which branches/units a user may operate on
CREATE TABLE map_user_branch (
  user_id         BIGINT UNSIGNED NOT NULL,
  branch_id       BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (user_id,branch_id),
  CONSTRAINT fk_ub__user   FOREIGN KEY (user_id)   REFERENCES mst_user(id),
  CONSTRAINT fk_ub__branch FOREIGN KEY (branch_id) REFERENCES mst_branch(id)
) ENGINE=InnoDB COMMENT='User branch scope (row-level security)';

CREATE TABLE trx_user_session (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  user_id         BIGINT UNSIGNED NOT NULL,
  login_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  logout_at       DATETIME,
  ip_address      VARCHAR(45),
  user_agent      VARCHAR(255),
  CONSTRAINT fk_sess__user FOREIGN KEY (user_id) REFERENCES mst_user(id)
) ENGINE=InnoDB COMMENT='Login session log';

-- =====================================================================
-- 3. AUDIT / HISTORY / WORKFLOW / NOTIFICATION / DOCUMENT (cross-cutting)
-- =====================================================================

CREATE TABLE log_audit (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED,
  table_name      VARCHAR(80) NOT NULL,
  record_id       BIGINT UNSIGNED NOT NULL,
  action          ENUM('INSERT','UPDATE','DELETE') NOT NULL,
  old_values      JSON,
  new_values      JSON,
  changed_by      BIGINT UNSIGNED,
  changed_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ip_address      VARCHAR(45),
  KEY ix_audit_rec (table_name,record_id),
  KEY ix_audit_time (changed_at)
) ENGINE=InnoDB COMMENT='Universal audit trail (JSON diff)';

CREATE TABLE trx_status_history (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  domain          VARCHAR(40) NOT NULL,   -- matches cfg_status.domain
  record_id       BIGINT UNSIGNED NOT NULL,
  from_status_id  INT UNSIGNED,
  to_status_id    INT UNSIGNED NOT NULL,
  remarks         VARCHAR(500),
  changed_by      BIGINT UNSIGNED,
  changed_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_sh (domain,record_id),
  CONSTRAINT fk_sh__from FOREIGN KEY (from_status_id) REFERENCES cfg_status(id),
  CONSTRAINT fk_sh__to   FOREIGN KEY (to_status_id)   REFERENCES cfg_status(id)
) ENGINE=InnoDB COMMENT='Generic status transition history';

-- Configurable approval workflow engine
CREATE TABLE cfg_workflow (
  id              INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  doc_type        VARCHAR(40) NOT NULL,   -- SALES_ORDER, PO, SAMPLE, COSTING
  workflow_name   VARCHAR(120) NOT NULL,
  is_active       TINYINT(1) NOT NULL DEFAULT 1,
  UNIQUE KEY uq_wf (company_id,doc_type),
  CONSTRAINT fk_wf__company FOREIGN KEY (company_id) REFERENCES mst_company(id)
) ENGINE=InnoDB COMMENT='Approval workflow header';

CREATE TABLE cfg_workflow_step (
  id              INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  workflow_id     INT UNSIGNED NOT NULL,
  step_order      INT NOT NULL,
  step_name       VARCHAR(120) NOT NULL,
  approver_role   INT UNSIGNED,           -- role required to approve
  min_amount      DECIMAL(18,2),          -- amount-based routing
  max_amount      DECIMAL(18,2),
  is_final        TINYINT(1) NOT NULL DEFAULT 0,
  UNIQUE KEY uq_wf_step (workflow_id,step_order),
  CONSTRAINT fk_wfs__wf   FOREIGN KEY (workflow_id)   REFERENCES cfg_workflow(id),
  CONSTRAINT fk_wfs__role FOREIGN KEY (approver_role) REFERENCES mst_role(id)
) ENGINE=InnoDB COMMENT='Approval workflow steps';

CREATE TABLE trx_approval (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  workflow_id     INT UNSIGNED NOT NULL,
  step_id         INT UNSIGNED NOT NULL,
  doc_type        VARCHAR(40) NOT NULL,
  record_id       BIGINT UNSIGNED NOT NULL,
  status          ENUM('PENDING','APPROVED','REJECTED','ESCALATED') NOT NULL DEFAULT 'PENDING',
  action_by       BIGINT UNSIGNED,
  action_at       DATETIME,
  remarks         VARCHAR(500),
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_appr (doc_type,record_id),
  CONSTRAINT fk_appr__wf   FOREIGN KEY (workflow_id) REFERENCES cfg_workflow(id),
  CONSTRAINT fk_appr__step FOREIGN KEY (step_id)     REFERENCES cfg_workflow_step(id),
  CONSTRAINT fk_appr__user FOREIGN KEY (action_by)   REFERENCES mst_user(id)
) ENGINE=InnoDB COMMENT='Per-document approval instances';

CREATE TABLE trx_notification (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  user_id         BIGINT UNSIGNED NOT NULL,
  title           VARCHAR(200) NOT NULL,
  body            TEXT,
  ref_type        VARCHAR(40),
  ref_id          BIGINT UNSIGNED,
  channel         ENUM('INAPP','EMAIL','SMS','WHATSAPP') NOT NULL DEFAULT 'INAPP',
  is_read         TINYINT(1) NOT NULL DEFAULT 0,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_notif_user (user_id,is_read),
  CONSTRAINT fk_notif__user FOREIGN KEY (user_id) REFERENCES mst_user(id)
) ENGINE=InnoDB COMMENT='User notifications';

CREATE TABLE mst_document (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  ref_type        VARCHAR(40) NOT NULL,   -- SAMPLE, TECHPACK, INVOICE, LC...
  ref_id          BIGINT UNSIGNED NOT NULL,
  doc_category    VARCHAR(60),
  file_name       VARCHAR(255) NOT NULL,
  file_path       VARCHAR(500) NOT NULL,
  mime_type       VARCHAR(100),
  file_size       BIGINT UNSIGNED,
  version         INT NOT NULL DEFAULT 1,
  uploaded_by     BIGINT UNSIGNED,
  uploaded_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  is_active       TINYINT(1) NOT NULL DEFAULT 1,
  KEY ix_doc_ref (ref_type,ref_id),
  CONSTRAINT fk_doc__company FOREIGN KEY (company_id) REFERENCES mst_company(id)
) ENGINE=InnoDB COMMENT='Central document management repository';
