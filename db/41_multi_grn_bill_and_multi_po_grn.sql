-- 41_multi_grn_bill_and_multi_po_grn.sql
-- Enables Multi-GRN linking on Supplier Bills (Bills Inward) and Multi-PO linking on Goods Receipt Notes (GRN).

-- 1. Multi-GRN support on Supplier Bills
ALTER TABLE trx_supplier_bill
  ADD COLUMN grn_ids JSON NULL AFTER grn_id;

ALTER TABLE trx_supplier_bill_line
  ADD COLUMN grn_id BIGINT UNSIGNED NULL AFTER po_line_id;

-- 2. Multi-PO support on Fabric, Yarn, and General GRNs
ALTER TABLE trx_grn
  ADD COLUMN po_ids JSON NULL AFTER po_id;

ALTER TABLE trx_grn_line
  ADD COLUMN po_id BIGINT UNSIGNED NULL AFTER po_line_id;

-- 3. Multi-PO support on Trims GRNs
ALTER TABLE trx_trim_grn
  ADD COLUMN po_ids JSON NULL AFTER po_id;

ALTER TABLE trx_trim_grn_line
  ADD COLUMN po_id BIGINT UNSIGNED NULL AFTER po_line_id;
