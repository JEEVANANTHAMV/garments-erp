/** Reference data and the RBAC catalog. */

export const COUNTRIES: [string, string, string, string][] = [
  ['IN','IND','India','+91'], ['US','USA','United States','+1'], ['GB','GBR','United Kingdom','+44'],
  ['DE','DEU','Germany','+49'], ['FR','FRA','France','+33'], ['IT','ITA','Italy','+39'],
  ['ES','ESP','Spain','+34'], ['NL','NLD','Netherlands','+31'], ['SE','SWE','Sweden','+46'],
  ['DK','DNK','Denmark','+45'], ['AE','ARE','United Arab Emirates','+971'], ['SA','SAU','Saudi Arabia','+966'],
  ['AU','AUS','Australia','+61'], ['CA','CAN','Canada','+1'], ['JP','JPN','Japan','+81'],
  ['CN','CHN','China','+86'], ['BD','BGD','Bangladesh','+880'], ['LK','LKA','Sri Lanka','+94'],
  ['PL','POL','Poland','+48'], ['BE','BEL','Belgium','+32'],
];

export const CURRENCIES: [string, string, string, number][] = [
  ['INR','Indian Rupee','₹',2], ['USD','US Dollar','$',2], ['EUR','Euro','€',2],
  ['GBP','Pound Sterling','£',2], ['AED','UAE Dirham','د.إ',2], ['AUD','Australian Dollar','A$',2],
  ['CAD','Canadian Dollar','C$',2], ['JPY','Japanese Yen','¥',0], ['SEK','Swedish Krona','kr',2],
  ['DKK','Danish Krone','kr',2],
];

export const UOMS: [string, string, string][] = [
  ['PCS','Pieces','QTY'], ['DZN','Dozen','QTY'], ['SET','Set','QTY'], ['PAIR','Pair','QTY'],
  ['KG','Kilogram','WEIGHT'], ['GM','Gram','WEIGHT'], ['TON','Metric Ton','WEIGHT'],
  ['LBS','Pounds','WEIGHT'], ['MTR','Meter','LENGTH'], ['CM','Centimeter','LENGTH'],
  ['INCH','Inch','LENGTH'], ['YRD','Yard','LENGTH'], ['SQM','Square Meter','AREA'],
  ['CONE','Cone','QTY'], ['ROLL','Roll','QTY'], ['BOX','Box','QTY'], ['CTN','Carton','QTY'],
  ['GROSS','Gross (144)','QTY'], ['HR','Hour','TIME'], ['MIN','Minute','TIME'],
];

export const UOM_CONVERSIONS: [string, string, number][] = [
  ['DZN','PCS',12], ['GROSS','PCS',144], ['KG','GM',1000], ['TON','KG',1000],
  ['MTR','CM',100], ['YRD','INCH',36], ['INCH','CM',2.54], ['PAIR','PCS',2],
];

/** domain, code, label, sortOrder, isTerminal */
export const STATUSES: [string, string, string, number, number][] = [
  ['ENQUIRY','NEW','New',1,0], ['ENQUIRY','IN_REVIEW','In Review',2,0],
  ['ENQUIRY','QUOTED','Quoted',3,0], ['ENQUIRY','CONVERTED','Converted to Order',4,1],
  ['ENQUIRY','LOST','Lost',5,1], ['ENQUIRY','CANCELLED','Cancelled',6,1],

  ['STYLE','DEVELOPMENT','In Development',1,0], ['STYLE','ACTIVE','Active',2,0],
  ['STYLE','APPROVED','Approved',3,0], ['STYLE','DISCONTINUED','Discontinued',4,1],

  ['SAMPLE','REQUESTED','Requested',1,0], ['SAMPLE','IN_PROGRESS','In Progress',2,0],
  ['SAMPLE','SUBMITTED','Submitted to Buyer',3,0], ['SAMPLE','APPROVED','Approved',4,1],
  ['SAMPLE','REJECTED','Rejected',5,1],

  ['COSTING','DRAFT','Draft',1,0], ['COSTING','SUBMITTED','Submitted',2,0],
  ['COSTING','APPROVED','Approved',3,1], ['COSTING','REVISED','Revised',4,0],

  ['QUOTATION','DRAFT','Draft',1,0], ['QUOTATION','SENT','Sent to Buyer',2,0],
  ['QUOTATION','NEGOTIATION','Under Negotiation',3,0], ['QUOTATION','ACCEPTED','Accepted',4,1],
  ['QUOTATION','REJECTED','Rejected',5,1], ['QUOTATION','EXPIRED','Expired',6,1],

  ['SALES_ORDER','DRAFT','Draft',1,0], ['SALES_ORDER','PENDING','Pending Approval',2,0],
  ['SALES_ORDER','APPROVED','Approved',3,0], ['SALES_ORDER','IN_PRODUCTION','In Production',4,0],
  ['SALES_ORDER','READY_TO_SHIP','Ready to Ship',5,0], ['SALES_ORDER','SHIPPED','Shipped',6,0],
  ['SALES_ORDER','CLOSED','Closed',7,1], ['SALES_ORDER','CANCELLED','Cancelled',8,1],
  ['SALES_ORDER','ON_HOLD','On Hold',9,0], ['SALES_ORDER','REJECTED','Rejected',10,1],

  ['BOM','DRAFT','Draft',1,0], ['BOM','APPROVED','Approved',2,1], ['BOM','OBSOLETE','Obsolete',3,1],

  ['TECHPACK','RECEIVED','Received',1,0], ['TECHPACK','IN_REVIEW','In Review',2,0],
  ['TECHPACK','APPROVED','Approved',3,1],

  ['MRP','DRAFT','Draft',1,0], ['MRP','COMPLETED','Completed',2,1],

  ['PURCHASE_ORDER','DRAFT','Draft',1,0], ['PURCHASE_ORDER','PENDING','Pending Approval',2,0],
  ['PURCHASE_ORDER','APPROVED','Approved',3,0], ['PURCHASE_ORDER','PARTIAL','Partially Received',4,0],
  ['PURCHASE_ORDER','RECEIVED','Fully Received',5,0], ['PURCHASE_ORDER','CLOSED','Closed',6,1],
  ['PURCHASE_ORDER','CANCELLED','Cancelled',7,1],

  ['GRN','DRAFT','Draft',1,0], ['GRN','POSTED','Posted',2,1], ['GRN','CANCELLED','Cancelled',3,1],

  ['PROD_PLAN','DRAFT','Draft',1,0], ['PROD_PLAN','APPROVED','Approved',2,0],
  ['PROD_PLAN','IN_PROGRESS','In Progress',3,0], ['PROD_PLAN','COMPLETED','Completed',4,1],

  ['PROD_ORDER','DRAFT','Draft',1,0], ['PROD_ORDER','APPROVED','Approved',2,0],
  ['PROD_ORDER','IN_PROGRESS','In Progress',3,0], ['PROD_ORDER','COMPLETED','Completed',4,0],
  ['PROD_ORDER','CLOSED','Closed',5,1], ['PROD_ORDER','CANCELLED','Cancelled',6,1],

  ['PROCESS','PENDING','Pending',1,0], ['PROCESS','IN_PROGRESS','In Progress',2,0],
  ['PROCESS','COMPLETED','Completed',3,1],

  ['QC','PENDING','Pending',1,0], ['QC','PASS','Passed',2,1],
  ['QC','FAIL','Failed',3,1], ['QC','REINSPECT','Re-inspection Required',4,0],

  ['PACKING','DRAFT','Draft',1,0], ['PACKING','IN_PROGRESS','In Progress',2,0],
  ['PACKING','COMPLETED','Completed',3,1],

  ['DISPATCH','PLANNED','Planned',1,0], ['DISPATCH','LOADED','Loaded',2,0],
  ['DISPATCH','DISPATCHED','Dispatched',3,1],

  ['INVOICE','DRAFT','Draft',1,0], ['INVOICE','ISSUED','Issued',2,0],
  ['INVOICE','SUBMITTED_BANK','Submitted to Bank',3,0], ['INVOICE','REALIZED','Realized',4,1],

  ['SHIPPING_BILL','FILED','Filed',1,0], ['SHIPPING_BILL','LEO','Let Export Order',2,0],
  ['SHIPPING_BILL','SHIPPED','Shipped',3,1],

  ['SHIPMENT','BOOKED','Booked',1,0], ['SHIPMENT','SAILED','Sailed',2,0],
  ['SHIPMENT','ARRIVED','Arrived',3,0], ['SHIPMENT','DELIVERED','Delivered',4,1],

  ['CERTIFICATE','PENDING','Pending',1,0], ['CERTIFICATE','ISSUED','Issued',2,1],
];

/** Module tree: code, name, parentCode|null, sortOrder */
export const MODULES: [string, string, string | null, number][] = [
  ['DASHBOARD','Dashboard',null,1],

  ['MASTERS','Master Data',null,10],
  ['COMPANY','Company Setup','MASTERS',11],
  ['BRANCH','Branches','MASTERS',12],
  ['UNIT','Units','MASTERS',13],
  ['WAREHOUSE','Warehouses','MASTERS',14],
  ['PARTY','Business Partners','MASTERS',15],
  ['COLOR','Colors','MASTERS',16],
  ['SIZE','Sizes','MASTERS',17],
  ['MATERIAL','Materials','MASTERS',18],
  ['PRODUCT','Products','MASTERS',19],
  ['STYLE','Styles','MASTERS',20],
  ['BOM','Bill of Materials','MASTERS',21],
  ['FINYEAR','Financial Years','MASTERS',22],

  ['SALES','Sales & Marketing',null,30],
  ['ENQUIRY','Enquiries','SALES',31],
  ['SAMPLE','Sampling','SALES',32],
  ['COSTING','Costing','SALES',33],
  ['QUOTATION','Quotations','SALES',34],
  ['SALES_ORDER','Sales Orders','SALES',35],

  ['PROCUREMENT','Procurement',null,40],
  ['MRP','MRP','PROCUREMENT',41],
  ['PURCHASE','Purchase Orders','PROCUREMENT',42],
  ['GRN','Goods Receipt','PROCUREMENT',43],

  ['GATE','Gate Management',null,45],
  ['GATE_INWARD','Inward Gate Entry','GATE',46],
  ['GATE_OUTWARD','Outward Gate Pass','GATE',47],

  ['INVENTORY','Inventory',null,50],
  ['ISSUE','Material Issue','INVENTORY',51],

  ['PRODUCTION','Production',null,60],

  ['QUALITY','Quality',null,70],
  ['QC','QC Inspections','QUALITY',71],

  ['LOGISTICS','Packing & Dispatch',null,80],
  ['PACKING','Packing','LOGISTICS',81],
  ['DISPATCH','Dispatch','LOGISTICS',82],

  ['EXPORT','Export Documentation',null,90],

  ['FINANCE','Finance',null,100],

  ['REPORTS','Reports & Analytics',null,110],
  ['REPORT','Reports','REPORTS',111],
  ['AUDIT','Audit Trail','REPORTS',112],

  ['ADMIN','Administration',null,120],
  ['USER','Users','ADMIN',121],
  ['ROLE','Roles & Permissions','ADMIN',122],
  ['SETTINGS','Settings','ADMIN',123],
];

/** Modules that receive the standard CRUD verb set. */
const CRUD_MODULES = [
  'COMPANY','BRANCH','UNIT','WAREHOUSE','PARTY','COLOR','SIZE','MATERIAL','PRODUCT',
  'STYLE','BOM','FINYEAR','ENQUIRY','SAMPLE','COSTING','QUOTATION','SALES_ORDER',
  'MRP','PURCHASE','GRN','INVENTORY','ISSUE','PRODUCTION','QC','PACKING','DISPATCH',
  'EXPORT','FINANCE','USER','ROLE','SETTINGS',
];

const VERBS = ['VIEW','CREATE','UPDATE','DELETE'] as const;
const VERB_LABEL: Record<string, string> = {
  VIEW: 'View', CREATE: 'Create', UPDATE: 'Edit', DELETE: 'Delete',
  APPROVE: 'Approve', ADJUST: 'Adjust', EXPORT: 'Export',
};

/** [permissionCode, permissionName, moduleCode] */
export function buildPermissions(): [string, string, string][] {
  const out: [string, string, string][] = [];
  const moduleName = new Map(MODULES.map(([c, n]) => [c, n]));

  for (const m of CRUD_MODULES) {
    for (const v of VERBS) {
      out.push([`${m}.${v}`, `${VERB_LABEL[v]} ${moduleName.get(m) ?? m}`, m]);
    }
  }

  // Extra, non-CRUD permissions.
  const extras: [string, string, string][] = [
    ['DASHBOARD.VIEW','View Dashboard','DASHBOARD'],
    ['REPORT.VIEW','View Reports','REPORT'],
    ['REPORT.EXPORT','Export Reports','REPORT'],
    ['AUDIT.VIEW','View Audit Trail','AUDIT'],
    ['SALES_ORDER.APPROVE','Approve Sales Orders','SALES_ORDER'],
    ['PURCHASE.APPROVE','Approve Purchase Orders','PURCHASE'],
    ['COSTING.APPROVE','Approve Costings','COSTING'],
    ['PRODUCTION.APPROVE','Approve Production Orders','PRODUCTION'],
    ['INVENTORY.ADJUST','Adjust Stock','INVENTORY'],
  ];
  out.push(...extras);
  return out;
}

/** Role definitions: code, name, description, permission matcher. */
export const ROLES: {
  code: string; name: string; description: string;
  /** '*' for everything, otherwise a list of exact codes or MODULE.* wildcards. */
  permissions: '*' | string[];
}[] = [
  {
    code: 'SUPER_ADMIN', name: 'Super Administrator',
    description: 'Unrestricted access to every module and setting',
    permissions: '*',
  },
  {
    code: 'ADMIN', name: 'Administrator',
    description: 'Full operational access plus user administration',
    permissions: [
      'DASHBOARD.*','COMPANY.*','BRANCH.*','UNIT.*','WAREHOUSE.*','PARTY.*','COLOR.*','SIZE.*',
      'MATERIAL.*','PRODUCT.*','STYLE.*','BOM.*','FINYEAR.*','ENQUIRY.*','SAMPLE.*','COSTING.*',
      'QUOTATION.*','SALES_ORDER.*','MRP.*','PURCHASE.*','GRN.*','INVENTORY.*','ISSUE.*',
      'PRODUCTION.*','QC.*','PACKING.*','DISPATCH.*','EXPORT.*','FINANCE.*','REPORT.*',
      'AUDIT.*','USER.*','ROLE.*','SETTINGS.*',
    ],
  },
  {
    code: 'MERCHANDISER', name: 'Merchandiser',
    description: 'Owns the buyer relationship: enquiries, sampling, costing, quotations and orders',
    permissions: [
      'DASHBOARD.VIEW','PARTY.VIEW','PARTY.CREATE','PARTY.UPDATE',
      'STYLE.*','BOM.*','COLOR.VIEW','SIZE.VIEW','MATERIAL.VIEW','PRODUCT.VIEW',
      'ENQUIRY.*','SAMPLE.*','COSTING.VIEW','COSTING.CREATE','COSTING.UPDATE',
      'QUOTATION.*','SALES_ORDER.VIEW','SALES_ORDER.CREATE','SALES_ORDER.UPDATE',
      'MRP.VIEW','PURCHASE.VIEW','PRODUCTION.VIEW','QC.VIEW','PACKING.VIEW',
      'DISPATCH.VIEW','EXPORT.VIEW','REPORT.VIEW','INVENTORY.VIEW',
    ],
  },
  {
    code: 'PRODUCTION_MANAGER', name: 'Production Manager',
    description: 'Plans and runs the factory floor across every process stage',
    permissions: [
      'DASHBOARD.VIEW','STYLE.VIEW','BOM.VIEW','MATERIAL.VIEW','PRODUCT.VIEW','UNIT.VIEW',
      'SALES_ORDER.VIEW','PRODUCTION.*','QC.VIEW','QC.CREATE','ISSUE.VIEW','ISSUE.CREATE',
      'INVENTORY.VIEW','PACKING.VIEW','PACKING.CREATE','REPORT.VIEW','WAREHOUSE.VIEW','PARTY.VIEW',
    ],
  },
  {
    code: 'QC_INSPECTOR', name: 'QC Inspector',
    description: 'Records inline and final inspections and defect data',
    permissions: [
      'DASHBOARD.VIEW','QC.*','PRODUCTION.VIEW','STYLE.VIEW','SALES_ORDER.VIEW',
      'PACKING.VIEW','REPORT.VIEW',
    ],
  },
  {
    code: 'STORE_KEEPER', name: 'Store Keeper',
    description: 'Receives goods, issues material and maintains stock accuracy',
    permissions: [
      'DASHBOARD.VIEW','INVENTORY.*','ISSUE.*','GRN.*','WAREHOUSE.VIEW','MATERIAL.VIEW',
      'PURCHASE.VIEW','PRODUCTION.VIEW','PARTY.VIEW','REPORT.VIEW',
    ],
  },
  {
    code: 'PURCHASE_OFFICER', name: 'Purchase Officer',
    description: 'Runs MRP and manages suppliers and purchase orders',
    permissions: [
      'DASHBOARD.VIEW','MRP.*','PURCHASE.*','GRN.VIEW','GRN.CREATE','PARTY.VIEW','PARTY.CREATE',
      'PARTY.UPDATE','MATERIAL.*','INVENTORY.VIEW','SALES_ORDER.VIEW','BOM.VIEW','REPORT.VIEW',
    ],
  },
  {
    code: 'EXPORT_EXECUTIVE', name: 'Export Executive',
    description: 'Handles packing, dispatch, shipping and export documentation',
    permissions: [
      'DASHBOARD.VIEW','PACKING.*','DISPATCH.*','EXPORT.*','SALES_ORDER.VIEW','PARTY.VIEW',
      'STYLE.VIEW','REPORT.VIEW','FINANCE.VIEW',
    ],
  },
  {
    code: 'ACCOUNTANT', name: 'Accountant',
    description: 'Manages vouchers, receipts, payments and export incentives',
    permissions: [
      'DASHBOARD.VIEW','FINANCE.*','EXPORT.VIEW','SALES_ORDER.VIEW','PURCHASE.VIEW',
      'PARTY.VIEW','REPORT.VIEW','AUDIT.VIEW','FINYEAR.VIEW',
    ],
  },
  {
    code: 'VIEWER', name: 'Read Only',
    description: 'Read-only visibility across operational modules',
    permissions: [
      'DASHBOARD.VIEW','PARTY.VIEW','STYLE.VIEW','BOM.VIEW','MATERIAL.VIEW','PRODUCT.VIEW',
      'ENQUIRY.VIEW','SAMPLE.VIEW','QUOTATION.VIEW','SALES_ORDER.VIEW','PURCHASE.VIEW',
      'INVENTORY.VIEW','PRODUCTION.VIEW','QC.VIEW','PACKING.VIEW','DISPATCH.VIEW',
      'EXPORT.VIEW','REPORT.VIEW',
    ],
  },
];

/** Expand 'MODULE.*' wildcards against the real permission list. */
export function expandPermissions(patterns: '*' | string[], all: string[]): string[] {
  if (patterns === '*') return all;
  const out = new Set<string>();
  for (const p of patterns) {
    if (p.endsWith('.*')) {
      const prefix = p.slice(0, -1);           // 'SALES_ORDER.'
      for (const code of all) if (code.startsWith(prefix)) out.add(code);
    } else if (all.includes(p)) {
      out.add(p);
    }
  }
  return [...out];
}

export const PROCESS_STAGES: [string, string, number, number][] = [
  ['KNIT','Knitting',1,1], ['DYE','Dyeing',2,1], ['CUT','Cutting',3,0],
  ['PRINT','Printing',4,1], ['EMB','Embroidery',5,1], ['STITCH','Stitching',6,1],
  ['WASH','Washing',7,1], ['FINISH','Finishing',8,0], ['PACK','Packing',9,0],
];

export const DEFECTS: [string, string, string, string][] = [
  ['D001','Broken Stitch','MAJOR','STITCH'], ['D002','Skip Stitch','MAJOR','STITCH'],
  ['D003','Open Seam','CRITICAL','STITCH'], ['D004','Puckering','MAJOR','STITCH'],
  ['D005','Uneven Hem','MINOR','STITCH'], ['D006','Loose Thread','MINOR','FINISH'],
  ['D007','Oil Stain','MAJOR','FINISH'], ['D008','Fabric Hole','CRITICAL','CUT'],
  ['D009','Shade Variation','MAJOR','DYE'], ['D010','Print Misalignment','MAJOR','PRINT'],
  ['D011','Print Cracking','MAJOR','PRINT'], ['D012','Wrong Measurement','CRITICAL','STITCH'],
  ['D013','Label Missing','CRITICAL','FINISH'], ['D014','Wrong Label','CRITICAL','FINISH'],
  ['D015','Button Loose','MAJOR','FINISH'], ['D016','Zipper Defect','MAJOR','FINISH'],
  ['D017','Needle Damage','CRITICAL','STITCH'], ['D018','Fabric Slub','MINOR','KNIT'],
  ['D019','Barre Mark','MAJOR','KNIT'], ['D020','Wrong Packing','MAJOR','PACK'],
];

export const CERT_TYPES: [string, string, string][] = [
  ['COO','Certificate of Origin','Chamber of Commerce'],
  ['GSP','GSP Form A','Export Inspection Council'],
  ['GOTS','Global Organic Textile Standard','Control Union'],
  ['OEKOTEX','OEKO-TEX Standard 100','Hohenstein'],
  ['FUMIGATION','Fumigation Certificate','Licensed Fumigator'],
  ['INSURANCE','Marine Insurance Certificate','Insurer'],
  ['PHYTO','Phytosanitary Certificate','Plant Quarantine'],
  ['BCI','Better Cotton Initiative','BCI'],
];

/** Chart of accounts: code, name, group, isBank */
export const LEDGER_ACCOUNTS: [string, string, string, number][] = [
  ['1000','Current Assets','ASSET',0], ['1100','Cash in Hand','ASSET',0],
  ['1200','Bank Accounts','ASSET',1], ['1210','Export Current Account','ASSET',1],
  ['1300','Accounts Receivable','ASSET',0], ['1400','Inventory - Raw Material','ASSET',0],
  ['1410','Inventory - WIP','ASSET',0], ['1420','Inventory - Finished Goods','ASSET',0],
  ['1500','GST Input Credit','ASSET',0], ['1600','Export Incentive Receivable','ASSET',0],
  ['2000','Current Liabilities','LIABILITY',0], ['2100','Accounts Payable','LIABILITY',0],
  ['2200','GST Payable','LIABILITY',0], ['2300','Salary Payable','LIABILITY',0],
  ['3000','Share Capital','EQUITY',0], ['3100','Retained Earnings','EQUITY',0],
  ['4000','Export Sales','INCOME',0], ['4100','Domestic Sales','INCOME',0],
  ['4200','Duty Drawback Income','INCOME',0], ['4300','RoDTEP Income','INCOME',0],
  ['5000','Raw Material Consumed','EXPENSE',0], ['5100','Jobwork Charges','EXPENSE',0],
  ['5200','Direct Labour','EXPENSE',0], ['5300','Factory Overheads','EXPENSE',0],
  ['5400','Freight & Forwarding','EXPENSE',0], ['5500','Agent Commission','EXPENSE',0],
  ['5600','Administrative Expenses','EXPENSE',0], ['5700','Bank Charges','EXPENSE',0],
];

export const TAX_RATES: [string, string, number, number, number][] = [
  ['61091000','T-shirts, singlets, knitted cotton',5,2.5,2.5],
  ['61051010','Men\'s shirts, knitted cotton',5,2.5,2.5],
  ['61103000','Sweatshirts, man-made fibres',5,2.5,2.5],
  ['61046200','Women\'s trousers, knitted cotton',5,2.5,2.5],
  ['52051110','Cotton yarn, single, uncombed',5,2.5,2.5],
  ['60062200','Knitted fabric, dyed cotton',5,2.5,2.5],
  ['96072000','Slide fasteners (zippers)',12,6,6],
  ['96061000','Press fasteners, buttons',18,9,9],
  ['48191010','Cartons, boxes of corrugated paper',12,6,6],
];

export const NUMBER_SERIES: [string, string][] = [
  ['ENQUIRY','ENQ-'], ['SAMPLE','SMP-'], ['COSTING','CST-'], ['QUOTATION','QTN-'],
  ['SALES_ORDER','SO-'], ['BOM','BOM-'], ['TECHPACK','TP-'], ['MRP','MRP-'],
  ['PURCHASE_ORDER','PO-'], ['GRN','GRN-'], ['GATE_INWARD','IGP-'], ['GATE_OUTWARD','OGP-'],
  ['MAT_ISSUE','ISS-'], ['PROD_PLAN','PLN-'],
  ['PROD_ORDER','WO-'], ['PROCESS_TXN','PRC-'], ['CUTTING','CUT-'], ['PRINTING','PRT-'],
  ['EMBROIDERY','EMB-'], ['WASHING','WSH-'], ['STITCHING','STC-'], ['FINISHING','FIN-'],
  ['QC','QC-'], ['PACKING','PCK-'], ['DISPATCH','DSP-'], ['INVOICE','INV-'],
  ['PACKING_LIST','PL-'], ['SHIPPING_BILL','SB-'], ['SHIPMENT','SHP-'],
  ['VOUCHER','VCH-'], ['RECEIPT','RCP-'], ['PAYMENT','PAY-'],
  ['DAILY_PLAN','DP-'], ['DAILY_OUTPUT','DPO-'], ['LINE_ALLOC','LA-'], ['SEW_OP','SOP-'],
  ['JW_CHALLAN','JWC-'], ['JW_RECEIPT','JWR-'], ['JW_IN','JWI-'], ['JW_INVOICE','JINV-'],
  ['PURCHASE_RETURN','PR-'], ['SUPPLIER_BILL','BILL-'], ['STOCK_TRANSFER','STX-'],
  ['FG_RECEIPT','FGR-'], ['PROD_COST','PCST-'],
];
