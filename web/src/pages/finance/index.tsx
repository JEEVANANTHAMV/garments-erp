import { CrudPage } from '../../components/CrudPage';
import { StatusBadge, Badge } from '../../components/ui';
import { fmtDate, fmtDecimal, humanize, today } from '../../lib/format';

const VOUCHER_TYPES = ['JOURNAL','PAYMENT','RECEIPT','CONTRA','SALES','PURCHASE','DEBIT_NOTE','CREDIT_NOTE'];
const ACCOUNT_TYPES = ['ASSET','LIABILITY','EQUITY','INCOME','EXPENSE','BANK','CASH'];

/* ---------------------------------------------------------------- Vouchers */
export function VouchersPage() {
  return <CrudPage
    path="vouchers" title="Journal Vouchers" permission="FINANCE" singular="Voucher"
    subtitle="General ledger journal entries"
    defaultSort={{ key: 'voucher_date', dir: 'desc' }}
    columns={[
      { key: 'voucher_no', header: 'Voucher no', sortable: true,
        render: (r: any) => <span className="font-mono text-[12px] font-medium text-brand-700">{r.voucher_no}</span> },
      { key: 'voucher_type', header: 'Type', render: (r: any) => <Badge tone="blue">{humanize(r.voucher_type)}</Badge> },
      { key: 'voucher_date', header: 'Date', sortable: true, render: (r: any) => fmtDate(r.voucher_date) },
      { key: 'narration', header: 'Narration' },
      { key: 'total_debit', header: 'Debit', align: 'right', render: (r: any) => fmtDecimal(r.total_debit) },
      { key: 'total_credit', header: 'Credit', align: 'right', render: (r: any) => fmtDecimal(r.total_credit) },
      { key: 'status_label', header: 'Status', render: (r: any) => <StatusBadge value={r.status_label} /> },
    ]}
    filters={[
      { name: 'voucher_type', label: 'Voucher type', options: VOUCHER_TYPES.map((v) => ({ value: v, label: humanize(v) })) },
      { name: 'status_id', label: 'Status', statusDomain: 'VOUCHER' },
    ]}
    fields={[
      { name: 'voucher_no', label: 'Voucher no', hint: 'Blank to auto-generate' },
      { name: 'voucher_type', label: 'Voucher type', required: true,
        options: VOUCHER_TYPES.map((v) => ({ value: v, label: humanize(v) })), defaultValue: 'JOURNAL' },
      { name: 'voucher_date', label: 'Voucher date', type: 'date', required: true, defaultValue: today() },
      { name: 'currency_id', label: 'Currency', lookup: 'currencies' },
      { name: 'exchange_rate', label: 'Exchange rate', type: 'number', defaultValue: 1 },
      { name: 'narration', label: 'Narration', type: 'textarea', span: 2 },
      { name: 'status_id', label: 'Status', statusDomain: 'VOUCHER' },
    ]} />;
}

/* ------------------------------------------------------------ Receipts */
export function ReceiptsPage() {
  return <CrudPage
    path="receipts" title="Receipts" permission="FINANCE" singular="Receipt"
    subtitle="Money received from buyers and other parties"
    defaultSort={{ key: 'receipt_date', dir: 'desc' }}
    columns={[
      { key: 'receipt_no', header: 'Receipt no', sortable: true,
        render: (r: any) => <span className="font-mono text-[12px] font-medium text-brand-700">{r.receipt_no}</span> },
      { key: 'receipt_date', header: 'Date', sortable: true, render: (r: any) => fmtDate(r.receipt_date) },
      { key: 'party_name', header: 'Party' },
      { key: 'mode', header: 'Mode', render: (r: any) => <Badge tone="green">{humanize(r.mode)}</Badge> },
      { key: 'amount', header: 'Amount', align: 'right',
        render: (r: any) => `${r.currency_code ?? ''} ${fmtDecimal(r.amount, 2)}` },
      { key: 'bank_ref', header: 'Bank ref' },
    ]}
    filters={[
      { name: 'party_id', label: 'Party', lookup: 'parties' },
      { name: 'mode', label: 'Mode', options: ['BANK_TRANSFER','CASH','CHEQUE','LC_REALISATION','DD','NEFT','RTGS'].map((v) => ({ value: v, label: humanize(v) })) },
    ]}
    fields={[
      { name: 'receipt_no', label: 'Receipt no', hint: 'Blank to auto-generate' },
      { name: 'receipt_date', label: 'Receipt date', type: 'date', required: true, defaultValue: today() },
      { name: 'party_id', label: 'Party', required: true, lookup: 'parties' },
      { name: 'mode', label: 'Payment mode', required: true,
        options: ['BANK_TRANSFER','CASH','CHEQUE','LC_REALISATION','DD','NEFT','RTGS'].map((v) => ({ value: v, label: humanize(v) })) },
      { name: 'amount', label: 'Amount', type: 'number', required: true },
      { name: 'currency_id', label: 'Currency', lookup: 'currencies' },
      { name: 'exchange_rate', label: 'Exchange rate', type: 'number', defaultValue: 1 },
      { name: 'bank_account_id', label: 'Bank account', lookup: 'bank-accounts' },
      { name: 'bank_ref', label: 'Bank reference' },
      { name: 'invoice_id', label: 'Against invoice', lookup: 'export-invoices' },
      { name: 'narration', label: 'Narration', type: 'textarea', span: 2 },
    ]} />;
}

/* ------------------------------------------------------------ Payments */
export function PaymentsPage() {
  return <CrudPage
    path="payments" title="Payments" permission="FINANCE" singular="Payment"
    subtitle="Outgoing payments to suppliers and vendors"
    defaultSort={{ key: 'payment_date', dir: 'desc' }}
    columns={[
      { key: 'payment_no', header: 'Payment no', sortable: true,
        render: (r: any) => <span className="font-mono text-[12px] font-medium text-brand-700">{r.payment_no}</span> },
      { key: 'payment_date', header: 'Date', sortable: true, render: (r: any) => fmtDate(r.payment_date) },
      { key: 'party_name', header: 'Party' },
      { key: 'mode', header: 'Mode', render: (r: any) => <Badge tone="amber">{humanize(r.mode)}</Badge> },
      { key: 'amount', header: 'Amount', align: 'right',
        render: (r: any) => `${r.currency_code ?? ''} ${fmtDecimal(r.amount, 2)}` },
      { key: 'bank_ref', header: 'Bank ref' },
    ]}
    filters={[
      { name: 'party_id', label: 'Party', lookup: 'parties' },
      { name: 'mode', label: 'Mode', options: ['BANK_TRANSFER','CASH','CHEQUE','DD','NEFT','RTGS'].map((v) => ({ value: v, label: humanize(v) })) },
    ]}
    fields={[
      { name: 'payment_no', label: 'Payment no', hint: 'Blank to auto-generate' },
      { name: 'payment_date', label: 'Payment date', type: 'date', required: true, defaultValue: today() },
      { name: 'party_id', label: 'Party', required: true, lookup: 'parties' },
      { name: 'mode', label: 'Payment mode', required: true,
        options: ['BANK_TRANSFER','CASH','CHEQUE','DD','NEFT','RTGS'].map((v) => ({ value: v, label: humanize(v) })) },
      { name: 'amount', label: 'Amount', type: 'number', required: true },
      { name: 'currency_id', label: 'Currency', lookup: 'currencies' },
      { name: 'bank_account_id', label: 'Bank account', lookup: 'bank-accounts' },
      { name: 'bank_ref', label: 'Bank reference' },
      { name: 'po_id', label: 'Against purchase order', lookup: 'purchase-orders' },
      { name: 'narration', label: 'Narration', type: 'textarea', span: 2 },
    ]} />;
}

/* -------------------------------------------------- Export incentives */
export function IncentivesPage() {
  return <CrudPage
    path="export-incentives" title="Export Incentives" permission="FINANCE" singular="Incentive"
    subtitle="RoDTEP, MEIS, drawback claims"
    defaultSort={{ key: 'claim_date', dir: 'desc' }}
    columns={[
      { key: 'incentive_no', header: 'Claim no', sortable: true,
        render: (r: any) => <span className="font-mono text-[12px] font-medium text-brand-700">{r.incentive_no}</span> },
      { key: 'incentive_type', header: 'Type', render: (r: any) => <Badge tone="emerald">{r.incentive_type}</Badge> },
      { key: 'sb_no', header: 'Shipping bill' },
      { key: 'claim_date', header: 'Claim date', sortable: true, render: (r: any) => fmtDate(r.claim_date) },
      { key: 'claim_amount', header: 'Claim amount', align: 'right', render: (r: any) => fmtDecimal(r.claim_amount, 2) },
      { key: 'realized_amount', header: 'Realised', align: 'right', render: (r: any) => fmtDecimal(r.realized_amount, 2) },
      { key: 'status_label', header: 'Status', render: (r: any) => <StatusBadge value={r.status_label} /> },
    ]}
    filters={[
      { name: 'incentive_type', label: 'Incentive type',
        options: ['RODTEP','MEIS','DRAWBACK','DBK','ROSCTL'].map((v) => ({ value: v, label: v })) },
    ]}
    fields={[
      { name: 'incentive_no', label: 'Claim no', hint: 'Blank to auto-generate' },
      { name: 'incentive_type', label: 'Incentive type', required: true,
        options: ['RODTEP','MEIS','DRAWBACK','DBK','ROSCTL'].map((v) => ({ value: v, label: v })) },
      { name: 'sb_id', label: 'Shipping bill', lookup: 'shipping-bills' },
      { name: 'claim_date', label: 'Claim date', type: 'date', defaultValue: today() },
      { name: 'claim_amount', label: 'Claim amount', type: 'number' },
      { name: 'realized_amount', label: 'Realised amount', type: 'number' },
      { name: 'realized_date', label: 'Realised date', type: 'date' },
      { name: 'status_id', label: 'Status', statusDomain: 'INCENTIVE' },
      { name: 'remarks', label: 'Remarks', type: 'textarea' },
    ]} />;
}

/* ----------------------------------------------- Ledger accounts */
export function LedgerAccountsPage() {
  return <CrudPage
    path="ledger-accounts" title="Ledger Accounts" permission="FINANCE" singular="Account"
    subtitle="Chart of accounts"
    defaultSort={{ key: 'account_code', dir: 'asc' }}
    columns={[
      { key: 'account_code', header: 'Code', sortable: true,
        render: (r: any) => <span className="font-mono text-[12px] font-medium text-brand-700">{r.account_code}</span> },
      { key: 'account_name', header: 'Account name', sortable: true },
      { key: 'account_type', header: 'Type', render: (r: any) => <Badge tone="blue">{humanize(r.account_type)}</Badge> },
      { key: 'parent_name', header: 'Parent' },
      { key: 'is_active', header: 'Active', render: (r: any) => r.is_active ? '✓' : '—' },
    ]}
    filters={[
      { name: 'account_type', label: 'Account type', options: ACCOUNT_TYPES.map((v) => ({ value: v, label: humanize(v) })) },
    ]}
    fields={[
      { name: 'account_code', label: 'Account code', required: true },
      { name: 'account_name', label: 'Account name', required: true },
      { name: 'account_type', label: 'Account type', required: true,
        options: ACCOUNT_TYPES.map((v) => ({ value: v, label: humanize(v) })) },
      { name: 'parent_id', label: 'Parent account', lookup: 'ledger-accounts' },
      { name: 'opening_balance', label: 'Opening balance', type: 'number' },
      { name: 'is_active', label: 'Active', type: 'checkbox', defaultValue: 1 },
    ]} />;
}

/* ----------------------------------------------- Tax rates */
export function TaxRatesPage() {
  return <CrudPage
    path="tax-rates" title="Tax Rates" permission="FINANCE" singular="Tax Rate"
    subtitle="GST, customs duty and other tax rate definitions"
    defaultSort={{ key: 'tax_name', dir: 'asc' }}
    columns={[
      { key: 'tax_code', header: 'Code', sortable: true,
        render: (r: any) => <span className="font-mono text-[12px] text-brand-700">{r.tax_code}</span> },
      { key: 'tax_name', header: 'Tax name', sortable: true },
      { key: 'tax_type', header: 'Type', render: (r: any) => <Badge tone="violet">{r.tax_type}</Badge> },
      { key: 'rate_pct', header: 'Rate %', align: 'right',
        render: (r: any) => <span className="font-medium tabular-nums">{fmtDecimal(r.rate_pct, 2)}%</span> },
      { key: 'is_active', header: 'Active', render: (r: any) => r.is_active ? '✓' : '—' },
    ]}
    filters={[
      { name: 'tax_type', label: 'Tax type', options: ['GST','IGST','SGST','CGST','CUSTOMS','TDS','TCS'].map((v) => ({ value: v, label: v })) },
    ]}
    fields={[
      { name: 'tax_code', label: 'Tax code', required: true },
      { name: 'tax_name', label: 'Tax name', required: true },
      { name: 'tax_type', label: 'Tax type', required: true,
        options: ['GST','IGST','SGST','CGST','CUSTOMS','TDS','TCS'].map((v) => ({ value: v, label: v })) },
      { name: 'rate_pct', label: 'Rate (%)', type: 'number', required: true },
      { name: 'applicable_from', label: 'Applicable from', type: 'date' },
      { name: 'applicable_to', label: 'Applicable to', type: 'date' },
      { name: 'is_active', label: 'Active', type: 'checkbox', defaultValue: 1 },
    ]} />;
}
