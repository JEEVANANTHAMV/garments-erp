-- =====================================================================
-- 7. ENQUIRY → SAMPLING → COSTING → QUOTATION → ORDER
-- =====================================================================

-- Customer enquiry (order procurement funnel entry)
CREATE TABLE trx_enquiry (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  branch_id       BIGINT UNSIGNED,
  enquiry_no      VARCHAR(40) NOT NULL,
  enquiry_date    DATE NOT NULL,
  buyer_id        BIGINT UNSIGNED NOT NULL,
  agent_id        BIGINT UNSIGNED,
  merchandiser_id BIGINT UNSIGNED,        -- mst_user
  season          VARCHAR(40),
  target_price    DECIMAL(18,4),
  currency_id     SMALLINT UNSIGNED,
  expected_qty    INT UNSIGNED,
  delivery_target DATE,
  status_id       INT UNSIGNED,           -- domain ENQUIRY
  remarks         TEXT,
  is_deleted      TINYINT(1) NOT NULL DEFAULT 0,
  created_by      BIGINT UNSIGNED,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by      BIGINT UNSIGNED,
  updated_at      DATETIME ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_enquiry (company_id,enquiry_no),
  CONSTRAINT fk_enq__company FOREIGN KEY (company_id)      REFERENCES mst_company(id),
  CONSTRAINT fk_enq__branch  FOREIGN KEY (branch_id)       REFERENCES mst_branch(id),
  CONSTRAINT fk_enq__buyer   FOREIGN KEY (buyer_id)        REFERENCES mst_party(id),
  CONSTRAINT fk_enq__agent   FOREIGN KEY (agent_id)        REFERENCES mst_party(id),
  CONSTRAINT fk_enq__mer     FOREIGN KEY (merchandiser_id) REFERENCES mst_user(id),
  CONSTRAINT fk_enq__cur     FOREIGN KEY (currency_id)     REFERENCES cfg_currency(id),
  CONSTRAINT fk_enq__status  FOREIGN KEY (status_id)       REFERENCES cfg_status(id)
) ENGINE=InnoDB COMMENT='Buyer enquiry (funnel entry)';

CREATE TABLE trx_enquiry_line (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  enquiry_id      BIGINT UNSIGNED NOT NULL,
  style_id        BIGINT UNSIGNED,
  product_id      BIGINT UNSIGNED,
  description     VARCHAR(255),
  qty             INT UNSIGNED,
  target_price    DECIMAL(18,4),
  CONSTRAINT fk_enql__enq     FOREIGN KEY (enquiry_id) REFERENCES trx_enquiry(id),
  CONSTRAINT fk_enql__style   FOREIGN KEY (style_id)   REFERENCES mst_style(id),
  CONSTRAINT fk_enql__product FOREIGN KEY (product_id) REFERENCES mst_product(id)
) ENGINE=InnoDB COMMENT='Enquiry line items';

-- Sampling management
CREATE TABLE trx_sample (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  sample_no       VARCHAR(40) NOT NULL,
  enquiry_id      BIGINT UNSIGNED,
  style_id        BIGINT UNSIGNED NOT NULL,
  buyer_id        BIGINT UNSIGNED,
  sample_type     ENUM('PROTO','FIT','SMS','SIZE_SET','PP','TOP','SHIPMENT','PHOTO') NOT NULL,
  request_date    DATE,
  target_date     DATE,
  submit_date     DATE,
  qty             INT UNSIGNED DEFAULT 1,
  status_id       INT UNSIGNED,           -- domain SAMPLE
  approval_status ENUM('PENDING','APPROVED','REJECTED','APPROVED_WITH_COMMENTS') DEFAULT 'PENDING',
  buyer_comments  TEXT,
  courier_awb     VARCHAR(60),
  is_deleted      TINYINT(1) NOT NULL DEFAULT 0,
  created_by      BIGINT UNSIGNED,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by      BIGINT UNSIGNED,
  updated_at      DATETIME ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_sample (company_id,sample_no),
  KEY ix_sample_style (style_id),
  CONSTRAINT fk_samp__company FOREIGN KEY (company_id) REFERENCES mst_company(id),
  CONSTRAINT fk_samp__enq     FOREIGN KEY (enquiry_id) REFERENCES trx_enquiry(id),
  CONSTRAINT fk_samp__style   FOREIGN KEY (style_id)   REFERENCES mst_style(id),
  CONSTRAINT fk_samp__buyer   FOREIGN KEY (buyer_id)   REFERENCES mst_party(id),
  CONSTRAINT fk_samp__status  FOREIGN KEY (status_id)  REFERENCES cfg_status(id)
) ENGINE=InnoDB COMMENT='Sampling lifecycle (proto→PP→TOP)';

-- Costing sheet (style-level pre-order cost build-up)
CREATE TABLE trx_costing (
  id                BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id        BIGINT UNSIGNED NOT NULL,
  costing_no        VARCHAR(40) NOT NULL,
  version           INT NOT NULL DEFAULT 1,
  enquiry_id        BIGINT UNSIGNED,
  style_id          BIGINT UNSIGNED NOT NULL,
  buyer_id          BIGINT UNSIGNED,
  costing_date      DATE NOT NULL,
  currency_id       SMALLINT UNSIGNED NOT NULL,
  order_qty         INT UNSIGNED,
  -- cost heads (per garment)
  fabric_cost       DECIMAL(18,4) DEFAULT 0,
  yarn_cost         DECIMAL(18,4) DEFAULT 0,
  trim_cost         DECIMAL(18,4) DEFAULT 0,
  knitting_cost     DECIMAL(18,4) DEFAULT 0,
  dyeing_cost       DECIMAL(18,4) DEFAULT 0,
  printing_cost     DECIMAL(18,4) DEFAULT 0,
  embroidery_cost   DECIMAL(18,4) DEFAULT 0,
  washing_cost      DECIMAL(18,4) DEFAULT 0,
  cutting_cost      DECIMAL(18,4) DEFAULT 0,
  stitching_cost    DECIMAL(18,4) DEFAULT 0,
  finishing_cost    DECIMAL(18,4) DEFAULT 0,
  packing_cost      DECIMAL(18,4) DEFAULT 0,
  overhead_cost     DECIMAL(18,4) DEFAULT 0,
  testing_cost      DECIMAL(18,4) DEFAULT 0,
  freight_cost      DECIMAL(18,4) DEFAULT 0,
  agent_commission  DECIMAL(18,4) DEFAULT 0,
  finance_cost      DECIMAL(18,4) DEFAULT 0,
  total_cost        DECIMAL(18,4) DEFAULT 0,   -- computed
  margin_pct        DECIMAL(6,3) DEFAULT 0,
  fob_price         DECIMAL(18,4) DEFAULT 0,   -- quoted FOB
  status_id         INT UNSIGNED,              -- domain COSTING
  remarks           TEXT,
  is_deleted        TINYINT(1) NOT NULL DEFAULT 0,
  created_by        BIGINT UNSIGNED,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by        BIGINT UNSIGNED,
  updated_at        DATETIME ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_costing (company_id,costing_no,version),
  CONSTRAINT fk_cost__company FOREIGN KEY (company_id)  REFERENCES mst_company(id),
  CONSTRAINT fk_cost__enq     FOREIGN KEY (enquiry_id)  REFERENCES trx_enquiry(id),
  CONSTRAINT fk_cost__style   FOREIGN KEY (style_id)    REFERENCES mst_style(id),
  CONSTRAINT fk_cost__buyer   FOREIGN KEY (buyer_id)    REFERENCES mst_party(id),
  CONSTRAINT fk_cost__cur     FOREIGN KEY (currency_id) REFERENCES cfg_currency(id),
  CONSTRAINT fk_cost__status  FOREIGN KEY (status_id)   REFERENCES cfg_status(id)
) ENGINE=InnoDB COMMENT='Costing sheet (cost build-up → FOB)';

-- Detailed line-level costing (optional granular heads)
CREATE TABLE trx_costing_line (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  costing_id      BIGINT UNSIGNED NOT NULL,
  cost_head       VARCHAR(60) NOT NULL,   -- free-form or ties to material
  material_type   ENUM('YARN','FABRIC','TRIM','PROCESS','OTHER'),
  ref_material_id BIGINT UNSIGNED,
  quantity        DECIMAL(18,5),
  uom_id          SMALLINT UNSIGNED,
  rate            DECIMAL(18,4),
  amount          DECIMAL(18,4),
  CONSTRAINT fk_costl__cost FOREIGN KEY (costing_id) REFERENCES trx_costing(id),
  CONSTRAINT fk_costl__uom  FOREIGN KEY (uom_id)     REFERENCES cfg_uom(id)
) ENGINE=InnoDB COMMENT='Costing line detail';

-- Quotation to buyer
CREATE TABLE trx_quotation (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  branch_id       BIGINT UNSIGNED,
  quotation_no    VARCHAR(40) NOT NULL,
  version         INT NOT NULL DEFAULT 1,
  quotation_date  DATE NOT NULL,
  buyer_id        BIGINT UNSIGNED NOT NULL,
  agent_id        BIGINT UNSIGNED,
  enquiry_id      BIGINT UNSIGNED,
  currency_id     SMALLINT UNSIGNED NOT NULL,
  incoterm        ENUM('FOB','CIF','CFR','EXW','DDP','DAP','FCA') DEFAULT 'FOB',
  valid_until     DATE,
  payment_terms   VARCHAR(150),
  total_amount    DECIMAL(18,4) DEFAULT 0,
  status_id       INT UNSIGNED,           -- domain QUOTATION
  remarks         TEXT,
  is_deleted      TINYINT(1) NOT NULL DEFAULT 0,
  created_by      BIGINT UNSIGNED,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by      BIGINT UNSIGNED,
  updated_at      DATETIME ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_quotation (company_id,quotation_no,version),
  CONSTRAINT fk_quo__company FOREIGN KEY (company_id)  REFERENCES mst_company(id),
  CONSTRAINT fk_quo__branch  FOREIGN KEY (branch_id)   REFERENCES mst_branch(id),
  CONSTRAINT fk_quo__buyer   FOREIGN KEY (buyer_id)    REFERENCES mst_party(id),
  CONSTRAINT fk_quo__agent   FOREIGN KEY (agent_id)    REFERENCES mst_party(id),
  CONSTRAINT fk_quo__enq     FOREIGN KEY (enquiry_id)  REFERENCES trx_enquiry(id),
  CONSTRAINT fk_quo__cur     FOREIGN KEY (currency_id) REFERENCES cfg_currency(id),
  CONSTRAINT fk_quo__status  FOREIGN KEY (status_id)   REFERENCES cfg_status(id)
) ENGINE=InnoDB COMMENT='Quotation header';

CREATE TABLE trx_quotation_line (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  quotation_id    BIGINT UNSIGNED NOT NULL,
  style_id        BIGINT UNSIGNED NOT NULL,
  costing_id      BIGINT UNSIGNED,
  description     VARCHAR(255),
  qty             INT UNSIGNED NOT NULL,
  unit_price      DECIMAL(18,4) NOT NULL,
  amount          DECIMAL(18,4) NOT NULL,
  CONSTRAINT fk_quol__quo   FOREIGN KEY (quotation_id) REFERENCES trx_quotation(id),
  CONSTRAINT fk_quol__style FOREIGN KEY (style_id)     REFERENCES mst_style(id),
  CONSTRAINT fk_quol__cost  FOREIGN KEY (costing_id)   REFERENCES trx_costing(id)
) ENGINE=InnoDB COMMENT='Quotation line items';

-- =====================================================================
-- 8. SALES ORDER (confirmed export order)
-- =====================================================================

CREATE TABLE trx_sales_order (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  branch_id       BIGINT UNSIGNED,
  so_no           VARCHAR(40) NOT NULL,
  io_no           VARCHAR(60),            -- factory / internal order number
  so_date         DATE NOT NULL,
  buyer_id        BIGINT UNSIGNED NOT NULL,
  agent_id        BIGINT UNSIGNED,
  quotation_id    BIGINT UNSIGNED,
  buyer_po_no     VARCHAR(60),            -- buyer's purchase order number
  buyer_po_date   DATE,
  season          VARCHAR(40),
  currency_id     SMALLINT UNSIGNED NOT NULL,
  exchange_rate   DECIMAL(18,6) DEFAULT 1,
  incoterm        ENUM('FOB','CIF','CFR','EXW','DDP','DAP','FCA') DEFAULT 'FOB',
  port_of_loading VARCHAR(80),
  destination_country SMALLINT UNSIGNED,
  destination_port VARCHAR(80),
  payment_term    ENUM('LC','TT_ADVANCE','TT_AGAINST_DOC','DA','DP','CAD','OPEN') DEFAULT 'LC',
  lc_no           VARCHAR(60),
  lc_date         DATE,
  lc_expiry       DATE,
  excess_pct      DECIMAL(6,2) DEFAULT 0,
  tolerance_plus_pct DECIMAL(6,2) DEFAULT 0,
  tolerance_minus_pct DECIMAL(6,2) DEFAULT 0,
  plan_cut_qty    INT UNSIGNED DEFAULT 0,
  order_qty       INT UNSIGNED DEFAULT 0,
  total_amount    DECIMAL(18,4) DEFAULT 0,
  ship_date       DATE,                   -- contracted shipment date
  delivery_date   DATE,
  status_id       INT UNSIGNED,           -- domain SALES_ORDER
  approval_state  ENUM('DRAFT','PENDING','APPROVED','REJECTED','ON_HOLD','CLOSED','CANCELLED') DEFAULT 'DRAFT',
  remarks         TEXT,
  is_deleted      TINYINT(1) NOT NULL DEFAULT 0,
  created_by      BIGINT UNSIGNED,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by      BIGINT UNSIGNED,
  updated_at      DATETIME ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_so (company_id,so_no),
  KEY ix_so_buyer (buyer_id),
  KEY ix_so_ship (ship_date),
  CONSTRAINT fk_so__company FOREIGN KEY (company_id)          REFERENCES mst_company(id),
  CONSTRAINT fk_so__branch  FOREIGN KEY (branch_id)           REFERENCES mst_branch(id),
  CONSTRAINT fk_so__buyer   FOREIGN KEY (buyer_id)            REFERENCES mst_party(id),
  CONSTRAINT fk_so__agent   FOREIGN KEY (agent_id)            REFERENCES mst_party(id),
  CONSTRAINT fk_so__quo     FOREIGN KEY (quotation_id)        REFERENCES trx_quotation(id),
  CONSTRAINT fk_so__cur     FOREIGN KEY (currency_id)         REFERENCES cfg_currency(id),
  CONSTRAINT fk_so__dest    FOREIGN KEY (destination_country) REFERENCES cfg_country(id),
  CONSTRAINT fk_so__status  FOREIGN KEY (status_id)           REFERENCES cfg_status(id)
) ENGINE=InnoDB COMMENT='Confirmed sales / export order header';

CREATE TABLE trx_sales_order_line (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  so_id           BIGINT UNSIGNED NOT NULL,
  style_id        BIGINT UNSIGNED NOT NULL,
  color_id        BIGINT UNSIGNED,
  description     VARCHAR(255),
  order_qty       INT UNSIGNED NOT NULL,
  excess_pct      DECIMAL(6,2) DEFAULT 0,
  plan_cut_qty    INT UNSIGNED DEFAULT 0,
  unit_price      DECIMAL(18,4) NOT NULL,
  amount          DECIMAL(18,4) NOT NULL,
  ship_date       DATE,
  CONSTRAINT fk_sol__so    FOREIGN KEY (so_id)    REFERENCES trx_sales_order(id),
  CONSTRAINT fk_sol__style FOREIGN KEY (style_id) REFERENCES mst_style(id),
  CONSTRAINT fk_sol__color FOREIGN KEY (color_id) REFERENCES mst_color(id)
) ENGINE=InnoDB COMMENT='Sales order lines (style/color)';

-- Size-wise quantity breakdown (order ratio) per SO line
CREATE TABLE trx_sales_order_sku (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  so_line_id      BIGINT UNSIGNED NOT NULL,
  sku_id          BIGINT UNSIGNED NOT NULL,   -- mst_style_sku
  qty             INT UNSIGNED NOT NULL,
  UNIQUE KEY uq_so_sku (so_line_id,sku_id),
  CONSTRAINT fk_sosku__line FOREIGN KEY (so_line_id) REFERENCES trx_sales_order_line(id),
  CONSTRAINT fk_sosku__sku  FOREIGN KEY (sku_id)     REFERENCES mst_style_sku(id)
) ENGINE=InnoDB COMMENT='Size-wise order breakdown';
