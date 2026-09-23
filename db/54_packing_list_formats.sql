-- =====================================================================
-- 54. PACKING LIST FORMATS — ASSORTED / SOLID / MIXED (client voice note 2)
-- ---------------------------------------------------------------------
-- Models the three packing-list formats the client uses (packinglist.xlsx):
--
--   ASSORTED  one size ratio per carton (S1 M2 L3 XL3 XXL2 XXXL1 = 12 pcs)
--   SOLID     one size per carton (numeric 36..52), sub-total per colour
--   MIXED     kids + adult size sets on one list, PCS/PACK × PACK/CTN
--             and cartons that mix several colours / styles
--
-- Structure:  packing list → block (label + size header set)
--               → carton row (carton-number range, packs, weights, dims)
--                 → row item (order / style / colour + qty per size)
--
-- plus the export document header (exporter, invoice, buyer order,
-- consignee, notify party, ports, vessel, terms) and a manual order-qty
-- table used for the Order / Shipped / Diff summary when the list is not
-- linked to a sales order. Every statement is idempotent.
-- =====================================================================

-- ─────────────────────────────────────────────────────────────────
-- 1. Header: packing lists are prepared BEFORE the commercial invoice,
--    so invoice_id must be optional (it was NOT NULL in migration 07).
-- ─────────────────────────────────────────────────────────────────
ALTER TABLE trx_packing_list MODIFY COLUMN invoice_id BIGINT UNSIGNED NULL;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_packing_list' AND COLUMN_NAME='invoice_no');
SET @s = IF(@x=0, 'ALTER TABLE trx_packing_list ADD COLUMN invoice_no VARCHAR(60) NULL COMMENT \'Printed invoice no (free text when the invoice is not yet in the ERP)\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_packing_list' AND COLUMN_NAME='invoice_date');
SET @s = IF(@x=0, 'ALTER TABLE trx_packing_list ADD COLUMN invoice_date DATE NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_packing_list' AND COLUMN_NAME='buyer_order_no');
SET @s = IF(@x=0, 'ALTER TABLE trx_packing_list ADD COLUMN buyer_order_no VARCHAR(80) NULL COMMENT \'Buyer PO no\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_packing_list' AND COLUMN_NAME='buyer_order_date');
SET @s = IF(@x=0, 'ALTER TABLE trx_packing_list ADD COLUMN buyer_order_date DATE NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_packing_list' AND COLUMN_NAME='other_references');
SET @s = IF(@x=0, 'ALTER TABLE trx_packing_list ADD COLUMN other_references VARCHAR(500) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_packing_list' AND COLUMN_NAME='exporter_details');
SET @s = IF(@x=0, 'ALTER TABLE trx_packing_list ADD COLUMN exporter_details TEXT NULL COMMENT \'Exporter name + address block, one line per row\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_packing_list' AND COLUMN_NAME='consignee_details');
SET @s = IF(@x=0, 'ALTER TABLE trx_packing_list ADD COLUMN consignee_details TEXT NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_packing_list' AND COLUMN_NAME='notify_label');
SET @s = IF(@x=0, 'ALTER TABLE trx_packing_list ADD COLUMN notify_label VARCHAR(40) NULL COMMENT \'"Notify Party" or "Goods Delivery address"\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_packing_list' AND COLUMN_NAME='notify_details');
SET @s = IF(@x=0, 'ALTER TABLE trx_packing_list ADD COLUMN notify_details TEXT NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_packing_list' AND COLUMN_NAME='country_of_origin');
SET @s = IF(@x=0, 'ALTER TABLE trx_packing_list ADD COLUMN country_of_origin VARCHAR(60) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_packing_list' AND COLUMN_NAME='country_of_destination');
SET @s = IF(@x=0, 'ALTER TABLE trx_packing_list ADD COLUMN country_of_destination VARCHAR(60) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_packing_list' AND COLUMN_NAME='pre_carriage_by');
SET @s = IF(@x=0, 'ALTER TABLE trx_packing_list ADD COLUMN pre_carriage_by VARCHAR(80) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_packing_list' AND COLUMN_NAME='place_of_receipt');
SET @s = IF(@x=0, 'ALTER TABLE trx_packing_list ADD COLUMN place_of_receipt VARCHAR(80) NULL COMMENT \'Place of receipt by pre-carrier\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_packing_list' AND COLUMN_NAME='vessel_flight_no');
SET @s = IF(@x=0, 'ALTER TABLE trx_packing_list ADD COLUMN vessel_flight_no VARCHAR(80) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_packing_list' AND COLUMN_NAME='port_of_loading');
SET @s = IF(@x=0, 'ALTER TABLE trx_packing_list ADD COLUMN port_of_loading VARCHAR(80) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_packing_list' AND COLUMN_NAME='port_of_discharge');
SET @s = IF(@x=0, 'ALTER TABLE trx_packing_list ADD COLUMN port_of_discharge VARCHAR(80) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_packing_list' AND COLUMN_NAME='final_destination');
SET @s = IF(@x=0, 'ALTER TABLE trx_packing_list ADD COLUMN final_destination VARCHAR(80) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_packing_list' AND COLUMN_NAME='terms_of_delivery');
SET @s = IF(@x=0, 'ALTER TABLE trx_packing_list ADD COLUMN terms_of_delivery VARCHAR(500) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_packing_list' AND COLUMN_NAME='terms_of_payment');
SET @s = IF(@x=0, 'ALTER TABLE trx_packing_list ADD COLUMN terms_of_payment VARCHAR(500) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_packing_list' AND COLUMN_NAME='allow_ctn_gaps');
SET @s = IF(@x=0, 'ALTER TABLE trx_packing_list ADD COLUMN allow_ctn_gaps TINYINT(1) NOT NULL DEFAULT 0 COMMENT \'1 = carton-number gaps between rows are intentional\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_packing_list' AND COLUMN_NAME='carton_tare_kg');
SET @s = IF(@x=0, 'ALTER TABLE trx_packing_list ADD COLUMN carton_tare_kg DECIMAL(8,3) NULL COMMENT \'Default gross - net per carton (packing material), used to pre-fill net weight\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_packing_list' AND COLUMN_NAME='remarks');
SET @s = IF(@x=0, 'ALTER TABLE trx_packing_list ADD COLUMN remarks TEXT NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_packing_list' AND COLUMN_NAME='updated_by');
SET @s = IF(@x=0, 'ALTER TABLE trx_packing_list ADD COLUMN updated_by BIGINT UNSIGNED NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_packing_list' AND COLUMN_NAME='updated_at');
SET @s = IF(@x=0, 'ALTER TABLE trx_packing_list ADD COLUMN updated_at DATETIME NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_packing_list' AND COLUMN_NAME='confirmed_by');
SET @s = IF(@x=0, 'ALTER TABLE trx_packing_list ADD COLUMN confirmed_by BIGINT UNSIGNED NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_packing_list' AND COLUMN_NAME='confirmed_at');
SET @s = IF(@x=0, 'ALTER TABLE trx_packing_list ADD COLUMN confirmed_at DATETIME NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_packing_list' AND COLUMN_NAME='reopen_reason');
SET @s = IF(@x=0, 'ALTER TABLE trx_packing_list ADD COLUMN reopen_reason VARCHAR(255) NULL COMMENT \'Reason given the last time a confirmed list was re-opened\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- ─────────────────────────────────────────────────────────────────
-- 2. Blocks — a titled section of rows with its own size-header set
--    (solid sheet: one block per colour; mixed sheet: kids / adult /
--    women blocks whose size columns carry different labels).
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS trx_packing_list_block (
  id               BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id       BIGINT UNSIGNED NOT NULL,
  packing_list_id  BIGINT UNSIGNED NOT NULL,
  block_no         INT UNSIGNED NOT NULL,
  label            VARCHAR(200) NULL COMMENT 'e.g. H26 VANPUR T SHIRT MARINE / Product Code:5957955',
  size_headers     JSON NULL COMMENT 'Size labels for this block (NULL = packing list size_headers)',
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_plb (packing_list_id, block_no),
  KEY ix_plb_company (company_id),
  CONSTRAINT fk_plb__pl FOREIGN KEY (packing_list_id) REFERENCES trx_packing_list(id)
) ENGINE=InnoDB COMMENT='Packing list block (section with its own size headers)';

-- ─────────────────────────────────────────────────────────────────
-- 3. Carton rows — one row per identical carton range.
--    Totals are always computed by the server.
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS trx_packing_list_row (
  id                BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id        BIGINT UNSIGNED NOT NULL,
  packing_list_id   BIGINT UNSIGNED NOT NULL,
  block_id          BIGINT UNSIGNED NOT NULL,
  sort_order        INT UNSIGNED NOT NULL DEFAULT 0,
  row_type          ENUM('ASSORTED','SOLID','MIXED') NOT NULL,
  ctn_from          INT UNSIGNED NOT NULL,
  ctn_to            INT UNSIGNED NOT NULL,
  no_of_ctns        INT UNSIGNED NOT NULL,
  pcs_per_pack      INT UNSIGNED NULL COMMENT 'MIXED pack rows: pieces in one pack (all item lines)',
  packs_per_ctn     INT UNSIGNED NULL COMMENT 'MIXED pack rows: packs in one carton',
  pcs_per_ctn       INT UNSIGNED NOT NULL,
  total_qty         INT UNSIGNED NOT NULL,
  net_wt_per_ctn    DECIMAL(10,3) NULL,
  gross_wt_per_ctn  DECIMAL(10,3) NULL,
  total_net_wt      DECIMAL(12,3) NOT NULL DEFAULT 0,
  total_gross_wt    DECIMAL(12,3) NOT NULL DEFAULT 0,
  length_cm         DECIMAL(8,2) NULL,
  width_cm          DECIMAL(8,2) NULL,
  height_cm         DECIMAL(8,2) NULL,
  cbm_per_ctn       DECIMAL(10,5) NULL,
  total_cbm         DECIMAL(12,5) NOT NULL DEFAULT 0,
  source_carton_ids JSON NULL COMMENT 'trx_carton ids this row was built from (packing linkage)',
  remarks           VARCHAR(255) NULL,
  KEY ix_plr_pl (packing_list_id, sort_order),
  KEY ix_plr_block (block_id),
  KEY ix_plr_company (company_id),
  CONSTRAINT fk_plr__pl    FOREIGN KEY (packing_list_id) REFERENCES trx_packing_list(id),
  CONSTRAINT fk_plr__block FOREIGN KEY (block_id) REFERENCES trx_packing_list_block(id)
) ENGINE=InnoDB COMMENT='Packing list carton row (carton-number range)';

-- ─────────────────────────────────────────────────────────────────
-- 4. Row items — what is inside each carton of the range.
--    size_qty is what the user enters: qty per PACK when the row has
--    packs_per_ctn, otherwise qty per CARTON. size_qty_per_ctn is the
--    server-computed qty per carton in both cases.
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS trx_packing_list_row_item (
  id                BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id        BIGINT UNSIGNED NOT NULL,
  packing_list_id   BIGINT UNSIGNED NOT NULL,
  row_id            BIGINT UNSIGNED NOT NULL,
  sort_order        INT UNSIGNED NOT NULL DEFAULT 0,
  so_id             BIGINT UNSIGNED NULL,
  order_no          VARCHAR(60) NULL,
  style_id          BIGINT UNSIGNED NULL,
  style_no          VARCHAR(80) NULL,
  style_name        VARCHAR(200) NULL,
  color_id          BIGINT UNSIGNED NULL,
  colour            VARCHAR(80) NULL,
  size_qty          JSON NOT NULL COMMENT '{"S":1,"M":2} per pack (pack rows) or per carton',
  size_qty_per_ctn  JSON NOT NULL COMMENT '{"S":14,"M":28} per carton (computed)',
  unit_qty          INT UNSIGNED NOT NULL COMMENT 'sum(size_qty)',
  qty_per_ctn       INT UNSIGNED NOT NULL,
  total_qty         INT UNSIGNED NOT NULL,
  KEY ix_plri_row (row_id, sort_order),
  KEY ix_plri_pl (packing_list_id),
  KEY ix_plri_company (company_id),
  CONSTRAINT fk_plri__row FOREIGN KEY (row_id) REFERENCES trx_packing_list_row(id),
  CONSTRAINT fk_plri__pl  FOREIGN KEY (packing_list_id) REFERENCES trx_packing_list(id)
) ENGINE=InnoDB COMMENT='Packing list row item (order/style/colour + qty per size)';

-- ─────────────────────────────────────────────────────────────────
-- 5. Manual order quantities for the Order / Shipped / Diff summary
--    (used only when no sales-order quantity can be matched).
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS trx_packing_list_order_qty (
  id               BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id       BIGINT UNSIGNED NOT NULL,
  packing_list_id  BIGINT UNSIGNED NOT NULL,
  group_key        VARCHAR(300) NOT NULL COMMENT 'order_no|style|colour, upper-cased',
  size_label       VARCHAR(20) NOT NULL,
  order_qty        INT UNSIGNED NOT NULL DEFAULT 0,
  UNIQUE KEY uq_ploq (packing_list_id, group_key, size_label),
  KEY ix_ploq_company (company_id),
  CONSTRAINT fk_ploq__pl FOREIGN KEY (packing_list_id) REFERENCES trx_packing_list(id)
) ENGINE=InnoDB COMMENT='Manual order qty per size for the packing list summary';
