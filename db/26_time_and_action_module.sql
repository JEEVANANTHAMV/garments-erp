-- =====================================================================
-- 26. TIME & ACTION (T&A) MODULE
-- Developer Technical Specification - Garment Manufacturing ERP
-- =====================================================================

-- 1. Working Calendar & Holidays
CREATE TABLE IF NOT EXISTS cfg_working_calendar (
  id                  INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id          BIGINT UNSIGNED NOT NULL,
  day_of_week         TINYINT UNSIGNED NOT NULL COMMENT '0=Sunday, 1=Monday ... 6=Saturday',
  day_name            VARCHAR(20) NOT NULL,
  is_working_day      TINYINT(1) NOT NULL DEFAULT 1,
  standard_hours      DECIMAL(4,2) DEFAULT 8.00,
  UNIQUE KEY uq_cal_day (company_id, day_of_week),
  CONSTRAINT fk_cal__company FOREIGN KEY (company_id) REFERENCES mst_company(id)
) ENGINE=InnoDB COMMENT='Weekly working days configuration';

CREATE TABLE IF NOT EXISTS cfg_holiday (
  id                  INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id          BIGINT UNSIGNED NOT NULL,
  holiday_date        DATE NOT NULL,
  holiday_name        VARCHAR(100) NOT NULL,
  is_optional         TINYINT(1) DEFAULT 0,
  UNIQUE KEY uq_hol_date (company_id, holiday_date),
  CONSTRAINT fk_hol__company FOREIGN KEY (company_id) REFERENCES mst_company(id)
) ENGINE=InnoDB COMMENT='Factory holiday calendar';

-- 2. Master Activity Library
CREATE TABLE IF NOT EXISTS mst_tna_activity (
  id                  BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id          BIGINT UNSIGNED NOT NULL,
  activity_code       VARCHAR(50) NOT NULL,
  activity_name       VARCHAR(150) NOT NULL,
  category            VARCHAR(50) NOT NULL COMMENT 'ORDER, SAMPLING, FABRIC, TRIM, PRODUCTION, QUALITY, SHIPMENT, OTHER',
  default_duration    INT UNSIGNED DEFAULT 1,
  lead_time_type      VARCHAR(20) DEFAULT 'BACKWARD',
  department_name     VARCHAR(60) NULL,
  default_owner_role  VARCHAR(60) NULL,
  dependency_type     VARCHAR(30) DEFAULT 'FINISH_TO_START',
  mandatory           TINYINT(1) DEFAULT 1,
  weight              DECIMAL(5,2) DEFAULT 1.00,
  alert_before_days   INT UNSIGNED DEFAULT 2,
  active              TINYINT(1) DEFAULT 1,
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_tna_act (company_id, activity_code),
  CONSTRAINT fk_mstat__company FOREIGN KEY (company_id) REFERENCES mst_company(id)
) ENGINE=InnoDB COMMENT='Reusable Master Activity Library';

-- 3. T&A Template Master Header & Activities
CREATE TABLE IF NOT EXISTS mst_tna_template_header (
  id                  BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id          BIGINT UNSIGNED NOT NULL,
  template_code       VARCHAR(50) NOT NULL,
  template_name       VARCHAR(150) NOT NULL,
  product_type        VARCHAR(80) NULL,
  description         VARCHAR(500) NULL,
  active              TINYINT(1) DEFAULT 1,
  created_by          BIGINT UNSIGNED NULL,
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_tna_tpl (company_id, template_code),
  CONSTRAINT fk_tpl__company FOREIGN KEY (company_id) REFERENCES mst_company(id)
) ENGINE=InnoDB COMMENT='T&A Templates Header';

CREATE TABLE IF NOT EXISTS mst_tna_template_activity (
  id                  BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  template_id         BIGINT UNSIGNED NOT NULL,
  activity_code       VARCHAR(50) NOT NULL,
  activity_name       VARCHAR(150) NOT NULL,
  category            VARCHAR(50) NOT NULL,
  sequence_no         INT UNSIGNED NOT NULL,
  default_duration    INT UNSIGNED DEFAULT 1,
  duration_uom        VARCHAR(20) DEFAULT 'DAYS',
  department_name     VARCHAR(60) NULL,
  default_owner_role  VARCHAR(60) NULL,
  dependency_sequence INT UNSIGNED NULL,
  dependency_type     VARCHAR(30) DEFAULT 'FINISH_TO_START',
  mandatory           TINYINT(1) DEFAULT 1,
  weight              DECIMAL(5,2) DEFAULT 1.00,
  alert_before_days   INT UNSIGNED DEFAULT 2,
  active              TINYINT(1) DEFAULT 1,
  CONSTRAINT fk_tplact__tpl FOREIGN KEY (template_id) REFERENCES mst_tna_template_header(id) ON DELETE CASCADE
) ENGINE=InnoDB COMMENT='T&A Template Activity Sequence';

-- 4. Transaction T&A Header
CREATE TABLE IF NOT EXISTS trx_tna_header (
  id                  BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id          BIGINT UNSIGNED NOT NULL,
  tna_no              VARCHAR(50) NOT NULL,
  tna_date            DATE NOT NULL,
  buyer_id            BIGINT UNSIGNED NOT NULL,
  style_id            BIGINT UNSIGNED NOT NULL,
  io_id               BIGINT UNSIGNED NULL,
  sales_order_id      BIGINT UNSIGNED NOT NULL,
  order_qty           INT UNSIGNED DEFAULT 0,
  order_date          DATE NULL,
  shipment_date       DATE NOT NULL,
  template_id         BIGINT UNSIGNED NULL,
  merchandiser_id     BIGINT UNSIGNED NULL,
  status              VARCHAR(30) DEFAULT 'DRAFT' COMMENT 'DRAFT, GENERATED, REVIEW, SUBMITTED, APPROVED, ACTIVE, CLOSED, CANCELLED',
  completion_percentage DECIMAL(5,2) DEFAULT 0.00,
  shipment_risk       VARCHAR(30) DEFAULT 'ON_TRACK' COMMENT 'ON_TRACK, AT_RISK, CRITICAL',
  version             INT UNSIGNED DEFAULT 1,
  remarks             VARCHAR(500) NULL,
  created_by          BIGINT UNSIGNED NULL,
  approved_by         BIGINT UNSIGNED NULL,
  approved_at         DATETIME NULL,
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_tna_no (company_id, tna_no),
  CONSTRAINT fk_tna__company FOREIGN KEY (company_id) REFERENCES mst_company(id),
  CONSTRAINT fk_tna__buyer   FOREIGN KEY (buyer_id)   REFERENCES mst_party(id),
  CONSTRAINT fk_tna__style   FOREIGN KEY (style_id)   REFERENCES mst_style(id),
  CONSTRAINT fk_tna__so      FOREIGN KEY (sales_order_id) REFERENCES trx_sales_order(id),
  CONSTRAINT fk_tna__tpl     FOREIGN KEY (template_id)    REFERENCES mst_tna_template_header(id)
) ENGINE=InnoDB COMMENT='Time and Action Order Header';

-- 5. Transaction T&A Activities
CREATE TABLE IF NOT EXISTS trx_tna_activity (
  id                  BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  tna_id              BIGINT UNSIGNED NOT NULL,
  activity_code       VARCHAR(50) NOT NULL,
  activity_name       VARCHAR(150) NOT NULL,
  category            VARCHAR(50) NOT NULL COMMENT 'ORDER, SAMPLING, FABRIC, TRIM, PRODUCTION, QUALITY, SHIPMENT, OTHER',
  sequence_no         INT UNSIGNED NOT NULL,
  planned_start_date  DATE NULL,
  planned_end_date    DATE NULL,
  actual_start_date   DATE NULL,
  actual_end_date     DATE NULL,
  department_name     VARCHAR(60) NULL,
  responsible_user_id BIGINT UNSIGNED NULL,
  dependency_activity_id BIGINT UNSIGNED NULL,
  dependency_sequence INT UNSIGNED NULL,
  dependency_type     VARCHAR(30) DEFAULT 'FINISH_TO_START',
  priority            VARCHAR(20) DEFAULT 'MEDIUM' COMMENT 'LOW, MEDIUM, HIGH, CRITICAL',
  weight              DECIMAL(5,2) DEFAULT 1.00,
  mandatory           TINYINT(1) DEFAULT 1,
  approval_required   TINYINT(1) DEFAULT 0,
  status              VARCHAR(30) DEFAULT 'NOT_STARTED' COMMENT 'NOT_STARTED, IN_PROGRESS, COMPLETED, ON_HOLD, CANCELLED',
  health_status       VARCHAR(30) DEFAULT 'ON_TRACK' COMMENT 'ON_TRACK, AT_RISK, DELAYED, CRITICAL',
  delay_days          INT DEFAULT 0,
  remarks             VARCHAR(500) NULL,
  source_event        VARCHAR(60) NULL,
  completed_by        BIGINT UNSIGNED NULL,
  completed_at        DATETIME NULL,
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_tnaact__tna FOREIGN KEY (tna_id) REFERENCES trx_tna_header(id) ON DELETE CASCADE
) ENGINE=InnoDB COMMENT='T&A Scheduled Activities';

-- 6. T&A Activity History / Audit Trail
CREATE TABLE IF NOT EXISTS trx_tna_activity_history (
  id                  BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  activity_id         BIGINT UNSIGNED NOT NULL,
  old_status          VARCHAR(50) NULL,
  new_status          VARCHAR(50) NULL,
  old_planned_start   DATE NULL,
  new_planned_start   DATE NULL,
  old_planned_end     DATE NULL,
  new_planned_end     DATE NULL,
  actual_start        DATE NULL,
  actual_end          DATE NULL,
  changed_by          BIGINT UNSIGNED NULL,
  changed_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reason              VARCHAR(255) NULL,
  remarks             VARCHAR(500) NULL,
  source_event        VARCHAR(60) NULL,
  CONSTRAINT fk_tna_hist__act FOREIGN KEY (activity_id) REFERENCES trx_tna_activity(id) ON DELETE CASCADE
) ENGINE=InnoDB COMMENT='T&A Activity Change Audit History';

-- =====================================================================
-- SEED DEFAULT WORKING CALENDAR & TEMPLATES FOR COMPANY 1
-- =====================================================================

-- Default working days (Monday-Saturday working, Sunday off)
INSERT IGNORE INTO cfg_working_calendar (company_id, day_of_week, day_name, is_working_day, standard_hours)
VALUES
  (1, 0, 'Sunday', 0, 0.00),
  (1, 1, 'Monday', 1, 8.00),
  (1, 2, 'Tuesday', 1, 8.00),
  (1, 3, 'Wednesday', 1, 8.00),
  (1, 4, 'Thursday', 1, 8.00),
  (1, 5, 'Friday', 1, 8.00),
  (1, 6, 'Saturday', 1, 8.00);

-- Master Activities Seed
INSERT IGNORE INTO mst_tna_activity
  (company_id, activity_code, activity_name, category, default_duration, lead_time_type, department_name, default_owner_role, mandatory, weight, alert_before_days)
VALUES
  (1, 'ACT_PO_REC', 'PO Received & Confirmation', 'ORDER', 2, 'FORWARD', 'Merchandising', 'Merchandiser', 1, 1.0, 2),
  (1, 'ACT_TECH_PACK', 'Tech Pack & Spec Received', 'ORDER', 3, 'FORWARD', 'Merchandising', 'Merchandiser', 1, 1.0, 2),
  (1, 'ACT_BOM_COST', 'BOM & Pre-Costing Approval', 'ORDER', 3, 'FORWARD', 'Merchandising', 'Costing Executive', 1, 1.5, 2),
  (1, 'ACT_PROTO_SMP', 'Proto Sample Submission & Approval', 'SAMPLING', 5, 'FORWARD', 'Sampling', 'Sample Coordinator', 1, 2.0, 3),
  (1, 'ACT_FIT_SMP', 'Fit Sample Submission & Approval', 'SAMPLING', 6, 'FORWARD', 'Sampling', 'Sample Coordinator', 1, 2.0, 3),
  (1, 'ACT_PP_SMP', 'Pre-Production (PP) Sample Approval', 'SAMPLING', 5, 'FORWARD', 'Sampling', 'QA Manager', 1, 2.5, 3),
  (1, 'ACT_YARN_BOOK', 'Yarn Requirement & PO Booking', 'FABRIC', 4, 'FORWARD', 'Purchase', 'Purchase Manager', 1, 2.0, 2),
  (1, 'ACT_KNIT_FAB', 'Knitting & Greige Fabric Production', 'FABRIC', 7, 'FORWARD', 'Knitting', 'Knitting In-charge', 1, 2.5, 2),
  (1, 'ACT_DYE_FIN', 'Fabric Dyeing, Compacting & Finishing', 'FABRIC', 8, 'FORWARD', 'Dyeing', 'Processing Manager', 1, 3.0, 3),
  (1, 'ACT_FAB_INHOUSE', 'Fabric In-House & Quality Inspection', 'FABRIC', 3, 'BACKWARD', 'Stores', 'Store In-charge', 1, 3.5, 2),
  (1, 'ACT_TRIM_BOOK', 'Trims Requirement & PO Booking', 'TRIM', 5, 'FORWARD', 'Purchase', 'Purchase Executive', 1, 1.5, 2),
  (1, 'ACT_TRIM_INHOUSE', 'Trims In-House & Inspection', 'TRIM', 3, 'BACKWARD', 'Stores', 'Store In-charge', 1, 2.0, 2),
  (1, 'ACT_SIZE_SET', 'Size Set / Pilot Run Approval', 'PRODUCTION', 2, 'BACKWARD', 'QA', 'QA Executive', 1, 2.0, 2),
  (1, 'ACT_CUTTING', 'Spreading, Marker & Cutting', 'PRODUCTION', 5, 'BACKWARD', 'Cutting', 'Cutting Manager', 1, 3.0, 2),
  (1, 'ACT_PRINT_EMB', 'Printing / Embroidery Embellishment', 'PRODUCTION', 4, 'BACKWARD', 'Printing', 'Printing In-charge', 0, 2.0, 2),
  (1, 'ACT_SEWING', 'Sewing & Assembly Production', 'PRODUCTION', 12, 'BACKWARD', 'Sewing', 'Sewing Floor Manager', 1, 5.0, 3),
  (1, 'ACT_WASHING', 'Garment Washing & Drying', 'PRODUCTION', 3, 'BACKWARD', 'Washing', 'Washing In-charge', 0, 1.5, 2),
  (1, 'ACT_FINISHING', 'Thread Trimming, Ironing & Checking', 'PRODUCTION', 5, 'BACKWARD', 'Finishing', 'Finishing Manager', 1, 2.5, 2),
  (1, 'ACT_PACKING', 'Packing, Tagging & Carton Box Packing', 'PRODUCTION', 4, 'BACKWARD', 'Packing', 'Packing Supervisor', 1, 2.5, 2),
  (1, 'ACT_FINAL_QC', 'Final Buyer/AQL Quality Inspection', 'QUALITY', 2, 'BACKWARD', 'QA', 'QA Manager', 1, 4.0, 2),
  (1, 'ACT_DOC_BOOK', 'Shipping Booking & Export Documents', 'SHIPMENT', 3, 'BACKWARD', 'Commercial', 'Shipping Executive', 1, 2.0, 2),
  (1, 'ACT_SHIPMENT', 'Container Stuffing & Final Shipment', 'SHIPMENT', 1, 'BACKWARD', 'Commercial', 'Logistics Manager', 1, 5.0, 1);

-- Template 1: Basic T-Shirt
INSERT IGNORE INTO mst_tna_template_header (id, company_id, template_code, template_name, product_type, description, active)
VALUES (1, 1, 'TPL_BASIC_TSHIRT', 'Basic Knit T-Shirt Standard', 'T-Shirt', 'Standard knit crew neck / round neck T-Shirt Time & Action template with 55-day order-to-ship cycle', 1);

-- Template 1 Activities
INSERT IGNORE INTO mst_tna_template_activity
  (template_id, activity_code, activity_name, category, sequence_no, default_duration, duration_uom, department_name, default_owner_role, dependency_sequence, mandatory, weight, alert_before_days)
VALUES
  (1, 'ACT_PO_REC', 'PO Received & Confirmation', 'ORDER', 1, 2, 'DAYS', 'Merchandising', 'Merchandiser', NULL, 1, 1.0, 2),
  (1, 'ACT_TECH_PACK', 'Tech Pack & Spec Finalized', 'ORDER', 2, 2, 'DAYS', 'Merchandising', 'Merchandiser', 1, 1, 1.0, 2),
  (1, 'ACT_BOM_COST', 'BOM & Costing Approval', 'ORDER', 3, 2, 'DAYS', 'Merchandising', 'Costing Executive', 2, 1, 1.5, 2),
  (1, 'ACT_PROTO_SMP', 'Proto Sample Approval', 'SAMPLING', 4, 4, 'DAYS', 'Sampling', 'Sample Coordinator', 2, 1, 2.0, 3),
  (1, 'ACT_FIT_SMP', 'Fit Sample Approval', 'SAMPLING', 5, 5, 'DAYS', 'Sampling', 'Sample Coordinator', 4, 1, 2.0, 3),
  (1, 'ACT_PP_SMP', 'PP Sample Approval', 'SAMPLING', 6, 4, 'DAYS', 'Sampling', 'QA Manager', 5, 1, 2.5, 3),
  (1, 'ACT_YARN_BOOK', 'Yarn Requirement & PO', 'FABRIC', 7, 3, 'DAYS', 'Purchase', 'Purchase Manager', 3, 1, 2.0, 2),
  (1, 'ACT_KNIT_FAB', 'Knitting Production', 'FABRIC', 8, 6, 'DAYS', 'Knitting', 'Knitting In-charge', 7, 1, 2.5, 2),
  (1, 'ACT_DYE_FIN', 'Dyeing & Finishing', 'FABRIC', 9, 7, 'DAYS', 'Dyeing', 'Processing Manager', 8, 1, 3.0, 3),
  (1, 'ACT_FAB_INHOUSE', 'Fabric In-House & QC', 'FABRIC', 10, 2, 'DAYS', 'Stores', 'Store In-charge', 9, 1, 3.5, 2),
  (1, 'ACT_TRIM_BOOK', 'Trim PO Booking', 'TRIM', 11, 4, 'DAYS', 'Purchase', 'Purchase Executive', 3, 1, 1.5, 2),
  (1, 'ACT_TRIM_INHOUSE', 'Trim In-House & QC', 'TRIM', 12, 2, 'DAYS', 'Stores', 'Store In-charge', 11, 1, 2.0, 2),
  (1, 'ACT_SIZE_SET', 'Size Set Cutting & QC', 'PRODUCTION', 13, 2, 'DAYS', 'QA', 'QA Executive', 6, 1, 2.0, 2),
  (1, 'ACT_CUTTING', 'Bulk Spreading & Cutting', 'PRODUCTION', 14, 4, 'DAYS', 'Cutting', 'Cutting Manager', 10, 1, 3.0, 2),
  (1, 'ACT_PRINT_EMB', 'Chest Print / Embroidery', 'PRODUCTION', 15, 3, 'DAYS', 'Printing', 'Printing In-charge', 14, 0, 2.0, 2),
  (1, 'ACT_SEWING', 'Sewing Assembly Lines', 'PRODUCTION', 16, 10, 'DAYS', 'Sewing', 'Sewing Floor Manager', 15, 1, 5.0, 3),
  (1, 'ACT_FINISHING', 'Ironing & Inspection', 'PRODUCTION', 17, 4, 'DAYS', 'Finishing', 'Finishing Manager', 16, 1, 2.5, 2),
  (1, 'ACT_PACKING', 'Tagging & Carton Packing', 'PRODUCTION', 18, 3, 'DAYS', 'Packing', 'Packing Supervisor', 17, 1, 2.5, 2),
  (1, 'ACT_FINAL_QC', 'Final Buyer Inspection (AQL 2.5)', 'QUALITY', 19, 2, 'DAYS', 'QA', 'QA Manager', 18, 1, 4.0, 2),
  (1, 'ACT_DOC_BOOK', 'Shipping Documentation & Booking', 'SHIPMENT', 20, 2, 'DAYS', 'Commercial', 'Shipping Executive', 19, 1, 2.0, 2),
  (1, 'ACT_SHIPMENT', 'Container Stuffing & On-Board Dispatch', 'SHIPMENT', 21, 1, 'DAYS', 'Commercial', 'Logistics Manager', 20, 1, 5.0, 1);

-- Template 2: Polo Garment
INSERT IGNORE INTO mst_tna_template_header (id, company_id, template_code, template_name, product_type, description, active)
VALUES (2, 1, 'TPL_POLO', 'Polo Garment (Collar & Cuff)', 'Polo', 'Polo shirt T&A template including flat knit collar/cuff procurement and placket preparation', 1);

INSERT IGNORE INTO mst_tna_template_activity
  (template_id, activity_code, activity_name, category, sequence_no, default_duration, duration_uom, department_name, default_owner_role, dependency_sequence, mandatory, weight, alert_before_days)
VALUES
  (2, 'ACT_PO_REC', 'PO Received & Order Confirmation', 'ORDER', 1, 2, 'DAYS', 'Merchandising', 'Merchandiser', NULL, 1, 1.0, 2),
  (2, 'ACT_TECH_PACK', 'Tech Pack & Artwork Approved', 'ORDER', 2, 2, 'DAYS', 'Merchandising', 'Merchandiser', 1, 1, 1.0, 2),
  (2, 'ACT_BOM_COST', 'BOM & Costing Approval', 'ORDER', 3, 2, 'DAYS', 'Merchandising', 'Costing Executive', 2, 1, 1.5, 2),
  (2, 'ACT_PROTO_SMP', 'Proto Sample Approval', 'SAMPLING', 4, 4, 'DAYS', 'Sampling', 'Sample Coordinator', 2, 1, 2.0, 3),
  (2, 'ACT_FIT_SMP', 'Fit Sample Approval', 'SAMPLING', 5, 5, 'DAYS', 'Sampling', 'Sample Coordinator', 4, 1, 2.0, 3),
  (2, 'ACT_PP_SMP', 'PP Sample Approval', 'SAMPLING', 6, 4, 'DAYS', 'Sampling', 'QA Manager', 5, 1, 2.5, 3),
  (2, 'ACT_YARN_BOOK', 'Yarn PO & Booking', 'FABRIC', 7, 4, 'DAYS', 'Purchase', 'Purchase Manager', 3, 1, 2.0, 2),
  (2, 'ACT_KNIT_FAB', 'Knitting (Body + Collar/Cuffs)', 'FABRIC', 8, 8, 'DAYS', 'Knitting', 'Knitting In-charge', 7, 1, 3.0, 2),
  (2, 'ACT_DYE_FIN', 'Dyeing & Heat-setting', 'FABRIC', 9, 8, 'DAYS', 'Dyeing', 'Processing Manager', 8, 1, 3.0, 3),
  (2, 'ACT_FAB_INHOUSE', 'Fabric & Collar In-House', 'FABRIC', 10, 2, 'DAYS', 'Stores', 'Store In-charge', 9, 1, 3.5, 2),
  (2, 'ACT_TRIM_BOOK', 'Trims & Buttons PO', 'TRIM', 11, 4, 'DAYS', 'Purchase', 'Purchase Executive', 3, 1, 1.5, 2),
  (2, 'ACT_TRIM_INHOUSE', 'Buttons & Labels In-House', 'TRIM', 12, 2, 'DAYS', 'Stores', 'Store In-charge', 11, 1, 2.0, 2),
  (2, 'ACT_CUTTING', 'Cutting Body & Placket Panels', 'PRODUCTION', 13, 5, 'DAYS', 'Cutting', 'Cutting Manager', 10, 1, 3.0, 2),
  (2, 'ACT_PRINT_EMB', 'Chest Embroidery Logo', 'PRODUCTION', 14, 4, 'DAYS', 'Printing', 'Printing In-charge', 13, 1, 2.0, 2),
  (2, 'ACT_SEWING', 'Sewing (Placket, Collar, Hem)', 'PRODUCTION', 15, 12, 'DAYS', 'Sewing', 'Sewing Floor Manager', 14, 1, 5.0, 3),
  (2, 'ACT_FINISHING', 'Button Hole, Ironing & Inspection', 'PRODUCTION', 16, 4, 'DAYS', 'Finishing', 'Finishing Manager', 15, 1, 2.5, 2),
  (2, 'ACT_PACKING', 'Collar Support, Polybag & Packing', 'PRODUCTION', 17, 3, 'DAYS', 'Packing', 'Packing Supervisor', 16, 1, 2.5, 2),
  (2, 'ACT_FINAL_QC', 'Final Inspection Passed', 'QUALITY', 18, 2, 'DAYS', 'QA', 'QA Manager', 17, 1, 4.0, 2),
  (2, 'ACT_SHIPMENT', 'Container Stuffing & Shipment', 'SHIPMENT', 19, 2, 'DAYS', 'Commercial', 'Logistics Manager', 18, 1, 5.0, 1);

-- Template 3: Woven Shirt
INSERT IGNORE INTO mst_tna_template_header (id, company_id, template_code, template_name, product_type, description, active)
VALUES (3, 1, 'TPL_WOVEN_SHIRT', 'Woven Casual/Formal Shirt', 'Shirt', 'Woven Shirt T&A workflow with fabric weaving/sourcing, fusing, cuff/collar and button attach', 1);

INSERT IGNORE INTO mst_tna_template_activity 
  (template_id, activity_code, activity_name, category, sequence_no, default_duration, duration_uom, department_name, default_owner_role, dependency_sequence, mandatory, weight, alert_before_days)
VALUES
  (3, 'ACT_TECH_PACK', 'Tech Pack Freeze', 'MERCHANDISING', 1, 2, 'DAYS', 'Merchandising', 'Merchant', NULL, 1, 1.0, 1),
  (3, 'ACT_PROTO_SAMPLE', 'Proto Sample Approved', 'SAMPLING', 2, 5, 'DAYS', 'Sampling', 'Sample Master', 1, 1, 2.0, 2),
  (3, 'ACT_FIT_SAMPLE', 'Fit Sample Approved', 'SAMPLING', 3, 7, 'DAYS', 'Sampling', 'Sample Master', 2, 1, 3.0, 2),
  (3, 'ACT_PP_SAMPLE', 'Pre-Production Sample Approved', 'SAMPLING', 4, 6, 'DAYS', 'Sampling', 'Merchant', 3, 1, 4.0, 2),
  (3, 'ACT_FABRIC_WOVEN', 'Woven Fabric Inward (Shell & Contrast)', 'FABRIC', 5, 20, 'DAYS', 'Procurement', 'Purchase Manager', 4, 1, 6.0, 4),
  (3, 'ACT_FUSING_INWARD', 'Interlining & Fusing Inward', 'TRIMS', 6, 8, 'DAYS', 'Procurement', 'Purchase Officer', 4, 1, 3.0, 2),
  (3, 'ACT_TRIMS_INWARD', 'Buttons, Labels & Thread Inward', 'TRIMS', 7, 10, 'DAYS', 'Procurement', 'Purchase Officer', 4, 1, 3.0, 2),
  (3, 'ACT_PPM', 'Pre-Production Meeting (PPM)', 'PRODUCTION', 8, 1, 'DAYS', 'QA / Production', 'Factory Manager', 7, 1, 2.0, 1),
  (3, 'ACT_FABRIC_INSPECT', '4-Point Fabric Inspection', 'QUALITY', 9, 2, 'DAYS', 'Fabric QC', 'QA Officer', 5, 1, 2.0, 1),
  (3, 'ACT_CUTTING', 'Spreading & Precision Cutting', 'PRODUCTION', 10, 4, 'DAYS', 'Cutting', 'Cutting Master', 9, 1, 4.0, 2),
  (3, 'ACT_COLLAR_FUSING', 'Collar & Cuff Fusing Process', 'PRODUCTION', 11, 3, 'DAYS', 'Cutting', 'Cutting Supervisor', 10, 1, 2.5, 1),
  (3, 'ACT_SEWING', 'Sewing Assembly (Collar, Front, Sleeves)', 'PRODUCTION', 12, 14, 'DAYS', 'Sewing', 'Floor In-Charge', 11, 1, 6.0, 3),
  (3, 'ACT_BUTTON_ATTACH', 'Button Hole & Button Attach', 'PRODUCTION', 13, 3, 'DAYS', 'Finishing', 'Finishing Supervisor', 12, 1, 3.0, 2),
  (3, 'ACT_PRESSING', 'Steam Pressing & Thread Trimming', 'PRODUCTION', 14, 3, 'DAYS', 'Finishing', 'Finishing Manager', 13, 1, 2.5, 2),
  (3, 'ACT_FINAL_QC', 'Final QA Audit (AQL 2.5)', 'QUALITY', 15, 2, 'DAYS', 'QA', 'QA Manager', 14, 1, 4.0, 2),
  (3, 'ACT_PACKING', 'Pinning, Cardboard & Polybag Packing', 'PRODUCTION', 16, 3, 'DAYS', 'Packing', 'Packing In-Charge', 15, 1, 3.0, 2),
  (3, 'ACT_SHIPMENT', 'Container Handover & Dispatch', 'SHIPMENT', 17, 2, 'DAYS', 'Commercial', 'Logistics Manager', 16, 1, 5.0, 1);

-- Template 4: Bottoms / Pant
INSERT IGNORE INTO mst_tna_template_header (id, company_id, template_code, template_name, product_type, description, active)
VALUES (4, 1, 'TPL_BOTTOMS', 'Casual Pants / Chinos / Joggers', 'Bottoms', 'Bottom wear with zipper, waistband fusing, wash cycle and bar-tack operations', 1);

INSERT IGNORE INTO mst_tna_template_activity 
  (template_id, activity_code, activity_name, category, sequence_no, default_duration, duration_uom, department_name, default_owner_role, dependency_sequence, mandatory, weight, alert_before_days)
VALUES
  (4, 'ACT_TECH_PACK', 'Tech Pack Freeze', 'MERCHANDISING', 1, 2, 'DAYS', 'Merchandising', 'Merchant', NULL, 1, 1.0, 1),
  (4, 'ACT_FIT_SAMPLE', 'Fit Sample Approved', 'SAMPLING', 2, 7, 'DAYS', 'Sampling', 'Sample Master', 1, 1, 3.0, 2),
  (4, 'ACT_PP_SAMPLE', 'Pre-Production Sample Approved', 'SAMPLING', 3, 6, 'DAYS', 'Sampling', 'Merchant', 2, 1, 4.0, 2),
  (4, 'ACT_FABRIC_INWARD', 'Twill/Denim Fabric Inward', 'FABRIC', 4, 18, 'DAYS', 'Procurement', 'Purchase Manager', 3, 1, 6.0, 4),
  (4, 'ACT_TRIMS_ZIPPER', 'Zippers, Rivets & Pocketing Inward', 'TRIMS', 5, 12, 'DAYS', 'Procurement', 'Purchase Officer', 3, 1, 3.0, 2),
  (4, 'ACT_PPM', 'Pre-Production Meeting (PPM)', 'PRODUCTION', 6, 1, 'DAYS', 'QA / Production', 'Factory Manager', 5, 1, 2.0, 1),
  (4, 'ACT_CUTTING', 'Spreading & Bulk Cutting', 'PRODUCTION', 7, 4, 'DAYS', 'Cutting', 'Cutting Master', 6, 1, 4.0, 2),
  (4, 'ACT_SEWING', 'Sewing (Pockets, Fly, Inseam, Waistband)', 'PRODUCTION', 8, 14, 'DAYS', 'Sewing', 'Floor In-Charge', 7, 1, 6.0, 3),
  (4, 'ACT_WASHING', 'Garment Wash / Enzyme Wash', 'PRODUCTION', 9, 5, 'DAYS', 'Washing', 'Washing Master', 8, 1, 4.0, 2),
  (4, 'ACT_RIVET_BUTTON', 'Rivet & Metal Button Attachment', 'PRODUCTION', 10, 2, 'DAYS', 'Finishing', 'Finishing Supervisor', 9, 1, 2.5, 1),
  (4, 'ACT_PRESSING', 'Pressing & Dimension Check', 'PRODUCTION', 11, 3, 'DAYS', 'Finishing', 'Finishing Manager', 10, 1, 2.5, 2),
  (4, 'ACT_FINAL_QC', 'Final QA Audit Passed', 'QUALITY', 12, 2, 'DAYS', 'QA', 'QA Manager', 11, 1, 4.0, 2),
  (4, 'ACT_PACKING', 'Folding, Tagging & Carton Packing', 'PRODUCTION', 13, 3, 'DAYS', 'Packing', 'Packing In-Charge', 12, 1, 3.0, 2),
  (4, 'ACT_SHIPMENT', 'Container Loading & Dispatch', 'SHIPMENT', 14, 2, 'DAYS', 'Commercial', 'Logistics Manager', 13, 1, 5.0, 1);

-- Template 5: Fleece Hoodie / Sweatshirt
INSERT IGNORE INTO mst_tna_template_header (id, company_id, template_code, template_name, product_type, description, active)
VALUES (5, 1, 'TPL_FLEECE', 'Fleece Hoodie & Sweatshirt', 'Fleece', 'Heavyweight fleece garment with brushed back fabric, hood lining, eyelets and drawcord', 1);

INSERT IGNORE INTO mst_tna_template_activity 
  (template_id, activity_code, activity_name, category, sequence_no, default_duration, duration_uom, department_name, default_owner_role, dependency_sequence, mandatory, weight, alert_before_days)
VALUES
  (5, 'ACT_TECH_PACK', 'Tech Pack Freeze', 'MERCHANDISING', 1, 2, 'DAYS', 'Merchandising', 'Merchant', NULL, 1, 1.0, 1),
  (5, 'ACT_PP_SAMPLE', 'Pre-Production Sample Approved', 'SAMPLING', 2, 7, 'DAYS', 'Sampling', 'Merchant', 1, 1, 4.0, 2),
  (5, 'ACT_YARN_INWARD', 'Yarn Inward & Inspection', 'MATERIAL', 3, 12, 'DAYS', 'Procurement', 'Purchase Officer', 2, 1, 4.0, 3),
  (5, 'ACT_KNITTING_FLEECE', '3-Thread Fleece Knitting', 'PRODUCTION', 4, 10, 'DAYS', 'Knitting', 'Knitting Manager', 3, 1, 5.0, 2),
  (5, 'ACT_DYEING_BRUSHING', 'Dyeing & Napping / Brushing Process', 'PRODUCTION', 5, 8, 'DAYS', 'Dyeing', 'Dyeing Manager', 4, 1, 5.0, 2),
  (5, 'ACT_RIB_DRAWCORD', 'Rib, Eyelets & Drawcord Inward', 'TRIMS', 6, 8, 'DAYS', 'Procurement', 'Purchase Officer', 2, 1, 3.0, 2),
  (5, 'ACT_PPM', 'Pre-Production Meeting (PPM)', 'PRODUCTION', 7, 1, 'DAYS', 'QA / Production', 'Factory Manager', 6, 1, 2.0, 1),
  (5, 'ACT_CUTTING', 'Cutting Fleece, Hood & Pocket Panels', 'PRODUCTION', 8, 4, 'DAYS', 'Cutting', 'Cutting Master', 7, 1, 4.0, 2),
  (5, 'ACT_HOOD_ASSEMBLY', 'Pocket & Hood Assembly with Eyelets', 'PRODUCTION', 9, 4, 'DAYS', 'Sewing', 'Floor In-Charge', 8, 1, 3.0, 2),
  (5, 'ACT_SEWING', 'Garment Body & Rib Assembly', 'PRODUCTION', 10, 12, 'DAYS', 'Sewing', 'Floor In-Charge', 9, 1, 6.0, 3),
  (5, 'ACT_FINISHING', 'Drawcord Threading, Steam Pressing & QC', 'PRODUCTION', 11, 4, 'DAYS', 'Finishing', 'Finishing Manager', 10, 1, 3.0, 2),
  (5, 'ACT_FINAL_QC', 'Final Inspection Passed', 'QUALITY', 12, 2, 'DAYS', 'QA', 'QA Manager', 11, 1, 4.0, 2),
  (5, 'ACT_PACKING', 'Flat Pack / Hanger Pack & Box Packing', 'PRODUCTION', 13, 3, 'DAYS', 'Packing', 'Packing In-Charge', 12, 1, 3.0, 2),
  (5, 'ACT_SHIPMENT', 'Dispatch & Port Clearance', 'SHIPMENT', 14, 2, 'DAYS', 'Commercial', 'Logistics Manager', 13, 1, 5.0, 1);

