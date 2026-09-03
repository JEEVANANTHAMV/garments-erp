-- =============================================================================
-- Migration 12: Quotation V2 — Domestic / Import types
-- Adds:
--   • quotation_type (DOMESTIC | IMPORT) on header
--   • supplier_id for import/purchase quotations
--   • exchange_rate for foreign currency quotations
--   • All domestic summary columns (discount, freight, packing, charges, GST)
--   • All import summary columns (courier, insurance, bank, customs, clearing,
--     landed_cost, margin_pct, final_selling_rate)
--   • Per-line: color_id, size_id (individual), job_no, uom_id, gst_rate
-- =============================================================================

-- -----------------------------------------------
-- 1. Header — quotation_type & party fields
-- -----------------------------------------------
ALTER TABLE trx_quotation
  ADD COLUMN quotation_type  ENUM('DOMESTIC','IMPORT') NOT NULL DEFAULT 'DOMESTIC'
    AFTER version,
  ADD COLUMN supplier_id     BIGINT UNSIGNED
    AFTER buyer_id,
  ADD COLUMN buyer_name_override VARCHAR(150)
    AFTER supplier_id,

  -- common
  ADD COLUMN exchange_rate   DECIMAL(12,4) DEFAULT 1,
  ADD COLUMN port_of_loading VARCHAR(100),
  ADD COLUMN port_of_discharge VARCHAR(100),
  ADD COLUMN job_no          VARCHAR(60)
    COMMENT 'Job/internal order number shown on print',

  -- ---- Domestic summary ----
  ADD COLUMN discount_pct    DECIMAL(6,2)  DEFAULT 0,
  ADD COLUMN discount_amount DECIMAL(18,4) DEFAULT 0,
  ADD COLUMN freight_charges DECIMAL(18,4) DEFAULT 0,
  ADD COLUMN packing_charges DECIMAL(18,4) DEFAULT 0,
  ADD COLUMN other_charges   DECIMAL(18,4) DEFAULT 0,
  ADD COLUMN taxable_value   DECIMAL(18,4) DEFAULT 0,
  ADD COLUMN cgst_rate       DECIMAL(6,2)  DEFAULT 0,
  ADD COLUMN cgst_amount     DECIMAL(18,4) DEFAULT 0,
  ADD COLUMN sgst_rate       DECIMAL(6,2)  DEFAULT 0,
  ADD COLUMN sgst_amount     DECIMAL(18,4) DEFAULT 0,
  ADD COLUMN igst_rate       DECIMAL(6,2)  DEFAULT 0,
  ADD COLUMN igst_amount     DECIMAL(18,4) DEFAULT 0,
  ADD COLUMN round_off       DECIMAL(10,4) DEFAULT 0,

  -- ---- Import summary ----
  ADD COLUMN courier_charges DECIMAL(18,4) DEFAULT 0,
  ADD COLUMN insurance       DECIMAL(18,4) DEFAULT 0,
  ADD COLUMN bank_charges    DECIMAL(18,4) DEFAULT 0,
  ADD COLUMN customs_duty    DECIMAL(18,4) DEFAULT 0,
  ADD COLUMN clearing_charges DECIMAL(18,4) DEFAULT 0,
  ADD COLUMN landed_cost     DECIMAL(18,4) DEFAULT 0,
  ADD COLUMN margin_pct      DECIMAL(6,2)  DEFAULT 0,
  ADD COLUMN final_selling_rate DECIMAL(18,4) DEFAULT 0,

  ADD CONSTRAINT fk_quo__supplier FOREIGN KEY (supplier_id) REFERENCES mst_party(id);

-- -----------------------------------------------
-- 2. Line items — individual size, color, job_no, GST
-- -----------------------------------------------
ALTER TABLE trx_quotation_line
  ADD COLUMN job_no      VARCHAR(60)         AFTER quotation_id,
  ADD COLUMN color_id    BIGINT UNSIGNED     AFTER style_id,
  ADD COLUMN size_id     INT UNSIGNED        AFTER color_id,
  ADD COLUMN uom_id      SMALLINT UNSIGNED   AFTER qty,
  ADD COLUMN gst_rate    DECIMAL(6,2) DEFAULT 0
    COMMENT 'Per-line GST% — used for Domestic quotations',
  ADD COLUMN gst_amount  DECIMAL(18,4) DEFAULT 0,
  ADD COLUMN sort_order  INT DEFAULT 0,

  ADD CONSTRAINT fk_quol__color   FOREIGN KEY (color_id) REFERENCES mst_color(id),
  ADD CONSTRAINT fk_quol__size    FOREIGN KEY (size_id)  REFERENCES mst_size(id);

-- -----------------------------------------------
-- 3. Sizes lookup — no group restriction needed
--    (read via lookup route, no table change required)
-- -----------------------------------------------
