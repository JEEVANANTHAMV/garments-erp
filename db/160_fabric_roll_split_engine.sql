-- =====================================================================
-- 160 · Fabric roll inventory & partial roll split (client doc "C_ONE_ERP_Fabric_Roll_Management_Developer_Document",
--       voice note 23-Nov-2026: 10 rolls / 500 KG → one roll cut in two → 11 pieces, purchase KG unchanged).
--
--   * trx_fabric_roll.stock_status gets SPLIT and MERGED: a parent that was cut / merged is no longer a physical
--     piece. It is never counted as a roll in stock, and the GRN still shows what was received.
--   * original_weight_kg: the KG the roll was born with (GRN / process / split …). Never changed afterwards —
--     stock audits / scrap / delivery change weight_kg (the current gross), never the original.
--   * roll_origin: RECEIPT (GRN, process / knitting inward, opening stock) / SPLIT / MERGE / RETURN / TRANSFER.
--     GRN roll counts use RECEIPT only, so a cut never changes the purchase count.
--   * supplier_roll_no: the number on the supplier's sticker, kept when the ERP roll no had to be made unique.
--   * Unique (company_id, roll_no): added only when the data has no duplicates (the app also makes numbers unique).
--   * Split documents (header + lines, variance + approval), roll transfers between stores, label print log.
--   * Settings: split tolerance (KG and %), cut a roll automatically when a DC takes part of it.
-- Idempotent and additive: the runner re-applies files >= 10 on every deploy.
-- =====================================================================

-- ---------- roll columns ----------
SET @t = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_fabric_roll');

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_fabric_roll' AND COLUMN_NAME = 'stock_status' AND COLUMN_TYPE LIKE '%''SPLIT''%');
SET @s = IF(@t = 1 AND @x = 0, 'ALTER TABLE trx_fabric_roll MODIFY stock_status ENUM(''AVAILABLE'',''RESERVED'',''ISSUED'',''PARTIAL'',''CLOSED'',''SPLIT'',''MERGED'') NOT NULL DEFAULT ''AVAILABLE''', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_fabric_roll' AND COLUMN_NAME = 'original_weight_kg');
SET @s = IF(@t = 1 AND @x = 0, 'ALTER TABLE trx_fabric_roll
  ADD COLUMN original_weight_kg DECIMAL(18,3) NULL COMMENT ''KG the roll was created with (GRN / process / split) — never changed'',
  ADD COLUMN roll_origin VARCHAR(12) NOT NULL DEFAULT ''RECEIPT'' COMMENT ''RECEIPT / SPLIT / MERGE / RETURN / TRANSFER'',
  ADD COLUMN supplier_roll_no VARCHAR(60) NULL COMMENT ''Roll no on the supplier sticker when it differs from the ERP roll no'',
  ADD COLUMN split_id BIGINT UNSIGNED NULL COMMENT ''Split document that created (child) or closed (parent) the roll'',
  ADD COLUMN measured_meters TINYINT(1) NOT NULL DEFAULT 0 COMMENT ''1 = actual_meters was measured, 0 = calculated / carried'',
  ADD KEY ix_froll_origin (company_id, grn_id, roll_origin),
  ADD KEY ix_froll_split (split_id)', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- roll no copies on cutting DCs / spreading were 40 chars; child roll nos (R-…-S12) need the full 60
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_fabric_issue_roll' AND COLUMN_NAME = 'roll_no' AND CHARACTER_MAXIMUM_LENGTH < 60);
SET @s = IF(@x = 1, 'ALTER TABLE trx_fabric_issue_roll MODIFY roll_no VARCHAR(60) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_spreading' AND COLUMN_NAME = 'roll_no' AND CHARACTER_MAXIMUM_LENGTH < 60);
SET @s = IF(@x = 1, 'ALTER TABLE trx_spreading MODIFY roll_no VARCHAR(60) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- ---------- backfill (only rows not set yet) ----------
-- children made before this migration: origin from the roll history
UPDATE trx_fabric_roll fr
   SET fr.roll_origin = CASE
         WHEN EXISTS (SELECT 1 FROM trx_fabric_roll_history h WHERE h.roll_id = fr.id AND h.event = 'SPLIT_FROM') THEN 'SPLIT'
         WHEN EXISTS (SELECT 1 FROM trx_fabric_roll_history h WHERE h.roll_id = fr.id AND h.event = 'MERGED_FROM') THEN 'MERGE'
         WHEN fr.process_state = 'RETURNED' AND fr.parent_roll_id IS NOT NULL THEN 'RETURN'
         WHEN fr.parent_roll_id IS NOT NULL AND EXISTS (SELECT 1 FROM trx_fabric_roll_history h WHERE h.roll_id = fr.id AND h.event = 'JOB_TRANSFER' AND h.related_roll_id = fr.parent_roll_id) THEN 'TRANSFER'
         ELSE 'RECEIPT' END
 WHERE fr.original_weight_kg IS NULL;

-- original KG = today's weight less the stores adjustments recorded on the roll (audit / scrap / rejection / delivery)
UPDATE trx_fabric_roll fr
   SET fr.original_weight_kg = ROUND(COALESCE(fr.weight_kg, 0) - COALESCE((
         SELECT SUM(h.qty_kg) FROM trx_fabric_roll_history h
          WHERE h.roll_id = fr.id AND h.event IN ('STOCK_AUDIT', 'SCRAP', 'REJECTION', 'DELIVERY', 'DELIVERY_RETURN')), 0), 3)
 WHERE fr.original_weight_kg IS NULL;

-- parents already split / merged were saved as CLOSED: give them their real status
UPDATE trx_fabric_roll fr SET fr.stock_status = 'SPLIT'
 WHERE fr.stock_status = 'CLOSED' AND EXISTS (SELECT 1 FROM trx_fabric_roll_history h WHERE h.roll_id = fr.id AND h.event = 'SPLIT');
UPDATE trx_fabric_roll fr SET fr.stock_status = 'MERGED'
 WHERE fr.stock_status = 'CLOSED' AND EXISTS (SELECT 1 FROM trx_fabric_roll_history h WHERE h.roll_id = fr.id AND h.event = 'MERGE');

-- ---------- unique roll no per company (only when the data allows it) ----------
SET @k = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_fabric_roll' AND INDEX_NAME = 'uq_froll_company_rollno');
SET @d = IF(@t = 1, (SELECT COUNT(*) FROM (SELECT company_id, roll_no FROM trx_fabric_roll GROUP BY company_id, roll_no HAVING COUNT(*) > 1) x), 1);
SET @s = IF(@t = 1 AND @k = 0 AND @d = 0, 'ALTER TABLE trx_fabric_roll ADD UNIQUE KEY uq_froll_company_rollno (company_id, roll_no)', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- ---------- split documents ----------
CREATE TABLE IF NOT EXISTS trx_fabric_roll_split (
  id                 BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id         BIGINT UNSIGNED NOT NULL,
  split_no           VARCHAR(40) NOT NULL,
  split_date         DATE NOT NULL,
  parent_roll_id     BIGINT UNSIGNED NOT NULL,
  parent_roll_no     VARCHAR(60) NOT NULL,
  reason_code        VARCHAR(30) NOT NULL COMMENT 'PROCESS_ISSUE / CONTRACTOR_ISSUE / CUTTING / DAMAGE_REMOVAL / STORE_TRANSFER / AUTO_DC / OTHER',
  remarks            VARCHAR(255) NULL,
  source             VARCHAR(20) NOT NULL DEFAULT 'MANUAL' COMMENT 'MANUAL / PROCESS_DC / JOBWORK_DC',
  source_ref_type    VARCHAR(30) NULL,
  source_ref_id      BIGINT UNSIGNED NULL,
  source_ref_no      VARCHAR(60) NULL,
  measurement_source VARCHAR(20) NOT NULL DEFAULT 'WEIGHING_SCALE' COMMENT 'WEIGHING_SCALE / MANUAL / SYSTEM',
  input_kg           DECIMAL(18,3) NOT NULL COMMENT 'KG on the parent roll when it was cut',
  output_kg          DECIMAL(18,3) NOT NULL,
  variance_kg        DECIMAL(18,3) NOT NULL DEFAULT 0 COMMENT 'input − output = cutting loss (never negative)',
  tolerance_kg       DECIMAL(18,3) NOT NULL DEFAULT 0,
  input_m            DECIMAL(18,3) NULL,
  output_m           DECIMAL(18,3) NULL,
  cost_per_kg        DECIMAL(18,4) NULL COMMENT 'Parent cost per KG carried to every piece',
  loss_value         DECIMAL(18,2) NULL COMMENT 'variance_kg × cost_per_kg (written off)',
  status             VARCHAR(20) NOT NULL DEFAULT 'POSTED' COMMENT 'PENDING_APPROVAL / POSTED / REJECTED / CANCELLED',
  requested_by       BIGINT UNSIGNED NULL,
  requested_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  approved_by        BIGINT UNSIGNED NULL,
  approved_at        DATETIME NULL,
  approval_remarks   VARCHAR(255) NULL,
  posted_by          BIGINT UNSIGNED NULL,
  posted_at          DATETIME NULL,
  UNIQUE KEY uq_frs_no (company_id, split_no),
  KEY ix_frs_parent (parent_roll_id),
  KEY ix_frs_status (company_id, status),
  KEY ix_frs_date (company_id, split_date)
) ENGINE=InnoDB COMMENT='Fabric roll split (cut) documents: parent closed, child rolls created';

CREATE TABLE IF NOT EXISTS trx_fabric_roll_split_line (
  id               BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  split_id         BIGINT UNSIGNED NOT NULL,
  line_no          INT NOT NULL,
  output_type      VARCHAR(12) NOT NULL COMMENT 'STORE / ISSUE / QC_HOLD / DAMAGE',
  weight_kg        DECIMAL(18,3) NOT NULL,
  length_m         DECIMAL(18,3) NULL COMMENT 'Measured meter (blank = carried pro-rata, calculated)',
  warehouse_id     BIGINT UNSIGNED NULL COMMENT 'Store the piece goes to (blank = parent store)',
  location_bin     VARCHAR(50) NULL,
  remarks          VARCHAR(255) NULL,
  child_roll_id    BIGINT UNSIGNED NULL,
  child_roll_no    VARCHAR(60) NULL,
  UNIQUE KEY uq_frsl_line (split_id, line_no),
  UNIQUE KEY uq_frsl_child (child_roll_id),
  KEY ix_frsl_split (split_id)
) ENGINE=InnoDB COMMENT='Pieces of a fabric roll split';

-- ---------- roll transfers between stores ----------
CREATE TABLE IF NOT EXISTS trx_fabric_roll_transfer (
  id                BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id        BIGINT UNSIGNED NOT NULL,
  transfer_no       VARCHAR(40) NOT NULL,
  transfer_date     DATE NOT NULL,
  to_warehouse_id   BIGINT UNSIGNED NOT NULL,
  to_location_bin   VARCHAR(50) NULL,
  reason            VARCHAR(255) NOT NULL,
  total_rolls       INT NOT NULL DEFAULT 0,
  total_kg          DECIMAL(18,3) NOT NULL DEFAULT 0,
  created_by        BIGINT UNSIGNED NULL,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_frt_no (company_id, transfer_no),
  KEY ix_frt_date (company_id, transfer_date)
) ENGINE=InnoDB COMMENT='Fabric roll moves between stores / bins';

CREATE TABLE IF NOT EXISTS trx_fabric_roll_transfer_line (
  id                BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  transfer_id       BIGINT UNSIGNED NOT NULL,
  fabric_roll_id    BIGINT UNSIGNED NOT NULL,
  roll_no           VARCHAR(60) NOT NULL,
  from_warehouse_id BIGINT UNSIGNED NULL,
  from_location_bin VARCHAR(50) NULL,
  qty_kg            DECIMAL(18,3) NOT NULL,
  KEY ix_frtl_transfer (transfer_id),
  KEY ix_frtl_roll (fabric_roll_id)
) ENGINE=InnoDB COMMENT='Rolls of a fabric roll transfer';

-- ---------- label print log ----------
CREATE TABLE IF NOT EXISTS trx_fabric_roll_label (
  id             BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id     BIGINT UNSIGNED NOT NULL,
  roll_id        BIGINT UNSIGNED NOT NULL,
  roll_no        VARCHAR(60) NOT NULL,
  print_kind     VARCHAR(10) NOT NULL DEFAULT 'FIRST' COMMENT 'FIRST / REPRINT',
  reprint_reason VARCHAR(255) NULL,
  balance_kg     DECIMAL(18,3) NULL COMMENT 'KG printed on the label',
  status         VARCHAR(10) NOT NULL DEFAULT 'ACTIVE' COMMENT 'ACTIVE / VOID (roll split / merged)',
  printed_by     BIGINT UNSIGNED NULL,
  printed_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_frl_roll (roll_id),
  KEY ix_frl_company (company_id, printed_at)
) ENGINE=InnoDB COMMENT='Fabric roll label prints / reprints (audit)';

-- ---------- settings (editable under Admin › Settings) ----------
INSERT IGNORE INTO cfg_system_setting (company_id, setting_key, setting_value, description)
SELECT id, 'ROLL_SPLIT_TOLERANCE_KG', '0.05', 'Fabric roll split: cutting loss up to this KG posts straight away (the larger of KG and %)' FROM mst_company;
INSERT IGNORE INTO cfg_system_setting (company_id, setting_key, setting_value, description)
SELECT id, 'ROLL_SPLIT_TOLERANCE_PCT', '0.5', 'Fabric roll split: cutting loss up to this % of the roll posts straight away; above it a store supervisor (Inventory Adjust) must approve' FROM mst_company;
INSERT IGNORE INTO cfg_system_setting (company_id, setting_key, setting_value, description)
SELECT id, 'FABRIC_PARTIAL_ISSUE_SPLIT', '1', 'Fabric DC (process / job work) taking part of a roll: 1 = cut the roll — the piece sent and the piece left get their own roll nos; 0 = keep one roll no' FROM mst_company;

-- ---------- number series ----------
INSERT INTO cfg_number_series (company_id, branch_id, doc_type, fy_id, prefix, next_number, padding)
SELECT c.id, NULL, 'ROLL_SPLIT', NULL, 'RSP-', 1, 5 FROM mst_company c
 WHERE NOT EXISTS (SELECT 1 FROM cfg_number_series s WHERE s.company_id = c.id AND s.doc_type = 'ROLL_SPLIT');
INSERT INTO cfg_number_series (company_id, branch_id, doc_type, fy_id, prefix, next_number, padding)
SELECT c.id, NULL, 'ROLL_TRANSFER', NULL, 'RTR-', 1, 5 FROM mst_company c
 WHERE NOT EXISTS (SELECT 1 FROM cfg_number_series s WHERE s.company_id = c.id AND s.doc_type = 'ROLL_TRANSFER');
