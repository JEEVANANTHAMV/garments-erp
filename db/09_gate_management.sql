-- =====================================================================
-- 13. SECURITY GATE MANAGEMENT & GATE PASS
--     Inward Gate Entry (IGP) → Vehicle & DC Log → Store GRN
--     Outward Gate Pass (OGP) → Returnable (Job-work WIP) vs Non-Returnable (Dispatch/Export)
-- =====================================================================

CREATE TABLE IF NOT EXISTS trx_gate_inward (
  id                BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id        BIGINT UNSIGNED NOT NULL,
  entry_no          VARCHAR(40) NOT NULL,
  entry_date        DATE NOT NULL,
  entry_time        TIME NOT NULL,
  entry_type        ENUM('PURCHASE_INWARD','JOBWORK_RETURN','SAMPLE_INWARD','SALES_RETURN','GENERAL_INWARD') NOT NULL DEFAULT 'PURCHASE_INWARD',
  party_id          BIGINT UNSIGNED NOT NULL,       -- Supplier / Job worker
  supplier_dc_no    VARCHAR(60),
  supplier_dc_date  DATE,
  supplier_inv_no   VARCHAR(60),
  supplier_inv_date DATE,
  vehicle_no        VARCHAR(30) NOT NULL,
  driver_name       VARCHAR(80),
  driver_phone      VARCHAR(30),
  transporter_name  VARCHAR(120),
  lr_no             VARCHAR(50),
  material_type     ENUM('FABRIC','YARN','TRIM','GARMENT','GENERAL','MACHINERY') NOT NULL DEFAULT 'FABRIC',
  package_count     INT UNSIGNED DEFAULT 1,          -- Number of Rolls / Bags / Cartons
  gross_weight_kg   DECIMAL(12,3) DEFAULT 0,
  tare_weight_kg    DECIMAL(12,3) DEFAULT 0,
  net_weight_kg     DECIMAL(12,3) DEFAULT 0,
  warehouse_id      BIGINT UNSIGNED,                -- Receiving Store
  status            ENUM('GATE_IN','INSPECTED','GRN_COMPLETED','REJECTED','CANCELLED') NOT NULL DEFAULT 'GATE_IN',
  security_guard    VARCHAR(80),
  remarks           VARCHAR(500),
  created_by        BIGINT UNSIGNED,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_gate_in (company_id, entry_no),
  KEY ix_gatein_party (party_id),
  KEY ix_gatein_status (status),
  CONSTRAINT fk_gatein__company   FOREIGN KEY (company_id)   REFERENCES mst_company(id),
  CONSTRAINT fk_gatein__party     FOREIGN KEY (party_id)     REFERENCES mst_party(id),
  CONSTRAINT fk_gatein__warehouse FOREIGN KEY (warehouse_id) REFERENCES mst_warehouse(id)
) ENGINE=InnoDB COMMENT='Security Inward Gate Entry (IGP)';

CREATE TABLE IF NOT EXISTS trx_gate_outward (
  id                  BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id          BIGINT UNSIGNED NOT NULL,
  pass_no             VARCHAR(40) NOT NULL,
  pass_date           DATE NOT NULL,
  pass_time           TIME NOT NULL,
  pass_type           ENUM('RETURNABLE_JOBWORK','RETURNABLE_GENERAL','NON_RETURNABLE_DISPATCH','NON_RETURNABLE_SCRAP','NON_RETURNABLE_SAMPLE') NOT NULL DEFAULT 'RETURNABLE_JOBWORK',
  party_id            BIGINT UNSIGNED,                -- Destination Vendor / Customer
  to_unit_id          BIGINT UNSIGNED,                -- If internal unit transfer
  vehicle_no          VARCHAR(30) NOT NULL,
  driver_name         VARCHAR(80),
  driver_phone        VARCHAR(30),
  transporter_name    VARCHAR(120),
  lr_no               VARCHAR(50),
  purpose             VARCHAR(255),
  ref_type            VARCHAR(40),                    -- DISPATCH, PROCESS_TXN, etc.
  ref_id              BIGINT UNSIGNED,
  expected_return_date DATE,                           -- For Returnable Gate Pass
  is_returned         TINYINT(1) NOT NULL DEFAULT 0,
  returned_date       DATE,
  package_count       INT UNSIGNED DEFAULT 1,
  total_qty           DECIMAL(14,3) DEFAULT 0,
  uom_id              SMALLINT UNSIGNED,
  status              ENUM('DRAFT','APPROVED','GATE_OUT','RETURNED_PARTIAL','RETURNED_FULL','CLOSED') NOT NULL DEFAULT 'GATE_OUT',
  security_guard      VARCHAR(80),
  remarks             VARCHAR(500),
  created_by          BIGINT UNSIGNED,
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_gate_out (company_id, pass_no),
  KEY ix_gateout_party (party_id),
  KEY ix_gateout_status (status),
  CONSTRAINT fk_gateout__company   FOREIGN KEY (company_id) REFERENCES mst_company(id),
  CONSTRAINT fk_gateout__party     FOREIGN KEY (party_id)   REFERENCES mst_party(id),
  CONSTRAINT fk_gateout__tounit    FOREIGN KEY (to_unit_id) REFERENCES mst_unit(id),
  CONSTRAINT fk_gateout__uom       FOREIGN KEY (uom_id)     REFERENCES cfg_uom(id)
) ENGINE=InnoDB COMMENT='Security Outward Gate Pass (OGP - Returnable & Non-Returnable)';
