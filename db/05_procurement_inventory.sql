-- =====================================================================
-- 9. MRP  /  PURCHASE  /  INVENTORY  /  WAREHOUSE  /  BATCH  /  BARCODE
-- =====================================================================

-- Material Requirement Planning run (explodes BOM against SO)
CREATE TABLE trx_mrp_run (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  mrp_no          VARCHAR(40) NOT NULL,
  run_date        DATE NOT NULL,
  so_id           BIGINT UNSIGNED,        -- optional scope to one SO
  status_id       INT UNSIGNED,
  remarks         VARCHAR(500),
  created_by      BIGINT UNSIGNED,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_mrp (company_id,mrp_no),
  CONSTRAINT fk_mrp__company FOREIGN KEY (company_id) REFERENCES mst_company(id),
  CONSTRAINT fk_mrp__so      FOREIGN KEY (so_id)      REFERENCES trx_sales_order(id),
  CONSTRAINT fk_mrp__status  FOREIGN KEY (status_id)  REFERENCES cfg_status(id)
) ENGINE=InnoDB COMMENT='MRP run header';

CREATE TABLE trx_mrp_requirement (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  mrp_id          BIGINT UNSIGNED NOT NULL,
  so_id           BIGINT UNSIGNED,
  style_id        BIGINT UNSIGNED,
  material_type   ENUM('YARN','FABRIC','TRIM') NOT NULL,
  yarn_id         BIGINT UNSIGNED,
  fabric_id       BIGINT UNSIGNED,
  trim_id         BIGINT UNSIGNED,
  color_id        BIGINT UNSIGNED,
  gross_required  DECIMAL(18,5) NOT NULL,
  in_stock        DECIMAL(18,5) DEFAULT 0,
  on_order        DECIMAL(18,5) DEFAULT 0,
  net_required    DECIMAL(18,5) NOT NULL,
  uom_id          SMALLINT UNSIGNED NOT NULL,
  required_by     DATE,
  CONSTRAINT fk_mrpr__mrp    FOREIGN KEY (mrp_id)    REFERENCES trx_mrp_run(id),
  CONSTRAINT fk_mrpr__so     FOREIGN KEY (so_id)     REFERENCES trx_sales_order(id),
  CONSTRAINT fk_mrpr__style  FOREIGN KEY (style_id)  REFERENCES mst_style(id),
  CONSTRAINT fk_mrpr__yarn   FOREIGN KEY (yarn_id)   REFERENCES mst_yarn(id),
  CONSTRAINT fk_mrpr__fabric FOREIGN KEY (fabric_id) REFERENCES mst_fabric(id),
  CONSTRAINT fk_mrpr__trim   FOREIGN KEY (trim_id)   REFERENCES mst_trim(id),
  CONSTRAINT fk_mrpr__color  FOREIGN KEY (color_id)  REFERENCES mst_color(id),
  CONSTRAINT fk_mrpr__uom    FOREIGN KEY (uom_id)    REFERENCES cfg_uom(id)
) ENGINE=InnoDB COMMENT='MRP net requirement (BOM explosion)';

-- Purchase Order to supplier / vendor
CREATE TABLE trx_purchase_order (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  branch_id       BIGINT UNSIGNED,
  po_no           VARCHAR(40) NOT NULL,
  po_date         DATE NOT NULL,
  supplier_id     BIGINT UNSIGNED NOT NULL,
  po_type         ENUM('MATERIAL','JOBWORK','SERVICE','CAPEX') NOT NULL DEFAULT 'MATERIAL',
  so_id           BIGINT UNSIGNED,        -- back-to-back linkage
  mrp_id          BIGINT UNSIGNED,
  currency_id     SMALLINT UNSIGNED NOT NULL,
  exchange_rate   DECIMAL(18,6) DEFAULT 1,
  delivery_date   DATE,
  payment_terms   VARCHAR(150),
  total_amount    DECIMAL(18,4) DEFAULT 0,
  tax_amount      DECIMAL(18,4) DEFAULT 0,
  grand_total     DECIMAL(18,4) DEFAULT 0,
  status_id       INT UNSIGNED,           -- domain PURCHASE_ORDER
  approval_state  ENUM('DRAFT','PENDING','APPROVED','REJECTED','CLOSED','CANCELLED') DEFAULT 'DRAFT',
  remarks         TEXT,
  is_deleted      TINYINT(1) NOT NULL DEFAULT 0,
  created_by      BIGINT UNSIGNED,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by      BIGINT UNSIGNED,
  updated_at      DATETIME ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_po (company_id,po_no),
  KEY ix_po_supplier (supplier_id),
  CONSTRAINT fk_po__company  FOREIGN KEY (company_id)  REFERENCES mst_company(id),
  CONSTRAINT fk_po__branch   FOREIGN KEY (branch_id)   REFERENCES mst_branch(id),
  CONSTRAINT fk_po__supplier FOREIGN KEY (supplier_id) REFERENCES mst_party(id),
  CONSTRAINT fk_po__so       FOREIGN KEY (so_id)       REFERENCES trx_sales_order(id),
  CONSTRAINT fk_po__mrp      FOREIGN KEY (mrp_id)      REFERENCES trx_mrp_run(id),
  CONSTRAINT fk_po__cur      FOREIGN KEY (currency_id) REFERENCES cfg_currency(id),
  CONSTRAINT fk_po__status   FOREIGN KEY (status_id)   REFERENCES cfg_status(id)
) ENGINE=InnoDB COMMENT='Purchase order (material / jobwork)';

CREATE TABLE trx_purchase_order_line (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  po_id           BIGINT UNSIGNED NOT NULL,
  material_type   ENUM('YARN','FABRIC','TRIM','SERVICE') NOT NULL,
  yarn_id         BIGINT UNSIGNED,
  fabric_id       BIGINT UNSIGNED,
  trim_id         BIGINT UNSIGNED,
  color_id        BIGINT UNSIGNED,
  description     VARCHAR(255),
  qty             DECIMAL(18,5) NOT NULL,
  uom_id          SMALLINT UNSIGNED NOT NULL,
  rate            DECIMAL(18,4) NOT NULL,
  amount          DECIMAL(18,4) NOT NULL,
  gst_rate        DECIMAL(5,2) DEFAULT 0,
  received_qty    DECIMAL(18,5) DEFAULT 0,
  CONSTRAINT fk_pol__po     FOREIGN KEY (po_id)     REFERENCES trx_purchase_order(id),
  CONSTRAINT fk_pol__yarn   FOREIGN KEY (yarn_id)   REFERENCES mst_yarn(id),
  CONSTRAINT fk_pol__fabric FOREIGN KEY (fabric_id) REFERENCES mst_fabric(id),
  CONSTRAINT fk_pol__trim   FOREIGN KEY (trim_id)   REFERENCES mst_trim(id),
  CONSTRAINT fk_pol__color  FOREIGN KEY (color_id)  REFERENCES mst_color(id),
  CONSTRAINT fk_pol__uom    FOREIGN KEY (uom_id)    REFERENCES cfg_uom(id)
) ENGINE=InnoDB COMMENT='Purchase order lines';

-- Warehouse / store master
CREATE TABLE mst_warehouse (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  unit_id         BIGINT UNSIGNED,
  warehouse_code  VARCHAR(20) NOT NULL,
  warehouse_name  VARCHAR(120) NOT NULL,
  warehouse_type  ENUM('RAW_MATERIAL','WIP','FINISHED_GOODS','TRIMS','REJECTION','BONDED') NOT NULL,
  is_active       TINYINT(1) NOT NULL DEFAULT 1,
  UNIQUE KEY uq_wh (company_id,warehouse_code),
  CONSTRAINT fk_wh__company FOREIGN KEY (company_id) REFERENCES mst_company(id),
  CONSTRAINT fk_wh__unit    FOREIGN KEY (unit_id)    REFERENCES mst_unit(id)
) ENGINE=InnoDB COMMENT='Warehouse / store master';

CREATE TABLE mst_warehouse_bin (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  warehouse_id    BIGINT UNSIGNED NOT NULL,
  bin_code        VARCHAR(30) NOT NULL,
  rack            VARCHAR(20),
  is_active       TINYINT(1) NOT NULL DEFAULT 1,
  UNIQUE KEY uq_bin (warehouse_id,bin_code),
  CONSTRAINT fk_bin__wh FOREIGN KEY (warehouse_id) REFERENCES mst_warehouse(id)
) ENGINE=InnoDB COMMENT='Bin locations';

-- Goods Receipt Note (against PO)
CREATE TABLE trx_grn (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  grn_no          VARCHAR(40) NOT NULL,
  grn_date        DATE NOT NULL,
  po_id           BIGINT UNSIGNED,
  supplier_id     BIGINT UNSIGNED NOT NULL,
  warehouse_id    BIGINT UNSIGNED NOT NULL,
  supplier_dc_no  VARCHAR(60),
  supplier_inv_no VARCHAR(60),
  vehicle_no      VARCHAR(30),
  status_id       INT UNSIGNED,
  remarks         VARCHAR(500),
  created_by      BIGINT UNSIGNED,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_grn (company_id,grn_no),
  CONSTRAINT fk_grn__company  FOREIGN KEY (company_id)   REFERENCES mst_company(id),
  CONSTRAINT fk_grn__po       FOREIGN KEY (po_id)        REFERENCES trx_purchase_order(id),
  CONSTRAINT fk_grn__supplier FOREIGN KEY (supplier_id)  REFERENCES mst_party(id),
  CONSTRAINT fk_grn__wh       FOREIGN KEY (warehouse_id) REFERENCES mst_warehouse(id),
  CONSTRAINT fk_grn__status   FOREIGN KEY (status_id)    REFERENCES cfg_status(id)
) ENGINE=InnoDB COMMENT='Goods receipt note header';

CREATE TABLE trx_grn_line (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  grn_id          BIGINT UNSIGNED NOT NULL,
  po_line_id      BIGINT UNSIGNED,
  material_type   ENUM('YARN','FABRIC','TRIM') NOT NULL,
  yarn_id         BIGINT UNSIGNED,
  fabric_id       BIGINT UNSIGNED,
  trim_id         BIGINT UNSIGNED,
  color_id        BIGINT UNSIGNED,
  batch_id        BIGINT UNSIGNED,        -- created lot
  received_qty    DECIMAL(18,5) NOT NULL,
  accepted_qty    DECIMAL(18,5) NOT NULL,
  rejected_qty    DECIMAL(18,5) DEFAULT 0,
  uom_id          SMALLINT UNSIGNED NOT NULL,
  bin_id          BIGINT UNSIGNED,
  CONSTRAINT fk_grnl__grn    FOREIGN KEY (grn_id)     REFERENCES trx_grn(id),
  CONSTRAINT fk_grnl__poline FOREIGN KEY (po_line_id) REFERENCES trx_purchase_order_line(id),
  CONSTRAINT fk_grnl__yarn   FOREIGN KEY (yarn_id)    REFERENCES mst_yarn(id),
  CONSTRAINT fk_grnl__fabric FOREIGN KEY (fabric_id)  REFERENCES mst_fabric(id),
  CONSTRAINT fk_grnl__trim   FOREIGN KEY (trim_id)    REFERENCES mst_trim(id),
  CONSTRAINT fk_grnl__color  FOREIGN KEY (color_id)   REFERENCES mst_color(id),
  CONSTRAINT fk_grnl__uom    FOREIGN KEY (uom_id)     REFERENCES cfg_uom(id),
  CONSTRAINT fk_grnl__bin    FOREIGN KEY (bin_id)     REFERENCES mst_warehouse_bin(id)
) ENGINE=InnoDB COMMENT='GRN lines';

-- Batch / Lot master (traceability)
CREATE TABLE mst_batch (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  batch_no        VARCHAR(50) NOT NULL,
  material_type   ENUM('YARN','FABRIC','TRIM','FINISHED') NOT NULL,
  yarn_id         BIGINT UNSIGNED,
  fabric_id       BIGINT UNSIGNED,
  trim_id         BIGINT UNSIGNED,
  supplier_id     BIGINT UNSIGNED,
  mfg_date        DATE,
  received_date   DATE,
  shade_lot       VARCHAR(40),            -- dye lot / shade batch
  remarks         VARCHAR(255),
  UNIQUE KEY uq_batch (company_id,batch_no),
  CONSTRAINT fk_batch__company  FOREIGN KEY (company_id)  REFERENCES mst_company(id),
  CONSTRAINT fk_batch__yarn     FOREIGN KEY (yarn_id)     REFERENCES mst_yarn(id),
  CONSTRAINT fk_batch__fabric   FOREIGN KEY (fabric_id)   REFERENCES mst_fabric(id),
  CONSTRAINT fk_batch__trim     FOREIGN KEY (trim_id)     REFERENCES mst_trim(id),
  CONSTRAINT fk_batch__supplier FOREIGN KEY (supplier_id) REFERENCES mst_party(id)
) ENGINE=InnoDB COMMENT='Batch / lot for traceability';

-- Stock ledger (append-only movement log — single source of truth)
CREATE TABLE trx_stock_ledger (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  warehouse_id    BIGINT UNSIGNED NOT NULL,
  bin_id          BIGINT UNSIGNED,
  material_type   ENUM('YARN','FABRIC','TRIM','FINISHED','WIP') NOT NULL,
  yarn_id         BIGINT UNSIGNED,
  fabric_id       BIGINT UNSIGNED,
  trim_id         BIGINT UNSIGNED,
  sku_id          BIGINT UNSIGNED,        -- for finished goods
  color_id        BIGINT UNSIGNED,
  batch_id        BIGINT UNSIGNED,
  txn_type        ENUM('GRN','ISSUE','RETURN','ADJUST','TRANSFER_IN','TRANSFER_OUT',
                       'PRODUCTION_IN','PRODUCTION_OUT','PACKING','DISPATCH') NOT NULL,
  ref_type        VARCHAR(40),            -- source doc type
  ref_id          BIGINT UNSIGNED,        -- source doc id
  qty_in          DECIMAL(18,5) DEFAULT 0,
  qty_out         DECIMAL(18,5) DEFAULT 0,
  uom_id          SMALLINT UNSIGNED NOT NULL,
  rate            DECIMAL(18,4) DEFAULT 0,
  txn_date        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by      BIGINT UNSIGNED,
  KEY ix_ledger_item (material_type,yarn_id,fabric_id,trim_id,sku_id),
  KEY ix_ledger_wh (warehouse_id,txn_date),
  KEY ix_ledger_ref (ref_type,ref_id),
  CONSTRAINT fk_led__company FOREIGN KEY (company_id)   REFERENCES mst_company(id),
  CONSTRAINT fk_led__wh      FOREIGN KEY (warehouse_id) REFERENCES mst_warehouse(id),
  CONSTRAINT fk_led__bin     FOREIGN KEY (bin_id)       REFERENCES mst_warehouse_bin(id),
  CONSTRAINT fk_led__yarn    FOREIGN KEY (yarn_id)      REFERENCES mst_yarn(id),
  CONSTRAINT fk_led__fabric  FOREIGN KEY (fabric_id)    REFERENCES mst_fabric(id),
  CONSTRAINT fk_led__trim    FOREIGN KEY (trim_id)      REFERENCES mst_trim(id),
  CONSTRAINT fk_led__sku     FOREIGN KEY (sku_id)       REFERENCES mst_style_sku(id),
  CONSTRAINT fk_led__color   FOREIGN KEY (color_id)     REFERENCES mst_color(id),
  CONSTRAINT fk_led__batch   FOREIGN KEY (batch_id)     REFERENCES mst_batch(id),
  CONSTRAINT fk_led__uom     FOREIGN KEY (uom_id)       REFERENCES cfg_uom(id)
) ENGINE=InnoDB COMMENT='Append-only stock movement ledger';

-- Material issue to production
CREATE TABLE trx_material_issue (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  issue_no        VARCHAR(40) NOT NULL,
  issue_date      DATE NOT NULL,
  warehouse_id    BIGINT UNSIGNED NOT NULL,
  prod_order_id   BIGINT UNSIGNED,        -- FK added after production table
  issued_to_unit  BIGINT UNSIGNED,
  status_id       INT UNSIGNED,
  remarks         VARCHAR(500),
  created_by      BIGINT UNSIGNED,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_issue (company_id,issue_no),
  CONSTRAINT fk_iss__company FOREIGN KEY (company_id)   REFERENCES mst_company(id),
  CONSTRAINT fk_iss__wh      FOREIGN KEY (warehouse_id) REFERENCES mst_warehouse(id),
  CONSTRAINT fk_iss__unit    FOREIGN KEY (issued_to_unit) REFERENCES mst_unit(id)
) ENGINE=InnoDB COMMENT='Material issue header';

CREATE TABLE trx_material_issue_line (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  issue_id        BIGINT UNSIGNED NOT NULL,
  material_type   ENUM('YARN','FABRIC','TRIM') NOT NULL,
  yarn_id         BIGINT UNSIGNED,
  fabric_id       BIGINT UNSIGNED,
  trim_id         BIGINT UNSIGNED,
  color_id        BIGINT UNSIGNED,
  batch_id        BIGINT UNSIGNED,
  issued_qty      DECIMAL(18,5) NOT NULL,
  uom_id          SMALLINT UNSIGNED NOT NULL,
  CONSTRAINT fk_issl__issue  FOREIGN KEY (issue_id)  REFERENCES trx_material_issue(id),
  CONSTRAINT fk_issl__yarn   FOREIGN KEY (yarn_id)   REFERENCES mst_yarn(id),
  CONSTRAINT fk_issl__fabric FOREIGN KEY (fabric_id) REFERENCES mst_fabric(id),
  CONSTRAINT fk_issl__trim   FOREIGN KEY (trim_id)   REFERENCES mst_trim(id),
  CONSTRAINT fk_issl__color  FOREIGN KEY (color_id)  REFERENCES mst_color(id),
  CONSTRAINT fk_issl__batch  FOREIGN KEY (batch_id)  REFERENCES mst_batch(id),
  CONSTRAINT fk_issl__uom    FOREIGN KEY (uom_id)    REFERENCES cfg_uom(id)
) ENGINE=InnoDB COMMENT='Material issue lines';

-- Barcode / QR registry (labels for cartons, bundles, rolls, SKUs)
CREATE TABLE trx_barcode (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  barcode_value   VARCHAR(80) NOT NULL,
  code_type       ENUM('BARCODE','QR') NOT NULL DEFAULT 'BARCODE',
  entity_type     ENUM('SKU','BUNDLE','CARTON','ROLL','BATCH','GARMENT') NOT NULL,
  entity_id       BIGINT UNSIGNED NOT NULL,
  printed_at      DATETIME,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_barcode (company_id,barcode_value),
  KEY ix_barcode_entity (entity_type,entity_id),
  CONSTRAINT fk_barcode__company FOREIGN KEY (company_id) REFERENCES mst_company(id)
) ENGINE=InnoDB COMMENT='Barcode / QR registry';
