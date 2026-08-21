-- =====================================================================
-- 15. FINANCE / ACCOUNTS / GST / PAYMENTS / EXPORT INCENTIVES
-- =====================================================================

-- Chart of accounts (minimal ledger backbone)
CREATE TABLE mst_ledger_account (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  account_code    VARCHAR(30) NOT NULL,
  account_name    VARCHAR(150) NOT NULL,
  account_group   ENUM('ASSET','LIABILITY','INCOME','EXPENSE','EQUITY') NOT NULL,
  parent_id       BIGINT UNSIGNED,
  is_bank         TINYINT(1) NOT NULL DEFAULT 0,
  is_active       TINYINT(1) NOT NULL DEFAULT 1,
  UNIQUE KEY uq_ledacc (company_id,account_code),
  CONSTRAINT fk_ledacc__company FOREIGN KEY (company_id) REFERENCES mst_company(id),
  CONSTRAINT fk_ledacc__parent  FOREIGN KEY (parent_id)  REFERENCES mst_ledger_account(id)
) ENGINE=InnoDB COMMENT='Chart of accounts';

-- GST / HSN tax rate master (multi-rate)
CREATE TABLE cfg_tax_rate (
  id              INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  hsn_code        VARCHAR(10) NOT NULL,
  description     VARCHAR(150),
  igst_pct        DECIMAL(5,2) NOT NULL DEFAULT 0,
  cgst_pct        DECIMAL(5,2) NOT NULL DEFAULT 0,
  sgst_pct        DECIMAL(5,2) NOT NULL DEFAULT 0,
  cess_pct        DECIMAL(5,2) NOT NULL DEFAULT 0,
  effective_from  DATE,
  effective_to    DATE,
  is_active       TINYINT(1) NOT NULL DEFAULT 1,
  KEY ix_taxrate_hsn (company_id,hsn_code),
  CONSTRAINT fk_taxrate__company FOREIGN KEY (company_id) REFERENCES mst_company(id)
) ENGINE=InnoDB COMMENT='HSN-wise GST rate master';

-- Voucher header (JV / receipt / payment / contra)
CREATE TABLE trx_voucher (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  branch_id       BIGINT UNSIGNED,
  voucher_no      VARCHAR(40) NOT NULL,
  voucher_date    DATE NOT NULL,
  voucher_type    ENUM('JOURNAL','RECEIPT','PAYMENT','CONTRA','SALES','PURCHASE','DEBIT_NOTE','CREDIT_NOTE') NOT NULL,
  narration       VARCHAR(500),
  ref_type        VARCHAR(40),
  ref_id          BIGINT UNSIGNED,
  currency_id     SMALLINT UNSIGNED,
  exchange_rate   DECIMAL(18,6) DEFAULT 1,
  total_debit     DECIMAL(18,2) DEFAULT 0,
  total_credit    DECIMAL(18,2) DEFAULT 0,
  fy_id           INT UNSIGNED,
  is_posted       TINYINT(1) NOT NULL DEFAULT 0,
  created_by      BIGINT UNSIGNED,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_voucher (company_id,voucher_no),
  KEY ix_voucher_ref (ref_type,ref_id),
  CONSTRAINT fk_vou__company FOREIGN KEY (company_id) REFERENCES mst_company(id),
  CONSTRAINT fk_vou__branch  FOREIGN KEY (branch_id)  REFERENCES mst_branch(id),
  CONSTRAINT fk_vou__cur     FOREIGN KEY (currency_id) REFERENCES cfg_currency(id),
  CONSTRAINT fk_vou__fy      FOREIGN KEY (fy_id)      REFERENCES mst_financial_year(id)
) ENGINE=InnoDB COMMENT='Accounting voucher header';

-- Voucher lines (double-entry postings)
CREATE TABLE trx_voucher_line (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  voucher_id      BIGINT UNSIGNED NOT NULL,
  account_id      BIGINT UNSIGNED NOT NULL,
  party_id        BIGINT UNSIGNED,        -- optional sub-ledger
  debit           DECIMAL(18,2) NOT NULL DEFAULT 0,
  credit          DECIMAL(18,2) NOT NULL DEFAULT 0,
  narration       VARCHAR(255),
  CONSTRAINT fk_voul__voucher FOREIGN KEY (voucher_id) REFERENCES trx_voucher(id),
  CONSTRAINT fk_voul__account FOREIGN KEY (account_id) REFERENCES mst_ledger_account(id),
  CONSTRAINT fk_voul__party   FOREIGN KEY (party_id)   REFERENCES mst_party(id)
) ENGINE=InnoDB COMMENT='Voucher lines (Dr/Cr postings)';

-- Sales / export invoice tax breakup (GST output)
CREATE TABLE trx_invoice_tax (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  invoice_id      BIGINT UNSIGNED NOT NULL,   -- trx_commercial_invoice
  hsn_code        VARCHAR(10),
  taxable_value   DECIMAL(18,2) NOT NULL DEFAULT 0,
  igst_pct        DECIMAL(5,2) DEFAULT 0,
  igst_amount     DECIMAL(18,2) DEFAULT 0,
  cgst_amount     DECIMAL(18,2) DEFAULT 0,
  sgst_amount     DECIMAL(18,2) DEFAULT 0,
  is_export_lut   TINYINT(1) NOT NULL DEFAULT 1,  -- export under LUT (0% GST)
  gstr_reference  VARCHAR(40),
  CONSTRAINT fk_invtax__ci FOREIGN KEY (invoice_id) REFERENCES trx_commercial_invoice(id)
) ENGINE=InnoDB COMMENT='Invoice-level GST breakup (HSN-wise)';

-- Customer receipts (against export invoices) incl. TT/LC realization
CREATE TABLE trx_receipt (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  receipt_no      VARCHAR(40) NOT NULL,
  receipt_date    DATE NOT NULL,
  buyer_id        BIGINT UNSIGNED NOT NULL,
  mode            ENUM('TT','LC','ADVANCE','CHEQUE','ONLINE','OTHER') NOT NULL DEFAULT 'TT',
  currency_id     SMALLINT UNSIGNED NOT NULL,
  exchange_rate   DECIMAL(18,6) DEFAULT 1,
  amount_fc       DECIMAL(18,2) NOT NULL,     -- foreign currency
  amount_inr      DECIMAL(18,2) NOT NULL,     -- realized INR
  bank_ref        VARCHAR(60),
  brc_no          VARCHAR(60),                -- bank realization certificate
  is_advance      TINYINT(1) NOT NULL DEFAULT 0,
  voucher_id      BIGINT UNSIGNED,
  remarks         VARCHAR(500),
  created_by      BIGINT UNSIGNED,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_receipt (company_id,receipt_no),
  CONSTRAINT fk_rcpt__company FOREIGN KEY (company_id)  REFERENCES mst_company(id),
  CONSTRAINT fk_rcpt__buyer   FOREIGN KEY (buyer_id)    REFERENCES mst_party(id),
  CONSTRAINT fk_rcpt__cur     FOREIGN KEY (currency_id) REFERENCES cfg_currency(id),
  CONSTRAINT fk_rcpt__voucher FOREIGN KEY (voucher_id)  REFERENCES trx_voucher(id)
) ENGINE=InnoDB COMMENT='Customer receipts / realization';

-- Receipt allocation against invoices (many-to-many settlement)
CREATE TABLE map_receipt_invoice (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  receipt_id      BIGINT UNSIGNED NOT NULL,
  invoice_id      BIGINT UNSIGNED NOT NULL,
  allocated_fc    DECIMAL(18,2) NOT NULL,
  allocated_inr   DECIMAL(18,2) NOT NULL,
  UNIQUE KEY uq_rcpt_inv (receipt_id,invoice_id),
  CONSTRAINT fk_ri__receipt FOREIGN KEY (receipt_id) REFERENCES trx_receipt(id),
  CONSTRAINT fk_ri__invoice FOREIGN KEY (invoice_id) REFERENCES trx_commercial_invoice(id)
) ENGINE=InnoDB COMMENT='Receipt→Invoice settlement';

-- Supplier payments (against purchase / GRN / jobwork)
CREATE TABLE trx_payment (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  payment_no      VARCHAR(40) NOT NULL,
  payment_date    DATE NOT NULL,
  supplier_id     BIGINT UNSIGNED NOT NULL,
  mode            ENUM('NEFT','RTGS','CHEQUE','CASH','LC','ONLINE') NOT NULL DEFAULT 'NEFT',
  currency_id     SMALLINT UNSIGNED NOT NULL,
  amount          DECIMAL(18,2) NOT NULL,
  bank_ref        VARCHAR(60),
  voucher_id      BIGINT UNSIGNED,
  remarks         VARCHAR(500),
  created_by      BIGINT UNSIGNED,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_payment (company_id,payment_no),
  CONSTRAINT fk_pay__company FOREIGN KEY (company_id)  REFERENCES mst_company(id),
  CONSTRAINT fk_pay__supplier FOREIGN KEY (supplier_id) REFERENCES mst_party(id),
  CONSTRAINT fk_pay__cur     FOREIGN KEY (currency_id) REFERENCES cfg_currency(id),
  CONSTRAINT fk_pay__voucher FOREIGN KEY (voucher_id)  REFERENCES trx_voucher(id)
) ENGINE=InnoDB COMMENT='Supplier / vendor payments';

-- Export incentives tracking (drawback / RoDTEP / others)
CREATE TABLE trx_export_incentive (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  incentive_type  ENUM('DUTY_DRAWBACK','RODTEP','ROSCTL','GST_REFUND','INTEREST_EQUAL','OTHER') NOT NULL,
  shipping_bill_id BIGINT UNSIGNED,
  invoice_id      BIGINT UNSIGNED,
  scrip_no        VARCHAR(60),                -- for scrip-based schemes
  claim_amount    DECIMAL(18,2) DEFAULT 0,
  received_amount DECIMAL(18,2) DEFAULT 0,
  claim_date      DATE,
  credit_date     DATE,
  status          ENUM('PENDING','CLAIMED','CREDITED','REJECTED') DEFAULT 'PENDING',
  remarks         VARCHAR(500),
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_incentive_type (company_id,incentive_type),
  CONSTRAINT fk_incv__company FOREIGN KEY (company_id)       REFERENCES mst_company(id),
  CONSTRAINT fk_incv__sb      FOREIGN KEY (shipping_bill_id) REFERENCES trx_shipping_bill(id),
  CONSTRAINT fk_incv__ci      FOREIGN KEY (invoice_id)       REFERENCES trx_commercial_invoice(id)
) ENGINE=InnoDB COMMENT='Export incentive claims (drawback/RoDTEP)';
