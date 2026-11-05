/**
 * Data every printout needs besides its own document: OUR company block (logo, name, address, GSTIN, phone — no
 * software branding, client 05-Nov-2026) and the print template the company prints with (Admin → Settings
 * PRINT_TEMPLATE = COLOUR | BW, overridable per print with ?template=colour|bw).
 */
import fs from 'fs';
import path from 'path';
import { queryOne } from '../../config/db.js';
import { NotFound } from '../errors.js';
import type { PrintCompany, PrintTemplate } from './docPdf.js';

const str = (v: unknown) => { const t = String(v ?? '').trim(); return t ? t : null; };

/** The company logo as a local PNG / JPEG inside uploads/ (never a path outside it, never a remote URL). */
export function logoFile(logoPath: string | null): string | null {
  if (!logoPath || /^https?:/i.test(logoPath) || !/\.(png|jpe?g)$/i.test(logoPath)) return null;
  const uploads = path.resolve(process.cwd(), 'uploads');
  const rel = logoPath.replace(/^\/+/, '').replace(/^uploads\//, '');
  const file = path.resolve(uploads, rel);
  if (!file.startsWith(uploads + path.sep)) return null;
  try { return fs.statSync(file).isFile() ? file : null; } catch { return null; }
}

export interface LoadedCompany extends PrintCompany {
  pan: string | null; website: string | null; stateCode: string | null; tradeName: string | null;
  gstin: string | null; phone: string | null; email: string | null; logoFile: string | null;
}

/** Company (or a non-head-office branch with its own address) as printed at the top of every document. */
export async function loadPrintCompany(companyId: number, branchId: number | null = null): Promise<LoadedCompany> {
  const c = await queryOne<any>(`SELECT * FROM mst_company WHERE id = ?`, [companyId]);
  if (!c) throw NotFound('Company not found');
  const b = branchId ? await queryOne<any>(`SELECT * FROM mst_branch WHERE id = ? AND company_id = ?`, [branchId, companyId]) : null;
  const useBranch = !!(b && b.address_line1 && !b.is_head_office);
  const address = useBranch
    ? [b.address_line1, [b.city, b.state, b.pincode].filter(Boolean).join(', ')]
    : [c.address_line1, c.address_line2, [c.city, c.state, c.pincode].filter(Boolean).join(' - ')];
  return {
    name: String(c.legal_name || c.trade_name || ''),
    tradeName: str(c.trade_name) && c.trade_name !== c.legal_name ? String(c.trade_name) : null,
    address: address.map((a) => String(a ?? '').trim()).filter(Boolean),
    gstin: str(useBranch && b.gstin ? b.gstin : c.gstin),
    pan: str(c.pan),
    phone: str(useBranch && b.phone ? b.phone : c.phone),
    email: str(c.email),
    website: str(c.website),
    stateCode: str(c.state_gst_code) ?? (str(c.gstin)?.slice(0, 2) ?? null),
    logoFile: logoFile(str(c.logo_path)),
  };
}

/** "Name\naddress…\nGSTIN: …" — the company as a billing / consignor address block. */
export const companyAddressLines = (c: PrintCompany) => [...c.address, c.gstin ? `GSTIN: ${c.gstin}` : null].filter(Boolean) as string[];

export const PRINT_TEMPLATE_KEY = 'PRINT_TEMPLATE';

/** 'colour' / 'color' / 'COLOUR' → COLOUR; 'bw' / 'b&w' / 'black' / 'mono' → BW; anything else → null. */
export function parsePrintTemplate(v: unknown): PrintTemplate | null {
  const t = String(v ?? '').trim().toLowerCase().replace(/[^a-z&]/g, '');
  if (['colour', 'color', 'c'].includes(t)) return 'COLOUR';
  if (['bw', 'b&w', 'blackwhite', 'black&white', 'black', 'mono', 'monochrome'].includes(t)) return 'BW';
  return null;
}

/** The company's default print template (Admin → Settings PRINT_TEMPLATE), COLOUR when not set. */
export async function companyPrintTemplate(companyId: number): Promise<PrintTemplate> {
  const r = await queryOne<any>(
    `SELECT setting_value FROM cfg_system_setting WHERE setting_key = ? AND (company_id = ? OR company_id IS NULL)
      ORDER BY company_id IS NULL, company_id LIMIT 1`, [PRINT_TEMPLATE_KEY, companyId]);
  return parsePrintTemplate(r?.setting_value) ?? 'COLOUR';
}

/** ?template=colour|bw when given and valid, else the company default. */
export async function resolvePrintTemplate(companyId: number, requested?: unknown): Promise<PrintTemplate> {
  return parsePrintTemplate(requested) ?? companyPrintTemplate(companyId);
}
