-- =====================================================================
-- 55. CUTTING CORE — cut order controls, fabric DC returns, marker
--     version change detection, lay reversal, reconciliation reopen
-- ---------------------------------------------------------------------
-- Builds on 52_cutting_traceability.sql (do not edit that file).
-- Every statement is idempotent: the migrate runner re-applies files on
-- each deploy and skips the rest of a file on "already exists".
-- =====================================================================

-- ─────────────────────────────────────────────────────────────────
-- 1. Cut order (trx_cutting_plan): authorised over-cut audit (doc §5)
-- ─────────────────────────────────────────────────────────────────
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_cutting_plan' AND COLUMN_NAME='over_cut_reason');
SET @s = IF(@x=0, 'ALTER TABLE trx_cutting_plan ADD COLUMN over_cut_reason VARCHAR(255) NULL COMMENT \'Why cut qty may exceed order qty × (1+over_cut_pct)\' AFTER over_cut_pct', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_cutting_plan' AND COLUMN_NAME='over_cut_approved_by');
SET @s = IF(@x=0, 'ALTER TABLE trx_cutting_plan ADD COLUMN over_cut_approved_by BIGINT UNSIGNED NULL AFTER over_cut_reason', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_cutting_plan' AND COLUMN_NAME='status_reason');
SET @s = IF(@x=0, 'ALTER TABLE trx_cutting_plan ADD COLUMN status_reason VARCHAR(255) NULL COMMENT \'Reason for the last manual status change (cancel / reopen)\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- ─────────────────────────────────────────────────────────────────
-- 2. Fabric DC returns (doc §6, §19) — a return is its own document,
--    never an edit of the posted issue line.
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS trx_fabric_return (
  id                   BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id           BIGINT UNSIGNED NOT NULL,
  return_no            VARCHAR(40) NOT NULL,
  return_date          DATE NOT NULL,
  fabric_issue_id      BIGINT UNSIGNED NOT NULL,
  fabric_issue_roll_id BIGINT UNSIGNED NOT NULL,
  fabric_roll_id       BIGINT UNSIGNED NULL,
  cutting_plan_id      BIGINT UNSIGNED NULL,
  return_kg            DECIMAL(12,4) NOT NULL,
  return_mtr           DECIMAL(12,4) NULL,
  to_location          VARCHAR(80) NULL,
  reason               VARCHAR(255) NULL,
  created_by           BIGINT UNSIGNED NULL,
  created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_frt_no (company_id, return_no),
  KEY ix_frt_issue (fabric_issue_id),
  KEY ix_frt_dcroll (fabric_issue_roll_id),
  KEY ix_frt_plan (cutting_plan_id),
  CONSTRAINT chk_frt_kg CHECK (return_kg > 0)
) ENGINE=InnoDB COMMENT='Fabric returned from cutting back to store (doc §6)';

SET @x = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_fabric_issue' AND INDEX_NAME='ix_fi_plan');
SET @s = IF(@x=0, 'ALTER TABLE trx_fabric_issue ADD KEY ix_fi_plan (cutting_plan_id)', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- ─────────────────────────────────────────────────────────────────
-- 3. Marker versions: content hash so a snapshot only creates a new
--    version when the CAD marker actually changed (doc §7).
-- ─────────────────────────────────────────────────────────────────
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_marker_version' AND COLUMN_NAME='content_hash');
SET @s = IF(@x=0, 'ALTER TABLE trx_marker_version ADD COLUMN content_hash CHAR(64) NULL AFTER uom', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_marker_version' AND COLUMN_NAME='source');
SET @s = IF(@x=0, 'ALTER TABLE trx_marker_version ADD COLUMN source ENUM(\'CAD\',\'MANUAL\') NOT NULL DEFAULT \'CAD\' AFTER content_hash', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_marker_version' AND COLUMN_NAME='locked_at');
SET @s = IF(@x=0, 'ALTER TABLE trx_marker_version ADD COLUMN locked_at DATETIME NULL AFTER is_locked', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_marker_version' AND INDEX_NAME='ix_mv_marker');
SET @s = IF(@x=0, 'ALTER TABLE trx_marker_version ADD KEY ix_mv_marker (company_id, marker_no)', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- ─────────────────────────────────────────────────────────────────
-- 4. Lay: over-cut override + reversal audit (doc §9, §19, §20)
-- ─────────────────────────────────────────────────────────────────
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_lay_plan' AND COLUMN_NAME='override_reason');
SET @s = IF(@x=0, 'ALTER TABLE trx_lay_plan ADD COLUMN override_reason VARCHAR(255) NULL COMMENT \'Authorised reason when good pcs exceed expected / order allowance\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_lay_plan' AND COLUMN_NAME='override_by');
SET @s = IF(@x=0, 'ALTER TABLE trx_lay_plan ADD COLUMN override_by BIGINT UNSIGNED NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_lay_plan' AND COLUMN_NAME='cancelled_by');
SET @s = IF(@x=0, 'ALTER TABLE trx_lay_plan ADD COLUMN cancelled_by BIGINT UNSIGNED NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_lay_plan' AND COLUMN_NAME='cancelled_at');
SET @s = IF(@x=0, 'ALTER TABLE trx_lay_plan ADD COLUMN cancelled_at DATETIME NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_lay_plan' AND INDEX_NAME='ix_lp_plan');
SET @s = IF(@x=0, 'ALTER TABLE trx_lay_plan ADD KEY ix_lp_plan (cutting_plan_id)', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- Output rows remember which consumption basis produced their actual KG.
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_cut_output' AND COLUMN_NAME='kg_basis');
SET @s = IF(@x=0, 'ALTER TABLE trx_cut_output ADD COLUMN kg_basis VARCHAR(40) NULL COMMENT \'PCS or MARKER_SIZE weighting used to split lay KG\' AFTER kg_per_pc', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- ─────────────────────────────────────────────────────────────────
-- 5. Reconciliation: approved snapshot + reopen audit (doc §16)
-- ─────────────────────────────────────────────────────────────────
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_cutting_reconciliation' AND COLUMN_NAME='approved_unaccounted_kg');
SET @s = IF(@x=0, 'ALTER TABLE trx_cutting_reconciliation ADD COLUMN approved_unaccounted_kg DECIMAL(12,4) NULL COMMENT \'Unaccounted KG the variance approval was given for\' AFTER approved_at', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_cutting_reconciliation' AND COLUMN_NAME='reopen_reason');
SET @s = IF(@x=0, 'ALTER TABLE trx_cutting_reconciliation ADD COLUMN reopen_reason VARCHAR(500) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_cutting_reconciliation' AND COLUMN_NAME='reopened_by');
SET @s = IF(@x=0, 'ALTER TABLE trx_cutting_reconciliation ADD COLUMN reopened_by BIGINT UNSIGNED NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_cutting_reconciliation' AND COLUMN_NAME='reopened_at');
SET @s = IF(@x=0, 'ALTER TABLE trx_cutting_reconciliation ADD COLUMN reopened_at DATETIME NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_cutting_reconciliation' AND COLUMN_NAME='remarks');
SET @s = IF(@x=0, 'ALTER TABLE trx_cutting_reconciliation ADD COLUMN remarks VARCHAR(500) NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- ─────────────────────────────────────────────────────────────────
-- 6. Number series for the cutting documents. Bundle numbers are one
--    company-wide series so a bundle no / barcode is never reused.
--    (cfg_number_series.branch_id is NULL so its UNIQUE key cannot
--    de-duplicate — guard with NOT EXISTS instead.)
-- ─────────────────────────────────────────────────────────────────
INSERT INTO cfg_number_series (company_id, branch_id, doc_type, fy_id, prefix, next_number, padding)
SELECT c.id, NULL, t.doc_type, NULL, t.prefix, 1, t.padding
  FROM mst_company c
  JOIN (SELECT 'CUT_BUNDLE' AS doc_type, 'BND-' AS prefix, 7 AS padding
        UNION ALL SELECT 'CUT_OUTPUT', 'CO-', 5
        UNION ALL SELECT 'FAB_ISSUE',  'FDC-', 5
        UNION ALL SELECT 'FAB_RETURN', 'FRT-', 5
        UNION ALL SELECT 'LAY_PLAN',   'LAY-', 5
        UNION ALL SELECT 'CUT_RECON',  'CRN-', 5) t
 WHERE NOT EXISTS (SELECT 1 FROM cfg_number_series ns
                    WHERE ns.company_id = c.id AND ns.doc_type = t.doc_type
                      AND ns.branch_id IS NULL AND ns.fy_id IS NULL);

-- ─────────────────────────────────────────────────────────────────
-- 7. Cutting roles (doc §21). Mirrors ROLES in server/src/scripts/seedData.ts
--    so production (where the seed does not run) gets them too.
--    Production Manager / Merchandiser already exist; QA is added.
-- ─────────────────────────────────────────────────────────────────
INSERT INTO mst_role (company_id, role_code, role_name, description, is_system)
SELECT c.id, t.code, t.name, t.descr, 0
  FROM mst_company c
  JOIN (SELECT 'CUTTING_OPERATOR' AS code, 'Cutting Operator' AS name,
               'Creates and executes lays, records cut output and generates bundles' AS descr
        UNION ALL SELECT 'CUTTING_SUPERVISOR', 'Cutting Supervisor',
               'Approves lays, consumption, cutting reconciliation and variances'
        UNION ALL SELECT 'FABRIC_STORE', 'Fabric Store',
               'Creates, issues and returns fabric DC (roll-wise) transactions'
        UNION ALL SELECT 'QA', 'Quality Assurance',
               'Views cut / production traceability and records quality checks') t
 WHERE NOT EXISTS (SELECT 1 FROM mst_role r WHERE r.company_id = c.id AND r.role_code = t.code);

INSERT INTO map_role_permission (role_id, permission_id)
SELECT r.id, p.id
  FROM mst_role r
  JOIN (SELECT 'CUTTING_OPERATOR' AS role_code, 'DASHBOARD.VIEW' AS perm
        UNION ALL SELECT 'CUTTING_OPERATOR','PRODUCTION.VIEW'
        UNION ALL SELECT 'CUTTING_OPERATOR','PRODUCTION.CREATE'
        UNION ALL SELECT 'CUTTING_OPERATOR','PRODUCTION.UPDATE'
        UNION ALL SELECT 'CUTTING_OPERATOR','STYLE.VIEW'
        UNION ALL SELECT 'CUTTING_OPERATOR','SIZE.VIEW'
        UNION ALL SELECT 'CUTTING_OPERATOR','COLOR.VIEW'
        UNION ALL SELECT 'CUTTING_OPERATOR','MATERIAL.VIEW'
        UNION ALL SELECT 'CUTTING_OPERATOR','INVENTORY.VIEW'
        UNION ALL SELECT 'CUTTING_OPERATOR','REPORT.VIEW'
        UNION ALL SELECT 'CUTTING_SUPERVISOR','DASHBOARD.VIEW'
        UNION ALL SELECT 'CUTTING_SUPERVISOR','PRODUCTION.VIEW'
        UNION ALL SELECT 'CUTTING_SUPERVISOR','PRODUCTION.CREATE'
        UNION ALL SELECT 'CUTTING_SUPERVISOR','PRODUCTION.UPDATE'
        UNION ALL SELECT 'CUTTING_SUPERVISOR','PRODUCTION.APPROVE'
        UNION ALL SELECT 'CUTTING_SUPERVISOR','STYLE.VIEW'
        UNION ALL SELECT 'CUTTING_SUPERVISOR','SIZE.VIEW'
        UNION ALL SELECT 'CUTTING_SUPERVISOR','COLOR.VIEW'
        UNION ALL SELECT 'CUTTING_SUPERVISOR','MATERIAL.VIEW'
        UNION ALL SELECT 'CUTTING_SUPERVISOR','INVENTORY.VIEW'
        UNION ALL SELECT 'CUTTING_SUPERVISOR','QC.VIEW'
        UNION ALL SELECT 'CUTTING_SUPERVISOR','REPORT.VIEW'
        UNION ALL SELECT 'FABRIC_STORE','DASHBOARD.VIEW'
        UNION ALL SELECT 'FABRIC_STORE','PRODUCTION.VIEW'
        UNION ALL SELECT 'FABRIC_STORE','PRODUCTION.CREATE'
        UNION ALL SELECT 'FABRIC_STORE','PRODUCTION.UPDATE'
        UNION ALL SELECT 'FABRIC_STORE','INVENTORY.VIEW'
        UNION ALL SELECT 'FABRIC_STORE','ISSUE.VIEW'
        UNION ALL SELECT 'FABRIC_STORE','ISSUE.CREATE'
        UNION ALL SELECT 'FABRIC_STORE','GRN.VIEW'
        UNION ALL SELECT 'FABRIC_STORE','WAREHOUSE.VIEW'
        UNION ALL SELECT 'FABRIC_STORE','MATERIAL.VIEW'
        UNION ALL SELECT 'FABRIC_STORE','STYLE.VIEW'
        UNION ALL SELECT 'FABRIC_STORE','REPORT.VIEW'
        UNION ALL SELECT 'QA','DASHBOARD.VIEW'
        UNION ALL SELECT 'QA','PRODUCTION.VIEW'
        UNION ALL SELECT 'QA','QC.VIEW'
        UNION ALL SELECT 'QA','QC.CREATE'
        UNION ALL SELECT 'QA','STYLE.VIEW'
        UNION ALL SELECT 'QA','SALES_ORDER.VIEW'
        UNION ALL SELECT 'QA','PACKING.VIEW'
        UNION ALL SELECT 'QA','DISPATCH.VIEW'
        UNION ALL SELECT 'QA','REPORT.VIEW') g ON g.role_code = r.role_code
  JOIN mst_permission p ON p.permission_code = g.perm
 WHERE NOT EXISTS (SELECT 1 FROM map_role_permission m WHERE m.role_id = r.id AND m.permission_id = p.id);
