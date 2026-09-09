import { useState, useEffect, useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft, Save, Plus, Trash2, Disc,
  PackageCheck, FileSpreadsheet, Building2, Truck, RotateCcw
} from 'lucide-react';
import { http, ApiError } from '../../lib/api';
import { useLookup, toOptions } from '../../hooks/useLookup';
import { useToast } from '../../hooks/useToast';
import { Input, Select, StatusBadge, Modal } from '../../components/ui';
import { fmtDecimal, today } from '../../lib/format';

interface YarnLine {
  id?: number;
  _key: string;
  yarn_id: string | number;
  yarn_name?: string;
  yarn_type: 'Grey Yarn' | 'Dyed Yarn';
  purchase_basis: 'DIRECT_KG' | 'PACK_BAG';
  yarn_count_str: string;
  yarn_category: string;
  composition: string;
  shade_code: string;
  dyeing_mill_id: string;
  packs: number;
  pack_weight_kg: number;
  qty: number; // Total KG
  uom_id: number;
  rate: number;
  amount: number;
  discount_amount: number;
  freight_amount: number;
  other_charges: number;
  gst_rate: number;
  net_amount: number;
}

let yseq = 0;
const emptyYarnLine = (): YarnLine => ({
  _key: `yl_${++yseq}`,
  yarn_id: '',
  yarn_type: 'Grey Yarn',
  purchase_basis: 'DIRECT_KG',
  yarn_count_str: '30s',
  yarn_category: 'Combed',
  composition: '100% Cotton',
  shade_code: '',
  dyeing_mill_id: '',
  packs: 50,
  pack_weight_kg: 45.36,
  qty: 2268,
  uom_id: 5, // KG
  rate: 220.0,
  amount: 498960,
  discount_amount: 0,
  freight_amount: 0,
  other_charges: 0,
  gst_rate: 5.0,
  net_amount: 523908,
});

export default function YarnPurchaseOrderDetailPage() {
  const { id } = useParams<{ id: string }>();
  const isNew = !id || id === 'new';
  const nav = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();

  const suppliers = useLookup('suppliers');
  const yarns = useLookup('yarns');
  const styles = useLookup('styles');
  const parties = useLookup('parties');

  const COMPANY_DEFAULT_ADDRESS = "CK Exports\n123 Textile Park, Dharapuram Road\nTirupur - 641604, Tamil Nadu\nGSTIN: 33AAAAA0000A1Z5";

  const [saving, setSaving] = useState(false);
  const [quoteModalOpen, setQuoteModalOpen] = useState(false);
  const [selectedQuoteId, setSelectedQuoteId] = useState<string>('');

  // PO Header State
  const [header, setHeader] = useState({
    po_no: '',
    po_date: today(),
    delivery_date: '',
    internal_ir_no: 'IR-2026-0001',
    supplier_id: '',
    style_id: '',
    payment_terms: '30 Days Credit',
    remarks: '',
    approval_state: 'APPROVED',
    billing_address: COMPANY_DEFAULT_ADDRESS,
    shipping_address: '',
    shipping_to_party_id: '',
    freight_charges: 0,
    other_charges: 0,
    tcs_applicable: false,
    tcs_section: '206C(1H)',
    tcs_rate: 0.1,
    round_off: 0,
  });

  const [lines, setLines] = useState<YarnLine[]>([emptyYarnLine()]);

  // Load existing PO
  const { data: existingPo, isLoading } = useQuery({
    queryKey: ['purchase-order-yarn', id],
    queryFn: async () => {
      if (isNew) return null;
      const res = await http.get<{ data: any }>(`/purchase-orders/${id}`);
      return res.data;
    },
    enabled: !isNew,
  });

  // Approved Yarn Quotations for modal
  const { data: approvedQuotes = [] } = useQuery({
    queryKey: ['yarn-quotations-approved'],
    queryFn: async () => {
      const res = await http.get<{ data: any[] }>('/quotations');
      return res.data || [];
    },
    enabled: isNew && quoteModalOpen,
  });

  useEffect(() => {
    if (existingPo) {
      setHeader({
        po_no: existingPo.po_no || '',
        po_date: existingPo.po_date?.slice(0, 10) || today(),
        delivery_date: existingPo.delivery_date?.slice(0, 10) || '',
        internal_ir_no: existingPo.internal_ir_no || '',
        supplier_id: existingPo.supplier_id ? String(existingPo.supplier_id) : '',
        style_id: existingPo.style_id ? String(existingPo.style_id) : '',
        payment_terms: existingPo.payment_terms || '',
        remarks: existingPo.remarks || '',
        approval_state: existingPo.approval_state || 'APPROVED',
        billing_address: existingPo.billing_address || COMPANY_DEFAULT_ADDRESS,
        shipping_address: existingPo.shipping_address || '',
        shipping_to_party_id: existingPo.shipping_to_party_id ? String(existingPo.shipping_to_party_id) : '',
        freight_charges: Number(existingPo.freight_charges) || 0,
        other_charges: Number(existingPo.other_charges) || 0,
        tcs_applicable: !!existingPo.tcs_applicable,
        tcs_section: existingPo.tcs_section || '206C(1H)',
        tcs_rate: Number(existingPo.tcs_rate) || 0.1,
        round_off: Number(existingPo.round_off) || 0,
      });

      if (existingPo.lines?.length) {
        const mappedLines: YarnLine[] = existingPo.lines.map((l: any) => ({
          id: l.id,
          _key: `yl_${l.id}`,
          yarn_id: l.yarn_id || '',
          yarn_name: l.yarn_name,
          yarn_type: (l.yarn_type as any) || 'Grey Yarn',
          purchase_basis: (l.purchase_basis as any) || 'DIRECT_KG',
          yarn_count_str: l.yarn_count_str || '30s',
          yarn_category: l.yarn_category || 'Combed',
          composition: l.composition || '100% Cotton',
          shade_code: l.shade_code || '',
          dyeing_mill_id: l.dyeing_mill_id ? String(l.dyeing_mill_id) : '',
          packs: Number(l.packs) || 0,
          pack_weight_kg: Number(l.pack_weight_kg) || 0,
          qty: Number(l.qty) || 0,
          uom_id: l.uom_id || 5,
          rate: Number(l.rate) || 0,
          amount: Number(l.amount) || 0,
          discount_amount: Number(l.discount_amount) || 0,
          freight_amount: Number(l.freight_amount) || 0,
          other_charges: Number(l.other_charges) || 0,
          gst_rate: Number(l.gst_rate) || 5.0,
          net_amount: Number(l.net_amount) || Number(l.amount) || 0,
        }));
        setLines(mappedLines);
      }
    }
  }, [existingPo, isNew]);

  // Recalculate line amounts
  const updateLine = (idx: number, updates: Partial<YarnLine>) => {
    setLines((prev) => {
      const copy = [...prev];
      const cur = { ...copy[idx], ...updates };

      // Calculate Qty if PACK_BAG
      if (cur.purchase_basis === 'PACK_BAG') {
        cur.qty = Math.round((Number(cur.packs || 0) * Number(cur.pack_weight_kg || 0)) * 100) / 100;
      }

      // Financials
      const baseAmt = (Number(cur.qty) || 0) * (Number(cur.rate) || 0);
      cur.amount = Math.round(baseAmt * 100) / 100;
      const taxable = cur.amount - (Number(cur.discount_amount) || 0) + (Number(cur.freight_amount) || 0) + (Number(cur.other_charges) || 0);
      const taxAmt = Math.round((taxable * (Number(cur.gst_rate) || 0) / 100) * 100) / 100;
      cur.net_amount = Math.round((taxable + taxAmt) * 100) / 100;

      copy[idx] = cur;
      return copy;
    });
  };

  const removeLine = (idx: number) => {
    if (lines.length === 1) {
      toast('At least one yarn item is required', 'warning');
      return;
    }
    setLines((p) => p.filter((_, i) => i !== idx));
  };

  // Grand Totals
  const totals = useMemo(() => {
    let totalKg = 0;
    let greyKg = 0;
    let dyedKg = 0;
    let totalPacks = 0;
    let gross = 0;
    let tax = 0;
    let net = 0;

    for (const l of lines) {
      const kg = Number(l.qty) || 0;
      totalKg += kg;
      if (l.yarn_type === 'Dyed Yarn') {
        dyedKg += kg;
      } else {
        greyKg += kg;
      }
      if (l.purchase_basis === 'PACK_BAG') {
        totalPacks += Number(l.packs) || 0;
      }
      gross += Number(l.amount) || 0;
      const taxable = (Number(l.amount) || 0) - (Number(l.discount_amount) || 0) + (Number(l.freight_amount) || 0) + (Number(l.other_charges) || 0);
      tax += (taxable * (Number(l.gst_rate) || 0)) / 100;
      net += Number(l.net_amount) || 0;
    }

    const freight = Number(header.freight_charges) || 0;
    const other = Number(header.other_charges) || 0;
    const baseBeforeTcs = net + freight + other;
    const tcsAmt = header.tcs_applicable ? Math.round(((baseBeforeTcs * (Number(header.tcs_rate) || 0)) / 100) * 100) / 100 : 0;
    const roundOff = Number(header.round_off) || 0;
    const grandTotal = Math.round((baseBeforeTcs + tcsAmt + roundOff) * 100) / 100;

    return { totalKg, greyKg, dyedKg, totalPacks, gross, tax, net, freight, other, tcsAmt, roundOff, grandTotal };
  }, [lines, header.freight_charges, header.other_charges, header.tcs_applicable, header.tcs_rate, header.round_off]);

  const handleShipToPartyChange = (partyIdStr: string) => {
    if (!partyIdStr) {
      setHeader((h) => ({ ...h, shipping_to_party_id: '', shipping_address: '' }));
      return;
    }
    const found = (parties.data as any[])?.find((p) => String(p.id) === partyIdStr);
    let addr = '';
    if (found) {
      addr = found.label;
      if (found.default_address) {
        addr += `\n${found.default_address}`;
      }
      if (found.gstin) {
        addr += `\nGSTIN: ${found.gstin}`;
      }
    }
    setHeader((h) => ({
      ...h,
      shipping_to_party_id: partyIdStr,
      shipping_address: addr || h.shipping_address,
    }));
  };

  // Convert from Quotation
  const handleConvertQuotation = async () => {
    if (!selectedQuoteId) {
      toast('Please select a quotation', 'error');
      return;
    }

    try {
      const res = await http.post<{ data: { id: number; po_no: string } }>(
        '/yarn-purchase-orders/convert-from-quotation',
        {
          quotation_id: selectedQuoteId,
          required_date: header.delivery_date || undefined,
          remarks: `Converted from Yarn Quotation #${selectedQuoteId}`,
          billing_address: header.billing_address,
          shipping_address: header.shipping_address,
          shipping_to_party_id: header.shipping_to_party_id ? Number(header.shipping_to_party_id) : undefined,
        }
      );
      toast(`Successfully converted to PO ${res.data.po_no}!`, 'success');
      setQuoteModalOpen(false);
      nav(`/procurement/yarn/orders/${res.data.id}`);
    } catch (err: any) {
      const msg = err instanceof ApiError ? err.message : 'Failed to convert quotation';
      toast(msg, 'error');
    }
  };

  // Save PO
  const handleSave = async () => {
    if (!header.supplier_id) {
      toast('Please select a spinning mill or supplier', 'error');
      return;
    }

    setSaving(true);
    try {
      const payload = {
        po_type: 'MATERIAL',
        order_type: 'PRODUCTION',
        internal_ir_no: header.internal_ir_no,
        supplier_id: Number(header.supplier_id),
        style_id: header.style_id ? Number(header.style_id) : null,
        po_date: header.po_date,
        delivery_date: header.delivery_date || null,
        payment_terms: header.payment_terms,
        remarks: header.remarks,
        approval_state: header.approval_state,
        billing_address: header.billing_address || null,
        shipping_address: header.shipping_address || null,
        shipping_to_party_id: header.shipping_to_party_id ? Number(header.shipping_to_party_id) : null,
        currency_id: 1,
        exchange_rate: 1.0,
        total_amount: totals.gross,
        tax_amount: totals.tax,
        grand_total: totals.net,
        lines: lines.map((l) => ({
          material_type: 'YARN',
          yarn_id: Number(l.yarn_id) || null,
          description: l.yarn_name || `${l.yarn_type} ${l.yarn_count_str}`,
          yarn_type: l.yarn_type,
          purchase_basis: l.purchase_basis,
          yarn_count_str: l.yarn_count_str,
          yarn_category: l.yarn_category,
          composition: l.composition,
          shade_code: l.yarn_type === 'Dyed Yarn' ? l.shade_code : null,
          dyeing_mill_id: (l.yarn_type === 'Dyed Yarn' && l.dyeing_mill_id) ? Number(l.dyeing_mill_id) : null,
          packs: l.purchase_basis === 'PACK_BAG' ? l.packs : null,
          pack_weight_kg: l.purchase_basis === 'PACK_BAG' ? l.pack_weight_kg : null,
          qty: l.qty,
          uom_id: l.uom_id || 5,
          rate: l.rate,
          amount: l.amount,
          discount_amount: l.discount_amount,
          freight_amount: l.freight_amount,
          other_charges: l.other_charges,
          gst_rate: l.gst_rate,
          net_amount: l.net_amount,
        })),
      };

      if (isNew) {
        const res = await http.post<{ data: { id: number; po_no: string } }>('/purchase-orders', payload);
        toast(`Yarn PO ${res.data.po_no} created successfully!`, 'success');
        nav(`/procurement/yarn/orders/${res.data.id}`);
      } else {
        await http.put(`/purchase-orders/${id}`, payload);
        toast('Yarn PO updated successfully', 'success');
        qc.invalidateQueries({ queryKey: ['purchase-order-yarn', id] });
      }
    } catch (err: any) {
      const msg = err instanceof ApiError ? err.message : 'Failed to save yarn PO';
      toast(msg, 'error');
    } finally {
      setSaving(false);
    }
  };

  if (!isNew && isLoading) {
    return (
      <div className="py-20 text-center text-slate-400">
        Loading yarn purchase order #{id}...
      </div>
    );
  }

  return (
    <div className="space-y-5 pb-16">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b border-slate-200 pb-4">
        <div className="flex items-center gap-3">
          <button
            onClick={() => nav('/procurement/yarn/orders')}
            className="p-1.5 rounded-lg border border-slate-300 hover:bg-slate-100 text-slate-600 transition"
            title="Back to Yarn POs"
          >
            <ArrowLeft size={16} />
          </button>
          <div>
            <div className="flex items-center gap-2">
              <span className="p-1.5 rounded-md bg-amber-100 text-amber-700">
                <Disc size={18} />
              </span>
              <h1 className="text-xl font-bold text-slate-900 tracking-tight">
                {isNew ? 'New Yarn Purchase Order' : `Yarn PO: ${header.po_no}`}
              </h1>
              {!isNew && <StatusBadge value={header.approval_state} />}
            </div>
            <p className="text-xs text-slate-500 mt-0.5">
              Unified procurement for Grey & Dyed yarn, Direct KG & Bag/Pack weights
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {isNew && (
            <button
              onClick={() => setQuoteModalOpen(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-amber-300 bg-amber-50 hover:bg-amber-100 text-amber-800 shadow-sm transition"
            >
              <FileSpreadsheet size={14} />
              <span>Convert from Quotation</span>
            </button>
          )}

          {!isNew && (
            <button
              onClick={() => nav(`/procurement/yarn/grn/new?po_id=${id}`)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 shadow-sm transition"
            >
              <PackageCheck size={14} className="text-amber-600" />
              <span>Inward Yarn GRN</span>
            </button>
          )}

          <button
            onClick={handleSave}
            disabled={saving}
            className="inline-flex items-center gap-1.5 px-4 py-1.5 text-xs font-medium rounded-lg bg-amber-600 hover:bg-amber-700 text-white shadow-sm transition disabled:opacity-50"
          >
            <Save size={15} />
            <span>{saving ? 'Saving...' : 'Save Order'}</span>
          </button>
        </div>
      </div>

      {/* Header Fields Card */}
      <div className="bg-white p-4 rounded-xl border border-slate-200/80 shadow-sm space-y-4">
        <div className="text-xs font-semibold text-slate-900 uppercase tracking-wider flex items-center gap-1.5 pb-2 border-b border-slate-100">
          <Disc size={14} className="text-amber-600" />
          <span>Purchase Order Details</span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">
          <Input
            label="PO Number"
            value={header.po_no}
            onChange={(e) => setHeader((p) => ({ ...p, po_no: e.target.value }))}
            placeholder="Auto-generated if blank"
            disabled={!isNew}
          />

          <Input
            label="PO Date"
            type="date"
            value={header.po_date}
            onChange={(e) => setHeader((p) => ({ ...p, po_date: e.target.value }))}
          />

          <Input
            label="Required Delivery Date"
            type="date"
            value={header.delivery_date}
            onChange={(e) => setHeader((p) => ({ ...p, delivery_date: e.target.value }))}
          />

          <Select
            label="Spinning Mill / Supplier *"
            value={header.supplier_id}
            onChange={(e) => setHeader((p) => ({ ...p, supplier_id: e.target.value }))}
            options={toOptions(suppliers.data)}
            placeholder="Select Mill"
          />

          <Input
            label="Internal / IR No"
            value={header.internal_ir_no}
            onChange={(e) => setHeader((p) => ({ ...p, internal_ir_no: e.target.value }))}
            placeholder="e.g. IR-2026-0001"
          />

          <Select
            label="Style No (Optional)"
            value={header.style_id}
            onChange={(e) => setHeader((p) => ({ ...p, style_id: e.target.value }))}
            options={toOptions(styles.data)}
            placeholder="Select Style"
          />

          <Input
            label="Payment Terms"
            value={header.payment_terms}
            onChange={(e) => setHeader((p) => ({ ...p, payment_terms: e.target.value }))}
            placeholder="e.g. 30 Days LC / PDC"
          />

          <Select
            label="Approval State"
            value={header.approval_state}
            onChange={(e) => setHeader((p) => ({ ...p, approval_state: e.target.value }))}
            options={[
              { value: 'DRAFT', label: 'Draft' },
              { value: 'PENDING', label: 'Pending Approval' },
              { value: 'APPROVED', label: 'Approved & Active' },
              { value: 'CLOSED', label: 'Closed' },
            ]}
          />

          <div className="sm:col-span-4">
            <Input
              label="Remarks / Contract Specifications"
              value={header.remarks}
              onChange={(e) => setHeader((p) => ({ ...p, remarks: e.target.value }))}
              placeholder="e.g. CSP 3200 min, Contamination free yarn, 50 bags packed in poly covers."
            />
          </div>
        </div>
      </div>

      {/* Billing and Shipping Addresses */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Billing Address Card */}
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-xs flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2 text-slate-800 font-semibold text-xs">
                <span className="p-1 rounded bg-blue-100 text-blue-700">
                  <Building2 size={13} />
                </span>
                <span>Billing Address (Company Invoicing)</span>
              </div>
              <button
                type="button"
                onClick={() => setHeader((h) => ({ ...h, billing_address: COMPANY_DEFAULT_ADDRESS }))}
                className="text-[11px] text-blue-600 hover:text-blue-700 font-medium flex items-center gap-1"
                title="Reset to Head Office address"
              >
                <RotateCcw size={11} /> Reset Default
              </button>
            </div>
            <p className="text-[11px] text-slate-500 mb-2.5">
              Buyer company legal entity billed by the spinning mill
            </p>
          </div>
          <textarea
            rows={4}
            className="input w-full font-mono text-xs leading-relaxed resize-y"
            value={header.billing_address}
            onChange={(e) => setHeader({ ...header, billing_address: e.target.value })}
            placeholder="Enter company billing address with GSTIN..."
          />
        </div>

        {/* Shipping Address Card */}
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-xs flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2 text-slate-800 font-semibold text-xs">
                <span className="p-1 rounded bg-emerald-100 text-emerald-700">
                  <Truck size={13} />
                </span>
                <span>Shipping Address (Direct Delivery to Knitting Unit / Mill)</span>
              </div>
              <button
                type="button"
                onClick={() => setHeader((h) => ({ ...h, shipping_to_party_id: '', shipping_address: header.billing_address }))}
                className="text-[11px] text-slate-600 hover:text-slate-800 font-medium flex items-center gap-1"
                title="Copy from Billing Address"
              >
                Same as Billing
              </button>
            </div>
            <div className="mb-2">
              <Select
                label="Destination Knitting Unit / Mill / Warehouse"
                placeholder="Select knitting unit to auto-populate delivery address..."
                options={toOptions(parties.data)}
                value={header.shipping_to_party_id}
                onChange={(e) => handleShipToPartyChange(e.target.value)}
              />
            </div>
          </div>
          <textarea
            rows={3}
            className="input w-full font-mono text-xs leading-relaxed resize-y"
            value={header.shipping_address}
            onChange={(e) => setHeader({ ...header, shipping_address: e.target.value })}
            placeholder="Enter destination delivery address (Knitting unit, dyeing plant, or company warehouse)..."
          />
        </div>
      </div>

      {/* Multi-Item Yarn Grid Cockpit */}
      <div className="bg-white rounded-xl border border-slate-200/80 shadow-sm overflow-hidden space-y-3 p-4">
        <div className="flex items-center justify-between pb-2 border-b border-slate-100">
          <div>
            <h2 className="text-xs font-semibold text-slate-900 uppercase tracking-wider flex items-center gap-1.5">
              <Disc size={14} className="text-amber-600" />
              <span>Yarn Line Items ({lines.length})</span>
            </h2>
            <p className="text-[11px] text-slate-400">
              Select Grey or Dyed Yarn, specify Direct KG or Pack/Bag basis (auto-multiplies Total KG)
            </p>
          </div>
          <button
            onClick={() => setLines((p) => [...p, emptyYarnLine()])}
            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 shadow-sm transition"
          >
            <Plus size={13} />
            <span>Add Yarn Item</span>
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="bg-slate-50 text-slate-600 font-semibold border-b border-slate-200">
                <th className="py-2.5 px-3">Yarn Master Item</th>
                <th className="py-2.5 px-2">Type</th>
                <th className="py-2.5 px-2">Count</th>
                <th className="py-2.5 px-2">Category</th>
                <th className="py-2.5 px-2">Composition</th>
                <th className="py-2.5 px-2">Dyed Specs</th>
                <th className="py-2.5 px-2">Basis</th>
                <th className="py-2.5 px-2 text-center">Packs × Wt</th>
                <th className="py-2.5 px-2 text-right">Total KG</th>
                <th className="py-2.5 px-2 text-right">Rate/KG (₹)</th>
                <th className="py-2.5 px-2 text-right">Amount (₹)</th>
                <th className="py-2.5 px-2 text-center">GST %</th>
                <th className="py-2.5 px-2 text-right">Net (₹)</th>
                <th className="py-2.5 px-2 text-center">Del</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-slate-700">
              {lines.map((l, idx) => {
                const isDyed = l.yarn_type === 'Dyed Yarn';
                const isPack = l.purchase_basis === 'PACK_BAG';

                return (
                  <tr key={l._key || idx} className="hover:bg-slate-50/70 transition">
                    {/* Master Yarn Selection */}
                    <td className="py-2.5 px-3 min-w-[140px]">
                      <select
                        value={l.yarn_id}
                        onChange={(e) => {
                          const val = e.target.value;
                          const opt: any = (yarns.data || []).find((y: any) => String(y.id) === val);
                          updateLine(idx, {
                            yarn_id: val,
                            yarn_name: opt?.yarn_name || '',
                            yarn_count_str: String(opt?.yarn_count || l.yarn_count_str),
                            composition: String(opt?.composition || l.composition),
                          });
                        }}
                        className="w-full text-xs rounded border border-slate-300 py-1 px-1.5 focus:border-amber-500"
                      >
                        <option value="">Select Yarn</option>
                        {toOptions(yarns.data).map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    </td>

                    {/* Yarn Type: Grey Yarn vs Dyed Yarn */}
                    <td className="py-2.5 px-2">
                      <select
                        value={l.yarn_type}
                        onChange={(e) =>
                          updateLine(idx, { yarn_type: e.target.value as 'Grey Yarn' | 'Dyed Yarn' })
                        }
                        className={`text-xs rounded border py-1 px-1.5 font-semibold ${
                          isDyed
                            ? 'bg-purple-50 text-purple-700 border-purple-300'
                            : 'bg-amber-50 text-amber-800 border-amber-300'
                        }`}
                      >
                        <option value="Grey Yarn">Grey Yarn</option>
                        <option value="Dyed Yarn">Dyed Yarn</option>
                      </select>
                    </td>

                    {/* Count */}
                    <td className="py-2.5 px-2">
                      <input
                        type="text"
                        value={l.yarn_count_str}
                        onChange={(e) => updateLine(idx, { yarn_count_str: e.target.value })}
                        className="w-16 text-xs font-mono font-medium border border-slate-300 rounded px-1.5 py-1"
                        placeholder="30s"
                      />
                    </td>

                    {/* Category */}
                    <td className="py-2.5 px-2">
                      <select
                        value={l.yarn_category}
                        onChange={(e) => updateLine(idx, { yarn_category: e.target.value })}
                        className="w-20 text-xs rounded border border-slate-300 py-1 px-1"
                      >
                        <option value="Combed">Combed</option>
                        <option value="Carded">Carded</option>
                        <option value="Compact">Compact</option>
                        <option value="OE">OE</option>
                        <option value="Slub">Slub</option>
                        <option value="Melange">Melange</option>
                      </select>
                    </td>

                    {/* Composition */}
                    <td className="py-2.5 px-2">
                      <input
                        type="text"
                        value={l.composition}
                        onChange={(e) => updateLine(idx, { composition: e.target.value })}
                        className="w-24 text-xs border border-slate-300 rounded px-1.5 py-1"
                        placeholder="100% Cotton"
                      />
                    </td>

                    {/* Conditional Dyed Specs */}
                    <td className="py-2.5 px-2">
                      {isDyed ? (
                        <div className="space-y-1">
                          <input
                            type="text"
                            value={l.shade_code}
                            onChange={(e) => updateLine(idx, { shade_code: e.target.value })}
                            placeholder="Shade/Colour"
                            className="w-24 text-[11px] border border-purple-300 rounded px-1.5 py-0.5 bg-purple-50/50"
                          />
                          <select
                            value={l.dyeing_mill_id}
                            onChange={(e) => updateLine(idx, { dyeing_mill_id: e.target.value })}
                            className="w-24 text-[10px] border border-slate-300 rounded px-1 py-0.5"
                          >
                            <option value="">Dyeing Mill</option>
                            {toOptions(suppliers.data).map((s) => (
                              <option key={s.value} value={s.value}>
                                {s.label}
                              </option>
                            ))}
                          </select>
                        </div>
                      ) : (
                        <span className="text-[11px] text-slate-400 italic">N/A (Grey)</span>
                      )}
                    </td>

                    {/* Purchase Basis: DIRECT_KG vs PACK_BAG */}
                    <td className="py-2.5 px-2">
                      <select
                        value={l.purchase_basis}
                        onChange={(e) =>
                          updateLine(idx, { purchase_basis: e.target.value as any })
                        }
                        className="text-xs rounded border border-slate-300 py-1 px-1 font-medium text-slate-700"
                      >
                        <option value="DIRECT_KG">Direct KG</option>
                        <option value="PACK_BAG">Pack / Bag</option>
                      </select>
                    </td>

                    {/* Packs × Weight */}
                    <td className="py-2.5 px-2 text-center">
                      {isPack ? (
                        <div className="flex items-center gap-1 justify-center">
                          <input
                            type="number"
                            value={l.packs}
                            onChange={(e) =>
                              updateLine(idx, { packs: parseInt(e.target.value) || 0 })
                            }
                            className="w-12 text-xs text-center border border-slate-300 rounded px-1 py-1 font-semibold"
                            placeholder="Bags"
                          />
                          <span className="text-slate-400">×</span>
                          <input
                            type="number"
                            value={l.pack_weight_kg}
                            onChange={(e) =>
                              updateLine(idx, { pack_weight_kg: parseFloat(e.target.value) || 0 })
                            }
                            className="w-14 text-xs text-center border border-slate-300 rounded px-1 py-1"
                            placeholder="kg"
                          />
                        </div>
                      ) : (
                        <span className="text-slate-400 text-[11px]">—</span>
                      )}
                    </td>

                    {/* Total KG */}
                    <td className="py-2.5 px-2 text-right">
                      {isPack ? (
                        <span className="font-bold text-amber-700">{fmtDecimal(l.qty)} kg</span>
                      ) : (
                        <input
                          type="number"
                          value={l.qty}
                          onChange={(e) =>
                            updateLine(idx, { qty: parseFloat(e.target.value) || 0 })
                          }
                          className="w-20 text-xs text-right font-bold text-amber-700 border border-slate-300 rounded px-1.5 py-1"
                        />
                      )}
                    </td>

                    {/* Rate / KG */}
                    <td className="py-2.5 px-2 text-right">
                      <input
                        type="number"
                        value={l.rate}
                        onChange={(e) =>
                          updateLine(idx, { rate: parseFloat(e.target.value) || 0 })
                        }
                        className="w-20 text-xs text-right font-medium border border-slate-300 rounded px-1.5 py-1"
                      />
                    </td>

                    {/* Amount */}
                    <td className="py-2.5 px-2 text-right font-semibold text-slate-900">
                      ₹{fmtDecimal(l.amount)}
                    </td>

                    {/* GST % */}
                    <td className="py-2.5 px-2 text-center">
                      <select
                        value={l.gst_rate}
                        onChange={(e) =>
                          updateLine(idx, { gst_rate: parseFloat(e.target.value) || 0 })
                        }
                        className="text-xs rounded border border-slate-300 py-1 px-1 text-center"
                      >
                        <option value="5">5%</option>
                        <option value="12">12%</option>
                        <option value="18">18%</option>
                        <option value="0">0%</option>
                      </select>
                    </td>

                    {/* Net Amount */}
                    <td className="py-2.5 px-2 text-right font-bold text-slate-900">
                      ₹{fmtDecimal(l.net_amount)}
                    </td>

                    {/* Delete */}
                    <td className="py-2.5 px-2 text-center">
                      <button
                        onClick={() => removeLine(idx)}
                        className="p-1 text-slate-400 hover:text-red-600 rounded transition"
                      >
                        <Trash2 size={13} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Footer Financial Cockpit */}
        <div className="pt-4 border-t border-slate-200 bg-slate-50/70 p-4 rounded-xl space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-4 text-xs pb-3 border-b border-slate-200">
            <div>
              <span className="text-slate-500 block">Total Yarn Weight</span>
              <span className="font-bold text-amber-700 text-sm">{fmtDecimal(totals.totalKg)} KG</span>
            </div>
            <div>
              <span className="text-slate-500 block">Grey / Dyed Split</span>
              <span className="font-medium text-slate-800">
                {fmtDecimal(totals.greyKg)} / {fmtDecimal(totals.dyedKg)} KG
              </span>
            </div>
            <div>
              <span className="text-slate-500 block">Total Bags / Packs</span>
              <span className="font-bold text-slate-800 text-sm">{totals.totalPacks} Bags</span>
            </div>
            <div>
              <span className="text-slate-500 block">GST Taxes</span>
              <span className="font-bold text-slate-800 text-sm">₹{fmtDecimal(totals.tax)}</span>
            </div>
            <div className="text-right sm:text-left">
              <span className="text-slate-500 block">Items Subtotal</span>
              <span className="font-bold text-slate-900 text-sm">₹{fmtDecimal(totals.net)}</span>
            </div>
          </div>

          {/* Footer Financial Adjustments & TCS */}
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-4 items-end">
            <div>
              <label className="label text-[11px] font-bold text-slate-700">Freight / Transport Charges (₹)</label>
              <input
                type="number"
                step="10"
                value={header.freight_charges}
                onChange={(e) => setHeader((h) => ({ ...h, freight_charges: parseFloat(e.target.value) || 0 }))}
                className="input py-1.5 text-xs text-right font-mono"
                placeholder="0.00"
              />
            </div>

            <div>
              <label className="label text-[11px] font-bold text-slate-700">Other / Unloading Charges (₹)</label>
              <input
                type="number"
                step="10"
                value={header.other_charges}
                onChange={(e) => setHeader((h) => ({ ...h, other_charges: parseFloat(e.target.value) || 0 }))}
                className="input py-1.5 text-xs text-right font-mono"
                placeholder="0.00"
              />
            </div>

            <div className="p-2.5 rounded-lg border border-amber-200 bg-amber-50/60 space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="flex items-center gap-1.5 text-[11px] font-bold text-amber-900 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={header.tcs_applicable}
                    onChange={(e) => setHeader((h) => ({ ...h, tcs_applicable: e.target.checked }))}
                    className="rounded border-amber-300 text-amber-600 focus:ring-amber-500"
                  />
                  <span>TCS Applicable</span>
                </label>
                {header.tcs_applicable && (
                  <span className="text-[11px] font-bold font-mono text-amber-800">
                    + ₹{fmtDecimal(totals.tcsAmt)}
                  </span>
                )}
              </div>
              {header.tcs_applicable && (
                <div className="flex items-center gap-1.5 text-[11px]">
                  <select
                    value={header.tcs_section}
                    onChange={(e) => setHeader((h) => ({ ...h, tcs_section: e.target.value }))}
                    className="input py-0.5 px-1.5 text-[10px] w-24"
                  >
                    <option value="206C(1H)">206C(1H)</option>
                    <option value="206C(1)">206C(1)</option>
                  </select>
                  <input
                    type="number"
                    step="0.01"
                    value={header.tcs_rate}
                    onChange={(e) => setHeader((h) => ({ ...h, tcs_rate: parseFloat(e.target.value) || 0 }))}
                    className="input py-0.5 px-1.5 text-[10px] text-right font-mono w-16"
                    placeholder="0.10"
                  />
                  <span className="text-slate-500">%</span>
                </div>
              )}
            </div>

            <div className="flex flex-col items-end justify-center bg-white p-3 rounded-lg border border-slate-200 shadow-sm">
              <span className="text-[11px] text-slate-500 font-bold uppercase tracking-wider block">Net Payable Amount</span>
              <span className="text-xl font-black text-brand-900 font-mono">₹{fmtDecimal(totals.grandTotal)}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Convert from Quotation Modal */}
      {quoteModalOpen && (
        <Modal
          title="Convert Yarn Quotation to PO"
          open={quoteModalOpen}
          onClose={() => setQuoteModalOpen(false)}
        >
          <div className="space-y-4 text-xs">
            <p className="text-slate-600">
              Select an approved Yarn Quotation to automatically pull items, counts, rates, and supplier details into a Purchase Order.
            </p>

            <div>
              <label className="block text-[11px] font-medium text-slate-700 mb-1">
                Approved Quotations
              </label>
              <select
                value={selectedQuoteId}
                onChange={(e) => setSelectedQuoteId(e.target.value)}
                className="w-full text-xs rounded-lg border border-slate-300 py-2 px-2.5 focus:border-amber-500"
              >
                <option value="">-- Choose Quotation --</option>
                {approvedQuotes.map((q) => (
                  <option key={q.id} value={q.id}>
                    {q.quotation_no} - {q.supplier_name || q.buyer_name || 'Mill'} (₹{fmtDecimal(q.total_amount)})
                  </option>
                ))}
              </select>
            </div>

            <div className="flex justify-end gap-2 pt-3 border-t border-slate-100">
              <button
                onClick={() => setQuoteModalOpen(false)}
                className="px-3 py-1.5 rounded-lg border border-slate-300 hover:bg-slate-50 text-slate-700"
              >
                Cancel
              </button>
              <button
                onClick={handleConvertQuotation}
                disabled={!selectedQuoteId}
                className="px-4 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-700 text-white font-medium disabled:opacity-50"
              >
                Convert & Open PO
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
