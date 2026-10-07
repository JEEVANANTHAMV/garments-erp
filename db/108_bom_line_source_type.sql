-- db/108_bom_line_source_type.sql
-- Add source_type to trx_bom_line for Job-wise material source planning
-- (PURCHASE = Direct purchase via PO, PRODUCTION = Manufactured internally e.g. Knitting from Yarn, STOCK = Inventory allocation, TRANSFER = Store transfer)

ALTER TABLE trx_bom_line
  ADD COLUMN source_type ENUM('PURCHASE', 'PRODUCTION', 'STOCK', 'TRANSFER') NOT NULL DEFAULT 'PURCHASE' AFTER applicability;
