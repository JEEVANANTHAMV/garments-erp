-- =====================================================================
-- 145 · Bill tracker: document inward register, links, matching, custody, approval, posting queue
--   (client voice note 24-Oct-2026: review the "Bill Tracker, Document Inward, Matching & Accounting Auto-Posting"
--    specification and build what is better than the existing tracker — keep the receipt → handover → back →
--    submitted-to-accounts flow the client already uses.)
--
--   trx_document_inward        every incoming document (bill, DC, GRN copy, PO copy, process challan, freight proof,
--                              certificate, email attachment, other) on its own Inward No., even before the bill / GRN exists
--   trx_bill_doc_attachment    files (private: server/uploads/bill-docs, random names, sha256, authenticated download only)
--   trx_document_link          inward document ↔ PO / GRN / gate inward / process DC / Bills Inward / another document
--   cfg_bill_category          PURCHASE / PROCESS / EXPENSE / FREIGHT / SERVICE / OTHER: required documents + tolerances
--   trx_bill_tracker_link      bill ↔ several DCs / GRNs / POs / Bills Inward entries / process bills (linked qty / amount)
--   trx_bill_movement          custody history (immutable: corrections are new rows)
--   trx_bill_match_result      matching runs: expected / actual / variance / severity / override
--   trx_bill_approval          verify / approve / return / reject / hold history (maker-checker)
--   trx_bill_followup          follow-up tasks (owner, due date, priority, next follow-up, resolution)
--   trx_bill_posting(+attempt) accounting posting queue (idempotency key; MANUAL adapter until the accounts package is confirmed)
--
-- Idempotent: the runner re-applies every file >= 10 on each deploy. No triggers (binary logging is on in production).
-- =====================================================================

-- ------------------------------------------------------------ categories + required-document matrix
CREATE TABLE IF NOT EXISTS cfg_bill_category (
  id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  company_id           BIGINT UNSIGNED NOT NULL,
  category_code        VARCHAR(12) NOT NULL COMMENT 'PURCHASE / PROCESS / EXPENSE / FREIGHT / SERVICE / OTHER',
  category_name        VARCHAR(60) NOT NULL,
  req_dc               TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'Needs a DC: supplier DC at the gate / DC document / process DC',
  req_receipt          TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'Needs a GRN (goods received and accepted)',
  req_po               TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'Needs a purchase order',
  req_bill_entry       TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'Needs the Bills Inward entry (supplier / knitting / process / contractor bill)',
  req_process          TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'Needs a process receipt at the approved rate (process / knitting / contractor bill, process DC with rate)',
  req_attachment       TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'Needs a scanned copy / file',
  amount_tol_pct       DECIMAL(6,2) NOT NULL DEFAULT 0.50 COMMENT 'Allowed amount variance %',
  amount_tol_abs       DECIMAL(12,2) NOT NULL DEFAULT 5.00 COMMENT 'Allowed amount variance ₹ (the larger of % and ₹ applies)',
  qty_tol_pct          DECIMAL(6,2) NOT NULL DEFAULT 0.50 COMMENT 'Allowed quantity variance %',
  over_billing         VARCHAR(10) NOT NULL DEFAULT 'APPROVAL' COMMENT 'BLOCK = cannot link more than the GRN / PO value; APPROVAL = allowed, needs an approver override',
  high_value_limit     DECIMAL(18,2) NOT NULL DEFAULT 0 COMMENT 'Bills above this need BILL_TRACKER.APPROVE_HIGH (0 = no limit)',
  sort_order           INT NOT NULL DEFAULT 0,
  is_active            TINYINT(1) NOT NULL DEFAULT 1,
  row_version          INT UNSIGNED NOT NULL DEFAULT 1,
  updated_by           BIGINT UNSIGNED NULL,
  updated_at           DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_bill_cat (company_id, category_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Bill categories: required documents, matching tolerances, over-billing policy';

INSERT INTO cfg_bill_category (company_id, category_code, category_name, req_dc, req_receipt, req_po, req_bill_entry, req_process, req_attachment, sort_order)
SELECT c.id, s.code, s.name, s.dc, s.rc, s.po, s.be, s.pr, s.att, s.so
  FROM mst_company c
  JOIN (SELECT 'PURCHASE' code, 'Purchase (yarn / fabric / trims / general)' name, 1 dc, 1 rc, 0 po, 0 be, 0 pr, 0 att, 1 so
        UNION ALL SELECT 'PROCESS', 'Process / job work (knitting, dyeing, printing, stitching…)', 1, 0, 0, 0, 1, 0, 2
        UNION ALL SELECT 'EXPENSE', 'Expense (no goods receipt)', 0, 0, 0, 0, 0, 0, 3
        UNION ALL SELECT 'FREIGHT', 'Freight / transport', 0, 0, 0, 0, 0, 0, 4
        UNION ALL SELECT 'SERVICE', 'Service (repairs, AMC, testing…)', 0, 0, 0, 0, 0, 0, 5
        UNION ALL SELECT 'OTHER', 'Other', 0, 0, 0, 0, 0, 0, 6) s
 WHERE NOT EXISTS (SELECT 1 FROM cfg_bill_category x WHERE x.company_id = c.id AND x.category_code = s.code);

-- ------------------------------------------------------------ document inward register
CREATE TABLE IF NOT EXISTS trx_document_inward (
  id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  company_id           BIGINT UNSIGNED NOT NULL,
  inward_no            VARCHAR(40) NOT NULL,
  doc_type             VARCHAR(20) NOT NULL COMMENT 'BILL / DC / GRN_COPY / PO_COPY / PROCESS_CHALLAN / FREIGHT_PROOF / CERTIFICATE / EMAIL_ATTACHMENT / OTHER',
  channel              VARCHAR(10) NOT NULL DEFAULT 'PHYSICAL' COMMENT 'PHYSICAL / EMAIL / SCAN / PORTAL / OTHER',
  received_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'System timestamp of the intake',
  receipt_date         DATE NOT NULL COMMENT 'Business receipt date (may differ from the system date)',
  received_by          BIGINT UNSIGNED NULL,
  received_dept        VARCHAR(80) NULL,
  sender_name          VARCHAR(150) NULL COMMENT 'From / sender (contact, courier, email sender)',
  party_id             BIGINT UNSIGNED NULL COMMENT 'Supplier / party — may be unknown at intake',
  doc_no               VARCHAR(60) NULL,
  normalized_doc_no    VARCHAR(60) NULL,
  doc_date             DATE NULL,
  amount               DECIMAL(18,2) NULL,
  completeness         VARCHAR(20) NOT NULL DEFAULT 'INCOMPLETE' COMMENT 'COMPLETE / INCOMPLETE / AWAITING_LINK / DUPLICATE_SUSPECTED / REJECTED',
  duplicate_note       VARCHAR(255) NULL,
  duplicate_cleared    TINYINT(1) NOT NULL DEFAULT 0,
  assigned_to          BIGINT UNSIGNED NULL COMMENT 'Owner while unresolved',
  due_date             DATE NULL,
  notes                VARCHAR(1000) NULL,
  tags                 VARCHAR(200) NULL,
  mailbox              VARCHAR(120) NULL,
  email_from           VARCHAR(200) NULL,
  email_subject        VARCHAR(300) NULL,
  email_message_id     VARCHAR(255) NULL,
  email_received_at    DATETIME NULL,
  email_attachment_ref VARCHAR(255) NULL,
  status               VARCHAR(10) NOT NULL DEFAULT 'ACTIVE' COMMENT 'ACTIVE / REJECTED / CANCELLED (never deleted)',
  status_reason        VARCHAR(255) NULL,
  row_version          INT UNSIGNED NOT NULL DEFAULT 1,
  created_by           BIGINT UNSIGNED NULL,
  created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by           BIGINT UNSIGNED NULL,
  updated_at           DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_doc_inward_no (company_id, inward_no),
  KEY ix_din_date (company_id, receipt_date),
  KEY ix_din_party (company_id, party_id, normalized_doc_no),
  KEY ix_din_owner (company_id, completeness, due_date),
  KEY ix_din_msg (company_id, email_message_id(100)),
  CONSTRAINT fk_din__company FOREIGN KEY (company_id) REFERENCES mst_company (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Document inward register: every incoming document, registered on its own';

CREATE TABLE IF NOT EXISTS trx_bill_doc_attachment (
  id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  company_id           BIGINT UNSIGNED NOT NULL,
  inward_id            BIGINT UNSIGNED NULL,
  bill_id              BIGINT UNSIGNED NULL,
  storage_key          VARCHAR(200) NOT NULL COMMENT 'bill-docs/<company>/<random> — never the original name',
  original_name        VARCHAR(255) NOT NULL,
  mime_type            VARCHAR(100) NOT NULL,
  byte_size            INT UNSIGNED NOT NULL,
  sha256               CHAR(64) NOT NULL,
  duplicate_of_id      BIGINT UNSIGNED NULL COMMENT 'Same file (checksum) already uploaded',
  malware_scan_status  VARCHAR(12) NOT NULL DEFAULT 'NOT_SCANNED',
  uploaded_by          BIGINT UNSIGNED NULL,
  uploaded_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  is_removed           TINYINT(1) NOT NULL DEFAULT 0,
  removed_by           BIGINT UNSIGNED NULL,
  removed_at           DATETIME NULL,
  remove_reason        VARCHAR(255) NULL,
  PRIMARY KEY (id),
  KEY ix_bda_inward (inward_id),
  KEY ix_bda_bill (bill_id),
  KEY ix_bda_hash (company_id, sha256)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Bill / inward document files (private storage)';

CREATE TABLE IF NOT EXISTS trx_document_link (
  id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  company_id           BIGINT UNSIGNED NOT NULL,
  inward_id            BIGINT UNSIGNED NOT NULL,
  target_type          VARCHAR(24) NOT NULL COMMENT 'INWARD / PO / TRIM_PO / GRN / TRIM_GRN / GATE_INWARD / JOBWORK_CHALLAN / SUPPLIER_BILL',
  target_id            BIGINT UNSIGNED NOT NULL,
  target_no            VARCHAR(60) NULL,
  note                 VARCHAR(255) NULL,
  linked_by            BIGINT UNSIGNED NULL,
  linked_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  removed_by           BIGINT UNSIGNED NULL,
  removed_at           DATETIME NULL,
  remove_reason        VARCHAR(255) NULL,
  PRIMARY KEY (id),
  KEY ix_dl_inward (inward_id),
  KEY ix_dl_target (company_id, target_type, target_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Inward document ↔ transaction / another document';

-- ------------------------------------------------------------ bill tracker: new columns
DROP PROCEDURE IF EXISTS _bt145_add_col;
CREATE PROCEDURE _bt145_add_col(IN t VARCHAR(64), IN c VARCHAR(64), IN ddl VARCHAR(500))
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = t AND COLUMN_NAME = c) THEN
    SET @q = CONCAT('ALTER TABLE ', t, ' ADD COLUMN ', c, ' ', ddl);
    PREPARE s1 FROM @q; EXECUTE s1; DEALLOCATE PREPARE s1;
  END IF;
END;
DROP PROCEDURE IF EXISTS _bt145_add_idx;
CREATE PROCEDURE _bt145_add_idx(IN t VARCHAR(64), IN i VARCHAR(64), IN cols VARCHAR(300))
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = t AND INDEX_NAME = i) THEN
    SET @q = CONCAT('ALTER TABLE ', t, ' ADD INDEX ', i, ' (', cols, ')');
    PREPARE s1 FROM @q; EXECUTE s1; DEALLOCATE PREPARE s1;
  END IF;
END;

CALL _bt145_add_col('trx_bill_tracker', 'bill_category', 'VARCHAR(12) NOT NULL DEFAULT ''PURCHASE'' COMMENT ''cfg_bill_category.category_code''');
CALL _bt145_add_col('trx_bill_tracker', 'normalized_bill_no', 'VARCHAR(60) NULL COMMENT ''Upper-case letters and digits only — duplicate check''');
CALL _bt145_add_col('trx_bill_tracker', 'inward_id', 'BIGINT UNSIGNED NULL COMMENT ''Document inward entry the bill was registered from''');
CALL _bt145_add_col('trx_bill_tracker', 'bill_qty', 'DECIMAL(18,3) NULL COMMENT ''Invoiced quantity (for quantity matching)''');
CALL _bt145_add_col('trx_bill_tracker', 'taxable_value', 'DECIMAL(18,2) NULL');
CALL _bt145_add_col('trx_bill_tracker', 'cgst_amount', 'DECIMAL(18,2) NOT NULL DEFAULT 0');
CALL _bt145_add_col('trx_bill_tracker', 'sgst_amount', 'DECIMAL(18,2) NOT NULL DEFAULT 0');
CALL _bt145_add_col('trx_bill_tracker', 'igst_amount', 'DECIMAL(18,2) NOT NULL DEFAULT 0');
CALL _bt145_add_col('trx_bill_tracker', 'other_charges', 'DECIMAL(18,2) NOT NULL DEFAULT 0');
CALL _bt145_add_col('trx_bill_tracker', 'round_off', 'DECIMAL(10,2) NOT NULL DEFAULT 0');
CALL _bt145_add_col('trx_bill_tracker', 'currency_code', 'VARCHAR(3) NOT NULL DEFAULT ''INR''');
CALL _bt145_add_col('trx_bill_tracker', 'exchange_rate', 'DECIMAL(14,6) NOT NULL DEFAULT 1');
CALL _bt145_add_col('trx_bill_tracker', 'cost_department', 'VARCHAR(80) NULL COMMENT ''Department / cost centre the bill is charged to''');
CALL _bt145_add_col('trx_bill_tracker', 'payment_due_date', 'DATE NULL');
CALL _bt145_add_col('trx_bill_tracker', 'workflow_status', 'VARCHAR(24) NOT NULL DEFAULT ''OPEN'' COMMENT ''OPEN / PENDING_VERIFICATION / PENDING_APPROVAL / APPROVED / ON_HOLD / REJECTED / CANCELLED / REVERSED''');
CALL _bt145_add_col('trx_bill_tracker', 'completeness_status', 'VARCHAR(20) NOT NULL DEFAULT ''NOT_EVALUATED'' COMMENT ''COMPLETE / INCOMPLETE (data) / AWAITING_LINK (documents missing)''');
CALL _bt145_add_col('trx_bill_tracker', 'missing_docs', 'VARCHAR(120) NULL COMMENT ''DC,GRN,PO,BILL_ENTRY,PROCESS,FILE,DATA''');
CALL _bt145_add_col('trx_bill_tracker', 'match_status', 'VARCHAR(12) NOT NULL DEFAULT ''NOT_RUN'' COMMENT ''NOT_RUN / MATCHED / WARNING / BLOCKED / RESOLVED''');
CALL _bt145_add_col('trx_bill_tracker', 'matched_at', 'DATETIME NULL');
CALL _bt145_add_col('trx_bill_tracker', 'duplicate_status', 'VARCHAR(10) NOT NULL DEFAULT ''NONE'' COMMENT ''NONE / SUSPECTED / CLEARED''');
CALL _bt145_add_col('trx_bill_tracker', 'duplicate_note', 'VARCHAR(255) NULL');
CALL _bt145_add_col('trx_bill_tracker', 'posting_status', 'VARCHAR(16) NOT NULL DEFAULT ''NOT_ELIGIBLE'' COMMENT ''NOT_ELIGIBLE / QUEUED / POSTING / POSTED / FAILED / UNKNOWN / RECON_REQUIRED / REVERSED''');
CALL _bt145_add_col('trx_bill_tracker', 'external_voucher_no', 'VARCHAR(60) NULL');
CALL _bt145_add_col('trx_bill_tracker', 'external_voucher_date', 'DATE NULL');
CALL _bt145_add_col('trx_bill_tracker', 'holder_name', 'VARCHAR(120) NULL COMMENT ''Current custody (from the latest movement)''');
CALL _bt145_add_col('trx_bill_tracker', 'holder_user_id', 'BIGINT UNSIGNED NULL');
CALL _bt145_add_col('trx_bill_tracker', 'holder_dept', 'VARCHAR(80) NULL');
CALL _bt145_add_col('trx_bill_tracker', 'holder_location', 'VARCHAR(80) NULL');
CALL _bt145_add_col('trx_bill_tracker', 'holder_since', 'DATETIME NULL');
CALL _bt145_add_col('trx_bill_tracker', 'holder_expected_back', 'DATE NULL');
CALL _bt145_add_col('trx_bill_tracker', 'submitted_by', 'BIGINT UNSIGNED NULL');
CALL _bt145_add_col('trx_bill_tracker', 'submitted_at', 'DATETIME NULL');
CALL _bt145_add_col('trx_bill_tracker', 'verified_by', 'BIGINT UNSIGNED NULL');
CALL _bt145_add_col('trx_bill_tracker', 'verified_at', 'DATETIME NULL');
CALL _bt145_add_col('trx_bill_tracker', 'approved_by', 'BIGINT UNSIGNED NULL');
CALL _bt145_add_col('trx_bill_tracker', 'approved_at', 'DATETIME NULL');
CALL _bt145_add_col('trx_bill_tracker', 'hold_reason', 'VARCHAR(255) NULL');
CALL _bt145_add_col('trx_bill_tracker', 'hold_from_status', 'VARCHAR(24) NULL');
CALL _bt145_add_col('trx_bill_tracker', 'reject_reason', 'VARCHAR(255) NULL');
CALL _bt145_add_col('trx_bill_tracker', 'row_version', 'INT UNSIGNED NOT NULL DEFAULT 1');

CALL _bt145_add_idx('trx_bill_tracker', 'ix_bt_dup', 'company_id, supplier_id, normalized_bill_no');
CALL _bt145_add_idx('trx_bill_tracker', 'ix_bt_wf', 'company_id, workflow_status');
CALL _bt145_add_idx('trx_bill_tracker', 'ix_bt_posting', 'company_id, posting_status');
CALL _bt145_add_idx('trx_bill_tracker', 'ix_bt_holder', 'company_id, holder_dept');
DROP PROCEDURE IF EXISTS _bt145_add_col;
DROP PROCEDURE IF EXISTS _bt145_add_idx;

UPDATE trx_bill_tracker SET normalized_bill_no = REGEXP_REPLACE(UPPER(bill_no), '[^A-Z0-9]', '') WHERE normalized_bill_no IS NULL;

-- one time: workflow from the old status (submitted to accounts = waiting for accounts' verification), category from the name
UPDATE trx_bill_tracker b
   SET b.workflow_status = CASE b.status WHEN 'CANCELLED' THEN 'CANCELLED' WHEN 'SUBMITTED' THEN 'PENDING_VERIFICATION' ELSE 'OPEN' END,
       b.submitted_at = IF(b.status = 'SUBMITTED', COALESCE(b.updated_at, b.created_at), b.submitted_at),
       b.bill_category = IF(LOWER(COALESCE(b.purchase_or_process, '')) REGEXP 'process|dye|dyeing|knit|print|embro|wash|compact|stitch|iron|job ?work|bleach|mercer|raising|peach',
                            'PROCESS', b.bill_category)
 WHERE NOT EXISTS (SELECT 1 FROM cfg_system_setting g WHERE g.company_id = b.company_id AND g.setting_key = 'BT145_BACKFILLED');

-- ------------------------------------------------------------ bill links (multi DC / GRN / PO / Bills Inward / process)
CREATE TABLE IF NOT EXISTS trx_bill_tracker_link (
  id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  company_id           BIGINT UNSIGNED NOT NULL,
  bill_id              BIGINT UNSIGNED NOT NULL,
  link_type            VARCHAR(24) NOT NULL COMMENT 'DOC_INWARD / GATE_INWARD / JOBWORK_CHALLAN / GRN / TRIM_GRN / PO / TRIM_PO / SUPPLIER_BILL / KNITTING_BILL / FABRIC_PROCESS_BILL / YARN_PROCESS_BILL / CONTRACTOR_BILL',
  target_id            BIGINT UNSIGNED NOT NULL,
  target_no            VARCHAR(60) NULL,
  target_date          DATE NULL,
  target_party_id      BIGINT UNSIGNED NULL,
  target_qty           DECIMAL(18,3) NULL COMMENT 'Accepted / ordered qty of the document (snapshot, refreshed by matching)',
  target_amount        DECIMAL(18,2) NULL COMMENT 'Value of the document (snapshot, refreshed by matching)',
  linked_qty           DECIMAL(18,3) NULL COMMENT 'Part of the document this bill covers',
  linked_amount        DECIMAL(18,2) NULL,
  needs_override       TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'Linked beyond the remaining value (over-billing) — approver override needed',
  note                 VARCHAR(255) NULL,
  created_by           BIGINT UNSIGNED NULL,
  created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  removed_by           BIGINT UNSIGNED NULL,
  removed_at           DATETIME NULL,
  remove_reason        VARCHAR(255) NULL,
  PRIMARY KEY (id),
  KEY ix_btl_bill (bill_id),
  KEY ix_btl_target (company_id, link_type, target_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Bill ↔ DC / GRN / PO / Bills Inward / process records (unlink = soft)';

-- the single Bills Inward / GRN link the tracker had becomes a link row (once)
INSERT INTO trx_bill_tracker_link (company_id, bill_id, link_type, target_id, target_no, target_date, target_party_id, target_amount, linked_amount, note, created_by, created_at)
SELECT b.company_id, b.id, 'SUPPLIER_BILL', sb.id, COALESCE(sb.supplier_inv_no, sb.bill_no), sb.bill_date, sb.supplier_id, sb.total_amount, sb.total_amount, 'Carried over', b.created_by, b.created_at
  FROM trx_bill_tracker b JOIN trx_supplier_bill sb ON sb.id = b.supplier_bill_id
 WHERE NOT EXISTS (SELECT 1 FROM trx_bill_tracker_link l WHERE l.bill_id = b.id AND l.link_type = 'SUPPLIER_BILL' AND l.target_id = b.supplier_bill_id);
INSERT INTO trx_bill_tracker_link (company_id, bill_id, link_type, target_id, target_no, target_date, target_party_id, target_amount, linked_amount, note, created_by, created_at)
SELECT b.company_id, b.id, 'GRN', g.id, g.grn_no, g.grn_date, g.supplier_id, COALESCE(NULLIF(g.grand_total, 0), g.net_amount), COALESCE(NULLIF(g.grand_total, 0), g.net_amount), 'Carried over', b.created_by, b.created_at
  FROM trx_bill_tracker b JOIN trx_grn g ON g.id = b.grn_id
 WHERE NOT EXISTS (SELECT 1 FROM trx_bill_tracker_link l WHERE l.bill_id = b.id AND l.link_type = 'GRN' AND l.target_id = b.grn_id);

-- ------------------------------------------------------------ custody movements (immutable)
CREATE TABLE IF NOT EXISTS trx_bill_movement (
  id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  company_id           BIGINT UNSIGNED NOT NULL,
  bill_id              BIGINT UNSIGNED NOT NULL,
  inward_id            BIGINT UNSIGNED NULL,
  seq                  INT UNSIGNED NOT NULL,
  movement_type        VARCHAR(12) NOT NULL COMMENT 'RECEIPT / HANDOVER / RETURN / TO_ACCOUNTS / TRANSFER / CORRECTION',
  from_holder          VARCHAR(150) NULL,
  from_user_id         BIGINT UNSIGNED NULL,
  from_dept            VARCHAR(80) NULL,
  from_location        VARCHAR(80) NULL,
  to_holder            VARCHAR(150) NULL,
  to_user_id           BIGINT UNSIGNED NULL,
  to_dept              VARCHAR(80) NULL,
  to_location          VARCHAR(80) NULL COMMENT 'Physical place or a digital queue',
  purpose              VARCHAR(120) NULL COMMENT 'Data entry, purchase verification, finance approval, auditor review, accounting posting…',
  business_date        DATE NOT NULL COMMENT 'Date the user gave (handover date)',
  moved_at             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Server timestamp',
  expected_return_date DATE NULL,
  handed_over_by       BIGINT UNSIGNED NULL COMMENT 'Authenticated user who recorded it',
  ack_status           VARCHAR(14) NOT NULL DEFAULT 'NOT_REQUIRED' COMMENT 'NOT_REQUIRED / PENDING / ACKNOWLEDGED / DISPUTED',
  ack_by               BIGINT UNSIGNED NULL,
  ack_at               DATETIME NULL,
  ack_note             VARCHAR(255) NULL,
  corrects_movement_id BIGINT UNSIGNED NULL,
  note                 VARCHAR(255) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_bm_seq (bill_id, seq),
  KEY ix_bm_company (company_id, moved_at),
  KEY ix_bm_to_user (to_user_id, ack_status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Bill custody movements — never edited; a wrong entry is reversed by a CORRECTION row';

-- existing bills: their receipt / handover / back / to-accounts dates become movement rows (once — BT145_BACKFILLED flag)
INSERT INTO trx_bill_movement (company_id, bill_id, seq, movement_type, from_holder, from_dept, to_holder, to_user_id, to_location, purpose, business_date, moved_at, handed_over_by, note)
SELECT b.company_id, b.id, 1, 'RECEIPT', COALESCE(p.party_name, b.received_from_dept, 'Vendor'), b.received_from_dept, COALESCE(u.full_name, 'Bill desk'), b.created_by, 'Bill inward desk',
       'Bill received', b.entry_date, b.created_at, b.created_by, 'Carried over (recorded before movement history)'
  FROM trx_bill_tracker b LEFT JOIN mst_party p ON p.id = b.supplier_id LEFT JOIN mst_user u ON u.id = b.created_by
 WHERE NOT EXISTS (SELECT 1 FROM trx_bill_movement m WHERE m.bill_id = b.id) AND NOT EXISTS (SELECT 1 FROM cfg_system_setting g WHERE g.company_id = b.company_id AND g.setting_key = 'BT145_BACKFILLED');
INSERT INTO trx_bill_movement (company_id, bill_id, seq, movement_type, from_holder, to_holder, to_dept, purpose, business_date, moved_at, handed_over_by, note)
SELECT b.company_id, b.id, 2, 'HANDOVER', COALESCE(u.full_name, 'Bill desk'), b.handed_over_to, b.handover_department, 'Handed over to the department',
       COALESCE(b.handover_date, b.entry_date), COALESCE(b.handover_date, b.entry_date), b.updated_by, 'Carried over (recorded before movement history)'
  FROM trx_bill_tracker b LEFT JOIN mst_user u ON u.id = b.created_by
 WHERE b.handed_over_to IS NOT NULL AND NOT EXISTS (SELECT 1 FROM cfg_system_setting g WHERE g.company_id = b.company_id AND g.setting_key = 'BT145_BACKFILLED') AND NOT EXISTS (SELECT 1 FROM trx_bill_movement m WHERE m.bill_id = b.id AND m.seq >= 2);
INSERT INTO trx_bill_movement (company_id, bill_id, seq, movement_type, from_holder, from_dept, to_holder, to_user_id, to_location, purpose, business_date, moved_at, handed_over_by, note)
SELECT b.company_id, b.id, 3, 'RETURN', b.handed_over_to, b.handover_department, COALESCE(u.full_name, 'Bill desk'), b.created_by, 'Bill inward desk', 'Received back from the department',
       b.received_back_date, b.received_back_date, b.updated_by, 'Carried over (recorded before movement history)'
  FROM trx_bill_tracker b LEFT JOIN mst_user u ON u.id = b.created_by
 WHERE b.received_back_date IS NOT NULL AND NOT EXISTS (SELECT 1 FROM cfg_system_setting g WHERE g.company_id = b.company_id AND g.setting_key = 'BT145_BACKFILLED') AND EXISTS (SELECT 1 FROM trx_bill_movement m WHERE m.bill_id = b.id AND m.seq = 2 AND m.note LIKE 'Carried over%')
   AND NOT EXISTS (SELECT 1 FROM trx_bill_movement m WHERE m.bill_id = b.id AND m.seq >= 3);
INSERT INTO trx_bill_movement (company_id, bill_id, seq, movement_type, from_holder, to_holder, to_dept, to_location, purpose, business_date, moved_at, handed_over_by, note)
SELECT b.company_id, b.id, 4, 'TO_ACCOUNTS', COALESCE(IF(b.received_back_date IS NULL, b.handed_over_to, NULL), u.full_name, 'Bill desk'), b.accounts_recipient, 'Accounts', 'Accounts',
       'Submitted to accounts', b.submitted_to_accounts_on, b.submitted_to_accounts_on, b.updated_by, 'Carried over (recorded before movement history)'
  FROM trx_bill_tracker b LEFT JOIN mst_user u ON u.id = b.created_by
 WHERE b.submitted_to_accounts_on IS NOT NULL AND NOT EXISTS (SELECT 1 FROM cfg_system_setting g WHERE g.company_id = b.company_id AND g.setting_key = 'BT145_BACKFILLED') AND EXISTS (SELECT 1 FROM trx_bill_movement m WHERE m.bill_id = b.id AND m.seq = 1 AND m.note LIKE 'Carried over%')
   AND NOT EXISTS (SELECT 1 FROM trx_bill_movement m WHERE m.bill_id = b.id AND m.seq >= 4);

-- current holder = latest movement
UPDATE trx_bill_tracker b
  JOIN trx_bill_movement m ON m.bill_id = b.id AND m.seq = (SELECT MAX(x.seq) FROM trx_bill_movement x WHERE x.bill_id = b.id)
   SET b.holder_name = m.to_holder, b.holder_user_id = m.to_user_id, b.holder_dept = m.to_dept, b.holder_location = m.to_location,
       b.holder_since = m.moved_at, b.holder_expected_back = m.expected_return_date
 WHERE b.holder_since IS NULL;

-- ------------------------------------------------------------ matching results
CREATE TABLE IF NOT EXISTS trx_bill_match_result (
  id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  company_id           BIGINT UNSIGNED NOT NULL,
  bill_id              BIGINT UNSIGNED NOT NULL,
  run_no               INT UNSIGNED NOT NULL,
  rule_code            VARCHAR(30) NOT NULL,
  link_id              BIGINT UNSIGNED NULL,
  label                VARCHAR(255) NOT NULL,
  severity             VARCHAR(10) NOT NULL COMMENT 'PASS / INFO / WARNING / BLOCKING',
  expected_value       VARCHAR(60) NULL,
  actual_value         VARCHAR(60) NULL,
  variance_value       VARCHAR(60) NULL,
  tolerance            VARCHAR(60) NULL,
  result_status        VARCHAR(12) NOT NULL DEFAULT 'OPEN' COMMENT 'OPEN / OVERRIDDEN / OK',
  override_reason      VARCHAR(255) NULL,
  overridden_by        BIGINT UNSIGNED NULL,
  overridden_at        DATETIME NULL,
  evaluated_by         BIGINT UNSIGNED NULL,
  evaluated_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_bmr_bill (bill_id, run_no)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Bill matching runs (history kept)';

-- ------------------------------------------------------------ approvals (decision history)
CREATE TABLE IF NOT EXISTS trx_bill_approval (
  id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  company_id           BIGINT UNSIGNED NOT NULL,
  bill_id              BIGINT UNSIGNED NOT NULL,
  stage                VARCHAR(14) NOT NULL COMMENT 'SUBMIT / VERIFY / APPROVE / RETURN / REJECT / HOLD / RELEASE / REOPEN / UNAPPROVE / DUPLICATE / OVERRIDE / CANCEL / REVERSE',
  decision             VARCHAR(14) NOT NULL,
  from_status          VARCHAR(24) NULL,
  to_status            VARCHAR(24) NULL,
  comments             VARCHAR(500) NULL,
  amount               DECIMAL(18,2) NULL,
  policy_version       VARCHAR(20) NOT NULL DEFAULT 'BT-145',
  actor_id             BIGINT UNSIGNED NULL,
  decided_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_bap_bill (bill_id),
  KEY ix_bap_company (company_id, decided_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Bill verification / approval decisions';

-- ------------------------------------------------------------ follow-ups / exceptions
CREATE TABLE IF NOT EXISTS trx_bill_followup (
  id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  company_id           BIGINT UNSIGNED NOT NULL,
  bill_id              BIGINT UNSIGNED NULL,
  inward_id            BIGINT UNSIGNED NULL,
  issue_type           VARCHAR(24) NOT NULL COMMENT 'MISSING_BILL / MISSING_DC / MISSING_GRN / MISMATCH / DUPLICATE / SUPPLIER_CLARIFICATION / APPROVAL_DELAY / POSTING_FAILURE / DATA_COMPLETION / OTHER',
  priority             VARCHAR(8) NOT NULL DEFAULT 'NORMAL' COMMENT 'LOW / NORMAL / HIGH / URGENT',
  owner_id             BIGINT UNSIGNED NULL,
  due_date             DATE NOT NULL,
  reason               VARCHAR(500) NOT NULL,
  notes                VARCHAR(1000) NULL,
  last_contact_date    DATE NULL,
  next_followup_date   DATE NULL,
  status               VARCHAR(10) NOT NULL DEFAULT 'OPEN' COMMENT 'OPEN / CLOSED / CANCELLED',
  resolution_note      VARCHAR(500) NULL,
  closed_by            BIGINT UNSIGNED NULL,
  closed_at            DATETIME NULL,
  row_version          INT UNSIGNED NOT NULL DEFAULT 1,
  created_by           BIGINT UNSIGNED NULL,
  created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by           BIGINT UNSIGNED NULL,
  updated_at           DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_bfu_bill (bill_id),
  KEY ix_bfu_inward (inward_id),
  KEY ix_bfu_open (company_id, status, due_date),
  KEY ix_bfu_owner (owner_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Bill / document follow-up tasks and exceptions';

-- ------------------------------------------------------------ accounting posting queue
CREATE TABLE IF NOT EXISTS trx_bill_posting (
  id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  company_id           BIGINT UNSIGNED NOT NULL,
  bill_id              BIGINT UNSIGNED NOT NULL,
  idempotency_key      VARCHAR(80) NOT NULL,
  adapter              VARCHAR(20) NOT NULL DEFAULT 'MANUAL',
  payload_version      INT UNSIGNED NOT NULL DEFAULT 1,
  payload_json         JSON NULL,
  payload_amount       DECIMAL(18,2) NULL,
  status               VARCHAR(16) NOT NULL DEFAULT 'QUEUED' COMMENT 'QUEUED / POSTING / POSTED / FAILED / UNKNOWN / RECON_REQUIRED / CANCELLED / REVERSED',
  attempts             INT UNSIGNED NOT NULL DEFAULT 0,
  next_attempt_at      DATETIME NULL,
  locked_at            DATETIME NULL,
  external_voucher_id  VARCHAR(80) NULL,
  external_voucher_no  VARCHAR(60) NULL,
  external_voucher_date DATE NULL,
  posted_at            DATETIME NULL,
  posted_by            BIGINT UNSIGNED NULL,
  response_code        VARCHAR(20) NULL,
  response_summary     VARCHAR(500) NULL,
  last_error_code      VARCHAR(40) NULL,
  last_error_summary   VARCHAR(500) NULL,
  reversal_voucher_no  VARCHAR(60) NULL,
  row_version          INT UNSIGNED NOT NULL DEFAULT 1,
  created_by           BIGINT UNSIGNED NULL,
  created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_bp_idem (idempotency_key),
  KEY ix_bp_bill (bill_id),
  KEY ix_bp_status (company_id, status, next_attempt_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Bill → accounting posting queue (history never deleted)';

CREATE TABLE IF NOT EXISTS trx_bill_posting_attempt (
  id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  posting_id           BIGINT UNSIGNED NOT NULL,
  attempt_no           INT UNSIGNED NOT NULL,
  action               VARCHAR(14) NOT NULL COMMENT 'QUEUE / SUBMIT / LOOKUP / MANUAL_POST / MARK_FAILED / RETRY / CANCEL / REVERSE',
  outcome              VARCHAR(16) NOT NULL,
  voucher_no           VARCHAR(60) NULL,
  error_code           VARCHAR(40) NULL,
  error_summary        VARCHAR(500) NULL,
  reason               VARCHAR(255) NULL,
  actor_id             BIGINT UNSIGNED NULL,
  at                   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_bpa_posting (posting_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Every posting attempt / manual action';

-- ------------------------------------------------------------ number series, settings
INSERT INTO cfg_number_series (company_id, branch_id, doc_type, fy_id, prefix, next_number, padding)
SELECT c.id, NULL, 'DOC_INWARD', NULL, 'DIN-', 1, 5 FROM mst_company c
 WHERE NOT EXISTS (SELECT 1 FROM cfg_number_series n WHERE n.company_id = c.id AND n.branch_id IS NULL AND n.fy_id IS NULL AND n.doc_type = 'DOC_INWARD');

INSERT IGNORE INTO cfg_system_setting (company_id, setting_key, setting_value, description)
SELECT id, 'BT_MAKER_CHECKER', '1', 'Bill tracker: the approver must be a different user from the one who entered the bill (1 = on)' FROM mst_company;
INSERT IGNORE INTO cfg_system_setting (company_id, setting_key, setting_value, description)
SELECT id, 'BT_POSTING_ADAPTER', 'MANUAL', 'Bill tracker: accounting posting adapter (MANUAL = accounts enters the voucher no; an API adapter needs the accounting package confirmed)' FROM mst_company;
INSERT IGNORE INTO cfg_system_setting (company_id, setting_key, setting_value, description)
SELECT id, 'BT_INWARD_DUE_DAYS', '2', 'Document inward: days to resolve an incomplete document (default due date)' FROM mst_company;

-- ------------------------------------------------------------ permissions
INSERT INTO mst_permission (module_id, permission_code, permission_name)
SELECT m.id, s.code, s.name FROM mst_module m
  JOIN (SELECT 'BILL_TRACKER.VERIFY' code, 'Bill tracker: verify bills, return for correction' name
        UNION ALL SELECT 'BILL_TRACKER.APPROVE', 'Bill tracker: approve bills, override mismatches, clear duplicates'
        UNION ALL SELECT 'BILL_TRACKER.APPROVE_HIGH', 'Bill tracker: approve bills above the category value limit'
        UNION ALL SELECT 'BILL_TRACKER.POST', 'Bill tracker: accounting posting (queue, mark posted, retry, reverse)'
        UNION ALL SELECT 'BILL_TRACKER.CONFIG', 'Bill tracker: categories, required documents, tolerances') s
 WHERE m.module_code = 'FINANCE' AND NOT EXISTS (SELECT 1 FROM mst_permission x WHERE x.permission_code = s.code);
-- one time: accounts (FINANCE.UPDATE) verify + post; the company ADMIN role gets everything
INSERT INTO map_role_permission (role_id, permission_id)
SELECT DISTINCT mrp.role_id, p.id FROM map_role_permission mrp
  JOIN mst_role r ON r.id = mrp.role_id
  JOIN mst_permission src ON src.id = mrp.permission_id AND src.permission_code = 'FINANCE.UPDATE'
  JOIN mst_permission p ON p.permission_code IN ('BILL_TRACKER.VERIFY', 'BILL_TRACKER.POST')
 WHERE NOT EXISTS (SELECT 1 FROM cfg_system_setting g WHERE g.company_id = r.company_id AND g.setting_key = 'BT145_BACKFILLED')
   AND NOT EXISTS (SELECT 1 FROM map_role_permission m WHERE m.role_id = mrp.role_id AND m.permission_id = p.id);
INSERT INTO map_role_permission (role_id, permission_id)
SELECT r.id, p.id FROM mst_role r
  JOIN mst_permission p ON p.permission_code LIKE 'BILL\_TRACKER.%'
 WHERE r.role_code = 'ADMIN'
   AND NOT EXISTS (SELECT 1 FROM cfg_system_setting g WHERE g.company_id = r.company_id AND g.setting_key = 'BT145_BACKFILLED')
   AND NOT EXISTS (SELECT 1 FROM map_role_permission m WHERE m.role_id = r.id AND m.permission_id = p.id);

-- last: the one-time steps above are done for every company that exists now
INSERT IGNORE INTO cfg_system_setting (company_id, setting_key, setting_value, description)
SELECT id, 'BT145_BACKFILLED', '1', 'Migration 145 one-time steps done (bill workflow / category backfill, bill tracker permissions)' FROM mst_company;
