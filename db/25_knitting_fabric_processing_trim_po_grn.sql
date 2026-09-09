-- =====================================================================
-- 25. KNITTING, FABRIC PROCESSING, AND TRIM PO & GRN MODULES
-- =====================================================================

-- -------------------------------------------------------------
-- 1. KNITTING MODULE (Machine allocations omitted per instructions)
-- -------------------------------------------------------------

CREATE TABLE IF NOT EXISTS trx_knitting_order (
  id                BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id        BIGINT UNSIGNED NOT NULL,
  kwo_no            VARCHAR(50) NOT NULL,
  kwo_date          DATE NOT NULL,
  io_no             VARCHAR(60) NOT NULL,
  customer_po_no    VARCHAR(60) NULL,
  style_id          BIGINT UNSIGNED NULL,
  sub_process       ENUM('KNITTING', 'WINDING', 'TWISTING', 'YARN_DYEING', 'COLLAR_KNITTING') NOT NULL DEFAULT 'KNITTING',
  vendor_id         BIGINT UNSIGNED NULL,
  fabric_id         BIGINT UNSIGNED NULL,
  dia               VARCHAR(40) NULL,
  gsm               VARCHAR(40) NULL,
  gauge             VARCHAR(40) NULL,
  loop_length       VARCHAR(40) NULL,
  planned_fabric_kg DECIMAL(14,3) NOT NULL DEFAULT 0,
  planned_yarn_kg   DECIMAL(14,3) NOT NULL DEFAULT 0,
  yarn_lot_no       VARCHAR(80) NULL,
  status            ENUM('DRAFT', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED') NOT NULL DEFAULT 'DRAFT',
  remarks           TEXT NULL,
  created_by        BIGINT UNSIGNED NULL,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_kwo_no (company_id, kwo_no),
  KEY ix_kwo_io (io_no),
  KEY ix_kwo_style (style_id),
  CONSTRAINT fk_kwo__company FOREIGN KEY (company_id) REFERENCES mst_company(id),
  CONSTRAINT fk_kwo__style   FOREIGN KEY (style_id)   REFERENCES mst_style(id),
  CONSTRAINT fk_kwo__vendor  FOREIGN KEY (vendor_id)  REFERENCES mst_party(id),
  CONSTRAINT fk_kwo__fabric  FOREIGN KEY (fabric_id)  REFERENCES mst_fabric(id)
) ENGINE=InnoDB COMMENT='Knitting Work Orders (KWO)';

CREATE TABLE IF NOT EXISTS trx_knitting_yarn_issue (
  id                BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id        BIGINT UNSIGNED NOT NULL,
  kwo_id            BIGINT UNSIGNED NOT NULL,
  issue_no          VARCHAR(50) NOT NULL,
  issue_date        DATE NOT NULL,
  yarn_id           BIGINT UNSIGNED NOT NULL,
  yarn_lot_no       VARCHAR(80) NULL,
  bags_cones        INT NOT NULL DEFAULT 0,
  issued_weight_kg  DECIMAL(14,3) NOT NULL DEFAULT 0,
  remarks           TEXT NULL,
  created_by        BIGINT UNSIGNED NULL,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_kyi_kwo (kwo_id),
  CONSTRAINT fk_kyi__kwo  FOREIGN KEY (kwo_id)  REFERENCES trx_knitting_order(id) ON DELETE CASCADE,
  CONSTRAINT fk_kyi__yarn FOREIGN KEY (yarn_id) REFERENCES mst_yarn(id)
) ENGINE=InnoDB COMMENT='Yarn issue against Knitting Work Order';

CREATE TABLE IF NOT EXISTS trx_knitting_roll_output (
  id                BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id        BIGINT UNSIGNED NOT NULL,
  kwo_id            BIGINT UNSIGNED NOT NULL,
  roll_no           VARCHAR(60) NOT NULL,
  lot_no            VARCHAR(80) NOT NULL,
  io_no             VARCHAR(60) NOT NULL,
  style_id          BIGINT UNSIGNED NULL,
  fabric_id         BIGINT UNSIGNED NULL,
  production_date   DATE NOT NULL,
  dia               VARCHAR(40) NULL,
  gsm               VARCHAR(40) NULL,
  meters            DECIMAL(14,2) NOT NULL DEFAULT 0,
  weight_kg         DECIMAL(14,3) NOT NULL DEFAULT 0,
  qc_status         ENUM('ACCEPTED', 'HOLD', 'REJECTED') NOT NULL DEFAULT 'ACCEPTED',
  defect_points     INT NOT NULL DEFAULT 0,
  rejection_reason  VARCHAR(255) NULL,
  is_dispatched_to_process TINYINT(1) NOT NULL DEFAULT 0,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_kro_kwo (kwo_id),
  KEY ix_kro_io (io_no),
  KEY ix_kro_lot (lot_no),
  KEY ix_kro_roll (roll_no),
  CONSTRAINT fk_kro__kwo    FOREIGN KEY (kwo_id)    REFERENCES trx_knitting_order(id) ON DELETE CASCADE,
  CONSTRAINT fk_kro__style  FOREIGN KEY (style_id)  REFERENCES mst_style(id),
  CONSTRAINT fk_kro__fabric FOREIGN KEY (fabric_id) REFERENCES mst_fabric(id)
) ENGINE=InnoDB COMMENT='Grey fabric rolls produced from Knitting';


-- -------------------------------------------------------------
-- 2. FABRIC PROCESSING MODULE (Dynamic Sub-processes)
-- -------------------------------------------------------------

CREATE TABLE IF NOT EXISTS trx_fabric_process_order (
  id                BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id        BIGINT UNSIGNED NOT NULL,
  fpo_no            VARCHAR(50) NOT NULL,
  fpo_date          DATE NOT NULL,
  io_no             VARCHAR(60) NOT NULL,
  customer_po_no    VARCHAR(60) NULL,
  style_id          BIGINT UNSIGNED NULL,
  fabric_id         BIGINT UNSIGNED NULL,
  sub_process       ENUM('DYEING', 'COMPACTING', 'HEAT_SETTING', 'WASHING', 'PRINTING', 'RELAX_DRYER', 'TUMBLE_DRYER', 'STENTERING', 'COMMON_PROCESS', 'BITTING_SLITTING') NOT NULL DEFAULT 'DYEING',
  vendor_id         BIGINT UNSIGNED NULL,
  shade_code        VARCHAR(80) NULL,
  color_name        VARCHAR(80) NULL,
  target_dia        VARCHAR(40) NULL,
  target_gsm        VARCHAR(40) NULL,
  total_input_rolls INT NOT NULL DEFAULT 0,
  input_weight_kg   DECIMAL(14,3) NOT NULL DEFAULT 0,
  output_weight_kg  DECIMAL(14,3) NOT NULL DEFAULT 0,
  process_loss_kg   DECIMAL(14,3) NOT NULL DEFAULT 0,
  process_loss_pct  DECIMAL(6,2) NOT NULL DEFAULT 0,
  status            ENUM('DRAFT', 'DISPATCHED', 'IN_PROCESS', 'COMPLETED', 'CANCELLED') NOT NULL DEFAULT 'DRAFT',
  remarks           TEXT NULL,
  created_by        BIGINT UNSIGNED NULL,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_fpo_no (company_id, fpo_no),
  KEY ix_fpo_io (io_no),
  KEY ix_fpo_style (style_id),
  CONSTRAINT fk_fpo__company FOREIGN KEY (company_id) REFERENCES mst_company(id),
  CONSTRAINT fk_fpo__style   FOREIGN KEY (style_id)   REFERENCES mst_style(id),
  CONSTRAINT fk_fpo__vendor  FOREIGN KEY (vendor_id)  REFERENCES mst_party(id),
  CONSTRAINT fk_fpo__fabric  FOREIGN KEY (fabric_id)  REFERENCES mst_fabric(id)
) ENGINE=InnoDB COMMENT='Fabric Processing Work Order';

CREATE TABLE IF NOT EXISTS trx_fabric_process_roll_in (
  id                BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  fpo_id            BIGINT UNSIGNED NOT NULL,
  knitting_roll_id  BIGINT UNSIGNED NULL,
  roll_no           VARCHAR(60) NOT NULL,
  lot_no            VARCHAR(80) NULL,
  weight_kg         DECIMAL(14,3) NOT NULL DEFAULT 0,
  meters            DECIMAL(14,2) NOT NULL DEFAULT 0,
  KEY ix_fpri_fpo (fpo_id),
  CONSTRAINT fk_fpri__fpo FOREIGN KEY (fpo_id) REFERENCES trx_fabric_process_order(id) ON DELETE CASCADE,
  CONSTRAINT fk_fpri__kro FOREIGN KEY (knitting_roll_id) REFERENCES trx_knitting_roll_output(id) ON DELETE SET NULL
) ENGINE=InnoDB COMMENT='Input rolls dispatched to fabric processing';

CREATE TABLE IF NOT EXISTS trx_fabric_process_roll_out (
  id                    BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id            BIGINT UNSIGNED NOT NULL,
  fpo_id                BIGINT UNSIGNED NOT NULL,
  roll_no               VARCHAR(60) NOT NULL,
  lot_no                VARCHAR(80) NOT NULL,
  io_no                 VARCHAR(60) NOT NULL,
  style_id              BIGINT UNSIGNED NULL,
  fabric_id             BIGINT UNSIGNED NULL,
  finish_date           DATE NOT NULL,
  dia                   VARCHAR(40) NULL,
  gsm                   VARCHAR(40) NULL,
  meters                DECIMAL(14,2) NOT NULL DEFAULT 0,
  weight_kg             DECIMAL(14,3) NOT NULL DEFAULT 0,
  shrinkage_length_pct  DECIMAL(5,2) NOT NULL DEFAULT 0,
  shrinkage_width_pct   DECIMAL(5,2) NOT NULL DEFAULT 0,
  qc_status             ENUM('ACCEPTED', 'HOLD', 'REJECTED') NOT NULL DEFAULT 'ACCEPTED',
  shade_match           VARCHAR(50) NOT NULL DEFAULT 'PASS',
  defect_points         INT NOT NULL DEFAULT 0,
  remarks               TEXT NULL,
  is_issued_to_cutting  TINYINT(1) NOT NULL DEFAULT 0,
  created_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_fpro_fpo (fpo_id),
  KEY ix_fpro_io (io_no),
  KEY ix_fpro_lot (lot_no),
  KEY ix_fpro_roll (roll_no),
  CONSTRAINT fk_fpro__fpo    FOREIGN KEY (fpo_id)    REFERENCES trx_fabric_process_order(id) ON DELETE CASCADE,
  CONSTRAINT fk_fpro__style  FOREIGN KEY (style_id)  REFERENCES mst_style(id),
  CONSTRAINT fk_fpro__fabric FOREIGN KEY (fabric_id) REFERENCES mst_fabric(id)
) ENGINE=InnoDB COMMENT='Processed output rolls ready for cutting';


-- -------------------------------------------------------------
-- 3. TRIM PURCHASE ORDER (PO) & TRIM GRN MODULE
-- -------------------------------------------------------------

CREATE TABLE IF NOT EXISTS trx_trim_po (
  id                BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id        BIGINT UNSIGNED NOT NULL,
  po_no             VARCHAR(50) NOT NULL,
  po_date           DATE NOT NULL,
  io_no             VARCHAR(60) NOT NULL,
  style_id          BIGINT UNSIGNED NULL,
  supplier_id       BIGINT UNSIGNED NOT NULL,
  delivery_date     DATE NULL,
  payment_terms     VARCHAR(150) NULL,
  total_amount      DECIMAL(18,4) NOT NULL DEFAULT 0,
  tax_amount        DECIMAL(18,4) NOT NULL DEFAULT 0,
  grand_total       DECIMAL(18,4) NOT NULL DEFAULT 0,
  status            ENUM('DRAFT', 'APPROVED', 'PARTIAL', 'CLOSED', 'CANCELLED') NOT NULL DEFAULT 'APPROVED',
  remarks           TEXT NULL,
  created_by        BIGINT UNSIGNED NULL,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_tpo_no (company_id, po_no),
  KEY ix_tpo_io (io_no),
  KEY ix_tpo_style (style_id),
  KEY ix_tpo_supp (supplier_id),
  CONSTRAINT fk_tpo__company  FOREIGN KEY (company_id)  REFERENCES mst_company(id),
  CONSTRAINT fk_tpo__style    FOREIGN KEY (style_id)    REFERENCES mst_style(id),
  CONSTRAINT fk_tpo__supplier FOREIGN KEY (supplier_id) REFERENCES mst_party(id)
) ENGINE=InnoDB COMMENT='Trim Purchase Orders (No stock effect)';

CREATE TABLE IF NOT EXISTS trx_trim_po_line (
  id                BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  po_id             BIGINT UNSIGNED NOT NULL,
  trim_id           BIGINT UNSIGNED NOT NULL,
  specification     VARCHAR(255) NULL,
  color_name        VARCHAR(80) NULL,
  trim_size         VARCHAR(50) NULL,
  order_qty         DECIMAL(18,4) NOT NULL,
  uom_id            SMALLINT UNSIGNED NOT NULL,
  rate              DECIMAL(18,4) NOT NULL DEFAULT 0,
  amount            DECIMAL(18,4) NOT NULL DEFAULT 0,
  gst_rate          DECIMAL(5,2) NOT NULL DEFAULT 0,
  tax_amount        DECIMAL(18,4) NOT NULL DEFAULT 0,
  net_amount        DECIMAL(18,4) NOT NULL DEFAULT 0,
  received_qty      DECIMAL(18,4) NOT NULL DEFAULT 0,
  KEY ix_tpol_po (po_id),
  KEY ix_tpol_trim (trim_id),
  CONSTRAINT fk_tpol__po   FOREIGN KEY (po_id)   REFERENCES trx_trim_po(id) ON DELETE CASCADE,
  CONSTRAINT fk_tpol__trim FOREIGN KEY (trim_id) REFERENCES mst_trim(id),
  CONSTRAINT fk_tpol__uom  FOREIGN KEY (uom_id)  REFERENCES cfg_uom(id)
) ENGINE=InnoDB COMMENT='Trim Purchase Order Lines';

CREATE TABLE IF NOT EXISTS trx_trim_grn (
  id                BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id        BIGINT UNSIGNED NOT NULL,
  grn_no            VARCHAR(50) NOT NULL,
  grn_date          DATE NOT NULL,
  po_id             BIGINT UNSIGNED NULL,
  io_no             VARCHAR(60) NOT NULL,
  style_id          BIGINT UNSIGNED NULL,
  supplier_id       BIGINT UNSIGNED NOT NULL,
  warehouse_id      BIGINT UNSIGNED NOT NULL,
  supplier_inv_no   VARCHAR(80) NULL,
  supplier_dc_no    VARCHAR(80) NULL,
  vehicle_no        VARCHAR(40) NULL,
  status            ENUM('DRAFT', 'POSTED', 'CANCELLED') NOT NULL DEFAULT 'POSTED',
  remarks           TEXT NULL,
  created_by        BIGINT UNSIGNED NULL,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_tgrn_no (company_id, grn_no),
  KEY ix_tgrn_io (io_no),
  KEY ix_tgrn_style (style_id),
  KEY ix_tgrn_po (po_id),
  CONSTRAINT fk_tgrn__company   FOREIGN KEY (company_id)   REFERENCES mst_company(id),
  CONSTRAINT fk_tgrn__po        FOREIGN KEY (po_id)        REFERENCES trx_trim_po(id),
  CONSTRAINT fk_tgrn__style     FOREIGN KEY (style_id)     REFERENCES mst_style(id),
  CONSTRAINT fk_tgrn__supplier  FOREIGN KEY (supplier_id)  REFERENCES mst_party(id),
  CONSTRAINT fk_tgrn__warehouse FOREIGN KEY (warehouse_id) REFERENCES mst_warehouse(id)
) ENGINE=InnoDB COMMENT='Trim Goods Receipt Note Header';

CREATE TABLE IF NOT EXISTS trx_trim_grn_line (
  id                BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  grn_id            BIGINT UNSIGNED NOT NULL,
  po_line_id        BIGINT UNSIGNED NULL,
  trim_id           BIGINT UNSIGNED NOT NULL,
  specification     VARCHAR(255) NULL,
  color_name        VARCHAR(80) NULL,
  trim_size         VARCHAR(50) NULL,
  uom_id            SMALLINT UNSIGNED NOT NULL,
  po_qty            DECIMAL(18,4) NOT NULL DEFAULT 0,
  received_qty      DECIMAL(18,4) NOT NULL DEFAULT 0,
  accepted_qty      DECIMAL(18,4) NOT NULL DEFAULT 0,
  rejected_qty      DECIMAL(18,4) NOT NULL DEFAULT 0,
  hold_qty          DECIMAL(18,4) NOT NULL DEFAULT 0,
  supplier_lot_no   VARCHAR(80) NULL,
  internal_lot_no   VARCHAR(80) NOT NULL,
  bin_location      VARCHAR(50) NULL,
  qc_status         ENUM('ACCEPTED', 'PARTIAL', 'REJECTED', 'HOLD') NOT NULL DEFAULT 'ACCEPTED',
  rejection_reason  VARCHAR(255) NULL,
  KEY ix_tgrnl_grn (grn_id),
  KEY ix_tgrnl_trim (trim_id),
  CONSTRAINT fk_tgrnl__grn    FOREIGN KEY (grn_id)     REFERENCES trx_trim_grn(id) ON DELETE CASCADE,
  CONSTRAINT fk_tgrnl__poline FOREIGN KEY (po_line_id) REFERENCES trx_trim_po_line(id),
  CONSTRAINT fk_tgrnl__trim   FOREIGN KEY (trim_id)    REFERENCES mst_trim(id),
  CONSTRAINT fk_tgrnl__uom    FOREIGN KEY (uom_id)     REFERENCES cfg_uom(id)
) ENGINE=InnoDB COMMENT='Trim GRN lines with QC split';

CREATE TABLE IF NOT EXISTS trx_trim_stock (
  id                BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id        BIGINT UNSIGNED NOT NULL,
  warehouse_id      BIGINT UNSIGNED NOT NULL,
  trim_id           BIGINT UNSIGNED NOT NULL,
  color_name        VARCHAR(80) NULL,
  trim_size         VARCHAR(50) NULL,
  internal_lot_no   VARCHAR(80) NOT NULL,
  bin_location      VARCHAR(50) NULL,
  stock_qty         DECIMAL(18,4) NOT NULL DEFAULT 0,
  allocated_qty     DECIMAL(18,4) NOT NULL DEFAULT 0,
  uom_id            SMALLINT UNSIGNED NOT NULL,
  updated_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_trim_stock (company_id, warehouse_id, trim_id, internal_lot_no),
  KEY ix_ts_trim (trim_id),
  CONSTRAINT fk_ts__company   FOREIGN KEY (company_id)   REFERENCES mst_company(id),
  CONSTRAINT fk_ts__warehouse FOREIGN KEY (warehouse_id) REFERENCES mst_warehouse(id),
  CONSTRAINT fk_ts__trim      FOREIGN KEY (trim_id)      REFERENCES mst_trim(id),
  CONSTRAINT fk_ts__uom       FOREIGN KEY (uom_id)       REFERENCES cfg_uom(id)
) ENGINE=InnoDB COMMENT='Trim inventory balance (updated only by accepted GRN qty)';
