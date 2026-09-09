import { useState, useEffect, useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft, Save, CheckCircle, Plus, Trash2, Layers,
  PackageCheck, FileSpreadsheet, Building2, Truck, RotateCcw
} from 'lucide-react';
import { http, ApiError } from '../../lib/api';
import { useLookup, toOptions } from '../../hooks/useLookup';
import { useToast } from '../../hooks/useToast';
import { Input, Select, StatusBadge, Modal } from '../../components/ui';
import { fmtDecimal, today } from '../../lib/format';

interface FabricLine {
  id?: number;
  _key: string;
  fabric_id: string | number;
  fabric_name?: string;
  fabric_type: string;
  dia: string;
  gsm: string;
  composition: string;
  color_name: string;
  shade_code: string;
  print_flag: boolean;
  print_color: string;
  finish: string;
  mill_id: string;
  uom_id: number;
  qty: number;
  weight_kg: number;
  no_of_rolls: number;
  rate: number;
  amount: number;
  discount_amount: number;
  freight_amount: number;
  other_charges: number;
  gst_rate: number;
  net_amount: number;
}

let fseq = 0;
const emptyFabricLine = (): FabricLine => ({
  _key: `fl_${++fseq}`,
  fabric_id: '',
  fabric_type: 'Knitted',
  dia: '30"',
  gsm: '180',
  composition: '100% Cotton',
  color_name: 'Navy',
  shade_code: 'NVY-01',
  print_flag: false,
  print_color: '',
  finish: 'Compact',
  mill_id: '',
  uom_id: 9, // MTR
  qty: 1000,
  weight_kg: 250,
  no_of_rolls: 10,
  rate: 65.0,
  amount: 65000,
  discount_amount: 0,
  freight_amount: 0,
  other_charges: 0,
  gst_rate: 5.0,
  net_amount: 68250,
});

export default function FabricPurchaseOrderDetailPage() {
  const { id } = useParams();
  const isNew = id === 'new';
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();

  const [saving, setSaving] = useState(false);
  const [showQuoteModal, setShowQuoteModal] = useState(false);

  // Lookups
  const suppliers = useLookup('suppliers');
  const styles = useLookup('styles');
  const fabrics = useLookup('fabrics');
  const parties = useLookup('parties');

  const COMPANY_DEFAULT_ADDRESS = "CK Exports\n123 Textile Park, Dharapuram Road\nTirupur - 641604, Tamil Nadu\nGSTIN: 33AAAAA0000A1Z5";

  // Header state
  const [head, setHead] = useState({
    id: isNew ? undefined : Number(id),
    po_no: '',
    internal_ir_no: 'IR-2026-000125',
    po_date: today(),
    supplier_id: '',
    style_id: '',
    order_type: 'PRODUCTION',
    delivery_date: '',
    payment_terms: '30 Days Net',
    approval_state: 'DRAFT',
    remarks: '',
    billing_address: COMPANY_DEFAULT_ADDRESS,
    shipping_address: '',
    shipping_to_party_id: '',
  });

  const [lines, setLines] = useState<FabricLine[]>([emptyFabricLine()]);

  // Load existing PO
  const poQuery = useQuery({
    queryKey: ['fabric-purchase-order', id],
    queryFn: async () => {
      if (isNew) return null;
      const res = await http.get<{ data: any }>(`/purchase-orders/${id}`);
      return res.data;
    },
    enabled: !isNew,
  });

  useEffect(() => {
    if (poQuery.data) {
      const d = poQuery.data;
      setHead({
        id: d.id,
        po_no: d.po_no || '',
        internal_ir_no: d.internal_ir_no || 'IR-2026-000125',
        po_date: d.po_date?.slice(0, 10) || today(),
        supplier_id: String(d.supplier_id || ''),
        style_id: String(d.style_id || ''),
        order_type: d.order_type || 'PRODUCTION',
        delivery_date: d.delivery_date?.slice(0, 10) || '',
        payment_terms: d.payment_terms || '',
        approval_state: d.approval_state || 'DRAFT',
        remarks: d.remarks || '',
        billing_address: d.billing_address || COMPANY_DEFAULT_ADDRESS,
        shipping_address: d.shipping_address || '',
        shipping_to_party_id: d.shipping_to_party_id ? String(d.shipping_to_party_id) : '',
      });

      if (Array.isArray(d.lines) && d.lines.length > 0) {
        setLines(
          d.lines.map((l: any) => ({
            id: l.id,
            _key: `fl_${++fseq}`,
            fabric_id: l.fabric_id || '',
            fabric_type: l.fabric_type || 'Knitted',
            dia: l.dia || '30"',
            gsm: l.gsm || '180',
            composition: l.composition || '100% Cotton',
            color_name: l.color_id || 'Navy',
            shade_code: l.shade_code || 'NVY-01',
            print_flag: !!l.print_flag,
            print_color: l.print_color || '',
            finish: l.finish || 'Compact',
            mill_id: String(l.mill_id || ''),
            uom_id: l.uom_id || 9,
            qty: Number(l.qty) || 0,
            weight_kg: Number(l.weight_kg) || 0,
            no_of_rolls: Number(l.no_of_rolls) || 0,
            rate: Number(l.rate) || 0,
            amount: Number(l.amount) || 0,
            discount_amount: Number(l.discount_amount) || 0,
            freight_amount: Number(l.freight_amount) || 0,
            other_charges: Number(l.other_charges) || 0,
            gst_rate: Number(l.gst_rate) || 5.0,
            net_amount: Number(l.net_amount) || Number(l.amount) || 0,
          }))
        );
      }
    }
  }, [poQuery.data]);

  // Calculations
  const updateLine = (idx: number, patch: Partial<FabricLine>) => {
    setLines((prev) => {
      const next = [...prev];
      const cur = { ...next[idx], ...patch };
      const qty = Number(cur.qty) || 0;
      const rate = Number(cur.rate) || 0;
      const basicAmt = qty * rate;
      const disc = Number(cur.discount_amount) || 0;
      const freight = Number(cur.freight_amount) || 0;
      const other = Number(cur.other_charges) || 0;
      const taxable = Math.max(0, basicAmt - disc + freight + other);
      const tax = (taxable * (Number(cur.gst_rate) || 5.0)) / 100.0;
      cur.amount = basicAmt;
      cur.net_amount = taxable + tax;
      next[idx] = cur;
      return next;
    });
  };

  const totals = useMemo(() => {
    const totalQty = lines.reduce((s, l) => s + (Number(l.qty) || 0), 0);
    const totalWeight = lines.reduce((s, l) => s + (Number(l.weight_kg) || 0), 0);
    const totalRolls = lines.reduce((s, l) => s + (Number(l.no_of_rolls) || 0), 0);
    const basicAmount = lines.reduce((s, l) => s + (Number(l.amount) || 0), 0);
    const grandTotal = lines.reduce((s, l) => s + (Number(l.net_amount) || 0), 0);
    return { totalQty, totalWeight, totalRolls, basicAmount, grandTotal };
  }, [lines]);

  const handleShipToPartyChange = (partyIdStr: string) => {
    if (!partyIdStr) {
      setHead((h) => ({ ...h, shipping_to_party_id: '', shipping_address: '' }));
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
    setHead((h) => ({
      ...h,
      shipping_to_party_id: partyIdStr,
      shipping_address: addr || h.shipping_address,
    }));
  };

  // Save Handler
  const handleSave = async (stateOverride?: string) => {
    if (!head.supplier_id) {
      toast('Please select a Supplier', 'warning');
      return;
    }
    if (lines.length === 0 || !lines[0].fabric_id) {
      toast('Please add at least one Fabric line', 'warning');
      return;
    }

    setSaving(true);
    try {
      const payload = {
        po_no: head.po_no || undefined,
        internal_ir_no: head.internal_ir_no,
        po_date: head.po_date,
        supplier_id: Number(head.supplier_id),
        style_id: head.style_id ? Number(head.style_id) : undefined,
        po_type: 'MATERIAL',
        order_type: head.order_type,
        currency_id: 1,
        delivery_date: head.delivery_date || undefined,
        payment_terms: head.payment_terms,
        total_amount: totals.basicAmount,
        tax_amount: totals.grandTotal - totals.basicAmount,
        grand_total: totals.grandTotal,
        approval_state: stateOverride || head.approval_state,
        remarks: head.remarks,
        billing_address: head.billing_address || null,
        shipping_address: head.shipping_address || null,
        shipping_to_party_id: head.shipping_to_party_id ? Number(head.shipping_to_party_id) : null,
        lines: lines.map((l) => ({
          fabric_id: Number(l.fabric_id),
          material_type: 'FABRIC',
          description: `${l.composition} ${l.fabric_type} ${l.gsm} GSM`,
          fabric_type: l.fabric_type,
          dia: l.dia,
          gsm: l.gsm,
          composition: l.composition,
          shade_code: l.shade_code,
          print_flag: l.print_flag,
          print_color: l.print_color,
          finish: l.finish,
          mill_id: l.mill_id ? Number(l.mill_id) : undefined,
          uom_id: l.uom_id,
          qty: Number(l.qty),
          weight_kg: Number(l.weight_kg),
          no_of_rolls: Number(l.no_of_rolls),
          rate: Number(l.rate),
          amount: Number(l.amount),
          discount_amount: Number(l.discount_amount),
          freight_amount: Number(l.freight_amount),
          other_charges: Number(l.other_charges),
          gst_rate: Number(l.gst_rate),
          net_amount: Number(l.net_amount),
        })),
      };

      let saved: any;
      if (isNew) {
        const res = await http.post<{ data: any }>('/purchase-orders', payload);
        saved = res.data;
        toast(`Fabric PO ${saved.po_no} created successfully`, 'success');
        qc.invalidateQueries({ queryKey: ['fabric-purchase-orders'] });
        nav(`/procurement/fabric/orders/${saved.id}`, { replace: true });
      } else {
        const res = await http.put<{ data: any }>(`/purchase-orders/${id}`, payload);
        saved = res.data;
        setHead((h) => ({ ...h, approval_state: stateOverride || h.approval_state }));
        toast(`Fabric PO ${saved.po_no || head.po_no} updated`, 'success');
        qc.invalidateQueries({ queryKey: ['fabric-purchase-orders'] });
      }
    } catch (err) {
      toast((err as ApiError).message || 'Failed to save Fabric PO', 'error');
    } finally {
      setSaving(false);
    }
  };

  // Convert from Quotation
  const { data: fabricQuotes = [] } = useQuery({
    queryKey: ['approved-fabric-quotations'],
    queryFn: async () => {
      const res = await http.get<{ data: any[] }>('/quotations?quotation_type=FABRIC');
      return res.data || [];
    },
    enabled: showQuoteModal,
  });

  const handleConvertQuotation = async (quoteId: number) => {
    setSaving(true);
    try {
      const res = await http.post<{ data: any }>('/fabric-purchase-orders/convert-from-quotation', {
        quotation_id: quoteId,
        billing_address: head.billing_address,
        shipping_address: head.shipping_address,
        shipping_to_party_id: head.shipping_to_party_id ? Number(head.shipping_to_party_id) : undefined,
      });
      toast(`Converted into Fabric PO ${res.data.po_no}`, 'success');
      setShowQuoteModal(false);
      qc.invalidateQueries({ queryKey: ['fabric-purchase-orders'] });
      nav(`/procurement/fabric/orders/${res.data.id}`);
    } catch (err) {
      toast((err as ApiError).message || 'Failed to convert quotation', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b border-slate-200 pb-4">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => nav('/procurement/fabric/orders')}
            className="btn-ghost btn-sm p-1.5"
          >
            <ArrowLeft size={18} />
          </button>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-bold text-slate-900 tracking-tight">
                {isNew ? 'New Fabric Purchase Order' : `Fabric PO: ${head.po_no}`}
              </h1>
              <StatusBadge value={head.approval_state} />
            </div>
            <p className="text-xs text-slate-500 mt-0.5">
              Knitted / Woven fabric purchase specifications, roll targets, and rates
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {isNew && (
            <button
              type="button"
              onClick={() => setShowQuoteModal(true)}
              className="btn-secondary text-xs flex items-center gap-1.5"
            >
              <FileSpreadsheet size={14} /> Convert from Quotation
            </button>
          )}

          {!isNew && head.approval_state === 'APPROVED' && (
            <button
              type="button"
              onClick={() => nav(`/procurement/fabric/grn/new?po_id=${head.id}`)}
              className="btn-secondary text-xs flex items-center gap-1.5 text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border-emerald-300"
            >
              <PackageCheck size={14} /> Create Fabric GRN
            </button>
          )}

          <button
            type="button"
            disabled={saving}
            onClick={() => handleSave('DRAFT')}
            className="btn-secondary text-xs flex items-center gap-1.5"
          >
            <Save size={14} /> Save Draft
          </button>

          {head.approval_state !== 'APPROVED' && (
            <button
              type="button"
              disabled={saving}
              onClick={() => handleSave('APPROVED')}
              className="btn-primary text-xs flex items-center gap-1.5"
            >
              <CheckCircle size={14} /> Approve PO
            </button>
          )}
        </div>
      </div>

      {/* Main Header Fields */}
      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-xs">
        <h2 className="text-xs font-bold text-slate-700 uppercase tracking-wider mb-3">Order Parameters</h2>
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-4 text-xs">
          <Input
            label="Internal / IR No."
            required
            value={head.internal_ir_no}
            onChange={(e) => setHead({ ...head, internal_ir_no: e.target.value })}
            placeholder="e.g. IR-2026-000125"
          />
          <Input
            label="PO Date"
            type="date"
            required
            value={head.po_date}
            onChange={(e) => setHead({ ...head, po_date: e.target.value })}
          />
          <Select
            label="Supplier"
            required
            placeholder="Select Supplier"
            options={toOptions(suppliers.data)}
            value={head.supplier_id}
            onChange={(e) => setHead({ ...head, supplier_id: e.target.value })}
          />
          <Select
            label="Style No"
            placeholder="Optional Style Link"
            options={toOptions(styles.data)}
            value={head.style_id}
            onChange={(e) => setHead({ ...head, style_id: e.target.value })}
          />
          <Select
            label="Order Type"
            options={[
              { value: 'PRODUCTION', label: 'Production' },
              { value: 'SAMPLE', label: 'Sample' },
              { value: 'STOCK', label: 'Stock' },
              { value: 'JOB_WORK', label: 'Job Work' },
            ]}
            value={head.order_type}
            onChange={(e) => setHead({ ...head, order_type: e.target.value })}
          />
          <Input
            label="Required Delivery Date"
            type="date"
            value={head.delivery_date}
            onChange={(e) => setHead({ ...head, delivery_date: e.target.value })}
          />
          <Input
            label="Payment Terms"
            value={head.payment_terms}
            onChange={(e) => setHead({ ...head, payment_terms: e.target.value })}
            placeholder="e.g. 30 Days Net"
          />
          <Input
            label="Remarks"
            value={head.remarks}
            onChange={(e) => setHead({ ...head, remarks: e.target.value })}
            placeholder="Special instructions..."
          />
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
                onClick={() => setHead((h) => ({ ...h, billing_address: COMPANY_DEFAULT_ADDRESS }))}
                className="text-[11px] text-blue-600 hover:text-blue-700 font-medium flex items-center gap-1"
                title="Reset to Head Office address"
              >
                <RotateCcw size={11} /> Reset Default
              </button>
            </div>
            <p className="text-[11px] text-slate-500 mb-2.5">
              Buyer / Company legal office address billed by the fabric mill
            </p>
          </div>
          <textarea
            rows={4}
            className="input w-full font-mono text-xs leading-relaxed resize-y"
            value={head.billing_address}
            onChange={(e) => setHead({ ...head, billing_address: e.target.value })}
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
                <span>Shipping Address (Delivery Destination Unit / Mill)</span>
              </div>
              <button
                type="button"
                onClick={() => setHead((h) => ({ ...h, shipping_to_party_id: '', shipping_address: head.billing_address }))}
                className="text-[11px] text-slate-600 hover:text-slate-800 font-medium flex items-center gap-1"
                title="Copy from Billing Address"
              >
                Same as Billing
              </button>
            </div>
            <div className="mb-2">
              <Select
                label="Destination Mill / Party (Knitting, Dyeing, Garment Unit)"
                placeholder="Select unit to auto-populate shipping address..."
                options={toOptions(parties.data)}
                value={head.shipping_to_party_id}
                onChange={(e) => handleShipToPartyChange(e.target.value)}
              />
            </div>
          </div>
          <textarea
            rows={3}
            className="input w-full font-mono text-xs leading-relaxed resize-y"
            value={head.shipping_address}
            onChange={(e) => setHead({ ...head, shipping_address: e.target.value })}
            placeholder="Enter destination delivery address (Knitting mill, processing unit, or factory warehouse)..."
          />
        </div>
      </div>

      {/* Multi-Item Fabric Grid */}
      <div className="rounded-xl border border-slate-200 bg-white shadow-xs overflow-hidden">
        <div className="flex items-center justify-between p-3.5 bg-slate-50 border-b border-slate-200">
          <div className="flex items-center gap-2">
            <span className="p-1 rounded bg-sky-100 text-sky-700">
              <Layers size={14} />
            </span>
            <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider">
              Fabric Specifications & Quantity Grid ({lines.length})
            </h3>
          </div>
          <button
            type="button"
            onClick={() => setLines([...lines, emptyFabricLine()])}
            className="btn-secondary btn-xs flex items-center gap-1"
          >
            <Plus size={13} /> Add Fabric Line
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-100/70 border-b border-slate-200 text-[11px] font-semibold text-slate-600 uppercase tracking-wider">
              <tr>
                <th className="py-2.5 px-3 min-w-[160px]">Fabric Name</th>
                <th className="py-2.5 px-2 w-28">Type</th>
                <th className="py-2.5 px-2 w-20">Dia</th>
                <th className="py-2.5 px-2 w-20">GSM</th>
                <th className="py-2.5 px-2 min-w-[120px]">Composition</th>
                <th className="py-2.5 px-2 w-28">Colour / Shade</th>
                <th className="py-2.5 px-2 w-24">Finish</th>
                <th className="py-2.5 px-2 w-20 text-center">UOM</th>
                <th className="py-2.5 px-2 w-24 text-right">Quantity</th>
                <th className="py-2.5 px-2 w-24 text-right">Weight (KG)</th>
                <th className="py-2.5 px-2 w-20 text-right">Rolls</th>
                <th className="py-2.5 px-2 w-24 text-right">Rate (₹)</th>
                <th className="py-2.5 px-2 w-28 text-right">Net Amount (₹)</th>
                <th className="py-2.5 px-2 w-10 text-center"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {lines.map((l, idx) => (
                <tr key={l._key} className="hover:bg-slate-50/50">
                  <td className="py-2 px-3">
                    <select
                      value={l.fabric_id}
                      onChange={(e) => {
                        const fab: any = (fabrics.data || []).find((x: any) => String(x.id) === e.target.value);
                        updateLine(idx, {
                          fabric_id: e.target.value,
                          fabric_name: fab?.fabric_name || '',
                          gsm: String(fab?.gsm || l.gsm),
                          composition: String(fab?.composition || l.composition),
                          fabric_type: String(fab?.fabric_type || l.fabric_type),
                        });
                      }}
                      className="input py-1 text-xs w-full"
                    >
                      <option value="">— Select Fabric —</option>
                      {toOptions(fabrics.data).map((o) => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                  </td>
                  <td className="py-2 px-2">
                    <select
                      value={l.fabric_type}
                      onChange={(e) => updateLine(idx, { fabric_type: e.target.value })}
                      className="input py-1 text-xs w-full"
                    >
                      <option value="Knitted">Knitted</option>
                      <option value="Woven">Woven</option>
                      <option value="Non-Woven">Non-Woven</option>
                    </select>
                  </td>
                  <td className="py-2 px-2">
                    <input
                      type="text"
                      value={l.dia}
                      onChange={(e) => updateLine(idx, { dia: e.target.value })}
                      placeholder='30"'
                      className="input py-1 text-xs w-full"
                    />
                  </td>
                  <td className="py-2 px-2">
                    <input
                      type="number"
                      value={l.gsm}
                      onChange={(e) => updateLine(idx, { gsm: e.target.value })}
                      placeholder="180"
                      className="input py-1 text-xs w-full"
                    />
                  </td>
                  <td className="py-2 px-2">
                    <input
                      type="text"
                      value={l.composition}
                      onChange={(e) => updateLine(idx, { composition: e.target.value })}
                      className="input py-1 text-xs w-full"
                      placeholder="100% Cotton"
                    />
                  </td>
                  <td className="py-2 px-2">
                    <div className="flex gap-1">
                      <input
                        type="text"
                        value={l.color_name}
                        onChange={(e) => updateLine(idx, { color_name: e.target.value })}
                        placeholder="Navy"
                        className="input py-1 text-xs w-1/2"
                      />
                      <input
                        type="text"
                        value={l.shade_code}
                        onChange={(e) => updateLine(idx, { shade_code: e.target.value })}
                        placeholder="NVY-01"
                        className="input py-1 text-xs w-1/2 font-mono text-[11px]"
                      />
                    </div>
                  </td>
                  <td className="py-2 px-2">
                    <input
                      type="text"
                      value={l.finish}
                      onChange={(e) => updateLine(idx, { finish: e.target.value })}
                      placeholder="Compact"
                      className="input py-1 text-xs w-full"
                    />
                  </td>
                  <td className="py-2 px-2 text-center">
                    <select
                      value={l.uom_id}
                      onChange={(e) => updateLine(idx, { uom_id: Number(e.target.value) })}
                      className="input py-1 text-xs w-full text-center"
                    >
                      <option value={9}>MTR</option>
                      <option value={5}>KG</option>
                      <option value={15}>ROLL</option>
                    </select>
                  </td>
                  <td className="py-2 px-2">
                    <input
                      type="number"
                      step="0.01"
                      value={l.qty}
                      onChange={(e) => updateLine(idx, { qty: Number(e.target.value) })}
                      className="input py-1 text-xs w-full text-right font-mono font-bold"
                    />
                  </td>
                  <td className="py-2 px-2">
                    <input
                      type="number"
                      step="0.01"
                      value={l.weight_kg}
                      onChange={(e) => updateLine(idx, { weight_kg: Number(e.target.value) })}
                      className="input py-1 text-xs w-full text-right font-mono"
                    />
                  </td>
                  <td className="py-2 px-2">
                    <input
                      type="number"
                      value={l.no_of_rolls}
                      onChange={(e) => updateLine(idx, { no_of_rolls: Number(e.target.value) })}
                      className="input py-1 text-xs w-full text-right font-mono"
                    />
                  </td>
                  <td className="py-2 px-2">
                    <input
                      type="number"
                      step="0.01"
                      value={l.rate}
                      onChange={(e) => updateLine(idx, { rate: Number(e.target.value) })}
                      className="input py-1 text-xs w-full text-right font-mono font-bold text-brand-700"
                    />
                  </td>
                  <td className="py-2 px-2 text-right font-mono font-bold text-slate-900">
                    ₹{fmtDecimal(l.net_amount, 2)}
                  </td>
                  <td className="py-2 px-2 text-center">
                    <button
                      type="button"
                      disabled={lines.length === 1}
                      onClick={() => setLines(lines.filter((_, i) => i !== idx))}
                      className="text-slate-400 hover:text-rose-600 disabled:opacity-30"
                    >
                      <Trash2 size={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot className="bg-slate-50/80 border-t border-slate-200 font-bold text-slate-800">
              <tr>
                <td colSpan={8} className="py-3 px-3 text-right text-slate-600">Total Purchase Totals:</td>
                <td className="py-3 px-2 text-right font-mono">{fmtDecimal(totals.totalQty, 2)}</td>
                <td className="py-3 px-2 text-right font-mono">{fmtDecimal(totals.totalWeight, 2)} KG</td>
                <td className="py-3 px-2 text-right font-mono">{totals.totalRolls}</td>
                <td className="py-3 px-2 text-right font-mono text-xs text-slate-500">Net Value:</td>
                <td className="py-3 px-2 text-right font-mono text-base font-black text-slate-900">
                  ₹{fmtDecimal(totals.grandTotal, 2)}
                </td>
                <td></td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      {/* Convert from Quotation Modal */}
      <Modal
        open={showQuoteModal}
        onClose={() => setShowQuoteModal(false)}
        title="Convert Approved Fabric Quotation to PO"
        size="lg"
      >
        <div className="space-y-4">
          <p className="text-xs text-slate-600">
            Select an approved fabric quotation to inherit all fabric specifications, consumption, rates, and internal references without manual re-entry.
          </p>

          <div className="rounded-lg border border-slate-200 overflow-hidden">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
                <tr>
                  <th className="py-2.5 px-3">Quotation No</th>
                  <th className="py-2.5 px-3">Date</th>
                  <th className="py-2.5 px-3">Supplier / Buyer</th>
                  <th className="py-2.5 px-3 text-right">Amount (₹)</th>
                  <th className="py-2.5 px-3 text-center">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {fabricQuotes.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-6 text-center text-slate-400">
                      No approved fabric quotations available.
                    </td>
                  </tr>
                ) : (
                  fabricQuotes.map((q: any) => (
                    <tr key={q.id} className="hover:bg-slate-50">
                      <td className="py-2.5 px-3 font-mono font-bold text-brand-700">{q.quotation_no}</td>
                      <td className="py-2.5 px-3">{q.quotation_date?.slice(0, 10)}</td>
                      <td className="py-2.5 px-3">{q.buyer_name || q.supplier_name || '—'}</td>
                      <td className="py-2.5 px-3 text-right font-mono font-bold">₹{fmtDecimal(q.total_amount, 2)}</td>
                      <td className="py-2.5 px-3 text-center">
                        <button
                          type="button"
                          onClick={() => handleConvertQuotation(q.id)}
                          className="btn-primary btn-xs"
                        >
                          Convert to PO
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </Modal>
    </div>
  );
}
