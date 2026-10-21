-- =====================================================================
-- 137 · E-way bill (GST) — Masters India API (client 21-Oct-2026)
--   One e-way bill record per movement of goods, made from the source document and editable before it
--   is generated: Dispatch (sale), Process / job-work outward DC, Purchase return, Gate outward, Stock delivery.
--   Provider: MANUAL (EWB generated on the portal, number recorded here) until the Masters India API is
--   connected (EWB_PROVIDER = MASTERS_INDIA + credentials in the server environment).
--
--   trx_eway_bill        header: Part A (document, consignor, consignee, values) + Part B (transport), status, EWB no / validity
--   trx_eway_bill_item   goods: HSN, qty, unit, taxable value, GST rates
--   trx_eway_bill_event  every action (generate, cancel, vehicle update, extend, refresh) with request / response
-- Idempotent: the runner re-applies files >= 10 on every deploy.
-- =====================================================================

CREATE TABLE IF NOT EXISTS trx_eway_bill (
  id                   BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id           BIGINT UNSIGNED NOT NULL,
  doc_no               VARCHAR(40) NOT NULL COMMENT 'Internal number (EWB-00001) — the EWB no comes from the portal',
  source_type          ENUM('DISPATCH','PROCESS_DC','PURCHASE_RETURN','GATE_OUTWARD','STOCK_DELIVERY','MANUAL') NOT NULL,
  source_id            BIGINT UNSIGNED NULL,
  source_no            VARCHAR(60) NULL,
  status               ENUM('DRAFT','GENERATED','CANCELLED') NOT NULL DEFAULT 'DRAFT',
  -- Part A: document
  supply_type          ENUM('OUTWARD','INWARD') NOT NULL DEFAULT 'OUTWARD',
  sub_supply_type      VARCHAR(40) NOT NULL DEFAULT 'Supply' COMMENT 'Supply / Export / Job Work / Job Work Returns / Sales Return / For Own Use / Exhibition or Fairs / Line Sales / Recipient Not Known / SKD/CKD/Lots / Others',
  sub_supply_desc      VARCHAR(100) NULL COMMENT 'Required when sub supply type = Others',
  document_type        VARCHAR(40) NOT NULL DEFAULT 'Tax Invoice' COMMENT 'Tax Invoice / Bill of Supply / Bill of Entry / Delivery Challan / Credit Note / Others',
  document_number      VARCHAR(16) NOT NULL,
  document_date        DATE NOT NULL,
  transaction_type     TINYINT NOT NULL DEFAULT 1 COMMENT '1 Regular, 2 Bill To-Ship To, 3 Bill From-Dispatch From, 4 Combination',
  -- consignor (from)
  from_gstin           VARCHAR(15) NOT NULL,
  from_name            VARCHAR(100) NOT NULL,
  from_address1        VARCHAR(120) NULL,
  from_address2        VARCHAR(120) NULL,
  from_place           VARCHAR(50) NULL,
  from_pincode         CHAR(6) NULL,
  from_state           VARCHAR(50) NULL COMMENT 'State of the GSTIN',
  dispatch_state       VARCHAR(50) NULL COMMENT 'Actual from state (dispatch from)',
  -- consignee (to)
  to_party_id          BIGINT UNSIGNED NULL,
  to_gstin             VARCHAR(15) NOT NULL DEFAULT 'URP' COMMENT 'URP = unregistered person',
  to_name              VARCHAR(100) NOT NULL,
  to_address1          VARCHAR(120) NULL,
  to_address2          VARCHAR(120) NULL,
  to_place             VARCHAR(50) NULL,
  to_pincode           CHAR(6) NULL,
  to_state             VARCHAR(50) NULL COMMENT 'State of supply',
  ship_state           VARCHAR(50) NULL COMMENT 'Actual to state (ship to)',
  -- values
  taxable_amount       DECIMAL(14,2) NOT NULL DEFAULT 0,
  cgst_amount          DECIMAL(14,2) NOT NULL DEFAULT 0,
  sgst_amount          DECIMAL(14,2) NOT NULL DEFAULT 0,
  igst_amount          DECIMAL(14,2) NOT NULL DEFAULT 0,
  cess_amount          DECIMAL(14,2) NOT NULL DEFAULT 0,
  other_value          DECIMAL(14,2) NOT NULL DEFAULT 0,
  total_invoice_value  DECIMAL(14,2) NOT NULL DEFAULT 0,
  -- Part B: transport
  transporter_party_id BIGINT UNSIGNED NULL,
  transporter_id       VARCHAR(15) NULL COMMENT 'Transporter GSTIN / TRANSIN',
  transporter_name     VARCHAR(100) NULL,
  transport_mode       ENUM('Road','Rail','Air','Ship') NOT NULL DEFAULT 'Road',
  distance_km          INT NOT NULL DEFAULT 0 COMMENT '0 = the portal works it out from the PIN codes',
  vehicle_no           VARCHAR(20) NULL,
  vehicle_type         ENUM('Regular','ODC') NOT NULL DEFAULT 'Regular' COMMENT 'ODC = over-dimensional cargo',
  transport_doc_no     VARCHAR(15) NULL COMMENT 'LR / RR / airway bill no',
  transport_doc_date   DATE NULL,
  -- result
  ewb_no               VARCHAR(20) NULL,
  ewb_date             DATETIME NULL,
  valid_upto           DATETIME NULL,
  ewb_url              VARCHAR(500) NULL COMMENT 'Provider PDF link',
  provider             VARCHAR(20) NULL COMMENT 'MANUAL / MASTERS_INDIA — how it was generated',
  cancel_reason        VARCHAR(40) NULL,
  cancel_remark        VARCHAR(100) NULL,
  cancelled_at         DATETIME NULL,
  cancelled_by         BIGINT UNSIGNED NULL,
  last_error           VARCHAR(500) NULL,
  remarks              VARCHAR(300) NULL,
  created_by           BIGINT UNSIGNED NULL,
  created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by           BIGINT UNSIGNED NULL,
  updated_at           DATETIME NULL,
  UNIQUE KEY uq_ewb_doc (company_id, doc_no),
  UNIQUE KEY uq_ewb_no (company_id, ewb_no),
  KEY ix_ewb_source (company_id, source_type, source_id),
  KEY ix_ewb_valid (company_id, status, valid_upto)
) ENGINE=InnoDB COMMENT='GST e-way bill: Part A + Part B, generated through the provider (Masters India) or recorded manually';

CREATE TABLE IF NOT EXISTS trx_eway_bill_item (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  ewb_id          BIGINT UNSIGNED NOT NULL,
  sort_order      INT NOT NULL DEFAULT 0,
  product_name    VARCHAR(100) NOT NULL,
  description     VARCHAR(100) NULL,
  hsn_code        VARCHAR(8) NOT NULL,
  quantity        DECIMAL(14,3) NOT NULL DEFAULT 0,
  unit            VARCHAR(8) NOT NULL DEFAULT 'PCS' COMMENT 'GST UQC: PCS / NOS / KGS / MTR / BOX / PAC / SET / ROL …',
  taxable_amount  DECIMAL(14,2) NOT NULL DEFAULT 0,
  cgst_rate       DECIMAL(5,2) NOT NULL DEFAULT 0,
  sgst_rate       DECIMAL(5,2) NOT NULL DEFAULT 0,
  igst_rate       DECIMAL(5,2) NOT NULL DEFAULT 0,
  cess_rate       DECIMAL(5,2) NOT NULL DEFAULT 0,
  KEY ix_ewb_item (ewb_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS trx_eway_bill_event (
  id          BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  ewb_id      BIGINT UNSIGNED NOT NULL,
  action      VARCHAR(20) NOT NULL COMMENT 'GENERATE / RECORD / CANCEL / PART_B / EXTEND / REFRESH',
  provider    VARCHAR(20) NULL,
  ok          TINYINT(1) NOT NULL DEFAULT 1,
  message     VARCHAR(500) NULL,
  request     JSON NULL,
  response    JSON NULL,
  user_id     BIGINT UNSIGNED NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_ewb_event (ewb_id)
) ENGINE=InnoDB;

-- e-way bill no on the source documents that had none
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_challan' AND COLUMN_NAME='eway_bill_no');
SET @s = IF(@x=0, 'ALTER TABLE trx_jobwork_challan ADD COLUMN eway_bill_no VARCHAR(20) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_gate_outward' AND COLUMN_NAME='eway_bill_no');
SET @s = IF(@x=0, 'ALTER TABLE trx_gate_outward ADD COLUMN eway_bill_no VARCHAR(20) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_stock_delivery' AND COLUMN_NAME='eway_bill_no');
SET @s = IF(@x=0, 'ALTER TABLE trx_stock_delivery ADD COLUMN eway_bill_no VARCHAR(20) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- numbering, settings
INSERT INTO cfg_number_series (company_id, branch_id, doc_type, fy_id, prefix, next_number, padding)
SELECT c.id, NULL, 'EWAY_BILL_DOC', NULL, 'EWB-', 1, 5 FROM mst_company c
 WHERE NOT EXISTS (SELECT 1 FROM cfg_number_series ns WHERE ns.company_id = c.id AND ns.doc_type = 'EWAY_BILL_DOC' AND ns.branch_id IS NULL AND ns.fy_id IS NULL);
INSERT IGNORE INTO cfg_system_setting (company_id, setting_key, setting_value, description)
SELECT id, 'EWB_PROVIDER', 'MANUAL', 'E-way bill: MANUAL = generate on the GST portal and record the EWB no here; MASTERS_INDIA = generate through the Masters India API (credentials in the server environment)' FROM mst_company;
INSERT IGNORE INTO cfg_system_setting (company_id, setting_key, setting_value, description)
SELECT id, 'EWB_THRESHOLD', '50000', 'E-way bill: consignment value (₹) from which an e-way bill is required' FROM mst_company;

-- permissions: module EWAY under Logistics
INSERT INTO mst_module (module_code, module_name, parent_id, sort_order)
SELECT 'EWAY', 'E-Way Bills', (SELECT id FROM (SELECT id FROM mst_module WHERE module_code = 'LOGISTICS') x), 83
 WHERE NOT EXISTS (SELECT 1 FROM mst_module WHERE module_code = 'EWAY');
INSERT INTO mst_permission (module_id, permission_code, permission_name)
SELECT m.id, t.code, t.name FROM mst_module m
  JOIN (SELECT 'EWAY.VIEW' code, 'View e-way bills' name UNION ALL
        SELECT 'EWAY.CREATE', 'Prepare e-way bills (draft from a document)' UNION ALL
        SELECT 'EWAY.UPDATE', 'Generate e-way bills, update vehicle, extend validity' UNION ALL
        SELECT 'EWAY.APPROVE', 'Cancel e-way bills') t
 WHERE m.module_code = 'EWAY' AND NOT EXISTS (SELECT 1 FROM mst_permission x WHERE x.permission_code = t.code);
-- whoever moves goods (dispatch, packing, production, purchase, stores, gate) prepares / generates; admins and approvers cancel
INSERT INTO map_role_permission (role_id, permission_id)
SELECT DISTINCT mrp.role_id, p.id FROM map_role_permission mrp
  JOIN mst_permission src ON src.id = mrp.permission_id
       AND src.permission_code IN ('DISPATCH.CREATE','PACKING.CREATE','PRODUCTION.CREATE','PURCHASE.CREATE','INVENTORY.CREATE','GATE.CREATE')
  JOIN mst_permission p ON p.permission_code IN ('EWAY.VIEW','EWAY.CREATE','EWAY.UPDATE')
 WHERE NOT EXISTS (SELECT 1 FROM map_role_permission m WHERE m.role_id = mrp.role_id AND m.permission_id = p.id);
INSERT INTO map_role_permission (role_id, permission_id)
SELECT r.id, p.id FROM mst_role r JOIN mst_permission p ON p.permission_code IN ('EWAY.VIEW','EWAY.CREATE','EWAY.UPDATE','EWAY.APPROVE')
 WHERE r.role_code IN ('SUPER_ADMIN','ADMIN')
   AND NOT EXISTS (SELECT 1 FROM map_role_permission m WHERE m.role_id = r.id AND m.permission_id = p.id);
INSERT INTO map_role_permission (role_id, permission_id)
SELECT DISTINCT mrp.role_id, p.id FROM map_role_permission mrp
  JOIN mst_permission src ON src.id = mrp.permission_id AND src.permission_code = 'PACKING.APPROVE'
  JOIN mst_permission p ON p.permission_code = 'EWAY.APPROVE'
 WHERE NOT EXISTS (SELECT 1 FROM map_role_permission m WHERE m.role_id = mrp.role_id AND m.permission_id = p.id);
