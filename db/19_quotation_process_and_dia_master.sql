-- =============================================================================
-- Migration 19: Fabric Tube Dia Master & Quotation Process (Job Work) Enhancements
-- Adds:
--   1. mst_dia: Tube diameter master for circular knit fabrics
--   2. trx_quotation: quotation_category ('PURCHASE', 'PROCESS') and process_name
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. FABRIC TUBE DIA MASTER (mst_dia)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mst_dia (
  id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  company_id      BIGINT UNSIGNED   NOT NULL,
  dia_value       DECIMAL(6,2)      NOT NULL,
  uom             VARCHAR(20)       DEFAULT 'INCH',
  is_active       TINYINT(1)        DEFAULT 1,
  created_at      TIMESTAMP         DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP         DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_dia__company FOREIGN KEY (company_id) REFERENCES app_company(id),
  UNIQUE KEY uk_dia__company_val (company_id, dia_value)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- 2. QUOTATION PURCHASE VS PROCESS (trx_quotation)
-- -----------------------------------------------------------------------------
SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_quotation' AND COLUMN_NAME = 'quotation_category');
SET @sql = IF(@col_exist = 0, "ALTER TABLE trx_quotation ADD COLUMN quotation_category ENUM('PURCHASE','PROCESS') NOT NULL DEFAULT 'PURCHASE' AFTER quotation_type", 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_quotation' AND COLUMN_NAME = 'process_name');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_quotation ADD COLUMN process_name VARCHAR(100) NULL AFTER quotation_category', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
