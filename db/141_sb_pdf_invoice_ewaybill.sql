-- =====================================================================
-- 141 · Shipping bill PDF + e-way bill from the commercial invoice (client voice notes 23-Oct-2026, late)
--   - the customs shipping bill PDF (ICEGATE LET EXPORT COPY) is uploaded on the shipping bill: its fields are read
--     once (pages 1–2) to fill the form, and the PDF stays attached for reference (a file — only its link here)
--   - an e-way bill can be made from the commercial invoice; the generated EWB no is written back on the invoice and
--     printed on it with its QR code
-- Idempotent: the runner re-applies files >= 10 on every deploy.
-- =====================================================================
DROP PROCEDURE IF EXISTS _sbp_add_col;
CREATE PROCEDURE _sbp_add_col(IN t VARCHAR(64), IN c VARCHAR(64), IN ddl VARCHAR(500))
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = t AND COLUMN_NAME = c) THEN
    SET @q = CONCAT('ALTER TABLE ', t, ' ADD COLUMN ', c, ' ', ddl);
    PREPARE s1 FROM @q; EXECUTE s1; DEALLOCATE PREPARE s1;
  END IF;
END;
CALL _sbp_add_col('trx_shipping_bill', 'sb_pdf_url',  'VARCHAR(300) NULL COMMENT ''Customs shipping bill PDF (uploads/shipping-bills)''');
CALL _sbp_add_col('trx_shipping_bill', 'sb_pdf_name', 'VARCHAR(200) NULL');
CALL _sbp_add_col('trx_shipping_bill', 'sb_pdf_pages', 'INT NULL');
CALL _sbp_add_col('trx_shipping_bill', 'pdf_read_fields', 'JSON NULL COMMENT ''Fields read from the PDF (what the form was filled with)''');
CALL _sbp_add_col('trx_commercial_invoice', 'eway_bill_no', 'VARCHAR(20) NULL');
DROP PROCEDURE IF EXISTS _sbp_add_col;

SET @x = (SELECT COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_eway_bill' AND COLUMN_NAME='source_type');
SET @s = IF(@x NOT LIKE '%COMMERCIAL_INVOICE%',
  'ALTER TABLE trx_eway_bill MODIFY source_type ENUM(''DISPATCH'',''PROCESS_DC'',''PURCHASE_RETURN'',''GATE_OUTWARD'',''STOCK_DELIVERY'',''COMMERCIAL_INVOICE'',''MANUAL'') NOT NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
