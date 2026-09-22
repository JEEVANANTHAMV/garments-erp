-- =====================================================================
-- 50. PROCESS REVISIONS  +  ROUTE SEQUENCE ENFORCEMENT
-- ---------------------------------------------------------------------
-- (a) Doc §22 / §29: "Changes after release require revision and audit
--     trail" and "Use revision instead of editing completed/released
--     historical data". Until now a released or completed document could
--     only be refused an edit — there was no way to legitimately change
--     one. This adds the revision document that makes that possible.
--
-- (b) Doc §4: a process route defines the sequence a yarn follows. The
--     route master existed and processes could reference it, but nothing
--     checked that the steps actually ran in order. The columns below let
--     a process record which route step it fulfils and what it followed.
-- =====================================================================

-- ─────────────────────────────────────────────────────────────────
-- 1. PROCESS REVISIONS
--    One row per revision of a released/completed document. Holds the
--    snapshot taken before the change, so the prior state is always
--    recoverable and the reason is on record.
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS trx_process_revision (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  src_type        ENUM('YARN_PROCESS','KNITTING_PROGRAM','COLLAR_PROGRAM') NOT NULL,
  src_id          BIGINT UNSIGNED NOT NULL,
  revision_no     INT NOT NULL DEFAULT 1
                  COMMENT 'Sequential per document: 1, 2, 3…',
  revision_date   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  reason          VARCHAR(500) NOT NULL
                  COMMENT 'Why the released document had to change',
  status_before   VARCHAR(40) NULL,
  status_after    VARCHAR(40) NULL,

  -- Full snapshot of the document (header plus lines) as it stood before
  -- the change, so a revision can always be read back or reversed.
  snapshot_json   JSON NULL,
  changes_json    JSON NULL COMMENT 'Fields the revision actually altered',

  created_by      BIGINT UNSIGNED NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  UNIQUE KEY uq_prev (src_type, src_id, revision_no),
  KEY ix_prev_src (src_type, src_id),
  CONSTRAINT fk_prev__company FOREIGN KEY (company_id) REFERENCES mst_company(id)
) ENGINE=InnoDB COMMENT='Revisions of released/completed process documents (doc §22)';

-- Current revision number on each document, so the UI can show "Rev 2".
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_yarn_process' AND COLUMN_NAME='revision_no');
SET @s = IF(@x=0, 'ALTER TABLE trx_yarn_process ADD COLUMN revision_no INT NOT NULL DEFAULT 0', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_knitting_program' AND COLUMN_NAME='revision_no');
SET @s = IF(@x=0, 'ALTER TABLE trx_knitting_program ADD COLUMN revision_no INT NOT NULL DEFAULT 0', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_collar_program' AND COLUMN_NAME='revision_no');
SET @s = IF(@x=0, 'ALTER TABLE trx_collar_program ADD COLUMN revision_no INT NOT NULL DEFAULT 0', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- ─────────────────────────────────────────────────────────────────
-- 2. ROUTE SEQUENCE ENFORCEMENT (doc §4)
--    prev_process_id links a process to the one it follows, so the chain
--    can be walked and validated against the route's step order.
-- ─────────────────────────────────────────────────────────────────
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_yarn_process' AND COLUMN_NAME='prev_process_id');
SET @s = IF(@x=0,
  'ALTER TABLE trx_yarn_process ADD COLUMN prev_process_id BIGINT UNSIGNED NULL COMMENT ''Process this one follows in the route''',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @x = (SELECT COUNT(*) FROM information_schema.STATISTICS
           WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_yarn_process' AND INDEX_NAME='ix_yp_prev');
SET @s = IF(@x=0, 'CREATE INDEX ix_yp_prev ON trx_yarn_process(prev_process_id)', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- Number series for revisions.
INSERT INTO cfg_number_series (company_id, branch_id, doc_type, fy_id, prefix, next_number, padding)
SELECT c.id, NULL, 'PROCESS_REVISION', NULL, 'REV-', 1, 5
FROM mst_company c
WHERE NOT EXISTS (
  SELECT 1 FROM cfg_number_series s WHERE s.company_id = c.id AND s.doc_type = 'PROCESS_REVISION'
);

COMMIT;

-- ─────────────────────────────────────────────────────────────────
-- 3. Permission for raising a revision (doc §22, §26).
--    Revising released history is an authorised act, so it is its own
--    right rather than something any editor can do.
-- ─────────────────────────────────────────────────────────────────
INSERT INTO mst_permission (module_id, permission_code, permission_name)
SELECT m.id, 'PROCESS.REVISE', 'Revise a released or completed process'
FROM mst_module m
WHERE m.module_code = 'PRODUCTION'
  AND NOT EXISTS (SELECT 1 FROM mst_permission x WHERE x.permission_code = 'PROCESS.REVISE');

COMMIT;

INSERT INTO map_role_permission (role_id, permission_id)
SELECT r.id, p.id
FROM mst_role r
JOIN mst_permission p ON p.permission_code = 'PROCESS.REVISE'
WHERE r.role_code IN ('SUPER_ADMIN','ADMIN','PRODUCTION_MANAGER')
  AND NOT EXISTS (
    SELECT 1 FROM map_role_permission m WHERE m.role_id = r.id AND m.permission_id = p.id
  );
