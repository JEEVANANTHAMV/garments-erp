import { useState, useMemo, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Plus, ArrowLeft, Save, Trash2, CheckCircle2, Zap,
  ShoppingCart, Sparkles, Copy
} from 'lucide-react';
import { http, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useLookup, toOptions } from '../../hooks/useLookup';
import { useToast } from '../../hooks/useToast';
import { Input, Select, Spinner, StatusBadge } from '../../components/ui';
import { fmtDecimal, today } from '../../lib/format';

export interface GeneralPurchaseLineItem {
  _key: string;
  id?: number;
  item_description: string;
  material_type: 'TRIM' | 'YARN' | 'FABRIC' | 'CONSUMABLE' | 'EXPENSE' | 'SPARE' | 'OTHER';
  material_id?: number | string;
  qty: number | '';
  uom_id: number | string;
  rate: number | '';
  discount_pct: number | '';
  gst_rate: number | '';
  igst_rate: number | '';
  tax_amount: number;
  amount: number;
  stock_type: 'STOCK' | 'CONSUMABLE' | 'EXPENSE' | 'SPARE';
  allocation_type: 'GENERAL_STOCK' | 'BUYER_ORDER' | 'PRODUCTION_ORDER' | 'SAMPLE' | 'JOB_WORK' | 'MAINTENANCE' | 'DEPARTMENT' | 'DIRECT_EXPENSE';
  buyer_id?: number | string;
  so_id?: number | string;
  prod_order_id?: number | string;
  style_id?: number | string;
  sample_id?: number | string;
  sample_type?: string;
  jobwork_id?: number | string;
  process_name?: string;
  machine_id?: string;
  department_id?: number | string;
  cost_centre?: string;
  expense_head?: string;
  direct_issue: number;
  warehouse_id?: number | string;
  remarks?: string;
}

let lineSeq = 0;

export function GeneralPurchaseDetailPage() {
  const { id } = useParams<{ id: string }>();
  const isNew = !id || id === 'new';
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();
  const editable = can(isNew ? 'PURCHASE.CREATE' : 'PURCHASE.UPDATE');

  const [saving, setSaving] = useState(false);

  // Lookups
  const suppliers = useLookup('suppliers');
  const currencies = useLookup('currencies');
  const uoms = useLookup('uoms');
  const warehouses = useLookup('warehouses');
  const salesOrders = useLookup('sales-orders');
  const styles = useLookup('styles');
  const departments = useLookup('departments');

  // Header State
  const [head, setHead] = useState<Record<string, any>>({
    purchase_no: '',
    purchase_date: today(),
    supplier_id: '',
    purchase_type: 'GENERAL',
    supplier_inv_no: '',
    supplier_inv_date: today(),
    currency_id: '',
    exchange_rate: 1,
    payment_terms: '30 Days Net',
    reference_po_id: '',
    remarks: '',
    approval_state: 'DRAFT',
    status_id: '',
  });

  // Lines State
  const [lines, setLines] = useState<GeneralPurchaseLineItem[]>([
    {
      _key: `gpl_${++lineSeq}`,
      item_description: 'Sewing Thread 40s/2 Spun Poly White',
      material_type: 'TRIM',
      qty: 10,
      uom_id: '',
      rate: 180,
      discount_pct: 0,
      gst_rate: 12,
      igst_rate: 0,
      tax_amount: 216,
      amount: 2016,
      stock_type: 'STOCK',
      allocation_type: 'BUYER_ORDER',
      direct_issue: 1, // Example direct issue
      remarks: 'Urgent sample batch stitching',
    },
  ]);

  // Load existing purchase record
  const purchaseQuery = useQuery({
    queryKey: ['general-purchase-detail', id],
    queryFn: async () => {
      const res = await http.get<any>(`/api/resources/general-purchases/${id}`);
      return res.data;
    },
    enabled: !isNew,
  });

  useEffect(() => {
    if (purchaseQuery.data) {
      const p = purchaseQuery.data;
      setHead({
        purchase_no: p.purchase_no || '',
        purchase_date: p.purchase_date ? p.purchase_date.slice(0, 10) : today(),
        supplier_id: p.supplier_id || '',
        purchase_type: p.purchase_type || 'GENERAL',
        supplier_inv_no: p.supplier_inv_no || '',
        supplier_inv_date: p.supplier_inv_date ? p.supplier_inv_date.slice(0, 10) : '',
        currency_id: p.currency_id || '',
        exchange_rate: p.exchange_rate || 1,
        payment_terms: p.payment_terms || '',
        reference_po_id: p.reference_po_id || '',
        remarks: p.remarks || '',
        approval_state: p.approval_state || 'DRAFT',
        status_id: p.status_id || '',
      });

      if (Array.isArray(p.lines) && p.lines.length > 0) {
        setLines(
          p.lines.map((l: any) => ({
            _key: `gpl_${l.id}`,
            id: l.id,
            item_description: l.item_description || '',
            material_type: l.material_type || 'CONSUMABLE',
            material_id: l.material_id || '',
            qty: Number(l.qty) || 0,
            uom_id: l.uom_id || '',
            rate: Number(l.rate) || 0,
            discount_pct: Number(l.discount_pct) || 0,
            gst_rate: Number(l.gst_rate) || 0,
            igst_rate: Number(l.igst_rate) || 0,
            tax_amount: Number(l.tax_amount) || 0,
            amount: Number(l.amount) || 0,
            stock_type: l.stock_type || 'STOCK',
            allocation_type: l.allocation_type || 'GENERAL_STOCK',
            buyer_id: l.buyer_id || '',
            so_id: l.so_id || '',
            prod_order_id: l.prod_order_id || '',
            style_id: l.style_id || '',
            sample_id: l.sample_id || '',
            sample_type: l.sample_type || '',
            jobwork_id: l.jobwork_id || '',
            process_name: l.process_name || '',
            machine_id: l.machine_id || '',
            department_id: l.department_id || '',
            cost_centre: l.cost_centre || '',
            expense_head: l.expense_head || '',
            direct_issue: l.direct_issue ? 1 : 0,
            warehouse_id: l.warehouse_id || '',
            remarks: l.remarks || '',
          }))
        );
      }
    }
  }, [purchaseQuery.data]);

  // Set default currency & UOM for new record
  useEffect(() => {
    if (isNew) {
      if (currencies.data?.length && !head.currency_id) {
        const inr = currencies.data.find((c: any) => c.code === 'INR') || currencies.data[0];
        if (inr) setHead((h) => ({ ...h, currency_id: inr.id }));
      }
    }
  }, [isNew, currencies.data, head.currency_id]);

  useEffect(() => {
    if (uoms.data?.length && lines.some((l) => !l.uom_id)) {
      const defaultUom = uoms.data.find((u: any) => u.code === 'NOS' || u.code === 'CONE' || u.code === 'KG') || uoms.data[0];
      if (defaultUom) {
        setLines((cur) =>
          cur.map((l) => (l.uom_id ? l : { ...l, uom_id: defaultUom.id }))
        );
      }
    }
  }, [uoms.data]);

  // Line Calculations helper
  const calculateLineTotals = (
    qty: number,
    rate: number,
    discountPct: number,
    gstRate: number,
    igstRate: number
  ) => {
    const rawTotal = qty * rate;
    const discountAmount = (rawTotal * (discountPct || 0)) / 100;
    const taxableAmount = Math.max(0, rawTotal - discountAmount);
    const taxRate = (Number(gstRate) || 0) + (Number(igstRate) || 0);
    const taxAmount = (taxableAmount * taxRate) / 100;
    const finalAmount = taxableAmount + taxAmount;
    return { taxAmount, amount: finalAmount };
  };

  // Update line field
  const handleUpdateLine = (key: string, field: keyof GeneralPurchaseLineItem, val: any) => {
    setLines((curr) =>
      curr.map((l) => {
        if (l._key !== key) return l;
        const updated = { ...l, [field]: val };

        const qty = field === 'qty' ? Number(val) || 0 : Number(l.qty) || 0;
        const rate = field === 'rate' ? Number(val) || 0 : Number(l.rate) || 0;
        const discountPct = field === 'discount_pct' ? Number(val) || 0 : Number(l.discount_pct) || 0;
        const gstRate = field === 'gst_rate' ? Number(val) || 0 : Number(l.gst_rate) || 0;
        const igstRate = field === 'igst_rate' ? Number(val) || 0 : Number(l.igst_rate) || 0;

        const { taxAmount, amount } = calculateLineTotals(qty, rate, discountPct, gstRate, igstRate);
        updated.tax_amount = taxAmount;
        updated.amount = amount;

        return updated;
      })
    );
  };

  const handleAddLine = () => {
    const defaultUom = uoms.data?.[0]?.id || '';
    setLines((curr) => [
      ...curr,
      {
        _key: `gpl_${++lineSeq}`,
        item_description: '',
        material_type: 'CONSUMABLE',
        qty: 1,
        uom_id: defaultUom,
        rate: 0,
        discount_pct: 0,
        gst_rate: 18,
        igst_rate: 0,
        tax_amount: 0,
        amount: 0,
        stock_type: 'STOCK',
        allocation_type: 'GENERAL_STOCK',
        direct_issue: 0,
        remarks: '',
      },
    ]);
  };

  const handleDuplicateLine = (key: string) => {
    const target = lines.find((l) => l._key === key);
    if (!target) return;
    setLines((curr) => [
      ...curr,
      {
        ...target,
        _key: `gpl_${++lineSeq}`,
        id: undefined,
      },
    ]);
  };

  const handleRemoveLine = (key: string) => {
    if (lines.length <= 1) {
      toast('At least one item line is required', 'info');
      return;
    }
    setLines((curr) => curr.filter((l) => l._key !== key));
  };

  // Grand Totals Computation
  const totals = useMemo(() => {
    let subtotal = 0;
    let totalDiscount = 0;
    let totalTax = 0;
    let grandTotal = 0;

    for (const l of lines) {
      const q = Number(l.qty) || 0;
      const r = Number(l.rate) || 0;
      const raw = q * r;
      const disc = (raw * (Number(l.discount_pct) || 0)) / 100;
      subtotal += raw;
      totalDiscount += disc;
      totalTax += l.tax_amount || 0;
      grandTotal += l.amount || 0;
    }

    return { subtotal, totalDiscount, totalTax, grandTotal };
  }, [lines]);

  // Save General Purchase
  const handleSave = async (submitState: 'DRAFT' | 'APPROVED' | 'POSTED' = 'DRAFT') => {
    if (!head.supplier_id) {
      toast('Please select a supplier', 'error');
      return;
    }
    if (!head.purchase_date) {
      toast('Purchase date is required', 'error');
      return;
    }
    if (lines.length === 0) {
      toast('Please add at least one line item', 'error');
      return;
    }

    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (!l.item_description?.trim()) {
        toast(`Line #${i + 1}: Item description is required`, 'error');
        return;
      }
      if (!l.qty || Number(l.qty) <= 0) {
        toast(`Line #${i + 1}: Quantity must be greater than 0`, 'error');
        return;
      }
      if (!l.uom_id) {
        toast(`Line #${i + 1}: UOM is required`, 'error');
        return;
      }
      if (l.allocation_type === 'BUYER_ORDER' && !l.so_id) {
        toast(`Line #${i + 1}: Buyer Order allocation requires Sales Order reference`, 'error');
        return;
      }
    }

    setSaving(true);
    try {
      const payload = {
        purchase_no: head.purchase_no || undefined,
        purchase_date: head.purchase_date,
        supplier_id: Number(head.supplier_id),
        purchase_type: head.purchase_type,
        supplier_inv_no: head.supplier_inv_no || null,
        supplier_inv_date: head.supplier_inv_date || null,
        currency_id: Number(head.currency_id),
        exchange_rate: Number(head.exchange_rate) || 1,
        payment_terms: head.payment_terms || null,
        reference_po_id: head.reference_po_id ? Number(head.reference_po_id) : null,
        subtotal: totals.subtotal,
        discount_amount: totals.totalDiscount,
        tax_amount: totals.totalTax,
        grand_total: totals.grandTotal,
        approval_state: submitState,
        status_id: head.status_id ? Number(head.status_id) : null,
        remarks: head.remarks || null,
        lines: lines.map((l) => ({
          item_description: l.item_description.trim(),
          material_type: l.material_type,
          material_id: l.material_id ? Number(l.material_id) : null,
          qty: Number(l.qty),
          uom_id: Number(l.uom_id),
          rate: Number(l.rate) || 0,
          discount_pct: Number(l.discount_pct) || 0,
          gst_rate: Number(l.gst_rate) || 0,
          igst_rate: Number(l.igst_rate) || 0,
          tax_amount: Number(l.tax_amount) || 0,
          amount: Number(l.amount) || 0,
          stock_type: l.stock_type,
          allocation_type: l.allocation_type,
          buyer_id: l.buyer_id ? Number(l.buyer_id) : null,
          so_id: l.so_id ? Number(l.so_id) : null,
          prod_order_id: l.prod_order_id ? Number(l.prod_order_id) : null,
          style_id: l.style_id ? Number(l.style_id) : null,
          sample_id: l.sample_id ? Number(l.sample_id) : null,
          sample_type: l.sample_type || null,
          jobwork_id: l.jobwork_id ? Number(l.jobwork_id) : null,
          process_name: l.process_name || null,
          machine_id: l.machine_id || null,
          department_id: l.department_id ? Number(l.department_id) : null,
          cost_centre: l.cost_centre || null,
          expense_head: l.expense_head || null,
          direct_issue: l.direct_issue ? 1 : 0,
          warehouse_id: l.warehouse_id ? Number(l.warehouse_id) : null,
          remarks: l.remarks || null,
        })),
      };

      if (isNew) {
        const created = await http.post<any>('/api/resources/general-purchases', payload);
        toast(`General Purchase ${created.data?.purchase_no || 'record'} created successfully`, 'success');
        void qc.invalidateQueries({ queryKey: ['general-purchases'] });
        nav(`/procurement/general-purchases/${created.data?.id}`);
      } else {
        await http.put(`/api/resources/general-purchases/${id}`, payload);
        toast('General Purchase updated successfully', 'success');
        void qc.invalidateQueries({ queryKey: ['general-purchase-detail', id] });
        void qc.invalidateQueries({ queryKey: ['general-purchases'] });
      }
    } catch (err: any) {
      toast(err instanceof ApiError ? err.message : 'Failed to save general purchase', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5 pb-12">
      {/* Header Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-surface-border pb-4">
        <div className="flex items-center gap-3">
          <button
            type="button"
            className="btn-secondary p-2"
            onClick={() => nav('/procurement/general-purchases')}
            title="Back to General Purchases"
          >
            <ArrowLeft size={16} />
          </button>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-bold text-slate-900">
                {isNew ? 'New General Purchase' : `General Purchase: ${head.purchase_no || 'Document'}`}
              </h1>
              {!isNew && <StatusBadge value={head.approval_state} />}
              {head.purchase_type === 'EMERGENCY' && (
                <span className="inline-flex items-center gap-1 rounded-full bg-rose-100 px-2.5 py-0.5 text-xs font-bold text-rose-700">
                  <Zap size={12} className="fill-rose-600" /> EMERGENCY / DIRECT
                </span>
              )}
            </div>
            <p className="text-xs text-slate-500">
              One-stop controlled purchase: Stock, Buyer Orders, Production Jobs, Maintenance &amp; Direct Emergency Issues
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            className="btn-secondary"
            onClick={() => handleSave('DRAFT')}
            disabled={saving || !editable}
          >
            {saving ? <Spinner size={15} /> : <Save size={15} />} Save Draft
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={() => handleSave('APPROVED')}
            disabled={saving || !editable}
          >
            {saving ? <Spinner size={15} /> : <CheckCircle2 size={15} />} Approve &amp; Post
          </button>
        </div>
      </div>

      {/* Header Form Card */}
      <div className="rounded-xl border border-surface-border bg-white p-5 shadow-xs">
        <div className="mb-4 flex items-center gap-2 border-b border-surface-border pb-2 text-sm font-semibold text-slate-800">
          <ShoppingCart size={16} className="text-brand-600" />
          General Purchase Details
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <Input
            label="Purchase No"
            value={head.purchase_no}
            onChange={(e) => setHead({ ...head, purchase_no: e.target.value })}
            placeholder="Auto-generated (e.g. GP-000125)"
            disabled={!isNew}
          />

          <Input
            label="Purchase Date *"
            type="date"
            value={head.purchase_date}
            onChange={(e) => setHead({ ...head, purchase_date: e.target.value })}
            required
          />

          <Select
            label="Supplier *"
            options={toOptions(suppliers.data || [])}
            value={head.supplier_id}
            onChange={(e) => setHead({ ...head, supplier_id: e.target.value })}
            placeholder="Select Supplier"
            required
          />

          <Select
            label="Purchase Type *"
            options={[
              { value: 'GENERAL', label: 'General / Office Purchase' },
              { value: 'STOCK', label: 'Stock Purchase (Trims, Spares)' },
              { value: 'ORDER_SPECIFIC', label: 'Order / Job Specific' },
              { value: 'EMERGENCY', label: 'Emergency / Direct Purchase' },
              { value: 'SAMPLE', label: 'Sample Development Purchase' },
              { value: 'MAINTENANCE', label: 'Machine Maintenance / Spares' },
            ]}
            value={head.purchase_type}
            onChange={(e) => setHead({ ...head, purchase_type: e.target.value })}
            required
          />

          <Input
            label="Supplier Bill / Invoice No"
            value={head.supplier_inv_no}
            onChange={(e) => setHead({ ...head, supplier_inv_no: e.target.value })}
            placeholder="e.g. INV-2026-458"
          />

          <Input
            label="Supplier Bill Date"
            type="date"
            value={head.supplier_inv_date}
            onChange={(e) => setHead({ ...head, supplier_inv_date: e.target.value })}
          />

          <Select
            label="Currency"
            options={toOptions(currencies.data || [])}
            value={head.currency_id}
            onChange={(e) => setHead({ ...head, currency_id: e.target.value })}
          />

          <Input
            label="Payment Terms"
            value={head.payment_terms}
            onChange={(e) => setHead({ ...head, payment_terms: e.target.value })}
            placeholder="e.g. 30 Days Net, Immediate"
          />
        </div>

        <div className="mt-4">
          <Input
            label="Purchase Remarks / Costing Notes"
            value={head.remarks}
            onChange={(e) => setHead({ ...head, remarks: e.target.value })}
            placeholder="Mention urgency, purpose, or special instructions..."
          />
        </div>
      </div>

      {/* Core ERP Rule Notice */}
      <div className="flex items-start gap-3 rounded-lg border border-sky-200 bg-sky-50/70 p-3.5 text-xs text-sky-900">
        <Sparkles size={18} className="mt-0.5 text-sky-600 shrink-0" />
        <div>
          <span className="font-bold">ERP Costing Rule:</span> Purchase = Stock &amp; Financial Entry. Material Issue / Consumption = Order Cost.
          Purchased material remains in inventory until issued. Enable <span className="font-bold text-emerald-700 bg-emerald-100 px-1 rounded">⚡ Direct Issue</span> on a line to immediately issue emergency purchases (e.g. 1 urgent thread cone, 10 sample buttons) into Actual Order Costing with 0 remaining in unissued stock.
        </div>
      </div>

      {/* Item Lines Grid */}
      <div className="rounded-xl border border-surface-border bg-white p-5 shadow-xs">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-surface-border pb-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-800">
              Purchase Line Items &amp; Allocation
            </h2>
            <p className="text-xs text-slate-500">
              Multi-purpose invoice: each line can be allocated to General Stock, Buyer Order, Production Order, Sample, or Maintenance.
            </p>
          </div>

          <button
            type="button"
            className="btn-secondary text-xs flex items-center gap-1.5"
            onClick={handleAddLine}
          >
            <Plus size={14} /> Add Item Line
          </button>
        </div>

        {/* Lines Table / Cards */}
        <div className="space-y-4">
          {lines.map((line, idx) => (
            <div
              key={line._key}
              className="rounded-lg border border-slate-200 bg-slate-50/50 p-4 transition-all hover:border-slate-300"
            >
              {/* Top Row: Item, Qty, Rate, Tax, Line Total, Actions */}
              <div className="grid grid-cols-1 md:grid-cols-12 gap-3 items-end">
                <div className="md:col-span-4">
                  <Input
                    label={`#${idx + 1} Item Description *`}
                    value={line.item_description}
                    onChange={(e) => handleUpdateLine(line._key, 'item_description', e.target.value)}
                    placeholder="e.g. Sewing Thread 40s/2, Machine Needle 14#, Carton Box"
                    required
                  />
                </div>

                <div className="md:col-span-2">
                  <Select
                    label="Material Type"
                    options={[
                      { value: 'TRIM', label: 'Trim / Accessory' },
                      { value: 'YARN', label: 'Yarn' },
                      { value: 'FABRIC', label: 'Fabric' },
                      { value: 'CONSUMABLE', label: 'Consumable' },
                      { value: 'SPARE', label: 'Machine Spare' },
                      { value: 'EXPENSE', label: 'General Expense' },
                      { value: 'OTHER', label: 'Other Item' },
                    ]}
                    value={line.material_type}
                    onChange={(e) => handleUpdateLine(line._key, 'material_type', e.target.value)}
                  />
                </div>

                <div className="md:col-span-1">
                  <Input
                    label="Qty *"
                    type="number"
                    min="0"
                    step="any"
                    value={line.qty}
                    onChange={(e) => handleUpdateLine(line._key, 'qty', e.target.value)}
                    required
                  />
                </div>

                <div className="md:col-span-1">
                  <Select
                    label="UOM *"
                    options={toOptions(uoms.data || [])}
                    value={line.uom_id}
                    onChange={(e) => handleUpdateLine(line._key, 'uom_id', e.target.value)}
                    required
                  />
                </div>

                <div className="md:col-span-1">
                  <Input
                    label="Rate (₹)"
                    type="number"
                    min="0"
                    step="0.01"
                    value={line.rate}
                    onChange={(e) => handleUpdateLine(line._key, 'rate', e.target.value)}
                    required
                  />
                </div>

                <div className="md:col-span-1">
                  <Input
                    label="GST %"
                    type="number"
                    min="0"
                    step="1"
                    value={line.gst_rate}
                    onChange={(e) => handleUpdateLine(line._key, 'gst_rate', e.target.value)}
                  />
                </div>

                <div className="md:col-span-1">
                  <div className="text-xs font-semibold text-slate-500 mb-1.5">Line Total</div>
                  <div className="rounded-md border border-slate-200 bg-white px-2 py-1.5 text-right font-mono font-bold text-slate-900 text-xs">
                    ₹{fmtDecimal(line.amount, 2)}
                  </div>
                </div>

                <div className="md:col-span-1 flex items-center justify-end gap-1">
                  <button
                    type="button"
                    onClick={() => handleDuplicateLine(line._key)}
                    className="rounded p-1.5 text-slate-400 hover:bg-slate-200 hover:text-slate-700"
                    title="Duplicate line"
                  >
                    <Copy size={15} />
                  </button>
                  <button
                    type="button"
                    onClick={() => handleRemoveLine(line._key)}
                    className="rounded p-1.5 text-rose-500 hover:bg-rose-100"
                    title="Remove line"
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              </div>

              {/* Bottom Row: Allocation Type, Dynamic References & Direct Issue */}
              <div className="mt-3 pt-3 border-t border-slate-200/80 grid grid-cols-1 md:grid-cols-12 gap-3 items-center bg-white/60 -mx-4 -mb-4 p-3 rounded-b-lg">
                <div className="md:col-span-3">
                  <Select
                    label="Allocation Type *"
                    options={[
                      { value: 'GENERAL_STOCK', label: '📦 General Stock (Warehouse)' },
                      { value: 'BUYER_ORDER', label: '🏷️ Buyer Order (SO / Style)' },
                      { value: 'PRODUCTION_ORDER', label: '⚙️ Production Order / WO' },
                      { value: 'SAMPLE', label: '🧪 Sample No / Style' },
                      { value: 'JOB_WORK', label: '🧵 Job Work Order' },
                      { value: 'MAINTENANCE', label: '🔧 Maintenance / Machine' },
                      { value: 'DEPARTMENT', label: '🏢 Department / Cost Centre' },
                      { value: 'DIRECT_EXPENSE', label: '💳 Direct Expense / GL' },
                    ]}
                    value={line.allocation_type}
                    onChange={(e) => handleUpdateLine(line._key, 'allocation_type', e.target.value)}
                  />
                </div>

                {/* Dynamic Reference Selector based on Allocation Type */}
                <div className="md:col-span-5">
                  {line.allocation_type === 'BUYER_ORDER' && (
                    <div className="grid grid-cols-2 gap-2">
                      <Select
                        label="Sales Order (SO) *"
                        options={toOptions(salesOrders.data || [])}
                        value={line.so_id || ''}
                        onChange={(e) => handleUpdateLine(line._key, 'so_id', e.target.value)}
                        placeholder="Select SO"
                      />
                      <Select
                        label="Style"
                        options={toOptions(styles.data || [])}
                        value={line.style_id || ''}
                        onChange={(e) => handleUpdateLine(line._key, 'style_id', e.target.value)}
                        placeholder="Select Style"
                      />
                    </div>
                  )}

                  {line.allocation_type === 'PRODUCTION_ORDER' && (
                    <div className="grid grid-cols-2 gap-2">
                      <Input
                        label="Production / Work Order *"
                        value={line.prod_order_id || ''}
                        onChange={(e) => handleUpdateLine(line._key, 'prod_order_id', e.target.value)}
                        placeholder="e.g. WO-2026-0045"
                      />
                      <Select
                        label="Style"
                        options={toOptions(styles.data || [])}
                        value={line.style_id || ''}
                        onChange={(e) => handleUpdateLine(line._key, 'style_id', e.target.value)}
                        placeholder="Select Style"
                      />
                    </div>
                  )}

                  {line.allocation_type === 'SAMPLE' && (
                    <div className="grid grid-cols-2 gap-2">
                      <Input
                        label="Sample No *"
                        value={line.sample_id || ''}
                        onChange={(e) => handleUpdateLine(line._key, 'sample_id', e.target.value)}
                        placeholder="e.g. SMP-0042"
                      />
                      <Input
                        label="Sample Type"
                        value={line.sample_type || ''}
                        onChange={(e) => handleUpdateLine(line._key, 'sample_type', e.target.value)}
                        placeholder="Proto / Fit / Size Set"
                      />
                    </div>
                  )}

                  {line.allocation_type === 'JOB_WORK' && (
                    <div className="grid grid-cols-2 gap-2">
                      <Input
                        label="Job Work No *"
                        value={line.jobwork_id || ''}
                        onChange={(e) => handleUpdateLine(line._key, 'jobwork_id', e.target.value)}
                        placeholder="e.g. JWC-0012"
                      />
                      <Input
                        label="Process"
                        value={line.process_name || ''}
                        onChange={(e) => handleUpdateLine(line._key, 'process_name', e.target.value)}
                        placeholder="Embroidery / Washing"
                      />
                    </div>
                  )}

                  {line.allocation_type === 'MAINTENANCE' && (
                    <div className="grid grid-cols-2 gap-2">
                      <Select
                        label="Department"
                        options={toOptions(departments.data || [])}
                        value={line.department_id || ''}
                        onChange={(e) => handleUpdateLine(line._key, 'department_id', e.target.value)}
                        placeholder="Dept"
                      />
                      <Input
                        label="Machine / Job ID *"
                        value={line.machine_id || ''}
                        onChange={(e) => handleUpdateLine(line._key, 'machine_id', e.target.value)}
                        placeholder="e.g. KNIT-M04, SEW-L2"
                      />
                    </div>
                  )}

                  {line.allocation_type === 'DEPARTMENT' && (
                    <div className="grid grid-cols-2 gap-2">
                      <Select
                        label="Department *"
                        options={toOptions(departments.data || [])}
                        value={line.department_id || ''}
                        onChange={(e) => handleUpdateLine(line._key, 'department_id', e.target.value)}
                        placeholder="Select Dept"
                      />
                      <Input
                        label="Cost Centre"
                        value={line.cost_centre || ''}
                        onChange={(e) => handleUpdateLine(line._key, 'cost_centre', e.target.value)}
                        placeholder="e.g. ADMIN-HQ"
                      />
                    </div>
                  )}

                  {line.allocation_type === 'DIRECT_EXPENSE' && (
                    <Input
                      label="Expense Head / GL *"
                      value={line.expense_head || ''}
                      onChange={(e) => handleUpdateLine(line._key, 'expense_head', e.target.value)}
                      placeholder="e.g. Printing & Stationery, Courier, Repairs"
                    />
                  )}

                  {line.allocation_type === 'GENERAL_STOCK' && (
                    <Select
                      label="Receiving Warehouse"
                      options={toOptions(warehouses.data || [])}
                      value={line.warehouse_id || ''}
                      onChange={(e) => handleUpdateLine(line._key, 'warehouse_id', e.target.value)}
                      placeholder="Select Store (e.g. RM Store, Trims Store)"
                    />
                  )}
                </div>

                {/* Direct Issue Checkbox / Toggle */}
                <div className="md:col-span-4 flex items-center justify-between border-l border-slate-200 pl-3">
                  <label className="flex items-center gap-2 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
                      checked={line.direct_issue === 1}
                      onChange={(e) => handleUpdateLine(line._key, 'direct_issue', e.target.checked ? 1 : 0)}
                    />
                    <div>
                      <div className="text-xs font-bold text-slate-800 flex items-center gap-1">
                        <Zap size={13} className={line.direct_issue ? "fill-emerald-500 text-emerald-600" : "text-slate-400"} />
                        Direct Issue to Order / Job
                      </div>
                      <div className="text-[10px] text-slate-500">
                        {line.direct_issue
                          ? '⚡ Immediately charges Actual Costing; 0 in unissued stock'
                          : 'Remains in inventory until officially issued'}
                      </div>
                    </div>
                  </label>

                  {line.direct_issue === 1 && (
                    <span className="rounded-md bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-800">
                      DIRECT ISSUE
                    </span>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Grand Totals Summary Card */}
        <div className="mt-6 flex flex-wrap items-center justify-between gap-4 rounded-xl border border-slate-200 bg-slate-50 p-5">
          <div className="text-xs text-slate-600 space-y-1">
            <div>Total Line Items: <span className="font-bold text-slate-800">{lines.length}</span></div>
            <div>Direct Issue Lines: <span className="font-bold text-emerald-700">{lines.filter((l) => l.direct_issue === 1).length}</span></div>
          </div>

          <div className="flex items-center gap-6">
            <div className="text-right text-xs text-slate-500">
              <div>Subtotal: ₹{fmtDecimal(totals.subtotal, 2)}</div>
              {totals.totalDiscount > 0 && <div>Discount: -₹{fmtDecimal(totals.totalDiscount, 2)}</div>}
              <div>Tax (GST): +₹{fmtDecimal(totals.totalTax, 2)}</div>
            </div>

            <div className="border-l border-slate-300 pl-6 text-right">
              <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Grand Total</div>
              <div className="text-2xl font-black text-brand-700 font-mono">
                ₹{fmtDecimal(totals.grandTotal, 2)}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
