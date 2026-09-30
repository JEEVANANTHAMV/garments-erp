-- =====================================================================
-- 84: Quotation versions (client voice note 30-Sep-2026)
--   Editing a saved quotation snapshots its previous header + lines here as
--   V1, V2 …; trx_quotation.version is the current version. Idempotent.
-- =====================================================================
CREATE TABLE IF NOT EXISTS trx_quotation_version (
  id            BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id    BIGINT UNSIGNED NOT NULL,
  quotation_id  BIGINT UNSIGNED NOT NULL,
  version       INT NOT NULL,
  header_json   JSON NOT NULL,
  lines_json    JSON NOT NULL,
  total_amount  DECIMAL(18,4) NOT NULL DEFAULT 0,
  changed_by    BIGINT UNSIGNED NULL COMMENT 'User whose save replaced this version',
  changed_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_qv (quotation_id, version),
  KEY ix_qv_company (company_id),
  CONSTRAINT fk_qv__quotation FOREIGN KEY (quotation_id) REFERENCES trx_quotation(id) ON DELETE CASCADE
) ENGINE=InnoDB COMMENT='Earlier versions (V1, V2 …) of a quotation';
