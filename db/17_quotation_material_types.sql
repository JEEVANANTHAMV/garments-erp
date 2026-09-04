-- =============================================================================
-- Migration 17: Quotation Material Types & Line Enhancements
-- Adds:
--   • Expanded quotation_type ENUM: FABRIC, YARN, TRIMS, GENERAL, BUYER, IMPORT, DOMESTIC
--   • is_io_wise flag for General / Administration / Sample quotations
--   • Line fields: dia, gsm, yarn_type, yarn_count, trim_size, quotation_rate, confirm_rate, igst_rate, igst_amount
--   • Nullable style_id in trx_quotation_line
--   • certification field in mst_trim (Trims & Accessories Master)
-- =============================================================================

-- 1. Header: Expand quotation_type enum & add is_io_wise
ALTER TABLE trx_quotation
  MODIFY COLUMN quotation_type ENUM('DOMESTIC','IMPORT','BUYER','FABRIC','YARN','TRIMS','GENERAL') NOT NULL DEFAULT 'BUYER';

ALTER TABLE trx_quotation
  ADD COLUMN is_io_wise TINYINT(1) NOT NULL DEFAULT 0 AFTER quotation_type;

-- 2. Line Items: Nullable style_id and specific material attributes
ALTER TABLE trx_quotation_line
  MODIFY COLUMN style_id BIGINT UNSIGNED NULL;

ALTER TABLE trx_quotation_line
  ADD COLUMN dia            VARCHAR(40)       AFTER style_id,
  ADD COLUMN gsm            VARCHAR(30)       AFTER dia,
  ADD COLUMN yarn_type      VARCHAR(80)       AFTER gsm,
  ADD COLUMN yarn_count     VARCHAR(50)       AFTER yarn_type,
  ADD COLUMN trim_size      VARCHAR(50)       AFTER yarn_count,
  ADD COLUMN quotation_rate DECIMAL(18,4)     DEFAULT 0 AFTER unit_price,
  ADD COLUMN confirm_rate   DECIMAL(18,4)     DEFAULT 0 AFTER quotation_rate,
  ADD COLUMN igst_rate      DECIMAL(6,2)      DEFAULT 0 AFTER gst_amount,
  ADD COLUMN igst_amount    DECIMAL(18,4)     DEFAULT 0 AFTER igst_rate;

-- 3. Trims Master: Certification field
ALTER TABLE mst_trim
  ADD COLUMN certification  VARCHAR(150)      AFTER specification;
