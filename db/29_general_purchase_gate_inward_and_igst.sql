-- 29_general_purchase_gate_inward_and_igst.sql
-- Add gate_inward_id, is_interstate, cgst_amount, sgst_amount, igst_amount to trx_general_purchase

ALTER TABLE trx_general_purchase
  ADD COLUMN gate_inward_id bigint unsigned NULL AFTER reference_po_id,
  ADD COLUMN is_interstate tinyint(1) NOT NULL DEFAULT 0 AFTER gate_inward_id,
  ADD COLUMN cgst_amount decimal(18,4) NULL DEFAULT 0.0000 AFTER tax_amount,
  ADD COLUMN sgst_amount decimal(18,4) NULL DEFAULT 0.0000 AFTER cgst_amount,
  ADD COLUMN igst_amount decimal(18,4) NULL DEFAULT 0.0000 AFTER sgst_amount;
