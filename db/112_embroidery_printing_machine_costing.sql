-- 112: Embroidery + Printing machine output & costing (client documents
--      "Embroidery / Printing – Machine Output & Costing Developer Document" v1.0, voice note 13-Oct-2026).
--
-- Process DCs (outward / inward) already move the cut panels / garments to and from embroidery and printing.
-- This adds what happens on the machine: one engine for both processes, the process is a column (process_kind):
--   machine master + effective-dated rates → design / artwork (versioned) → recipe (versioned, thread / dyes /
--   chemicals per piece, per base qty or per 1,000 stitches) → job (approved design + recipe, optional DC link)
--   → material issue / return from trims stock lots → production entry (machine, heads, timings, downtime,
--   input / good / reject / rework with reasons, actual consumption) → Draft → Submitted → Approved / Rejected
--   → Cancelled, with a costing snapshot (material + machine + labour + overhead + other) kept on approval.
-- Re-runnable; every ALTER is guarded.

-- Trims master: embroidery / printing consumables are stocked as trims (thread, backing, topping, dyes …).
-- Widening only — every existing value stays.
ALTER TABLE mst_trim MODIFY trim_type ENUM('BUTTON','ZIPPER','LABEL','THREAD','ELASTIC','DRAWCORD',
  'HANGTAG','STICKER','POLYBAG','CARTON','HANGER','TAPE','RIVET','VELCRO','LACE','OTHER',
  'BOBBIN_THREAD','BACKING','TOPPING','ADHESIVE','NEEDLE','DYE','PIGMENT','INK','BINDER','CHEMICAL') NOT NULL;

-- ---------------------------------------------------------------- machine master
CREATE TABLE IF NOT EXISTS mst_mp_machine (
  id                     BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id             BIGINT UNSIGNED NOT NULL,
  process_kind           ENUM('EMBROIDERY','PRINTING') NOT NULL,
  machine_code           VARCHAR(40) NOT NULL,
  machine_name           VARCHAR(120) NOT NULL,
  machine_type           VARCHAR(30) NOT NULL COMMENT 'EMB: SINGLE_HEAD / MULTI_HEAD / COMPUTERIZED / MANUAL; PRT: FLAT_BED / ROTARY / AUTOMATIC / MANUAL / DIGITAL',
  head_count             INT UNSIGNED NOT NULL DEFAULT 1,
  needle_count           INT UNSIGNED NULL COMMENT 'needles per head (embroidery)',
  no_of_colors           INT UNSIGNED NULL COMMENT 'max printing colours',
  capacity_stitches_hour DECIMAL(18,4) NULL COMMENT 'standard stitches / hour (whole machine)',
  capacity_per_hour      DECIMAL(18,4) NULL COMMENT 'standard output / hour in capacity_uom',
  capacity_uom           ENUM('PCS','KG','MTR') NOT NULL DEFAULT 'PCS',
  setup_time_minutes     INT UNSIGNED NULL,
  location               VARCHAR(80) NULL,
  remarks                VARCHAR(255) NULL,
  is_active              TINYINT(1) NOT NULL DEFAULT 1,
  created_by             BIGINT UNSIGNED NULL,
  created_at             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by             BIGINT UNSIGNED NULL,
  updated_at             DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_mp_machine (company_id, process_kind, machine_code),
  CONSTRAINT fk_mp_machine__company FOREIGN KEY (company_id) REFERENCES mst_company(id)
) ENGINE=InnoDB COMMENT='Embroidery / printing machine master';

-- Effective-dated machine + labour rates: a production is costed with the rate in force on its date,
-- so a later rate change never alters historical costing (doc §26 / §28).
CREATE TABLE IF NOT EXISTS mst_mp_machine_rate (
  id                     BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  machine_id             BIGINT UNSIGNED NOT NULL,
  effective_from         DATE NOT NULL,
  costing_method         ENUM('MACHINE_HOUR','COMPONENT') NOT NULL DEFAULT 'COMPONENT'
                         COMMENT 'MACHINE_HOUR: machine cost = hours x machine_hour_rate; COMPONENT: hours x (depreciation + electricity + maintenance)',
  rate_basis             ENUM('MACHINE','HEAD') NOT NULL DEFAULT 'MACHINE' COMMENT 'HEAD: machine rates are per head-hour x heads used',
  machine_hour_rate      DECIMAL(18,4) NOT NULL DEFAULT 0,
  depreciation_rate_hour DECIMAL(18,4) NOT NULL DEFAULT 0,
  electricity_rate_hour  DECIMAL(18,4) NOT NULL DEFAULT 0,
  maintenance_rate_hour  DECIMAL(18,4) NOT NULL DEFAULT 0,
  overhead_basis         ENUM('HOUR','PERCENT') NOT NULL DEFAULT 'HOUR',
  overhead_rate_hour     DECIMAL(18,4) NOT NULL DEFAULT 0,
  overhead_pct           DECIMAL(9,4) NOT NULL DEFAULT 0 COMMENT 'PERCENT basis: % of material + machine + labour',
  operator_rate_hour     DECIMAL(18,4) NOT NULL DEFAULT 0,
  helper_rate_hour       DECIMAL(18,4) NOT NULL DEFAULT 0,
  remarks                VARCHAR(255) NULL,
  created_by             BIGINT UNSIGNED NULL,
  created_at             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_mp_rate (machine_id, effective_from),
  CONSTRAINT fk_mp_rate__machine FOREIGN KEY (machine_id) REFERENCES mst_mp_machine(id)
) ENGINE=InnoDB COMMENT='Effective-dated machine / labour / overhead rates';

-- ---------------------------------------------------------------- reasons (downtime / reject / rework)
CREATE TABLE IF NOT EXISTS mst_mp_reason (
  id            BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id    BIGINT UNSIGNED NOT NULL,
  process_kind  ENUM('EMBROIDERY','PRINTING') NOT NULL,
  reason_type   ENUM('DOWNTIME','REJECT') NOT NULL COMMENT 'REJECT reasons are used for reject and rework',
  reason_code   VARCHAR(20) NOT NULL,
  reason_name   VARCHAR(120) NOT NULL,
  needs_approval TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'downtime of this reason needs supervisor approval',
  sort_order    INT NOT NULL DEFAULT 0,
  is_active     TINYINT(1) NOT NULL DEFAULT 1,
  UNIQUE KEY uq_mp_reason (company_id, process_kind, reason_type, reason_code),
  CONSTRAINT fk_mp_reason__company FOREIGN KEY (company_id) REFERENCES mst_company(id)
) ENGINE=InnoDB COMMENT='Embroidery / printing downtime and reject / rework reason master';

INSERT IGNORE INTO mst_mp_reason (company_id, process_kind, reason_type, reason_code, reason_name, sort_order)
SELECT c.id, r.k, r.t, r.code, r.name, r.so FROM mst_company c JOIN (
  SELECT 'EMBROIDERY' k, 'DOWNTIME' t, 'E01' code, 'Machine Breakdown' name, 1 so UNION ALL
  SELECT 'EMBROIDERY','DOWNTIME','E02','Thread Break',2 UNION ALL
  SELECT 'EMBROIDERY','DOWNTIME','E03','Needle Change',3 UNION ALL
  SELECT 'EMBROIDERY','DOWNTIME','E04','Design / Program Change',4 UNION ALL
  SELECT 'EMBROIDERY','DOWNTIME','E05','Hooping / Frame Change',5 UNION ALL
  SELECT 'EMBROIDERY','DOWNTIME','E06','Material Waiting',6 UNION ALL
  SELECT 'EMBROIDERY','DOWNTIME','E07','Operator Waiting',7 UNION ALL
  SELECT 'EMBROIDERY','DOWNTIME','E08','Power Failure',8 UNION ALL
  SELECT 'EMBROIDERY','DOWNTIME','E09','Quality Hold',9 UNION ALL
  SELECT 'EMBROIDERY','DOWNTIME','E10','Maintenance',10 UNION ALL
  SELECT 'EMBROIDERY','DOWNTIME','E11','Other',11 UNION ALL
  SELECT 'EMBROIDERY','REJECT','ER01','Thread Break / Stitch Defect',1 UNION ALL
  SELECT 'EMBROIDERY','REJECT','ER02','Design Misalignment',2 UNION ALL
  SELECT 'EMBROIDERY','REJECT','ER03','Wrong Thread Color',3 UNION ALL
  SELECT 'EMBROIDERY','REJECT','ER04','Missing Stitch',4 UNION ALL
  SELECT 'EMBROIDERY','REJECT','ER05','Fabric Damage',5 UNION ALL
  SELECT 'EMBROIDERY','REJECT','ER06','Backing Problem',6 UNION ALL
  SELECT 'EMBROIDERY','REJECT','ER07','Hooping Mark',7 UNION ALL
  SELECT 'EMBROIDERY','REJECT','ER99','Other',99 UNION ALL
  SELECT 'PRINTING','DOWNTIME','M01','Machine Breakdown',1 UNION ALL
  SELECT 'PRINTING','DOWNTIME','M02','Screen Change',2 UNION ALL
  SELECT 'PRINTING','DOWNTIME','M03','Color Change',3 UNION ALL
  SELECT 'PRINTING','DOWNTIME','M04','Ink / Paste Preparation',4 UNION ALL
  SELECT 'PRINTING','DOWNTIME','M05','Material Waiting',5 UNION ALL
  SELECT 'PRINTING','DOWNTIME','M06','Operator Waiting',6 UNION ALL
  SELECT 'PRINTING','DOWNTIME','M07','Power Failure',7 UNION ALL
  SELECT 'PRINTING','DOWNTIME','M08','Quality Hold',8 UNION ALL
  SELECT 'PRINTING','DOWNTIME','M09','Maintenance',9 UNION ALL
  SELECT 'PRINTING','DOWNTIME','M10','Other',10 UNION ALL
  SELECT 'PRINTING','REJECT','PR01','Print Misalignment',1 UNION ALL
  SELECT 'PRINTING','REJECT','PR02','Shade Variation',2 UNION ALL
  SELECT 'PRINTING','REJECT','PR03','Crack / Poor Fixing',3 UNION ALL
  SELECT 'PRINTING','REJECT','PR04','Smudge',4 UNION ALL
  SELECT 'PRINTING','REJECT','PR05','Missing Print',5 UNION ALL
  SELECT 'PRINTING','REJECT','PR06','Fabric Damage',6 UNION ALL
  SELECT 'PRINTING','REJECT','PR99','Other',99
) r;

-- ---------------------------------------------------------------- design / artwork (versioned)
CREATE TABLE IF NOT EXISTS mst_mp_design (
  id                  BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id          BIGINT UNSIGNED NOT NULL,
  process_kind        ENUM('EMBROIDERY','PRINTING') NOT NULL,
  design_code         VARCHAR(40) NOT NULL,
  version_no          INT UNSIGNED NOT NULL DEFAULT 1,
  design_name         VARCHAR(150) NOT NULL,
  style_id            BIGINT UNSIGNED NULL,
  buyer_id            BIGINT UNSIGNED NULL,
  file_url            VARCHAR(300) NULL COMMENT 'DST / DSB / EMB or approved artwork upload',
  file_name           VARCHAR(200) NULL,
  total_stitches      INT UNSIGNED NULL,
  no_of_colors        INT UNSIGNED NULL,
  needle_sequence     VARCHAR(255) NULL,
  hoop_size           VARCHAR(60) NULL,
  std_minutes_per_pc  DECIMAL(18,4) NULL COMMENT 'standard machine minutes per piece',
  backing_type        VARCHAR(60) NULL,
  print_type          VARCHAR(40) NULL COMMENT 'PIGMENT / REACTIVE / DIGITAL / SCREEN / ROTARY …',
  placement           VARCHAR(60) NULL,
  status              ENUM('DRAFT','APPROVED','OBSOLETE') NOT NULL DEFAULT 'DRAFT',
  approved_by         BIGINT UNSIGNED NULL,
  approved_at         DATETIME NULL,
  remarks             VARCHAR(500) NULL,
  created_by          BIGINT UNSIGNED NULL,
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by          BIGINT UNSIGNED NULL,
  updated_at          DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_mp_design (company_id, process_kind, design_code, version_no),
  KEY ix_mp_design_style (style_id),
  CONSTRAINT fk_mp_design__company FOREIGN KEY (company_id) REFERENCES mst_company(id),
  CONSTRAINT fk_mp_design__style   FOREIGN KEY (style_id)   REFERENCES mst_style(id)
) ENGINE=InnoDB COMMENT='Embroidery design / program and print artwork, version controlled';

CREATE TABLE IF NOT EXISTS mst_mp_design_color (
  id           BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  design_id    BIGINT UNSIGNED NOT NULL,
  seq_no       INT UNSIGNED NOT NULL,
  needle_no    INT UNSIGNED NULL,
  color_name   VARCHAR(80) NOT NULL,
  trim_id      BIGINT UNSIGNED NULL COMMENT 'thread / ink item',
  stitches     INT UNSIGNED NULL,
  KEY ix_mp_dcol (design_id),
  CONSTRAINT fk_mp_dcol__design FOREIGN KEY (design_id) REFERENCES mst_mp_design(id) ON DELETE CASCADE,
  CONSTRAINT fk_mp_dcol__trim   FOREIGN KEY (trim_id)   REFERENCES mst_trim(id)
) ENGINE=InnoDB COMMENT='Thread colours / needle sequence of a design';

-- ---------------------------------------------------------------- recipe (versioned)
CREATE TABLE IF NOT EXISTS mst_mp_recipe (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  process_kind    ENUM('EMBROIDERY','PRINTING') NOT NULL,
  recipe_no       VARCHAR(40) NOT NULL,
  version_no      INT UNSIGNED NOT NULL DEFAULT 1,
  recipe_name     VARCHAR(150) NOT NULL,
  design_id       BIGINT UNSIGNED NULL,
  base_qty        DECIMAL(18,4) NOT NULL DEFAULT 1 COMMENT 'PER_BASE lines: standard qty is for this many units',
  base_uom        ENUM('PCS','KG','MTR') NOT NULL DEFAULT 'PCS',
  effective_from  DATE NULL,
  status          ENUM('DRAFT','APPROVED','OBSOLETE') NOT NULL DEFAULT 'DRAFT',
  approved_by     BIGINT UNSIGNED NULL,
  approved_at     DATETIME NULL,
  remarks         VARCHAR(500) NULL,
  created_by      BIGINT UNSIGNED NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by      BIGINT UNSIGNED NULL,
  updated_at      DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_mp_recipe (company_id, process_kind, recipe_no, version_no),
  CONSTRAINT fk_mp_recipe__company FOREIGN KEY (company_id) REFERENCES mst_company(id),
  CONSTRAINT fk_mp_recipe__design  FOREIGN KEY (design_id)  REFERENCES mst_mp_design(id)
) ENGINE=InnoDB COMMENT='Thread / consumable (embroidery) or dye / chemical (printing) recipe, version controlled';

CREATE TABLE IF NOT EXISTS mst_mp_recipe_item (
  id             BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  recipe_id      BIGINT UNSIGNED NOT NULL,
  seq_no         INT UNSIGNED NOT NULL DEFAULT 10,
  trim_id        BIGINT UNSIGNED NOT NULL,
  material_role  ENUM('THREAD','BOBBIN','BACKING','TOPPING','ADHESIVE','DYE','PIGMENT','CHEMICAL','BINDER','INK','OTHER') NOT NULL,
  basis          ENUM('PER_PIECE','PER_BASE','PER_1000_STITCH') NOT NULL DEFAULT 'PER_PIECE',
  std_qty        DECIMAL(18,6) NOT NULL COMMENT 'per piece / per recipe base qty / per 1,000 stitches',
  uom_id         SMALLINT UNSIGNED NOT NULL COMMENT 'consumption UOM (e.g. MTR of thread)',
  per_stock_unit DECIMAL(18,6) NOT NULL DEFAULT 1 COMMENT 'consumption UOM units in 1 stock (trim base) unit, e.g. 5000 MTR per CONE',
  loss_pct       DECIMAL(9,4) NOT NULL DEFAULT 0,
  remarks        VARCHAR(255) NULL,
  KEY ix_mp_ritem (recipe_id),
  CONSTRAINT fk_mp_ritem__recipe FOREIGN KEY (recipe_id) REFERENCES mst_mp_recipe(id) ON DELETE CASCADE,
  CONSTRAINT fk_mp_ritem__trim   FOREIGN KEY (trim_id)   REFERENCES mst_trim(id),
  CONSTRAINT fk_mp_ritem__uom    FOREIGN KEY (uom_id)    REFERENCES cfg_uom(id)
) ENGINE=InnoDB COMMENT='Recipe lines: standard consumption per basis with loss %';

-- ---------------------------------------------------------------- job / program
CREATE TABLE IF NOT EXISTS trx_mp_job (
  id               BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id       BIGINT UNSIGNED NOT NULL,
  process_kind     ENUM('EMBROIDERY','PRINTING') NOT NULL,
  job_no           VARCHAR(40) NOT NULL,
  job_date         DATE NOT NULL,
  so_id            BIGINT UNSIGNED NULL,
  io_no            VARCHAR(40) NULL,
  buyer_id         BIGINT UNSIGNED NULL,
  style_id         BIGINT UNSIGNED NULL,
  color_id         BIGINT UNSIGNED NULL,
  design_id        BIGINT UNSIGNED NULL,
  recipe_id        BIGINT UNSIGNED NULL,
  machine_id       BIGINT UNSIGNED NULL,
  challan_id       BIGINT UNSIGNED NULL COMMENT 'process DC (outward) the panels / garments came on',
  placement        VARCHAR(60) NULL,
  print_type       VARCHAR(40) NULL,
  input_type       ENUM('CUT_PANEL','GARMENT','FABRIC','OTHER') NOT NULL DEFAULT 'CUT_PANEL',
  planned_qty      DECIMAL(18,4) NOT NULL,
  uom              ENUM('PCS','KG','MTR') NOT NULL DEFAULT 'PCS',
  stitches_per_pc  INT UNSIGNED NULL COMMENT 'snapshot from the design version',
  planned_start    DATE NULL,
  planned_end      DATE NULL,
  status           ENUM('DRAFT','PLANNED','RUNNING','COMPLETED','CANCELLED') NOT NULL DEFAULT 'DRAFT',
  remarks          VARCHAR(500) NULL,
  completed_by     BIGINT UNSIGNED NULL,
  completed_at     DATETIME NULL,
  cancel_reason    VARCHAR(255) NULL,
  cancelled_by     BIGINT UNSIGNED NULL,
  cancelled_at     DATETIME NULL,
  created_by       BIGINT UNSIGNED NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by       BIGINT UNSIGNED NULL,
  updated_at       DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_mp_job (company_id, job_no),
  KEY ix_mp_job_kind (company_id, process_kind, status, job_date),
  KEY ix_mp_job_so (so_id), KEY ix_mp_job_io (io_no), KEY ix_mp_job_design (design_id), KEY ix_mp_job_machine (machine_id),
  KEY ix_mp_job_dc (challan_id),
  CONSTRAINT fk_mp_job__company FOREIGN KEY (company_id) REFERENCES mst_company(id),
  CONSTRAINT fk_mp_job__style   FOREIGN KEY (style_id)   REFERENCES mst_style(id),
  CONSTRAINT fk_mp_job__design  FOREIGN KEY (design_id)  REFERENCES mst_mp_design(id),
  CONSTRAINT fk_mp_job__recipe  FOREIGN KEY (recipe_id)  REFERENCES mst_mp_recipe(id),
  CONSTRAINT fk_mp_job__machine FOREIGN KEY (machine_id) REFERENCES mst_mp_machine(id)
) ENGINE=InnoDB COMMENT='Embroidery / printing job (program)';

-- ---------------------------------------------------------------- material issue / return (trims stock lots)
CREATE TABLE IF NOT EXISTS trx_mp_material_txn (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  process_kind    ENUM('EMBROIDERY','PRINTING') NOT NULL,
  txn_no          VARCHAR(40) NOT NULL,
  txn_type        ENUM('ISSUE','RETURN') NOT NULL,
  txn_date        DATE NOT NULL,
  job_id          BIGINT UNSIGNED NOT NULL,
  production_id   BIGINT UNSIGNED NULL COMMENT 'optional: issued for this production entry',
  trim_stock_id   BIGINT UNSIGNED NOT NULL,
  warehouse_id    BIGINT UNSIGNED NOT NULL,
  trim_id         BIGINT UNSIGNED NOT NULL,
  lot_no          VARCHAR(80) NULL,
  qty             DECIMAL(18,4) NOT NULL,
  uom_id          SMALLINT UNSIGNED NOT NULL,
  unit_cost       DECIMAL(18,4) NOT NULL DEFAULT 0,
  amount          DECIMAL(18,4) NOT NULL DEFAULT 0,
  status          ENUM('POSTED','CANCELLED') NOT NULL DEFAULT 'POSTED',
  remarks         VARCHAR(255) NULL,
  cancel_reason   VARCHAR(255) NULL,
  cancelled_by    BIGINT UNSIGNED NULL,
  cancelled_at    DATETIME NULL,
  created_by      BIGINT UNSIGNED NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_mp_mtxn_no (company_id, txn_no),
  KEY ix_mp_mtxn_job (job_id, trim_id), KEY ix_mp_mtxn_prod (production_id), KEY ix_mp_mtxn_date (txn_date),
  CONSTRAINT fk_mp_mtxn__job   FOREIGN KEY (job_id)        REFERENCES trx_mp_job(id),
  CONSTRAINT fk_mp_mtxn__stock FOREIGN KEY (trim_stock_id) REFERENCES trx_trim_stock(id),
  CONSTRAINT fk_mp_mtxn__trim  FOREIGN KEY (trim_id)       REFERENCES mst_trim(id),
  CONSTRAINT fk_mp_mtxn__uom   FOREIGN KEY (uom_id)        REFERENCES cfg_uom(id)
) ENGINE=InnoDB COMMENT='Thread / consumable / dye / chemical issue and return against a job (trims stock lot)';

-- ---------------------------------------------------------------- production entry
CREATE TABLE IF NOT EXISTS trx_mp_production (
  id                  BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id          BIGINT UNSIGNED NOT NULL,
  process_kind        ENUM('EMBROIDERY','PRINTING') NOT NULL,
  production_no       VARCHAR(40) NOT NULL,
  prod_date           DATE NOT NULL,
  shift_id            INT UNSIGNED NOT NULL,
  job_id              BIGINT UNSIGNED NOT NULL,
  machine_id          BIGINT UNSIGNED NOT NULL,
  heads_used          INT UNSIGNED NOT NULL DEFAULT 1,
  operator_name       VARCHAR(80) NULL,
  helper_name         VARCHAR(80) NULL,
  operator_count      DECIMAL(9,2) NOT NULL DEFAULT 1,
  helper_count        DECIMAL(9,2) NOT NULL DEFAULT 0,
  start_at            DATETIME NOT NULL,
  end_at              DATETIME NOT NULL,
  break_minutes       INT UNSIGNED NOT NULL DEFAULT 0,
  setup_minutes       INT UNSIGNED NOT NULL DEFAULT 0,
  downtime_minutes    INT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'sum of the downtime rows',
  input_qty           DECIMAL(18,4) NOT NULL DEFAULT 0,
  good_qty            DECIMAL(18,4) NOT NULL DEFAULT 0,
  reject_qty          DECIMAL(18,4) NOT NULL DEFAULT 0,
  rework_qty          DECIMAL(18,4) NOT NULL DEFAULT 0,
  adjustment_qty      DECIMAL(18,4) NOT NULL DEFAULT 0 COMMENT 'input - good - reject - rework (needs a reason when not 0)',
  adjustment_reason   VARCHAR(255) NULL,
  output_uom          ENUM('PCS','KG','MTR') NOT NULL DEFAULT 'PCS',
  good_weight_kg      DECIMAL(18,4) NULL COMMENT 'good output in KG for cost per KG',
  total_stitches      BIGINT UNSIGNED NULL COMMENT 'actual stitches (machine counter) — else good x stitches per piece',
  stitches_source     ENUM('COUNTER','MANUAL','DESIGN') NULL,
  other_cost          DECIMAL(18,4) NOT NULL DEFAULT 0,
  other_cost_reason   VARCHAR(255) NULL,
  rework_of_id        BIGINT UNSIGNED NULL COMMENT 'rework run of this original production (keeps the job reference)',
  over_plan           TINYINT(1) NOT NULL DEFAULT 0,
  over_plan_reason    VARCHAR(255) NULL,
  remarks             VARCHAR(500) NULL,
  status              ENUM('DRAFT','SUBMITTED','APPROVED','REJECTED','CANCELLED') NOT NULL DEFAULT 'DRAFT',
  submitted_by        BIGINT UNSIGNED NULL,
  submitted_at        DATETIME NULL,
  approved_by         BIGINT UNSIGNED NULL,
  approved_at         DATETIME NULL,
  rejected_by         BIGINT UNSIGNED NULL,
  rejected_at         DATETIME NULL,
  reject_remarks      VARCHAR(255) NULL,
  cancelled_by        BIGINT UNSIGNED NULL,
  cancelled_at        DATETIME NULL,
  cancel_reason       VARCHAR(255) NULL,
  created_by          BIGINT UNSIGNED NULL,
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by          BIGINT UNSIGNED NULL,
  updated_at          DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_mp_prod (company_id, production_no),
  KEY ix_mp_prod_kind (company_id, process_kind, prod_date, status),
  KEY ix_mp_prod_job (job_id), KEY ix_mp_prod_machine (machine_id, start_at),
  CONSTRAINT fk_mp_prod__company FOREIGN KEY (company_id) REFERENCES mst_company(id),
  CONSTRAINT fk_mp_prod__job     FOREIGN KEY (job_id)     REFERENCES trx_mp_job(id),
  CONSTRAINT fk_mp_prod__machine FOREIGN KEY (machine_id) REFERENCES mst_mp_machine(id),
  CONSTRAINT fk_mp_prod__shift   FOREIGN KEY (shift_id)   REFERENCES cfg_shift(id)
) ENGINE=InnoDB COMMENT='Embroidery / printing machine production entry';

CREATE TABLE IF NOT EXISTS trx_mp_production_output (
  id             BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  production_id  BIGINT UNSIGNED NOT NULL,
  output_type    ENUM('REJECT','REWORK') NOT NULL,
  reason_id      BIGINT UNSIGNED NOT NULL,
  qty            DECIMAL(18,4) NOT NULL,
  remarks        VARCHAR(255) NULL,
  KEY ix_mp_pout (production_id),
  CONSTRAINT fk_mp_pout__prod   FOREIGN KEY (production_id) REFERENCES trx_mp_production(id) ON DELETE CASCADE,
  CONSTRAINT fk_mp_pout__reason FOREIGN KEY (reason_id)     REFERENCES mst_mp_reason(id)
) ENGINE=InnoDB COMMENT='Reject / rework qty by reason';

CREATE TABLE IF NOT EXISTS trx_mp_downtime (
  id             BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  production_id  BIGINT UNSIGNED NOT NULL,
  reason_id      BIGINT UNSIGNED NOT NULL,
  start_at       DATETIME NULL,
  end_at         DATETIME NULL,
  minutes        INT UNSIGNED NOT NULL,
  remarks        VARCHAR(255) NULL,
  KEY ix_mp_dt (production_id),
  CONSTRAINT fk_mp_dt__prod   FOREIGN KEY (production_id) REFERENCES trx_mp_production(id) ON DELETE CASCADE,
  CONSTRAINT fk_mp_dt__reason FOREIGN KEY (reason_id)     REFERENCES mst_mp_reason(id)
) ENGINE=InnoDB COMMENT='Machine downtime of a production entry';

CREATE TABLE IF NOT EXISTS trx_mp_consumption (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  production_id   BIGINT UNSIGNED NOT NULL,
  trim_id         BIGINT UNSIGNED NOT NULL,
  recipe_item_id  BIGINT UNSIGNED NULL,
  material_role   VARCHAR(20) NULL,
  uom_id          SMALLINT UNSIGNED NOT NULL COMMENT 'consumption UOM',
  per_stock_unit  DECIMAL(18,6) NOT NULL DEFAULT 1 COMMENT 'consumption UOM units in 1 stock unit',
  standard_qty    DECIMAL(18,6) NOT NULL DEFAULT 0,
  issued_qty      DECIMAL(18,6) NOT NULL DEFAULT 0 COMMENT 'issued against this production entry (consumption UOM)',
  returned_qty    DECIMAL(18,6) NOT NULL DEFAULT 0,
  actual_qty      DECIMAL(18,6) NOT NULL DEFAULT 0,
  wastage_qty     DECIMAL(18,6) NOT NULL DEFAULT 0 COMMENT 'approved process loss (part of actual)',
  unit_cost       DECIMAL(18,6) NOT NULL DEFAULT 0 COMMENT 'per consumption UOM',
  total_cost      DECIMAL(18,4) NOT NULL DEFAULT 0,
  lot_nos         VARCHAR(255) NULL,
  KEY ix_mp_cons (production_id), KEY ix_mp_cons_trim (trim_id),
  CONSTRAINT fk_mp_cons__prod FOREIGN KEY (production_id) REFERENCES trx_mp_production(id) ON DELETE CASCADE,
  CONSTRAINT fk_mp_cons__trim FOREIGN KEY (trim_id)       REFERENCES mst_trim(id)
) ENGINE=InnoDB COMMENT='Standard vs actual material consumption of a production entry';

-- Costing snapshot: recalculated on every save / submit (is_final = 0); the approved one is frozen (is_final = 1)
CREATE TABLE IF NOT EXISTS trx_mp_costing (
  id                      BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  production_id           BIGINT UNSIGNED NOT NULL,
  machine_rate_id         BIGINT UNSIGNED NULL,
  rate_snapshot           JSON NULL,
  gross_minutes           DECIMAL(18,4) NOT NULL DEFAULT 0,
  net_run_hours           DECIMAL(18,4) NOT NULL DEFAULT 0,
  costing_hours           DECIMAL(18,4) NOT NULL DEFAULT 0,
  standard_hours          DECIMAL(18,4) NOT NULL DEFAULT 0,
  thread_cost             DECIMAL(18,4) NOT NULL DEFAULT 0 COMMENT 'embroidery thread / printing dyes + pigments + inks',
  consumable_cost         DECIMAL(18,4) NOT NULL DEFAULT 0 COMMENT 'embroidery backing etc. / printing chemicals + binders',
  material_cost           DECIMAL(18,4) NOT NULL DEFAULT 0,
  machine_cost            DECIMAL(18,4) NOT NULL DEFAULT 0,
  labour_cost             DECIMAL(18,4) NOT NULL DEFAULT 0,
  overhead_cost           DECIMAL(18,4) NOT NULL DEFAULT 0,
  other_cost              DECIMAL(18,4) NOT NULL DEFAULT 0,
  total_cost              DECIMAL(18,4) NOT NULL DEFAULT 0,
  std_material_cost       DECIMAL(18,4) NOT NULL DEFAULT 0,
  std_machine_cost        DECIMAL(18,4) NOT NULL DEFAULT 0,
  std_labour_cost         DECIMAL(18,4) NOT NULL DEFAULT 0,
  std_overhead_cost       DECIMAL(18,4) NOT NULL DEFAULT 0,
  std_total_cost          DECIMAL(18,4) NOT NULL DEFAULT 0,
  good_qty                DECIMAL(18,4) NOT NULL DEFAULT 0,
  good_weight_kg          DECIMAL(18,4) NULL,
  total_stitches          BIGINT UNSIGNED NULL,
  cost_per_unit           DECIMAL(18,4) NULL,
  cost_per_kg             DECIMAL(18,4) NULL,
  cost_per_1000_stitches  DECIMAL(18,4) NULL,
  output_per_hour         DECIMAL(18,4) NULL,
  stitches_per_hour       DECIMAL(18,4) NULL,
  efficiency_pct          DECIMAL(9,2) NULL,
  utilization_pct         DECIMAL(9,2) NULL,
  reject_pct              DECIMAL(9,2) NULL,
  rework_pct              DECIMAL(9,2) NULL,
  is_final                TINYINT(1) NOT NULL DEFAULT 0,
  calculated_by           BIGINT UNSIGNED NULL,
  calculated_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_mp_cost (production_id, is_final),
  CONSTRAINT fk_mp_cost__prod FOREIGN KEY (production_id) REFERENCES trx_mp_production(id)
) ENGINE=InnoDB COMMENT='Production costing snapshot (approved = frozen)';

CREATE TABLE IF NOT EXISTS trx_mp_approval (
  id             BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  production_id  BIGINT UNSIGNED NOT NULL,
  action         ENUM('SUBMIT','APPROVE','REJECT','CANCEL','REOPEN') NOT NULL,
  from_status    VARCHAR(20) NULL,
  to_status      VARCHAR(20) NOT NULL,
  remarks        VARCHAR(255) NULL,
  acted_by       BIGINT UNSIGNED NULL,
  acted_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_mp_appr (production_id),
  CONSTRAINT fk_mp_appr__prod FOREIGN KEY (production_id) REFERENCES trx_mp_production(id)
) ENGINE=InnoDB COMMENT='Production approval history';

-- Machine counter / stitch data import (source evidence, doc §10 / §33)
CREATE TABLE IF NOT EXISTS trx_mp_machine_counter (
  id             BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id     BIGINT UNSIGNED NOT NULL,
  machine_id     BIGINT UNSIGNED NOT NULL,
  reading_from   DATETIME NOT NULL,
  reading_to     DATETIME NOT NULL,
  stitches       BIGINT UNSIGNED NULL,
  pieces         DECIMAL(18,4) NULL,
  run_minutes    DECIMAL(18,4) NULL,
  machine_status VARCHAR(30) NULL,
  source_ref     VARCHAR(120) NULL,
  production_id  BIGINT UNSIGNED NULL,
  created_by     BIGINT UNSIGNED NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_mp_ctr (machine_id, reading_from), KEY ix_mp_ctr_prod (production_id),
  CONSTRAINT fk_mp_ctr__machine FOREIGN KEY (machine_id) REFERENCES mst_mp_machine(id)
) ENGINE=InnoDB COMMENT='Imported machine counter readings';

-- ---------------------------------------------------------------- settings, numbering, permissions
INSERT IGNORE INTO cfg_system_setting (company_id, setting_key, setting_value, description)
SELECT id, 'MP_SETUP_IN_COSTING', '0', 'Embroidery / printing: 1 = setup / hooping time is charged as machine time; 0 = costing hours = net run hours' FROM mst_company;
INSERT IGNORE INTO cfg_system_setting (company_id, setting_key, setting_value, description)
SELECT id, 'MP_OUTPUT_TOLERANCE_PCT', '2', 'Embroidery / printing: output above the job planned qty by more than this % needs a supervisor reason at approval' FROM mst_company;
INSERT IGNORE INTO cfg_system_setting (company_id, setting_key, setting_value, description)
SELECT id, 'MP_CONSUMPTION_WITHIN_ISSUE', '1', 'Embroidery / printing: 1 = actual material consumption of a job cannot exceed what the store issued (net of returns)' FROM mst_company;

INSERT INTO cfg_number_series (company_id, branch_id, doc_type, fy_id, prefix, next_number, padding)
SELECT c.id, NULL, t.doc_type, NULL, t.prefix, 1, 5
  FROM mst_company c
  JOIN (SELECT 'EMB_JOB' AS doc_type, 'EMJ-' AS prefix UNION ALL SELECT 'EMB_PROD', 'EMP-' UNION ALL SELECT 'EMB_MAT', 'EMM-'
        UNION ALL SELECT 'PRT_JOB', 'PRJ-' UNION ALL SELECT 'PRT_PROD', 'PRP-' UNION ALL SELECT 'PRT_MAT', 'PRM-'
        UNION ALL SELECT 'EMB_RECIPE', 'ER-' UNION ALL SELECT 'PRT_RECIPE', 'PR-') t
 WHERE NOT EXISTS (SELECT 1 FROM cfg_number_series ns WHERE ns.company_id = c.id AND ns.doc_type = t.doc_type AND ns.branch_id IS NULL AND ns.fy_id IS NULL);
