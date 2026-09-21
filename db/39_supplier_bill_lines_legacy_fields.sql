-- 39_supplier_bill_lines_legacy_fields.sql
-- Add legacy garment fields to trx_supplier_bill_line

ALTER TABLE trx_supplier_bill_line
  ADD COLUMN lot_no VARCHAR(50) NULL,
  ADD COLUMN no_of_bags DECIMAL(10,2) NULL,
  ADD COLUMN no_of_rolls DECIMAL(10,2) NULL,
  ADD COLUMN dia VARCHAR(30) NULL,
  ADD COLUMN gsm DECIMAL(8,2) NULL,
  ADD COLUMN color_name VARCHAR(100) NULL,
  ADD COLUMN size_name VARCHAR(50) NULL;
