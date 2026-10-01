-- =====================================================================
-- 87: Job-wise yarn / fabric / trim stock, multi-job yarn DCs, traceability
--   (client voice notes 01-Oct-2026)
--   • trx_process_issue lines carry their job and the exact yarn GRN lot (grn_line_id),
--     so one knitting / yarn-process DC can serve several jobs and every issued KG
--     traces back to its PO / GRN / supplier invoice.
--   • trx_job_transfer: job → job (or general → job) transfer of yarn lots, fabric rolls
--     and trim stock.
--   • trx_trim_stock rows carry the job they belong to.
--   Idempotent (migrations >= 10 re-run every deploy).
-- =====================================================================

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_process_issue' AND COLUMN_NAME='grn_line_id');
SET @s = IF(@x=0, 'ALTER TABLE trx_process_issue ADD COLUMN grn_line_id BIGINT UNSIGNED NULL COMMENT ''Yarn GRN lot issued'', ADD COLUMN so_id BIGINT UNSIGNED NULL COMMENT ''Job of the DC line'', ADD COLUMN io_no VARCHAR(60) NULL, ADD KEY ix_pi_grnline (grn_line_id), ADD KEY ix_pi_dc (company_id, dc_no)', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- backfill job of existing DC lines from their program / yarn process
UPDATE trx_process_issue pi JOIN trx_knitting_program kp ON kp.id = pi.src_id
   SET pi.so_id = kp.so_id, pi.io_no = kp.io_no
 WHERE pi.src_type = 'KNITTING_PROGRAM' AND pi.so_id IS NULL AND kp.so_id IS NOT NULL;
UPDATE trx_process_issue pi JOIN trx_yarn_process yp ON yp.id = pi.src_id
   SET pi.so_id = yp.so_id, pi.io_no = yp.io_no
 WHERE pi.src_type = 'YARN_PROCESS' AND pi.so_id IS NULL AND yp.so_id IS NOT NULL;

-- yarn GRN lines: stamp the job from the PO line / PO where the GRN left it empty
UPDATE trx_grn_line gl JOIN trx_purchase_order_line pol ON pol.id = gl.po_line_id
   SET gl.so_id = pol.so_id
 WHERE gl.material_type = 'YARN' AND gl.so_id IS NULL AND pol.so_id IS NOT NULL;

-- ---------- Job → job stock transfer ----------
CREATE TABLE IF NOT EXISTS trx_job_transfer (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  transfer_no     VARCHAR(50) NOT NULL,
  transfer_date   DATE NOT NULL,
  material_type   VARCHAR(10) NOT NULL COMMENT 'YARN / FABRIC / TRIM',
  from_so_id      BIGINT UNSIGNED NULL COMMENT 'NULL = general stock',
  to_so_id        BIGINT UNSIGNED NULL COMMENT 'NULL = back to general stock',
  to_style_id     BIGINT UNSIGNED NULL,
  reason          VARCHAR(255) NOT NULL,
  total_qty       DECIMAL(18,4) NOT NULL DEFAULT 0,
  status          VARCHAR(20) NOT NULL DEFAULT 'POSTED',
  created_by      BIGINT UNSIGNED NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_jt_no (company_id, transfer_no)
) ENGINE=InnoDB COMMENT='Job to job / general to job stock transfer';

CREATE TABLE IF NOT EXISTS trx_job_transfer_line (
  id               BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  transfer_id      BIGINT UNSIGNED NOT NULL,
  grn_line_id      BIGINT UNSIGNED NULL COMMENT 'Yarn lot',
  fabric_roll_id   BIGINT UNSIGNED NULL COMMENT 'Fabric roll moved / split from',
  new_roll_id      BIGINT UNSIGNED NULL COMMENT 'Fabric roll created for the part moved',
  trim_stock_id    BIGINT UNSIGNED NULL,
  to_trim_stock_id BIGINT UNSIGNED NULL,
  item_label       VARCHAR(200) NULL,
  lot_no           VARCHAR(80) NULL,
  qty              DECIMAL(18,4) NOT NULL,
  uom_id           SMALLINT UNSIGNED NULL,
  KEY ix_jtl_t (transfer_id),
  KEY ix_jtl_grn (grn_line_id)
) ENGINE=InnoDB;

INSERT INTO cfg_number_series (company_id, branch_id, doc_type, fy_id, prefix, next_number, padding)
SELECT c.id, NULL, 'JOB_TRANSFER', NULL, 'JTR-', 1, 5 FROM mst_company c
WHERE NOT EXISTS (SELECT 1 FROM cfg_number_series s WHERE s.company_id = c.id AND s.doc_type = 'JOB_TRANSFER' AND s.branch_id IS NULL AND s.fy_id IS NULL);

-- ---------- Trim stock per job ----------
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_trim_stock' AND COLUMN_NAME='so_id');
SET @s = IF(@x=0, 'ALTER TABLE trx_trim_stock ADD COLUMN so_id BIGINT UNSIGNED NULL COMMENT ''Job the stock belongs to (NULL = general)'', ADD COLUMN style_id BIGINT UNSIGNED NULL, ADD COLUMN so_key BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT ''so_id or 0 — part of the unique key''', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- unique key now includes the job (a lot can be split between jobs)
SET @x = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_trim_stock' AND INDEX_NAME='uq_trim_stock' AND COLUMN_NAME='so_key');
SET @s = IF(@x=0, 'ALTER TABLE trx_trim_stock DROP INDEX uq_trim_stock, ADD UNIQUE KEY uq_trim_stock (company_id, warehouse_id, trim_id, internal_lot_no, so_key)', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- backfill the job of existing trim stock from the trim GRN line of its lot
UPDATE trx_trim_stock ts
  JOIN (SELECT gl.trim_id, gl.internal_lot_no, MAX(COALESCE(gl.so_id, so.id)) so_id, MAX(COALESCE(gl.style_id, g.style_id)) style_id
          FROM trx_trim_grn_line gl JOIN trx_trim_grn g ON g.id = gl.grn_id
          LEFT JOIN trx_sales_order so ON so.company_id = g.company_id AND (so.io_no = g.io_no OR so.so_no = g.io_no)
         GROUP BY gl.trim_id, gl.internal_lot_no) x ON x.trim_id = ts.trim_id AND x.internal_lot_no = ts.internal_lot_no
   SET ts.so_id = x.so_id, ts.style_id = x.style_id, ts.so_key = COALESCE(x.so_id, 0)
 WHERE ts.so_id IS NULL AND x.so_id IS NOT NULL;
