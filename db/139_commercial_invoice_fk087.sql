-- =====================================================================
-- 139 · Commercial invoice in the client's shipping format FK-087 (voice note 23-Oct-2026: "use this format for
--   the invoice for shipping"). FK-087.xls holds two layouts of the same invoice:
--     BUYER  — "BUYER INVOICE": goods in USD, bank details + REX declaration (EU GSP origin) in the footer
--     IGST   — "IGST INVOICE": the same goods plus charges (hanger cost), the INR value at the exchange rate and
--              IGST paid per rate (5 % garments / 18 % hangers), import-bond note in the footer
--   Header boxes (exporter, consignee, buyer, ship-to, transport, terms), marks & numbers, packages, per-line
--   buyer references (order no, SKU / EAN, buyer item id, supplier material no) and totals come from the
--   confirmed packing list(s) of the invoice and stay editable on the invoice.
-- Idempotent: the runner re-applies files >= 10 on every deploy.
-- =====================================================================

DROP PROCEDURE IF EXISTS _ci_add_col;
CREATE PROCEDURE _ci_add_col(IN t VARCHAR(64), IN c VARCHAR(64), IN ddl VARCHAR(500))
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = t AND COLUMN_NAME = c) THEN
    SET @q = CONCAT('ALTER TABLE ', t, ' ADD COLUMN ', c, ' ', ddl);
    PREPARE s1 FROM @q; EXECUTE s1; DEALLOCATE PREPARE s1;
  END IF;
END;

-- header
CALL _ci_add_col('trx_commercial_invoice', 'invoice_format',     'VARCHAR(8) NOT NULL DEFAULT ''BUYER'' COMMENT ''BUYER (buyer invoice: bank + REX) / IGST (INR value + IGST paid)''');
CALL _ci_add_col('trx_commercial_invoice', 'doc_status',         'VARCHAR(10) NOT NULL DEFAULT ''DRAFT'' COMMENT ''DRAFT / FINAL — a final invoice is read-only until reopened''');
CALL _ci_add_col('trx_commercial_invoice', 'exporter_details',   'TEXT NULL');
CALL _ci_add_col('trx_commercial_invoice', 'exporter_ref',       'VARCHAR(200) NULL COMMENT ''Exporter''''s Ref. box (IEC NO …)''');
CALL _ci_add_col('trx_commercial_invoice', 'buyer_order_ref',    'VARCHAR(500) NULL COMMENT ''PO NO: … DT: … (one line per PO)''');
CALL _ci_add_col('trx_commercial_invoice', 'other_references',   'VARCHAR(500) NULL');
CALL _ci_add_col('trx_commercial_invoice', 'consignee_details',  'TEXT NULL');
CALL _ci_add_col('trx_commercial_invoice', 'buyer_details',      'TEXT NULL COMMENT ''Buyer (if other than consignee)''');
CALL _ci_add_col('trx_commercial_invoice', 'ship_to_details',    'TEXT NULL COMMENT ''SHIP TO (DELIVERY ADDRESS)''');
CALL _ci_add_col('trx_commercial_invoice', 'country_origin_text','VARCHAR(60) NULL');
CALL _ci_add_col('trx_commercial_invoice', 'country_dest_text',  'VARCHAR(60) NULL');
CALL _ci_add_col('trx_commercial_invoice', 'pre_carriage_by',    'VARCHAR(80) NULL');
CALL _ci_add_col('trx_commercial_invoice', 'place_of_receipt',   'VARCHAR(80) NULL');
CALL _ci_add_col('trx_commercial_invoice', 'vessel_flight_no',   'VARCHAR(80) NULL');
CALL _ci_add_col('trx_commercial_invoice', 'terms_of_delivery',  'VARCHAR(500) NULL');
CALL _ci_add_col('trx_commercial_invoice', 'terms_of_payment',   'VARCHAR(500) NULL');
CALL _ci_add_col('trx_commercial_invoice', 'marks_nos',          'TEXT NULL COMMENT ''Marks & Nos. / Container No. column''');
CALL _ci_add_col('trx_commercial_invoice', 'packages_text',      'VARCHAR(200) NULL COMMENT ''No. & Kind of Pkgs. (e.g. 200 CTNS / 200 PACKAGES)''');
CALL _ci_add_col('trx_commercial_invoice', 'goods_heading',      'TEXT NULL COMMENT ''Description of goods above the lines''');
CALL _ci_add_col('trx_commercial_invoice', 'qty_unit',           'VARCHAR(12) NOT NULL DEFAULT ''PCS''');
CALL _ci_add_col('trx_commercial_invoice', 'item_ref_label',     'VARCHAR(30) NULL COMMENT ''Caption of the buyer item id column, e.g. COOP ID NO''');
CALL _ci_add_col('trx_commercial_invoice', 'rate_basis',         'VARCHAR(20) NULL COMMENT ''Rate column caption, e.g. FOB USD''');
CALL _ci_add_col('trx_commercial_invoice', 'total_cartons',      'INT NULL');
CALL _ci_add_col('trx_commercial_invoice', 'total_pcs',          'INT NULL');
CALL _ci_add_col('trx_commercial_invoice', 'total_pcs_unit',     'VARCHAR(12) NULL COMMENT ''PCS / PACKS / SETS''');
CALL _ci_add_col('trx_commercial_invoice', 'net_weight_kg',      'DECIMAL(12,3) NULL');
CALL _ci_add_col('trx_commercial_invoice', 'gross_weight_kg',    'DECIMAL(12,3) NULL');
CALL _ci_add_col('trx_commercial_invoice', 'qty_words',          'VARCHAR(300) NULL COMMENT ''Blank = worked out from the quantity''');
CALL _ci_add_col('trx_commercial_invoice', 'amount_words',       'VARCHAR(300) NULL COMMENT ''Blank = worked out from the total''');
CALL _ci_add_col('trx_commercial_invoice', 'bank_details',       'TEXT NULL');
CALL _ci_add_col('trx_commercial_invoice', 'rex_declaration',    'TEXT NULL');
CALL _ci_add_col('trx_commercial_invoice', 'declaration',        'TEXT NULL');
CALL _ci_add_col('trx_commercial_invoice', 'footer_note',        'TEXT NULL COMMENT ''IGST format: import bond / other note above the declaration''');
CALL _ci_add_col('trx_commercial_invoice', 'charges_gst_rate',   'DECIMAL(5,2) NULL COMMENT ''IGST format: GST % on charge lines (hangers 18)''');
CALL _ci_add_col('trx_commercial_invoice', 'goods_gst_rate',     'DECIMAL(5,2) NULL COMMENT ''IGST format: GST % on goods (5)''');
CALL _ci_add_col('trx_commercial_invoice', 'remarks',            'TEXT NULL');
CALL _ci_add_col('trx_commercial_invoice', 'finalized_by',       'BIGINT UNSIGNED NULL');
CALL _ci_add_col('trx_commercial_invoice', 'finalized_at',       'DATETIME NULL');
CALL _ci_add_col('trx_commercial_invoice', 'updated_by',         'BIGINT UNSIGNED NULL');
CALL _ci_add_col('trx_commercial_invoice', 'updated_at',         'DATETIME NULL ON UPDATE CURRENT_TIMESTAMP');
CALL _ci_add_col('trx_commercial_invoice', 'row_version',        'INT NOT NULL DEFAULT 1');

-- lines
CALL _ci_add_col('trx_commercial_invoice_line', 'sort_order',      'INT NOT NULL DEFAULT 0');
CALL _ci_add_col('trx_commercial_invoice_line', 'line_kind',       'VARCHAR(8) NOT NULL DEFAULT ''GOODS'' COMMENT ''GOODS / CHARGE (hanger cost …)''');
CALL _ci_add_col('trx_commercial_invoice_line', 'so_id',           'BIGINT UNSIGNED NULL');
CALL _ci_add_col('trx_commercial_invoice_line', 'color_id',        'BIGINT UNSIGNED NULL');
CALL _ci_add_col('trx_commercial_invoice_line', 'order_no',        'VARCHAR(60) NULL COMMENT ''Buyer order (PO) no''');
CALL _ci_add_col('trx_commercial_invoice_line', 'buyer_sku_no',    'VARCHAR(60) NULL COMMENT ''Buyer SKU / EAN''');
CALL _ci_add_col('trx_commercial_invoice_line', 'buyer_item_no',   'VARCHAR(60) NULL COMMENT ''Buyer item id (e.g. COOP ID NO)''');
CALL _ci_add_col('trx_commercial_invoice_line', 'supplier_mat_no', 'VARCHAR(60) NULL COMMENT ''Our material / style no''');
CALL _ci_add_col('trx_commercial_invoice_line', 'gst_rate',        'DECIMAL(5,2) NULL COMMENT ''IGST % of the line (blank = invoice default for its kind)''');

SET @x = (SELECT DATA_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_commercial_invoice_line' AND COLUMN_NAME='qty');
SET @s = IF(@x='int', 'ALTER TABLE trx_commercial_invoice_line MODIFY qty DECIMAL(14,3) NOT NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT CHARACTER_MAXIMUM_LENGTH FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_commercial_invoice_line' AND COLUMN_NAME='description');
SET @s = IF(@x < 500, 'ALTER TABLE trx_commercial_invoice_line MODIFY description VARCHAR(500) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
DROP PROCEDURE IF EXISTS _ci_add_col;

-- ------------------------------------------------------------ document defaults (per company; the latest invoice of the buyer wins)
INSERT IGNORE INTO cfg_system_setting (company_id, setting_key, setting_value, description)
SELECT id, 'CI_EXPORTER_DETAILS', NULL, 'Commercial invoice: exporter box (name, address, GST no — one line each). Blank = company master' FROM mst_company;
INSERT IGNORE INTO cfg_system_setting (company_id, setting_key, setting_value, description)
SELECT id, 'CI_BANK_DETAILS', NULL, 'Commercial invoice (buyer format): OUR BANK DETAILS block' FROM mst_company;
INSERT IGNORE INTO cfg_system_setting (company_id, setting_key, setting_value, description)
SELECT id, 'CI_REX_DECLARATION', NULL, 'Commercial invoice (buyer format): REX declaration (EU GSP statement of origin)' FROM mst_company;
INSERT IGNORE INTO cfg_system_setting (company_id, setting_key, setting_value, description)
SELECT id, 'CI_DECLARATION', CONCAT('“Any Dispute arising out of this transaction/contract will be refered to institutional Arbitration Council of', CHAR(10), '‘Tirupur as per the rules and regulations of Arbitration Council of ‘Tirupur and the award passed will be binding on us"'),
       'Commercial invoice: declaration at the foot' FROM mst_company;

-- permissions: the invoice keeps the EXPORT.* rights it had; finalising / reopening needs EXPORT.APPROVE
INSERT INTO mst_permission (module_id, permission_code, permission_name)
SELECT m.id, 'EXPORT.APPROVE', 'Finalise / reopen commercial invoices' FROM mst_module m
 WHERE m.module_code = 'EXPORT' AND NOT EXISTS (SELECT 1 FROM mst_permission x WHERE x.permission_code = 'EXPORT.APPROVE');
INSERT INTO map_role_permission (role_id, permission_id)
SELECT DISTINCT mrp.role_id, p.id FROM map_role_permission mrp
  JOIN mst_role r ON r.id = mrp.role_id
  JOIN mst_permission src ON src.id = mrp.permission_id AND src.permission_code = 'EXPORT.UPDATE'
  JOIN mst_permission p ON p.permission_code = 'EXPORT.APPROVE'
 WHERE NOT EXISTS (SELECT 1 FROM cfg_system_setting g WHERE g.company_id = r.company_id AND g.setting_key = 'CI_PERMS_GRANTED')
   AND NOT EXISTS (SELECT 1 FROM map_role_permission m WHERE m.role_id = mrp.role_id AND m.permission_id = p.id);
INSERT IGNORE INTO cfg_system_setting (company_id, setting_key, setting_value, description)
SELECT id, 'CI_PERMS_GRANTED', '1', 'EXPORT.APPROVE granted to roles with EXPORT.UPDATE (one time, migration 139)' FROM mst_company;
