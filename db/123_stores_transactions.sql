-- 123: stores transactions (client tracker 14-Oct-2026, "Business Process(New)" rows marked "no").
--   • Opening stock entry → posts yarn (opening GRN lot) / fabric (opening GRN + roll) / trims (trim stock) /
--     general items (general stock ledger) + trx_stock_ledger, by location, SO / style optional, with rate.
--   • Stock audit: entry → submit → approval; approval posts physical − system as adjustments.
--   • Stock delivery (and general delivery with item lines): returnable / non-returnable (billable / non-billable),
--     approval posts stock out; returns bring it back; a returnable DC stays outstanding until fully returned.
--   • Bill tracker: bill receipt → handover to department → received back → submitted to accounts.
--   • Special request: purchase over and above the budget, with approval (optionally raises the job allowance).
--   • Scrap / rejection entry at any stage; rejection moves stock into the rejection godown.
-- No hard delete anywhere: drafts are edited / cancelled with a reason, posted documents are never edited.
-- Re-runnable.

CREATE TABLE IF NOT EXISTS trx_store_general_ledger (
  id            BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id    BIGINT UNSIGNED NOT NULL,
  warehouse_id  BIGINT UNSIGNED NOT NULL,
  item_name     VARCHAR(150) NOT NULL COMMENT 'General / consumable / spare item (free text, no master)',
  uom_id        SMALLINT UNSIGNED NOT NULL,
  so_id         BIGINT UNSIGNED NULL,
  color_name    VARCHAR(80) NULL,
  qty_in        DECIMAL(18,4) NOT NULL DEFAULT 0,
  qty_out       DECIMAL(18,4) NOT NULL DEFAULT 0,
  rate          DECIMAL(18,4) NOT NULL DEFAULT 0,
  ref_type      VARCHAR(30) NOT NULL,
  ref_id        BIGINT UNSIGNED NOT NULL,
  ref_no        VARCHAR(60) NULL,
  txn_date      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by    BIGINT UNSIGNED NULL,
  KEY ix_sgl_item (company_id, warehouse_id, item_name),
  KEY ix_sgl_ref (ref_type, ref_id)
) ENGINE=InnoDB COMMENT='General (non-master) item stock ledger: opening / audit / delivery / scrap';

-- ------------------------------------------------------------ opening stock
CREATE TABLE IF NOT EXISTS trx_opening_stock (
  id             BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id     BIGINT UNSIGNED NOT NULL,
  doc_no         VARCHAR(40) NOT NULL,
  doc_date       DATE NOT NULL,
  party_id       BIGINT UNSIGNED NULL,
  warehouse_id   BIGINT UNSIGNED NOT NULL,
  process_name   VARCHAR(80) NULL,
  so_id          BIGINT UNSIGNED NULL,
  style_id       BIGINT UNSIGNED NULL,
  remarks        VARCHAR(500) NULL,
  status         VARCHAR(12) NOT NULL DEFAULT 'DRAFT' COMMENT 'DRAFT / POSTED / CANCELLED',
  posted_by      BIGINT UNSIGNED NULL,
  posted_at      DATETIME NULL,
  cancel_reason  VARCHAR(255) NULL,
  cancelled_by   BIGINT UNSIGNED NULL,
  cancelled_at   DATETIME NULL,
  created_by     BIGINT UNSIGNED NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_opening (company_id, doc_no),
  KEY ix_opening_date (company_id, doc_date)
) ENGINE=InnoDB COMMENT='Opening stock entry';

CREATE TABLE IF NOT EXISTS trx_opening_stock_line (
  id             BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  opening_id     BIGINT UNSIGNED NOT NULL,
  material_type  VARCHAR(10) NOT NULL COMMENT 'YARN / FABRIC / TRIM / GENERAL',
  yarn_id        BIGINT UNSIGNED NULL,
  fabric_id      BIGINT UNSIGNED NULL,
  trim_id        BIGINT UNSIGNED NULL,
  item_description VARCHAR(255) NULL,
  color_name     VARCHAR(80) NULL,
  sizes          VARCHAR(80) NULL,
  lot_no         VARCHAR(60) NULL COMMENT 'Yarn lot / trim lot / fabric lot',
  roll_no        VARCHAR(60) NULL,
  so_id          BIGINT UNSIGNED NULL,
  style_id       BIGINT UNSIGNED NULL,
  uom_id         SMALLINT UNSIGNED NOT NULL,
  qty            DECIMAL(18,4) NOT NULL,
  rate           DECIMAL(18,4) NOT NULL DEFAULT 0,
  amount         DECIMAL(18,4) NOT NULL DEFAULT 0,
  remarks        VARCHAR(255) NULL,
  grn_line_id    BIGINT UNSIGNED NULL COMMENT 'Posted: opening GRN lot (yarn / fabric)',
  roll_id        BIGINT UNSIGNED NULL COMMENT 'Posted: fabric roll',
  trim_stock_id  BIGINT UNSIGNED NULL COMMENT 'Posted: trim stock row',
  KEY ix_osl_doc (opening_id)
) ENGINE=InnoDB COMMENT='Opening stock lines';

-- ------------------------------------------------------------ stock audit
CREATE TABLE IF NOT EXISTS trx_stock_audit (
  id             BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id     BIGINT UNSIGNED NOT NULL,
  doc_no         VARCHAR(40) NOT NULL,
  doc_date       DATE NOT NULL,
  audit_type     VARCHAR(10) NOT NULL COMMENT 'YARN / FABRIC / TRIM / GENERAL',
  warehouse_id   BIGINT UNSIGNED NOT NULL,
  remarks        VARCHAR(500) NULL,
  status         VARCHAR(12) NOT NULL DEFAULT 'DRAFT' COMMENT 'DRAFT / SUBMITTED / APPROVED / REJECTED / CANCELLED',
  submitted_by   BIGINT UNSIGNED NULL,
  submitted_at   DATETIME NULL,
  approved_by    BIGINT UNSIGNED NULL,
  approved_at    DATETIME NULL,
  cancel_reason  VARCHAR(255) NULL,
  cancelled_by   BIGINT UNSIGNED NULL,
  cancelled_at   DATETIME NULL,
  created_by     BIGINT UNSIGNED NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_saudit (company_id, doc_no),
  KEY ix_saudit_date (company_id, doc_date)
) ENGINE=InnoDB COMMENT='Stock audit (physical count) with approval';

CREATE TABLE IF NOT EXISTS trx_stock_audit_line (
  id             BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  audit_id       BIGINT UNSIGNED NOT NULL,
  material_type  VARCHAR(10) NOT NULL,
  source_ref     VARCHAR(255) NOT NULL COMMENT 'Y:grn_line / F:roll / T:trim_stock / G:general key',
  yarn_id        BIGINT UNSIGNED NULL,
  fabric_id      BIGINT UNSIGNED NULL,
  trim_id        BIGINT UNSIGNED NULL,
  item_description VARCHAR(255) NULL,
  color_name     VARCHAR(80) NULL,
  lot_no         VARCHAR(80) NULL,
  grn_no         VARCHAR(60) NULL,
  process_name   VARCHAR(80) NULL,
  so_id          BIGINT UNSIGNED NULL,
  style_id       BIGINT UNSIGNED NULL,
  uom_id         SMALLINT UNSIGNED NOT NULL,
  system_qty     DECIMAL(18,4) NOT NULL DEFAULT 0 COMMENT 'Stock as per ERP (refreshed at approval)',
  physical_qty   DECIMAL(18,4) NOT NULL DEFAULT 0,
  diff_qty       DECIMAL(18,4) NOT NULL DEFAULT 0 COMMENT 'Physical − ERP; posted at approval',
  rate           DECIMAL(18,4) NOT NULL DEFAULT 0,
  amount         DECIMAL(18,4) NOT NULL DEFAULT 0,
  remarks        VARCHAR(255) NULL,
  KEY ix_sal_doc (audit_id)
) ENGINE=InnoDB COMMENT='Stock audit lines: ERP vs physical';

-- ------------------------------------------------------------ stock / general delivery
CREATE TABLE IF NOT EXISTS trx_stock_delivery (
  id             BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id     BIGINT UNSIGNED NOT NULL,
  doc_no         VARCHAR(40) NOT NULL,
  doc_date       DATE NOT NULL,
  delivery_kind  VARCHAR(10) NOT NULL DEFAULT 'STOCK' COMMENT 'STOCK (from stock) / GENERAL (general delivery, free items)',
  dc_type        VARCHAR(16) NOT NULL COMMENT 'RETURNABLE / NON_RETURNABLE',
  is_billable    TINYINT(1) NULL COMMENT 'Non-returnable only: 1 billable / 0 non-billable (FOC)',
  warehouse_id   BIGINT UNSIGNED NOT NULL,
  party_id       BIGINT UNSIGNED NULL,
  party_dc_no    VARCHAR(60) NULL,
  so_id          BIGINT UNSIGNED NULL,
  style_id       BIGINT UNSIGNED NULL,
  purpose        VARCHAR(255) NULL,
  expected_return_date DATE NULL,
  vehicle_no     VARCHAR(30) NULL,
  gate_outward_id BIGINT UNSIGNED NULL COMMENT 'Outward gate pass made at approval (when a vehicle is given)',
  remarks        VARCHAR(500) NULL,
  status         VARCHAR(16) NOT NULL DEFAULT 'DRAFT' COMMENT 'DRAFT / APPROVED / PARTIAL_RETURN / RETURNED / CLOSED / CANCELLED',
  approved_by    BIGINT UNSIGNED NULL,
  approved_at    DATETIME NULL,
  cancel_reason  VARCHAR(255) NULL COMMENT 'Cancel (draft) or short-close (returnable) reason',
  cancelled_by   BIGINT UNSIGNED NULL,
  cancelled_at   DATETIME NULL,
  created_by     BIGINT UNSIGNED NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_sdel (company_id, doc_no),
  KEY ix_sdel_date (company_id, doc_date)
) ENGINE=InnoDB COMMENT='Stock delivery / general delivery DC';

CREATE TABLE IF NOT EXISTS trx_stock_delivery_line (
  id             BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  delivery_id    BIGINT UNSIGNED NOT NULL,
  material_type  VARCHAR(10) NOT NULL COMMENT 'YARN / FABRIC / TRIM / GENERAL',
  source_ref     VARCHAR(255) NULL,
  yarn_id        BIGINT UNSIGNED NULL,
  fabric_id      BIGINT UNSIGNED NULL,
  trim_id        BIGINT UNSIGNED NULL,
  item_description VARCHAR(255) NULL,
  color_name     VARCHAR(80) NULL,
  sizes          VARCHAR(80) NULL,
  so_id          BIGINT UNSIGNED NULL,
  style_id       BIGINT UNSIGNED NULL,
  uom_id         SMALLINT UNSIGNED NOT NULL,
  stock_qty      DECIMAL(18,4) NOT NULL DEFAULT 0 COMMENT 'Stock at the time of entry',
  qty            DECIMAL(18,4) NOT NULL,
  returned_qty   DECIMAL(18,4) NOT NULL DEFAULT 0,
  rate           DECIMAL(18,4) NOT NULL DEFAULT 0,
  amount         DECIMAL(18,4) NOT NULL DEFAULT 0,
  remarks        VARCHAR(255) NULL,
  KEY ix_sdl_doc (delivery_id)
) ENGINE=InnoDB COMMENT='Stock delivery lines';

CREATE TABLE IF NOT EXISTS trx_stock_delivery_return (
  id             BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id     BIGINT UNSIGNED NOT NULL,
  delivery_id    BIGINT UNSIGNED NOT NULL,
  return_no      VARCHAR(40) NOT NULL,
  return_date    DATE NOT NULL,
  party_dc_no    VARCHAR(60) NULL,
  remarks        VARCHAR(500) NULL,
  created_by     BIGINT UNSIGNED NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_sdret (company_id, return_no),
  KEY ix_sdret_del (delivery_id)
) ENGINE=InnoDB COMMENT='Return entry against a returnable stock / general delivery';

CREATE TABLE IF NOT EXISTS trx_stock_delivery_return_line (
  id               BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  return_id        BIGINT UNSIGNED NOT NULL,
  delivery_line_id BIGINT UNSIGNED NOT NULL,
  qty              DECIMAL(18,4) NOT NULL,
  KEY ix_sdrl_ret (return_id),
  KEY ix_sdrl_line (delivery_line_id)
) ENGINE=InnoDB COMMENT='Returned qty per delivery line';

-- ------------------------------------------------------------ bill tracker
CREATE TABLE IF NOT EXISTS trx_bill_tracker (
  id                       BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id               BIGINT UNSIGNED NOT NULL,
  entry_no                 VARCHAR(40) NULL,
  entry_date               DATE NOT NULL,
  received_from            VARCHAR(12) NOT NULL DEFAULT 'VENDOR' COMMENT 'VENDOR / DEPARTMENT',
  received_from_dept       VARCHAR(80) NULL,
  bill_no                  VARCHAR(60) NOT NULL,
  bill_date                DATE NULL,
  supplier_id              BIGINT UNSIGNED NULL,
  purchase_or_process      VARCHAR(120) NULL COMMENT 'Purchase / process name',
  amount                   DECIMAL(18,2) NOT NULL DEFAULT 0,
  supplier_bill_id         BIGINT UNSIGNED NULL COMMENT 'Optional link: Bills Inward entry',
  grn_id                   BIGINT UNSIGNED NULL COMMENT 'Optional link: GRN',
  handed_over_to           VARCHAR(120) NULL,
  handover_department      VARCHAR(80) NULL,
  handover_date            DATE NULL,
  received_back_date       DATE NULL,
  submitted_to_accounts_on DATE NULL,
  accounts_recipient       VARCHAR(120) NULL,
  status                   VARCHAR(16) NOT NULL DEFAULT 'RECEIVED' COMMENT 'RECEIVED / HANDED_OVER / RECEIVED_BACK / SUBMITTED / CANCELLED',
  remarks                  VARCHAR(500) NULL,
  cancel_reason            VARCHAR(255) NULL,
  created_by               BIGINT UNSIGNED NULL,
  created_at               DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by               BIGINT UNSIGNED NULL,
  updated_at               DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
  KEY ix_bt_date (company_id, entry_date),
  KEY ix_bt_status (company_id, status),
  KEY ix_bt_supplier (supplier_id)
) ENGINE=InnoDB COMMENT='Bill tracker: receipt → department handover → back → accounts';

-- ------------------------------------------------------------ special request (over budget)
CREATE TABLE IF NOT EXISTS trx_special_request (
  id               BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id       BIGINT UNSIGNED NOT NULL,
  req_no           VARCHAR(40) NOT NULL,
  req_date         DATE NOT NULL,
  so_id            BIGINT UNSIGNED NULL,
  style_id         BIGINT UNSIGNED NULL,
  material_type    VARCHAR(10) NOT NULL COMMENT 'YARN / FABRIC / TRIM / GENERAL',
  yarn_id          BIGINT UNSIGNED NULL,
  fabric_id        BIGINT UNSIGNED NULL,
  trim_id          BIGINT UNSIGNED NULL,
  item_description VARCHAR(255) NULL,
  uom_id           SMALLINT UNSIGNED NULL,
  budget_qty       DECIMAL(18,4) NOT NULL DEFAULT 0 COMMENT 'Allowed (BOM requirement + allowance) at request time',
  ordered_qty      DECIMAL(18,4) NOT NULL DEFAULT 0 COMMENT 'Already on POs at request time',
  requested_qty    DECIMAL(18,4) NOT NULL,
  rate             DECIMAL(18,4) NOT NULL DEFAULT 0,
  amount           DECIMAL(18,2) NOT NULL DEFAULT 0,
  reason           VARCHAR(500) NOT NULL,
  raise_allowance  TINYINT(1) NOT NULL DEFAULT 1 COMMENT 'On approval, add the qty to the job purchase allowance',
  allowance_applied_qty DECIMAL(18,4) NULL,
  status           VARCHAR(12) NOT NULL DEFAULT 'PENDING' COMMENT 'PENDING / APPROVED / REJECTED / CANCELLED',
  decided_by       BIGINT UNSIGNED NULL,
  decided_at       DATETIME NULL,
  decision_remarks VARCHAR(255) NULL,
  created_by       BIGINT UNSIGNED NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_spreq (company_id, req_no),
  KEY ix_spreq_date (company_id, req_date)
) ENGINE=InnoDB COMMENT='Special request: purchase over and above the budget';

-- ------------------------------------------------------------ scrap / rejection
CREATE TABLE IF NOT EXISTS trx_scrap_rejection (
  id                     BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id             BIGINT UNSIGNED NOT NULL,
  doc_no                 VARCHAR(40) NOT NULL,
  doc_date               DATE NOT NULL,
  entry_kind             VARCHAR(10) NOT NULL COMMENT 'SCRAP / REJECTION',
  stage                  VARCHAR(40) NOT NULL COMMENT 'Stores / Knitting / Dyeing / Cutting / Sewing / Finishing / Packing / …',
  warehouse_id           BIGINT UNSIGNED NOT NULL COMMENT 'Location the goods are taken from',
  rejection_warehouse_id BIGINT UNSIGNED NULL COMMENT 'Rejection godown (REJECTION entries)',
  so_id                  BIGINT UNSIGNED NULL,
  style_id               BIGINT UNSIGNED NULL,
  process_name           VARCHAR(80) NULL,
  remarks                VARCHAR(500) NULL,
  status                 VARCHAR(12) NOT NULL DEFAULT 'DRAFT' COMMENT 'DRAFT / POSTED / CANCELLED',
  posted_by              BIGINT UNSIGNED NULL,
  posted_at              DATETIME NULL,
  cancel_reason          VARCHAR(255) NULL,
  cancelled_by           BIGINT UNSIGNED NULL,
  cancelled_at           DATETIME NULL,
  created_by             BIGINT UNSIGNED NULL,
  created_at             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at             DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_scrap (company_id, doc_no),
  KEY ix_scrap_date (company_id, doc_date)
) ENGINE=InnoDB COMMENT='Scrap / rejection entry at any stage';

CREATE TABLE IF NOT EXISTS trx_scrap_rejection_line (
  id             BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  entry_id       BIGINT UNSIGNED NOT NULL,
  material_type  VARCHAR(10) NOT NULL COMMENT 'YARN / FABRIC / TRIM / GENERAL / GARMENT (garment = record only)',
  source_ref     VARCHAR(255) NULL,
  yarn_id        BIGINT UNSIGNED NULL,
  fabric_id      BIGINT UNSIGNED NULL,
  trim_id        BIGINT UNSIGNED NULL,
  item_description VARCHAR(255) NULL,
  color_name     VARCHAR(80) NULL,
  sizes          VARCHAR(80) NULL,
  so_id          BIGINT UNSIGNED NULL,
  uom_id         SMALLINT UNSIGNED NOT NULL,
  qty            DECIMAL(18,4) NOT NULL,
  rate           DECIMAL(18,4) NOT NULL DEFAULT 0,
  amount         DECIMAL(18,4) NOT NULL DEFAULT 0,
  reason         VARCHAR(255) NULL,
  KEY ix_srl_doc (entry_id)
) ENGINE=InnoDB COMMENT='Scrap / rejection lines';

-- ------------------------------------------------------------ number series
INSERT INTO cfg_number_series (company_id, branch_id, doc_type, fy_id, prefix, next_number, padding)
SELECT c.id, NULL, s.dt, NULL, s.px, 1, 5
  FROM mst_company c
  JOIN (SELECT 'OPENING_STOCK' dt, 'OPN-' px UNION ALL SELECT 'STOCK_AUDIT', 'SAU-'
        UNION ALL SELECT 'STOCK_DELIVERY', 'SDC-' UNION ALL SELECT 'GENERAL_DELIVERY', 'GDC-'
        UNION ALL SELECT 'DELIVERY_RETURN', 'DRT-' UNION ALL SELECT 'BILL_TRACKER', 'BTR-'
        UNION ALL SELECT 'SPECIAL_REQUEST', 'SPR-' UNION ALL SELECT 'SCRAP_ENTRY', 'SCR-'
        UNION ALL SELECT 'REJECTION_ENTRY', 'REJ-') s
 WHERE NOT EXISTS (SELECT 1 FROM cfg_number_series n WHERE n.company_id = c.id AND n.branch_id IS NULL AND n.fy_id IS NULL AND n.doc_type = s.dt);
