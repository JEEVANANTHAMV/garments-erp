-- 98: client voice notes 03-Oct-2026 (second set).
--   * Job-work inward GRNs (knitting grey inward KIN, fabric process inward FPI, yarn process inward YPI) carry the
--     job-work rate of their DC — existing ones back-filled where the rate is 0.
--   * Yarn GRN lines carry the yarn count (as ordered on the PO).
--   * Purchase GRNs are PARTIAL (more to come) or FINAL (last delivery — PO lines still pending are closed short);
--     PO receipt status Pending / Partially received / Fully received / Short closed is derived from the lines.
-- Re-runnable.

-- yarn count on GRN lines
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_grn_line' AND COLUMN_NAME='yarn_count_str');
SET @s = IF(@x=0, 'ALTER TABLE trx_grn_line ADD COLUMN yarn_count_str VARCHAR(50) NULL COMMENT ''Yarn count as ordered (e.g. 30s Ne)'' AFTER yarn_type', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
UPDATE trx_grn_line gl
  LEFT JOIN trx_purchase_order_line pl ON pl.id = gl.po_line_id
  LEFT JOIN mst_yarn y ON y.id = gl.yarn_id
   SET gl.yarn_count_str = COALESCE(NULLIF(pl.yarn_count_str, ''), NULLIF(TRIM(CONCAT(COALESCE(y.count_value, ''), IF(y.count_value IS NULL, '', CONCAT(' ', COALESCE(y.count_type, 'Ne'))))), ''))
 WHERE gl.material_type = 'YARN' AND gl.yarn_count_str IS NULL AND gl.yarn_id IS NOT NULL;

-- receipt type on GRNs, short close on PO lines
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_grn' AND COLUMN_NAME='receipt_type');
SET @s = IF(@x=0, 'ALTER TABLE trx_grn ADD COLUMN receipt_type VARCHAR(10) NULL COMMENT ''PARTIAL / FINAL (purchase GRN against a PO)''', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_trim_grn' AND COLUMN_NAME='receipt_type');
SET @s = IF(@x=0, 'ALTER TABLE trx_trim_grn ADD COLUMN receipt_type VARCHAR(10) NULL COMMENT ''PARTIAL / FINAL''', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_purchase_order_line' AND COLUMN_NAME='short_closed');
SET @s = IF(@x=0, 'ALTER TABLE trx_purchase_order_line ADD COLUMN short_closed TINYINT(1) NOT NULL DEFAULT 0 COMMENT ''Closed short by a FINAL GRN'', ADD COLUMN short_closed_grn_id BIGINT UNSIGNED NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_trim_po_line' AND COLUMN_NAME='short_closed');
SET @s = IF(@x=0, 'ALTER TABLE trx_trim_po_line ADD COLUMN short_closed TINYINT(1) NOT NULL DEFAULT 0 COMMENT ''Closed short by a FINAL GRN'', ADD COLUMN short_closed_grn_id BIGINT UNSIGNED NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- job-work inward GRNs: the DC's job-work rate where the GRN has none
UPDATE trx_grn_line gl
  JOIN trx_process_receipt pr ON pr.grn_id = gl.grn_id AND pr.src_type = 'KNITTING_PROGRAM'
  LEFT JOIN trx_knitting_dc_job j ON j.company_id = pr.company_id AND j.dc_no = pr.ref_dc_no AND j.program_id = pr.src_id
  LEFT JOIN trx_knitting_dc kd ON kd.company_id = pr.company_id AND kd.dc_no = pr.ref_dc_no
   SET gl.rate = COALESCE(j.rate_per_kg, kd.rate_per_kg, 0),
       gl.taxable_amount = ROUND(gl.accepted_qty * COALESCE(j.rate_per_kg, kd.rate_per_kg, 0), 4),
       gl.total_amount = ROUND(gl.accepted_qty * COALESCE(j.rate_per_kg, kd.rate_per_kg, 0), 4)
 WHERE COALESCE(gl.rate, 0) = 0 AND COALESCE(j.rate_per_kg, kd.rate_per_kg, 0) > 0;
UPDATE trx_grn_line gl
  JOIN trx_fabric_process_inward i ON i.grn_id = gl.grn_id
  JOIN trx_fabric_process_order o ON o.id = i.fpo_id
   SET gl.rate = o.rate_per_kg, gl.taxable_amount = ROUND(gl.accepted_qty * o.rate_per_kg, 4), gl.total_amount = ROUND(gl.accepted_qty * o.rate_per_kg, 4)
 WHERE COALESCE(gl.rate, 0) = 0 AND COALESCE(o.rate_per_kg, 0) > 0;
UPDATE trx_grn_line gl
  JOIN trx_yarn_process_inward i ON i.grn_id = gl.grn_id
  JOIN trx_yarn_process_order o ON o.id = i.ypo_id
   SET gl.rate = o.rate_per_kg, gl.taxable_amount = ROUND(gl.accepted_qty * o.rate_per_kg, 4), gl.total_amount = ROUND(gl.accepted_qty * o.rate_per_kg, 4)
 WHERE COALESCE(gl.rate, 0) = 0 AND COALESCE(o.rate_per_kg, 0) > 0;
-- their header totals
UPDATE trx_grn g JOIN (SELECT gl.grn_id, SUM(gl.taxable_amount) t FROM trx_grn_line gl GROUP BY gl.grn_id) x ON x.grn_id = g.id
   SET g.taxable_amount = x.t, g.net_amount = x.t, g.grand_total = x.t
 WHERE COALESCE(g.taxable_amount, 0) = 0 AND x.t > 0 AND g.po_id IS NULL
   AND (EXISTS (SELECT 1 FROM trx_process_receipt pr WHERE pr.grn_id = g.id) OR EXISTS (SELECT 1 FROM trx_fabric_process_inward i WHERE i.grn_id = g.id)
        OR EXISTS (SELECT 1 FROM trx_yarn_process_inward i WHERE i.grn_id = g.id));
