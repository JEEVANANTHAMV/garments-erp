-- 40_supplier_bill_import_and_igst.sql
-- Adds GST type (Intra-state, Inter-state, Import), exchange rate, BOE details, and expands bill_type ENUM.

ALTER TABLE trx_supplier_bill
  MODIFY COLUMN bill_type ENUM(
    'YARN_PURCHASE',
    'YARN_PROCESS',
    'FABRIC_PURCHASE',
    'FABRIC_PROCESS',
    'TRIMS_PURCHASE',
    'TRIMS_PROCESS',
    'IMPORT_PURCHASE',
    'IMPORT_PROCESS',
    'GENERAL'
  ) NOT NULL DEFAULT 'GENERAL';

ALTER TABLE trx_supplier_bill
  ADD COLUMN gst_type ENUM('INTRA_STATE', 'INTER_STATE', 'IMPORT') NOT NULL DEFAULT 'INTRA_STATE' AFTER currency_id,
  ADD COLUMN exchange_rate DECIMAL(12,4) NOT NULL DEFAULT 1.0000 AFTER gst_type,
  ADD COLUMN base_currency_total DECIMAL(18,4) NOT NULL DEFAULT 0.0000 AFTER total_amount,
  ADD COLUMN boe_no VARCHAR(60) NULL AFTER base_currency_total,
  ADD COLUMN boe_date DATE NULL AFTER boe_no,
  ADD COLUMN port_code VARCHAR(30) NULL AFTER boe_date;
