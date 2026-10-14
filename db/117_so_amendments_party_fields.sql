-- =====================================================================
-- 117. SALES ORDER AMENDMENTS, CLOSURE, ORDER TYPE / NUMBER FORMAT,
--      PARTY BANK & STATUTORY FIELDS   (client call 14-Oct-2026)
-- ---------------------------------------------------------------------
--  * trx_sales_order_amendment (+ _line): ADDITIONAL / CANCEL quantity
--    amendments of a running (approved) order, numbered A1, A2 … per order.
--    Additional quantity is added as NEW order lines (is_additional = 1,
--    amendment_id) — original lines are never edited. Cancelled quantity
--    is taken off the line / size and kept in cancelled_qty.
--  * trx_sales_order closure: closure_type (CANCELLED / SHORT_CLOSED /
--    COMPLETED), closed_date, close_reason, closed_by / closed_at — so
--    reports can list orders cancelled / closed in a period.
--  * order_type gains JOB_WORK (initial J in the SO number).
--  * SO_NUMBER_FORMAT setting: DEFAULT (today's numbering) or
--    TEAM_TYPE_FY_BUYER_JOB (G01 E 26 ACT 9999, running number per FY,
--    sequence in cfg_so_number_seq_fy).
--  * mst_party: short_code (3-letter buyer code for the SO number),
--    msme_applicable, tds_category. MSME category / number / valid from
--    reuse msme_type / udyam_no / udyam_date; bank details live in
--    mst_party_bank (existing child table).
-- Every statement is idempotent: the migrate runner re-applies files.
-- =====================================================================

-- ── trx_sales_order_line ──────────────────────────────────────────────
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_sales_order_line' AND COLUMN_NAME='is_additional');
SET @s = IF(@x=0, 'ALTER TABLE trx_sales_order_line ADD COLUMN is_additional TINYINT(1) NOT NULL DEFAULT 0 COMMENT ''1 = added by an ADDITIONAL amendment'', ADD COLUMN amendment_id BIGINT UNSIGNED NULL COMMENT ''Amendment that added this line'', ADD COLUMN cancelled_qty INT NOT NULL DEFAULT 0 COMMENT ''Qty cancelled by CANCEL amendments''', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- ── trx_sales_order_sku ───────────────────────────────────────────────
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_sales_order_sku' AND COLUMN_NAME='cancelled_qty');
SET @s = IF(@x=0, 'ALTER TABLE trx_sales_order_sku ADD COLUMN cancelled_qty INT NOT NULL DEFAULT 0 COMMENT ''Qty cancelled by CANCEL amendments''', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- ── trx_sales_order: order type JOB_WORK + closure ────────────────────
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_sales_order' AND COLUMN_NAME='order_type' AND COLUMN_TYPE LIKE '%JOB_WORK%');
SET @s = IF(@x=0, "ALTER TABLE trx_sales_order MODIFY COLUMN order_type ENUM('SAMPLE','PROJECTION','DOMESTIC','EXPORT','JOB_WORK') NULL DEFAULT 'EXPORT'", 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_sales_order' AND COLUMN_NAME='closure_type');
SET @s = IF(@x=0, "ALTER TABLE trx_sales_order ADD COLUMN closure_type ENUM('CANCELLED','SHORT_CLOSED','COMPLETED') NULL COMMENT 'How the order was closed', ADD COLUMN closed_date DATE NULL, ADD COLUMN close_reason VARCHAR(300) NULL, ADD COLUMN closed_by BIGINT UNSIGNED NULL, ADD COLUMN closed_at DATETIME NULL, ADD COLUMN cancelled_qty INT NOT NULL DEFAULT 0 COMMENT 'Sum of line cancelled_qty', ADD COLUMN additional_qty INT NOT NULL DEFAULT 0 COMMENT 'Sum of additional-line qty'", 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @x = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_sales_order' AND INDEX_NAME='ix_so__closure');
SET @s = IF(@x=0, 'ALTER TABLE trx_sales_order ADD INDEX ix_so__closure (company_id, closure_type, closed_date)', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- Orders already closed / cancelled through the state change keep a closure row for reports.
UPDATE trx_sales_order
   SET closure_type = IF(approval_state = 'CANCELLED', 'CANCELLED', 'COMPLETED'),
       closed_date = DATE(COALESCE(updated_at, created_at))
 WHERE approval_state IN ('CLOSED', 'CANCELLED') AND closure_type IS NULL;

-- ── Amendments ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS trx_sales_order_amendment (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  so_id           BIGINT UNSIGNED NOT NULL,
  amendment_no    VARCHAR(10) NOT NULL COMMENT 'A1, A2 … per order',
  amendment_seq   INT UNSIGNED NOT NULL,
  amendment_date  DATE NOT NULL,
  amendment_type  ENUM('ADDITIONAL','CANCEL') NOT NULL,
  reason          VARCHAR(500) NULL,
  buyer_ref       VARCHAR(80) NULL COMMENT 'Buyer revision / mail reference',
  total_qty       INT NOT NULL DEFAULT 0,
  status          ENUM('POSTED','CANCELLED') NOT NULL DEFAULT 'POSTED',
  void_reason     VARCHAR(300) NULL,
  voided_by       BIGINT UNSIGNED NULL,
  voided_at       DATETIME NULL,
  created_by      BIGINT UNSIGNED NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_soam__no (so_id, amendment_seq),
  KEY ix_soam__company (company_id, amendment_date),
  CONSTRAINT fk_soam__so FOREIGN KEY (so_id) REFERENCES trx_sales_order(id)
) ENGINE=InnoDB COMMENT='Sales order quantity amendments (additional / cancel)';

CREATE TABLE IF NOT EXISTS trx_sales_order_amendment_line (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  amendment_id    BIGINT UNSIGNED NOT NULL,
  so_line_id      BIGINT UNSIGNED NULL COMMENT 'Line added (ADDITIONAL) or reduced (CANCEL)',
  so_sku_id       BIGINT UNSIGNED NULL COMMENT 'trx_sales_order_sku row touched',
  style_id        BIGINT UNSIGNED NOT NULL,
  color_id        BIGINT UNSIGNED NULL,
  size_id         BIGINT UNSIGNED NULL,
  sku_id          BIGINT UNSIGNED NULL,
  qty             INT NOT NULL COMMENT 'Qty added / cancelled (positive)',
  plan_cut_qty    INT NOT NULL DEFAULT 0 COMMENT 'Plan-cut pieces added / removed',
  before_qty      INT NOT NULL DEFAULT 0 COMMENT 'Order qty of this style/colour/size cell before',
  after_qty       INT NOT NULL DEFAULT 0 COMMENT 'Order qty of this style/colour/size cell after',
  KEY ix_soaml__am (amendment_id),
  CONSTRAINT fk_soaml__am FOREIGN KEY (amendment_id) REFERENCES trx_sales_order_amendment(id)
) ENGINE=InnoDB COMMENT='Sales order amendment lines (per colour / size cell)';

-- ── SO number: FY sequence + format setting ───────────────────────────
CREATE TABLE IF NOT EXISTS cfg_so_number_seq_fy (
  company_id  BIGINT UNSIGNED NOT NULL,
  fy          CHAR(2) NOT NULL COMMENT 'Financial year start, e.g. 26 = Apr-2026..Mar-2027',
  next_number INT UNSIGNED NOT NULL DEFAULT 1,
  PRIMARY KEY (company_id, fy)
) ENGINE=InnoDB COMMENT='Running number for SO_NUMBER_FORMAT = TEAM_TYPE_FY_BUYER_JOB';

INSERT INTO cfg_system_setting (company_id, setting_key, setting_value, description, is_editable)
SELECT c.id, 'SO_NUMBER_FORMAT', 'DEFAULT',
       'Sales order number: DEFAULT (group+type+year+buyer prefix+no) or TEAM_TYPE_FY_BUYER_JOB (G01 E 26 ACT 9999, running no per FY)', 1
  FROM mst_company c
 WHERE NOT EXISTS (SELECT 1 FROM cfg_system_setting x WHERE x.company_id = c.id AND x.setting_key = 'SO_NUMBER_FORMAT');

-- ── mst_party ─────────────────────────────────────────────────────────
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='mst_party' AND COLUMN_NAME='short_code');
SET @s = IF(@x=0, 'ALTER TABLE mst_party ADD COLUMN short_code VARCHAR(3) NULL COMMENT ''3-letter buyer code used in the SO number'' AFTER io_prefix', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='mst_party' AND COLUMN_NAME='msme_applicable');
SET @msme_new = (@x = 0);
SET @s = IF(@x=0, 'ALTER TABLE mst_party ADD COLUMN msme_applicable TINYINT(1) NOT NULL DEFAULT 0 COMMENT ''MSME registered: category = msme_type, number = udyam_no, valid from = udyam_date'' AFTER tax_id_foreign', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
UPDATE mst_party SET msme_applicable = 1 WHERE msme_applicable = 0 AND msme_type IS NOT NULL AND msme_type <> 'NA' AND @msme_new = 1;  -- only on the run that adds the column

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='mst_party' AND COLUMN_NAME='tds_category');
SET @s = IF(@x=0, 'ALTER TABLE mst_party ADD COLUMN tds_category VARCHAR(30) NULL COMMENT ''Deductee category: COMPANY / INDIVIDUAL_HUF / FIRM / OTHERS'' AFTER tds_applicable', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
