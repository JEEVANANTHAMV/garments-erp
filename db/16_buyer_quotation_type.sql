-- Migration 16: Add BUYER quotation_type to trx_quotation.
-- Guarded: the runner re-applies every file >= 10 on each deploy, and migration 17
-- widens this ENUM (FABRIC / YARN / TRIMS / GENERAL). Re-narrowing it here would fail
-- as soon as a purchase quotation exists, so only apply while 'BUYER' is still missing.
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_quotation'
             AND COLUMN_NAME = 'quotation_type' AND COLUMN_TYPE NOT LIKE '%''BUYER''%');
SET @s = IF(@x = 1, 'ALTER TABLE trx_quotation MODIFY COLUMN quotation_type ENUM(''DOMESTIC'',''IMPORT'',''BUYER'') NOT NULL DEFAULT ''BUYER''', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
