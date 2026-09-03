-- =====================================================================
--  Role-specific fields on mst_party
--  Buyer columns already existed; this adds the supplier, job-work and
--  agent equivalents so each Business Partner role has its own data.
-- =====================================================================

DROP PROCEDURE IF EXISTS add_col_if_missing;

CREATE PROCEDURE add_col_if_missing(
  IN tbl VARCHAR(64), IN col VARCHAR(64), IN ddl TEXT)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = tbl AND COLUMN_NAME = col
  ) THEN
    SET @s = CONCAT('ALTER TABLE `', tbl, '` ADD COLUMN `', col, '` ', ddl);
    PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  END IF;
END;

-- ---- Supplier-specific (is_supplier = 1) ----------------------------
CALL add_col_if_missing('mst_party','supplier_category',   "VARCHAR(50)");
CALL add_col_if_missing('mst_party','lead_time_days',      "INT DEFAULT 0");
CALL add_col_if_missing('mst_party','min_order_qty',       "DECIMAL(18,3) DEFAULT 0");
CALL add_col_if_missing('mst_party','supplier_rating',     "ENUM('A','B','C','D','UNRATED') DEFAULT 'UNRATED'");
CALL add_col_if_missing('mst_party','delivery_terms',      "VARCHAR(120)");
CALL add_col_if_missing('mst_party','quality_agreement',   "TINYINT(1) NOT NULL DEFAULT 0");
CALL add_col_if_missing('mst_party','supplier_remarks',    "VARCHAR(500)");

-- ---- Job worker / CMT-specific (is_vendor = 1) ----------------------
CALL add_col_if_missing('mst_party','jobwork_process',      "VARCHAR(120)");
CALL add_col_if_missing('mst_party','jobwork_capacity_day', "INT DEFAULT 0");
CALL add_col_if_missing('mst_party','jobwork_rate_basis',   "ENUM('PER_PIECE','PER_KG','PER_HOUR','PER_DOZEN','LUMPSUM') DEFAULT 'PER_PIECE'");
CALL add_col_if_missing('mst_party','jobwork_rate',         "DECIMAL(18,4) DEFAULT 0");
CALL add_col_if_missing('mst_party','jobwork_gate_terms',   "VARCHAR(120)");
CALL add_col_if_missing('mst_party','jobwork_remarks',      "VARCHAR(500)");

-- ---- Buying agent-specific (is_agent = 1) ---------------------------
CALL add_col_if_missing('mst_party','commission_pct',    "DECIMAL(6,3) DEFAULT 0");
CALL add_col_if_missing('mst_party','commission_basis',  "ENUM('FOB','ORDER_VALUE','QTY','INVOICE_VALUE') DEFAULT 'FOB'");
CALL add_col_if_missing('mst_party','commission_payout', "VARCHAR(120)");
CALL add_col_if_missing('mst_party','agent_territory',   "VARCHAR(120)");
CALL add_col_if_missing('mst_party','agent_remarks',     "VARCHAR(500)");

-- ---- Merchandiser-specific (is_merchandiser = 1) --------------------
CALL add_col_if_missing('mst_party','is_merchandiser',          "TINYINT(1) NOT NULL DEFAULT 0");
CALL add_col_if_missing('mst_party','merchandiser_type',        "VARCHAR(50)");
CALL add_col_if_missing('mst_party','merchandiser_division',    "VARCHAR(100)");
CALL add_col_if_missing('mst_party','merchandiser_brands',      "VARCHAR(255)");
CALL add_col_if_missing('mst_party','merchandiser_target',      "DECIMAL(18,2) DEFAULT 0");
CALL add_col_if_missing('mst_party','merchandiser_commission',  "DECIMAL(6,3) DEFAULT 0");
CALL add_col_if_missing('mst_party','merchandiser_remarks',     "VARCHAR(500)");

DROP PROCEDURE IF EXISTS add_col_if_missing;
