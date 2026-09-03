-- Migration 16: Add BUYER quotation_type to trx_quotation
ALTER TABLE trx_quotation MODIFY COLUMN quotation_type ENUM('DOMESTIC','IMPORT','BUYER') NOT NULL DEFAULT 'BUYER';
