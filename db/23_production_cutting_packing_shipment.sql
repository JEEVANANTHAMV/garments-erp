-- =====================================================================
-- 23. PRODUCTION TRACEABILITY, CUTTING PLAN, PACKING LIST & SHIPMENT
--     Phase 1 of Cutting→Packing→Shipment implementation
-- =====================================================================

-- =============================================================
-- A. ADD io_no TO ALL PRODUCTION TABLES FOR TRACEABILITY
-- =============================================================

ALTER TABLE trx_production_order
  ADD COLUMN io_no VARCHAR(40) AFTER po_prod_no;

ALTER TABLE trx_cutting
  ADD COLUMN io_no VARCHAR(40) AFTER cut_no;

ALTER TABLE trx_cutting_bundle
  ADD COLUMN io_no VARCHAR(40) AFTER cutting_id,
  ADD COLUMN style_id BIGINT UNSIGNED AFTER io_no,
  ADD COLUMN color_id BIGINT UNSIGNED AFTER style_id,
  ADD COLUMN size_id  INT UNSIGNED AFTER color_id,
  ADD COLUMN component VARCHAR(60) AFTER size_id;

ALTER TABLE trx_printing
  ADD COLUMN io_no VARCHAR(40) AFTER print_no;

ALTER TABLE trx_embroidery
  ADD COLUMN io_no VARCHAR(40) AFTER emb_no;

ALTER TABLE trx_washing
  ADD COLUMN io_no VARCHAR(40) AFTER wash_no;

ALTER TABLE trx_stitching
  ADD COLUMN io_no VARCHAR(40) AFTER stitch_no;

ALTER TABLE trx_finishing
  ADD COLUMN io_no VARCHAR(40) AFTER finish_no;

ALTER TABLE trx_process_transaction
  ADD COLUMN io_no VARCHAR(40) AFTER txn_no;

ALTER TABLE trx_packing
  ADD COLUMN io_no    VARCHAR(40) AFTER pack_no,
  ADD COLUMN style_id BIGINT UNSIGNED AFTER io_no;

ALTER TABLE trx_daily_production_plan
  ADD COLUMN io_no VARCHAR(40) AFTER plan_no;

ALTER TABLE trx_daily_output
  ADD COLUMN io_no VARCHAR(40) AFTER output_no;


-- =============================================================
-- B. CUTTING PLAN (Master cutting plan per IO/Style/Colour)
-- =============================================================

CREATE TABLE trx_cutting_plan (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  plan_no         VARCHAR(40) NOT NULL,
  plan_date       DATE NOT NULL,
  io_no           VARCHAR(40) NOT NULL,
  so_id           BIGINT UNSIGNED,
  prod_order_id   BIGINT UNSIGNED,
  style_id        BIGINT UNSIGNED NOT NULL,
  color_id        BIGINT UNSIGNED,
  order_qty       INT UNSIGNED DEFAULT 0,
  planned_cut_qty INT UNSIGNED DEFAULT 0,
  actual_cut_qty  INT UNSIGNED DEFAULT 0,
  required_date   DATE,
  marker_ref      VARCHAR(60),
  marker_eff_pct  DECIMAL(6,3),
  fabric_id       BIGINT UNSIGNED,
  fabric_req_kg   DECIMAL(12,4),
  fabric_req_mtr  DECIMAL(12,4),
  status          ENUM('DRAFT','APPROVED','RELEASED','IN_PROGRESS','COMPLETED','CLOSED','CANCELLED') DEFAULT 'DRAFT',
  remarks         VARCHAR(500),
  created_by      BIGINT UNSIGNED,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by      BIGINT UNSIGNED,
  updated_at      DATETIME ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_cutplan (company_id, plan_no),
  KEY ix_cutplan_io (io_no),
  CONSTRAINT fk_cplan__company FOREIGN KEY (company_id) REFERENCES mst_company(id),
  CONSTRAINT fk_cplan__so      FOREIGN KEY (so_id)      REFERENCES trx_sales_order(id),
  CONSTRAINT fk_cplan__prod    FOREIGN KEY (prod_order_id) REFERENCES trx_production_order(id),
  CONSTRAINT fk_cplan__style   FOREIGN KEY (style_id)   REFERENCES mst_style(id),
  CONSTRAINT fk_cplan__color   FOREIGN KEY (color_id)   REFERENCES mst_color(id),
  CONSTRAINT fk_cplan__fabric  FOREIGN KEY (fabric_id)  REFERENCES mst_fabric(id)
) ENGINE=InnoDB COMMENT='Cutting plan header with I/O + Style traceability';

-- Size-wise breakdown per cutting plan
CREATE TABLE trx_cutting_plan_size (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  cutting_plan_id BIGINT UNSIGNED NOT NULL,
  size_id         INT UNSIGNED NOT NULL,
  sku_id          BIGINT UNSIGNED,
  order_qty       INT UNSIGNED DEFAULT 0,
  planned_qty     INT UNSIGNED DEFAULT 0,
  actual_qty      INT UNSIGNED DEFAULT 0,
  CONSTRAINT fk_cps__plan FOREIGN KEY (cutting_plan_id) REFERENCES trx_cutting_plan(id) ON DELETE CASCADE,
  CONSTRAINT fk_cps__size FOREIGN KEY (size_id) REFERENCES mst_size(id),
  CONSTRAINT fk_cps__sku  FOREIGN KEY (sku_id)  REFERENCES mst_style_sku(id)
) ENGINE=InnoDB COMMENT='Cutting plan size-wise quantities';


-- =============================================================
-- C. FABRIC ISSUE (Roll-level issue to cutting plan)
-- =============================================================

CREATE TABLE trx_fabric_issue (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  issue_no        VARCHAR(40) NOT NULL,
  issue_date      DATE NOT NULL,
  io_no           VARCHAR(40) NOT NULL,
  cutting_plan_id BIGINT UNSIGNED,
  style_id        BIGINT UNSIGNED NOT NULL,
  color_id        BIGINT UNSIGNED,
  fabric_id       BIGINT UNSIGNED,
  warehouse_id    BIGINT UNSIGNED,
  total_rolls     INT UNSIGNED DEFAULT 0,
  total_mtr       DECIMAL(12,4) DEFAULT 0,
  total_kg        DECIMAL(12,4) DEFAULT 0,
  status          ENUM('DRAFT','ISSUED','CONFIRMED','RETURNED') DEFAULT 'DRAFT',
  remarks         VARCHAR(500),
  created_by      BIGINT UNSIGNED,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_fabissue (company_id, issue_no),
  KEY ix_fabissue_io (io_no),
  CONSTRAINT fk_fiss__company  FOREIGN KEY (company_id) REFERENCES mst_company(id),
  CONSTRAINT fk_fiss__cutplan  FOREIGN KEY (cutting_plan_id) REFERENCES trx_cutting_plan(id),
  CONSTRAINT fk_fiss__style    FOREIGN KEY (style_id) REFERENCES mst_style(id),
  CONSTRAINT fk_fiss__color    FOREIGN KEY (color_id) REFERENCES mst_color(id),
  CONSTRAINT fk_fiss__fabric   FOREIGN KEY (fabric_id) REFERENCES mst_fabric(id),
  CONSTRAINT fk_fiss__wh       FOREIGN KEY (warehouse_id) REFERENCES mst_warehouse(id)
) ENGINE=InnoDB COMMENT='Fabric issue to cutting with I/O traceability';

CREATE TABLE trx_fabric_issue_roll (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  fabric_issue_id BIGINT UNSIGNED NOT NULL,
  lot_no          VARCHAR(40),
  roll_no         VARCHAR(40),
  shade           VARCHAR(40),
  issue_mtr       DECIMAL(12,4),
  issue_kg        DECIMAL(12,4),
  gsm             DECIMAL(8,2),
  width_cm        DECIMAL(8,2),
  CONSTRAINT fk_firoll__issue FOREIGN KEY (fabric_issue_id) REFERENCES trx_fabric_issue(id) ON DELETE CASCADE
) ENGINE=InnoDB COMMENT='Fabric issue roll-level detail';


-- =============================================================
-- D. BUNDLE MOVEMENT (Stage tracking for bundles)
-- =============================================================

CREATE TABLE trx_bundle_movement (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  bundle_id       BIGINT UNSIGNED NOT NULL,
  io_no           VARCHAR(40),
  style_id        BIGINT UNSIGNED,
  from_stage      VARCHAR(40) NOT NULL,
  to_stage        VARCHAR(40) NOT NULL,
  moved_qty       INT UNSIGNED DEFAULT 0,
  moved_by        BIGINT UNSIGNED,
  moved_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  destination     VARCHAR(80),
  remarks         VARCHAR(255),
  CONSTRAINT fk_bmov__company FOREIGN KEY (company_id) REFERENCES mst_company(id),
  CONSTRAINT fk_bmov__bundle  FOREIGN KEY (bundle_id)  REFERENCES trx_cutting_bundle(id),
  CONSTRAINT fk_bmov__style   FOREIGN KEY (style_id)   REFERENCES mst_style(id)
) ENGINE=InnoDB COMMENT='Bundle movement tracking between stages';

-- Add status field to cutting_bundle
ALTER TABLE trx_cutting_bundle
  ADD COLUMN status ENUM('GENERATED','CHECKED','ISSUED','IN_SEWING','COMPLETED','FINISHING','CLOSED') DEFAULT 'GENERATED';


-- =============================================================
-- E. FG STOCK RECEIPT (Finished Goods receipt with I/O traceability)
-- =============================================================

CREATE TABLE trx_fg_receipt (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  receipt_no      VARCHAR(40) NOT NULL,
  receipt_date    DATE NOT NULL,
  io_no           VARCHAR(40) NOT NULL,
  so_id           BIGINT UNSIGNED,
  prod_order_id   BIGINT UNSIGNED,
  style_id        BIGINT UNSIGNED NOT NULL,
  warehouse_id    BIGINT UNSIGNED,
  source_stage    VARCHAR(40) DEFAULT 'FINISHING',
  source_ref      VARCHAR(60),
  total_qty       INT UNSIGNED DEFAULT 0,
  total_reject    INT UNSIGNED DEFAULT 0,
  status          ENUM('DRAFT','RECEIVED','CONFIRMED','CLOSED') DEFAULT 'DRAFT',
  remarks         VARCHAR(500),
  created_by      BIGINT UNSIGNED,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_fg_receipt (company_id, receipt_no),
  KEY ix_fgr_io (io_no),
  CONSTRAINT fk_fgr__company FOREIGN KEY (company_id) REFERENCES mst_company(id),
  CONSTRAINT fk_fgr__so      FOREIGN KEY (so_id)      REFERENCES trx_sales_order(id),
  CONSTRAINT fk_fgr__prod    FOREIGN KEY (prod_order_id) REFERENCES trx_production_order(id),
  CONSTRAINT fk_fgr__style   FOREIGN KEY (style_id)   REFERENCES mst_style(id),
  CONSTRAINT fk_fgr__wh      FOREIGN KEY (warehouse_id) REFERENCES mst_warehouse(id)
) ENGINE=InnoDB COMMENT='Finished goods receipt with I/O traceability';

CREATE TABLE trx_fg_receipt_line (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  fg_receipt_id   BIGINT UNSIGNED NOT NULL,
  color_id        BIGINT UNSIGNED NOT NULL,
  size_id         INT UNSIGNED NOT NULL,
  sku_id          BIGINT UNSIGNED,
  good_qty        INT UNSIGNED DEFAULT 0,
  reject_qty      INT UNSIGNED DEFAULT 0,
  batch_no        VARCHAR(40),
  CONSTRAINT fk_fgrl__receipt FOREIGN KEY (fg_receipt_id) REFERENCES trx_fg_receipt(id) ON DELETE CASCADE,
  CONSTRAINT fk_fgrl__color   FOREIGN KEY (color_id) REFERENCES mst_color(id),
  CONSTRAINT fk_fgrl__size    FOREIGN KEY (size_id) REFERENCES mst_size(id),
  CONSTRAINT fk_fgrl__sku     FOREIGN KEY (sku_id) REFERENCES mst_style_sku(id)
) ENGINE=InnoDB COMMENT='FG receipt colour/size lines';


-- =============================================================
-- F. ENHANCED PACKING LIST (Separate from export packing list)
-- =============================================================

-- Add missing fields to trx_packing for I/O traceability
-- (io_no and style_id already added in section A above)

-- Enhanced packing list for domestic + export with package selection
ALTER TABLE trx_packing_list
  ADD COLUMN io_no          VARCHAR(40) AFTER pl_no,
  ADD COLUMN so_id          BIGINT UNSIGNED AFTER io_no,
  ADD COLUMN buyer_id       BIGINT UNSIGNED AFTER so_id,
  ADD COLUMN consignee_id   BIGINT UNSIGNED AFTER buyer_id,
  ADD COLUMN shipment_type  ENUM('DOMESTIC','EXPORT') DEFAULT 'DOMESTIC' AFTER consignee_id,
  ADD COLUMN destination    VARCHAR(120) AFTER shipment_type,
  ADD COLUMN style_summary  TEXT AFTER destination,
  ADD COLUMN status         ENUM('DRAFT','CONFIRMED','CLOSED') DEFAULT 'DRAFT' AFTER style_summary;


-- =============================================================
-- G. ENHANCED SHIPMENT (Domestic + Export with package allocation)
-- =============================================================

-- Add domestic/export conditional fields to trx_shipment
ALTER TABLE trx_shipment
  ADD COLUMN io_no           VARCHAR(40) AFTER shipment_no,
  ADD COLUMN so_id           BIGINT UNSIGNED AFTER io_no,
  ADD COLUMN packing_list_id BIGINT UNSIGNED AFTER so_id,
  ADD COLUMN buyer_id        BIGINT UNSIGNED AFTER packing_list_id,
  ADD COLUMN consignee_id    BIGINT UNSIGNED AFTER buyer_id,
  ADD COLUMN notify_party_id BIGINT UNSIGNED AFTER consignee_id,
  ADD COLUMN shipment_type   ENUM('DOMESTIC','EXPORT') DEFAULT 'DOMESTIC' AFTER notify_party_id,
  ADD COLUMN mode            ENUM('SEA','AIR','ROAD','COURIER') DEFAULT 'ROAD' AFTER shipment_type,
  ADD COLUMN incoterm        ENUM('FOB','CIF','CFR','EXW','DDP','DAP','FCA') AFTER mode,
  ADD COLUMN destination     VARCHAR(120) AFTER incoterm,
  ADD COLUMN country_id      SMALLINT UNSIGNED AFTER destination,
  ADD COLUMN freight_terms   VARCHAR(80) AFTER country_id,
  ADD COLUMN total_packages  INT UNSIGNED DEFAULT 0 AFTER freight_terms,
  ADD COLUMN total_qty       INT UNSIGNED DEFAULT 0 AFTER total_packages,
  ADD COLUMN net_weight_kg   DECIMAL(12,3) AFTER total_qty,
  ADD COLUMN gross_weight_kg DECIMAL(12,3) AFTER net_weight_kg,
  ADD COLUMN total_cbm       DECIMAL(12,5) AFTER gross_weight_kg,
  ADD COLUMN remarks         TEXT AFTER total_cbm;


-- Shipment → Package allocation table
CREATE TABLE trx_shipment_package (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  shipment_id     BIGINT UNSIGNED NOT NULL,
  carton_id       BIGINT UNSIGNED NOT NULL,
  packing_id      BIGINT UNSIGNED,
  package_no      VARCHAR(40),
  allocated_qty   INT UNSIGNED DEFAULT 0,
  gross_weight_kg DECIMAL(10,3),
  cbm             DECIMAL(10,5),
  status          ENUM('ALLOCATED','DISPATCHED','DELIVERED','CANCELLED') DEFAULT 'ALLOCATED',
  UNIQUE KEY uq_ship_pkg (shipment_id, carton_id),
  CONSTRAINT fk_spkg__shipment FOREIGN KEY (shipment_id) REFERENCES trx_shipment(id),
  CONSTRAINT fk_spkg__carton   FOREIGN KEY (carton_id)   REFERENCES trx_carton(id),
  CONSTRAINT fk_spkg__packing  FOREIGN KEY (packing_id)  REFERENCES trx_packing(id)
) ENGINE=InnoDB COMMENT='Shipment package/carton allocation';

-- Shipment item summary (auto-derived from packages)
CREATE TABLE trx_shipment_item_summary (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  shipment_id     BIGINT UNSIGNED NOT NULL,
  style_id        BIGINT UNSIGNED,
  color_id        BIGINT UNSIGNED,
  size_id         INT UNSIGNED,
  sku_id          BIGINT UNSIGNED,
  qty             INT UNSIGNED DEFAULT 0,
  net_weight_kg   DECIMAL(10,3),
  gross_weight_kg DECIMAL(10,3),
  cbm             DECIMAL(10,5),
  CONSTRAINT fk_sis__shipment FOREIGN KEY (shipment_id) REFERENCES trx_shipment(id),
  CONSTRAINT fk_sis__style    FOREIGN KEY (style_id)    REFERENCES mst_style(id)
) ENGINE=InnoDB COMMENT='Shipment item summary derived from package contents';


-- =============================================================
-- H. ENHANCED DISPATCH (Transport, LR, E-Way Bill)
-- =============================================================

ALTER TABLE trx_dispatch
  ADD COLUMN io_no            VARCHAR(40) AFTER dispatch_no,
  ADD COLUMN shipment_id      BIGINT UNSIGNED AFTER io_no,
  ADD COLUMN transporter_id   BIGINT UNSIGNED AFTER shipment_id,
  ADD COLUMN vehicle_no       VARCHAR(20) AFTER transporter_id,
  ADD COLUMN driver_name      VARCHAR(80) AFTER vehicle_no,
  ADD COLUMN lr_no            VARCHAR(40) AFTER driver_name,
  ADD COLUMN lr_date          DATE AFTER lr_no,
  ADD COLUMN eway_bill_no     VARCHAR(40) AFTER lr_date,
  ADD COLUMN dispatch_time    TIME AFTER eway_bill_no,
  ADD COLUMN delivery_location VARCHAR(120) AFTER dispatch_time,
  ADD COLUMN pod_ref          VARCHAR(60) AFTER delivery_location,
  ADD COLUMN delivered_date   DATE AFTER pod_ref,
  ADD COLUMN receiver_name    VARCHAR(80) AFTER delivered_date,
  ADD COLUMN remarks          TEXT AFTER receiver_name;


-- =============================================================
-- I. SHIPMENT DOCUMENT TYPE MASTER
-- =============================================================

CREATE TABLE cfg_shipment_doc_type (
  id              INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  doc_code        VARCHAR(30) NOT NULL,
  doc_name        VARCHAR(120) NOT NULL,
  domestic_allowed TINYINT(1) DEFAULT 1,
  export_allowed   TINYINT(1) DEFAULT 1,
  is_mandatory     TINYINT(1) DEFAULT 0,
  sort_order      INT DEFAULT 0,
  is_active       TINYINT(1) NOT NULL DEFAULT 1,
  UNIQUE KEY uq_shipdoctype (company_id, doc_code),
  CONSTRAINT fk_sdt__company FOREIGN KEY (company_id) REFERENCES mst_company(id)
) ENGINE=InnoDB COMMENT='Shipment document type master';

-- Shipment documents (actual documents attached)
CREATE TABLE trx_shipment_document (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  shipment_id     BIGINT UNSIGNED NOT NULL,
  doc_type_id     INT UNSIGNED NOT NULL,
  document_no     VARCHAR(60),
  file_path       VARCHAR(255),
  status          ENUM('PENDING','PREPARED','VERIFIED') DEFAULT 'PENDING',
  verified_by     BIGINT UNSIGNED,
  remarks         VARCHAR(255),
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_sdoc__shipment FOREIGN KEY (shipment_id) REFERENCES trx_shipment(id),
  CONSTRAINT fk_sdoc__doctype  FOREIGN KEY (doc_type_id) REFERENCES cfg_shipment_doc_type(id)
) ENGINE=InnoDB COMMENT='Shipment attached documents';


-- =============================================================
-- J. PACKAGE TYPE MASTER
-- =============================================================

CREATE TABLE cfg_package_type (
  id              INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  type_code       VARCHAR(20) NOT NULL,
  type_name       VARCHAR(80) NOT NULL,
  prefix          VARCHAR(10) DEFAULT 'CTN-',
  is_active       TINYINT(1) NOT NULL DEFAULT 1,
  UNIQUE KEY uq_pkgtype (company_id, type_code),
  CONSTRAINT fk_pkgt__company FOREIGN KEY (company_id) REFERENCES mst_company(id)
) ENGINE=InnoDB COMMENT='Package type master (Carton, Bale, Pallet)';

-- Seed default package types
INSERT INTO cfg_package_type (company_id, type_code, type_name, prefix)
SELECT id, 'CARTON', 'Carton', 'CTN-' FROM mst_company
UNION ALL
SELECT id, 'BALE', 'Bale', 'BAL-' FROM mst_company
UNION ALL
SELECT id, 'PALLET', 'Pallet', 'PAL-' FROM mst_company;

-- Seed default shipment document types
INSERT INTO cfg_shipment_doc_type (company_id, doc_code, doc_name, domestic_allowed, export_allowed, is_mandatory, sort_order)
SELECT id, 'TAX_INVOICE', 'Tax Invoice / E-Invoice', 1, 1, 1, 1 FROM mst_company
UNION ALL
SELECT id, 'PACKING_LIST', 'Packing List', 1, 1, 1, 2 FROM mst_company
UNION ALL
SELECT id, 'EWAY_BILL', 'E-Way Bill', 1, 1, 0, 3 FROM mst_company
UNION ALL
SELECT id, 'COMM_INVOICE', 'Commercial Invoice', 0, 1, 1, 4 FROM mst_company
UNION ALL
SELECT id, 'SHIPPING_BILL', 'Shipping Bill', 0, 1, 1, 5 FROM mst_company
UNION ALL
SELECT id, 'COO', 'Certificate of Origin', 0, 1, 0, 6 FROM mst_company
UNION ALL
SELECT id, 'BL_AWB', 'Bill of Lading / AWB', 0, 1, 0, 7 FROM mst_company
UNION ALL
SELECT id, 'INSURANCE', 'Insurance Certificate', 0, 1, 0, 8 FROM mst_company
UNION ALL
SELECT id, 'INSPECTION', 'Inspection Certificate', 0, 1, 0, 9 FROM mst_company
UNION ALL
SELECT id, 'LR_DOCKET', 'LR / Transport Docket', 1, 0, 0, 10 FROM mst_company;
