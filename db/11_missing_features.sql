-- =====================================================================
-- 11. MISSING FEATURES — Full Production-Grade Migration
--     Adds: rework/shortage tracking, daily production plan,
--     sewing line management, job work challan/receipt/in,
--     purchase return, supplier bill, stock transfer, FG receipt,
--     actual production costing, gate→GRN link
-- =====================================================================

-- =============================================================
-- A. REWORK & SHORTAGE on all process tables  (Production §18)
-- =============================================================

ALTER TABLE trx_cutting
  ADD COLUMN rework_qty   INT UNSIGNED DEFAULT 0 AFTER total_pieces,
  ADD COLUMN shortage_qty INT UNSIGNED DEFAULT 0 AFTER rework_qty;

ALTER TABLE trx_printing
  ADD COLUMN rework_qty   INT UNSIGNED DEFAULT 0 AFTER rejected_qty,
  ADD COLUMN shortage_qty INT UNSIGNED DEFAULT 0 AFTER rework_qty;

ALTER TABLE trx_embroidery
  ADD COLUMN rework_qty   INT UNSIGNED DEFAULT 0 AFTER rejected_qty,
  ADD COLUMN shortage_qty INT UNSIGNED DEFAULT 0 AFTER rework_qty;

ALTER TABLE trx_washing
  ADD COLUMN rework_qty   INT UNSIGNED DEFAULT 0 AFTER rejected_qty,
  ADD COLUMN shortage_qty INT UNSIGNED DEFAULT 0 AFTER rework_qty;

ALTER TABLE trx_stitching
  ADD COLUMN rework_qty   INT UNSIGNED DEFAULT 0 AFTER rejected_qty,
  ADD COLUMN shortage_qty INT UNSIGNED DEFAULT 0 AFTER rework_qty;

ALTER TABLE trx_finishing
  ADD COLUMN rework_qty   INT UNSIGNED DEFAULT 0 AFTER rejected_qty,
  ADD COLUMN shortage_qty INT UNSIGNED DEFAULT 0 AFTER rework_qty;

ALTER TABLE trx_process_transaction
  ADD COLUMN rework_qty   INT UNSIGNED DEFAULT 0 AFTER rejected_qty,
  ADD COLUMN shortage_qty INT UNSIGNED DEFAULT 0 AFTER rework_qty;


-- =============================================================
-- B. GATE ENTRY → GRN FK linkage  (Po & Purchase doc)
-- =============================================================

ALTER TABLE trx_grn
  ADD COLUMN gate_inward_id BIGINT UNSIGNED AFTER supplier_id,
  ADD CONSTRAINT fk_grn__gate FOREIGN KEY (gate_inward_id) REFERENCES trx_gate_inward(id);


-- =============================================================
-- C. CONFIG MASTERS for Daily Production Plan
-- =============================================================

CREATE TABLE cfg_sewing_line (
  id            INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id    BIGINT UNSIGNED NOT NULL,
  line_code     VARCHAR(20)  NOT NULL,
  line_name     VARCHAR(80)  NOT NULL,
  unit_id       BIGINT UNSIGNED,
  capacity_pcs  INT UNSIGNED DEFAULT 0,     -- daily capacity
  manpower      INT UNSIGNED DEFAULT 0,
  working_hours DECIMAL(4,1) DEFAULT 8.0,
  is_active     TINYINT(1)   NOT NULL DEFAULT 1,
  UNIQUE KEY uq_sewing_line (company_id, line_code),
  CONSTRAINT fk_sewline__company FOREIGN KEY (company_id) REFERENCES mst_company(id),
  CONSTRAINT fk_sewline__unit    FOREIGN KEY (unit_id)    REFERENCES mst_unit(id)
) ENGINE=InnoDB COMMENT='Sewing line master with capacity';

CREATE TABLE cfg_shift (
  id            INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id    BIGINT UNSIGNED NOT NULL,
  shift_code    VARCHAR(20) NOT NULL,
  shift_name    VARCHAR(80) NOT NULL,
  start_time    TIME,
  end_time      TIME,
  break_minutes INT UNSIGNED DEFAULT 0,
  is_active     TINYINT(1)  NOT NULL DEFAULT 1,
  UNIQUE KEY uq_shift (company_id, shift_code),
  CONSTRAINT fk_shift__company FOREIGN KEY (company_id) REFERENCES mst_company(id)
) ENGINE=InnoDB COMMENT='Shift master (General, Night, etc.)';

CREATE TABLE cfg_delay_reason (
  id            INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id    BIGINT UNSIGNED NOT NULL,
  reason_code   VARCHAR(30) NOT NULL,
  reason_name   VARCHAR(120) NOT NULL,
  category      ENUM('MACHINE','MATERIAL','MANPOWER','METHOD','QUALITY','OTHER') DEFAULT 'OTHER',
  is_active     TINYINT(1)  NOT NULL DEFAULT 1,
  UNIQUE KEY uq_delay_reason (company_id, reason_code),
  CONSTRAINT fk_delay__company FOREIGN KEY (company_id) REFERENCES mst_company(id)
) ENGINE=InnoDB COMMENT='Production delay reason master';

CREATE TABLE cfg_sewing_operation_master (
  id             INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id     BIGINT UNSIGNED NOT NULL,
  operation_code VARCHAR(30) NOT NULL,
  operation_name VARCHAR(120) NOT NULL,
  smv            DECIMAL(8,3) DEFAULT 0,   -- standard minute value
  sort_order     INT DEFAULT 0,
  is_active      TINYINT(1) NOT NULL DEFAULT 1,
  UNIQUE KEY uq_sew_op (company_id, operation_code),
  CONSTRAINT fk_sewop__company FOREIGN KEY (company_id) REFERENCES mst_company(id)
) ENGINE=InnoDB COMMENT='Sewing operation master (Shoulder, Side Seam, Sleeve, etc.)';


-- =============================================================
-- D. DAILY PRODUCTION PLAN  (Daily Production Plan.docx)
-- =============================================================

CREATE TABLE trx_daily_production_plan (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  plan_no         VARCHAR(40) NOT NULL,
  plan_date       DATE NOT NULL,
  unit_id         BIGINT UNSIGNED,
  line_id         INT UNSIGNED,
  shift_id        INT UNSIGNED,
  supervisor_id   BIGINT UNSIGNED,           -- mst_user
  prod_order_id   BIGINT UNSIGNED,
  style_id        BIGINT UNSIGNED,
  planned_qty     INT UNSIGNED DEFAULT 0,
  previous_output INT UNSIGNED DEFAULT 0,    -- cumulative before today
  balance_qty     INT UNSIGNED DEFAULT 0,    -- remaining
  today_target    INT UNSIGNED DEFAULT 0,
  smv             DECIMAL(8,3),              -- style SMV
  line_efficiency DECIMAL(6,2),              -- target efficiency %
  capacity_pcs    INT UNSIGNED DEFAULT 0,    -- calculated capacity
  status          ENUM('DRAFT','PLANNED','IN_PROGRESS','COMPLETED','CANCELLED') DEFAULT 'DRAFT',
  remarks         VARCHAR(500),
  created_by      BIGINT UNSIGNED,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by      BIGINT UNSIGNED,
  updated_at      DATETIME ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_daily_plan (company_id, plan_no),
  KEY ix_dplan_date (plan_date),
  CONSTRAINT fk_dplan__company    FOREIGN KEY (company_id)    REFERENCES mst_company(id),
  CONSTRAINT fk_dplan__unit       FOREIGN KEY (unit_id)       REFERENCES mst_unit(id),
  CONSTRAINT fk_dplan__line       FOREIGN KEY (line_id)       REFERENCES cfg_sewing_line(id),
  CONSTRAINT fk_dplan__shift      FOREIGN KEY (shift_id)      REFERENCES cfg_shift(id),
  CONSTRAINT fk_dplan__supervisor FOREIGN KEY (supervisor_id) REFERENCES mst_user(id),
  CONSTRAINT fk_dplan__prod       FOREIGN KEY (prod_order_id) REFERENCES trx_production_order(id),
  CONSTRAINT fk_dplan__style      FOREIGN KEY (style_id)      REFERENCES mst_style(id)
) ENGINE=InnoDB COMMENT='Daily production plan header (shift/line level)';

-- Size × Colour grid for daily plan
CREATE TABLE trx_daily_plan_size_color (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  daily_plan_id   BIGINT UNSIGNED NOT NULL,
  color_id        BIGINT UNSIGNED NOT NULL,
  sku_id          BIGINT UNSIGNED NOT NULL,   -- style×color×size
  plan_qty        INT UNSIGNED DEFAULT 0,
  CONSTRAINT fk_dpsc__plan  FOREIGN KEY (daily_plan_id) REFERENCES trx_daily_production_plan(id),
  CONSTRAINT fk_dpsc__color FOREIGN KEY (color_id)      REFERENCES mst_color(id),
  CONSTRAINT fk_dpsc__sku   FOREIGN KEY (sku_id)        REFERENCES mst_style_sku(id)
) ENGINE=InnoDB COMMENT='Daily plan size×colour breakdown';

-- Operation-wise target/actual per daily plan
CREATE TABLE trx_daily_plan_operation (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  daily_plan_id   BIGINT UNSIGNED NOT NULL,
  stage_id        INT UNSIGNED,              -- cfg_process_stage
  line_id         INT UNSIGNED,              -- cfg_sewing_line
  target_qty      INT UNSIGNED DEFAULT 0,
  actual_qty      INT UNSIGNED DEFAULT 0,
  balance_qty     INT UNSIGNED DEFAULT 0,
  CONSTRAINT fk_dpop__plan  FOREIGN KEY (daily_plan_id) REFERENCES trx_daily_production_plan(id),
  CONSTRAINT fk_dpop__stage FOREIGN KEY (stage_id)      REFERENCES cfg_process_stage(id),
  CONSTRAINT fk_dpop__line  FOREIGN KEY (line_id)       REFERENCES cfg_sewing_line(id)
) ENGINE=InnoDB COMMENT='Daily plan operation-wise target vs actual';

-- Daily output entry (end-of-day actuals)
CREATE TABLE trx_daily_output (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  output_no       VARCHAR(40) NOT NULL,
  output_date     DATE NOT NULL,
  daily_plan_id   BIGINT UNSIGNED,
  prod_order_id   BIGINT UNSIGNED,
  style_id        BIGINT UNSIGNED,
  line_id         INT UNSIGNED,
  shift_id        INT UNSIGNED,
  stage_id        INT UNSIGNED,              -- which operation
  target_qty      INT UNSIGNED DEFAULT 0,
  actual_good     INT UNSIGNED DEFAULT 0,
  reject_qty      INT UNSIGNED DEFAULT 0,
  rework_qty      INT UNSIGNED DEFAULT 0,
  total_output    INT UNSIGNED DEFAULT 0,
  achievement_pct DECIMAL(6,2) DEFAULT 0,
  delay_reason_id INT UNSIGNED,
  status          ENUM('DRAFT','SUBMITTED','APPROVED') DEFAULT 'DRAFT',
  remarks         VARCHAR(500),
  created_by      BIGINT UNSIGNED,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by      BIGINT UNSIGNED,
  updated_at      DATETIME ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_daily_output (company_id, output_no),
  KEY ix_dout_date (output_date),
  CONSTRAINT fk_dout__company FOREIGN KEY (company_id)      REFERENCES mst_company(id),
  CONSTRAINT fk_dout__dplan   FOREIGN KEY (daily_plan_id)   REFERENCES trx_daily_production_plan(id),
  CONSTRAINT fk_dout__prod    FOREIGN KEY (prod_order_id)   REFERENCES trx_production_order(id),
  CONSTRAINT fk_dout__style   FOREIGN KEY (style_id)        REFERENCES mst_style(id),
  CONSTRAINT fk_dout__line    FOREIGN KEY (line_id)         REFERENCES cfg_sewing_line(id),
  CONSTRAINT fk_dout__shift   FOREIGN KEY (shift_id)        REFERENCES cfg_shift(id),
  CONSTRAINT fk_dout__stage   FOREIGN KEY (stage_id)        REFERENCES cfg_process_stage(id),
  CONSTRAINT fk_dout__delay   FOREIGN KEY (delay_reason_id) REFERENCES cfg_delay_reason(id)
) ENGINE=InnoDB COMMENT='Daily output actuals entry (Good/Reject/Rework)';


-- =============================================================
-- E. SEWING LINE ALLOCATION + OPERATION TRACKING  (Production §16-17)
-- =============================================================

CREATE TABLE trx_line_allocation (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  allocation_no   VARCHAR(40) NOT NULL,
  allocation_date DATE NOT NULL,
  prod_order_id   BIGINT UNSIGNED NOT NULL,
  style_id        BIGINT UNSIGNED,
  color_id        BIGINT UNSIGNED,
  line_id         INT UNSIGNED NOT NULL,
  allocated_qty   INT UNSIGNED NOT NULL,
  start_date      DATE,
  end_date        DATE,
  status_id       INT UNSIGNED,
  remarks         VARCHAR(500),
  created_by      BIGINT UNSIGNED,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_line_alloc (company_id, allocation_no),
  KEY ix_lalloc_prod (prod_order_id),
  CONSTRAINT fk_lalloc__company FOREIGN KEY (company_id)    REFERENCES mst_company(id),
  CONSTRAINT fk_lalloc__prod    FOREIGN KEY (prod_order_id) REFERENCES trx_production_order(id),
  CONSTRAINT fk_lalloc__style   FOREIGN KEY (style_id)      REFERENCES mst_style(id),
  CONSTRAINT fk_lalloc__color   FOREIGN KEY (color_id)      REFERENCES mst_color(id),
  CONSTRAINT fk_lalloc__line    FOREIGN KEY (line_id)       REFERENCES cfg_sewing_line(id),
  CONSTRAINT fk_lalloc__status  FOREIGN KEY (status_id)     REFERENCES cfg_status(id)
) ENGINE=InnoDB COMMENT='Sewing line allocation (style→line→qty)';

CREATE TABLE trx_sewing_operation (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  operation_no    VARCHAR(40) NOT NULL,
  operation_date  DATE NOT NULL,
  prod_order_id   BIGINT UNSIGNED NOT NULL,
  line_id         INT UNSIGNED,
  operation_id    INT UNSIGNED NOT NULL,      -- cfg_sewing_operation_master
  plan_qty        INT UNSIGNED DEFAULT 0,
  actual_qty      INT UNSIGNED DEFAULT 0,
  rework_qty      INT UNSIGNED DEFAULT 0,
  rejected_qty    INT UNSIGNED DEFAULT 0,
  wip_qty         INT UNSIGNED DEFAULT 0,     -- plan - actual
  operator_name   VARCHAR(80),
  status_id       INT UNSIGNED,
  created_by      BIGINT UNSIGNED,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_sew_op_txn (company_id, operation_no),
  KEY ix_sewop_prod (prod_order_id, operation_id),
  CONSTRAINT fk_sewoptxn__company FOREIGN KEY (company_id)    REFERENCES mst_company(id),
  CONSTRAINT fk_sewoptxn__prod    FOREIGN KEY (prod_order_id) REFERENCES trx_production_order(id),
  CONSTRAINT fk_sewoptxn__line    FOREIGN KEY (line_id)       REFERENCES cfg_sewing_line(id),
  CONSTRAINT fk_sewoptxn__op      FOREIGN KEY (operation_id)  REFERENCES cfg_sewing_operation_master(id),
  CONSTRAINT fk_sewoptxn__status  FOREIGN KEY (status_id)     REFERENCES cfg_status(id)
) ENGINE=InnoDB COMMENT='Sewing operation-level output tracking (per operation)';


-- =============================================================
-- F. JOB WORK CHALLAN / RECEIPT / IN / INVOICE  (Production §19-21, §34)
-- =============================================================

-- Job Work Challan (issue to external vendor)
CREATE TABLE trx_jobwork_challan (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  challan_no      VARCHAR(40) NOT NULL,
  challan_date    DATE NOT NULL,
  prod_order_id   BIGINT UNSIGNED,
  vendor_id       BIGINT UNSIGNED NOT NULL,   -- job worker
  stage_id        INT UNSIGNED,               -- which process
  gate_outward_id BIGINT UNSIGNED,
  total_qty       INT UNSIGNED DEFAULT 0,
  rate            DECIMAL(18,4) DEFAULT 0,
  total_amount    DECIMAL(18,4) DEFAULT 0,
  expected_return DATE,
  status          ENUM('DRAFT','ISSUED','PARTIAL_RECEIVED','FULLY_RECEIVED','CLOSED','CANCELLED') DEFAULT 'DRAFT',
  remarks         VARCHAR(500),
  created_by      BIGINT UNSIGNED,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by      BIGINT UNSIGNED,
  updated_at      DATETIME ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_jw_challan (company_id, challan_no),
  KEY ix_jwc_vendor (vendor_id),
  CONSTRAINT fk_jwc__company  FOREIGN KEY (company_id)     REFERENCES mst_company(id),
  CONSTRAINT fk_jwc__prod     FOREIGN KEY (prod_order_id)  REFERENCES trx_production_order(id),
  CONSTRAINT fk_jwc__vendor   FOREIGN KEY (vendor_id)      REFERENCES mst_party(id),
  CONSTRAINT fk_jwc__stage    FOREIGN KEY (stage_id)       REFERENCES cfg_process_stage(id),
  CONSTRAINT fk_jwc__gateout  FOREIGN KEY (gate_outward_id) REFERENCES trx_gate_outward(id)
) ENGINE=InnoDB COMMENT='Job work challan (issue to vendor)';

CREATE TABLE trx_jobwork_challan_line (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  challan_id      BIGINT UNSIGNED NOT NULL,
  sku_id          BIGINT UNSIGNED,
  bundle_id       BIGINT UNSIGNED,
  description     VARCHAR(255),
  qty             INT UNSIGNED NOT NULL,
  uom_id          SMALLINT UNSIGNED,
  CONSTRAINT fk_jwcl__challan FOREIGN KEY (challan_id) REFERENCES trx_jobwork_challan(id),
  CONSTRAINT fk_jwcl__sku     FOREIGN KEY (sku_id)     REFERENCES mst_style_sku(id),
  CONSTRAINT fk_jwcl__bundle  FOREIGN KEY (bundle_id)  REFERENCES trx_cutting_bundle(id),
  CONSTRAINT fk_jwcl__uom     FOREIGN KEY (uom_id)     REFERENCES cfg_uom(id)
) ENGINE=InnoDB COMMENT='Job work challan line items';

-- Job Work Receipt (reconciliation when material returns)
CREATE TABLE trx_jobwork_receipt (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  receipt_no      VARCHAR(40) NOT NULL,
  receipt_date    DATE NOT NULL,
  challan_id      BIGINT UNSIGNED NOT NULL,
  vendor_id       BIGINT UNSIGNED NOT NULL,
  gate_inward_id  BIGINT UNSIGNED,
  issued_qty      INT UNSIGNED DEFAULT 0,
  received_qty    INT UNSIGNED DEFAULT 0,
  rejected_qty    INT UNSIGNED DEFAULT 0,
  shortage_qty    INT UNSIGNED DEFAULT 0,
  rework_qty      INT UNSIGNED DEFAULT 0,
  rate            DECIMAL(18,4) DEFAULT 0,
  total_amount    DECIMAL(18,4) DEFAULT 0,
  status          ENUM('DRAFT','RECEIVED','QC_PENDING','ACCEPTED','CLOSED') DEFAULT 'DRAFT',
  remarks         VARCHAR(500),
  created_by      BIGINT UNSIGNED,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_jw_receipt (company_id, receipt_no),
  CONSTRAINT fk_jwr__company FOREIGN KEY (company_id)    REFERENCES mst_company(id),
  CONSTRAINT fk_jwr__challan FOREIGN KEY (challan_id)    REFERENCES trx_jobwork_challan(id),
  CONSTRAINT fk_jwr__vendor  FOREIGN KEY (vendor_id)     REFERENCES mst_party(id),
  CONSTRAINT fk_jwr__gatein  FOREIGN KEY (gate_inward_id) REFERENCES trx_gate_inward(id)
) ENGINE=InnoDB COMMENT='Job work receipt (reconciliation with shortage/reject)';

CREATE TABLE trx_jobwork_receipt_line (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  receipt_id      BIGINT UNSIGNED NOT NULL,
  sku_id          BIGINT UNSIGNED,
  issued_qty      INT UNSIGNED DEFAULT 0,
  received_qty    INT UNSIGNED DEFAULT 0,
  rejected_qty    INT UNSIGNED DEFAULT 0,
  shortage_qty    INT UNSIGNED DEFAULT 0,
  remarks         VARCHAR(255),
  CONSTRAINT fk_jwrl__receipt FOREIGN KEY (receipt_id) REFERENCES trx_jobwork_receipt(id),
  CONSTRAINT fk_jwrl__sku     FOREIGN KEY (sku_id)     REFERENCES mst_style_sku(id)
) ENGINE=InnoDB COMMENT='Job work receipt line reconciliation';

-- Job Work In (customer material received for processing at our factory)
CREATE TABLE trx_jobwork_in (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  jwin_no         VARCHAR(40) NOT NULL,
  jwin_date       DATE NOT NULL,
  customer_id     BIGINT UNSIGNED NOT NULL,   -- customer who sends material
  gate_inward_id  BIGINT UNSIGNED,
  customer_dc_no  VARCHAR(60),
  customer_po_ref VARCHAR(60),
  process_type    VARCHAR(80),                -- Printing / Embroidery / etc.
  total_qty       INT UNSIGNED DEFAULT 0,
  rate            DECIMAL(18,4) DEFAULT 0,
  total_amount    DECIMAL(18,4) DEFAULT 0,
  expected_delivery DATE,
  status          ENUM('DRAFT','RECEIVED','IN_PROCESS','QC_DONE','READY_TO_DISPATCH','DISPATCHED','INVOICED','CLOSED') DEFAULT 'DRAFT',
  remarks         VARCHAR(500),
  created_by      BIGINT UNSIGNED,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by      BIGINT UNSIGNED,
  updated_at      DATETIME ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_jwin (company_id, jwin_no),
  KEY ix_jwin_customer (customer_id),
  CONSTRAINT fk_jwin__company  FOREIGN KEY (company_id)    REFERENCES mst_company(id),
  CONSTRAINT fk_jwin__customer FOREIGN KEY (customer_id)   REFERENCES mst_party(id),
  CONSTRAINT fk_jwin__gatein   FOREIGN KEY (gate_inward_id) REFERENCES trx_gate_inward(id)
) ENGINE=InnoDB COMMENT='Job work in (customer material for processing)';

CREATE TABLE trx_jobwork_in_line (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  jwin_id         BIGINT UNSIGNED NOT NULL,
  description     VARCHAR(255),
  material_type   ENUM('FABRIC','GARMENT','TRIM','OTHER') DEFAULT 'GARMENT',
  qty             INT UNSIGNED NOT NULL,
  uom_id          SMALLINT UNSIGNED,
  received_qty    INT UNSIGNED DEFAULT 0,
  processed_qty   INT UNSIGNED DEFAULT 0,
  rejected_qty    INT UNSIGNED DEFAULT 0,
  returned_qty    INT UNSIGNED DEFAULT 0,
  CONSTRAINT fk_jwinl__jwin FOREIGN KEY (jwin_id) REFERENCES trx_jobwork_in(id),
  CONSTRAINT fk_jwinl__uom  FOREIGN KEY (uom_id)  REFERENCES cfg_uom(id)
) ENGINE=InnoDB COMMENT='Job work in line items';

-- Job Work Invoice (billing for processing done)
CREATE TABLE trx_jobwork_invoice (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  invoice_no      VARCHAR(40) NOT NULL,
  invoice_date    DATE NOT NULL,
  jwin_id         BIGINT UNSIGNED,            -- if billing for job work in
  challan_id      BIGINT UNSIGNED,            -- if billing for job work out
  party_id        BIGINT UNSIGNED NOT NULL,   -- customer or vendor
  invoice_type    ENUM('RECEIVABLE','PAYABLE') NOT NULL,  -- we bill customer / vendor bills us
  currency_id     SMALLINT UNSIGNED NOT NULL,
  total_qty       INT UNSIGNED DEFAULT 0,
  rate            DECIMAL(18,4) DEFAULT 0,
  taxable_amount  DECIMAL(18,4) DEFAULT 0,
  gst_amount      DECIMAL(18,4) DEFAULT 0,
  total_amount    DECIMAL(18,4) DEFAULT 0,
  hsn_code        VARCHAR(10),
  status          ENUM('DRAFT','SUBMITTED','APPROVED','PAID','CANCELLED') DEFAULT 'DRAFT',
  voucher_id      BIGINT UNSIGNED,
  remarks         VARCHAR(500),
  created_by      BIGINT UNSIGNED,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_jw_invoice (company_id, invoice_no),
  CONSTRAINT fk_jwi__company FOREIGN KEY (company_id)  REFERENCES mst_company(id),
  CONSTRAINT fk_jwi__jwin    FOREIGN KEY (jwin_id)     REFERENCES trx_jobwork_in(id),
  CONSTRAINT fk_jwi__challan FOREIGN KEY (challan_id)  REFERENCES trx_jobwork_challan(id),
  CONSTRAINT fk_jwi__party   FOREIGN KEY (party_id)    REFERENCES mst_party(id),
  CONSTRAINT fk_jwi__cur     FOREIGN KEY (currency_id) REFERENCES cfg_currency(id),
  CONSTRAINT fk_jwi__voucher FOREIGN KEY (voucher_id)  REFERENCES trx_voucher(id)
) ENGINE=InnoDB COMMENT='Job work invoice (receivable or payable)';


-- =============================================================
-- G. PURCHASE RETURN + SUPPLIER BILL  (Po & Purchase §10-12)
-- =============================================================

CREATE TABLE trx_purchase_return (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  return_no       VARCHAR(40) NOT NULL,
  return_date     DATE NOT NULL,
  grn_id          BIGINT UNSIGNED NOT NULL,
  supplier_id     BIGINT UNSIGNED NOT NULL,
  warehouse_id    BIGINT UNSIGNED NOT NULL,
  gate_outward_id BIGINT UNSIGNED,
  return_reason   ENUM('QUALITY_REJECT','EXCESS','WRONG_MATERIAL','DAMAGED','OTHER') DEFAULT 'QUALITY_REJECT',
  total_qty       DECIMAL(18,5) DEFAULT 0,
  total_amount    DECIMAL(18,4) DEFAULT 0,
  debit_note_id   BIGINT UNSIGNED,            -- link to voucher debit note
  status          ENUM('DRAFT','APPROVED','DISPATCHED','ACKNOWLEDGED','CLOSED') DEFAULT 'DRAFT',
  remarks         VARCHAR(500),
  created_by      BIGINT UNSIGNED,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_pr (company_id, return_no),
  KEY ix_pr_grn (grn_id),
  CONSTRAINT fk_pr__company  FOREIGN KEY (company_id)     REFERENCES mst_company(id),
  CONSTRAINT fk_pr__grn      FOREIGN KEY (grn_id)         REFERENCES trx_grn(id),
  CONSTRAINT fk_pr__supplier FOREIGN KEY (supplier_id)    REFERENCES mst_party(id),
  CONSTRAINT fk_pr__wh       FOREIGN KEY (warehouse_id)   REFERENCES mst_warehouse(id),
  CONSTRAINT fk_pr__gateout  FOREIGN KEY (gate_outward_id) REFERENCES trx_gate_outward(id),
  CONSTRAINT fk_pr__debit    FOREIGN KEY (debit_note_id)  REFERENCES trx_voucher(id)
) ENGINE=InnoDB COMMENT='Purchase return (physical stock return to supplier)';

CREATE TABLE trx_purchase_return_line (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  return_id       BIGINT UNSIGNED NOT NULL,
  grn_line_id     BIGINT UNSIGNED,
  material_type   ENUM('YARN','FABRIC','TRIM') NOT NULL,
  yarn_id         BIGINT UNSIGNED,
  fabric_id       BIGINT UNSIGNED,
  trim_id         BIGINT UNSIGNED,
  color_id        BIGINT UNSIGNED,
  return_qty      DECIMAL(18,5) NOT NULL,
  uom_id          SMALLINT UNSIGNED NOT NULL,
  rate            DECIMAL(18,4) DEFAULT 0,
  amount          DECIMAL(18,4) DEFAULT 0,
  reason          VARCHAR(255),
  CONSTRAINT fk_prl__return  FOREIGN KEY (return_id)  REFERENCES trx_purchase_return(id),
  CONSTRAINT fk_prl__grnline FOREIGN KEY (grn_line_id) REFERENCES trx_grn_line(id),
  CONSTRAINT fk_prl__yarn    FOREIGN KEY (yarn_id)    REFERENCES mst_yarn(id),
  CONSTRAINT fk_prl__fabric  FOREIGN KEY (fabric_id)  REFERENCES mst_fabric(id),
  CONSTRAINT fk_prl__trim    FOREIGN KEY (trim_id)    REFERENCES mst_trim(id),
  CONSTRAINT fk_prl__color   FOREIGN KEY (color_id)   REFERENCES mst_color(id),
  CONSTRAINT fk_prl__uom     FOREIGN KEY (uom_id)     REFERENCES cfg_uom(id)
) ENGINE=InnoDB COMMENT='Purchase return lines';

-- Supplier Bill (for 3-way / 4-way matching)
CREATE TABLE trx_supplier_bill (
  id                BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id        BIGINT UNSIGNED NOT NULL,
  bill_no           VARCHAR(40) NOT NULL,
  bill_date         DATE NOT NULL,
  supplier_id       BIGINT UNSIGNED NOT NULL,
  supplier_inv_no   VARCHAR(60),
  supplier_inv_date DATE,
  po_id             BIGINT UNSIGNED,
  grn_id            BIGINT UNSIGNED,
  gate_inward_id    BIGINT UNSIGNED,
  currency_id       SMALLINT UNSIGNED NOT NULL,
  subtotal          DECIMAL(18,4) DEFAULT 0,
  gst_amount        DECIMAL(18,4) DEFAULT 0,
  tds_amount        DECIMAL(18,4) DEFAULT 0,
  total_amount      DECIMAL(18,4) DEFAULT 0,
  -- matching flags
  po_matched        TINYINT(1) NOT NULL DEFAULT 0,
  grn_matched       TINYINT(1) NOT NULL DEFAULT 0,
  gate_matched      TINYINT(1) NOT NULL DEFAULT 0,
  match_status      ENUM('UNMATCHED','PARTIAL','FULLY_MATCHED','DISCREPANCY') DEFAULT 'UNMATCHED',
  payment_due_date  DATE,
  voucher_id        BIGINT UNSIGNED,
  status            ENUM('DRAFT','VERIFIED','APPROVED','PAID','DISPUTED','CANCELLED') DEFAULT 'DRAFT',
  remarks           VARCHAR(500),
  created_by        BIGINT UNSIGNED,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by        BIGINT UNSIGNED,
  updated_at        DATETIME ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_sbill (company_id, bill_no),
  KEY ix_sbill_supplier (supplier_id),
  CONSTRAINT fk_sbill__company  FOREIGN KEY (company_id)    REFERENCES mst_company(id),
  CONSTRAINT fk_sbill__supplier FOREIGN KEY (supplier_id)   REFERENCES mst_party(id),
  CONSTRAINT fk_sbill__po       FOREIGN KEY (po_id)         REFERENCES trx_purchase_order(id),
  CONSTRAINT fk_sbill__grn      FOREIGN KEY (grn_id)        REFERENCES trx_grn(id),
  CONSTRAINT fk_sbill__gatein   FOREIGN KEY (gate_inward_id) REFERENCES trx_gate_inward(id),
  CONSTRAINT fk_sbill__cur      FOREIGN KEY (currency_id)   REFERENCES cfg_currency(id),
  CONSTRAINT fk_sbill__voucher  FOREIGN KEY (voucher_id)    REFERENCES trx_voucher(id)
) ENGINE=InnoDB COMMENT='Supplier bill / invoice entry (3-way/4-way matching)';

CREATE TABLE trx_supplier_bill_line (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  bill_id         BIGINT UNSIGNED NOT NULL,
  po_line_id      BIGINT UNSIGNED,
  grn_line_id     BIGINT UNSIGNED,
  material_type   ENUM('YARN','FABRIC','TRIM','SERVICE') NOT NULL,
  description     VARCHAR(255),
  bill_qty        DECIMAL(18,5) NOT NULL,
  po_qty          DECIMAL(18,5) DEFAULT 0,    -- from PO for comparison
  grn_qty         DECIMAL(18,5) DEFAULT 0,    -- from GRN for comparison
  uom_id          SMALLINT UNSIGNED NOT NULL,
  rate            DECIMAL(18,4) NOT NULL,
  amount          DECIMAL(18,4) NOT NULL,
  gst_rate        DECIMAL(5,2) DEFAULT 0,
  hsn_code        VARCHAR(10),
  qty_matched     TINYINT(1) NOT NULL DEFAULT 0,
  rate_matched    TINYINT(1) NOT NULL DEFAULT 0,
  CONSTRAINT fk_sbl__bill    FOREIGN KEY (bill_id)    REFERENCES trx_supplier_bill(id),
  CONSTRAINT fk_sbl__poline  FOREIGN KEY (po_line_id) REFERENCES trx_purchase_order_line(id),
  CONSTRAINT fk_sbl__grnline FOREIGN KEY (grn_line_id) REFERENCES trx_grn_line(id),
  CONSTRAINT fk_sbl__uom     FOREIGN KEY (uom_id)     REFERENCES cfg_uom(id)
) ENGINE=InnoDB COMMENT='Supplier bill line items with matching';


-- =============================================================
-- H. STOCK TRANSFER  (Production §28)
-- =============================================================

CREATE TABLE trx_stock_transfer (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  transfer_no     VARCHAR(40) NOT NULL,
  transfer_date   DATE NOT NULL,
  from_warehouse  BIGINT UNSIGNED NOT NULL,
  to_warehouse    BIGINT UNSIGNED NOT NULL,
  prod_order_id   BIGINT UNSIGNED,
  transfer_type   ENUM('INTER_STORE','FLOOR_TRANSFER','UNIT_TRANSFER','REJECTION_MOVE') DEFAULT 'INTER_STORE',
  total_qty       DECIMAL(14,3) DEFAULT 0,
  status          ENUM('DRAFT','IN_TRANSIT','RECEIVED','CANCELLED') DEFAULT 'DRAFT',
  remarks         VARCHAR(500),
  created_by      BIGINT UNSIGNED,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_stxfr (company_id, transfer_no),
  CONSTRAINT fk_stxfr__company FOREIGN KEY (company_id)    REFERENCES mst_company(id),
  CONSTRAINT fk_stxfr__from    FOREIGN KEY (from_warehouse) REFERENCES mst_warehouse(id),
  CONSTRAINT fk_stxfr__to      FOREIGN KEY (to_warehouse)  REFERENCES mst_warehouse(id),
  CONSTRAINT fk_stxfr__prod    FOREIGN KEY (prod_order_id) REFERENCES trx_production_order(id)
) ENGINE=InnoDB COMMENT='Inter-location stock transfer header';

CREATE TABLE trx_stock_transfer_line (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  transfer_id     BIGINT UNSIGNED NOT NULL,
  material_type   ENUM('YARN','FABRIC','TRIM','FINISHED','WIP') NOT NULL,
  yarn_id         BIGINT UNSIGNED,
  fabric_id       BIGINT UNSIGNED,
  trim_id         BIGINT UNSIGNED,
  sku_id          BIGINT UNSIGNED,
  color_id        BIGINT UNSIGNED,
  batch_id        BIGINT UNSIGNED,
  bundle_id       BIGINT UNSIGNED,
  qty             DECIMAL(18,5) NOT NULL,
  uom_id          SMALLINT UNSIGNED NOT NULL,
  CONSTRAINT fk_stxfrl__transfer FOREIGN KEY (transfer_id) REFERENCES trx_stock_transfer(id),
  CONSTRAINT fk_stxfrl__yarn     FOREIGN KEY (yarn_id)     REFERENCES mst_yarn(id),
  CONSTRAINT fk_stxfrl__fabric   FOREIGN KEY (fabric_id)   REFERENCES mst_fabric(id),
  CONSTRAINT fk_stxfrl__trim     FOREIGN KEY (trim_id)     REFERENCES mst_trim(id),
  CONSTRAINT fk_stxfrl__sku      FOREIGN KEY (sku_id)      REFERENCES mst_style_sku(id),
  CONSTRAINT fk_stxfrl__color    FOREIGN KEY (color_id)    REFERENCES mst_color(id),
  CONSTRAINT fk_stxfrl__batch    FOREIGN KEY (batch_id)    REFERENCES mst_batch(id),
  CONSTRAINT fk_stxfrl__bundle   FOREIGN KEY (bundle_id)   REFERENCES trx_cutting_bundle(id),
  CONSTRAINT fk_stxfrl__uom      FOREIGN KEY (uom_id)      REFERENCES cfg_uom(id)
) ENGINE=InnoDB COMMENT='Stock transfer line items';


-- =============================================================
-- I. FG RECEIPT  (Production §27)
-- =============================================================

CREATE TABLE trx_fg_receipt (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  fg_receipt_no   VARCHAR(40) NOT NULL,
  receipt_date    DATE NOT NULL,
  prod_order_id   BIGINT UNSIGNED NOT NULL,
  so_id           BIGINT UNSIGNED,
  packing_id      BIGINT UNSIGNED,
  qc_id           BIGINT UNSIGNED,            -- final QC reference
  warehouse_id    BIGINT UNSIGNED NOT NULL,   -- FG warehouse
  total_qty       INT UNSIGNED DEFAULT 0,
  status          ENUM('DRAFT','RECEIVED','CONFIRMED','CANCELLED') DEFAULT 'DRAFT',
  remarks         VARCHAR(500),
  created_by      BIGINT UNSIGNED,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_fgr (company_id, fg_receipt_no),
  CONSTRAINT fk_fgr__company FOREIGN KEY (company_id)    REFERENCES mst_company(id),
  CONSTRAINT fk_fgr__prod    FOREIGN KEY (prod_order_id) REFERENCES trx_production_order(id),
  CONSTRAINT fk_fgr__so      FOREIGN KEY (so_id)         REFERENCES trx_sales_order(id),
  CONSTRAINT fk_fgr__packing FOREIGN KEY (packing_id)    REFERENCES trx_packing(id),
  CONSTRAINT fk_fgr__qc      FOREIGN KEY (qc_id)         REFERENCES trx_qc_inspection(id),
  CONSTRAINT fk_fgr__wh      FOREIGN KEY (warehouse_id)  REFERENCES mst_warehouse(id)
) ENGINE=InnoDB COMMENT='Finished goods receipt into FG warehouse';

CREATE TABLE trx_fg_receipt_line (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  fg_receipt_id   BIGINT UNSIGNED NOT NULL,
  sku_id          BIGINT UNSIGNED NOT NULL,
  carton_id       BIGINT UNSIGNED,
  qty             INT UNSIGNED NOT NULL,
  CONSTRAINT fk_fgrl__fgr    FOREIGN KEY (fg_receipt_id) REFERENCES trx_fg_receipt(id),
  CONSTRAINT fk_fgrl__sku    FOREIGN KEY (sku_id)        REFERENCES mst_style_sku(id),
  CONSTRAINT fk_fgrl__carton FOREIGN KEY (carton_id)     REFERENCES trx_carton(id)
) ENGINE=InnoDB COMMENT='FG receipt lines (SKU-wise)';


-- =============================================================
-- J. ACTUAL PRODUCTION COSTING  (Production §30)
-- =============================================================

CREATE TABLE trx_production_cost (
  id                  BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id          BIGINT UNSIGNED NOT NULL,
  cost_no             VARCHAR(40) NOT NULL,
  cost_date           DATE NOT NULL,
  prod_order_id       BIGINT UNSIGNED NOT NULL,
  style_id            BIGINT UNSIGNED,
  produced_qty        INT UNSIGNED DEFAULT 0,
  -- aggregated cost heads
  material_cost       DECIMAL(18,4) DEFAULT 0,
  labour_cost         DECIMAL(18,4) DEFAULT 0,
  machine_cost        DECIMAL(18,4) DEFAULT 0,
  jobwork_cost        DECIMAL(18,4) DEFAULT 0,
  process_cost        DECIMAL(18,4) DEFAULT 0,
  overhead_cost       DECIMAL(18,4) DEFAULT 0,
  packing_cost        DECIMAL(18,4) DEFAULT 0,
  total_cost          DECIMAL(18,4) DEFAULT 0,
  cost_per_piece      DECIMAL(18,4) DEFAULT 0,  -- total_cost / produced_qty
  -- comparison with estimate
  estimated_cost      DECIMAL(18,4) DEFAULT 0,  -- from trx_costing
  variance            DECIMAL(18,4) DEFAULT 0,
  variance_pct        DECIMAL(6,2)  DEFAULT 0,
  status              ENUM('DRAFT','CALCULATED','APPROVED','CLOSED') DEFAULT 'DRAFT',
  remarks             VARCHAR(500),
  created_by          BIGINT UNSIGNED,
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_prod_cost (company_id, cost_no),
  CONSTRAINT fk_pcost__company FOREIGN KEY (company_id)    REFERENCES mst_company(id),
  CONSTRAINT fk_pcost__prod    FOREIGN KEY (prod_order_id) REFERENCES trx_production_order(id),
  CONSTRAINT fk_pcost__style   FOREIGN KEY (style_id)      REFERENCES mst_style(id)
) ENGINE=InnoDB COMMENT='Actual production cost per work order';

CREATE TABLE trx_production_cost_line (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  cost_id         BIGINT UNSIGNED NOT NULL,
  cost_head       VARCHAR(60) NOT NULL,       -- Fabric, Yarn, Trims, Sewing Labour, Printing, etc.
  cost_category   ENUM('MATERIAL','LABOUR','MACHINE','JOBWORK','PROCESS','OVERHEAD','PACKING','OTHER') NOT NULL,
  ref_type        VARCHAR(40),                -- source doc type (MATERIAL_ISSUE, STITCHING, PRINTING, etc.)
  ref_id          BIGINT UNSIGNED,            -- source doc id
  quantity        DECIMAL(18,5),
  uom_id          SMALLINT UNSIGNED,
  rate            DECIMAL(18,4),
  amount          DECIMAL(18,4) NOT NULL,
  remarks         VARCHAR(255),
  CONSTRAINT fk_pcostl__cost FOREIGN KEY (cost_id) REFERENCES trx_production_cost(id),
  CONSTRAINT fk_pcostl__uom  FOREIGN KEY (uom_id)  REFERENCES cfg_uom(id)
) ENGINE=InnoDB COMMENT='Production cost line detail (cost head breakdown)';
