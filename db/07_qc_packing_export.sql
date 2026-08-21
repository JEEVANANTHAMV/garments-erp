-- =====================================================================
-- 11. QUALITY CONTROL  (Inline & Final / AQL)
-- =====================================================================

CREATE TABLE mst_defect (
  id              INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  defect_code     VARCHAR(30) NOT NULL,
  defect_name     VARCHAR(120) NOT NULL,
  defect_type     ENUM('CRITICAL','MAJOR','MINOR') NOT NULL DEFAULT 'MINOR',
  stage           VARCHAR(40),            -- where typically found
  is_active       TINYINT(1) NOT NULL DEFAULT 1,
  UNIQUE KEY uq_defect (company_id,defect_code),
  CONSTRAINT fk_defect__company FOREIGN KEY (company_id) REFERENCES mst_company(id)
) ENGINE=InnoDB COMMENT='Defect master (AQL classification)';

CREATE TABLE trx_qc_inspection (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  qc_no           VARCHAR(40) NOT NULL,
  qc_date         DATE NOT NULL,
  prod_order_id   BIGINT UNSIGNED,
  stage_id        INT UNSIGNED,           -- cfg_process_stage
  inspection_type ENUM('INCOMING','INLINE','END_LINE','FINAL','PRE_FINAL','AQL','PACKING') NOT NULL,
  aql_level       VARCHAR(20),            -- 1.5 / 2.5 / 4.0
  lot_size        INT UNSIGNED,
  sample_size     INT UNSIGNED,
  inspected_qty   INT UNSIGNED,
  passed_qty      INT UNSIGNED,
  major_defects   INT UNSIGNED DEFAULT 0,
  minor_defects   INT UNSIGNED DEFAULT 0,
  critical_defects INT UNSIGNED DEFAULT 0,
  result          ENUM('PASS','FAIL','PENDING','REINSPECT') DEFAULT 'PENDING',
  inspector_id    BIGINT UNSIGNED,
  buyer_qc        TINYINT(1) NOT NULL DEFAULT 0,   -- third-party/buyer QC
  remarks         TEXT,
  created_by      BIGINT UNSIGNED,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_qc (company_id,qc_no),
  KEY ix_qc_prod (prod_order_id),
  CONSTRAINT fk_qc__company FOREIGN KEY (company_id)    REFERENCES mst_company(id),
  CONSTRAINT fk_qc__prod    FOREIGN KEY (prod_order_id) REFERENCES trx_production_order(id),
  CONSTRAINT fk_qc__stage   FOREIGN KEY (stage_id)      REFERENCES cfg_process_stage(id),
  CONSTRAINT fk_qc__insp    FOREIGN KEY (inspector_id)  REFERENCES mst_user(id)
) ENGINE=InnoDB COMMENT='QC inspection header (inline/final/AQL)';

CREATE TABLE trx_qc_defect_line (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  qc_id           BIGINT UNSIGNED NOT NULL,
  defect_id       INT UNSIGNED NOT NULL,
  sku_id          BIGINT UNSIGNED,
  defect_qty      INT UNSIGNED NOT NULL,
  remarks         VARCHAR(255),
  CONSTRAINT fk_qcd__qc     FOREIGN KEY (qc_id)     REFERENCES trx_qc_inspection(id),
  CONSTRAINT fk_qcd__defect FOREIGN KEY (defect_id) REFERENCES mst_defect(id),
  CONSTRAINT fk_qcd__sku    FOREIGN KEY (sku_id)    REFERENCES mst_style_sku(id)
) ENGINE=InnoDB COMMENT='QC defect capture lines';

-- =====================================================================
-- 12. PACKING
-- =====================================================================

CREATE TABLE trx_packing (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  pack_no         VARCHAR(40) NOT NULL,
  pack_date       DATE NOT NULL,
  so_id           BIGINT UNSIGNED NOT NULL,
  prod_order_id   BIGINT UNSIGNED,
  pack_method     ENUM('SOLID_COLOR_SOLID_SIZE','SOLID_COLOR_ASSORTED_SIZE',
                       'ASSORTED_COLOR_ASSORTED_SIZE','RATIO_PACK') NOT NULL DEFAULT 'RATIO_PACK',
  total_cartons   INT UNSIGNED DEFAULT 0,
  total_qty       INT UNSIGNED DEFAULT 0,
  net_weight_kg   DECIMAL(12,3),
  gross_weight_kg DECIMAL(12,3),
  status_id       INT UNSIGNED,
  created_by      BIGINT UNSIGNED,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_pack (company_id,pack_no),
  CONSTRAINT fk_pack__company FOREIGN KEY (company_id)    REFERENCES mst_company(id),
  CONSTRAINT fk_pack__so      FOREIGN KEY (so_id)         REFERENCES trx_sales_order(id),
  CONSTRAINT fk_pack__prod    FOREIGN KEY (prod_order_id) REFERENCES trx_production_order(id),
  CONSTRAINT fk_pack__status  FOREIGN KEY (status_id)     REFERENCES cfg_status(id)
) ENGINE=InnoDB COMMENT='Packing header';

CREATE TABLE trx_carton (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  packing_id      BIGINT UNSIGNED NOT NULL,
  carton_no       VARCHAR(40) NOT NULL,
  carton_type     VARCHAR(40),
  length_cm       DECIMAL(8,2),
  width_cm        DECIMAL(8,2),
  height_cm       DECIMAL(8,2),
  net_weight_kg   DECIMAL(10,3),
  gross_weight_kg DECIMAL(10,3),
  cbm             DECIMAL(10,5),          -- cubic metre
  barcode         VARCHAR(80),
  UNIQUE KEY uq_carton (packing_id,carton_no),
  CONSTRAINT fk_carton__pack FOREIGN KEY (packing_id) REFERENCES trx_packing(id)
) ENGINE=InnoDB COMMENT='Individual export cartons';

CREATE TABLE trx_carton_content (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  carton_id       BIGINT UNSIGNED NOT NULL,
  sku_id          BIGINT UNSIGNED NOT NULL,
  qty             INT UNSIGNED NOT NULL,
  CONSTRAINT fk_cc__carton FOREIGN KEY (carton_id) REFERENCES trx_carton(id),
  CONSTRAINT fk_cc__sku    FOREIGN KEY (sku_id)    REFERENCES mst_style_sku(id)
) ENGINE=InnoDB COMMENT='Carton contents (SKU x qty)';

-- =====================================================================
-- 13. DISPATCH / CONTAINER / LOGISTICS / SHIPMENT
-- =====================================================================

CREATE TABLE trx_dispatch (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  dispatch_no     VARCHAR(40) NOT NULL,
  dispatch_date   DATE NOT NULL,
  so_id           BIGINT UNSIGNED NOT NULL,
  packing_id      BIGINT UNSIGNED,
  buyer_id        BIGINT UNSIGNED,
  mode            ENUM('SEA','AIR','ROAD','COURIER') NOT NULL DEFAULT 'SEA',
  total_cartons   INT UNSIGNED,
  total_qty       INT UNSIGNED,
  gross_weight_kg DECIMAL(12,3),
  total_cbm       DECIMAL(12,5),
  status_id       INT UNSIGNED,
  created_by      BIGINT UNSIGNED,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_dispatch (company_id,dispatch_no),
  CONSTRAINT fk_disp__company FOREIGN KEY (company_id) REFERENCES mst_company(id),
  CONSTRAINT fk_disp__so      FOREIGN KEY (so_id)      REFERENCES trx_sales_order(id),
  CONSTRAINT fk_disp__pack    FOREIGN KEY (packing_id) REFERENCES trx_packing(id),
  CONSTRAINT fk_disp__buyer   FOREIGN KEY (buyer_id)   REFERENCES mst_party(id),
  CONSTRAINT fk_disp__status  FOREIGN KEY (status_id)  REFERENCES cfg_status(id)
) ENGINE=InnoDB COMMENT='Dispatch header';

CREATE TABLE trx_container (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  container_no    VARCHAR(40) NOT NULL,
  dispatch_id     BIGINT UNSIGNED,
  container_type  ENUM('20FT','40FT','40HC','45HC','LCL') NOT NULL DEFAULT '40HC',
  seal_no         VARCHAR(40),
  line_seal_no    VARCHAR(40),
  tare_weight_kg  DECIMAL(12,3),
  max_cbm         DECIMAL(10,3),
  loaded_cbm      DECIMAL(10,3),
  stuffing_date   DATE,
  stuffing_type   ENUM('FACTORY','CFS','ICD') DEFAULT 'FACTORY',
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_container (company_id,container_no,dispatch_id),
  CONSTRAINT fk_cont__company  FOREIGN KEY (company_id)  REFERENCES mst_company(id),
  CONSTRAINT fk_cont__dispatch FOREIGN KEY (dispatch_id) REFERENCES trx_dispatch(id)
) ENGINE=InnoDB COMMENT='Container planning / stuffing';

-- =====================================================================
-- 14. EXPORT DOCUMENTATION
--     Commercial Invoice / Packing List / Shipping Bill / Certs / LC
-- =====================================================================

CREATE TABLE trx_commercial_invoice (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  invoice_no      VARCHAR(40) NOT NULL,
  invoice_date    DATE NOT NULL,
  so_id           BIGINT UNSIGNED NOT NULL,
  dispatch_id     BIGINT UNSIGNED,
  buyer_id        BIGINT UNSIGNED NOT NULL,
  consignee_id    BIGINT UNSIGNED,        -- may differ from buyer
  currency_id     SMALLINT UNSIGNED NOT NULL,
  exchange_rate   DECIMAL(18,6) DEFAULT 1,
  incoterm        ENUM('FOB','CIF','CFR','EXW','DDP','DAP','FCA') DEFAULT 'FOB',
  port_of_loading VARCHAR(80),
  port_of_discharge VARCHAR(80),
  final_destination VARCHAR(80),
  country_origin  SMALLINT UNSIGNED,
  country_dest    SMALLINT UNSIGNED,
  fob_value       DECIMAL(18,4) DEFAULT 0,
  freight_value   DECIMAL(18,4) DEFAULT 0,
  insurance_value DECIMAL(18,4) DEFAULT 0,
  total_value     DECIMAL(18,4) DEFAULT 0,
  lc_no           VARCHAR(60),
  status_id       INT UNSIGNED,
  created_by      BIGINT UNSIGNED,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_ci (company_id,invoice_no),
  CONSTRAINT fk_ci__company   FOREIGN KEY (company_id)     REFERENCES mst_company(id),
  CONSTRAINT fk_ci__so        FOREIGN KEY (so_id)          REFERENCES trx_sales_order(id),
  CONSTRAINT fk_ci__dispatch  FOREIGN KEY (dispatch_id)    REFERENCES trx_dispatch(id),
  CONSTRAINT fk_ci__buyer     FOREIGN KEY (buyer_id)       REFERENCES mst_party(id),
  CONSTRAINT fk_ci__consignee FOREIGN KEY (consignee_id)   REFERENCES mst_party(id),
  CONSTRAINT fk_ci__cur       FOREIGN KEY (currency_id)    REFERENCES cfg_currency(id),
  CONSTRAINT fk_ci__origin    FOREIGN KEY (country_origin) REFERENCES cfg_country(id),
  CONSTRAINT fk_ci__dest      FOREIGN KEY (country_dest)   REFERENCES cfg_country(id),
  CONSTRAINT fk_ci__status    FOREIGN KEY (status_id)      REFERENCES cfg_status(id)
) ENGINE=InnoDB COMMENT='Commercial invoice (export)';

CREATE TABLE trx_commercial_invoice_line (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  invoice_id      BIGINT UNSIGNED NOT NULL,
  style_id        BIGINT UNSIGNED,
  sku_id          BIGINT UNSIGNED,
  description     VARCHAR(255),
  hsn_code        VARCHAR(10),
  qty             INT UNSIGNED NOT NULL,
  unit_price      DECIMAL(18,4) NOT NULL,
  amount          DECIMAL(18,4) NOT NULL,
  CONSTRAINT fk_cil__ci    FOREIGN KEY (invoice_id) REFERENCES trx_commercial_invoice(id),
  CONSTRAINT fk_cil__style FOREIGN KEY (style_id)   REFERENCES mst_style(id),
  CONSTRAINT fk_cil__sku   FOREIGN KEY (sku_id)     REFERENCES mst_style_sku(id)
) ENGINE=InnoDB COMMENT='Commercial invoice lines';

CREATE TABLE trx_packing_list (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  pl_no           VARCHAR(40) NOT NULL,
  pl_date         DATE NOT NULL,
  invoice_id      BIGINT UNSIGNED NOT NULL,
  packing_id      BIGINT UNSIGNED,
  total_cartons   INT UNSIGNED,
  total_qty       INT UNSIGNED,
  net_weight_kg   DECIMAL(12,3),
  gross_weight_kg DECIMAL(12,3),
  total_cbm       DECIMAL(12,5),
  created_by      BIGINT UNSIGNED,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_pl (company_id,pl_no),
  CONSTRAINT fk_pl__company FOREIGN KEY (company_id) REFERENCES mst_company(id),
  CONSTRAINT fk_pl__ci      FOREIGN KEY (invoice_id) REFERENCES trx_commercial_invoice(id),
  CONSTRAINT fk_pl__pack    FOREIGN KEY (packing_id) REFERENCES trx_packing(id)
) ENGINE=InnoDB COMMENT='Export packing list';

CREATE TABLE trx_shipping_bill (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  sb_no           VARCHAR(40) NOT NULL,
  sb_date         DATE NOT NULL,
  invoice_id      BIGINT UNSIGNED NOT NULL,
  port_code       VARCHAR(20),            -- ICEGATE port code
  cha_name        VARCHAR(150),           -- customs house agent
  cha_ref         VARCHAR(60),
  leo_date        DATE,                   -- Let Export Order date
  scheme_code     VARCHAR(20),            -- drawback / RoDTEP scheme
  drawback_amount DECIMAL(18,4) DEFAULT 0,
  rodtep_amount   DECIMAL(18,4) DEFAULT 0,
  fob_inr         DECIMAL(18,2),
  status_id       INT UNSIGNED,
  created_by      BIGINT UNSIGNED,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_sb (company_id,sb_no),
  CONSTRAINT fk_sb__company FOREIGN KEY (company_id) REFERENCES mst_company(id),
  CONSTRAINT fk_sb__ci      FOREIGN KEY (invoice_id) REFERENCES trx_commercial_invoice(id),
  CONSTRAINT fk_sb__status  FOREIGN KEY (status_id)  REFERENCES cfg_status(id)
) ENGINE=InnoDB COMMENT='Shipping bill (customs)';

CREATE TABLE mst_certificate_type (
  id              INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  cert_code       VARCHAR(30) NOT NULL,   -- COO, GSP, GOTS, OEKOTEX, FUMIGATION
  cert_name       VARCHAR(120) NOT NULL,
  issuing_body    VARCHAR(120),
  is_active       TINYINT(1) NOT NULL DEFAULT 1,
  UNIQUE KEY uq_certtype (company_id,cert_code),
  CONSTRAINT fk_certtype__company FOREIGN KEY (company_id) REFERENCES mst_company(id)
) ENGINE=InnoDB COMMENT='Certificate type master';

CREATE TABLE trx_certificate (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  cert_type_id    INT UNSIGNED NOT NULL,
  cert_no         VARCHAR(60) NOT NULL,
  invoice_id      BIGINT UNSIGNED,
  so_id           BIGINT UNSIGNED,
  issue_date      DATE,
  expiry_date     DATE,
  issuing_body    VARCHAR(120),
  doc_id          BIGINT UNSIGNED,        -- mst_document
  status_id       INT UNSIGNED,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_cert (company_id,cert_type_id,cert_no),
  CONSTRAINT fk_cert__company FOREIGN KEY (company_id)   REFERENCES mst_company(id),
  CONSTRAINT fk_cert__type    FOREIGN KEY (cert_type_id) REFERENCES mst_certificate_type(id),
  CONSTRAINT fk_cert__ci      FOREIGN KEY (invoice_id)   REFERENCES trx_commercial_invoice(id),
  CONSTRAINT fk_cert__so      FOREIGN KEY (so_id)        REFERENCES trx_sales_order(id),
  CONSTRAINT fk_cert__doc     FOREIGN KEY (doc_id)       REFERENCES mst_document(id)
) ENGINE=InnoDB COMMENT='Export certificates (COO/GSP/GOTS...)';

-- Shipment / BL and tracking
CREATE TABLE trx_shipment (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  shipment_no     VARCHAR(40) NOT NULL,
  invoice_id      BIGINT UNSIGNED,
  dispatch_id     BIGINT UNSIGNED,
  shipping_bill_id BIGINT UNSIGNED,
  forwarder_id    BIGINT UNSIGNED,        -- party
  shipping_line   VARCHAR(120),
  vessel_name     VARCHAR(120),
  voyage_no       VARCHAR(40),
  bl_no           VARCHAR(60),            -- bill of lading / AWB
  bl_date         DATE,
  etd             DATE,                   -- estimated departure
  eta             DATE,                   -- estimated arrival
  atd             DATE,                   -- actual departure
  ata             DATE,                   -- actual arrival
  pol             VARCHAR(80),            -- port of loading
  pod             VARCHAR(80),            -- port of discharge
  tracking_status ENUM('BOOKED','GATED_IN','LOADED','SAILED','TRANSIT','ARRIVED','DELIVERED') DEFAULT 'BOOKED',
  status_id       INT UNSIGNED,
  created_by      BIGINT UNSIGNED,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_shipment (company_id,shipment_no),
  CONSTRAINT fk_ship__company   FOREIGN KEY (company_id)       REFERENCES mst_company(id),
  CONSTRAINT fk_ship__ci        FOREIGN KEY (invoice_id)       REFERENCES trx_commercial_invoice(id),
  CONSTRAINT fk_ship__dispatch  FOREIGN KEY (dispatch_id)      REFERENCES trx_dispatch(id),
  CONSTRAINT fk_ship__sb        FOREIGN KEY (shipping_bill_id) REFERENCES trx_shipping_bill(id),
  CONSTRAINT fk_ship__forwarder FOREIGN KEY (forwarder_id)     REFERENCES mst_party(id),
  CONSTRAINT fk_ship__status    FOREIGN KEY (status_id)        REFERENCES cfg_status(id)
) ENGINE=InnoDB COMMENT='Shipment / BL + tracking';

CREATE TABLE trx_shipment_event (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  shipment_id     BIGINT UNSIGNED NOT NULL,
  event_type      VARCHAR(60) NOT NULL,
  event_location  VARCHAR(120),
  event_time      DATETIME,
  remarks         VARCHAR(255),
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_shipev__ship FOREIGN KEY (shipment_id) REFERENCES trx_shipment(id)
) ENGINE=InnoDB COMMENT='Shipment tracking events';
