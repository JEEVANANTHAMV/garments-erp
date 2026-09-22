-- =====================================================================
-- 49. COLLAR RECEIPT (stock in PCS)  +  PROCESS PERMISSION MATRIX
-- ---------------------------------------------------------------------
-- (a) Doc §16.5 / §17: collar inventory is maintained in PCS, with the
--     KG consumed retained only as a costing / variance reference.
--     Production already records actual PCS and actual KG; this adds the
--     receipt that actually puts finished collars into stock as pieces.
--
-- (b) Doc §26: the process permission matrix. Until now every yarn
--     process endpoint checked only the generic PRODUCTION.* rights, so
--     a QC user could release a program and a store user could complete
--     one. These finer permissions let the matrix be enforced.
-- =====================================================================

-- ─────────────────────────────────────────────────────────────────
-- 1. COLLAR RECEIPT — finished collars into stock, counted in PCS
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS trx_collar_receipt (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  receipt_no      VARCHAR(60) NOT NULL,
  receipt_date    DATE NOT NULL,
  program_id      BIGINT UNSIGNED NOT NULL,
  production_id   BIGINT UNSIGNED NULL
                  COMMENT 'Production entry this receipt draws from, when known',
  size_id         INT UNSIGNED NULL,
  size_code       VARCHAR(40) NULL,

  -- Stock quantity is PCS; KG is reference only (doc §16.5).
  received_pcs    INT NOT NULL DEFAULT 0,
  rejected_pcs    INT NOT NULL DEFAULT 0,
  good_pcs        INT NOT NULL DEFAULT 0,
  yarn_kg_ref     DECIMAL(14,3) NOT NULL DEFAULT 0
                  COMMENT 'Yarn consumed for these pieces — costing reference, not a stock qty',

  warehouse_id    BIGINT UNSIGNED NULL,
  qc_status       ENUM('PENDING','PASSED','HOLD','REJECTED') NOT NULL DEFAULT 'PENDING',
  is_stock_posted TINYINT(1) NOT NULL DEFAULT 0,
  remarks         TEXT NULL,
  created_by      BIGINT UNSIGNED NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  UNIQUE KEY uq_colrcpt (company_id, receipt_no),
  KEY ix_colrcpt_prog (program_id),
  CONSTRAINT fk_colrcpt__company FOREIGN KEY (company_id) REFERENCES mst_company(id),
  CONSTRAINT fk_colrcpt__prog FOREIGN KEY (program_id)
    REFERENCES trx_collar_program(id) ON DELETE CASCADE,
  CONSTRAINT fk_colrcpt__prod FOREIGN KEY (production_id)
    REFERENCES trx_collar_production(id) ON DELETE SET NULL,
  CONSTRAINT fk_colrcpt__size FOREIGN KEY (size_id) REFERENCES mst_size(id)
) ENGINE=InnoDB COMMENT='Collar receipt — finished collars into stock in PCS (doc §16.5)';

-- Running total of pieces actually received into stock, per program.
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_collar_program'
             AND COLUMN_NAME='received_pcs');
SET @s = IF(@x=0,
  'ALTER TABLE trx_collar_program ADD COLUMN received_pcs INT NOT NULL DEFAULT 0',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- Number series for collar receipts.
INSERT INTO cfg_number_series (company_id, branch_id, doc_type, fy_id, prefix, next_number, padding)
SELECT c.id, NULL, 'COLLAR_RECEIPT', NULL, 'CRC-', 1, 5
FROM mst_company c
WHERE NOT EXISTS (
  SELECT 1 FROM cfg_number_series s WHERE s.company_id = c.id AND s.doc_type = 'COLLAR_RECEIPT'
);

-- ─────────────────────────────────────────────────────────────────
-- 2. PROCESS PERMISSIONS (doc §26)
--    Separate rights for the steps the matrix distinguishes, so a role
--    can be allowed to reserve without being allowed to release, and so
--    on. Existing PRODUCTION.* rights stay untouched.
-- ─────────────────────────────────────────────────────────────────
-- The migration runner sends this file as one multi-statement batch, and the
-- grants below join against these rows. Committing here guarantees the new
-- permissions are visible to those statements rather than racing them.
INSERT INTO mst_permission (module_id, permission_code, permission_name)
SELECT m.id, p.code, p.name
FROM mst_module m
JOIN (
  SELECT 'PROCESS.RESERVE'    AS code, 'Reserve material for a process'   AS name UNION ALL
  SELECT 'PROCESS.RELEASE',        'Release a process for execution'           UNION ALL
  SELECT 'PROCESS.ISSUE',          'Issue material against a process'          UNION ALL
  SELECT 'PROCESS.PRODUCTION',     'Record process production'                 UNION ALL
  SELECT 'PROCESS.QC',             'Record process QC'                         UNION ALL
  SELECT 'PROCESS.COMPLETE',       'Complete or cancel a process'              UNION ALL
  SELECT 'PROCESS.OVERRIDE_ISSUE', 'Issue beyond available or reserved stock'
) p
WHERE m.module_code = 'PRODUCTION'
  AND NOT EXISTS (
    SELECT 1 FROM mst_permission x WHERE x.permission_code = p.code
  );

COMMIT;

-- ─────────────────────────────────────────────────────────────────
-- 3. Grant the new rights per the doc §26 matrix.
--    Planner          reserve only
--    Process Manager  reserve, release, production, complete
--    Store User       issue
--    Operators        production
--    QC User          QC
--    Admin            everything
-- ─────────────────────────────────────────────────────────────────
INSERT INTO map_role_permission (role_id, permission_id)
SELECT r.id, p.id
FROM mst_role r
JOIN mst_permission p ON p.permission_code IN (
  'PROCESS.RESERVE','PROCESS.RELEASE','PROCESS.ISSUE','PROCESS.PRODUCTION',
  'PROCESS.QC','PROCESS.COMPLETE','PROCESS.OVERRIDE_ISSUE')
WHERE r.role_code IN ('SUPER_ADMIN','ADMIN')
  AND NOT EXISTS (
    SELECT 1 FROM map_role_permission m WHERE m.role_id = r.id AND m.permission_id = p.id
  );

INSERT INTO map_role_permission (role_id, permission_id)
SELECT r.id, p.id
FROM mst_role r
JOIN mst_permission p ON p.permission_code IN (
  'PROCESS.RESERVE','PROCESS.RELEASE','PROCESS.PRODUCTION','PROCESS.COMPLETE')
WHERE r.role_code = 'PRODUCTION_MANAGER'
  AND NOT EXISTS (
    SELECT 1 FROM map_role_permission m WHERE m.role_id = r.id AND m.permission_id = p.id
  );

INSERT INTO map_role_permission (role_id, permission_id)
SELECT r.id, p.id
FROM mst_role r
JOIN mst_permission p ON p.permission_code = 'PROCESS.ISSUE'
WHERE r.role_code = 'STORE_KEEPER'
  AND NOT EXISTS (
    SELECT 1 FROM map_role_permission m WHERE m.role_id = r.id AND m.permission_id = p.id
  );

INSERT INTO map_role_permission (role_id, permission_id)
SELECT r.id, p.id
FROM mst_role r
JOIN mst_permission p ON p.permission_code = 'PROCESS.QC'
WHERE r.role_code = 'QC_INSPECTOR'
  AND NOT EXISTS (
    SELECT 1 FROM map_role_permission m WHERE m.role_id = r.id AND m.permission_id = p.id
  );

INSERT INTO map_role_permission (role_id, permission_id)
SELECT r.id, p.id
FROM mst_role r
JOIN mst_permission p ON p.permission_code = 'PROCESS.RESERVE'
WHERE r.role_code = 'MERCHANDISER'
  AND NOT EXISTS (
    SELECT 1 FROM map_role_permission m WHERE m.role_id = r.id AND m.permission_id = p.id
  );

-- ─────────────────────────────────────────────────────────────────
-- 4. The PROCESS.* rights now stand alone on their endpoints, rather
--    than being demanded alongside a broad PRODUCTION.* right — pairing
--    them would make the narrow §26 roles useless (a QC user has no
--    PRODUCTION.CREATE, so could never record QC).
--
--    Consequence worth stating plainly: PRODUCTION_MANAGER previously
--    reached every process endpoint through PRODUCTION.CREATE/UPDATE.
--    Under the §26 matrix they may reserve, release, record production
--    and complete, but NOT issue material or sign off QC — those belong
--    to the store user and the QC user respectively. Grant the extra
--    rights below if a site wants the old behaviour back.
-- ─────────────────────────────────────────────────────────────────

-- Anyone who could already run production keeps being able to do so.
INSERT INTO map_role_permission (role_id, permission_id)
SELECT r.id, p.id
FROM mst_role r
JOIN mst_permission p ON p.permission_code = 'PROCESS.PRODUCTION'
WHERE r.role_code IN ('PRODUCTION_MANAGER','ADMIN','SUPER_ADMIN')
  AND NOT EXISTS (
    SELECT 1 FROM map_role_permission m WHERE m.role_id = r.id AND m.permission_id = p.id
  );
