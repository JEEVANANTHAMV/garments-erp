-- =====================================================================
-- 59. SALES ORDER NUMBER FORMAT + ASSORT COLOUR
-- ---------------------------------------------------------------------
-- Client review 24-Sep-2026: the SO number follows the legacy format
--   G11 E 26 CAPE 0570
--   |   |  |  |    +-- 4-digit running number (per company per year)
--   |   |  |  +------- buyer I/O prefix (mst_party.io_prefix)
--   |   |  +---------- 2-digit year of the SO date
--   |   +------------- order type initial (E/D/P/S)
--   +----------------- merchandiser group (G01 .. G99)
-- The Internal Order (IO) number stays a separate number.
--
--  * mst_party.group_code        - group of a merchandiser partner.
--  * trx_sales_order.order_group - group picked on the order.
--  * cfg_so_number_seq           - running-number row per company + year,
--                                  locked FOR UPDATE while numbering.
--  * trx_sales_order_line.assort_color - assort colour entered per line.
-- Every statement is idempotent: the migrate runner re-applies files.
-- =====================================================================


-- mst_party
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='mst_party' AND COLUMN_NAME='group_code');
SET @s = IF(@x=0, 'ALTER TABLE mst_party ADD COLUMN group_code VARCHAR(4) NULL COMMENT \'Merchandiser group (G01..G99) used in SO numbers\' AFTER io_prefix', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- trx_sales_order
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_sales_order' AND COLUMN_NAME='order_group');
SET @s = IF(@x=0, 'ALTER TABLE trx_sales_order ADD COLUMN order_group VARCHAR(4) NULL COMMENT \'Merchandiser group (G01..G99)\' AFTER merchandiser_id', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- trx_sales_order_line
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_sales_order_line' AND COLUMN_NAME='assort_color');
SET @s = IF(@x=0, 'ALTER TABLE trx_sales_order_line ADD COLUMN assort_color VARCHAR(80) NULL COMMENT \'Assort colour entered on the order\' AFTER color_id', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- Running number for the SO format, one row per company + 2-digit year.
CREATE TABLE IF NOT EXISTS cfg_so_number_seq (
  company_id  BIGINT UNSIGNED NOT NULL,
  yy          CHAR(2) NOT NULL,
  next_number INT UNSIGNED NOT NULL DEFAULT 1,
  PRIMARY KEY (company_id, yy),
  CONSTRAINT fk_sonseq__company FOREIGN KEY (company_id) REFERENCES mst_company(id)
) ENGINE=InnoDB COMMENT='Sales order number running sequence (per company per year)';

-- Continue after any order already numbered in the new format (e.g. keyed in
-- from the legacy software) so the first generated number never collides.
INSERT INTO cfg_so_number_seq (company_id, yy, next_number)
SELECT company_id, SUBSTRING(so_no, 5, 2), MAX(CAST(RIGHT(so_no, 4) AS UNSIGNED)) + 1
  FROM trx_sales_order
 WHERE so_no REGEXP '^G[0-9]{2}[EDPS][0-9]{2}[A-Z0-9]+[0-9]{4}$'
 GROUP BY company_id, SUBSTRING(so_no, 5, 2)
ON DUPLICATE KEY UPDATE next_number = GREATEST(cfg_so_number_seq.next_number, VALUES(next_number));
