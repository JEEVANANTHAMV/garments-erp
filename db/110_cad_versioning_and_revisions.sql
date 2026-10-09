-- Migration 110: CAD Requirement Versioning and Revisions (V01, V02...)
-- Allows multiple versions under the same req_no (e.g. CAD-2026-0001 with V01, V02)
-- Adds SUPERSEDED to status ENUM

SET @idx_exist = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_cad_requirement' AND INDEX_NAME = 'uq_cad_req');
SET @sql1 = IF(@idx_exist > 0, 'ALTER TABLE trx_cad_requirement DROP INDEX uq_cad_req', 'SELECT 1');
PREPARE stmt1 FROM @sql1; EXECUTE stmt1; DEALLOCATE PREPARE stmt1;

SET @ver_idx_exist = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_cad_requirement' AND INDEX_NAME = 'uq_cad_req_ver');
SET @sql2 = IF(@ver_idx_exist = 0, 'ALTER TABLE trx_cad_requirement ADD UNIQUE KEY uq_cad_req_ver (company_id, req_no, cad_version)', 'SELECT 1');
PREPARE stmt2 FROM @sql2; EXECUTE stmt2; DEALLOCATE PREPARE stmt2;

ALTER TABLE trx_cad_requirement MODIFY COLUMN status ENUM('DRAFT','CALCULATED','VALIDATED','APPROVED','OBSOLETE','SUPERSEDED') NOT NULL DEFAULT 'DRAFT';
