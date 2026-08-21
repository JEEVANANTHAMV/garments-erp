import type { LucideIcon } from 'lucide-react';
import {
  LayoutDashboard, Building2, Users, Palette, Ruler, Package, Shirt, Layers,
  FileText, Beaker, Calculator, FileSpreadsheet, ShoppingCart, Boxes, Truck,
  Factory, Scissors, ClipboardCheck, PackageCheck, Ship, Receipt, Landmark,
  BarChart3, Shield, Settings, Warehouse, GitBranch, CalendarClock, FileCheck2,
  History, Wallet, TrendingUp, Container, Coins,
} from 'lucide-react';

export interface NavItem {
  label: string;
  to: string;
  icon: LucideIcon;
  /** Item is shown when the user holds any of these permissions. */
  perms: string[];
}
export interface NavSection {
  label: string;
  items: NavItem[];
}

export const NAV: NavSection[] = [
  {
    label: 'Overview',
    items: [
      { label: 'Dashboard', to: '/', icon: LayoutDashboard, perms: ['DASHBOARD.VIEW'] },
    ],
  },
  {
    label: 'Master Data',
    items: [
      { label: 'Business Partners', to: '/masters/parties', icon: Users, perms: ['PARTY.VIEW'] },
      { label: 'Styles',            to: '/masters/styles', icon: Shirt, perms: ['STYLE.VIEW'] },
      { label: 'Bill of Materials', to: '/masters/boms', icon: Layers, perms: ['BOM.VIEW'] },
      { label: 'Products',          to: '/masters/products', icon: Package, perms: ['PRODUCT.VIEW'] },
      { label: 'Yarns',             to: '/masters/yarns', icon: GitBranch, perms: ['MATERIAL.VIEW'] },
      { label: 'Fabrics',           to: '/masters/fabrics', icon: Layers, perms: ['MATERIAL.VIEW'] },
      { label: 'Trims',             to: '/masters/trims', icon: Package, perms: ['MATERIAL.VIEW'] },
      { label: 'Colors',            to: '/masters/colors', icon: Palette, perms: ['COLOR.VIEW'] },
      { label: 'Size Groups',       to: '/masters/size-groups', icon: Ruler, perms: ['SIZE.VIEW'] },
      { label: 'Warehouses',        to: '/masters/warehouses', icon: Warehouse, perms: ['WAREHOUSE.VIEW'] },
      { label: 'Branches & Units',  to: '/masters/branches', icon: Building2, perms: ['BRANCH.VIEW','UNIT.VIEW'] },
    ],
  },
  {
    label: 'Sales',
    items: [
      { label: 'Enquiries',    to: '/sales/enquiries', icon: FileText, perms: ['ENQUIRY.VIEW'] },
      { label: 'Samples',      to: '/sales/samples', icon: Beaker, perms: ['SAMPLE.VIEW'] },
      { label: 'Costings',     to: '/sales/costings', icon: Calculator, perms: ['COSTING.VIEW'] },
      { label: 'Quotations',   to: '/sales/quotations', icon: FileSpreadsheet, perms: ['QUOTATION.VIEW'] },
      { label: 'Sales Orders', to: '/sales/orders', icon: ShoppingCart, perms: ['SALES_ORDER.VIEW'] },
    ],
  },
  {
    label: 'Procurement',
    items: [
      { label: 'MRP Runs',        to: '/procurement/mrp', icon: TrendingUp, perms: ['MRP.VIEW'] },
      { label: 'Purchase Orders', to: '/procurement/purchase-orders', icon: ShoppingCart, perms: ['PURCHASE.VIEW'] },
      { label: 'Goods Receipt',   to: '/procurement/grns', icon: Truck, perms: ['GRN.VIEW'] },
    ],
  },
  {
    label: 'Inventory',
    items: [
      { label: 'Stock on Hand',  to: '/inventory/stock', icon: Boxes, perms: ['INVENTORY.VIEW'] },
      { label: 'Stock Ledger',   to: '/inventory/ledger', icon: History, perms: ['INVENTORY.VIEW'] },
      { label: 'Material Issue', to: '/inventory/issues', icon: PackageCheck, perms: ['ISSUE.VIEW'] },
      { label: 'Batches',        to: '/inventory/batches', icon: Container, perms: ['INVENTORY.VIEW'] },
    ],
  },
  {
    label: 'Production',
    items: [
      { label: 'Production Plans',  to: '/production/plans', icon: CalendarClock, perms: ['PRODUCTION.VIEW'] },
      { label: 'Production Orders', to: '/production/orders', icon: Factory, perms: ['PRODUCTION.VIEW'] },
      { label: 'Cutting',           to: '/production/cuttings', icon: Scissors, perms: ['PRODUCTION.VIEW'] },
      { label: 'Stitching',         to: '/production/stitchings', icon: Factory, perms: ['PRODUCTION.VIEW'] },
      { label: 'Printing',          to: '/production/printings', icon: Palette, perms: ['PRODUCTION.VIEW'] },
      { label: 'Embroidery',        to: '/production/embroideries', icon: Palette, perms: ['PRODUCTION.VIEW'] },
      { label: 'Washing',           to: '/production/washings', icon: Beaker, perms: ['PRODUCTION.VIEW'] },
      { label: 'Finishing',         to: '/production/finishings', icon: PackageCheck, perms: ['PRODUCTION.VIEW'] },
      { label: 'Process Movements', to: '/production/process-transactions', icon: GitBranch, perms: ['PRODUCTION.VIEW'] },
    ],
  },
  {
    label: 'Quality',
    items: [
      { label: 'QC Inspections', to: '/quality/inspections', icon: ClipboardCheck, perms: ['QC.VIEW'] },
      { label: 'Defect Master',  to: '/quality/defects', icon: Shield, perms: ['QC.VIEW'] },
    ],
  },
  {
    label: 'Packing & Export',
    items: [
      { label: 'Packing',             to: '/logistics/packings', icon: PackageCheck, perms: ['PACKING.VIEW'] },
      { label: 'Dispatch',            to: '/logistics/dispatches', icon: Truck, perms: ['DISPATCH.VIEW'] },
      { label: 'Containers',          to: '/logistics/containers', icon: Container, perms: ['DISPATCH.VIEW'] },
      { label: 'Commercial Invoices', to: '/export/invoices', icon: Receipt, perms: ['EXPORT.VIEW'] },
      { label: 'Packing Lists',       to: '/export/packing-lists', icon: FileCheck2, perms: ['EXPORT.VIEW'] },
      { label: 'Shipping Bills',      to: '/export/shipping-bills', icon: FileText, perms: ['EXPORT.VIEW'] },
      { label: 'Shipments',           to: '/export/shipments', icon: Ship, perms: ['EXPORT.VIEW'] },
      { label: 'Certificates',        to: '/export/certificates', icon: FileCheck2, perms: ['EXPORT.VIEW'] },
    ],
  },
  {
    label: 'Finance',
    items: [
      { label: 'Vouchers',          to: '/finance/vouchers', icon: Landmark, perms: ['FINANCE.VIEW'] },
      { label: 'Receipts',          to: '/finance/receipts', icon: Wallet, perms: ['FINANCE.VIEW'] },
      { label: 'Payments',          to: '/finance/payments', icon: Coins, perms: ['FINANCE.VIEW'] },
      { label: 'Export Incentives', to: '/finance/incentives', icon: TrendingUp, perms: ['FINANCE.VIEW'] },
      { label: 'Ledger Accounts',   to: '/finance/ledger-accounts', icon: Landmark, perms: ['FINANCE.VIEW'] },
      { label: 'Tax Rates',         to: '/finance/tax-rates', icon: Receipt, perms: ['FINANCE.VIEW'] },
    ],
  },
  {
    label: 'Reports',
    items: [
      { label: 'Reports',     to: '/reports', icon: BarChart3, perms: ['REPORT.VIEW'] },
      { label: 'Audit Trail', to: '/reports/audit', icon: History, perms: ['AUDIT.VIEW'] },
    ],
  },
  {
    label: 'Administration',
    items: [
      { label: 'Users',    to: '/admin/users', icon: Users, perms: ['USER.VIEW'] },
      { label: 'Roles',    to: '/admin/roles', icon: Shield, perms: ['ROLE.VIEW'] },
      { label: 'Company',  to: '/admin/company', icon: Building2, perms: ['COMPANY.VIEW'] },
      { label: 'Settings', to: '/admin/settings', icon: Settings, perms: ['SETTINGS.VIEW'] },
    ],
  },
];
