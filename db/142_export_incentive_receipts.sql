-- =====================================================================
-- 142 · Export incentive receipts (client voice note 23-Oct-2026, late)
--   Drawback, IGST refund, RoSCTL and RoDTEP of a shipping bill are not received on one day — each comes on its own
--   date (drawback to the bank, RoSCTL / RoDTEP as e-scrips, IGST refund to the bank), sometimes in parts. Finance
--   records every receipt (date, amount, bank UTR / scroll / scrip no); the claim's received amount, credit date and
--   status (claimed → part received → received) follow from its receipts. A balance that will not come (rate cut,
--   short payment) is short-closed with a reason. Export and Finance both see per shipping bill what is received
--   and what is pending.
-- Idempotent: the runner re-applies files >= 10 on every deploy.
-- =====================================================================
CREATE TABLE IF NOT EXISTS trx_export_incentive_receipt (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  company_id    BIGINT UNSIGNED NOT NULL,
  incentive_id  BIGINT UNSIGNED NOT NULL,
  receipt_date  DATE NOT NULL,
  amount        DECIMAL(18,2) NOT NULL,
  mode          VARCHAR(10) NOT NULL DEFAULT 'BANK' COMMENT 'BANK / SCRIP (e-scrip in the ICEGATE ledger) / ADJUSTED',
  reference     VARCHAR(80) NULL COMMENT 'Bank UTR / DBK scroll no / e-scrip no',
  remarks       VARCHAR(300) NULL,
  created_by    BIGINT UNSIGNED NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_incr_incentive (incentive_id),
  KEY ix_incr_company_date (company_id, receipt_date),
  CONSTRAINT fk_incr__incentive FOREIGN KEY (incentive_id) REFERENCES trx_export_incentive (id),
  CONSTRAINT fk_incr__company FOREIGN KEY (company_id) REFERENCES mst_company (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Receipts against an export incentive claim (one per credit)';

-- status: + PARTIAL (part received) and SHORT_CLOSED (balance will not come). Only while it is still an ENUM —
-- migration 144 makes it VARCHAR(20) (with NOT_APPLICABLE etc.); turning that back into this ENUM truncates rows.
SET @x = (SELECT COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_export_incentive' AND COLUMN_NAME='status');
SET @s = IF(@x LIKE 'enum(%' AND @x NOT LIKE '%SHORT_CLOSED%',
  'ALTER TABLE trx_export_incentive MODIFY status ENUM(''PENDING'',''CLAIMED'',''PARTIAL'',''CREDITED'',''SHORT_CLOSED'',''REJECTED'') DEFAULT ''PENDING''', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

DROP PROCEDURE IF EXISTS _inr_add_col;
CREATE PROCEDURE _inr_add_col(IN t VARCHAR(64), IN c VARCHAR(64), IN ddl VARCHAR(500))
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = t AND COLUMN_NAME = c) THEN
    SET @q = CONCAT('ALTER TABLE ', t, ' ADD COLUMN ', c, ' ', ddl);
    PREPARE s1 FROM @q; EXECUTE s1; DEALLOCATE PREPARE s1;
  END IF;
END;
CALL _inr_add_col('trx_export_incentive', 'closed_reason', 'VARCHAR(300) NULL COMMENT ''Why the balance was short-closed / rejected''');
CALL _inr_add_col('trx_export_incentive', 'closed_at', 'DATETIME NULL');
DROP PROCEDURE IF EXISTS _inr_add_col;

-- what was received before receipts existed becomes one receipt (once). From migration 144 on, receipts are events in
-- trx_export_benefit_event and received_amount is derived from them — so this carry-over (and the status fix) only run
-- while that table does not exist yet (otherwise every deploy would add a duplicate "carried over" receipt).
SET @eb = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_export_benefit_event');
SET @s = IF(@eb > 0, 'SELECT 1', 'INSERT INTO trx_export_incentive_receipt (company_id, incentive_id, receipt_date, amount, mode, reference, remarks)
SELECT x.company_id, x.id, COALESCE(x.credit_date, x.claim_date, DATE(x.created_at)), x.received_amount,
       IF(x.incentive_type IN (''RODTEP'', ''ROSCTL''), ''SCRIP'', ''BANK''), x.scrip_no, ''Carried over (received before receipts were recorded)''
  FROM trx_export_incentive x
 WHERE x.received_amount > 0 AND NOT EXISTS (SELECT 1 FROM trx_export_incentive_receipt r WHERE r.incentive_id = x.id)');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s = IF(@eb > 0, 'SELECT 1', 'UPDATE trx_export_incentive SET status = ''PARTIAL''
 WHERE status IN (''PENDING'', ''CLAIMED'') AND received_amount > 0 AND received_amount < claim_amount - 0.005');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
