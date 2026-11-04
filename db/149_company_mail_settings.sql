-- =====================================================================
-- 149 · Purchase order PDF + e-mail to supplier (client voice notes 04-Nov-2026)
--   "When we raise a PO, click Mail → it converts to PDF and the mail goes to the supplier."
--   cfg_company_mail       one row per company: its own SMTP server (host / port / TLS / login), the sender
--                          name + address, reply-to, default CC and the PO mail subject / body templates
--                          ({PO_NO}, {SUPPLIER}, {COMPANY}, {PO_DATE}). The SMTP password is stored encrypted
--                          (AES-256-GCM, key from the server secret) and is never returned by the API.
--   trx_document_mail_log  every send attempt of a document (PO now; any doc type later): to / cc / subject,
--                          SENT or FAILED with the SMTP error, message id, who sent it and when.
-- Idempotent: the runner re-applies files >= 10 on every deploy.
-- =====================================================================
CREATE TABLE IF NOT EXISTS cfg_company_mail (
  id                 BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  company_id         BIGINT UNSIGNED NOT NULL,
  smtp_host          VARCHAR(200) NULL,
  smtp_port          INT NOT NULL DEFAULT 587,
  smtp_secure        TINYINT(1) NOT NULL DEFAULT 0,   -- 1 = implicit TLS (port 465); 0 = STARTTLS when offered (587)
  smtp_username      VARCHAR(200) NULL,
  smtp_password_enc  TEXT NULL,                       -- iv:tag:ciphertext (base64), AES-256-GCM
  from_name          VARCHAR(150) NULL,
  from_email         VARCHAR(200) NULL,
  reply_to           VARCHAR(200) NULL,
  default_cc         VARCHAR(1000) NULL,              -- comma separated
  po_subject_tpl     VARCHAR(300) NULL,
  po_body_tpl        TEXT NULL,
  is_active          TINYINT(1) NOT NULL DEFAULT 1,
  updated_by         BIGINT UNSIGNED NULL,
  created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY ux_company_mail (company_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS trx_document_mail_log (
  id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  company_id     BIGINT UNSIGNED NOT NULL,
  doc_type       VARCHAR(30) NOT NULL,                -- YARN_PO / FABRIC_PO / TRIM_PO / GENERAL_PO
  doc_id         BIGINT UNSIGNED NOT NULL,
  doc_no         VARCHAR(60) NULL,
  to_emails      VARCHAR(2000) NOT NULL,
  cc_emails      VARCHAR(2000) NULL,
  subject        VARCHAR(300) NOT NULL,
  attachment     VARCHAR(150) NULL,
  status         ENUM('SENT','FAILED') NOT NULL,
  error_message  VARCHAR(1000) NULL,
  message_id     VARCHAR(300) NULL,
  sent_by        BIGINT UNSIGNED NULL,
  sent_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_dml_doc (company_id, doc_type, doc_id, sent_at),
  KEY ix_dml_company_date (company_id, sent_at)
) ENGINE=InnoDB;
