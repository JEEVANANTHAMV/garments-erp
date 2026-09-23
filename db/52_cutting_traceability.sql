-- =====================================================================
-- 52. CUTTING → FABRIC CONSUMPTION → BUNDLE → SHIPMENT TRACEABILITY
-- ---------------------------------------------------------------------
-- Implements the data model of the "Cutting to Shipment Fabric
-- Traceability Developer Document" (§18 recommended entities):
--
--   Fabric Roll → Fabric DC roll → Lay (+ lay rolls, before/after KG)
--     → Cut Output (size-wise good/reject/re-cut, actual KG)
--     → Bundle (allocated KG, parent bundle, unique barcode)
--     → Bundle movements (sewing / finishing / packing) → Carton → Shipment
--
-- plus marker versions, cutting losses, cutting reconciliation, size
-- consumption and a barcode scan log. Every statement is idempotent: the
-- migrate runner re-applies files on each deploy.
-- =====================================================================

-- ─────────────────────────────────────────────────────────────────
-- 1. CUT ORDER (trx_cutting_plan) — doc §5
-- ─────────────────────────────────────────────────────────────────
ALTER TABLE trx_cutting_plan
  MODIFY COLUMN status ENUM('DRAFT','APPROVED','RELEASED','IN_PROGRESS','PARTIALLY_COMPLETED','COMPLETED','CLOSED','CANCELLED') DEFAULT 'DRAFT';
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_cutting_plan' AND COLUMN_NAME='over_cut_pct');
SET @s = IF(@x=0, 'ALTER TABLE trx_cutting_plan ADD COLUMN over_cut_pct DECIMAL(6,2) NOT NULL DEFAULT 0 COMMENT \'Authorised over-cut allowance over order qty (%)\' AFTER planned_cut_qty', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_cutting_plan' AND COLUMN_NAME='cutting_location');
SET @s = IF(@x=0, 'ALTER TABLE trx_cutting_plan ADD COLUMN cutting_location VARCHAR(80) NULL AFTER required_date', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_cutting_plan' AND COLUMN_NAME='closed_by');
SET @s = IF(@x=0, 'ALTER TABLE trx_cutting_plan ADD COLUMN closed_by BIGINT UNSIGNED NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_cutting_plan' AND COLUMN_NAME='closed_at');
SET @s = IF(@x=0, 'ALTER TABLE trx_cutting_plan ADD COLUMN closed_at DATETIME NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- ─────────────────────────────────────────────────────────────────
-- 2. FABRIC DC (trx_fabric_issue / _roll) linked to real roll stock — doc §6
-- ─────────────────────────────────────────────────────────────────
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_fabric_roll' AND COLUMN_NAME='issued_kg');
SET @s = IF(@x=0, 'ALTER TABLE trx_fabric_roll ADD COLUMN issued_kg DECIMAL(18,3) NOT NULL DEFAULT 0 COMMENT \'KG issued to cutting DCs (net of returns)\' AFTER weight_kg', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_fabric_issue' AND COLUMN_NAME='from_location');
SET @s = IF(@x=0, 'ALTER TABLE trx_fabric_issue ADD COLUMN from_location VARCHAR(80) NULL AFTER warehouse_id', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_fabric_issue' AND COLUMN_NAME='to_location');
SET @s = IF(@x=0, 'ALTER TABLE trx_fabric_issue ADD COLUMN to_location VARCHAR(80) NULL AFTER from_location', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_fabric_issue_roll' AND COLUMN_NAME='fabric_roll_id');
SET @s = IF(@x=0, 'ALTER TABLE trx_fabric_issue_roll ADD COLUMN fabric_roll_id BIGINT UNSIGNED NULL AFTER fabric_issue_id', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_fabric_issue_roll' AND COLUMN_NAME='color_name');
SET @s = IF(@x=0, 'ALTER TABLE trx_fabric_issue_roll ADD COLUMN color_name VARCHAR(80) NULL AFTER shade', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_fabric_issue_roll' AND COLUMN_NAME='consumed_kg');
SET @s = IF(@x=0, 'ALTER TABLE trx_fabric_issue_roll ADD COLUMN consumed_kg DECIMAL(12,4) NOT NULL DEFAULT 0 COMMENT \'KG consumed by executed lays\' AFTER issue_kg', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_fabric_issue_roll' AND COLUMN_NAME='returned_kg');
SET @s = IF(@x=0, 'ALTER TABLE trx_fabric_issue_roll ADD COLUMN returned_kg DECIMAL(12,4) NOT NULL DEFAULT 0 AFTER consumed_kg', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_fabric_issue_roll' AND COLUMN_NAME='roll_status');
SET @s = IF(@x=0, 'ALTER TABLE trx_fabric_issue_roll ADD COLUMN roll_status ENUM(\'OPEN\',\'PARTIALLY_USED\',\'CLOSED\') NOT NULL DEFAULT \'OPEN\' AFTER returned_kg', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_fabric_issue_roll' AND INDEX_NAME='ix_fir_roll');
SET @s = IF(@x=0, 'ALTER TABLE trx_fabric_issue_roll ADD KEY ix_fir_roll (fabric_roll_id)', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- ─────────────────────────────────────────────────────────────────
-- 3. MARKER VERSIONS — doc §7. CAD markers are edited freely; a lay
--    locks an immutable snapshot of the marker it used.
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS trx_marker_version (
  id                   BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id           BIGINT UNSIGNED NOT NULL,
  cad_req_id           BIGINT UNSIGNED NULL,
  marker_no            VARCHAR(60) NOT NULL COMMENT 'CAD marker_ref',
  version              INT NOT NULL DEFAULT 1,
  marker_name          VARCHAR(120) NULL,
  style_id             BIGINT UNSIGNED NULL,
  color_id             BIGINT UNSIGNED NULL,
  fabric_id            BIGINT UNSIGNED NULL,
  fabric_type          VARCHAR(80) NULL,
  gsm                  DECIMAL(8,2) NULL,
  width_in             DECIMAL(8,2) NULL,
  length_m             DECIMAL(10,3) NULL,
  sizes                JSON NULL COMMENT '["S","M","L"]',
  ratios               JSON NULL COMMENT '[2,3,3]',
  pieces_per_marker    INT NOT NULL DEFAULT 0,
  marker_kg_per_ply    DECIMAL(12,5) NULL COMMENT 'Fabric KG for one ply of this marker',
  cad_kg_per_pc        DECIMAL(12,5) NULL COMMENT 'Marker (CAD) consumption per piece',
  size_consumption     JSON NULL COMMENT '{"S":0.20,"M":0.22} KG per piece',
  uom                  VARCHAR(10) NOT NULL DEFAULT 'KG',
  cad_file_ref         VARCHAR(255) NULL,
  approved_by          BIGINT UNSIGNED NULL,
  approved_at          DATETIME NULL,
  is_locked            TINYINT(1) NOT NULL DEFAULT 0 COMMENT '1 once used by an executed lay',
  created_by           BIGINT UNSIGNED NULL,
  created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_mv (company_id, cad_req_id, marker_no, version),
  KEY ix_mv_style (style_id),
  CONSTRAINT fk_mv__company FOREIGN KEY (company_id) REFERENCES mst_company(id)
) ENGINE=InnoDB COMMENT='Immutable marker versions used by lays (doc §7)';

-- ─────────────────────────────────────────────────────────────────
-- 4. LAY PLAN / EXECUTION — doc §8, §9
-- ─────────────────────────────────────────────────────────────────
ALTER TABLE trx_lay_plan
  MODIFY COLUMN status ENUM('PLANNED','SPREAD','CUT','APPROVED','CANCELLED') DEFAULT 'PLANNED';
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_lay_plan' AND COLUMN_NAME='marker_version_id');
SET @s = IF(@x=0, 'ALTER TABLE trx_lay_plan ADD COLUMN marker_version_id BIGINT UNSIGNED NULL AFTER marker_ref', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_lay_plan' AND COLUMN_NAME='expected_pieces');
SET @s = IF(@x=0, 'ALTER TABLE trx_lay_plan ADD COLUMN expected_pieces INT UNSIGNED NOT NULL DEFAULT 0 COMMENT \'Marker pieces × ply\' AFTER ply_count', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_lay_plan' AND COLUMN_NAME='planned_kg');
SET @s = IF(@x=0, 'ALTER TABLE trx_lay_plan ADD COLUMN planned_kg DECIMAL(12,4) NULL AFTER expected_pieces', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_lay_plan' AND COLUMN_NAME='fabric_width_cm');
SET @s = IF(@x=0, 'ALTER TABLE trx_lay_plan ADD COLUMN fabric_width_cm DECIMAL(8,2) NULL AFTER planned_kg', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_lay_plan' AND COLUMN_NAME='operator_name');
SET @s = IF(@x=0, 'ALTER TABLE trx_lay_plan ADD COLUMN operator_name VARCHAR(80) NULL AFTER table_no', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_lay_plan' AND COLUMN_NAME='started_at');
SET @s = IF(@x=0, 'ALTER TABLE trx_lay_plan ADD COLUMN started_at DATETIME NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_lay_plan' AND COLUMN_NAME='executed_at');
SET @s = IF(@x=0, 'ALTER TABLE trx_lay_plan ADD COLUMN executed_at DATETIME NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_lay_plan' AND COLUMN_NAME='executed_by');
SET @s = IF(@x=0, 'ALTER TABLE trx_lay_plan ADD COLUMN executed_by BIGINT UNSIGNED NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_lay_plan' AND COLUMN_NAME='actual_kg');
SET @s = IF(@x=0, 'ALTER TABLE trx_lay_plan ADD COLUMN actual_kg DECIMAL(12,4) NOT NULL DEFAULT 0 COMMENT \'Σ lay roll consumption\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_lay_plan' AND COLUMN_NAME='actual_cut_qty');
SET @s = IF(@x=0, 'ALTER TABLE trx_lay_plan ADD COLUMN actual_cut_qty INT UNSIGNED NOT NULL DEFAULT 0 COMMENT \'Σ good cut pieces\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_lay_plan' AND COLUMN_NAME='approved_by');
SET @s = IF(@x=0, 'ALTER TABLE trx_lay_plan ADD COLUMN approved_by BIGINT UNSIGNED NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_lay_plan' AND COLUMN_NAME='approved_at');
SET @s = IF(@x=0, 'ALTER TABLE trx_lay_plan ADD COLUMN approved_at DATETIME NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_lay_plan' AND COLUMN_NAME='cancel_reason');
SET @s = IF(@x=0, 'ALTER TABLE trx_lay_plan ADD COLUMN cancel_reason VARCHAR(255) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- Roll-wise actual consumption of a lay (doc §9: Before − Remaining).
CREATE TABLE IF NOT EXISTS trx_lay_roll (
  id                   BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id           BIGINT UNSIGNED NOT NULL,
  lay_id               BIGINT UNSIGNED NOT NULL,
  fabric_issue_roll_id BIGINT UNSIGNED NULL COMMENT 'DC roll line this roll came from',
  fabric_roll_id       BIGINT UNSIGNED NULL COMMENT 'Roll stock record',
  roll_no              VARCHAR(60) NULL,
  lot_no               VARCHAR(60) NULL,
  plies                INT UNSIGNED NOT NULL DEFAULT 0,
  before_kg            DECIMAL(12,4) NOT NULL,
  after_kg             DECIMAL(12,4) NOT NULL DEFAULT 0,
  actual_consumed_kg   DECIMAL(12,4) NOT NULL,
  length_used_m        DECIMAL(10,3) NULL,
  created_by           BIGINT UNSIGNED NULL,
  created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_lr_lay (lay_id),
  KEY ix_lr_roll (fabric_roll_id),
  KEY ix_lr_dcroll (fabric_issue_roll_id),
  CONSTRAINT fk_lr__lay FOREIGN KEY (lay_id) REFERENCES trx_lay_plan(id),
  CONSTRAINT chk_lr_kg CHECK (actual_consumed_kg >= 0 AND after_kg >= 0 AND before_kg >= after_kg)
) ENGINE=InnoDB COMMENT='Roll-wise actual lay consumption (doc §9)';

-- Loss categories (doc §9, §16): end loss, selvedge, waste, remnant, other.
CREATE TABLE IF NOT EXISTS trx_cutting_loss (
  id                   BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id           BIGINT UNSIGNED NOT NULL,
  cutting_plan_id      BIGINT UNSIGNED NOT NULL,
  lay_id               BIGINT UNSIGNED NULL,
  loss_type            ENUM('CUTTING_WASTE','END_LOSS','SELVEDGE_LOSS','REMNANT','OTHER') NOT NULL,
  qty_kg               DECIMAL(12,4) NOT NULL,
  reason               VARCHAR(255) NULL,
  is_reversed          TINYINT(1) NOT NULL DEFAULT 0,
  reversed_by          BIGINT UNSIGNED NULL,
  reversed_at          DATETIME NULL,
  reversal_reason      VARCHAR(255) NULL,
  created_by           BIGINT UNSIGNED NULL,
  created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_cl_plan (cutting_plan_id),
  KEY ix_cl_lay (lay_id),
  CONSTRAINT chk_cl_qty CHECK (qty_kg >= 0)
) ENGINE=InnoDB COMMENT='Cutting loss categories (doc §16)';

-- ─────────────────────────────────────────────────────────────────
-- 5. CUT OUTPUT — doc §10
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS trx_cut_output (
  id                   BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id           BIGINT UNSIGNED NOT NULL,
  output_no            VARCHAR(40) NOT NULL,
  lay_id               BIGINT UNSIGNED NOT NULL,
  cutting_plan_id      BIGINT UNSIGNED NOT NULL,
  cutting_id           BIGINT UNSIGNED NULL COMMENT 'trx_cutting header the bundles hang off',
  io_no                VARCHAR(40) NULL,
  style_id             BIGINT UNSIGNED NULL,
  color_id             BIGINT UNSIGNED NULL,
  size_id              BIGINT UNSIGNED NOT NULL,
  good_qty             INT UNSIGNED NOT NULL DEFAULT 0,
  reject_qty           INT UNSIGNED NOT NULL DEFAULT 0,
  recut_qty            INT UNSIGNED NOT NULL DEFAULT 0,
  actual_kg            DECIMAL(12,5) NOT NULL DEFAULT 0 COMMENT 'Share of lay actual KG',
  kg_per_pc            DECIMAL(12,6) NULL,
  bundled_qty          INT UNSIGNED NOT NULL DEFAULT 0,
  status               ENUM('OPEN','COMPLETED','REVERSED') NOT NULL DEFAULT 'OPEN',
  created_by           BIGINT UNSIGNED NULL,
  created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_co_no (company_id, output_no),
  KEY ix_co_lay (lay_id),
  KEY ix_co_plan (cutting_plan_id),
  CONSTRAINT fk_co__lay FOREIGN KEY (lay_id) REFERENCES trx_lay_plan(id),
  CONSTRAINT chk_co_bundled CHECK (bundled_qty <= good_qty)
) ENGINE=InnoDB COMMENT='Size-wise cut output of a lay (doc §10)';

-- trx_cutting becomes the lay's cutting header; plans without a
-- production order must still be able to cut.
ALTER TABLE trx_cutting MODIFY COLUMN prod_order_id BIGINT UNSIGNED NULL;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_cutting' AND COLUMN_NAME='cutting_plan_id');
SET @s = IF(@x=0, 'ALTER TABLE trx_cutting ADD COLUMN cutting_plan_id BIGINT UNSIGNED NULL AFTER prod_order_id', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_cutting' AND COLUMN_NAME='lay_id');
SET @s = IF(@x=0, 'ALTER TABLE trx_cutting ADD COLUMN lay_id BIGINT UNSIGNED NULL AFTER cutting_plan_id', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_cutting' AND COLUMN_NAME='is_cancelled');
SET @s = IF(@x=0, 'ALTER TABLE trx_cutting ADD COLUMN is_cancelled TINYINT(1) NOT NULL DEFAULT 0', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- ─────────────────────────────────────────────────────────────────
-- 6. SIZE CONSUMPTION — doc §12, §13 (source + effective date/version)
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS trx_size_consumption (
  id                   BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id           BIGINT UNSIGNED NOT NULL,
  style_id             BIGINT UNSIGNED NOT NULL,
  color_id             BIGINT UNSIGNED NULL,
  fabric_id            BIGINT UNSIGNED NULL,
  size_id              BIGINT UNSIGNED NOT NULL,
  kg_per_pc            DECIMAL(12,6) NOT NULL,
  source               ENUM('COSTING','MARKER','ACTUAL','APPROVED') NOT NULL,
  source_ref           VARCHAR(120) NULL,
  version              INT NOT NULL DEFAULT 1,
  effective_from       DATE NOT NULL,
  is_active            TINYINT(1) NOT NULL DEFAULT 1,
  created_by           BIGINT UNSIGNED NULL,
  created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_sc_lookup (company_id, style_id, size_id, effective_from)
) ENGINE=InnoDB COMMENT='Size-specific consumption with source/version (doc §13)';

-- ─────────────────────────────────────────────────────────────────
-- 7. BUNDLES — doc §11, §14
-- ─────────────────────────────────────────────────────────────────
ALTER TABLE trx_cutting_bundle
  MODIFY COLUMN status ENUM('GENERATED','CHECKED','ISSUED','IN_SEWING','COMPLETED','FINISHING','PACKED','SHIPPED','SPLIT','CLOSED','CANCELLED') DEFAULT 'GENERATED';
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_cutting_bundle' AND COLUMN_NAME='company_id');
SET @s = IF(@x=0, 'ALTER TABLE trx_cutting_bundle ADD COLUMN company_id BIGINT UNSIGNED NULL FIRST', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_cutting_bundle' AND COLUMN_NAME='lay_id');
SET @s = IF(@x=0, 'ALTER TABLE trx_cutting_bundle ADD COLUMN lay_id BIGINT UNSIGNED NULL AFTER cutting_id', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_cutting_bundle' AND COLUMN_NAME='cut_output_id');
SET @s = IF(@x=0, 'ALTER TABLE trx_cutting_bundle ADD COLUMN cut_output_id BIGINT UNSIGNED NULL AFTER lay_id', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_cutting_bundle' AND COLUMN_NAME='marker_version_id');
SET @s = IF(@x=0, 'ALTER TABLE trx_cutting_bundle ADD COLUMN marker_version_id BIGINT UNSIGNED NULL AFTER cut_output_id', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_cutting_bundle' AND COLUMN_NAME='parent_bundle_id');
SET @s = IF(@x=0, 'ALTER TABLE trx_cutting_bundle ADD COLUMN parent_bundle_id BIGINT UNSIGNED NULL AFTER marker_version_id', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_cutting_bundle' AND COLUMN_NAME='allocated_kg');
SET @s = IF(@x=0, 'ALTER TABLE trx_cutting_bundle ADD COLUMN allocated_kg DECIMAL(12,5) NULL COMMENT \'Allocated/calculated fabric KG — NOT a physical weight\' AFTER qty', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_cutting_bundle' AND COLUMN_NAME='allocation_method');
SET @s = IF(@x=0, 'ALTER TABLE trx_cutting_bundle ADD COLUMN allocation_method ENUM(\'SIZE_CONSUMPTION\',\'LAY_AVERAGE\',\'MANUAL\') NULL AFTER allocated_kg', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_cutting_bundle' AND COLUMN_NAME='allocation_source');
SET @s = IF(@x=0, 'ALTER TABLE trx_cutting_bundle ADD COLUMN allocation_source VARCHAR(160) NULL AFTER allocation_method', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_cutting_bundle' AND COLUMN_NAME='balance_qty');
SET @s = IF(@x=0, 'ALTER TABLE trx_cutting_bundle ADD COLUMN balance_qty INT UNSIGNED NULL COMMENT \'PCS still available to the next stage\' AFTER allocation_source', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_cutting_bundle' AND COLUMN_NAME='created_by');
SET @s = IF(@x=0, 'ALTER TABLE trx_cutting_bundle ADD COLUMN created_by BIGINT UNSIGNED NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_cutting_bundle' AND COLUMN_NAME='created_at');
SET @s = IF(@x=0, 'ALTER TABLE trx_cutting_bundle ADD COLUMN created_at DATETIME NULL DEFAULT CURRENT_TIMESTAMP', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- Backfill company and balance on existing bundles.
UPDATE trx_cutting_bundle b JOIN trx_cutting c ON c.id = b.cutting_id
   SET b.company_id = c.company_id WHERE b.company_id IS NULL;
UPDATE trx_cutting_bundle SET balance_qty = qty WHERE balance_qty IS NULL;
SET @x = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_cutting_bundle' AND INDEX_NAME='uq_cb_barcode');
SET @s = IF(@x=0, 'ALTER TABLE trx_cutting_bundle ADD UNIQUE KEY uq_cb_barcode (barcode)', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_cutting_bundle' AND INDEX_NAME='ix_cb_company');
SET @s = IF(@x=0, 'ALTER TABLE trx_cutting_bundle ADD KEY ix_cb_company (company_id)', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_cutting_bundle' AND INDEX_NAME='ix_cb_parent');
SET @s = IF(@x=0, 'ALTER TABLE trx_cutting_bundle ADD KEY ix_cb_parent (parent_bundle_id)', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_cutting_bundle' AND INDEX_NAME='ix_cb_lay');
SET @s = IF(@x=0, 'ALTER TABLE trx_cutting_bundle ADD KEY ix_cb_lay (lay_id)', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- Movement history: location / work centre / quantities per stage (doc §15).
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_bundle_movement' AND COLUMN_NAME='txn_type');
SET @s = IF(@x=0, 'ALTER TABLE trx_bundle_movement ADD COLUMN txn_type VARCHAR(40) NULL AFTER to_stage', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_bundle_movement' AND COLUMN_NAME='location');
SET @s = IF(@x=0, 'ALTER TABLE trx_bundle_movement ADD COLUMN location VARCHAR(80) NULL AFTER destination', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_bundle_movement' AND COLUMN_NAME='work_center');
SET @s = IF(@x=0, 'ALTER TABLE trx_bundle_movement ADD COLUMN work_center VARCHAR(80) NULL AFTER location', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_bundle_movement' AND COLUMN_NAME='good_qty');
SET @s = IF(@x=0, 'ALTER TABLE trx_bundle_movement ADD COLUMN good_qty INT UNSIGNED NULL AFTER moved_qty', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_bundle_movement' AND COLUMN_NAME='reject_qty');
SET @s = IF(@x=0, 'ALTER TABLE trx_bundle_movement ADD COLUMN reject_qty INT UNSIGNED NULL AFTER good_qty', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_bundle_movement' AND COLUMN_NAME='rework_qty');
SET @s = IF(@x=0, 'ALTER TABLE trx_bundle_movement ADD COLUMN rework_qty INT UNSIGNED NULL AFTER reject_qty', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_bundle_movement' AND COLUMN_NAME='ref_table');
SET @s = IF(@x=0, 'ALTER TABLE trx_bundle_movement ADD COLUMN ref_table VARCHAR(60) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_bundle_movement' AND COLUMN_NAME='ref_id');
SET @s = IF(@x=0, 'ALTER TABLE trx_bundle_movement ADD COLUMN ref_id BIGINT UNSIGNED NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- Every barcode scan is logged (doc §19).
CREATE TABLE IF NOT EXISTS trx_bundle_scan_log (
  id                   BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id           BIGINT UNSIGNED NOT NULL,
  bundle_id            BIGINT UNSIGNED NULL,
  scanned_code         VARCHAR(120) NOT NULL,
  context              VARCHAR(40) NULL COMMENT 'TRACE / SEWING_IN / PACKING …',
  result               ENUM('FOUND','NOT_FOUND') NOT NULL,
  user_id              BIGINT UNSIGNED NULL,
  workstation          VARCHAR(120) NULL,
  ip_address           VARCHAR(64) NULL,
  scanned_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_bsl_bundle (bundle_id),
  KEY ix_bsl_company_time (company_id, scanned_at)
) ENGINE=InnoDB COMMENT='Bundle barcode scan log (doc §19)';

-- Carton ↔ bundle link so shipment traces back to fabric (doc §23, §29).
CREATE TABLE IF NOT EXISTS trx_carton_bundle (
  id                   BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  carton_id            BIGINT UNSIGNED NOT NULL,
  bundle_id            BIGINT UNSIGNED NOT NULL,
  qty                  INT UNSIGNED NOT NULL,
  created_by           BIGINT UNSIGNED NULL,
  created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_ctb (carton_id, bundle_id),
  KEY ix_ctb_bundle (bundle_id),
  CONSTRAINT fk_ctb__carton FOREIGN KEY (carton_id) REFERENCES trx_carton(id),
  CONSTRAINT fk_ctb__bundle FOREIGN KEY (bundle_id) REFERENCES trx_cutting_bundle(id)
) ENGINE=InnoDB COMMENT='Bundles packed into each carton';

-- ─────────────────────────────────────────────────────────────────
-- 8. CUTTING RECONCILIATION — doc §16
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS trx_cutting_reconciliation (
  id                   BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id           BIGINT UNSIGNED NOT NULL,
  recon_no             VARCHAR(40) NOT NULL,
  cutting_plan_id      BIGINT UNSIGNED NOT NULL,
  issued_kg            DECIMAL(12,4) NOT NULL DEFAULT 0,
  returned_kg          DECIMAL(12,4) NOT NULL DEFAULT 0,
  consumed_kg          DECIMAL(12,4) NOT NULL DEFAULT 0,
  waste_kg             DECIMAL(12,4) NOT NULL DEFAULT 0,
  end_loss_kg          DECIMAL(12,4) NOT NULL DEFAULT 0,
  selvedge_kg          DECIMAL(12,4) NOT NULL DEFAULT 0,
  remnant_kg           DECIMAL(12,4) NOT NULL DEFAULT 0,
  other_loss_kg        DECIMAL(12,4) NOT NULL DEFAULT 0,
  unaccounted_kg       DECIMAL(12,4) NOT NULL DEFAULT 0,
  tolerance_pct        DECIMAL(6,3) NOT NULL DEFAULT 0.5,
  tolerance_kg         DECIMAL(12,4) NOT NULL DEFAULT 0,
  status               ENUM('DRAFT','VARIANCE_PENDING','APPROVED','CLOSED','REOPENED') NOT NULL DEFAULT 'DRAFT',
  variance_reason      VARCHAR(500) NULL,
  approved_by          BIGINT UNSIGNED NULL,
  approved_at          DATETIME NULL,
  closed_by            BIGINT UNSIGNED NULL,
  closed_at            DATETIME NULL,
  created_by           BIGINT UNSIGNED NULL,
  created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by           BIGINT UNSIGNED NULL,
  updated_at           DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_crec_no (company_id, recon_no),
  KEY ix_crec_plan (cutting_plan_id)
) ENGINE=InnoDB COMMENT='Cutting close reconciliation (doc §16)';

INSERT IGNORE INTO cfg_system_setting (company_id, setting_key, setting_value, description)
SELECT id, 'CUTTING_RECON_TOLERANCE_PCT', '0.5', 'Max unaccounted fabric (% of issued KG) before cutting close needs variance approval'
  FROM mst_company;
