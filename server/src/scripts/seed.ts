/**
 * Seed reference data, the RBAC catalog and a coherent Tiruppur demo dataset.
 * Safe to re-run: every insert is idempotent (INSERT IGNORE / upsert).
 *
 *   npm run db:seed
 */
import fs from 'fs';
import path from 'path';
import bcrypt from 'bcryptjs';
import { pool } from '../config/db.js';
import { env } from '../config/env.js';
import {
  COUNTRIES, CURRENCIES, UOMS, UOM_CONVERSIONS, STATUSES, MODULES,
  buildPermissions, ROLES, expandPermissions, PROCESS_STAGES, DEFECTS,
  CERT_TYPES, LEDGER_ACCOUNTS, TAX_RATES, NUMBER_SERIES,
} from './seedData.js';

const conn = await pool.getConnection();
const q = async <T = any>(sql: string, p?: any[]): Promise<T[]> => {
  const [rows] = await conn.query(sql, p); return rows as T[];
};
const one = async <T = any>(sql: string, p?: any[]): Promise<T | null> =>
  (await q<T>(sql, p))[0] ?? null;
const exec = async (sql: string, p?: any[]) => {
  const [r] = await conn.execute(sql, p); return r as any;
};

/** Look up a scalar id, or throw with a helpful message. */
async function id(sql: string, p: any[], what: string): Promise<number> {
  const row = await one<{ id: number }>(sql, p);
  if (!row) throw new Error(`Seed lookup failed: ${what}`);
  return row.id;
}

const log = (msg: string) => console.log(`[seed] ${msg}`);

async function ensureColumn(table: string, col: string, ddl: string) {
  try {
    const exists = await one<{ COLUMN_NAME: string }>(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?`,
      [table, col]
    );
    if (!exists) {
      await exec(`ALTER TABLE \`${table}\` ADD COLUMN \`${col}\` ${ddl}`);
    }
  } catch (e) {
    // ignore
  }
}

async function main() {
  log('starting...');

  // Ensure recent schema columns exist before any seeding runs
  await ensureColumn('trx_sales_order', 'io_no', 'VARCHAR(60) AFTER so_no');
  await ensureColumn('trx_sales_order', 'order_type', "ENUM('SAMPLE','PROJECTION','DOMESTIC','EXPORT') DEFAULT 'EXPORT' AFTER io_no");
  await ensureColumn('mst_party', 'is_merchandiser', 'TINYINT(1) NOT NULL DEFAULT 0 AFTER is_agent');
  await ensureColumn('mst_party', 'merchandiser_type', 'VARCHAR(50)');
  await ensureColumn('mst_party', 'merchandiser_division', 'VARCHAR(100)');
  await ensureColumn('mst_party', 'merchandiser_brands', 'VARCHAR(255)');
  await ensureColumn('mst_party', 'merchandiser_target', 'DECIMAL(18,2) DEFAULT 0');
  await ensureColumn('mst_party', 'merchandiser_commission', 'DECIMAL(6,3) DEFAULT 0');
  await ensureColumn('mst_party', 'merchandiser_remarks', 'VARCHAR(500)');

  // ===================================================== 1. GLOBAL LOOKUPS
  for (const [iso2, iso3, name, dial] of COUNTRIES) {
    await exec(`INSERT INTO cfg_country (iso2,iso3,name,dial_code) VALUES (?,?,?,?)
                ON DUPLICATE KEY UPDATE name=VALUES(name)`, [iso2, iso3, name, dial]);
  }
  for (const [code, name, symbol, dp] of CURRENCIES) {
    await exec(`INSERT INTO cfg_currency (code,name,symbol,decimal_place) VALUES (?,?,?,?)
                ON DUPLICATE KEY UPDATE name=VALUES(name)`, [code, name, symbol, dp]);
  }
  for (const [code, name, type] of UOMS) {
    await exec(`INSERT INTO cfg_uom (code,name,uom_type) VALUES (?,?,?)
                ON DUPLICATE KEY UPDATE name=VALUES(name)`, [code, name, type]);
  }
  for (const [from, to, factor] of UOM_CONVERSIONS) {
    const f = await one<{ id: number }>(`SELECT id FROM cfg_uom WHERE code=?`, [from]);
    const t = await one<{ id: number }>(`SELECT id FROM cfg_uom WHERE code=?`, [to]);
    if (f && t) {
      await exec(`INSERT INTO cfg_uom_conversion (from_uom,to_uom,factor) VALUES (?,?,?)
                  ON DUPLICATE KEY UPDATE factor=VALUES(factor)`, [f.id, t.id, factor]);
    }
  }
  for (const [domain, code, label, sort, terminal] of STATUSES) {
    await exec(`INSERT INTO cfg_status (domain,code,label,sort_order,is_terminal) VALUES (?,?,?,?,?)
                ON DUPLICATE KEY UPDATE label=VALUES(label), sort_order=VALUES(sort_order)`,
      [domain, code, label, sort, terminal]);
  }
  log(`lookups: ${COUNTRIES.length} countries, ${CURRENCIES.length} currencies, ${UOMS.length} UOMs, ${STATUSES.length} statuses`);

  // ===================================================== 2. MODULES & PERMS
  const moduleId = new Map<string, number>();
  for (const [code, name, parent, sort] of MODULES) {
    await exec(`INSERT INTO mst_module (module_code,module_name,parent_id,sort_order)
                VALUES (?,?,?,?)
                ON DUPLICATE KEY UPDATE module_name=VALUES(module_name), sort_order=VALUES(sort_order)`,
      [code, name, parent ? moduleId.get(parent) ?? null : null, sort]);
    const m = await one<{ id: number }>(`SELECT id FROM mst_module WHERE module_code=?`, [code]);
    moduleId.set(code, m!.id);
  }
  // Second pass fixes parents defined before their child rows existed.
  for (const [code, , parent] of MODULES) {
    if (parent) {
      await exec(`UPDATE mst_module SET parent_id=? WHERE module_code=?`,
        [moduleId.get(parent) ?? null, code]);
    }
  }

  const PERMISSIONS = buildPermissions();
  for (const [code, name, mod] of PERMISSIONS) {
    await exec(`INSERT INTO mst_permission (module_id,permission_code,permission_name)
                VALUES (?,?,?) ON DUPLICATE KEY UPDATE permission_name=VALUES(permission_name)`,
      [moduleId.get(mod), code, name]);
  }
  log(`RBAC catalog: ${MODULES.length} modules, ${PERMISSIONS.length} permissions`);

  // ===================================================== 3. COMPANY
  const inrId = await id(`SELECT id FROM cfg_currency WHERE code='INR'`, [], 'INR currency');
  const usdId = await id(`SELECT id FROM cfg_currency WHERE code='USD'`, [], 'USD currency');
  const eurId = await id(`SELECT id FROM cfg_currency WHERE code='EUR'`, [], 'EUR currency');
  const indId = await id(`SELECT id FROM cfg_country WHERE iso2='IN'`, [], 'India');

  await exec(
    `INSERT INTO mst_company (company_code, legal_name, trade_name, gstin, pan, iec_code, cin,
       base_currency, country_id, address_line1, address_line2, city, state, state_gst_code,
       pincode, phone, email, website)
     VALUES ('TEX01','Coimbatore Knitwear Exports Private Limited','CK Exports',
             '33AABCC1234D1ZP','AABCC1234D','0788012345','U18101TZ2005PTC012345',
             ?,?, 'SF No. 142/3, Mangalam Road','Kongu Nagar','Tiruppur','Tamil Nadu','33',
             '641604','+91 421 220 1234','exports@ckexports.in','www.ckexports.in')
     ON DUPLICATE KEY UPDATE legal_name=VALUES(legal_name)`, [inrId, indId]);
  const companyId = await id(`SELECT id FROM mst_company WHERE company_code='TEX01'`, [], 'company');

  // Branches
  for (const [code, name, gstin, city, ho] of [
    ['HO','Head Office - Tiruppur','33AABCC1234D1ZP','Tiruppur',1],
    ['CBE','Coimbatore Office','33AABCC1234D1ZP','Coimbatore',0],
  ] as [string,string,string,string,number][]) {
    await exec(`INSERT INTO mst_branch (company_id,branch_code,branch_name,gstin,city,state,is_head_office)
                VALUES (?,?,?,?,?,'Tamil Nadu',?)
                ON DUPLICATE KEY UPDATE branch_name=VALUES(branch_name)`,
      [companyId, code, name, gstin, city, ho]);
  }
  const hoBranch = await id(`SELECT id FROM mst_branch WHERE company_id=? AND branch_code='HO'`,
    [companyId], 'HO branch');

  // Units
  const UNITS: [string,string,string,number][] = [
    ['U-CUT','Cutting Section','CUTTING',8000],
    ['U-STC','Stitching Unit 1','STITCHING',6000],
    ['U-STC2','Stitching Unit 2','STITCHING',4500],
    ['U-FIN','Finishing & Packing','FINISHING',9000],
    ['U-WH','Central Warehouse','WAREHOUSE',0],
  ];
  for (const [code, name, type, cap] of UNITS) {
    await exec(`INSERT INTO mst_unit (company_id,branch_id,unit_code,unit_name,unit_type,capacity_per_day,city)
                VALUES (?,?,?,?,?,?,'Tiruppur')
                ON DUPLICATE KEY UPDATE unit_name=VALUES(unit_name)`,
      [companyId, hoBranch, code, name, type, cap]);
  }
  const whUnit = await id(`SELECT id FROM mst_unit WHERE company_id=? AND unit_code='U-WH'`,
    [companyId], 'warehouse unit');

  // Financial year
  await exec(`INSERT INTO mst_financial_year (company_id,fy_code,start_date,end_date,is_current)
              VALUES (?,'2026-27','2026-04-01','2027-03-31',1)
              ON DUPLICATE KEY UPDATE is_current=1`, [companyId]);
  const fyId = await id(`SELECT id FROM mst_financial_year WHERE company_id=? AND fy_code='2026-27'`,
    [companyId], 'financial year');

  // Number series
  for (const [docType, prefix] of NUMBER_SERIES) {
    await exec(`INSERT INTO cfg_number_series (company_id,branch_id,doc_type,fy_id,prefix,next_number,padding)
                VALUES (?,NULL,?,NULL,?,1,5)
                ON DUPLICATE KEY UPDATE prefix=VALUES(prefix)`, [companyId, docType, prefix]);
  }
  log(`company "${'CK Exports'}" with ${UNITS.length} units, FY 2026-27, ${NUMBER_SERIES.length} number series`);

  // ===================================================== 4. ROLES & ADMIN USER
  const allPermCodes = PERMISSIONS.map(([c]) => c);
  const roleIdByCode = new Map<string, number>();

  for (const role of ROLES) {
    await exec(`INSERT INTO mst_role (company_id,role_code,role_name,description,is_system)
                VALUES (?,?,?,?,?)
                ON DUPLICATE KEY UPDATE role_name=VALUES(role_name), description=VALUES(description)`,
      [companyId, role.code, role.name, role.description, role.code === 'SUPER_ADMIN' ? 1 : 0]);
    const rid = await id(`SELECT id FROM mst_role WHERE company_id=? AND role_code=?`,
      [companyId, role.code], `role ${role.code}`);
    roleIdByCode.set(role.code, rid);

    const codes = expandPermissions(role.permissions, allPermCodes);
    await exec(`DELETE FROM map_role_permission WHERE role_id=?`, [rid]);
    if (codes.length) {
      await exec(
        `INSERT IGNORE INTO map_role_permission (role_id, permission_id)
         SELECT ?, id FROM mst_permission WHERE permission_code IN (${codes.map(() => '?').join(',')})`,
        [rid, ...codes]);
    }
  }
  log(`${ROLES.length} roles with permission mappings`);

  // Users — admin plus one per functional role, all sharing the demo password.
  const demoHash = await bcrypt.hash(env.seed.adminPassword, env.bcryptRounds);
  const USERS: [string, string, string, string][] = [
    [env.seed.adminUsername, 'System Administrator', 'admin@ckexports.in', 'SUPER_ADMIN'],
    ['merch',    'Lakshmi Narayanan', 'merch@ckexports.in',    'MERCHANDISER'],
    ['prod',     'Rajesh Kumar',      'prod@ckexports.in',     'PRODUCTION_MANAGER'],
    ['qc',       'Anitha Selvam',     'qc@ckexports.in',       'QC_INSPECTOR'],
    ['store',    'Murugan Palanisamy','store@ckexports.in',    'STORE_KEEPER'],
    ['purchase', 'Sundar Ramasamy',   'purchase@ckexports.in', 'PURCHASE_OFFICER'],
    ['export',   'Priya Venkatesan',  'export@ckexports.in',   'EXPORT_EXECUTIVE'],
    ['accounts', 'Ganesh Subramani',  'accounts@ckexports.in', 'ACCOUNTANT'],
  ];
  for (const [username, fullName, email, roleCode] of USERS) {
    await exec(`INSERT INTO mst_user (company_id,username,password_hash,full_name,email,default_branch)
                VALUES (?,?,?,?,?,?)
                ON DUPLICATE KEY UPDATE full_name=VALUES(full_name), email=VALUES(email)`,
      [companyId, username, demoHash, fullName, email, hoBranch]);
    const uid = await id(`SELECT id FROM mst_user WHERE company_id=? AND username=?`,
      [companyId, username], `user ${username}`);
    await exec(`INSERT IGNORE INTO map_user_role (user_id,role_id) VALUES (?,?)`,
      [uid, roleIdByCode.get(roleCode)]);
    const branches = await q<{ id: number }>(`SELECT id FROM mst_branch WHERE company_id=?`, [companyId]);
    for (const b of branches) {
      await exec(`INSERT IGNORE INTO map_user_branch (user_id,branch_id) VALUES (?,?)`, [uid, b.id]);
    }
  }
  const adminId = await id(`SELECT id FROM mst_user WHERE company_id=? AND username=?`,
    [companyId, env.seed.adminUsername], 'admin user');
  log(`${USERS.length} users (password: ${env.seed.adminPassword})`);

  // ===================================================== 5. CONFIG MASTERS
  for (const [code, name, sort, outsource] of PROCESS_STAGES) {
    await exec(`INSERT INTO cfg_process_stage (company_id,stage_code,stage_name,sort_order,is_outsourceable)
                VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE stage_name=VALUES(stage_name)`,
      [companyId, code, name, sort, outsource]);
  }
  for (const [code, name, type, stage] of DEFECTS) {
    await exec(`INSERT INTO mst_defect (company_id,defect_code,defect_name,defect_type,stage)
                VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE defect_name=VALUES(defect_name)`,
      [companyId, code, name, type, stage]);
  }
  for (const [code, name, body] of CERT_TYPES) {
    await exec(`INSERT INTO mst_certificate_type (company_id,cert_code,cert_name,issuing_body)
                VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE cert_name=VALUES(cert_name)`,
      [companyId, code, name, body]);
  }
  for (const [code, name, group, isBank] of LEDGER_ACCOUNTS) {
    await exec(`INSERT INTO mst_ledger_account (company_id,account_code,account_name,account_group,is_bank)
                VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE account_name=VALUES(account_name)`,
      [companyId, code, name, group, isBank]);
  }
  for (const [hsn, desc, igst, cgst, sgst] of TAX_RATES) {
    const exists = await one(`SELECT id FROM cfg_tax_rate WHERE company_id=? AND hsn_code=?`,
      [companyId, hsn]);
    if (!exists) {
      await exec(`INSERT INTO cfg_tax_rate (company_id,hsn_code,description,igst_pct,cgst_pct,sgst_pct,effective_from)
                  VALUES (?,?,?,?,?,?,'2026-04-01')`, [companyId, hsn, desc, igst, cgst, sgst]);
    }
  }
  const SETTINGS: [string, string, string][] = [
    ['DEFAULT_CURRENCY', 'USD', 'Default transaction currency'],
    ['FISCAL_YEAR_START', '04-01', 'Fiscal year start (MM-DD)'],
    ['PO_APPROVAL_LIMIT', '100000', 'PO value above which dual approval needed'],
    ['LOW_STOCK_ALERT_DAYS', '7', 'Days before OTD to trigger stock alerts'],
    ['MRP_NET_STOCK', '1', '1=net on-hand stock in MRP'],
    ['AUDIT_RETENTION_DAYS', '730', 'Days to keep audit log entries'],
    ['SESSION_TIMEOUT_MINS', '60', 'Idle session timeout in minutes'],
    ['EMAIL_FROM', '', 'SMTP sender address for system emails'],
    ['DEFAULT_INCOTERM', 'FOB', 'Default incoterm for export invoices'],
    ['PACKING_QC_MANDATORY', '1', 'Require passing QC before packing'],
  ];
  for (const [k, v, d] of SETTINGS) {
    await exec(`INSERT INTO cfg_system_setting (company_id,setting_key,setting_value,description)
                VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE description=VALUES(description)`,
      [companyId, k, v, d]);
  }

  log(`config: ${PROCESS_STAGES.length} stages, ${DEFECTS.length} defects, ${CERT_TYPES.length} cert types, ${LEDGER_ACCOUNTS.length} accounts, ${SETTINGS.length} settings`);

  // Warehouses
  const WAREHOUSES: [string,string,string][] = [
    ['WH-RM','Raw Material Store','RAW_MATERIAL'],
    ['WH-TRM','Trims Store','TRIMS'],
    ['WH-WIP','WIP Store','WIP'],
    ['WH-FG','Finished Goods Store','FINISHED_GOODS'],
    ['WH-REJ','Rejection Store','REJECTION'],
  ];
  for (const [code, name, type] of WAREHOUSES) {
    await exec(`INSERT INTO mst_warehouse (company_id,unit_id,warehouse_code,warehouse_name,warehouse_type)
                VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE warehouse_name=VALUES(warehouse_name)`,
      [companyId, whUnit, code, name, type]);
  }
  const rmWh = await id(`SELECT id FROM mst_warehouse WHERE company_id=? AND warehouse_code='WH-RM'`,
    [companyId], 'RM warehouse');
  const trmWh = await id(`SELECT id FROM mst_warehouse WHERE company_id=? AND warehouse_code='WH-TRM'`,
    [companyId], 'Trims warehouse');
  for (const wh of [rmWh, trmWh]) {
    for (const bin of ['A-01','A-02','B-01','B-02']) {
      await exec(`INSERT INTO mst_warehouse_bin (warehouse_id,bin_code,rack) VALUES (?,?,?)
                  ON DUPLICATE KEY UPDATE rack=VALUES(rack)`, [wh, bin, bin.split('-')[0]]);
    }
  }

  await seedDemo({ companyId, hoBranch, adminId, inrId, usdId, eurId, indId, rmWh, trmWh, fyId });

  log('done.');
}

// ======================================================================
//  DEMO DATASET — a realistic Tiruppur export house
// ======================================================================
async function seedDemo(ctx: {
  companyId: number; hoBranch: number; adminId: number;
  inrId: number; usdId: number; eurId: number; indId: number;
  rmWh: number; trmWh: number; fyId: number;
}) {
  const { companyId, hoBranch, adminId, inrId, usdId, eurId, rmWh, trmWh } = ctx;

  const uom = async (code: string) => id(`SELECT id FROM cfg_uom WHERE code=?`, [code], `UOM ${code}`);
  const [PCS, KG, MTR, CONE, GROSS] =
    await Promise.all([uom('PCS'), uom('KG'), uom('MTR'), uom('CONE'), uom('GROSS')]);
  const country = async (iso: string) =>
    id(`SELECT id FROM cfg_country WHERE iso2=?`, [iso], `country ${iso}`);
  const status = async (domain: string, code: string) =>
    id(`SELECT id FROM cfg_status WHERE domain=? AND code=?`, [domain, code], `status ${domain}.${code}`);

  // ------------------------------------------------------- parties
  const PARTIES: [string,string,Record<string,number>,string,string|null,number|null,string][] = [
    ['B001','H&M Hennes & Mauritz AB',{is_buyer:1,is_customer:1},'EXPORT','SE',null,'LC 60 DAYS'],
    ['B002','Primark Stores Limited',{is_buyer:1,is_customer:1},'EXPORT','GB',null,'TT 45 DAYS'],
    ['B003','Decathlon SA',{is_buyer:1,is_customer:1},'EXPORT','FR',null,'LC 90 DAYS'],
    ['B004','Target Corporation',{is_buyer:1,is_customer:1},'EXPORT','US',null,'TT 60 DAYS'],
    ['S001','Sri Vari Spinning Mills',{is_supplier:1},'DOMESTIC','IN',null,'30 DAYS CREDIT'],
    ['S002','Anandha Knit Fabrics',{is_supplier:1},'DOMESTIC','IN',null,'45 DAYS CREDIT'],
    ['S003','Kumaran Trims & Accessories',{is_supplier:1},'DOMESTIC','IN',null,'30 DAYS CREDIT'],
    ['S004','Coimbatore Dyeing Works',{is_supplier:1,is_vendor:1},'DOMESTIC','IN',null,'30 DAYS CREDIT'],
    ['V001','Sakthi Printing Works',{is_vendor:1},'DOMESTIC','IN',null,'15 DAYS CREDIT'],
    ['V002','Lakshmi Embroidery Unit',{is_vendor:1},'DOMESTIC','IN',null,'15 DAYS CREDIT'],
    ['V003','Perfect Wash Company',{is_vendor:1},'DOMESTIC','IN',null,'30 DAYS CREDIT'],
    ['A001','EuroSource Buying Agents',{is_agent:1},'EXPORT','GB',null,'ON REALIZATION'],
    ['M001','Apex Garment Sourcing & Merchandising',{is_merchandiser:1},'EXPORT','IN',null,'30 DAYS CREDIT'],
    ['F001','Blue Dart Logistics',{is_vendor:1},'DOMESTIC','IN',null,'IMMEDIATE'],
  ];
  const partyId = new Map<string, number>();
  for (const [code, name, flags, ptype, iso, _c, terms] of PARTIES) {
    const cid = iso ? await country(iso) : null;
    const curId = ptype === 'EXPORT'
      ? (iso === 'SE' || iso === 'FR' ? eurId : iso === 'GB' ? await id(`SELECT id FROM cfg_currency WHERE code='GBP'`, [], 'GBP') : usdId)
      : inrId;
    await exec(
      `INSERT INTO mst_party (company_id,party_code,party_name,is_customer,is_buyer,is_supplier,
         is_vendor,is_agent,is_merchandiser,party_type,country_id,currency_id,payment_terms,credit_days,email,created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE party_name=VALUES(party_name)`,
      [companyId, code, name, flags.is_customer ?? 0, flags.is_buyer ?? 0, flags.is_supplier ?? 0,
       flags.is_vendor ?? 0, flags.is_agent ?? 0, (flags as any).is_merchandiser ?? 0, ptype, cid, curId, terms, 45,
       `contact@${code.toLowerCase()}.example.com`, adminId]);
    partyId.set(code, await id(`SELECT id FROM mst_party WHERE company_id=? AND party_code=?`,
      [companyId, code], `party ${code}`));
  }
  log(`${PARTIES.length} business partners`);

  // ------------------------------------------------------- colors & sizes
  const COLORS: [string,string,string,string][] = [
    ['BLK','Black','19-4005 TCX','#101010'], ['WHT','White','11-0601 TCX','#FFFFFF'],
    ['NVY','Navy','19-4027 TCX','#1B2A4A'], ['GRY','Melange Grey','17-0000 TCX','#8C8C8C'],
    ['RED','True Red','18-1662 TCX','#BE0B2E'], ['OLV','Olive Green','18-0625 TCX','#6B6337'],
    ['SKY','Sky Blue','14-4318 TCX','#8ABAD3'], ['MRN','Maroon','19-1522 TCX','#6B2A35'],
    ['BEG','Beige','13-1006 TCX','#D9C9B5'], ['MST','Mustard','15-0955 TCX','#D5A021'],
  ];
  const colorId = new Map<string, number>();
  for (const [code, name, pantone, hex] of COLORS) {
    await exec(`INSERT INTO mst_color (company_id,color_code,color_name,pantone_ref,hex_value)
                VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE color_name=VALUES(color_name)`,
      [companyId, code, name, pantone, hex]);
    colorId.set(code, await id(`SELECT id FROM mst_color WHERE company_id=? AND color_code=?`,
      [companyId, code], `color ${code}`));
  }

  const SIZE_GROUPS: [string, string, [string,string][]][] = [
    ['ALPHA','Alpha Sizes (S-XXL)', [['S','Small'],['M','Medium'],['L','Large'],['XL','X-Large'],['XXL','XX-Large']]],
    ['KIDS','Kids Age Sizes', [['2-3Y','2-3 Years'],['4-5Y','4-5 Years'],['6-7Y','6-7 Years'],['8-9Y','8-9 Years']]],
    ['NUM-EU','Numeric EU', [['46','EU 46'],['48','EU 48'],['50','EU 50'],['52','EU 52']]],
  ];
  const sizeGroupId = new Map<string, number>();
  for (const [code, name, sizes] of SIZE_GROUPS) {
    await exec(`INSERT INTO mst_size_group (company_id,group_code,group_name) VALUES (?,?,?)
                ON DUPLICATE KEY UPDATE group_name=VALUES(group_name)`, [companyId, code, name]);
    const gid = await id(`SELECT id FROM mst_size_group WHERE company_id=? AND group_code=?`,
      [companyId, code], `size group ${code}`);
    sizeGroupId.set(code, gid);
    let sort = 1;
    for (const [sc, sl] of sizes) {
      await exec(`INSERT INTO mst_size (size_group_id,size_code,size_label,sort_order) VALUES (?,?,?,?)
                  ON DUPLICATE KEY UPDATE size_label=VALUES(size_label), sort_order=VALUES(sort_order)`,
        [gid, sc, sl, sort++]);
    }
  }

  // ------------------------------------------------------- compositions & GSM
  const COMPOSITIONS: [string,string,[string,number][]][] = [
    ['C100','100% Cotton',[['Cotton',100]]],
    ['C955','95% Cotton 5% Elastane',[['Cotton',95],['Elastane',5]]],
    ['CP6040','60% Cotton 40% Polyester',[['Cotton',60],['Polyester',40]]],
    ['P100','100% Polyester',[['Polyester',100]]],
    ['CV5050','50% Cotton 50% Viscose',[['Cotton',50],['Viscose',50]]],
  ];
  const compId = new Map<string, number>();
  for (const [code, desc, parts] of COMPOSITIONS) {
    await exec(`INSERT INTO mst_composition (company_id,composition_code,description) VALUES (?,?,?)
                ON DUPLICATE KEY UPDATE description=VALUES(description)`, [companyId, code, desc]);
    const cid = await id(`SELECT id FROM mst_composition WHERE company_id=? AND composition_code=?`,
      [companyId, code], `composition ${code}`);
    compId.set(code, cid);
    const existing = await one(`SELECT id FROM mst_composition_detail WHERE composition_id=?`, [cid]);
    if (!existing) {
      for (const [fibre, pct] of parts) {
        await exec(`INSERT INTO mst_composition_detail (composition_id,fibre_name,percentage)
                    VALUES (?,?,?)`, [cid, fibre, pct]);
      }
    }
  }
  const gsmId = new Map<number, number>();
  for (const g of [140, 160, 180, 200, 220, 240, 280, 320]) {
    await exec(`INSERT INTO mst_gsm (company_id,gsm_value,tolerance) VALUES (?,?,5)
                ON DUPLICATE KEY UPDATE tolerance=5`, [companyId, g]);
    gsmId.set(g, await id(`SELECT id FROM mst_gsm WHERE company_id=? AND gsm_value=?`,
      [companyId, g], `gsm ${g}`));
  }

  // ------------------------------------------------------- material categories
  const CATEGORIES: [string,string,string][] = [
    ['CAT-YRN','Yarn','YARN'], ['CAT-FAB','Fabric','FABRIC'], ['CAT-TRM','Trims','TRIM'],
    ['CAT-PKG','Packing Material','PACKING'],
  ];
  const catId = new Map<string, number>();
  for (const [code, name, type] of CATEGORIES) {
    await exec(`INSERT INTO mst_material_category (company_id,category_code,category_name,material_type)
                VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE category_name=VALUES(category_name)`,
      [companyId, code, name, type]);
    catId.set(code, await id(`SELECT id FROM mst_material_category WHERE company_id=? AND category_code=?`,
      [companyId, code], `category ${code}`));
  }

  // ------------------------------------------------------- yarns
  const YARNS: [string,string,string,string,string,number][] = [
    ['Y30CC','30s Combed Cotton','30s','COMBED','C100',285],
    ['Y40CC','40s Combed Cotton','40s','COMBED','C100',310],
    ['Y24CC','24s Combed Cotton','24s','COMBED','C100',268],
    ['Y30CD','30s Carded Cotton','30s','CARDED','C100',242],
    ['Y30ML','30s Melange Grey','30s','MELANGE','CV5050',298],
    ['Y150P','150D Polyester Filament','150D','OTHER','P100',165],
  ];
  const yarnId = new Map<string, number>();
  for (const [code, name, count, type, comp, rate] of YARNS) {
    await exec(
      `INSERT INTO mst_yarn (company_id,yarn_code,yarn_name,category_id,count_value,count_type,
         composition_id,yarn_type,hsn_code,base_uom,std_rate,created_by)
       VALUES (?,?,?,?,?,'Ne',?,?, '52051110',?,?,?)
       ON DUPLICATE KEY UPDATE yarn_name=VALUES(yarn_name), std_rate=VALUES(std_rate)`,
      [companyId, code, name, catId.get('CAT-YRN'), count, compId.get(comp), type, KG, rate, adminId]);
    yarnId.set(code, await id(`SELECT id FROM mst_yarn WHERE company_id=? AND yarn_code=?`,
      [companyId, code], `yarn ${code}`));
  }

  // ------------------------------------------------------- fabrics
  const FABRICS: [string,string,string,string,number,string,number][] = [
    ['F-SJ180','Single Jersey 180 GSM','KNIT','Single Jersey',180,'C100',420],
    ['F-SJ160','Single Jersey 160 GSM','KNIT','Single Jersey',160,'C100',405],
    ['F-PQ220','Pique 220 GSM','KNIT','Pique',220,'C100',445],
    ['F-RIB200','Rib 1x1 200 GSM','KNIT','Rib 1x1',200,'C955',480],
    ['F-FL280','Fleece 280 GSM','KNIT','Fleece',280,'CP6040',390],
    ['F-IN240','Interlock 240 GSM','KNIT','Interlock',240,'C100',455],
  ];
  const fabricId = new Map<string, number>();
  for (const [code, name, ftype, structure, gsm, comp, rate] of FABRICS) {
    await exec(
      `INSERT INTO mst_fabric (company_id,fabric_code,fabric_name,category_id,fabric_type,knit_structure,
         composition_id,gsm_id,width_cm,dia_inch,yarn_id,finish_type,hsn_code,base_uom,std_rate,created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,'Bio-wash','60062200',?,?,?)
       ON DUPLICATE KEY UPDATE fabric_name=VALUES(fabric_name), std_rate=VALUES(std_rate)`,
      [companyId, code, name, catId.get('CAT-FAB'), ftype, structure, compId.get(comp),
       gsmId.get(gsm), 180, 34, yarnId.get('Y30CC'), KG, rate, adminId]);
    fabricId.set(code, await id(`SELECT id FROM mst_fabric WHERE company_id=? AND fabric_code=?`,
      [companyId, code], `fabric ${code}`));
  }

  // ------------------------------------------------------- trims
  const TRIMS: [string,string,string,string,number,number][] = [
    ['T-LBL-MAIN','Main Woven Label','LABEL','Satin woven, 30x50mm',0, 0],
    ['T-LBL-CARE','Care Label','LABEL','Printed satin, 4 languages',0, 0],
    ['T-LBL-SIZE','Size Label','LABEL','Woven size tab',0, 0],
    ['T-HTG','Hangtag with String','HANGTAG','300gsm art card',0, 0],
    ['T-THR-40','Sewing Thread 40/2','THREAD','Polyester core spun',0, 0],
    ['T-BTN-18L','Button 18L 4-hole','BUTTON','Polyester, matte',0, 0],
    ['T-DRW-CTN','Drawcord Cotton 8mm','DRAWCORD','Flat braided',0, 0],
    ['T-ELS-30','Elastic 30mm','ELASTIC','Knitted waistband',0, 0],
    ['T-PLY','Polybag 300x400','POLYBAG','LDPE 40 micron',0, 0],
    ['T-CTN-5PLY','Export Carton 5-Ply','CARTON','600x400x350mm',0, 0],
  ];
  const trimRates: Record<string, [number, number]> = {   // [uom, rate]
    'T-LBL-MAIN': [PCS, 1.85], 'T-LBL-CARE': [PCS, 0.95], 'T-LBL-SIZE': [PCS, 0.55],
    'T-HTG': [PCS, 2.40], 'T-THR-40': [CONE, 85], 'T-BTN-18L': [GROSS, 96],
    'T-DRW-CTN': [MTR, 3.20], 'T-ELS-30': [MTR, 8.50], 'T-PLY': [PCS, 1.15],
    'T-CTN-5PLY': [PCS, 42],
  };
  const trimId = new Map<string, number>();
  for (const [code, name, type, spec] of TRIMS) {
    const [u, rate] = trimRates[code];
    await exec(
      `INSERT INTO mst_trim (company_id,trim_code,trim_name,category_id,trim_type,specification,
         hsn_code,base_uom,std_rate,created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE trim_name=VALUES(trim_name), std_rate=VALUES(std_rate)`,
      [companyId, code, name, catId.get('CAT-TRM'), type, spec,
       type === 'CARTON' ? '48191010' : '96061000', u, rate, adminId]);
    trimId.set(code, await id(`SELECT id FROM mst_trim WHERE company_id=? AND trim_code=?`,
      [companyId, code], `trim ${code}`));
  }
  log(`materials: ${YARNS.length} yarns, ${FABRICS.length} fabrics, ${TRIMS.length} trims`);

  // ------------------------------------------------------- products & styles
  const PRODUCTS: [string,string,string,string,string][] = [
    ['P-TSH','Basic T-Shirt','TSHIRT','UNISEX','61091000'],
    ['P-POL','Polo Shirt','POLO','MEN','61051010'],
    ['P-SWT','Sweatshirt','SWEATSHIRT','UNISEX','61103000'],
    ['P-HOD','Hoodie','HOODIE','UNISEX','61103000'],
    ['P-LEG','Leggings','LEGGING','WOMEN','61046200'],
    ['P-KID','Kids T-Shirt','KIDSWEAR','BOYS','61091000'],
  ];
  const productId = new Map<string, number>();
  for (const [code, name, type, gender, hsn] of PRODUCTS) {
    await exec(`INSERT INTO mst_product (company_id,product_code,product_name,product_type,gender,hsn_code,default_uom,created_by)
                VALUES (?,?,?,?,?,?,?,?)
                ON DUPLICATE KEY UPDATE product_name=VALUES(product_name)`,
      [companyId, code, name, type, gender, hsn, PCS, adminId]);
    productId.set(code, await id(`SELECT id FROM mst_product WHERE company_id=? AND product_code=?`,
      [companyId, code], `product ${code}`));
  }

  // Ensure default style SVG sketches exist on disk
  const sampleUploadsDir = path.resolve(process.cwd(), 'uploads', 'styles');
  if (!fs.existsSync(sampleUploadsDir)) fs.mkdirSync(sampleUploadsDir, { recursive: true });

  const SVG_MAP: Record<string, string> = {
    'mens_crew_tee.svg': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="100%" height="100%"><defs><linearGradient id="teeGrad" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#3b82f6" /><stop offset="100%" stop-color="#1d4ed8" /></linearGradient></defs><rect width="200" height="200" rx="24" fill="#f1f5f9" /><g transform="translate(10, 10)"><path d="M55 40 L70 30 C80 42 100 42 110 30 L125 40 L155 60 L140 85 L125 78 L125 150 C125 153 122 155 119 155 L61 155 C58 155 55 153 55 150 L55 78 L40 85 L25 60 Z" fill="url(#teeGrad)" stroke="#1e40af" stroke-width="2" /><path d="M70 30 C80 44 100 44 110 30" fill="none" stroke="#93c5fd" stroke-width="3" stroke-linecap="round" /><path d="M30 67 L42 80 M150 67 L138 80 M57 148 L123 148" stroke="#60a5fa" stroke-width="1.5" stroke-dasharray="2,2" /></g></svg>`,
    'mens_polo_pique.svg': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="100%" height="100%"><defs><linearGradient id="poloGrad" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#0284c7" /><stop offset="100%" stop-color="#0369a1" /></linearGradient></defs><rect width="200" height="200" rx="24" fill="#f0fdf4" /><g transform="translate(10, 10)"><path d="M55 42 L70 32 C80 38 100 38 110 32 L125 42 L155 62 L140 86 L125 80 L125 152 C125 155 122 157 119 157 L61 157 C58 157 55 155 55 152 L55 80 L40 86 L25 62 Z" fill="url(#poloGrad)" stroke="#075985" stroke-width="2" /><path d="M68 31 L85 46 L95 46 L112 31 C102 38 78 38 68 31 Z" fill="#0f172a" stroke="#075985" stroke-width="1.5" /><rect x="85" y="44" width="10" height="30" rx="2" fill="#0f172a" /><circle cx="90" cy="51" r="1.5" fill="#e2e8f0" /><circle cx="90" cy="60" r="1.5" fill="#e2e8f0" /></g></svg>`,
    'unisex_hoodie.svg': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="100%" height="100%"><defs><linearGradient id="hoodieGrad" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#475569" /><stop offset="100%" stop-color="#1e293b" /></linearGradient></defs><rect width="200" height="200" rx="24" fill="#faf5ff" /><g transform="translate(10, 10)"><path d="M70 20 C70 10 110 10 110 20 C120 30 115 45 90 45 C65 45 60 30 70 20 Z" fill="#334155" stroke="#0f172a" stroke-width="2" /><path d="M50 46 L68 36 C80 44 100 44 112 36 L130 46 L160 88 L142 98 L126 72 L126 150 L54 150 L54 72 L38 98 L20 88 Z" fill="url(#hoodieGrad)" stroke="#0f172a" stroke-width="2" /><path d="M66 108 L114 108 L122 135 L58 135 Z" fill="#334155" stroke="#64748b" stroke-width="1.5" /></g></svg>`,
    'womens_leggings.svg': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="100%" height="100%"><defs><linearGradient id="legGrad" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#881337" /><stop offset="100%" stop-color="#4c0519" /></linearGradient></defs><rect width="200" height="200" rx="24" fill="#fff1f2" /><g transform="translate(10, 10)"><rect x="62" y="25" width="56" height="14" rx="3" fill="#9f1239" stroke="#4c0519" stroke-width="1.5" /><path d="M62 39 L56 75 L62 165 C62 167 65 168 67 168 L77 168 C79 168 81 167 81 165 L89 85 L91 85 L99 165 C99 167 101 168 103 168 L113 168 C115 168 118 167 118 165 L124 75 L118 39 Z" fill="url(#legGrad)" stroke="#4c0519" stroke-width="2" /><path d="M90 40 L90 85 M64 163 L79 163 M101 163 L116 163" stroke="#f43f5e" stroke-width="1.5" stroke-dasharray="2,2" /></g></svg>`,
    'kids_tee.svg': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="100%" height="100%"><defs><linearGradient id="kidGrad" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#f59e0b" /><stop offset="100%" stop-color="#d97706" /></linearGradient></defs><rect width="200" height="200" rx="24" fill="#fef3c7" /><g transform="translate(10, 10)"><path d="M58 45 L72 36 C80 46 100 46 108 36 L122 45 L148 64 L134 86 L122 79 L122 144 C122 147 119 149 116 149 L64 149 C61 149 58 147 58 144 L58 79 L46 86 L32 64 Z" fill="url(#kidGrad)" stroke="#b45309" stroke-width="2" /><circle cx="90" cy="85" r="14" fill="#ef4444" stroke="#fff" stroke-width="1.5" /></g></svg>`,
    'mens_sweatshirt.svg': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="100%" height="100%"><defs><linearGradient id="swtGrad" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#059669" /><stop offset="100%" stop-color="#065f46" /></linearGradient></defs><rect width="200" height="200" rx="24" fill="#ecfdf5" /><g transform="translate(10, 10)"><path d="M52 46 L70 36 C80 44 100 44 110 36 L128 46 L158 86 L140 96 L125 72 L125 148 L55 148 L55 72 L40 96 L22 86 Z" fill="url(#swtGrad)" stroke="#064e3b" stroke-width="2" /><path d="M70 36 C80 44 100 44 110 36" fill="none" stroke="#6ee7b7" stroke-width="3" stroke-linecap="round" /><rect x="55" y="142" width="70" height="8" fill="#064e3b" /></g></svg>`,
  };

  for (const [file, content] of Object.entries(SVG_MAP)) {
    const target = path.join(sampleUploadsDir, file);
    if (!fs.existsSync(target)) fs.writeFileSync(target, content, 'utf-8');
  }

  const styleActive = await status('STYLE', 'ACTIVE');
  const STYLES: [string,string,string,string,string,string,string,string[],string][] = [
    ['ST-2601','Mens Crew Neck Tee','P-TSH','B001','SS26','ALPHA','F-SJ180',['BLK','WHT','NVY'],'/uploads/styles/mens_crew_tee.svg'],
    ['ST-2602','Mens Polo Pique','P-POL','B002','SS26','ALPHA','F-PQ220',['NVY','WHT','GRY'],'/uploads/styles/mens_polo_pique.svg'],
    ['ST-2603','Unisex Hoodie','P-HOD','B003','AW26','ALPHA','F-FL280',['BLK','GRY','OLV'],'/uploads/styles/unisex_hoodie.svg'],
    ['ST-2604','Womens Leggings','P-LEG','B004','SS26','ALPHA','F-RIB200',['BLK','MRN'],'/uploads/styles/womens_leggings.svg'],
    ['ST-2605','Kids Printed Tee','P-KID','B001','SS26','KIDS','F-SJ160',['SKY','RED','WHT'],'/uploads/styles/kids_tee.svg'],
    ['ST-2606','Mens Sweatshirt','P-SWT','B002','AW26','ALPHA','F-FL280',['NVY','BEG'],'/uploads/styles/mens_sweatshirt.svg'],
  ];
  const styleId = new Map<string, number>();
  for (const [code, name, prod, buyer, season, szGrp, fab, colors, imgUrl] of STYLES) {
    await exec(
      `INSERT INTO mst_style (company_id,style_code,style_name,product_id,buyer_id,buyer_style_ref,
         season,size_group_id,fabric_id,description,image_url,status_id,created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE style_name=VALUES(style_name), image_url=VALUES(image_url)`,
      [companyId, code, name, productId.get(prod), partyId.get(buyer), `${buyer}-${code}`,
       season, sizeGroupId.get(szGrp), fabricId.get(fab),
       `${name} for ${season} season`, imgUrl, styleActive, adminId]);
    const sid = await id(`SELECT id FROM mst_style WHERE company_id=? AND style_code=?`,
      [companyId, code], `style ${code}`);
    styleId.set(code, sid);

    for (const c of colors) {
      await exec(`INSERT IGNORE INTO map_style_color (style_id,color_id) VALUES (?,?)`,
        [sid, colorId.get(c)]);
    }
    // Generate the SKU matrix (style x color x size).
    const sizes = await q<{ id: number; size_code: string }>(
      `SELECT id, size_code FROM mst_size WHERE size_group_id=? ORDER BY sort_order`,
      [sizeGroupId.get(szGrp)]);
    for (const c of colors) {
      for (const sz of sizes) {
        const skuCode = `${code}-${c}-${sz.size_code}`.toUpperCase();
        await exec(
          `INSERT INTO mst_style_sku (style_id,color_id,size_id,sku_code,barcode)
           VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE sku_code=VALUES(sku_code)`,
          [sid, colorId.get(c), sz.id, skuCode, `890${String(sid).padStart(4,'0')}${String(sz.id).padStart(3,'0')}`]);
      }
    }
  }
  const skuCount = await one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM mst_style_sku k JOIN mst_style s ON s.id=k.style_id WHERE s.company_id=?`,
    [companyId]);
  log(`${STYLES.length} styles with ${skuCount?.n ?? 0} SKUs`);

  // ------------------------------------------------------- BOMs
  const bomApproved = await status('BOM', 'APPROVED');
  for (const [code, , , , , , fab] of STYLES) {
    const sid = styleId.get(code)!;
    const existing = await one(`SELECT id FROM trx_bom WHERE company_id=? AND style_id=?`, [companyId, sid]);
    if (existing) continue;

    const bomNo = `BOM-${code.replace('ST-', '')}`;
    const r = await exec(
      `INSERT INTO trx_bom (company_id,style_id,bom_no,version,effective_date,status_id,remarks,created_by)
       VALUES (?,?,?,1,'2026-04-01',?,?,?)`,
      [companyId, sid, bomNo, bomApproved, `Approved BOM for ${code}`, adminId]);
    const bomId = r.insertId;

    // Body fabric plus the standard trim set.
    const lines: [string, number|undefined, number, number, number][] = [
      ['FABRIC', fabricId.get(fab), 0.235, KG, 8],
      ['TRIM', trimId.get('T-LBL-MAIN'), 1, PCS, 2],
      ['TRIM', trimId.get('T-LBL-CARE'), 1, PCS, 2],
      ['TRIM', trimId.get('T-LBL-SIZE'), 1, PCS, 2],
      ['TRIM', trimId.get('T-HTG'), 1, PCS, 2],
      ['TRIM', trimId.get('T-THR-40'), 0.012, CONE, 5],
      ['TRIM', trimId.get('T-PLY'), 1, PCS, 3],
      ['TRIM', trimId.get('T-CTN-5PLY'), 0.0167, PCS, 2],   // ~60 pcs/carton
    ];
    for (const [mtype, mid, cons, u, waste] of lines) {
      await exec(
        `INSERT INTO trx_bom_line (bom_id,material_type,fabric_id,trim_id,consumption,uom_id,wastage_pct)
         VALUES (?,?,?,?,?,?,?)`,
        [bomId, mtype, mtype === 'FABRIC' ? mid : null, mtype === 'TRIM' ? mid : null, cons, u, waste]);
    }
  }
  log(`${STYLES.length} BOMs with component lines`);

  // ------------------------------------------------------- sales orders
  const soApproved = await status('SALES_ORDER', 'IN_PRODUCTION');
  const ORDERS: [string,string,string,string,string,string,number,[string,string,number,number][]][] = [
    ['SO-00001','B001','2026-05-04','2026-08-15','SS26','USD',0,
      [['ST-2601','BLK',6000,4.85],['ST-2601','WHT',4000,4.85],['ST-2601','NVY',3000,4.95]]],
    ['SO-00002','B002','2026-05-12','2026-08-28','SS26','GBP',0,
      [['ST-2602','NVY',5000,8.20],['ST-2602','WHT',3500,8.20]]],
    ['SO-00003','B003','2026-06-02','2026-09-20','AW26','EUR',1,
      [['ST-2603','BLK',4000,14.50],['ST-2603','GRY',2500,14.50]]],
    ['SO-00004','B004','2026-06-18','2026-10-05','SS26','USD',0,
      [['ST-2604','BLK',7000,6.75]]],
    ['SO-00005','B001','2026-07-01','2026-10-18','SS26','USD',0,
      [['ST-2605','SKY',5000,3.95],['ST-2605','RED',5000,3.95]]],
  ];
  const soId = new Map<string, number>();
  for (const [soNo, buyer, soDate, shipDate, season, curCode, useAgent, lines] of ORDERS) {
    const existing = await one<{id:number}>(`SELECT id FROM trx_sales_order WHERE company_id=? AND so_no=?`,
      [companyId, soNo]);
    if (existing) { soId.set(soNo, existing.id); continue; }

    const curId = await id(`SELECT id FROM cfg_currency WHERE code=?`, [curCode], `currency ${curCode}`);
    const buyerRow = await one<{ country_id: number }>(`SELECT country_id FROM mst_party WHERE id=?`,
      [partyId.get(buyer)]);
    const ioNo = `IO-26${soNo.slice(-3)}`;

    const r = await exec(
      `INSERT INTO trx_sales_order (company_id,branch_id,so_no,io_no,order_type,so_date,buyer_id,agent_id,buyer_po_no,
         buyer_po_date,season,currency_id,exchange_rate,incoterm,port_of_loading,destination_country,
         destination_port,payment_term,ship_date,delivery_date,status_id,approval_state,created_by)
       VALUES (?,?,?,?,'EXPORT',?,?,?,?,?,?,?,?,?,'FOB','Tuticorin',?,'Rotterdam','LC',?,?,?,'APPROVED',?)`,
      [companyId, hoBranch, soNo, ioNo, soDate, partyId.get(buyer), useAgent ? partyId.get('A001') : null,
       `PO-${buyer}-${soNo.slice(-4)}`, soDate, season, curId, curCode === 'USD' ? 83.2 : curCode === 'EUR' ? 90.1 : 105.4,
       buyerRow?.country_id ?? null, shipDate, shipDate, soApproved, adminId]);
    const sid = r.insertId;
    soId.set(soNo, sid);

    let totalQty = 0, totalAmt = 0;
    for (const [styleCode, colorCode, qty, price] of lines) {
      const amount = Number((qty * price).toFixed(4));
      totalQty += qty; totalAmt += amount;
      const lr = await exec(
        `INSERT INTO trx_sales_order_line (so_id,style_id,color_id,description,order_qty,unit_price,amount,ship_date)
         VALUES (?,?,?,?,?,?,?,?)`,
        [sid, styleId.get(styleCode), colorId.get(colorCode),
         `${styleCode} ${colorCode}`, qty, price, amount, shipDate]);

      // Spread the quantity across sizes in a realistic S:M:L:XL:XXL ratio.
      const skus = await q<{ id: number; size_code: string }>(
        `SELECT k.id, sz.size_code FROM mst_style_sku k
           JOIN mst_size sz ON sz.id = k.size_id
          WHERE k.style_id=? AND k.color_id=? ORDER BY sz.sort_order`,
        [styleId.get(styleCode), colorId.get(colorCode)]);
      const ratios = skus.length === 5 ? [0.15, 0.25, 0.30, 0.20, 0.10]
                   : skus.length === 4 ? [0.20, 0.30, 0.30, 0.20]
                   : new Array(skus.length).fill(1 / Math.max(skus.length, 1));
      let assigned = 0;
      for (let i = 0; i < skus.length; i++) {
        const sq = i === skus.length - 1 ? qty - assigned : Math.round(qty * ratios[i]);
        assigned += sq;
        await exec(`INSERT INTO trx_sales_order_sku (so_line_id,sku_id,qty) VALUES (?,?,?)
                    ON DUPLICATE KEY UPDATE qty=VALUES(qty)`, [lr.insertId, skus[i].id, sq]);
      }
    }
    await exec(`UPDATE trx_sales_order SET order_qty=?, total_amount=? WHERE id=?`,
      [totalQty, totalAmt.toFixed(4), sid]);
  }
  log(`${ORDERS.length} sales orders with size-wise breakdowns`);

  // ------------------------------------------------------- opening stock
  const openingStock: [string, number, number, number, number][] = [
    // [materialCode, warehouseId, qty, uom, rate]
    ['Y30CC', rmWh, 2500, KG, 285], ['Y40CC', rmWh, 1800, KG, 310],
    ['Y30ML', rmWh, 900, KG, 298],
  ];
  for (const [code, wh, qty, u, rate] of openingStock) {
    const exists = await one(
      `SELECT id FROM trx_stock_ledger WHERE company_id=? AND yarn_id=? AND ref_type='OPENING'`,
      [companyId, yarnId.get(code)]);
    if (exists) continue;
    await exec(
      `INSERT INTO trx_stock_ledger (company_id,warehouse_id,material_type,yarn_id,txn_type,
         ref_type,ref_id,qty_in,uom_id,rate,created_by)
       VALUES (?,?,'YARN',?,'ADJUST','OPENING',0,?,?,?,?)`,
      [companyId, wh, yarnId.get(code), qty, u, rate, adminId]);
  }
  const fabricStock: [string, number, number][] = [
    ['F-SJ180', 3200, 420], ['F-PQ220', 1800, 445], ['F-FL280', 2400, 390], ['F-RIB200', 1200, 480],
  ];
  for (const [code, qty, rate] of fabricStock) {
    const exists = await one(
      `SELECT id FROM trx_stock_ledger WHERE company_id=? AND fabric_id=? AND ref_type='OPENING'`,
      [companyId, fabricId.get(code)]);
    if (exists) continue;
    await exec(
      `INSERT INTO trx_stock_ledger (company_id,warehouse_id,material_type,fabric_id,txn_type,
         ref_type,ref_id,qty_in,uom_id,rate,created_by)
       VALUES (?,?,'FABRIC',?,'ADJUST','OPENING',0,?,?,?,?)`,
      [companyId, rmWh, fabricId.get(code), qty, KG, rate, adminId]);
  }
  for (const [code] of TRIMS) {
    const exists = await one(
      `SELECT id FROM trx_stock_ledger WHERE company_id=? AND trim_id=? AND ref_type='OPENING'`,
      [companyId, trimId.get(code)]);
    if (exists) continue;
    const [u, rate] = trimRates[code];
    await exec(
      `INSERT INTO trx_stock_ledger (company_id,warehouse_id,material_type,trim_id,txn_type,
         ref_type,ref_id,qty_in,uom_id,rate,created_by)
       VALUES (?,?,'TRIM',?,'ADJUST','OPENING',0,?,?,?,?)`,
      [companyId, trmWh, trimId.get(code), 25000, u, rate, adminId]);
  }
  log('opening stock posted to the ledger');

  // ------------------------------------------------------- production flow
  const stage = async (code: string) =>
    id(`SELECT id FROM cfg_process_stage WHERE company_id=? AND stage_code=?`, [companyId, code],
      `stage ${code}`);
  const [CUT, STITCH, FINISH_S] = await Promise.all([stage('CUT'), stage('STITCH'), stage('FINISH')]);
  const cutUnit = await id(`SELECT id FROM mst_unit WHERE company_id=? AND unit_code='U-CUT'`,
    [companyId], 'cutting unit');
  const stcUnit = await id(`SELECT id FROM mst_unit WHERE company_id=? AND unit_code='U-STC'`,
    [companyId], 'stitching unit');
  const finUnit = await id(`SELECT id FROM mst_unit WHERE company_id=? AND unit_code='U-FIN'`,
    [companyId], 'finishing unit');
  const prodInProg = await status('PROD_ORDER', 'IN_PROGRESS');

  // Work orders for the first three sales orders, at varying completion.
  const WORK_ORDERS: [string,string,string,string,number,number][] = [
    ['WO-00001','SO-00001','ST-2601','BLK',6000,5400],
    ['WO-00002','SO-00001','ST-2601','WHT',4000,3600],
    ['WO-00003','SO-00002','ST-2602','NVY',5000,3200],
    ['WO-00004','SO-00003','ST-2603','BLK',4000,1500],
  ];
  for (const [woNo, soNo, styleCode, colorCode, qty, produced] of WORK_ORDERS) {
    const exists = await one<{id:number}>(
      `SELECT id FROM trx_production_order WHERE company_id=? AND po_prod_no=?`, [companyId, woNo]);
    let woId: number;
    if (exists) { woId = exists.id; }
    else {
      const r = await exec(
        `INSERT INTO trx_production_order (company_id,po_prod_no,prod_date,so_id,style_id,color_id,
           unit_id,order_qty,planned_qty,produced_qty,status_id,approval_state,created_by)
         VALUES (?,?,'2026-06-01',?,?,?,?,?,?,?,?,'IN_PROGRESS',?)`,
        [companyId, woNo, soId.get(soNo), styleId.get(styleCode), colorId.get(colorCode),
         stcUnit, qty, qty, produced, prodInProg, adminId]);
      woId = r.insertId;
    }

    // Cutting
    const cutExists = await one(`SELECT id FROM trx_cutting WHERE company_id=? AND cut_no=?`,
      [companyId, `CUT-${woNo.slice(-5)}`]);
    if (!cutExists) {
      await exec(
        `INSERT INTO trx_cutting (company_id,cut_no,cut_date,prod_order_id,fabric_id,lay_length_m,
           ply_count,marker_ref,marker_eff_pct,fabric_used_kg,total_pieces,created_by)
         VALUES (?,?,'2026-06-05',?,?,?,?,?,?,?,?,?)`,
        [companyId, `CUT-${woNo.slice(-5)}`, woId,
         fabricId.get(STYLES.find((s) => s[0] === styleCode)![6]),
         42.5, 60, `MKR-${woNo.slice(-5)}`, 86.5, (qty * 0.235).toFixed(4), produced, adminId]);
    }

    // Process transactions at three stages
    for (const [st, stName, inQty, outQty, rej] of [
      [CUT, 'CUT', qty, produced + 40, 40],
      [STITCH, 'STC', produced + 40, produced, 40],
      [FINISH_S, 'FIN', produced, Math.floor(produced * 0.99), Math.ceil(produced * 0.01)],
    ] as [number,string,number,number,number][]) {
      const txnNo = `PRC-${stName}-${woNo.slice(-5)}`;
      const e = await one(`SELECT id FROM trx_process_transaction WHERE company_id=? AND txn_no=?`,
        [companyId, txnNo]);
      if (e) continue;
      await exec(
        `INSERT INTO trx_process_transaction (company_id,prod_order_id,stage_id,txn_no,txn_date,
           from_unit,to_unit,input_qty,output_qty,rejected_qty,created_by)
         VALUES (?,?,?,?,'2026-06-10',?,?,?,?,?,?)`,
        [companyId, woId, st, txnNo, cutUnit, st === CUT ? stcUnit : finUnit,
         inQty, outQty, rej, adminId]);
    }

    // Stitching record
    const stcNo = `STC-${woNo.slice(-5)}`;
    const stcExists = await one(`SELECT id FROM trx_stitching WHERE company_id=? AND stitch_no=?`,
      [companyId, stcNo]);
    if (!stcExists) {
      await exec(
        `INSERT INTO trx_stitching (company_id,stitch_no,stitch_date,prod_order_id,unit_id,line_no,
           input_qty,output_qty,rejected_qty,smv,rate,created_by)
         VALUES (?,?,'2026-06-15',?,?,'LINE-1',?,?,?,?,?,?)`,
        [companyId, stcNo, woId, stcUnit, produced + 40, produced, 40, 12.5, 18.5, adminId]);
    }

    // QC inspection
    const qcNo = `QC-${woNo.slice(-5)}`;
    const qcExists = await one(`SELECT id FROM trx_qc_inspection WHERE company_id=? AND qc_no=?`,
      [companyId, qcNo]);
    if (!qcExists) {
      const sample = Math.min(200, Math.floor(produced * 0.1));
      const major = Math.floor(sample * 0.02), minor = Math.floor(sample * 0.05);
      const r = await exec(
        `INSERT INTO trx_qc_inspection (company_id,qc_no,qc_date,prod_order_id,stage_id,inspection_type,
           aql_level,lot_size,sample_size,inspected_qty,passed_qty,major_defects,minor_defects,
           critical_defects,result,inspector_id,created_by)
         VALUES (?,?,'2026-06-20',?,?,'FINAL','2.5',?,?,?,?,?,?,0,'PASS',?,?)`,
        [companyId, qcNo, woId, FINISH_S, produced, sample, sample,
         sample - major - minor, major, minor, adminId, adminId]);
      const defects = await q<{ id: number }>(
        `SELECT id FROM mst_defect WHERE company_id=? ORDER BY RAND() LIMIT 3`, [companyId]);
      for (const d of defects) {
        await exec(`INSERT INTO trx_qc_defect_line (qc_id,defect_id,defect_qty) VALUES (?,?,?)`,
          [r.insertId, d.id, Math.max(1, Math.floor(Math.random() * 6))]);
      }
    }
  }
  log(`${WORK_ORDERS.length} production orders with cutting, stitching, process and QC records`);

  // ------------------------------------------------------- purchase & GRN
  const poApproved = await status('PURCHASE_ORDER', 'APPROVED');
  const poNo = 'PO-00001';
  let poId: number;
  const poExists = await one<{id:number}>(`SELECT id FROM trx_purchase_order WHERE company_id=? AND po_no=?`,
    [companyId, poNo]);
  if (poExists) { poId = poExists.id; }
  else {
    const r = await exec(
      `INSERT INTO trx_purchase_order (company_id,branch_id,po_no,po_date,supplier_id,po_type,so_id,
         currency_id,delivery_date,payment_terms,total_amount,tax_amount,grand_total,status_id,
         approval_state,created_by)
       VALUES (?,?,?,'2026-05-10',?,'MATERIAL',?,?,'2026-06-05','30 DAYS CREDIT',?,?,?,?,'APPROVED',?)`,
      [companyId, hoBranch, poNo, partyId.get('S001'), soId.get('SO-00001'), inrId,
       1425000, 71250, 1496250, poApproved, adminId]);
    poId = r.insertId;
    await exec(
      `INSERT INTO trx_purchase_order_line (po_id,material_type,yarn_id,qty,uom_id,rate,amount,gst_rate,received_qty)
       VALUES (?,'YARN',?,5000,?,285,1425000,5,5000)`, [poId, yarnId.get('Y30CC'), KG]);
  }

  const grnNo = 'GRN-00001';
  const grnExists = await one(`SELECT id FROM trx_grn WHERE company_id=? AND grn_no=?`, [companyId, grnNo]);
  if (!grnExists) {
    const batchNo = 'BATCH-Y30CC-2601';
    let batchId: number;
    const bExists = await one<{id:number}>(`SELECT id FROM mst_batch WHERE company_id=? AND batch_no=?`,
      [companyId, batchNo]);
    if (bExists) batchId = bExists.id;
    else {
      const br = await exec(
        `INSERT INTO mst_batch (company_id,batch_no,material_type,yarn_id,supplier_id,received_date,shade_lot)
         VALUES (?,?,'YARN',?,?,'2026-06-02','SL-2601')`,
        [companyId, batchNo, yarnId.get('Y30CC'), partyId.get('S001')]);
      batchId = br.insertId;
    }
    const poLine = await one<{ id: number }>(`SELECT id FROM trx_purchase_order_line WHERE po_id=? LIMIT 1`, [poId]);
    const gr = await exec(
      `INSERT INTO trx_grn (company_id,grn_no,grn_date,po_id,supplier_id,warehouse_id,supplier_dc_no,
         supplier_inv_no,vehicle_no,created_by)
       VALUES (?,?,'2026-06-02',?,?,?,'DC-8842','INV-SVS-2291','TN39BX4471',?)`,
      [companyId, grnNo, poId, partyId.get('S001'), rmWh, adminId]);
    await exec(
      `INSERT INTO trx_grn_line (grn_id,po_line_id,material_type,yarn_id,batch_id,received_qty,
         accepted_qty,rejected_qty,uom_id)
       VALUES (?,?,'YARN',?,?,5000,4950,50,?)`,
      [gr.insertId, poLine?.id ?? null, yarnId.get('Y30CC'), batchId, KG]);
    await exec(
      `INSERT INTO trx_stock_ledger (company_id,warehouse_id,material_type,yarn_id,batch_id,txn_type,
         ref_type,ref_id,qty_in,uom_id,rate,created_by)
       VALUES (?,?,'YARN',?,?,'GRN','GRN',?,4950,?,285,?)`,
      [companyId, rmWh, yarnId.get('Y30CC'), batchId, gr.insertId, KG, adminId]);
  }
  log('purchase order and goods receipt with batch traceability');

  // ------------------------------------------------------- Gate Management
  const gateInExists = await one(`SELECT id FROM trx_gate_inward WHERE company_id=? AND entry_no='IGP-00001'`, [companyId]);
  if (!gateInExists) {
    await exec(
      `INSERT INTO trx_gate_inward (company_id,entry_no,entry_date,entry_time,entry_type,party_id,supplier_dc_no,
         supplier_dc_date,supplier_inv_no,supplier_inv_date,vehicle_no,driver_name,driver_phone,transporter_name,
         lr_no,material_type,package_count,gross_weight_kg,tare_weight_kg,net_weight_kg,warehouse_id,status,security_guard,created_by)
       VALUES (?,'IGP-00001','2026-06-02','09:45:00','PURCHASE_INWARD',?,'DC-8842','2026-06-01','INV-SVS-2291','2026-06-01',
               'TN39BX4471','R. Manickam','+91 98421 11223','VRL Logistics','LR-99812','FABRIC',48,5120.000,120.000,5000.000,
               ?,'GRN_COMPLETED','P. Velusamy',?)`,
      [companyId, partyId.get('S001'), rmWh, adminId]);

    await exec(
      `INSERT INTO trx_gate_inward (company_id,entry_no,entry_date,entry_time,entry_type,party_id,supplier_dc_no,
         supplier_dc_date,vehicle_no,driver_name,driver_phone,transporter_name,material_type,package_count,
         gross_weight_kg,tare_weight_kg,net_weight_kg,warehouse_id,status,security_guard,created_by)
       VALUES (?,'IGP-00002','2026-06-15','11:30:00','JOBWORK_RETURN',?,'DC-PRT-402','2026-06-15',
               'TN38AZ9921','S. Kannan','+91 97890 55443','Local Mini Truck','GARMENT',24,1250.000,50.000,1200.000,
               ?,'GATE_IN','P. Velusamy',?)`,
      [companyId, partyId.get('V001'), rmWh, adminId]);
  }

  const gateOutExists = await one(`SELECT id FROM trx_gate_outward WHERE company_id=? AND pass_no='OGP-00001'`, [companyId]);
  if (!gateOutExists) {
    await exec(
      `INSERT INTO trx_gate_outward (company_id,pass_no,pass_date,pass_time,pass_type,party_id,vehicle_no,
         driver_name,driver_phone,transporter_name,purpose,package_count,total_qty,uom_id,expected_return_date,
         is_returned,status,security_guard,created_by)
       VALUES (?,'OGP-00001','2026-06-10','14:15:00','RETURNABLE_JOBWORK',?,'TN38AZ9921',
               'S. Kannan','+91 97890 55443','Local Mini Truck','Sent cut panels for chest pigment printing',24,1200.000,?,
               '2026-06-16',1,'RETURNED_FULL','P. Velusamy',?)`,
      [companyId, partyId.get('V001'), PCS, adminId]);

    await exec(
      `INSERT INTO trx_gate_outward (company_id,pass_no,pass_date,pass_time,pass_type,party_id,vehicle_no,
         driver_name,driver_phone,transporter_name,purpose,package_count,total_qty,uom_id,expected_return_date,
         is_returned,status,security_guard,created_by)
       VALUES (?,'OGP-00002','2026-07-29','16:30:00','NON_RETURNABLE_DISPATCH',?,'TN39BX8819',
               'K. Palani','+91 94432 77889','South Indian Roadways','Export shipment dispatch to Tuticorin Port CFS',90,5400.000,?,
               NULL,0,'GATE_OUT','P. Velusamy',?)`,
      [companyId, partyId.get('B001'), PCS, adminId]);
  }
  log('gate entries (inward & outward returnables) seeded');

  // ------------------------------------------------------- packing → export
  const packNo = 'PCK-00001';
  let packId: number;
  const packExists = await one<{id:number}>(`SELECT id FROM trx_packing WHERE company_id=? AND pack_no=?`,
    [companyId, packNo]);
  if (packExists) packId = packExists.id;
  else {
    const r = await exec(
      `INSERT INTO trx_packing (company_id,pack_no,pack_date,so_id,pack_method,total_cartons,
         total_qty,net_weight_kg,gross_weight_kg,created_by)
       VALUES (?,?,'2026-07-28',?,'RATIO_PACK',90,5400,1080,1188,?)`,
      [companyId, packNo, soId.get('SO-00001'), adminId]);
    packId = r.insertId;

    const skus = await q<{ id: number }>(
      `SELECT k.id FROM mst_style_sku k
         JOIN mst_size sz ON sz.id=k.size_id
        WHERE k.style_id=? AND k.color_id=? ORDER BY sz.sort_order`,
      [styleId.get('ST-2601'), colorId.get('BLK')]);
    const ratio = [9, 15, 18, 12, 6];    // 60 pcs per carton
    for (let i = 1; i <= 90; i++) {
      const cr = await exec(
        `INSERT INTO trx_carton (packing_id,carton_no,carton_type,length_cm,width_cm,height_cm,
           net_weight_kg,gross_weight_kg,cbm,barcode)
         VALUES (?,?,'5-Ply Export',60,40,35,12,13.2,0.084,?)`,
        [packId, `CTN-${String(i).padStart(4,'0')}`, `890CTN${String(i).padStart(5,'0')}`]);
      for (let idx = 0; idx < skus.length; idx++) {
        await exec(`INSERT INTO trx_carton_content (carton_id,sku_id,qty) VALUES (?,?,?)`,
          [cr.insertId, skus[idx].id, ratio[idx] ?? 12]);
      }
    }
  }

  const dispNo = 'DSP-00001';
  let dispId: number;
  const dispExists = await one<{id:number}>(`SELECT id FROM trx_dispatch WHERE company_id=? AND dispatch_no=?`,
    [companyId, dispNo]);
  if (dispExists) dispId = dispExists.id;
  else {
    const r = await exec(
      `INSERT INTO trx_dispatch (company_id,dispatch_no,dispatch_date,so_id,packing_id,buyer_id,
         mode,total_cartons,total_qty,gross_weight_kg,total_cbm,created_by)
       VALUES (?,?,'2026-08-02',?,?,?,'SEA',90,5400,1188,7.56,?)`,
      [companyId, dispNo, soId.get('SO-00001'), packId, partyId.get('B001'), adminId]);
    dispId = r.insertId;
    await exec(
      `INSERT INTO trx_container (company_id,container_no,dispatch_id,container_type,seal_no,
         tare_weight_kg,max_cbm,loaded_cbm,stuffing_date,stuffing_type)
       VALUES (?,'MSKU7841239',?,'40HC','SL-889201',3800,67.7,7.56,'2026-08-02','FACTORY')`,
      [companyId, dispId]);
  }

  const invNo = 'INV-00001';
  let invId: number;
  const invExists = await one<{id:number}>(
    `SELECT id FROM trx_commercial_invoice WHERE company_id=? AND invoice_no=?`, [companyId, invNo]);
  if (invExists) invId = invExists.id;
  else {
    const swe = await country('SE');
    const ind = await country('IN');
    const r = await exec(
      `INSERT INTO trx_commercial_invoice (company_id,invoice_no,invoice_date,so_id,dispatch_id,buyer_id,
         currency_id,exchange_rate,incoterm,port_of_loading,port_of_discharge,final_destination,
         country_origin,country_dest,fob_value,freight_value,total_value,created_by)
       VALUES (?,?,'2026-08-03',?,?,?,?,83.2,'FOB','Tuticorin','Gothenburg','Stockholm',?,?,26190,0,26190,?)`,
      [companyId, invNo, soId.get('SO-00001'), dispId, partyId.get('B001'), usdId, ind, swe, adminId]);
    invId = r.insertId;
    await exec(
      `INSERT INTO trx_commercial_invoice_line (invoice_id,style_id,description,hsn_code,qty,unit_price,amount)
       VALUES (?,?,'Mens Crew Neck Tee - Black','61091000',5400,4.85,26190)`,
      [invId, styleId.get('ST-2601')]);
    await exec(
      `INSERT INTO trx_invoice_tax (invoice_id,hsn_code,taxable_value,igst_pct,igst_amount,is_export_lut)
       VALUES (?,'61091000',2179008,0,0,1)`, [invId]);
    await exec(
      `INSERT INTO trx_packing_list (company_id,pl_no,pl_date,invoice_id,packing_id,total_cartons,
         total_qty,net_weight_kg,gross_weight_kg,total_cbm,created_by)
       VALUES (?,'PL-00001','2026-08-03',?,?,90,5400,1080,1188,7.56,?)`,
      [companyId, invId, packId, adminId]);

    const sbr = await exec(
      `INSERT INTO trx_shipping_bill (company_id,sb_no,sb_date,invoice_id,port_code,cha_name,cha_ref,
         leo_date,scheme_code,drawback_amount,rodtep_amount,fob_inr,created_by)
       VALUES (?,'SB-00001','2026-08-04',?,'INTUT1','Sea Link Clearing Agents','SLC-2291',
               '2026-08-05','RODTEP',43580,28950,2179008,?)`,
      [companyId, invId, adminId]);
    await exec(
      `INSERT INTO trx_shipment (company_id,shipment_no,invoice_id,dispatch_id,shipping_bill_id,
         forwarder_id,shipping_line,vessel_name,voyage_no,bl_no,bl_date,etd,eta,atd,pol,pod,
         tracking_status,created_by)
       VALUES (?,'SHP-00001',?,?,?,?,'Maersk Line','MAERSK KOWLOON','241W','MAEU789456123',
               '2026-08-06','2026-08-07','2026-09-02','2026-08-07','Tuticorin','Gothenburg','SAILED',?)`,
      [companyId, invId, dispId, sbr.insertId, partyId.get('F001'), adminId]);
    await exec(
      `INSERT INTO trx_export_incentive (company_id,incentive_type,shipping_bill_id,invoice_id,
         claim_amount,claim_date,status)
       VALUES (?,'RODTEP',?,?,28950,'2026-08-10','CLAIMED')`, [companyId, sbr.insertId, invId]);

    // Part payment received against the invoice.
    const rcpt = await exec(
      `INSERT INTO trx_receipt (company_id,receipt_no,receipt_date,buyer_id,mode,currency_id,
         exchange_rate,amount_fc,amount_inr,bank_ref,created_by)
       VALUES (?,'RCP-00001','2026-09-15',?,'TT',?,83.5,15000,1252500,'SWIFT-8829371',?)`,
      [companyId, partyId.get('B001'), usdId, adminId]);
    await exec(
      `INSERT INTO map_receipt_invoice (receipt_id,invoice_id,allocated_fc,allocated_inr)
       VALUES (?,?,15000,1252500)`, [rcpt.insertId, invId]);
  }
  log('packing (90 cartons), dispatch, invoice, shipping bill, shipment and part receipt');

  // ------------------------------------------------------- pre-sales funnel
  const enqNew = await status('ENQUIRY', 'NEW');
  const enqExists = await one(`SELECT id FROM trx_enquiry WHERE company_id=? AND enquiry_no='ENQ-00001'`,
    [companyId]);
  if (!enqExists) {
    const merchUser = await one<{ id: number }>(
      `SELECT id FROM mst_user WHERE company_id=? AND username='merch'`, [companyId]);
    const er = await exec(
      `INSERT INTO trx_enquiry (company_id,branch_id,enquiry_no,enquiry_date,buyer_id,merchandiser_id,
         season,target_price,currency_id,expected_qty,delivery_target,status_id,remarks,created_by)
       VALUES (?,?,'ENQ-00001','2026-07-15',?,?,'AW26',5.20,?,15000,'2026-12-15',?,
               'Buyer exploring organic cotton programme for AW26',?)`,
      [companyId, hoBranch, partyId.get('B003'), merchUser?.id ?? adminId, usdId, enqNew, adminId]);
    await exec(
      `INSERT INTO trx_enquiry_line (enquiry_id,style_id,product_id,description,qty,target_price)
       VALUES (?,?,?,'Organic cotton crew tee',15000,5.20)`,
      [er.insertId, styleId.get('ST-2601'), productId.get('P-TSH')]);

    const sampProg = await status('SAMPLE', 'IN_PROGRESS');
    await exec(
      `INSERT INTO trx_sample (company_id,sample_no,enquiry_id,style_id,buyer_id,sample_type,
         request_date,target_date,qty,status_id,approval_status,created_by)
       VALUES (?,'SMP-00001',?,?,?,'PROTO','2026-07-18','2026-08-01',3,?,'PENDING',?)`,
      [companyId, er.insertId, styleId.get('ST-2601'), partyId.get('B003'), sampProg, adminId]);

    const costDraft = await status('COSTING', 'APPROVED');
    await exec(
      `INSERT INTO trx_costing (company_id,costing_no,version,enquiry_id,style_id,buyer_id,costing_date,
         currency_id,order_qty,fabric_cost,trim_cost,cutting_cost,stitching_cost,finishing_cost,
         packing_cost,overhead_cost,freight_cost,total_cost,margin_pct,fob_price,status_id,created_by)
       VALUES (?,'CST-00001',1,?,?,?,'2026-07-22',?,15000,1.85,0.42,0.18,0.95,0.22,0.28,0.35,0.12,
               4.37,15.5,5.05,?,?)`,
      [companyId, er.insertId, styleId.get('ST-2601'), partyId.get('B003'), usdId, costDraft, adminId]);
  }
  log('enquiry → sample → costing funnel');

  // ------------------------------------------------------- production plan / T&A
  const planExists = await one(`SELECT id FROM trx_production_plan WHERE company_id=? AND plan_no='PLN-00001'`,
    [companyId]);
  if (!planExists) {
    const pr = await exec(
      `INSERT INTO trx_production_plan (company_id,plan_no,plan_date,so_id,unit_id,plan_start,plan_end,created_by)
       VALUES (?,'PLN-00001','2026-05-06',?,?,'2026-05-20','2026-08-10',?)`,
      [companyId, soId.get('SO-00001'), stcUnit, adminId]);
    const MILESTONES: [string,string,string|null,number,string][] = [
      ['PP Sample Approval','2026-05-15','2026-05-14',1,'DONE'],
      ['Yarn In-house','2026-05-25','2026-06-02',1,'DONE'],
      ['Fabric Knitting Complete','2026-06-05','2026-06-08',1,'DONE'],
      ['Fabric Dyeing Complete','2026-06-12','2026-06-15',1,'DONE'],
      ['Cutting Start','2026-06-18','2026-06-18',0,'DONE'],
      ['Stitching Start','2026-06-25','2026-06-26',1,'DONE'],
      ['Stitching Complete','2026-07-20',null,1,'ON_TRACK'],
      ['Finishing Complete','2026-07-25',null,0,'PENDING'],
      ['Final Inspection','2026-07-28',null,1,'PENDING'],
      ['Ex-Factory','2026-08-05',null,1,'PENDING'],
    ];
    for (const [ms, planned, actual, critical, st] of MILESTONES) {
      await exec(
        `INSERT INTO trx_plan_milestone (plan_id,milestone,planned_date,actual_date,is_critical,status)
         VALUES (?,?,?,?,?,?)`, [pr.insertId, ms, planned, actual, critical, st]);
    }
  }
  log('production plan with 10 Time & Action milestones');

  // ------------------------------------------------------- notifications
  const notifExists = await one(`SELECT id FROM trx_notification WHERE company_id=?`, [companyId]);
  if (!notifExists) {
    const notes: [string, string][] = [
      ['Order SO-00001 shipped', 'Container MSKU7841239 sailed from Tuticorin on 07 Aug 2026.'],
      ['QC inspection passed', 'WO-00001 cleared final AQL 2.5 inspection.'],
      ['Low stock alert', 'Fabric F-RIB200 is below the reorder level.'],
      ['New enquiry received', 'Decathlon SA raised ENQ-00001 for the AW26 organic programme.'],
    ];
    for (const [title, body] of notes) {
      await exec(`INSERT INTO trx_notification (company_id,user_id,title,body,channel) VALUES (?,?,?,?,'INAPP')`,
        [companyId, adminId, title, body]);
    }
  }
}

try {
  await main();
} catch (err) {
  console.error('[seed] failed:', (err as Error).message);
  console.error((err as Error).stack);
  process.exitCode = 1;
} finally {
  conn.release();
  await pool.end();
}
