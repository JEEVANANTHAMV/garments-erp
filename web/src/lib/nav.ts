import type { LucideIcon } from 'lucide-react';
import {
  LayoutDashboard, ShieldCheck, Building2, Users, Palette, Ruler, Package, Shirt, Layers,
  FileText, Beaker, Calculator, FileSpreadsheet, ShoppingCart, Boxes, Truck,
  Factory, Scissors, ClipboardCheck, PackageCheck, Ship, Receipt, Landmark,
  BarChart3, Shield, Settings, Warehouse, GitBranch, CalendarClock, FileCheck2,
  History, Wallet, TrendingUp, Container, Coins, SlidersHorizontal, Search,
  Activity, RefreshCw, ShieldAlert, Workflow, ListChecks, HandCoins, ClipboardList, Gauge,
} from 'lucide-react';

export interface NavItem {
  label: string;
  to: string;
  icon: LucideIcon;
  /** Item is shown when the user holds any of these permissions. */
  perms: string[];
  /** Kept routable but off the menu (old screens, or screens reached through tabs of another screen). */
  hidden?: boolean;
  /** Hidden screen that is part of a menu screen (a tab of it): the sidebar and step bar show that screen. */
  parent?: string;
  /** Shown only when this admin menu switch (cfg_system_setting MENU_*) is on. */
  flag?: string;
}
export interface NavSection {
  label: string;
  items: NavItem[];
}

/**
 * Sidebar in the order the work happens — order → purchase → gate & stores → yarn / knitting → fabric process →
 * cutting → stitching → checking / ironing / packing → embroidery & printing → shipment, then job work, finance,
 * reports and the masters at the bottom (client call 14-Oct-2026). A user follows it top to bottom.
 */
export const NAV: NavSection[] = [
  {
    label: 'Overview',
    items: [
      { label: 'Dashboard', to: '/', icon: LayoutDashboard, perms: ['DASHBOARD.VIEW'] },
    ],
  },
  {
    label: '1 · Orders',
    items: [
      { label: 'Enquiries',          to: '/sales/enquiries', icon: FileText, perms: ['ENQUIRY.VIEW'] },
      { label: 'Samples',            to: '/sales/samples', icon: Beaker, perms: ['SAMPLE.VIEW'] },
      { label: 'Styles',             to: '/masters/styles', icon: Shirt, perms: ['STYLE.VIEW'] },
      { label: 'Pre-Costing',        to: '/sales/pre-costings', icon: Calculator, perms: ['COSTING.VIEW'] },
      { label: 'Quotations',         to: '/sales/quotations', icon: FileSpreadsheet, perms: ['QUOTATION.VIEW'] },
      { label: 'Sales Orders',       to: '/sales/orders', icon: ShoppingCart, perms: ['SALES_ORDER.VIEW'] },
      { label: 'Bill of Materials',  to: '/masters/boms', icon: Layers, perms: ['BOM.VIEW'] },
      { label: 'T&A Order Tracking', to: '/tna', icon: CalendarClock, perms: ['SALES_ORDER.VIEW', 'PRODUCTION.VIEW'] },
      { label: 'T&A Risk Dashboard', to: '/tna/dashboard', icon: ShieldAlert, perms: ['SALES_ORDER.VIEW', 'PRODUCTION.VIEW'] },
      { label: 'Production Orders',  to: '/production/orders', icon: Factory, perms: ['PRODUCTION.VIEW'] },
    ],
  },
  {
    label: '2 · Purchase',
    items: [
      { label: 'MRP Runs',             to: '/procurement/mrp', icon: TrendingUp, perms: ['MRP.VIEW'] },
      { label: 'Yarn POs',             to: '/procurement/yarn/orders', icon: GitBranch, perms: ['PURCHASE.VIEW'] },
      { label: 'Yarn GRN',             to: '/procurement/yarn/grn', icon: PackageCheck, perms: ['GRN.VIEW'] },
      { label: 'Fabric POs',           to: '/procurement/fabric/orders', icon: Layers, perms: ['PURCHASE.VIEW'] },
      { label: 'Fabric GRN & Rolls',   to: '/procurement/fabric/grn', icon: PackageCheck, perms: ['GRN.VIEW'] },
      { label: 'Trim POs',             to: '/procurement/trim/orders', icon: Scissors, perms: ['PURCHASE.VIEW'] },
      { label: 'Trim GRN & Stock',     to: '/procurement/trim/grn', icon: PackageCheck, perms: ['GRN.VIEW'] },
      { label: 'General PO & GRN',     to: '/procurement/general-purchases', icon: Receipt, perms: ['PURCHASE.VIEW'] },
      { label: 'Purchase Orders (All)', to: '/procurement/purchase-orders', icon: ShoppingCart, perms: ['PURCHASE.VIEW'] },
      { label: 'Goods Receipt (All)',  to: '/procurement/grns', icon: PackageCheck, perms: ['GRN.VIEW'] },
      { label: 'Bills Inward',         to: '/procurement/supplier-bills', icon: Receipt, perms: ['PURCHASE.VIEW'] },
      { label: 'GRN Bill Status',      to: '/procurement/grn-bill-status', icon: Receipt, perms: ['GRN.VIEW', 'PURCHASE.VIEW'] },
      { label: 'Bill Tracker',         to: '/stores/bill-tracker', icon: FileCheck2, perms: ['FINANCE.VIEW', 'PURCHASE.VIEW', 'GRN.VIEW'] },
      { label: 'Special Requests',     to: '/stores/special-requests', icon: ShieldAlert, perms: ['PURCHASE.VIEW'] },
      { label: 'Purchase Returns',     to: '/procurement/returns', icon: Truck, perms: ['PURCHASE.VIEW'] },
      { label: 'Purchase Excess Limits', to: '/procurement/purchase-excess', icon: ShieldCheck, perms: ['PURCHASE.VIEW', 'PROCUREMENT.VIEW'] },
    ],
  },
  {
    label: '3 · Gate & Stores',
    items: [
      { label: 'Inward Gate Entry',  to: '/gate/inwards', icon: Truck, perms: ['GATE_INWARD.VIEW'] },
      { label: 'Outward Gate Pass',  to: '/gate/outwards', icon: Shield, perms: ['GATE_OUTWARD.VIEW'] },
      { label: 'Stock on Hand',      to: '/inventory/stock', icon: Boxes, perms: ['INVENTORY.VIEW'] },
      { label: 'Yarn Stock List',    to: '/procurement/yarn/stock', icon: Boxes, perms: ['INVENTORY.VIEW'] },
      { label: 'Fabric Roll Stock',  to: '/procurement/fabric/roll-stock', icon: Boxes, perms: ['INVENTORY.VIEW'] },
      { label: 'Material Issue',     to: '/inventory/issues', icon: PackageCheck, perms: ['ISSUE.VIEW'] },
      { label: 'Stock Transfers',    to: '/inventory/transfers', icon: Truck, perms: ['INVENTORY.VIEW'] },
      { label: 'Job Stock Transfer', to: '/inventory/job-transfers', icon: GitBranch, perms: ['INVENTORY.VIEW'] },
      { label: 'Stock Ledger',       to: '/inventory/ledger', icon: History, perms: ['INVENTORY.VIEW'] },
      { label: 'Batches',            to: '/inventory/batches', icon: Container, perms: ['INVENTORY.VIEW'] },
      { label: 'Opening Stock',      to: '/stores/opening-stock', icon: Boxes, perms: ['INVENTORY.VIEW'] },
      { label: 'Stock Audit',        to: '/stores/stock-audit', icon: ClipboardList, perms: ['INVENTORY.VIEW'] },
      { label: 'Stock Delivery',     to: '/stores/stock-delivery', icon: Truck, perms: ['INVENTORY.VIEW'] },
      { label: 'General Delivery',   to: '/stores/general-delivery', icon: Truck, perms: ['INVENTORY.VIEW', 'GATE_OUTWARD.VIEW'] },
      { label: 'Scrap & Rejection',  to: '/stores/scrap-rejection', icon: ShieldAlert, perms: ['INVENTORY.VIEW', 'QC.VIEW'] },
    ],
  },
  {
    label: '4 · Yarn & Knitting',
    items: [
      { label: 'Knitting Programs',            to: '/production/knitting-programs', icon: Layers, perms: ['PRODUCTION.VIEW'] },
      { label: 'Yarn Process – Outward DC',    to: '/production/yarn-process/outward', icon: Truck, perms: ['YARN_PROCESS.VIEW'] },
      { label: 'Yarn Process – Inward / GRN',  to: '/production/yarn-process/inward', icon: PackageCheck, perms: ['YARN_PROCESS.VIEW'] },
      { label: 'Yarn Process – Return',        to: '/production/yarn-process/returns', icon: ShieldAlert, perms: ['YARN_PROCESS.VIEW'] },
      { label: 'Yarn Process – Reprocess',     to: '/production/yarn-process/reprocess', icon: RefreshCw, perms: ['YARN_PROCESS.VIEW'] },
      { label: 'Yarn Cone / Lot Tracking',     to: '/production/yarn-process/cone-tracking', icon: History, perms: ['YARN_PROCESS.VIEW'] },
      // "alternate yarn" in the client's words: use another job's / count's yarn in an emergency, with approval (call 15-Oct-2026)
      { label: 'Yarn Substitution (Alternate Yarn)', to: '/production/yarn-substitution', icon: GitBranch, perms: ['PRODUCTION.VIEW', 'INVENTORY.VIEW', 'YARN_SUBSTITUTION.VIEW'] },
      { label: 'Collar Knitting',              to: '/production/collar-knitting', icon: Shirt, perms: ['PRODUCTION.VIEW'] },
      { label: 'Collar – Yarn Issue / QC', to: '/production/process-execution', icon: ClipboardCheck, perms: ['PRODUCTION.VIEW'] },
    ],
  },
  {
    label: '5 · Fabric Process',
    items: [
      { label: 'Fabric Process – Outward DC',   to: '/production/fabric-process/outward', icon: Truck, perms: ['FABRIC_PROCESS.VIEW'] },
      { label: 'Fabric Process – Inward / GRN', to: '/production/fabric-process/inward', icon: PackageCheck, perms: ['FABRIC_PROCESS.VIEW'] },
      { label: 'Fabric Process – Return',       to: '/production/fabric-process/returns', icon: ShieldAlert, perms: ['FABRIC_PROCESS.VIEW'] },
      { label: 'Fabric Process – Reprocess',    to: '/production/fabric-process/reprocess', icon: RefreshCw, perms: ['FABRIC_PROCESS.VIEW'] },
      { label: 'Fabric Roll Tracking',          to: '/production/fabric-process/tracking', icon: History, perms: ['FABRIC_PROCESS.VIEW'] },
      { label: 'Fabric GSM & Meter',            to: '/production/fabric-gsm-meter', icon: Ruler, perms: ['MATERIAL.VIEW', 'INVENTORY.VIEW', 'PRODUCTION.VIEW'] },
    ],
  },
  {
    label: '6 · Cutting',
    items: [
      { label: 'CAD Auto-Consumption',        to: '/production/cad-requirements', icon: Scissors, perms: ['PRODUCTION.VIEW'] },
      { label: 'Cutting Plans',               to: '/production/cutting-plans', icon: Scissors, perms: ['PRODUCTION.VIEW'] },
      { label: 'Fabric Issues',               to: '/production/fabric-issues', icon: Beaker, perms: ['PRODUCTION.VIEW'] },
      { label: 'Lay Plan & Marker Execution', to: '/production/lay-spreading', icon: Layers, perms: ['PRODUCTION.VIEW'] },
      { label: 'Cut QC & Bundles',            to: '/production/cut-qc-bundles', icon: Scissors, perms: ['PRODUCTION.VIEW'] },
      { label: 'Cutting Reconciliation',      to: '/production/cutting-reconciliation', icon: Calculator, perms: ['PRODUCTION.VIEW'] },
    ],
  },
  {
    label: '7 · Stitching',
    items: [
      { label: 'Sewing Line Allocation', to: '/production/sewing-line-allocation', icon: GitBranch, perms: ['PRODUCTION.VIEW'] },
      { label: 'Sewing Daily Plan',      to: '/production/sewing-daily-plan', icon: CalendarClock, perms: ['PRODUCTION.VIEW'] },
      { label: 'Process Outward (DC)',   to: '/production/jobwork-challans', icon: Truck, perms: ['PRODUCTION.VIEW'] },
      { label: 'Process Inward',         to: '/production/jobwork-receipts', icon: PackageCheck, perms: ['PRODUCTION.VIEW'] },
      { label: 'Operation Status',       to: '/production/operation-status', icon: Gauge, perms: ['PRODUCTION.VIEW'] },
      { label: 'Daily Output – Sewing',  to: '/production/sewing-daily-output', icon: ClipboardCheck, perms: ['PRODUCTION.VIEW'] },
      { label: 'Sewing & Finishing Floor', to: '/production/sewing-finishing', icon: Factory, perms: ['PRODUCTION.VIEW'] },
    ],
  },
  {
    label: '8 · Checking · Ironing · Packing',
    items: [
      { label: 'Checking Line Allocation', to: '/production/checking-line-allocation', icon: GitBranch, perms: ['PRODUCTION.VIEW'] },
      { label: 'Checking Daily Plan',      to: '/production/checking-daily-plan', icon: CalendarClock, perms: ['PRODUCTION.VIEW'] },
      { label: 'Checking Entry (QC)',      to: '/production/checking-qc-entry', icon: ClipboardCheck, perms: ['PRODUCTION.VIEW'] },
      // random AQL line checks — kept off until the client needs it (Admin → Settings → MENU_SHOW_LINE_QC)
      { label: 'Line QC (AQL)',            to: '/quality/inspections', icon: ClipboardCheck, perms: ['QC.VIEW'], flag: 'MENU_SHOW_LINE_QC' },
      { label: 'Ironing Line Allocation',  to: '/production/ironing-line-allocation', icon: GitBranch, perms: ['PRODUCTION.VIEW'] },
      { label: 'Ironing Daily Plan',       to: '/production/ironing-daily-plan', icon: CalendarClock, perms: ['PRODUCTION.VIEW'] },
      { label: 'Packing Line Allocation',  to: '/production/packing-line-allocation', icon: GitBranch, perms: ['PRODUCTION.VIEW'] },
      { label: 'Packing Daily Plan',       to: '/production/packing-daily-plan', icon: CalendarClock, perms: ['PRODUCTION.VIEW'] },
      { label: 'FG Receipts',              to: '/production/fg-receipts', icon: PackageCheck, perms: ['PRODUCTION.VIEW'] },
      // packing engine (client developer doc 14-Oct-2026): order → polybag / piece entry → carton box entry → verify / seal → post
      { label: 'Packing Orders',           to: '/logistics/packing/orders', icon: PackageCheck, perms: ['PACKING.VIEW'] },
      { label: 'Individual Piece / Polybag Entry', to: '/logistics/packing/polybag', icon: Package, perms: ['PACKING.CREATE'] },
      { label: 'Carton Box Entry',         to: '/logistics/packing/cartons', icon: Boxes, perms: ['PACKING.CREATE'] },
      { label: 'Carton Verify / Seal',     to: '/logistics/packing/verify', icon: ShieldCheck, perms: ['PACKING.UPDATE'] },
      { label: 'Packing Reports',          to: '/logistics/packing/reports', icon: BarChart3, perms: ['PACKING.VIEW'] },
      { label: 'Packing Lists',            to: '/logistics/packing-lists', icon: FileCheck2, perms: ['PACKING.VIEW', 'EXPORT.VIEW'] },
    ],
  },
  {
    label: '9 · Embroidery & Printing',
    items: [
      { label: 'Embroidery – Machine Output & Cost', to: '/production/embroidery', icon: Palette, perms: ['EMBROIDERY.VIEW'] },
      { label: 'Printing – Machine Output & Cost',   to: '/production/printing', icon: Palette, perms: ['PRINTING.VIEW'] },
    ],
  },
  {
    label: '10 · Shipment & Export',
    items: [
      { label: 'Shipment Planning',   to: '/logistics/shipment-plans', icon: CalendarClock, perms: ['PACKING.VIEW', 'EXPORT.VIEW'] },
      { label: 'Shipments',           to: '/logistics/shipments', icon: Ship, perms: ['PACKING.VIEW', 'EXPORT.VIEW'] },
      { label: 'Dispatch',            to: '/logistics/dispatches', icon: Truck, perms: ['DISPATCH.VIEW'] },
      { label: 'Containers',          to: '/logistics/containers', icon: Container, perms: ['DISPATCH.VIEW'] },
      { label: 'Commercial Invoices', to: '/export/invoices', icon: Receipt, perms: ['EXPORT.VIEW'] },
      { label: 'Shipping Bills',      to: '/export/shipping-bills', icon: FileText, perms: ['EXPORT.VIEW'] },
      { label: 'Certificates',        to: '/export/certificates', icon: FileCheck2, perms: ['EXPORT.VIEW'] },
    ],
  },
  {
    label: '11 · Job Work & Contractors',
    items: [
      { label: 'Job Work Orders',        to: '/production/job-work-orders', icon: ClipboardList, perms: ['PRODUCTION.VIEW'] },
      { label: 'Job Work Dashboard',     to: '/production/job-work-dashboard', icon: Gauge, perms: ['PRODUCTION.VIEW'] },
      { label: 'Job Work In',            to: '/production/jobwork-ins', icon: Factory, perms: ['PRODUCTION.VIEW'] },
      { label: 'Job Work Invoices',      to: '/production/jobwork-invoices', icon: Receipt, perms: ['PRODUCTION.VIEW'] },
      { label: 'Contractor Accounts',    to: '/production/contractor-accounts', icon: HandCoins, perms: ['PRODUCTION.VIEW'] },
      { label: 'Contractor Advances',    to: '/production/contractor-advances', icon: HandCoins, perms: ['PRODUCTION.VIEW'] },
      { label: 'Contractor Debit Notes', to: '/production/contractor-debit-notes', icon: HandCoins, perms: ['PRODUCTION.VIEW'] },
    ],
  },
  {
    label: '12 · Finance',
    items: [
      { label: 'Vouchers',          to: '/finance/vouchers', icon: Landmark, perms: ['FINANCE.VIEW'] },
      { label: 'Receipts',          to: '/finance/receipts', icon: Wallet, perms: ['FINANCE.VIEW'] },
      { label: 'Payments',          to: '/finance/payments', icon: Coins, perms: ['FINANCE.VIEW'] },
      { label: 'Export Incentives', to: '/finance/incentives', icon: TrendingUp, perms: ['FINANCE.VIEW'] },
    ],
  },
  {
    label: '13 · Reports',
    items: [
      { label: 'WIP Stock Value',        to: '/production/wip-stock-value', icon: Coins, perms: ['PRODUCTION.VIEW'] },
      { label: 'Production Costing',     to: '/production/costs', icon: Calculator, perms: ['PRODUCTION.VIEW'] },
      { label: 'Planning Reports',       to: '/production/planning-reports', icon: BarChart3, perms: ['PRODUCTION.VIEW'] },
      { label: 'Cutting Reports',        to: '/production/cutting-reports', icon: BarChart3, perms: ['PRODUCTION.VIEW'] },
      { label: 'Process Reports',        to: '/production/process-reports', icon: BarChart3, perms: ['PRODUCTION.VIEW'] },
      { label: 'Yarn Process Ledger & Reports', to: '/production/yarn-process/reports', icon: BarChart3, perms: ['YARN_PROCESS.VIEW'] },
      { label: 'Fabric Process Ledger',  to: '/production/fabric-process/ledger', icon: BarChart3, perms: ['FABRIC_PROCESS.VIEW'] },
      { label: 'Fabric Process Reports', to: '/production/fabric-process/reports', icon: BarChart3, perms: ['FABRIC_PROCESS.VIEW'] },
      { label: 'Genealogy Reports',      to: '/production/genealogy-reports', icon: Workflow, perms: ['PRODUCTION.VIEW'] },
      { label: 'Traceability Search',    to: '/production/traceability', icon: Search, perms: ['PRODUCTION.VIEW'] },
      { label: 'Material Traceability (Yarn / Fabric)', to: '/production/material-trace', icon: Workflow, perms: ['PRODUCTION.VIEW'] },
      { label: 'Reports',                to: '/reports', icon: BarChart3, perms: ['REPORT.VIEW'] },
      { label: 'Client Reports – Orders & Production', to: '/reports/client-a', icon: FileSpreadsheet, perms: ['REPORT.VIEW'] },
      { label: 'Client Reports – Purchase & Stores',   to: '/reports/client-b', icon: FileSpreadsheet, perms: ['REPORT.VIEW'] },
      { label: 'Audit Trail',            to: '/reports/audit', icon: History, perms: ['AUDIT.VIEW'] },
    ],
  },
  {
    label: '14 · Masters & Setup',
    items: [
      { label: 'Business Partners',  to: '/masters/parties', icon: Users, perms: ['PARTY.VIEW'] },
      { label: 'Products',           to: '/masters/products', icon: Package, perms: ['PRODUCT.VIEW'] },
      { label: 'Yarns',              to: '/masters/yarns', icon: GitBranch, perms: ['MATERIAL.VIEW'] },
      { label: 'Yarn Counts',        to: '/masters/yarn-counts', icon: SlidersHorizontal, perms: ['MATERIAL.VIEW'] },
      { label: 'Fabrics',            to: '/masters/fabrics', icon: Layers, perms: ['MATERIAL.VIEW'] },
      { label: 'GSM Master',         to: '/masters/gsm', icon: SlidersHorizontal, perms: ['MATERIAL.VIEW'] },
      { label: 'Tube Dia Master',    to: '/masters/dias', icon: Ruler, perms: ['MATERIAL.VIEW'] },
      { label: 'Trims',              to: '/masters/trims', icon: Package, perms: ['MATERIAL.VIEW'] },
      { label: 'Colors',             to: '/masters/colors', icon: Palette, perms: ['COLOR.VIEW'] },
      { label: 'Size Groups',        to: '/masters/size-groups', icon: Ruler, perms: ['SIZE.VIEW'] },
      { label: 'Warehouses',         to: '/masters/warehouses', icon: Warehouse, perms: ['WAREHOUSE.VIEW'] },
      { label: 'Bins & Racks',       to: '/masters/warehouse-bins', icon: Boxes, perms: ['WAREHOUSE.VIEW'] },
      { label: 'Departments',        to: '/masters/departments', icon: Building2, perms: ['UNIT.VIEW'] },
      { label: 'Branches & Units',   to: '/masters/branches', icon: Building2, perms: ['BRANCH.VIEW', 'UNIT.VIEW'] },
      { label: 'Divisions',          to: '/masters/divisions', icon: Building2, perms: ['UNIT.VIEW'] },
      { label: 'Production Lines',   to: '/production/sewing-lines', icon: SlidersHorizontal, perms: ['PRODUCTION.VIEW'] },
      { label: 'Process & Operations', to: '/production/process-master', icon: ListChecks, perms: ['PRODUCTION.VIEW'] },
      { label: 'Production Rate Fixing (Job Rate Card)', to: '/production/job-rate-cards', icon: ListChecks, perms: ['PRODUCTION.VIEW'] },
      { label: 'Job Work Rates',     to: '/production/job-work-rates', icon: ListChecks, perms: ['PRODUCTION.VIEW'] },
      { label: 'Yarn Process Types', to: '/production/yarn-process/types', icon: SlidersHorizontal, perms: ['YARN_PROCESS.VIEW'] },
      { label: 'Fabric Process Types & QC', to: '/production/fabric-process/masters', icon: SlidersHorizontal, perms: ['FABRIC_PROCESS.VIEW'] },
      { label: 'Packing Rules',      to: '/logistics/packing/rules', icon: ListChecks, perms: ['PACKING.VIEW'] },
      { label: 'Defect Master',      to: '/quality/defects', icon: Shield, perms: ['QC.VIEW'] },
      { label: 'T&A Templates',      to: '/tna/templates', icon: Layers, perms: ['SALES_ORDER.VIEW', 'PRODUCTION.VIEW'] },
      { label: 'Ledger Accounts',    to: '/finance/ledger-accounts', icon: Landmark, perms: ['FINANCE.VIEW'] },
      { label: 'Tax Rates',          to: '/finance/tax-rates', icon: Receipt, perms: ['FINANCE.VIEW'] },
    ],
  },
  {
    label: 'Administration',
    items: [
      { label: 'Users',    to: '/admin/users', icon: Users, perms: ['USER.VIEW'] },
      { label: 'Roles',    to: '/admin/roles', icon: Shield, perms: ['ROLE.VIEW'] },
      { label: 'Company',  to: '/admin/company', icon: Building2, perms: ['COMPANY.VIEW'] },
      { label: 'Settings', to: '/admin/settings', icon: Settings, perms: ['SETTINGS.VIEW'] },
      { label: 'Menu Access', to: '/admin/menu-access', icon: SlidersHorizontal, perms: ['ROLE.VIEW', 'SETTINGS.VIEW'] },
    ],
  },
  {
    // Routable but off the menu: older screens, and line masters reached through the tabs of "Production Lines".
    label: 'More screens',
    items: [
      { label: 'Checking Lines',  to: '/production/checking-lines', icon: SlidersHorizontal, perms: ['PRODUCTION.VIEW'], hidden: true, parent: '/production/sewing-lines' },
      { label: 'Ironing Lines',   to: '/production/ironing-lines', icon: SlidersHorizontal, perms: ['PRODUCTION.VIEW'], hidden: true, parent: '/production/sewing-lines' },
      { label: 'Packing Lines',   to: '/production/packing-lines', icon: SlidersHorizontal, perms: ['PRODUCTION.VIEW'], hidden: true, parent: '/production/sewing-lines' },
      { label: 'Yarn Processing', to: '/production/knitting', icon: Activity, perms: ['PRODUCTION.VIEW'], hidden: true },
      { label: 'Process Routes',  to: '/production/process-routes', icon: Workflow, perms: ['PRODUCTION.VIEW'], hidden: true },
      { label: 'Yarn Processing (D/W/T)', to: '/production/yarn-processes', icon: Beaker, perms: ['PRODUCTION.VIEW'], hidden: true },
      { label: 'Yarn Process – Contractor Bill', to: '/production/yarn-process/bills', icon: Receipt, perms: ['YARN_PROCESS.VIEW'], hidden: true, parent: '/procurement/supplier-bills' },
      { label: 'Fabric Process – Contractor Bill', to: '/production/fabric-process/bills', icon: Receipt, perms: ['FABRIC_PROCESS.VIEW'], hidden: true, parent: '/procurement/supplier-bills' },
      { label: 'Daily Plans',        to: '/production/daily-plans', icon: CalendarClock, perms: ['PRODUCTION.VIEW'], hidden: true },
      { label: 'Daily Output Entry', to: '/production/daily-outputs', icon: ClipboardCheck, perms: ['PRODUCTION.VIEW'], hidden: true },
      { label: 'Line Allocations',   to: '/production/line-allocations', icon: GitBranch, perms: ['PRODUCTION.VIEW'], hidden: true },
      { label: 'Cutting',            to: '/production/cuttings', icon: Scissors, perms: ['PRODUCTION.VIEW'], hidden: true },
      { label: 'Stitching',          to: '/production/stitchings', icon: Factory, perms: ['PRODUCTION.VIEW'], hidden: true },
      { label: 'Printing',           to: '/production/printings', icon: Palette, perms: ['PRODUCTION.VIEW'], hidden: true },
      { label: 'Embroidery',         to: '/production/embroideries', icon: Palette, perms: ['PRODUCTION.VIEW'], hidden: true },
      { label: 'Washing',            to: '/production/washings', icon: Beaker, perms: ['PRODUCTION.VIEW'], hidden: true },
      { label: 'Finishing',          to: '/production/finishings', icon: PackageCheck, perms: ['PRODUCTION.VIEW'], hidden: true },
      { label: 'Process Movements',  to: '/production/process-transactions', icon: GitBranch, perms: ['PRODUCTION.VIEW'], hidden: true },
      { label: 'Contractor Bills',   to: '/production/contractor-bills', icon: HandCoins, perms: ['PRODUCTION.VIEW'], hidden: true, parent: '/procurement/supplier-bills' },
      { label: 'Packing (old)',      to: '/logistics/packings', icon: PackageCheck, perms: ['PACKING.VIEW'], hidden: true, parent: '/logistics/packing/orders' },
      // Duplicates removed from the menu 14-Oct-2026 (each replaced by the screen in brackets)
      { label: 'General POs',        to: '/procurement/general-orders', icon: ShoppingCart, perms: ['PURCHASE.VIEW'], hidden: true, parent: '/procurement/general-purchases' }, // PO tab
      { label: 'Production Plans',   to: '/production/plans', icon: CalendarClock, perms: ['PRODUCTION.VIEW'], hidden: true },          // T&A Order Tracking
      { label: 'WIP Dashboard',      to: '/production/wip', icon: BarChart3, perms: ['PRODUCTION.VIEW'], hidden: true },                // WIP Stock Value / Operation Status
      { label: 'Sewing Operations',  to: '/production/sewing-operations', icon: Scissors, perms: ['PRODUCTION.VIEW'], hidden: true },  // Process & Operations
    ],
  },
];

/** Every menu screen by path (favourites / recent show the label and icon). */
export const NAV_BY_PATH = new Map(NAV.flatMap((s) => s.items.map((i) => [i.to, i] as [string, NavItem])));

/**
 * The menu screen a page belongs to: the longest menu path the URL starts with (so /tna/dashboard is
 * "T&A Risk Dashboard", not "T&A Order Tracking"; /procurement/yarn/orders/12 is "Yarn POs"), with a hidden
 * tab screen resolved to its parent. `detail` is true below the list (an open document).
 */
export function matchNav(pathname: string): { item: NavItem; detail: boolean } | null {
  let best: NavItem | null = null;
  for (const i of NAV_BY_PATH.values()) {
    const hit = i.to === '/' ? pathname === '/' : pathname === i.to || pathname.startsWith(`${i.to}/`);
    if (hit && (!best || i.to.length > best.to.length)) best = i;
  }
  if (!best) return null;
  const detail = pathname !== best.to;
  const shown = best.parent ? NAV_BY_PATH.get(best.parent) ?? best : best;
  return { item: shown, detail };
}

/**
 * Screens that are one screen with tabs — Sewing / Checking / Ironing / Packing versions of the same page.
 * The tab strip shows above any of them; the menu lists the first (or each, where it is a step of the flow).
 */
export const PROCESS_TABS: { key: string; tabs: { label: string; to: string }[] }[] = [
  { key: 'lines', tabs: [
    { label: 'Sewing', to: '/production/sewing-lines' }, { label: 'Checking', to: '/production/checking-lines' },
    { label: 'Ironing', to: '/production/ironing-lines' }, { label: 'Packing', to: '/production/packing-lines' }] },
  { key: 'alloc', tabs: [
    { label: 'Sewing', to: '/production/sewing-line-allocation' }, { label: 'Checking', to: '/production/checking-line-allocation' },
    { label: 'Ironing', to: '/production/ironing-line-allocation' }, { label: 'Packing', to: '/production/packing-line-allocation' }] },
  { key: 'plan', tabs: [
    { label: 'Sewing', to: '/production/sewing-daily-plan' }, { label: 'Checking', to: '/production/checking-daily-plan' },
    { label: 'Ironing', to: '/production/ironing-daily-plan' }, { label: 'Packing', to: '/production/packing-daily-plan' }] },
];
