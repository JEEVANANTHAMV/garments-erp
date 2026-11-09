import { query, queryOne, execute } from '../../config/db.js';

/**
 * Default accounts setup for a company — the one source of truth (migration 157 only creates tables).
 * Idempotent: INSERT IGNORE on the business keys, so a renamed / remapped / deactivated row is never overwritten.
 * Runs lazily on the first accounts request of each company (incl. companies created later).
 */

/** The 28 TallyPrime predefined groups: [code, name, nature, affects gross profit, sort, parent code]. */
export const DEFAULT_GROUPS: [string, string, 'ASSET' | 'LIABILITY' | 'INCOME' | 'EXPENSE', 0 | 1, number, string | null][] = [
  ['CAPITAL', 'Capital Account', 'LIABILITY', 0, 10, null],
  ['RESERVES', 'Reserves & Surplus', 'LIABILITY', 0, 11, 'CAPITAL'],
  ['LOANS_LIAB', 'Loans (Liability)', 'LIABILITY', 0, 20, null],
  ['SECURED_LOANS', 'Secured Loans', 'LIABILITY', 0, 21, 'LOANS_LIAB'],
  ['UNSECURED_LOANS', 'Unsecured Loans', 'LIABILITY', 0, 22, 'LOANS_LIAB'],
  ['BANK_OD', 'Bank OD A/c', 'LIABILITY', 0, 23, 'LOANS_LIAB'],
  ['CURR_LIAB', 'Current Liabilities', 'LIABILITY', 0, 30, null],
  ['DUTIES_TAXES', 'Duties & Taxes', 'LIABILITY', 0, 31, 'CURR_LIAB'],
  ['PROVISIONS', 'Provisions', 'LIABILITY', 0, 32, 'CURR_LIAB'],
  ['SUNDRY_CREDITORS', 'Sundry Creditors', 'LIABILITY', 0, 33, 'CURR_LIAB'],
  ['SUSPENSE', 'Suspense A/c', 'LIABILITY', 0, 40, null],
  ['BRANCH', 'Branch / Divisions', 'LIABILITY', 0, 45, null],
  ['FIXED_ASSETS', 'Fixed Assets', 'ASSET', 0, 50, null],
  ['INVESTMENTS', 'Investments', 'ASSET', 0, 60, null],
  ['CURR_ASSETS', 'Current Assets', 'ASSET', 0, 70, null],
  ['BANK_ACCOUNTS', 'Bank Accounts', 'ASSET', 0, 71, 'CURR_ASSETS'],
  ['CASH_IN_HAND', 'Cash-in-Hand', 'ASSET', 0, 72, 'CURR_ASSETS'],
  ['DEPOSITS', 'Deposits (Asset)', 'ASSET', 0, 73, 'CURR_ASSETS'],
  ['LOANS_ADV', 'Loans & Advances (Asset)', 'ASSET', 0, 74, 'CURR_ASSETS'],
  ['STOCK_IN_HAND', 'Stock-in-Hand', 'ASSET', 0, 75, 'CURR_ASSETS'],
  ['SUNDRY_DEBTORS', 'Sundry Debtors', 'ASSET', 0, 76, 'CURR_ASSETS'],
  ['MISC_EXP_ASSET', 'Misc. Expenses (ASSET)', 'ASSET', 0, 80, null],
  ['SALES', 'Sales Accounts', 'INCOME', 1, 100, null],
  ['DIRECT_INCOME', 'Direct Incomes', 'INCOME', 1, 110, null],
  ['INDIRECT_INCOME', 'Indirect Incomes', 'INCOME', 0, 120, null],
  ['PURCHASE', 'Purchase Accounts', 'EXPENSE', 1, 200, null],
  ['DIRECT_EXP', 'Direct Expenses', 'EXPENSE', 1, 210, null],
  ['INDIRECT_EXP', 'Indirect Expenses', 'EXPENSE', 0, 220, null],
];

export const DEFAULT_VOUCHER_TYPES: [string, string, string, string][] = [
  ['JOURNAL', 'Journal', 'JV', 'Journal'],
  ['PAYMENT', 'Payment', 'PV', 'Payment'],
  ['RECEIPT', 'Receipt', 'RV', 'Receipt'],
  ['CONTRA', 'Contra', 'CV', 'Contra'],
  ['SALES', 'Sales', 'SV', 'Sales'],
  ['PURCHASE', 'Purchase', 'PUV', 'Purchase'],
  ['DEBIT_NOTE', 'Debit Note', 'DN', 'Debit Note'],
  ['CREDIT_NOTE', 'Credit Note', 'CN', 'Credit Note'],
];

/** System ledgers: [code, name, group, type, control, cost-centre/job on, tax kind, tax direction, posting role]. */
type L = [string, string, string, string, 0 | 1, 0 | 1, string | null, string | null, string | null];
export const DEFAULT_LEDGERS: L[] = [
  ['CASH', 'Cash', 'CASH_IN_HAND', 'CASH', 0, 0, null, null, 'CASH'],
  ['PUR-YARN', 'Purchase - Yarn', 'PURCHASE', 'GENERAL', 0, 1, null, null, 'PURCHASE_YARN'],
  ['PUR-FABRIC', 'Purchase - Fabric', 'PURCHASE', 'GENERAL', 0, 1, null, null, 'PURCHASE_FABRIC'],
  ['PUR-TRIMS', 'Purchase - Trims & Accessories', 'PURCHASE', 'GENERAL', 0, 1, null, null, 'PURCHASE_TRIMS'],
  ['PUR-GENERAL', 'Purchase - General / Consumables', 'PURCHASE', 'GENERAL', 0, 1, null, null, 'PURCHASE_GENERAL'],
  ['PUR-RETURN', 'Purchase Returns', 'PURCHASE', 'GENERAL', 0, 1, null, null, 'PURCHASE_RETURN'],
  ['JW-KNITTING', 'Knitting Charges', 'DIRECT_EXP', 'GENERAL', 0, 1, null, null, 'JOBWORK_KNITTING'],
  ['JW-FABPROC', 'Dyeing & Fabric Processing Charges', 'DIRECT_EXP', 'GENERAL', 0, 1, null, null, 'JOBWORK_FABRIC_PROCESS'],
  ['JW-YARNPROC', 'Yarn Processing Charges', 'DIRECT_EXP', 'GENERAL', 0, 1, null, null, 'JOBWORK_YARN_PROCESS'],
  ['JW-STITCH', 'Stitching / Contract Labour Charges', 'DIRECT_EXP', 'GENERAL', 0, 1, null, null, 'JOBWORK_STITCHING'],
  ['JW-OTHER', 'Other Job Work Charges', 'DIRECT_EXP', 'GENERAL', 0, 1, null, null, 'JOBWORK_OTHER'],
  ['JW-DEDUCT', 'Job Work Deductions & Recoveries', 'DIRECT_EXP', 'GENERAL', 0, 1, null, null, 'JOBWORK_DEDUCTION'],
  ['FREIGHT-IN', 'Freight & Landed Charges Inward', 'DIRECT_EXP', 'GENERAL', 0, 1, null, null, 'FREIGHT_INWARD'],
  ['PUR-OTHER-CHG', 'Other Purchase Charges', 'DIRECT_EXP', 'GENERAL', 0, 1, null, null, 'PURCHASE_OTHER_CHARGES'],
  ['SALES-EXPORT', 'Export Sales', 'SALES', 'GENERAL', 0, 1, null, null, 'SALES_EXPORT'],
  ['SALES-DOMESTIC', 'Domestic Sales', 'SALES', 'GENERAL', 0, 1, null, null, 'SALES_DOMESTIC'],
  ['EXPORT-INCENTIVE', 'Export Incentives (Drawback / RoDTEP)', 'DIRECT_INCOME', 'GENERAL', 0, 0, null, null, 'EXPORT_INCENTIVE_INCOME'],
  ['FX-GAINLOSS', 'Exchange Gain / Loss', 'INDIRECT_INCOME', 'GENERAL', 0, 0, null, null, 'FX_GAIN_LOSS'],
  ['BANK-CHARGES', 'Bank Charges', 'INDIRECT_EXP', 'GENERAL', 0, 0, null, null, 'BANK_CHARGES'],
  ['ROUND-OFF', 'Round Off', 'INDIRECT_EXP', 'GENERAL', 1, 0, null, null, 'ROUND_OFF'],
  ['IN-CGST', 'Input CGST', 'DUTIES_TAXES', 'TAX', 1, 0, 'CGST', 'IN', 'INPUT_CGST'],
  ['IN-SGST', 'Input SGST', 'DUTIES_TAXES', 'TAX', 1, 0, 'SGST', 'IN', 'INPUT_SGST'],
  ['IN-IGST', 'Input IGST', 'DUTIES_TAXES', 'TAX', 1, 0, 'IGST', 'IN', 'INPUT_IGST'],
  ['OUT-CGST', 'Output CGST', 'DUTIES_TAXES', 'TAX', 1, 0, 'CGST', 'OUT', 'OUTPUT_CGST'],
  ['OUT-SGST', 'Output SGST', 'DUTIES_TAXES', 'TAX', 1, 0, 'SGST', 'OUT', 'OUTPUT_SGST'],
  ['OUT-IGST', 'Output IGST', 'DUTIES_TAXES', 'TAX', 1, 0, 'IGST', 'OUT', 'OUTPUT_IGST'],
  ['TDS-PAYABLE', 'TDS Payable', 'DUTIES_TAXES', 'TAX', 1, 0, 'TDS', 'OUT', 'TDS_PAYABLE'],
  ['TCS-RECV', 'TCS Receivable', 'LOANS_ADV', 'TAX', 1, 0, 'TCS', 'IN', 'TCS_RECEIVABLE'],
  ['IGST-REFUND', 'IGST Refund Receivable (Exports)', 'LOANS_ADV', 'GENERAL', 1, 0, null, null, 'IGST_REFUND_RECEIVABLE'],
  ['OPENING-STOCK', 'Opening Stock', 'STOCK_IN_HAND', 'STOCK', 1, 0, null, null, 'OPENING_STOCK'],
  ['CAPITAL', 'Capital Account', 'CAPITAL', 'GENERAL', 0, 0, null, null, null],
  ['SUSPENSE', 'Suspense', 'SUSPENSE', 'GENERAL', 0, 0, null, null, 'SUSPENSE'],
];

/** Posting roles shown on Accounts → Settings → Posting ledgers, in display order, with what uses them. */
export const POSTING_ROLES: { code: string; label: string; used: string }[] = [
  { code: 'PURCHASE_YARN', label: 'Yarn purchases', used: 'Bills Inward (yarn)' },
  { code: 'PURCHASE_FABRIC', label: 'Fabric purchases', used: 'Bills Inward (fabric)' },
  { code: 'PURCHASE_TRIMS', label: 'Trims & accessories purchases', used: 'Bills Inward (trims)' },
  { code: 'PURCHASE_GENERAL', label: 'General purchases', used: 'Bills Inward (general / service lines)' },
  { code: 'PURCHASE_RETURN', label: 'Purchase returns', used: 'Purchase return credit notes' },
  { code: 'JOBWORK_KNITTING', label: 'Knitting charges', used: 'Knitting bills' },
  { code: 'JOBWORK_FABRIC_PROCESS', label: 'Dyeing / fabric process charges', used: 'Fabric process bills, old fabric-process supplier bills' },
  { code: 'JOBWORK_YARN_PROCESS', label: 'Yarn process charges', used: 'Yarn process bills, old yarn-process supplier bills' },
  { code: 'JOBWORK_STITCHING', label: 'Stitching / contract labour', used: 'Contractor bills' },
  { code: 'JOBWORK_OTHER', label: 'Other job work', used: 'Trims / import process supplier bills' },
  { code: 'JOBWORK_DEDUCTION', label: 'Job work deductions & recoveries', used: 'Contractor bill deductions / debit notes' },
  { code: 'FREIGHT_INWARD', label: 'Freight, insurance, customs, clearing', used: 'Bills Inward landed charges, process bill freight' },
  { code: 'PURCHASE_OTHER_CHARGES', label: 'Other charges on bills', used: 'Bills Inward / process bills "other charges"' },
  { code: 'INPUT_CGST', label: 'Input CGST', used: 'Purchase-side GST (intra-state)' },
  { code: 'INPUT_SGST', label: 'Input SGST', used: 'Purchase-side GST (intra-state)' },
  { code: 'INPUT_IGST', label: 'Input IGST', used: 'Purchase-side GST (inter-state / import)' },
  { code: 'TDS_PAYABLE', label: 'TDS payable', used: 'TDS deducted on bills' },
  { code: 'TCS_RECEIVABLE', label: 'TCS receivable', used: 'TCS charged by suppliers' },
  { code: 'SALES_EXPORT', label: 'Export sales', used: 'Commercial invoices' },
  { code: 'SALES_DOMESTIC', label: 'Domestic sales', used: 'Commercial invoices to DOMESTIC buyers' },
  { code: 'OUTPUT_CGST', label: 'Output CGST', used: 'Manual sales vouchers' },
  { code: 'OUTPUT_SGST', label: 'Output SGST', used: 'Manual sales vouchers' },
  { code: 'OUTPUT_IGST', label: 'Output IGST', used: 'Commercial invoices under IGST payment' },
  { code: 'IGST_REFUND_RECEIVABLE', label: 'IGST refund receivable', used: 'Export invoices under IGST payment' },
  { code: 'EXPORT_INCENTIVE_INCOME', label: 'Export incentive income', used: 'Drawback / RoDTEP bank receipts' },
  { code: 'FX_GAIN_LOSS', label: 'Exchange gain / loss', used: 'Bank realisation vs invoice rate' },
  { code: 'BANK_CHARGES', label: 'Bank charges', used: 'Bank realisation charges' },
  { code: 'ROUND_OFF', label: 'Round off', used: 'Rounding on every automatic voucher (max ₹1)' },
  { code: 'CASH', label: 'Cash', used: 'Payments made in cash' },
  { code: 'OPENING_STOCK', label: 'Opening stock', used: 'P&L / balance sheet stock' },
  { code: 'SUSPENSE', label: 'Suspense', used: 'Manual vouchers only' },
];

/** Automatic posting events (acc_posting_rule.event_code). */
export const POSTING_EVENTS: { code: string; label: string; voucher: string }[] = [
  { code: 'SUPPLIER_BILL.APPROVE', label: 'Bills Inward approved → Purchase', voucher: 'PURCHASE' },
  { code: 'SUPPLIER_BILL.PAY', label: 'Bills Inward marked paid → Payment', voucher: 'PAYMENT' },
  { code: 'KNITTING_BILL.POST', label: 'Knitting bill saved → Purchase (job work)', voucher: 'PURCHASE' },
  { code: 'FABRIC_PROCESS_BILL.POST', label: 'Fabric process bill saved → Purchase (job work)', voucher: 'PURCHASE' },
  { code: 'YARN_PROCESS_BILL.POST', label: 'Yarn process bill saved → Purchase (job work)', voucher: 'PURCHASE' },
  { code: 'CONTRACTOR_BILL.APPROVE', label: 'Contractor bill approved → Purchase (job work)', voucher: 'PURCHASE' },
  { code: 'CONTRACTOR_PAYMENT.POST', label: 'Contractor payment → Payment', voucher: 'PAYMENT' },
  { code: 'CONTRACTOR_ADVANCE.POST', label: 'Contractor advance paid → Payment', voucher: 'PAYMENT' },
  { code: 'PURCHASE_CREDIT_NOTE.ISSUE', label: 'Purchase return credit note → Debit Note', voucher: 'DEBIT_NOTE' },
  { code: 'COMMERCIAL_INVOICE.FINAL', label: 'Commercial invoice final → Sales', voucher: 'SALES' },
  { code: 'REALISATION.POST', label: 'Bank realisation → Receipt', voucher: 'RECEIPT' },
  { code: 'EXPORT_BENEFIT.BANK_RECEIPT', label: 'Export incentive received in bank → Receipt', voucher: 'RECEIPT' },
];

export const DEFAULT_SETTINGS: [string, string, string][] = [
  ['ACC_STOCK_FROM_ERP', '0', 'Accounts: 1 = P&L / balance sheet opening & closing stock from ERP stock valuation (stock ledger qty × rate); 0 = not included (only the Opening Stock ledger) until Finance approves the inventory policy'],
  ['ACC_AUTO_SWEEP_MIN', '10', 'Accounts: minutes between automatic scans for documents to post (0 = only when someone clicks Scan now)'],
];

const ready = new Set<number>();

export async function ensureAccountsSetup(cid: number): Promise<void> {
  if (ready.has(cid)) return;
  const have = await queryOne<any>(`SELECT
      (SELECT COUNT(*) FROM acc_account_group WHERE company_id = ? AND is_system = 1) g,
      (SELECT COUNT(*) FROM acc_ledger_role WHERE company_id = ?) r,
      (SELECT COUNT(*) FROM acc_posting_rule WHERE company_id = ?) e`, [cid, cid, cid]);
  if (Number(have?.g) >= DEFAULT_GROUPS.length && Number(have?.r) >= POSTING_ROLES.length && Number(have?.e) >= POSTING_EVENTS.length) {
    ready.add(cid); return;
  }
  for (const [code, name, nature, gp, so] of DEFAULT_GROUPS) {
    await execute(`INSERT IGNORE INTO acc_account_group (company_id, group_code, group_name, nature, affects_gross_profit, sort_order, is_system)
                   VALUES (?,?,?,?,?,?,1)`, [cid, code, name, nature, gp, so]);
  }
  for (const [code, , , , , parent] of DEFAULT_GROUPS) {
    if (!parent) continue;
    await execute(`UPDATE acc_account_group g JOIN acc_account_group p ON p.company_id = g.company_id AND p.group_code = ?
                      SET g.parent_id = p.id WHERE g.company_id = ? AND g.group_code = ? AND g.parent_id IS NULL`, [parent, cid, code]);
  }
  for (const [code, name, prefix, tally] of DEFAULT_VOUCHER_TYPES) {
    await execute(`INSERT IGNORE INTO acc_voucher_type (company_id, type_code, type_name, prefix, tally_voucher_type) VALUES (?,?,?,?,?)`,
      [cid, code, name, prefix, tally]);
  }
  for (const [code, name, grp, type, ctrl, cc, tk, td] of DEFAULT_LEDGERS) {
    // skip when the code exists OR the name is taken (a user ledger of the same name)
    await execute(`INSERT INTO acc_ledger (company_id, ledger_code, ledger_name, group_id, ledger_type, is_control, is_cost_centre_on, tax_kind, tax_direction, is_system)
                   SELECT ?,?,?,g.id,?,?,?,?,?,1 FROM acc_account_group g
                    WHERE g.company_id = ? AND g.group_code = ?
                      AND NOT EXISTS (SELECT 1 FROM acc_ledger x WHERE x.company_id = ? AND (x.ledger_code = ? OR x.ledger_name = ?))`,
      [cid, code, name, type, ctrl, cc, tk, td, cid, grp, cid, code, name]);
  }
  for (const [code, name, , , , , , , role] of DEFAULT_LEDGERS) {
    if (!role) continue;
    await execute(`INSERT IGNORE INTO acc_ledger_role (company_id, role_code, ledger_id)
                   SELECT ?, ?, (SELECT id FROM acc_ledger WHERE company_id = ? AND (ledger_code = ? OR ledger_name = ?) ORDER BY ledger_code = ? DESC LIMIT 1)`,
      [cid, role, cid, code, name, code]);
  }
  // Automatic posting starts in REVIEW: vouchers wait for accounts approval; documents from the current FY start.
  const fy = await queryOne<any>(`SELECT DATE_FORMAT(start_date, '%Y-%m-%d') d FROM mst_financial_year WHERE company_id = ? AND is_current = 1 LIMIT 1`, [cid]);
  for (const e of POSTING_EVENTS) {
    await execute(`INSERT IGNORE INTO acc_posting_rule (company_id, event_code, mode, effective_from) VALUES (?,?, 'REVIEW', ?)`,
      [cid, e.code, fy?.d ?? '2026-04-01']);
  }
  for (const [k, v, d] of DEFAULT_SETTINGS) {
    await execute(`INSERT IGNORE INTO cfg_system_setting (company_id, setting_key, setting_value, description) VALUES (?,?,?,?)`, [cid, k, v, d]);
  }
  await execute(`INSERT IGNORE INTO acc_period_lock (company_id, locked_upto) VALUES (?, NULL)`, [cid]);
  ready.add(cid);
}

export async function allCompanyIds(): Promise<number[]> {
  return (await query<any>(`SELECT id FROM mst_company WHERE is_active = 1`)).map((r) => Number(r.id));
}
