-- =====================================================================
-- 82 · What a Process DC released from in-house line allocations / daily
--   plans, so cancelling the DC can restore exactly that (when the
--   allocation is still active and the PCS are still free). Idempotent.
-- =====================================================================
CREATE TABLE IF NOT EXISTS trx_dc_alloc_release (
  id                   BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id           BIGINT UNSIGNED NOT NULL,
  challan_id           BIGINT UNSIGNED NOT NULL,
  bundle_id            BIGINT UNSIGNED NOT NULL,
  proc                 VARCHAR(20) NOT NULL COMMENT 'sewing / checking / ironing / packing',
  kind                 ENUM('ALLOC','PLAN') NOT NULL,
  allocation_detail_id BIGINT UNSIGNED NOT NULL,
  plan_detail_id       BIGINT UNSIGNED NULL,
  qty                  INT UNSIGNED NOT NULL,
  restored_qty         INT UNSIGNED NOT NULL DEFAULT 0,
  status               ENUM('RELEASED','RESTORED','PARTIAL','SKIPPED') NOT NULL DEFAULT 'RELEASED',
  note                 VARCHAR(255),
  created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  restored_at          DATETIME NULL,
  KEY ix_dcar_challan (challan_id, status),
  CONSTRAINT fk_dcar__company FOREIGN KEY (company_id) REFERENCES mst_company(id)
) ENGINE=InnoDB COMMENT='Line allocation / daily plan PCS released by a Process DC (restored on DC cancel)';
