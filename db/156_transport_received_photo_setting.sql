-- =====================================================================
-- 156 · Transport: requester confirms the material received + delivery photo switch (client voice note 05-Nov-2026)
--   "When we receive the material, OUR person (the requester) must update 'received'." → request status RECEIVED
--   (after Delivered / Completed) with received date-time, qty, condition OK / SHORT / DAMAGED and remarks.
--   "Delivery photos are not needed for us now — keep the option but hidden, something we can enable."
--   → TRANSPORT_DELIVERY_PHOTO (default 0 = hidden, never required; 1 = shown, request types set to need proof
--   need a photo). Visitor photos are not affected.
-- Idempotent: the runner re-applies files >= 10 on every deploy.
-- =====================================================================
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_transport_request'
           AND COLUMN_NAME='status' AND COLUMN_TYPE LIKE '%''RECEIVED''%');
SET @s = IF(@x=0, 'ALTER TABLE trx_transport_request MODIFY COLUMN status ENUM(''DRAFT'',''SUBMITTED'',''UNDER_REVIEW'',''CLARIFICATION_REQUIRED'',''APPROVED'',''REJECTED'',''ASSIGNED'',''IN_PROGRESS'',''PICKUP_COMPLETED'',''DELIVERED'',''COMPLETED'',''RECEIVED'',''CANCELLED'') NOT NULL DEFAULT ''DRAFT''', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_transport_request' AND COLUMN_NAME='received_at');
SET @s = IF(@x=0, 'ALTER TABLE trx_transport_request
    ADD COLUMN received_at DATETIME NULL COMMENT ''Requester confirmed the material received (UTC)'',
    ADD COLUMN received_by BIGINT UNSIGNED NULL,
    ADD COLUMN received_qty DECIMAL(12,2) NULL,
    ADD COLUMN received_condition ENUM(''OK'',''SHORT'',''DAMAGED'') NULL,
    ADD COLUMN received_remarks VARCHAR(500) NULL,
    ADD COLUMN received_recorded_at DATETIME NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

INSERT IGNORE INTO cfg_system_setting (company_id, setting_key, setting_value, description)
SELECT id, 'TRANSPORT_DELIVERY_PHOTO', '0',
       'Transport delivery / proof photos on the driver screen: 1 = shown (request types marked "proof required" need a photo at delivery); 0 = hidden and never required (visitor photos are not affected)'
  FROM mst_company;
