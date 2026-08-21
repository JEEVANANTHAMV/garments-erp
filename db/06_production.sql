-- =====================================================================
-- 10. PRODUCTION PLANNING & MANUFACTURING
--     Plan → Production Order → Cutting → Printing → Embroidery →
--     Washing → Stitching → Finishing → Packing  (+ WIP tracking)
-- =====================================================================

-- Production plan (Time & Action / capacity plan)
CREATE TABLE trx_production_plan (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  plan_no         VARCHAR(40) NOT NULL,
  plan_date       DATE NOT NULL,
  so_id           BIGINT UNSIGNED NOT NULL,
  unit_id         BIGINT UNSIGNED,
  plan_start      DATE,
  plan_end        DATE,
  status_id       INT UNSIGNED,
  remarks         VARCHAR(500),
  created_by      BIGINT UNSIGNED,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_plan (company_id,plan_no),
  CONSTRAINT fk_plan__company FOREIGN KEY (company_id) REFERENCES mst_company(id),
  CONSTRAINT fk_plan__so      FOREIGN KEY (so_id)      REFERENCES trx_sales_order(id),
  CONSTRAINT fk_plan__unit    FOREIGN KEY (unit_id)    REFERENCES mst_unit(id),
  CONSTRAINT fk_plan__status  FOREIGN KEY (status_id)  REFERENCES cfg_status(id)
) ENGINE=InnoDB COMMENT='Production plan header (T&A)';

-- Time & Action milestone calendar
CREATE TABLE trx_plan_milestone (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  plan_id         BIGINT UNSIGNED NOT NULL,
  milestone       VARCHAR(80) NOT NULL,   -- PP Approval, Fabric In, Cut Start...
  planned_date    DATE,
  actual_date     DATE,
  is_critical     TINYINT(1) NOT NULL DEFAULT 0,
  status          ENUM('PENDING','ON_TRACK','DELAYED','DONE') DEFAULT 'PENDING',
  CONSTRAINT fk_pmile__plan FOREIGN KEY (plan_id) REFERENCES trx_production_plan(id)
) ENGINE=InnoDB COMMENT='T&A milestone tracking';

-- Production Order (work order for a style/qty at a unit)
CREATE TABLE trx_production_order (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  po_prod_no      VARCHAR(40) NOT NULL,
  prod_date       DATE NOT NULL,
  so_id           BIGINT UNSIGNED NOT NULL,
  so_line_id      BIGINT UNSIGNED,
  plan_id         BIGINT UNSIGNED,
  style_id        BIGINT UNSIGNED NOT NULL,
  color_id        BIGINT UNSIGNED,
  unit_id         BIGINT UNSIGNED,
  order_qty       INT UNSIGNED NOT NULL,
  planned_qty     INT UNSIGNED,
  produced_qty    INT UNSIGNED DEFAULT 0,
  is_jobwork      TINYINT(1) NOT NULL DEFAULT 0,
  vendor_id       BIGINT UNSIGNED,        -- if outsourced (CMT)
  status_id       INT UNSIGNED,           -- domain PROD_ORDER
  approval_state  ENUM('DRAFT','APPROVED','IN_PROGRESS','COMPLETED','CLOSED','CANCELLED') DEFAULT 'DRAFT',
  remarks         VARCHAR(500),
  created_by      BIGINT UNSIGNED,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by      BIGINT UNSIGNED,
  updated_at      DATETIME ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_prodorder (company_id,po_prod_no),
  KEY ix_prod_so (so_id),
  CONSTRAINT fk_prod__company FOREIGN KEY (company_id) REFERENCES mst_company(id),
  CONSTRAINT fk_prod__so      FOREIGN KEY (so_id)      REFERENCES trx_sales_order(id),
  CONSTRAINT fk_prod__soline  FOREIGN KEY (so_line_id) REFERENCES trx_sales_order_line(id),
  CONSTRAINT fk_prod__plan    FOREIGN KEY (plan_id)    REFERENCES trx_production_plan(id),
  CONSTRAINT fk_prod__style   FOREIGN KEY (style_id)   REFERENCES mst_style(id),
  CONSTRAINT fk_prod__color   FOREIGN KEY (color_id)   REFERENCES mst_color(id),
  CONSTRAINT fk_prod__unit    FOREIGN KEY (unit_id)    REFERENCES mst_unit(id),
  CONSTRAINT fk_prod__vendor  FOREIGN KEY (vendor_id)  REFERENCES mst_party(id),
  CONSTRAINT fk_prod__status  FOREIGN KEY (status_id)  REFERENCES cfg_status(id)
) ENGINE=InnoDB COMMENT='Production / work order';

-- Now wire material issue → production order
ALTER TABLE trx_material_issue
  ADD CONSTRAINT fk_iss__prod FOREIGN KEY (prod_order_id) REFERENCES trx_production_order(id);

-- Generic process-stage master (data-driven routing)
CREATE TABLE cfg_process_stage (
  id              INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  stage_code      VARCHAR(30) NOT NULL,   -- KNIT, DYE, CUT, PRINT, EMB, WASH, STITCH, FINISH, PACK
  stage_name      VARCHAR(80) NOT NULL,
  sort_order      INT DEFAULT 0,
  is_outsourceable TINYINT(1) NOT NULL DEFAULT 1,
  is_active       TINYINT(1) NOT NULL DEFAULT 1,
  UNIQUE KEY uq_stage (company_id,stage_code),
  CONSTRAINT fk_stage__company FOREIGN KEY (company_id) REFERENCES mst_company(id)
) ENGINE=InnoDB COMMENT='Process stage master (routing)';

-- Universal WIP movement between stages / units / vendors
CREATE TABLE trx_process_transaction (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  prod_order_id   BIGINT UNSIGNED NOT NULL,
  stage_id        INT UNSIGNED NOT NULL,
  txn_no          VARCHAR(40) NOT NULL,
  txn_date        DATE NOT NULL,
  from_unit       BIGINT UNSIGNED,
  to_unit         BIGINT UNSIGNED,
  vendor_id       BIGINT UNSIGNED,        -- jobwork contractor
  input_qty       INT UNSIGNED DEFAULT 0,
  output_qty      INT UNSIGNED DEFAULT 0,
  rejected_qty    INT UNSIGNED DEFAULT 0,
  received_qty    INT UNSIGNED DEFAULT 0, -- back from vendor
  jobwork_rate    DECIMAL(18,4) DEFAULT 0,
  status_id       INT UNSIGNED,
  remarks         VARCHAR(500),
  created_by      BIGINT UNSIGNED,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_proctxn (company_id,txn_no),
  KEY ix_proctxn_po (prod_order_id,stage_id),
  CONSTRAINT fk_ptx__company FOREIGN KEY (company_id)    REFERENCES mst_company(id),
  CONSTRAINT fk_ptx__prod    FOREIGN KEY (prod_order_id) REFERENCES trx_production_order(id),
  CONSTRAINT fk_ptx__stage   FOREIGN KEY (stage_id)      REFERENCES cfg_process_stage(id),
  CONSTRAINT fk_ptx__fromu   FOREIGN KEY (from_unit)     REFERENCES mst_unit(id),
  CONSTRAINT fk_ptx__tou     FOREIGN KEY (to_unit)       REFERENCES mst_unit(id),
  CONSTRAINT fk_ptx__vendor  FOREIGN KEY (vendor_id)     REFERENCES mst_party(id),
  CONSTRAINT fk_ptx__status  FOREIGN KEY (status_id)     REFERENCES cfg_status(id)
) ENGINE=InnoDB COMMENT='Generic WIP/jobwork movement between stages';

-- ---------- CUTTING ----------
CREATE TABLE trx_cutting (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  cut_no          VARCHAR(40) NOT NULL,
  cut_date        DATE NOT NULL,
  prod_order_id   BIGINT UNSIGNED NOT NULL,
  fabric_id       BIGINT UNSIGNED,
  batch_id        BIGINT UNSIGNED,
  lay_length_m    DECIMAL(10,3),
  ply_count       INT UNSIGNED,
  marker_ref      VARCHAR(60),
  marker_eff_pct  DECIMAL(6,3),
  fabric_used_kg  DECIMAL(12,4),
  total_pieces    INT UNSIGNED DEFAULT 0,
  status_id       INT UNSIGNED,
  created_by      BIGINT UNSIGNED,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_cut (company_id,cut_no),
  CONSTRAINT fk_cut__company FOREIGN KEY (company_id)    REFERENCES mst_company(id),
  CONSTRAINT fk_cut__prod    FOREIGN KEY (prod_order_id) REFERENCES trx_production_order(id),
  CONSTRAINT fk_cut__fabric  FOREIGN KEY (fabric_id)     REFERENCES mst_fabric(id),
  CONSTRAINT fk_cut__batch   FOREIGN KEY (batch_id)      REFERENCES mst_batch(id),
  CONSTRAINT fk_cut__status  FOREIGN KEY (status_id)     REFERENCES cfg_status(id)
) ENGINE=InnoDB COMMENT='Cutting header (lay/marker)';

-- Cut bundles (size-wise bundle tracking with barcode)
CREATE TABLE trx_cutting_bundle (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  cutting_id      BIGINT UNSIGNED NOT NULL,
  sku_id          BIGINT UNSIGNED NOT NULL,
  bundle_no       VARCHAR(40) NOT NULL,
  qty             INT UNSIGNED NOT NULL,
  barcode         VARCHAR(80),
  UNIQUE KEY uq_bundle (cutting_id,bundle_no),
  CONSTRAINT fk_cutb__cut FOREIGN KEY (cutting_id) REFERENCES trx_cutting(id),
  CONSTRAINT fk_cutb__sku FOREIGN KEY (sku_id)     REFERENCES mst_style_sku(id)
) ENGINE=InnoDB COMMENT='Cut bundles (size-wise)';

-- ---------- PRINTING ----------
CREATE TABLE trx_printing (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  print_no        VARCHAR(40) NOT NULL,
  print_date      DATE NOT NULL,
  prod_order_id   BIGINT UNSIGNED NOT NULL,
  print_type      ENUM('SCREEN','DIGITAL','SUBLIMATION','RUBBER','DISCHARGE','FOIL','PUFF','OTHER') NOT NULL,
  placement       VARCHAR(80),            -- front, back, sleeve
  no_of_colors    TINYINT,
  vendor_id       BIGINT UNSIGNED,
  input_qty       INT UNSIGNED DEFAULT 0,
  output_qty      INT UNSIGNED DEFAULT 0,
  rejected_qty    INT UNSIGNED DEFAULT 0,
  rate            DECIMAL(18,4) DEFAULT 0,
  status_id       INT UNSIGNED,
  created_by      BIGINT UNSIGNED,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_print (company_id,print_no),
  CONSTRAINT fk_prt__company FOREIGN KEY (company_id)    REFERENCES mst_company(id),
  CONSTRAINT fk_prt__prod    FOREIGN KEY (prod_order_id) REFERENCES trx_production_order(id),
  CONSTRAINT fk_prt__vendor  FOREIGN KEY (vendor_id)     REFERENCES mst_party(id),
  CONSTRAINT fk_prt__status  FOREIGN KEY (status_id)     REFERENCES cfg_status(id)
) ENGINE=InnoDB COMMENT='Printing process';

-- ---------- EMBROIDERY ----------
CREATE TABLE trx_embroidery (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  emb_no          VARCHAR(40) NOT NULL,
  emb_date        DATE NOT NULL,
  prod_order_id   BIGINT UNSIGNED NOT NULL,
  design_ref      VARCHAR(60),
  stitch_count    INT UNSIGNED,
  placement       VARCHAR(80),
  vendor_id       BIGINT UNSIGNED,
  input_qty       INT UNSIGNED DEFAULT 0,
  output_qty      INT UNSIGNED DEFAULT 0,
  rejected_qty    INT UNSIGNED DEFAULT 0,
  rate            DECIMAL(18,4) DEFAULT 0,
  status_id       INT UNSIGNED,
  created_by      BIGINT UNSIGNED,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_emb (company_id,emb_no),
  CONSTRAINT fk_emb__company FOREIGN KEY (company_id)    REFERENCES mst_company(id),
  CONSTRAINT fk_emb__prod    FOREIGN KEY (prod_order_id) REFERENCES trx_production_order(id),
  CONSTRAINT fk_emb__vendor  FOREIGN KEY (vendor_id)     REFERENCES mst_party(id),
  CONSTRAINT fk_emb__status  FOREIGN KEY (status_id)     REFERENCES cfg_status(id)
) ENGINE=InnoDB COMMENT='Embroidery process';

-- ---------- WASHING ----------
CREATE TABLE trx_washing (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  wash_no         VARCHAR(40) NOT NULL,
  wash_date       DATE NOT NULL,
  prod_order_id   BIGINT UNSIGNED NOT NULL,
  wash_type       ENUM('NORMAL','ENZYME','STONE','ACID','BLEACH','GARMENT_DYE','SILICON','OTHER') NOT NULL,
  vendor_id       BIGINT UNSIGNED,
  input_qty       INT UNSIGNED DEFAULT 0,
  output_qty      INT UNSIGNED DEFAULT 0,
  rejected_qty    INT UNSIGNED DEFAULT 0,
  shrinkage_pct   DECIMAL(6,3),
  rate            DECIMAL(18,4) DEFAULT 0,
  status_id       INT UNSIGNED,
  created_by      BIGINT UNSIGNED,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_wash (company_id,wash_no),
  CONSTRAINT fk_wsh__company FOREIGN KEY (company_id)    REFERENCES mst_company(id),
  CONSTRAINT fk_wsh__prod    FOREIGN KEY (prod_order_id) REFERENCES trx_production_order(id),
  CONSTRAINT fk_wsh__vendor  FOREIGN KEY (vendor_id)     REFERENCES mst_party(id),
  CONSTRAINT fk_wsh__status  FOREIGN KEY (status_id)     REFERENCES cfg_status(id)
) ENGINE=InnoDB COMMENT='Washing process';

-- ---------- STITCHING (sewing lines) ----------
CREATE TABLE trx_stitching (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  stitch_no       VARCHAR(40) NOT NULL,
  stitch_date     DATE NOT NULL,
  prod_order_id   BIGINT UNSIGNED NOT NULL,
  unit_id         BIGINT UNSIGNED,
  line_no         VARCHAR(20),
  vendor_id       BIGINT UNSIGNED,        -- CMT contractor
  input_qty       INT UNSIGNED DEFAULT 0,
  output_qty      INT UNSIGNED DEFAULT 0,
  rejected_qty    INT UNSIGNED DEFAULT 0,
  smv             DECIMAL(8,3),           -- standard minute value
  rate            DECIMAL(18,4) DEFAULT 0,
  status_id       INT UNSIGNED,
  created_by      BIGINT UNSIGNED,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_stitch (company_id,stitch_no),
  CONSTRAINT fk_stc__company FOREIGN KEY (company_id)    REFERENCES mst_company(id),
  CONSTRAINT fk_stc__prod    FOREIGN KEY (prod_order_id) REFERENCES trx_production_order(id),
  CONSTRAINT fk_stc__unit    FOREIGN KEY (unit_id)       REFERENCES mst_unit(id),
  CONSTRAINT fk_stc__vendor  FOREIGN KEY (vendor_id)     REFERENCES mst_party(id),
  CONSTRAINT fk_stc__status  FOREIGN KEY (status_id)     REFERENCES cfg_status(id)
) ENGINE=InnoDB COMMENT='Stitching / sewing process';

CREATE TABLE trx_stitching_output (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  stitching_id    BIGINT UNSIGNED NOT NULL,
  sku_id          BIGINT UNSIGNED NOT NULL,
  bundle_id       BIGINT UNSIGNED,
  qty             INT UNSIGNED NOT NULL,
  CONSTRAINT fk_sto__stitch FOREIGN KEY (stitching_id) REFERENCES trx_stitching(id),
  CONSTRAINT fk_sto__sku    FOREIGN KEY (sku_id)       REFERENCES mst_style_sku(id),
  CONSTRAINT fk_sto__bundle FOREIGN KEY (bundle_id)    REFERENCES trx_cutting_bundle(id)
) ENGINE=InnoDB COMMENT='Stitching size-wise output';

-- ---------- FINISHING ----------
CREATE TABLE trx_finishing (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  finish_no       VARCHAR(40) NOT NULL,
  finish_date     DATE NOT NULL,
  prod_order_id   BIGINT UNSIGNED NOT NULL,
  unit_id         BIGINT UNSIGNED,
  activity        SET('TRIMMING','IRONING','CHECKING','TAGGING','FOLDING','GET_UP') ,
  input_qty       INT UNSIGNED DEFAULT 0,
  output_qty      INT UNSIGNED DEFAULT 0,
  rejected_qty    INT UNSIGNED DEFAULT 0,
  status_id       INT UNSIGNED,
  created_by      BIGINT UNSIGNED,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_finish (company_id,finish_no),
  CONSTRAINT fk_fin__company FOREIGN KEY (company_id)    REFERENCES mst_company(id),
  CONSTRAINT fk_fin__prod    FOREIGN KEY (prod_order_id) REFERENCES trx_production_order(id),
  CONSTRAINT fk_fin__unit    FOREIGN KEY (unit_id)       REFERENCES mst_unit(id),
  CONSTRAINT fk_fin__status  FOREIGN KEY (status_id)     REFERENCES cfg_status(id)
) ENGINE=InnoDB COMMENT='Finishing process';
