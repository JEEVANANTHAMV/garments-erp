import { CrudPage } from '../../components/CrudPage';
import { Badge } from '../../components/ui';
import { fmtDecimal, fmtDate, humanize } from '../../lib/format';
import { useNavigate } from 'react-router-dom';

const yesNo = [{ value: 1, label: 'Yes' }, { value: 0, label: 'No' }];
const activeField = { name: 'is_active', label: 'Active', type: 'checkbox' as const, defaultValue: 1 };

export { PartyDetailPage } from './PartyDetail';

/* ------------------------------------------------------------ Parties */
export function PartiesPage() {
  const nav = useNavigate();
  return <CrudPage
    path="parties" title="Business Partners" permission="PARTY" singular="Partner"
    subtitle="Buyers, suppliers, job-work vendors and agents"
    searchPlaceholder="Search by code, name, email or GSTIN…"
    defaultSort={{ key: 'party_name', dir: 'asc' }}
    onNew={() => nav('/masters/parties/new')}
    onRowClick={(r) => nav(`/masters/parties/${r.id}`)}
    columns={[
      { key: 'party_code', header: 'Code', sortable: true,
        render: (r: any) => <span className="font-mono text-[12px] font-medium text-brand-700">{r.party_code}</span> },
      { key: 'party_name', header: 'Name', sortable: true,
        render: (r: any) => <span className="font-medium text-slate-800">{r.party_name}</span> },
      { key: 'roles', header: 'Roles', render: (r: any) => (
        <div className="flex flex-wrap gap-1">
          {r.is_buyer ? <Badge tone="blue">Buyer</Badge> : null}
          {r.is_supplier ? <Badge tone="green">Supplier</Badge> : null}
          {r.is_vendor ? <Badge tone="violet">Vendor</Badge> : null}
          {r.is_agent ? <Badge tone="amber">Agent</Badge> : null}
        </div>) },
      { key: 'country_name', header: 'Country' },
      { key: 'currency_code', header: 'Currency' },
      { key: 'payment_terms', header: 'Payment terms' },
      { key: 'credit_days', header: 'Credit days', align: 'right' },
    ]}
    filters={[
      { name: 'is_buyer', label: 'Buyer', options: yesNo },
      { name: 'is_supplier', label: 'Supplier', options: yesNo },
      { name: 'is_vendor', label: 'Vendor', options: yesNo },
      { name: 'country_id', label: 'Country', lookup: 'countries' },
    ]}
    modalSize="lg"
    fields={[
      { name: 'party_code', label: 'Partner code', required: true },
      { name: 'party_name', label: 'Partner name', required: true },
      { name: 'party_type', label: 'Type', options: [
        { value: 'EXPORT', label: 'Export' }, { value: 'DOMESTIC', label: 'Domestic' },
        { value: 'BOTH', label: 'Both' }], defaultValue: 'EXPORT' },
      { name: 'country_id', label: 'Country', lookup: 'countries' },
      { name: 'currency_id', label: 'Default currency', lookup: 'currencies' },
      { name: 'payment_terms', label: 'Payment terms', placeholder: 'e.g. LC 60 DAYS' },
      { name: 'credit_limit', label: 'Credit limit', type: 'number' },
      { name: 'credit_days', label: 'Credit days', type: 'number' },
      { name: 'gstin', label: 'GSTIN' },
      { name: 'pan', label: 'PAN' },
      { name: 'tax_id_foreign', label: 'Foreign tax ID', hint: 'VAT / EIN for overseas partners' },
      { name: 'email', label: 'Email', type: 'email' },
      { name: 'phone', label: 'Phone' },
      { name: 'website', label: 'Website' },
      { name: 'is_buyer', label: 'Is buyer', type: 'checkbox' },
      { name: 'is_customer', label: 'Is customer', type: 'checkbox' },
      { name: 'is_supplier', label: 'Is supplier', type: 'checkbox' },
      { name: 'is_vendor', label: 'Is job-work vendor', type: 'checkbox' },
      { name: 'is_agent', label: 'Is agent', type: 'checkbox' },
      activeField,
    ]} />;
}

/* ------------------------------------------------------------ Products */
export function ProductsPage() {
  return <CrudPage
    path="products" title="Products" permission="PRODUCT" singular="Product"
    subtitle="Garment type catalogue"
    defaultSort={{ key: 'product_name', dir: 'asc' }}
    columns={[
      { key: 'product_code', header: 'Code', sortable: true,
        render: (r: any) => <span className="font-mono text-[12px] text-brand-700">{r.product_code}</span> },
      { key: 'product_name', header: 'Name', sortable: true },
      { key: 'product_type', header: 'Type', render: (r: any) => <Badge tone="blue">{humanize(r.product_type)}</Badge> },
      { key: 'gender', header: 'Gender', render: (r: any) => humanize(r.gender) },
      { key: 'hsn_code', header: 'HSN' },
      { key: 'uom_code', header: 'UOM' },
    ]}
    filters={[
      { name: 'product_type', label: 'Type', options: ['TSHIRT','POLO','SWEATSHIRT','HOODIE','SHORTS','TRACKPANT','LEGGING','INNERWEAR','NIGHTWEAR','KIDSWEAR','JACKET','OTHER'].map((v) => ({ value: v, label: humanize(v) })) },
      { name: 'gender', label: 'Gender', options: ['MEN','WOMEN','UNISEX','BOYS','GIRLS','INFANT'].map((v) => ({ value: v, label: humanize(v) })) },
    ]}
    fields={[
      { name: 'product_code', label: 'Product code', required: true },
      { name: 'product_name', label: 'Product name', required: true },
      { name: 'product_type', label: 'Product type', required: true, options: ['TSHIRT','POLO','SWEATSHIRT','HOODIE','SHORTS','TRACKPANT','LEGGING','INNERWEAR','NIGHTWEAR','KIDSWEAR','JACKET','OTHER'].map((v) => ({ value: v, label: humanize(v) })) },
      { name: 'gender', label: 'Gender', options: ['MEN','WOMEN','UNISEX','BOYS','GIRLS','INFANT'].map((v) => ({ value: v, label: humanize(v) })), defaultValue: 'UNISEX' },
      { name: 'hsn_code', label: 'HSN code' },
      { name: 'default_uom', label: 'Default UOM', required: true, lookup: 'uoms' },
      activeField,
    ]} />;
}

/* --------------------------------------------------------------- Yarns */
export function YarnsPage() {
  return <CrudPage
    path="yarns" title="Yarns" permission="MATERIAL" singular="Yarn"
    subtitle="Yarn master with count, composition and rate"
    defaultSort={{ key: 'yarn_name', dir: 'asc' }}
    columns={[
      { key: 'yarn_code', header: 'Code', sortable: true,
        render: (r: any) => <span className="font-mono text-[12px] text-brand-700">{r.yarn_code}</span> },
      { key: 'yarn_name', header: 'Name', sortable: true },
      { key: 'count_value', header: 'Count' },
      { key: 'yarn_type', header: 'Type', render: (r: any) => humanize(r.yarn_type) },
      { key: 'composition_desc', header: 'Composition' },
      { key: 'uom_code', header: 'UOM' },
      { key: 'std_rate', header: 'Rate', align: 'right', render: (r: any) => fmtDecimal(r.std_rate, 2) },
    ]}
    filters={[
      { name: 'yarn_type', label: 'Yarn type', options: ['COMBED','CARDED','OE','COMPACT','MELANGE','SLUB','OTHER'].map((v) => ({ value: v, label: humanize(v) })) },
      { name: 'composition_id', label: 'Composition', lookup: 'compositions' },
    ]}
    fields={[
      { name: 'yarn_code', label: 'Yarn code', required: true },
      { name: 'yarn_name', label: 'Yarn name', required: true },
      { name: 'category_id', label: 'Category', lookup: 'material-categories' },
      { name: 'count_value', label: 'Count', placeholder: 'e.g. 30s' },
      { name: 'count_type', label: 'Count type', options: ['Ne','Nm','Denier','Tex'].map((v) => ({ value: v, label: v })), defaultValue: 'Ne' },
      { name: 'composition_id', label: 'Composition', lookup: 'compositions' },
      { name: 'ply', label: 'Ply', type: 'number', defaultValue: 1 },
      { name: 'yarn_type', label: 'Yarn type', options: ['COMBED','CARDED','OE','COMPACT','MELANGE','SLUB','OTHER'].map((v) => ({ value: v, label: humanize(v) })) },
      { name: 'hsn_code', label: 'HSN code' },
      { name: 'base_uom', label: 'Base UOM', required: true, lookup: 'uoms' },
      { name: 'std_rate', label: 'Standard rate', type: 'number' },
      activeField,
    ]} />;
}

/* ------------------------------------------------------------- Fabrics */
export function FabricsPage() {
  return <CrudPage
    path="fabrics" title="Fabrics" permission="MATERIAL" singular="Fabric"
    subtitle="Knit and woven fabric master"
    defaultSort={{ key: 'fabric_name', dir: 'asc' }}
    columns={[
      { key: 'fabric_code', header: 'Code', sortable: true,
        render: (r: any) => <span className="font-mono text-[12px] text-brand-700">{r.fabric_code}</span> },
      { key: 'fabric_name', header: 'Name', sortable: true },
      { key: 'fabric_type', header: 'Type', render: (r: any) => <Badge tone="blue">{humanize(r.fabric_type)}</Badge> },
      { key: 'knit_structure', header: 'Structure' },
      { key: 'gsm_value', header: 'GSM', align: 'right' },
      { key: 'composition_desc', header: 'Composition' },
      { key: 'std_rate', header: 'Rate', align: 'right', render: (r: any) => fmtDecimal(r.std_rate, 2) },
    ]}
    filters={[
      { name: 'fabric_type', label: 'Fabric type', options: ['KNIT','WOVEN','NONWOVEN'].map((v) => ({ value: v, label: humanize(v) })) },
      { name: 'gsm_id', label: 'GSM', lookup: 'gsm' },
      { name: 'composition_id', label: 'Composition', lookup: 'compositions' },
    ]}
    fields={[
      { name: 'fabric_code', label: 'Fabric code', required: true },
      { name: 'fabric_name', label: 'Fabric name', required: true },
      { name: 'category_id', label: 'Category', lookup: 'material-categories' },
      { name: 'fabric_type', label: 'Fabric type', required: true, options: ['KNIT','WOVEN','NONWOVEN'].map((v) => ({ value: v, label: humanize(v) })), defaultValue: 'KNIT' },
      { name: 'knit_structure', label: 'Knit structure', placeholder: 'e.g. Single Jersey' },
      { name: 'composition_id', label: 'Composition', lookup: 'compositions' },
      { name: 'gsm_id', label: 'GSM', lookup: 'gsm' },
      { name: 'width_cm', label: 'Width (cm)', type: 'number' },
      { name: 'dia_inch', label: 'Diameter (inch)', type: 'number' },
      { name: 'yarn_id', label: 'Primary yarn', lookup: 'yarns' },
      { name: 'finish_type', label: 'Finish', placeholder: 'e.g. Bio-wash' },
      { name: 'hsn_code', label: 'HSN code' },
      { name: 'base_uom', label: 'Base UOM', required: true, lookup: 'uoms' },
      { name: 'std_rate', label: 'Standard rate', type: 'number' },
      activeField,
    ]} />;
}

/* --------------------------------------------------------------- Trims */
export function TrimsPage() {
  const TYPES = ['BUTTON','ZIPPER','LABEL','THREAD','ELASTIC','DRAWCORD','HANGTAG','STICKER','POLYBAG','CARTON','HANGER','TAPE','RIVET','VELCRO','LACE','OTHER'];
  return <CrudPage
    path="trims" title="Trims & Accessories" permission="MATERIAL" singular="Trim"
    subtitle="Labels, threads, buttons, packing materials"
    defaultSort={{ key: 'trim_name', dir: 'asc' }}
    columns={[
      { key: 'trim_code', header: 'Code', sortable: true,
        render: (r: any) => <span className="font-mono text-[12px] text-brand-700">{r.trim_code}</span> },
      { key: 'trim_name', header: 'Name', sortable: true },
      { key: 'trim_type', header: 'Type', render: (r: any) => <Badge tone="violet">{humanize(r.trim_type)}</Badge> },
      { key: 'specification', header: 'Specification' },
      { key: 'uom_code', header: 'UOM' },
      { key: 'std_rate', header: 'Rate', align: 'right', render: (r: any) => fmtDecimal(r.std_rate, 2) },
    ]}
    filters={[{ name: 'trim_type', label: 'Trim type', options: TYPES.map((v) => ({ value: v, label: humanize(v) })) }]}
    fields={[
      { name: 'trim_code', label: 'Trim code', required: true },
      { name: 'trim_name', label: 'Trim name', required: true },
      { name: 'category_id', label: 'Category', lookup: 'material-categories' },
      { name: 'trim_type', label: 'Trim type', required: true, options: TYPES.map((v) => ({ value: v, label: humanize(v) })) },
      { name: 'specification', label: 'Specification', span: 2 },
      { name: 'hsn_code', label: 'HSN code' },
      { name: 'base_uom', label: 'Base UOM', required: true, lookup: 'uoms' },
      { name: 'std_rate', label: 'Standard rate', type: 'number' },
      activeField,
    ]} />;
}

/* -------------------------------------------------------------- Colors */
export function ColorsPage() {
  return <CrudPage
    path="colors" title="Colors" permission="COLOR" singular="Color"
    subtitle="Colour master with Pantone references"
    defaultSort={{ key: 'color_name', dir: 'asc' }}
    columns={[
      { key: 'swatch', header: '', width: 'w-12', render: (r: any) => (
        <span className="inline-block h-6 w-6 rounded-md border border-slate-200"
          style={{ background: r.hex_value || '#f1f5f9' }} title={r.hex_value ?? ''} />) },
      { key: 'color_code', header: 'Code', sortable: true,
        render: (r: any) => <span className="font-mono text-[12px] text-brand-700">{r.color_code}</span> },
      { key: 'color_name', header: 'Name', sortable: true },
      { key: 'pantone_ref', header: 'Pantone' },
      { key: 'hex_value', header: 'Hex', render: (r: any) => <span className="font-mono text-[12px]">{r.hex_value}</span> },
    ]}
    fields={[
      { name: 'color_code', label: 'Colour code', required: true },
      { name: 'color_name', label: 'Colour name', required: true },
      { name: 'pantone_ref', label: 'Pantone reference' },
      { name: 'hex_value', label: 'Hex value', type: 'color', defaultValue: '#000000' },
      activeField,
    ]} />;
}

/* -------------------------------------------------------- Warehouses */
export function WarehousesPage() {
  const TYPES = ['RAW_MATERIAL','WIP','FINISHED_GOODS','TRIMS','REJECTION','BONDED'];
  return <CrudPage
    path="warehouses" title="Warehouses" permission="WAREHOUSE" singular="Warehouse"
    subtitle="Stores and stock locations"
    defaultSort={{ key: 'warehouse_name', dir: 'asc' }}
    columns={[
      { key: 'warehouse_code', header: 'Code', sortable: true,
        render: (r: any) => <span className="font-mono text-[12px] text-brand-700">{r.warehouse_code}</span> },
      { key: 'warehouse_name', header: 'Name', sortable: true },
      { key: 'warehouse_type', header: 'Type', render: (r: any) => <Badge tone="blue">{humanize(r.warehouse_type)}</Badge> },
      { key: 'unit_name', header: 'Unit' },
    ]}
    filters={[{ name: 'warehouse_type', label: 'Type', options: TYPES.map((v) => ({ value: v, label: humanize(v) })) }]}
    fields={[
      { name: 'warehouse_code', label: 'Warehouse code', required: true },
      { name: 'warehouse_name', label: 'Warehouse name', required: true },
      { name: 'warehouse_type', label: 'Type', required: true, options: TYPES.map((v) => ({ value: v, label: humanize(v) })) },
      { name: 'unit_id', label: 'Unit', lookup: 'units' },
      activeField,
    ]} />;
}

/* ----------------------------------------------------------- Branches */
export function BranchesPage() {
  return <CrudPage
    path="branches" title="Branches" permission="BRANCH" singular="Branch"
    subtitle="Company offices and locations"
    defaultSort={{ key: 'branch_name', dir: 'asc' }}
    columns={[
      { key: 'branch_code', header: 'Code', sortable: true,
        render: (r: any) => <span className="font-mono text-[12px] text-brand-700">{r.branch_code}</span> },
      { key: 'branch_name', header: 'Name', sortable: true },
      { key: 'city', header: 'City' },
      { key: 'state', header: 'State' },
      { key: 'gstin', header: 'GSTIN' },
      { key: 'is_head_office', header: 'Head office',
        render: (r: any) => r.is_head_office ? <Badge tone="green">Head Office</Badge> : null },
    ]}
    fields={[
      { name: 'branch_code', label: 'Branch code', required: true },
      { name: 'branch_name', label: 'Branch name', required: true },
      { name: 'gstin', label: 'GSTIN' },
      { name: 'address_line1', label: 'Address', span: 2 },
      { name: 'city', label: 'City' }, { name: 'state', label: 'State' },
      { name: 'pincode', label: 'Pincode' }, { name: 'phone', label: 'Phone' },
      { name: 'is_head_office', label: 'Head office', type: 'checkbox' },
      activeField,
    ]} />;
}

/* -------------------------------------------------------------- Units */
export function UnitsPage() {
  const TYPES = ['CUTTING','STITCHING','PRINTING','EMBROIDERY','WASHING','FINISHING','PACKING','INTEGRATED','WAREHOUSE'];
  return <CrudPage
    path="units" title="Production Units" permission="UNIT" singular="Unit"
    subtitle="Factory floors and warehouses"
    defaultSort={{ key: 'unit_name', dir: 'asc' }}
    columns={[
      { key: 'unit_code', header: 'Code', sortable: true,
        render: (r: any) => <span className="font-mono text-[12px] text-brand-700">{r.unit_code}</span> },
      { key: 'unit_name', header: 'Name', sortable: true },
      { key: 'unit_type', header: 'Type', render: (r: any) => <Badge tone="violet">{humanize(r.unit_type)}</Badge> },
      { key: 'capacity_per_day', header: 'Capacity/day', align: 'right' },
      { key: 'branch_name', header: 'Branch' },
      { key: 'city', header: 'City' },
    ]}
    filters={[{ name: 'unit_type', label: 'Unit type', options: TYPES.map((v) => ({ value: v, label: humanize(v) })) }]}
    fields={[
      { name: 'unit_code', label: 'Unit code', required: true },
      { name: 'unit_name', label: 'Unit name', required: true },
      { name: 'unit_type', label: 'Unit type', required: true, options: TYPES.map((v) => ({ value: v, label: humanize(v) })) },
      { name: 'branch_id', label: 'Branch', lookup: 'branches' },
      { name: 'capacity_per_day', label: 'Capacity per day', type: 'number' },
      { name: 'address_line1', label: 'Address', span: 2 },
      { name: 'city', label: 'City' },
      activeField,
    ]} />;
}

/* -------------------------------------------------------- Size groups */
export function SizeGroupsPage() {
  return <CrudPage
    path="size-groups" title="Size Groups" permission="SIZE" singular="Size Group"
    subtitle="Size scales used by styles"
    defaultSort={{ key: 'group_name', dir: 'asc' }}
    columns={[
      { key: 'group_code', header: 'Code', sortable: true,
        render: (r: any) => <span className="font-mono text-[12px] text-brand-700">{r.group_code}</span> },
      { key: 'group_name', header: 'Name', sortable: true },
    ]}
    fields={[
      { name: 'group_code', label: 'Group code', required: true },
      { name: 'group_name', label: 'Group name', required: true },
    ]} />;
}

/* ------------------------------------------------------------ Batches */
export function BatchesPage() {
  return <CrudPage
    path="batches" title="Batches & Lots" permission="INVENTORY" singular="Batch"
    subtitle="Material traceability by lot and shade"
    defaultSort={{ key: 'id', dir: 'desc' }}
    columns={[
      { key: 'batch_no', header: 'Batch no', sortable: true,
        render: (r: any) => <span className="font-mono text-[12px] text-brand-700">{r.batch_no}</span> },
      { key: 'material_type', header: 'Material', render: (r: any) => <Badge tone="blue">{humanize(r.material_type)}</Badge> },
      { key: 'shade_lot', header: 'Shade lot' },
      { key: 'mfg_date', header: 'Mfg date', render: (r: any) => fmtDate(r.mfg_date) },
      { key: 'received_date', header: 'Received', sortable: true, render: (r: any) => fmtDate(r.received_date) },
      { key: 'remarks', header: 'Remarks' },
    ]}
    filters={[
      { name: 'material_type', label: 'Material type', options: ['YARN','FABRIC','TRIM','FINISHED'].map((v) => ({ value: v, label: humanize(v) })) },
      { name: 'supplier_id', label: 'Supplier', lookup: 'suppliers' },
    ]}
    fields={[
      { name: 'batch_no', label: 'Batch number', required: true },
      { name: 'material_type', label: 'Material type', required: true, options: ['YARN','FABRIC','TRIM','FINISHED'].map((v) => ({ value: v, label: humanize(v) })) },
      { name: 'yarn_id', label: 'Yarn', lookup: 'yarns' },
      { name: 'fabric_id', label: 'Fabric', lookup: 'fabrics' },
      { name: 'trim_id', label: 'Trim', lookup: 'trims' },
      { name: 'supplier_id', label: 'Supplier', lookup: 'suppliers' },
      { name: 'mfg_date', label: 'Manufacturing date', type: 'date' },
      { name: 'received_date', label: 'Received date', type: 'date' },
      { name: 'shade_lot', label: 'Shade / dye lot' },
      { name: 'remarks', label: 'Remarks', type: 'textarea' },
    ]} />;
}
