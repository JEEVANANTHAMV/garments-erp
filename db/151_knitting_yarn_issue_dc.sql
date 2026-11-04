-- =====================================================================
-- 151 · Knitting Yarn Issue DC (C-ONE ERP developer specification, 04-Nov-2026)
--   The existing knitting DC (trx_knitting_dc header + trx_knitting_dc_job per job + yarn lines in
--   trx_process_issue) already carries many jobs on one DC. This adds what the specification asks for
--   on top of it, without a parallel DC:
--     * trx_knitting_dc: document status DRAFT / APPROVED / CANCELLED (separate from the receipt status
--       OPEN / PARTIALLY_RECEIVED / CLOSED), purpose, vehicle, contractor name / address / GSTIN snapshot,
--       from store, approve / cancel / edit stamps, reprint count.
--     * trx_knitting_dc_line: the DC lines with their job no, yarn and fabric description snapshots, lot
--       no, cones and net weight (DECIMAL(18,3)) — the draft lines before approval, and after approval
--       linked to the stock-moving trx_process_issue row.
--     * trx_knitting_dc_audit: every save / approve / approved edit / cancel / print with old + new JSON.
--     * trx_knitting_dc_eway + trx_knitting_dc_eway_audit: e-way bill captured on the DC (manual entry
--       of an EWB generated on the GST portal; QR only from a verified payload), with its own audit.
--     * permissions KNIT_DC.APPROVE / KNIT_DC.EDIT_DESC / KNIT_DC.EDIT_APPROVED / KNIT_DC.CANCEL.
--   Existing DCs (they were issued on save) become APPROVED, and their lines + snapshots are backfilled.
--   Idempotent and non-destructive: the runner re-applies files >= 10 on every deploy.
-- =====================================================================

-- ---------- trx_knitting_dc: document fields ----------
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_knitting_dc' AND COLUMN_NAME='doc_status');
SET @s = IF(@x=0, 'ALTER TABLE trx_knitting_dc
  ADD COLUMN doc_status VARCHAR(20) NOT NULL DEFAULT ''APPROVED'' COMMENT ''DRAFT / APPROVED / CANCELLED (stock moves on approval)'' AFTER status,
  ADD COLUMN purpose VARCHAR(150) NULL AFTER doc_status,
  ADD COLUMN vehicle_no VARCHAR(30) NULL AFTER purpose,
  ADD COLUMN warehouse_id BIGINT UNSIGNED NULL COMMENT ''Store the yarn goes out from'' AFTER vehicle_no,
  ADD COLUMN contractor_name_snapshot VARCHAR(200) NULL AFTER warehouse_id,
  ADD COLUMN contractor_address_snapshot VARCHAR(600) NULL AFTER contractor_name_snapshot,
  ADD COLUMN contractor_gstin_snapshot VARCHAR(20) NULL AFTER contractor_address_snapshot,
  ADD COLUMN remarks TEXT NULL,
  ADD COLUMN allow_override TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN override_reason VARCHAR(255) NULL,
  ADD COLUMN created_by BIGINT UNSIGNED NULL,
  ADD COLUMN updated_by BIGINT UNSIGNED NULL,
  ADD COLUMN updated_at DATETIME NULL,
  ADD COLUMN approved_by BIGINT UNSIGNED NULL,
  ADD COLUMN approved_at DATETIME NULL,
  ADD COLUMN cancelled_by BIGINT UNSIGNED NULL,
  ADD COLUMN cancelled_at DATETIME NULL,
  ADD COLUMN cancel_reason VARCHAR(255) NULL,
  ADD COLUMN print_count INT UNSIGNED NOT NULL DEFAULT 0,
  ADD COLUMN last_printed_at DATETIME NULL,
  ADD COLUMN last_printed_by BIGINT UNSIGNED NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @x = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_knitting_dc' AND INDEX_NAME='ix_kdc_doc');
SET @s = IF(@x=0, 'ALTER TABLE trx_knitting_dc ADD KEY ix_kdc_doc (company_id, doc_status, dc_date)', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- headers for issued DCs that never got one (older data)
INSERT IGNORE INTO trx_knitting_dc (company_id, dc_no, dc_date, vendor_id, status)
SELECT i.company_id, i.dc_no, MIN(i.issue_date), MAX(i.vendor_id), 'OPEN'
  FROM trx_process_issue i WHERE i.src_type = 'KNITTING_PROGRAM' AND i.dc_no IS NOT NULL GROUP BY i.company_id, i.dc_no;

-- backfill header snapshots of issued DCs (only where still empty: never overwrites a saved snapshot)
UPDATE trx_knitting_dc kd
  JOIN (SELECT company_id, dc_no, MAX(vehicle_no) vehicle_no, MAX(warehouse_id) warehouse_id, MAX(vendor_id) vendor_id,
               MIN(created_by) created_by, MIN(created_at) created_at, MAX(remarks) remarks
          FROM trx_process_issue WHERE src_type = 'KNITTING_PROGRAM' AND dc_no IS NOT NULL GROUP BY company_id, dc_no) i
    ON i.company_id = kd.company_id AND i.dc_no = kd.dc_no
   SET kd.vehicle_no   = COALESCE(kd.vehicle_no, i.vehicle_no),
       kd.warehouse_id = COALESCE(kd.warehouse_id, i.warehouse_id),
       kd.vendor_id    = COALESCE(kd.vendor_id, i.vendor_id),
       kd.created_by   = COALESCE(kd.created_by, i.created_by),
       kd.approved_by  = COALESCE(kd.approved_by, i.created_by),
       kd.approved_at  = COALESCE(kd.approved_at, i.created_at),
       kd.remarks      = COALESCE(kd.remarks, i.remarks),
       kd.purpose      = COALESCE(kd.purpose, 'Yarn Issue for Knitting')
 WHERE kd.doc_status = 'APPROVED';

UPDATE trx_knitting_dc kd
  JOIN mst_party p ON p.id = kd.vendor_id
   SET kd.contractor_name_snapshot = COALESCE(kd.contractor_name_snapshot, p.party_name),
       kd.contractor_gstin_snapshot = COALESCE(kd.contractor_gstin_snapshot, p.gstin),
       kd.contractor_address_snapshot = COALESCE(kd.contractor_address_snapshot,
         (SELECT NULLIF(CONCAT_WS(', ', NULLIF(pa.address_line1, ''), NULLIF(pa.address_line2, ''), NULLIF(pa.address_line3, ''), NULLIF(pa.city, ''),
                                  NULLIF(pa.state, ''), NULLIF(pa.pincode, '')), '')
            FROM mst_party_address pa WHERE pa.party_id = p.id AND pa.is_active = 1 ORDER BY pa.is_default DESC, pa.id LIMIT 1))
 WHERE kd.doc_status = 'APPROVED' AND (kd.contractor_name_snapshot IS NULL OR kd.contractor_address_snapshot IS NULL);


-- ---------- DC lines (draft lines; after approval linked to the stock issue) ----------
CREATE TABLE IF NOT EXISTS trx_knitting_dc_line (
  id                          BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id                  BIGINT UNSIGNED NOT NULL,
  dc_id                       BIGINT UNSIGNED NOT NULL,
  dc_no                       VARCHAR(60) NOT NULL,
  line_no                     INT UNSIGNED NOT NULL,
  program_id                  BIGINT UNSIGNED NOT NULL COMMENT 'Knitting program = the job line (IO) the yarn is for',
  program_yarn_id             BIGINT UNSIGNED NULL,
  so_id                       BIGINT UNSIGNED NULL,
  job_no_snapshot             VARCHAR(80) NULL COMMENT 'IO / job no as printed',
  yarn_id                     BIGINT UNSIGNED NOT NULL,
  grn_line_id                 BIGINT UNSIGNED NULL COMMENT 'Yarn GRN lot the KG comes from',
  lot_no                      VARCHAR(80) NULL COMMENT 'From the lot (GRN) data only — never generated',
  yarn_description_snapshot   VARCHAR(500) NULL,
  fabric_description_snapshot VARCHAR(500) NULL,
  cones                       INT UNSIGNED NOT NULL DEFAULT 0,
  net_weight_kg               DECIMAL(18,3) NOT NULL DEFAULT 0,
  remarks                     VARCHAR(255) NULL,
  process_issue_id            BIGINT UNSIGNED NULL COMMENT 'Stock issue made on approval',
  created_at                  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                  DATETIME NULL,
  KEY ix_kdcl_dc (dc_id, line_no),
  KEY ix_kdcl_no (company_id, dc_no),
  KEY ix_kdcl_prog (program_id),
  KEY ix_kdcl_issue (process_issue_id)
) ENGINE=InnoDB COMMENT='Knitting yarn issue DC lines with description snapshots (job, yarn, fabric, lot, cones, net KG)';

-- backfill the lines of issued DCs from their stock issues (once per issue)
INSERT INTO trx_knitting_dc_line
  (company_id, dc_id, dc_no, line_no, program_id, program_yarn_id, so_id, job_no_snapshot, yarn_id, grn_line_id, lot_no,
   yarn_description_snapshot, fabric_description_snapshot, cones, net_weight_kg, process_issue_id, created_at)
SELECT i.company_id, kd.id, i.dc_no,
       (SELECT COUNT(*) FROM trx_process_issue i2 WHERE i2.company_id = i.company_id AND i2.dc_no = i.dc_no AND i2.src_type = 'KNITTING_PROGRAM' AND i2.id <= i.id),
       i.src_id, i.src_line_id, COALESCE(i.so_id, kp.so_id), COALESCE(NULLIF(i.io_no, ''), NULLIF(kp.io_no, ''), kp.program_no), i.yarn_id, i.grn_line_id,
       COALESCE(NULLIF(i.lot_no, ''), (SELECT NULLIF(gl.lot_no, '') FROM trx_grn_line gl WHERE gl.id = i.grn_line_id)),
       CONCAT(COALESCE(y.yarn_name, y.yarn_code, 'Yarn'), IF(kpy.colour IS NOT NULL AND kpy.colour <> '', CONCAT(' (', kpy.colour, ')'), '')),
       CONCAT_WS(' / ',
         CONCAT(COALESCE(NULLIF(kp.fabric_type, ''), f.fabric_name, 'Fabric'), IF(kp.gsm IS NOT NULL AND kp.gsm <> '', CONCAT(' – ', kp.gsm, ' GSM'), '')),
         IF(kp.dia IS NOT NULL AND kp.dia <> '', CONCAT(kp.dia, '" Dia'), NULL),
         IF(kp.gauge IS NOT NULL AND kp.gauge <> '', CONCAT(kp.gauge, ' G'), NULL)),
       i.no_of_cones, i.issued_qty_kg, i.id, i.created_at
  FROM trx_process_issue i
  JOIN trx_knitting_dc kd ON kd.company_id = i.company_id AND kd.dc_no = i.dc_no
  JOIN trx_knitting_program kp ON kp.id = i.src_id
  LEFT JOIN mst_yarn y ON y.id = i.yarn_id
  LEFT JOIN trx_knitting_program_yarns kpy ON kpy.id = i.src_line_id
  LEFT JOIN mst_fabric f ON f.id = kp.fabric_id
 WHERE i.src_type = 'KNITTING_PROGRAM' AND i.dc_no IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM trx_knitting_dc_line l WHERE l.process_issue_id = i.id);


-- ---------- audit: old / new JSON for every change ----------
CREATE TABLE IF NOT EXISTS trx_knitting_dc_audit (
  id               BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id       BIGINT UNSIGNED NOT NULL,
  dc_id            BIGINT UNSIGNED NOT NULL,
  dc_no            VARCHAR(60) NOT NULL,
  action           VARCHAR(30) NOT NULL COMMENT 'CREATE / UPDATE / APPROVE / EDIT_APPROVED / CANCEL / PRINT / REPRINT',
  old_values_json  JSON NULL,
  new_values_json  JSON NULL,
  user_id          BIGINT UNSIGNED NULL,
  action_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  remarks          VARCHAR(500) NULL,
  KEY ix_kdca_dc (dc_id, id)
) ENGINE=InnoDB COMMENT='Knitting yarn issue DC audit trail';


-- ---------- e-way bill captured on the DC ----------
CREATE TABLE IF NOT EXISTS trx_knitting_dc_eway (
  id                   BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id           BIGINT UNSIGNED NOT NULL,
  dc_id                BIGINT UNSIGNED NOT NULL,
  is_required          TINYINT(1) NOT NULL DEFAULT 0,
  eway_bill_no         VARCHAR(20) NULL,
  eway_bill_datetime   DATETIME NULL COMMENT 'UTC instant; shown in eway_tz',
  valid_until          DATETIME NULL COMMENT 'UTC instant; shown in eway_tz',
  eway_tz              VARCHAR(40) NOT NULL DEFAULT 'Asia/Kolkata' COMMENT 'Time zone the EWB date / validity were entered in',
  approx_distance_km   DECIMAL(10,2) NULL,
  transport_mode       VARCHAR(10) NULL COMMENT 'Road / Rail / Air / Ship / Other',
  transporter_party_id BIGINT UNSIGNED NULL,
  transporter_gstin    VARCHAR(15) NULL COMMENT 'Transporter GSTIN / TRANSIN',
  transporter_name     VARCHAR(150) NULL,
  same_as_dc_vehicle   TINYINT(1) NOT NULL DEFAULT 1,
  eway_vehicle_no      VARCHAR(30) NULL,
  reference_url        VARCHAR(500) NULL,
  attachment_key       VARCHAR(200) NULL,
  attachment_name      VARCHAR(200) NULL,
  attachment_mime      VARCHAR(100) NULL,
  attachment_size      INT UNSIGNED NULL,
  attachment_sha256    CHAR(64) NULL,
  remarks              VARCHAR(500) NULL,
  source_type          VARCHAR(20) NOT NULL DEFAULT 'MANUAL' COMMENT 'MANUAL (portal) / EWB_MODULE (generated through the e-way bill module)',
  linked_ewb_id        BIGINT UNSIGNED NULL COMMENT 'trx_eway_bill row with the same EWB no, when one exists',
  qr_payload           VARCHAR(1000) NULL COMMENT 'QR content from a verified official source only — never built here',
  qr_source            VARCHAR(60) NULL,
  status               VARCHAR(20) NOT NULL DEFAULT 'NOT_REQUIRED' COMMENT 'NOT_REQUIRED / PENDING / ENTERED / CANCELLED',
  created_by           BIGINT UNSIGNED NULL,
  created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by           BIGINT UNSIGNED NULL,
  updated_at           DATETIME NULL,
  UNIQUE KEY uq_kdce_dc (dc_id),
  KEY ix_kdce_no (company_id, eway_bill_no)
) ENGINE=InnoDB COMMENT='E-way bill details captured on a knitting yarn issue DC';

CREATE TABLE IF NOT EXISTS trx_knitting_dc_eway_audit (
  id               BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id       BIGINT UNSIGNED NOT NULL,
  eway_bill_id     BIGINT UNSIGNED NOT NULL,
  dc_id            BIGINT UNSIGNED NOT NULL,
  action           VARCHAR(30) NOT NULL COMMENT 'SAVE / UPDATE_AFTER_APPROVAL / ATTACH / REMOVE_ATTACHMENT',
  old_values_json  JSON NULL,
  new_values_json  JSON NULL,
  change_reason    VARCHAR(500) NULL,
  user_id          BIGINT UNSIGNED NULL,
  action_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_kdcea (eway_bill_id, id)
) ENGINE=InnoDB COMMENT='Knitting DC e-way bill audit trail';


-- ---------- permissions (module PRODUCTION) ----------
INSERT INTO mst_permission (module_id, permission_code, permission_name)
SELECT m.id, t.code, t.name FROM mst_module m
  JOIN (SELECT 'KNIT_DC.APPROVE' code, 'Knitting yarn issue DC: approve / issue (moves stock)' name UNION ALL
        SELECT 'KNIT_DC.EDIT_DESC', 'Knitting yarn issue DC: edit yarn / fabric description on the DC' UNION ALL
        SELECT 'KNIT_DC.EDIT_APPROVED', 'Knitting yarn issue DC: edit an approved DC (vehicle, purpose, descriptions, e-way bill) with reason' UNION ALL
        SELECT 'KNIT_DC.CANCEL', 'Knitting yarn issue DC: cancel (approved DC stock is reversed)') t
 WHERE m.module_code = 'PRODUCTION' AND NOT EXISTS (SELECT 1 FROM mst_permission x WHERE x.permission_code = t.code);
-- whoever issues yarn approves and may correct descriptions
INSERT INTO map_role_permission (role_id, permission_id)
SELECT DISTINCT mrp.role_id, p.id FROM map_role_permission mrp
  JOIN mst_permission src ON src.id = mrp.permission_id AND src.permission_code = 'PROCESS.ISSUE'
  JOIN mst_permission p ON p.permission_code IN ('KNIT_DC.APPROVE', 'KNIT_DC.EDIT_DESC')
 WHERE NOT EXISTS (SELECT 1 FROM map_role_permission m WHERE m.role_id = mrp.role_id AND m.permission_id = p.id);
-- editing / cancelling an approved DC: administrators and whoever may authorise an over-issue
INSERT INTO map_role_permission (role_id, permission_id)
SELECT DISTINCT r.id, p.id FROM mst_role r JOIN mst_permission p ON p.permission_code IN ('KNIT_DC.APPROVE', 'KNIT_DC.EDIT_DESC', 'KNIT_DC.EDIT_APPROVED', 'KNIT_DC.CANCEL')
 WHERE r.role_code IN ('SUPER_ADMIN', 'ADMIN')
   AND NOT EXISTS (SELECT 1 FROM map_role_permission m WHERE m.role_id = r.id AND m.permission_id = p.id);
INSERT INTO map_role_permission (role_id, permission_id)
SELECT DISTINCT mrp.role_id, p.id FROM map_role_permission mrp
  JOIN mst_permission src ON src.id = mrp.permission_id AND src.permission_code = 'PROCESS.OVERRIDE_ISSUE'
  JOIN mst_permission p ON p.permission_code IN ('KNIT_DC.EDIT_APPROVED', 'KNIT_DC.CANCEL')
 WHERE NOT EXISTS (SELECT 1 FROM map_role_permission m WHERE m.role_id = mrp.role_id AND m.permission_id = p.id);
