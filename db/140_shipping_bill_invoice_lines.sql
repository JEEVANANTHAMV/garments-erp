-- =====================================================================
-- 140 · Shipping bill from the commercial invoice + invoice line columns (client voice notes 23-Oct-2026)
--   1. Sales order line: composition + description of goods (from the style's fabric composition, editable) —
--      the commercial invoice takes its "Description of Goods / Composition" from here.
--   2. Commercial invoice lines as the client's template: S.NO | Order No (buyer PO) | Style/Ref No | Colour | Size |
--      Description of Goods / Composition | HSN | Qty (PCS/PACKS) | Price | Total.
--   3. Shipping bill (ICEGATE "LET EXPORT COPY", yellow-marked in the client's PDF): picking the commercial
--      invoice brings invoice no / date / value / currency; SB no + date, FOB ₹, freight, insurance, exchange rate,
--      DBK claim, IGST amount, RoDTEP and RoSCTL are entered. The incentives are entered here once and kept as
--      finance claims (trx_export_incentive, received / credited tracked in Finance) and in the order P&L.
-- Idempotent: the runner re-applies files >= 10 on every deploy.
-- =====================================================================

DROP PROCEDURE IF EXISTS _sb_add_col;
CREATE PROCEDURE _sb_add_col(IN t VARCHAR(64), IN c VARCHAR(64), IN ddl VARCHAR(500))
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = t AND COLUMN_NAME = c) THEN
    SET @q = CONCAT('ALTER TABLE ', t, ' ADD COLUMN ', c, ' ', ddl);
    PREPARE s1 FROM @q; EXECUTE s1; DEALLOCATE PREPARE s1;
  END IF;
END;

-- 1. sales order line
CALL _sb_add_col('trx_sales_order_line', 'composition',       'VARCHAR(120) NULL COMMENT ''e.g. 95% COTTON 5% ELASTANE (from the style fabric, editable)''');
CALL _sb_add_col('trx_sales_order_line', 'goods_description', 'VARCHAR(255) NULL COMMENT ''Description of goods for the invoice / shipping bill (blank = built from composition + style)''');

-- 2. invoice line columns of the template
CALL _sb_add_col('trx_commercial_invoice_line', 'style_ref', 'VARCHAR(60) NULL COMMENT ''Style / Ref No column''');
CALL _sb_add_col('trx_commercial_invoice_line', 'colour',    'VARCHAR(80) NULL');
CALL _sb_add_col('trx_commercial_invoice_line', 'size_text', 'VARCHAR(80) NULL COMMENT ''Size or size range (S-XXL)''');
UPDATE trx_commercial_invoice_line SET style_ref = supplier_mat_no WHERE style_ref IS NULL AND supplier_mat_no IS NOT NULL;

-- 3. shipping bill
CALL _sb_add_col('trx_shipping_bill', 'mode',              'VARCHAR(4) NULL COMMENT ''SEA / AIR / ROAD''');
CALL _sb_add_col('trx_shipping_bill', 'port_of_loading',   'VARCHAR(80) NULL');
CALL _sb_add_col('trx_shipping_bill', 'port_of_discharge', 'VARCHAR(80) NULL');
CALL _sb_add_col('trx_shipping_bill', 'country_dest',      'VARCHAR(60) NULL');
CALL _sb_add_col('trx_shipping_bill', 'invoice_no',        'VARCHAR(40) NULL COMMENT ''From the commercial invoice''');
CALL _sb_add_col('trx_shipping_bill', 'invoice_date',      'DATE NULL');
CALL _sb_add_col('trx_shipping_bill', 'currency_code',     'VARCHAR(3) NULL');
CALL _sb_add_col('trx_shipping_bill', 'invoice_value_fc',  'DECIMAL(18,2) NULL COMMENT ''Invoice amount (foreign currency)''');
CALL _sb_add_col('trx_shipping_bill', 'invoice_term',      'VARCHAR(4) NULL COMMENT ''FOB / CF / CIF …''');
CALL _sb_add_col('trx_shipping_bill', 'exchange_rate',     'DECIMAL(18,4) NULL COMMENT ''Customs rate (₹ per 1 unit)''');
CALL _sb_add_col('trx_shipping_bill', 'fob_fc',            'DECIMAL(18,2) NULL');
CALL _sb_add_col('trx_shipping_bill', 'freight_inr',       'DECIMAL(18,2) NOT NULL DEFAULT 0');
CALL _sb_add_col('trx_shipping_bill', 'insurance_inr',     'DECIMAL(18,2) NOT NULL DEFAULT 0');
CALL _sb_add_col('trx_shipping_bill', 'igst_value',        'DECIMAL(18,2) NOT NULL DEFAULT 0 COMMENT ''Taxable value for IGST''');
CALL _sb_add_col('trx_shipping_bill', 'igst_amount',       'DECIMAL(18,2) NOT NULL DEFAULT 0');
CALL _sb_add_col('trx_shipping_bill', 'rosctl_amount',     'DECIMAL(18,2) NOT NULL DEFAULT 0');
CALL _sb_add_col('trx_shipping_bill', 'lut',               'TINYINT(1) NOT NULL DEFAULT 0 COMMENT ''Export under LUT''');
CALL _sb_add_col('trx_shipping_bill', 'leo_no',            'VARCHAR(30) NULL');
CALL _sb_add_col('trx_shipping_bill', 'packages',          'INT NULL');
CALL _sb_add_col('trx_shipping_bill', 'gross_weight_kg',   'DECIMAL(12,3) NULL');
CALL _sb_add_col('trx_shipping_bill', 'bl_awb_no',         'VARCHAR(40) NULL COMMENT ''MAWB / BL no''');
CALL _sb_add_col('trx_shipping_bill', 'bl_awb_date',       'DATE NULL');
CALL _sb_add_col('trx_shipping_bill', 'ad_code',           'VARCHAR(20) NULL');
CALL _sb_add_col('trx_shipping_bill', 'brc_due_date',      'DATE NULL COMMENT ''BRC realisation date''');
CALL _sb_add_col('trx_shipping_bill', 'remarks',           'VARCHAR(500) NULL');
CALL _sb_add_col('trx_shipping_bill', 'updated_by',        'BIGINT UNSIGNED NULL');
CALL _sb_add_col('trx_shipping_bill', 'updated_at',        'DATETIME NULL ON UPDATE CURRENT_TIMESTAMP');
CALL _sb_add_col('trx_shipping_bill', 'row_version',       'INT NOT NULL DEFAULT 1');
CALL _sb_add_col('trx_export_incentive', 'source',         'VARCHAR(14) NOT NULL DEFAULT ''MANUAL'' COMMENT ''SHIPPING_BILL = claim amount kept by the shipping bill''');
CALL _sb_add_col('trx_export_incentive', 'updated_at',     'DATETIME NULL ON UPDATE CURRENT_TIMESTAMP');
DROP PROCEDURE IF EXISTS _sb_add_col;

SET @x = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_export_incentive' AND INDEX_NAME='ix_inc_sb');
SET @s = IF(@x=0, 'ALTER TABLE trx_export_incentive ADD KEY ix_inc_sb (shipping_bill_id, incentive_type)', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- shipping bills made before: snapshot the invoice fields they show
UPDATE trx_shipping_bill sb JOIN trx_commercial_invoice ci ON ci.id = sb.invoice_id LEFT JOIN cfg_currency cu ON cu.id = ci.currency_id
   SET sb.invoice_no = ci.invoice_no, sb.invoice_date = ci.invoice_date, sb.currency_code = cu.code, sb.invoice_value_fc = ci.total_value,
       sb.exchange_rate = COALESCE(sb.exchange_rate, ci.exchange_rate)
 WHERE sb.invoice_no IS NULL;
