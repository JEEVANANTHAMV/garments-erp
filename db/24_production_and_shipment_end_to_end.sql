-- =====================================================================
-- 24. COMPLETE PRODUCTION & SHIPMENT TRACEABILITY (END-TO-END)
--     Lay, Spreading, Cut QC, Bundle Details, Sewing, Finishing,
--     Final QC, Shipment Plan, and Container Management
-- =====================================================================

-- -------------------------------------------------------------
-- 1. LAY PLAN
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trx_lay_plan (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  lay_no          VARCHAR(40) NOT NULL,
  lay_date        DATE NOT NULL,
  io_no           VARCHAR(40) NOT NULL,
  cutting_plan_id BIGINT UNSIGNED,
  style_id        BIGINT UNSIGNED NOT NULL,
  color_id        BIGINT UNSIGNED,
  marker_ref      VARCHAR(60),
  marker_length_m DECIMAL(10,3),
  ply_count       INT UNSIGNED DEFAULT 0,
  fabric_roll_id  BIGINT UNSIGNED,
  fabric_id       BIGINT UNSIGNED,
  shade           VARCHAR(40),
  table_no        VARCHAR(40),
  planned_cut_qty INT UNSIGNED DEFAULT 0,
  status          ENUM('PLANNED','SPREAD','CUT','CANCELLED') DEFAULT 'PLANNED',
  remarks         VARCHAR(500),
  created_by      BIGINT UNSIGNED,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by      BIGINT UNSIGNED,
  updated_at      DATETIME ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_lay_plan (company_id, lay_no),
  KEY ix_lay_io (io_no),
  CONSTRAINT fk_lay__company FOREIGN KEY (company_id) REFERENCES mst_company(id),
  CONSTRAINT fk_lay__cutplan FOREIGN KEY (cutting_plan_id) REFERENCES trx_cutting_plan(id),
  CONSTRAINT fk_lay__style   FOREIGN KEY (style_id) REFERENCES mst_style(id),
  CONSTRAINT fk_lay__color   FOREIGN KEY (color_id) REFERENCES mst_color(id)
) ENGINE=InnoDB COMMENT='Lay Plan header with I/O + Style traceability';

-- -------------------------------------------------------------
-- 2. SPREADING
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trx_spreading (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  spreading_no    VARCHAR(40) NOT NULL,
  spreading_date  DATE NOT NULL,
  lay_id          BIGINT UNSIGNED NOT NULL,
  io_no           VARCHAR(40) NOT NULL,
  style_id        BIGINT UNSIGNED NOT NULL,
  roll_no         VARCHAR(40),
  start_mtr       DECIMAL(10,3),
  end_mtr         DECIMAL(10,3),
  actual_used_mtr DECIMAL(10,3),
  ply_count       INT UNSIGNED DEFAULT 0,
  fabric_width_cm DECIMAL(8,2),
  gsm             DECIMAL(8,2),
  shade           VARCHAR(40),
  operator_name   VARCHAR(80),
  qc_status       ENUM('PASS','HOLD','REJECT') DEFAULT 'PASS',
  remarks         VARCHAR(500),
  created_by      BIGINT UNSIGNED,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_spreading (company_id, spreading_no),
  KEY ix_sprd_io (io_no),
  CONSTRAINT fk_sprd__company FOREIGN KEY (company_id) REFERENCES mst_company(id),
  CONSTRAINT fk_sprd__lay     FOREIGN KEY (lay_id) REFERENCES trx_lay_plan(id) ON DELETE CASCADE,
  CONSTRAINT fk_sprd__style   FOREIGN KEY (style_id) REFERENCES mst_style(id)
) ENGINE=InnoDB COMMENT='Spreading actual measurements and roll QC';

-- -------------------------------------------------------------
-- 3. CUT PIECE QC
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trx_cut_piece_qc (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  qc_no           VARCHAR(40) NOT NULL,
  qc_date         DATE NOT NULL,
  cutting_id      BIGINT UNSIGNED,
  io_no           VARCHAR(40) NOT NULL,
  style_id        BIGINT UNSIGNED NOT NULL,
  color_id        BIGINT UNSIGNED,
  size_id         INT UNSIGNED,
  component       VARCHAR(60) NOT NULL DEFAULT 'BODY',
  cut_qty         INT UNSIGNED DEFAULT 0,
  accepted_qty    INT UNSIGNED DEFAULT 0,
  reject_qty      INT UNSIGNED DEFAULT 0,
  recut_qty       INT UNSIGNED DEFAULT 0,
  reject_reason   VARCHAR(120),
  qc_status       ENUM('APPROVED','REJECTED','CONDITIONAL') DEFAULT 'APPROVED',
  inspector_name  VARCHAR(80),
  remarks         VARCHAR(500),
  created_by      BIGINT UNSIGNED,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_cut_qc (company_id, qc_no),
  KEY ix_cpqc_io (io_no),
  CONSTRAINT fk_cpqc__company FOREIGN KEY (company_id) REFERENCES mst_company(id),
  CONSTRAINT fk_cpqc__cutting FOREIGN KEY (cutting_id) REFERENCES trx_cutting(id),
  CONSTRAINT fk_cpqc__style   FOREIGN KEY (style_id) REFERENCES mst_style(id),
  CONSTRAINT fk_cpqc__color   FOREIGN KEY (color_id) REFERENCES mst_color(id),
  CONSTRAINT fk_cpqc__size    FOREIGN KEY (size_id) REFERENCES mst_size(id)
) ENGINE=InnoDB COMMENT='Cut Piece QC with component and rejection traceability';

-- -------------------------------------------------------------
-- 4. BUNDLE DETAIL (Piece breakdown: Front, Back, Sleeves, etc.)
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trx_cutting_bundle_detail (
  id          BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  bundle_id   BIGINT UNSIGNED NOT NULL,
  component   VARCHAR(60) NOT NULL,
  piece_qty   INT UNSIGNED DEFAULT 0,
  cut_qc_id   BIGINT UNSIGNED,
  CONSTRAINT fk_bdtl__bundle FOREIGN KEY (bundle_id) REFERENCES trx_cutting_bundle(id) ON DELETE CASCADE,
  CONSTRAINT fk_bdtl__qc     FOREIGN KEY (cut_qc_id) REFERENCES trx_cut_piece_qc(id)
) ENGINE=InnoDB COMMENT='Component breakdown per cut bundle';

-- -------------------------------------------------------------
-- 5. SEWING INPUT & OUTPUT
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trx_sewing_input (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  input_no        VARCHAR(40) NOT NULL,
  input_date      DATE NOT NULL,
  io_no           VARCHAR(40) NOT NULL,
  style_id        BIGINT UNSIGNED NOT NULL,
  color_id        BIGINT UNSIGNED,
  size_id         INT UNSIGNED,
  bundle_id       BIGINT UNSIGNED NOT NULL,
  line_name       VARCHAR(60) NOT NULL,
  operator_name   VARCHAR(80),
  input_qty       INT UNSIGNED DEFAULT 0,
  status          ENUM('OPEN','COMPLETED','CANCELLED') DEFAULT 'OPEN',
  remarks         VARCHAR(500),
  created_by      BIGINT UNSIGNED,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_sew_in (company_id, input_no),
  KEY ix_sewin_io (io_no),
  CONSTRAINT fk_sewin__company FOREIGN KEY (company_id) REFERENCES mst_company(id),
  CONSTRAINT fk_sewin__style   FOREIGN KEY (style_id) REFERENCES mst_style(id),
  CONSTRAINT fk_sewin__bundle  FOREIGN KEY (bundle_id) REFERENCES trx_cutting_bundle(id)
) ENGINE=InnoDB COMMENT='Sewing floor input per bundle';

CREATE TABLE IF NOT EXISTS trx_sewing_output (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  output_no       VARCHAR(40) NOT NULL,
  output_date     DATE NOT NULL,
  sewing_input_id BIGINT UNSIGNED,
  io_no           VARCHAR(40) NOT NULL,
  style_id        BIGINT UNSIGNED NOT NULL,
  color_id        BIGINT UNSIGNED,
  size_id         INT UNSIGNED,
  bundle_id       BIGINT UNSIGNED,
  line_name       VARCHAR(60),
  output_qty      INT UNSIGNED DEFAULT 0,
  reject_qty      INT UNSIGNED DEFAULT 0,
  rework_qty      INT UNSIGNED DEFAULT 0,
  status          ENUM('COMPLETED','IN_PROGRESS') DEFAULT 'COMPLETED',
  remarks         VARCHAR(500),
  created_by      BIGINT UNSIGNED,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_sew_out (company_id, output_no),
  KEY ix_sewout_io (io_no),
  CONSTRAINT fk_sewout__company FOREIGN KEY (company_id) REFERENCES mst_company(id),
  CONSTRAINT fk_sewout__input   FOREIGN KEY (sewing_input_id) REFERENCES trx_sewing_input(id),
  CONSTRAINT fk_sewout__style   FOREIGN KEY (style_id) REFERENCES mst_style(id)
) ENGINE=InnoDB COMMENT='Sewing floor output per line/bundle';

-- -------------------------------------------------------------
-- 6. FINISHING INPUT & OUTPUT & FINAL QC
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trx_finishing_input (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  input_no        VARCHAR(40) NOT NULL,
  input_date      DATE NOT NULL,
  io_no           VARCHAR(40) NOT NULL,
  style_id        BIGINT UNSIGNED NOT NULL,
  color_id        BIGINT UNSIGNED,
  size_id         INT UNSIGNED,
  sewing_output_id BIGINT UNSIGNED,
  input_qty       INT UNSIGNED DEFAULT 0,
  status          ENUM('OPEN','COMPLETED','CANCELLED') DEFAULT 'OPEN',
  remarks         VARCHAR(500),
  created_by      BIGINT UNSIGNED,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_fin_in (company_id, input_no),
  KEY ix_finin_io (io_no),
  CONSTRAINT fk_finin__company FOREIGN KEY (company_id) REFERENCES mst_company(id),
  CONSTRAINT fk_finin__style   FOREIGN KEY (style_id) REFERENCES mst_style(id),
  CONSTRAINT fk_finin__sewout  FOREIGN KEY (sewing_output_id) REFERENCES trx_sewing_output(id)
) ENGINE=InnoDB COMMENT='Finishing input from sewing';

CREATE TABLE IF NOT EXISTS trx_finishing_output (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  output_no       VARCHAR(40) NOT NULL,
  output_date     DATE NOT NULL,
  finishing_input_id BIGINT UNSIGNED,
  io_no           VARCHAR(40) NOT NULL,
  style_id        BIGINT UNSIGNED NOT NULL,
  color_id        BIGINT UNSIGNED,
  size_id         INT UNSIGNED,
  output_qty      INT UNSIGNED DEFAULT 0,
  reject_qty      INT UNSIGNED DEFAULT 0,
  rework_qty      INT UNSIGNED DEFAULT 0,
  status          ENUM('COMPLETED','IN_PROGRESS') DEFAULT 'COMPLETED',
  remarks         VARCHAR(500),
  created_by      BIGINT UNSIGNED,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_fin_out (company_id, output_no),
  KEY ix_finout_io (io_no),
  CONSTRAINT fk_finout__company FOREIGN KEY (company_id) REFERENCES mst_company(id),
  CONSTRAINT fk_finout__input   FOREIGN KEY (finishing_input_id) REFERENCES trx_finishing_input(id),
  CONSTRAINT fk_finout__style   FOREIGN KEY (style_id) REFERENCES mst_style(id)
) ENGINE=InnoDB COMMENT='Finishing output';

CREATE TABLE IF NOT EXISTS trx_final_qc (
  id                  BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id          BIGINT UNSIGNED NOT NULL,
  qc_no               VARCHAR(40) NOT NULL,
  qc_date             DATE NOT NULL,
  finishing_output_id BIGINT UNSIGNED,
  io_no               VARCHAR(40) NOT NULL,
  style_id            BIGINT UNSIGNED NOT NULL,
  color_id            BIGINT UNSIGNED,
  size_id             INT UNSIGNED,
  inspected_qty       INT UNSIGNED DEFAULT 0,
  passed_qty          INT UNSIGNED DEFAULT 0,
  reject_qty          INT UNSIGNED DEFAULT 0,
  rework_qty          INT UNSIGNED DEFAULT 0,
  qc_status           ENUM('PASS','HOLD','REJECT') DEFAULT 'PASS',
  inspector_name      VARCHAR(80),
  remarks             VARCHAR(500),
  created_by          BIGINT UNSIGNED,
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_final_qc (company_id, qc_no),
  KEY ix_fqc_io (io_no),
  CONSTRAINT fk_fqc__company FOREIGN KEY (company_id) REFERENCES mst_company(id),
  CONSTRAINT fk_fqc__finout  FOREIGN KEY (finishing_output_id) REFERENCES trx_finishing_output(id),
  CONSTRAINT fk_fqc__style   FOREIGN KEY (style_id) REFERENCES mst_style(id)
) ENGINE=InnoDB COMMENT='Final QC inspection before FG stock receipt';

-- -------------------------------------------------------------
-- 7. SHIPMENT PLANNING
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trx_shipment_plan (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  plan_no         VARCHAR(40) NOT NULL,
  planned_date    DATE NOT NULL,
  buyer_id        BIGINT UNSIGNED,
  shipment_type   ENUM('DOMESTIC','EXPORT') DEFAULT 'DOMESTIC',
  mode            ENUM('SEA','AIR','ROAD','COURIER') DEFAULT 'ROAD',
  destination     VARCHAR(120),
  total_packages  INT UNSIGNED DEFAULT 0,
  total_qty       INT UNSIGNED DEFAULT 0,
  gross_weight_kg DECIMAL(10,3),
  total_cbm       DECIMAL(10,5),
  status          ENUM('DRAFT','CONFIRMED','CONVERTED','CANCELLED') DEFAULT 'DRAFT',
  remarks         VARCHAR(500),
  created_by      BIGINT UNSIGNED,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_shipplan (company_id, plan_no),
  CONSTRAINT fk_shplan__company FOREIGN KEY (company_id) REFERENCES mst_company(id),
  CONSTRAINT fk_shplan__buyer   FOREIGN KEY (buyer_id) REFERENCES mst_party(id)
) ENGINE=InnoDB COMMENT='Shipment Planning for confirmed packages';

CREATE TABLE IF NOT EXISTS trx_shipment_plan_package (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  plan_id         BIGINT UNSIGNED NOT NULL,
  carton_id       BIGINT UNSIGNED NOT NULL,
  UNIQUE KEY uq_shplan_pkg (plan_id, carton_id),
  CONSTRAINT fk_sppkg__plan   FOREIGN KEY (plan_id)   REFERENCES trx_shipment_plan(id) ON DELETE CASCADE,
  CONSTRAINT fk_sppkg__carton FOREIGN KEY (carton_id) REFERENCES trx_carton(id)
) ENGINE=InnoDB COMMENT='Packages selected for shipment plan';

-- -------------------------------------------------------------
-- 8. SHIPMENT CONTAINERS (Under Shipment)
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trx_shipment_container (
  id                BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id        BIGINT UNSIGNED NOT NULL,
  shipment_id       BIGINT UNSIGNED NOT NULL,
  container_no      VARCHAR(40) NOT NULL,
  container_type    ENUM('20FT','40FT','40HC','45HC','LCL') NOT NULL DEFAULT '40HC',
  seal_no           VARCHAR(40),
  tare_weight_kg    DECIMAL(10,3),
  net_weight_kg     DECIMAL(10,3),
  gross_weight_kg   DECIMAL(10,3),
  max_cbm           DECIMAL(10,3),
  loaded_cbm        DECIMAL(10,3),
  stuffing_date     DATE,
  stuffing_location VARCHAR(120),
  status            ENUM('PLANNED','STUFFED','RELEASED') DEFAULT 'PLANNED',
  remarks           VARCHAR(255),
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_ship_container (shipment_id, container_no),
  CONSTRAINT fk_scont__company  FOREIGN KEY (company_id)  REFERENCES mst_company(id),
  CONSTRAINT fk_scont__shipment FOREIGN KEY (shipment_id) REFERENCES trx_shipment(id) ON DELETE CASCADE
) ENGINE=InnoDB COMMENT='Export containers tied to shipment';

CREATE TABLE IF NOT EXISTS trx_shipment_container_package (
  id                   BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  container_id         BIGINT UNSIGNED NOT NULL,
  shipment_package_id  BIGINT UNSIGNED NOT NULL,
  UNIQUE KEY uq_scont_pkg (container_id, shipment_package_id),
  CONSTRAINT fk_scp__container FOREIGN KEY (container_id) REFERENCES trx_shipment_container(id) ON DELETE CASCADE,
  CONSTRAINT fk_scp__ship_pkg  FOREIGN KEY (shipment_package_id) REFERENCES trx_shipment_package(id) ON DELETE CASCADE
) ENGINE=InnoDB COMMENT='Carton assignment to export container';
