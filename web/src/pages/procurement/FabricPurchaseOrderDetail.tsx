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
  so_id?: string | number;
  style_id?: string | number;
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
  hsn_code: string;
  uom_id: number;
  qty: number;
  weight_kg: number;
  no_of_rolls: number;
  rate: number;
  amount: number;
  discount_amount: number;
  freight_amount: number;
  other_charges: number;
  taxable_amount: number;
  gst_rate: number;
  cgst_rate: number;
  cgst_amount: number;
  sgst_rate: number;
  sgst_amount: number;
  igst_rate: number;
  igst_amount: number;
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
  hsn_code: '5208',
  uom_id: 9, // MTR
  qty: 1000,
  weight_kg: 250,
  no_of_rolls: 10,
  rate: 65.0,
  amount: 65000,
  discount_amount: 0,
  freight_amount: 0,
  other_charges: 0,
  taxable_amount: 65000,
  gst_rate: 5.0,
  cgst_rate: 2.5,
  cgst_amount: 1625,
  sgst_rate: 2.5,
  sgst_amount: 1625,
  igst_rate: 0,
  igst_amount: 0,
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
  const salesOrders = useLookup('sales-orders');
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
    is_interstate: false,
    freight_charges: 0,
    other_charges: 0,
    round_off: 0,
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
        is_interstate: !!d.is_interstate,
        freight_charges: Number(d.freight_charges) || 0,
        other_charges: Number(d.other_charges) || 0,
        round_off: Number(d.round_off) || 0,
      });

      if (Array.isArray(d.lines) && d.lines.length > 0) {
        setLines(
          d.lines.map((l: any) => ({
            id: l.id,
            _key: `fl_${++fseq}`,
            so_id: l.so_id || '',
            style_id: l.style_id || '',
            fabric_id: l.fabric_id || '',
            fabric_name: l.fabric_name,
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
            hsn_code: l.hsn_code || '5208',
            uom_id: l.uom_id || 9,
            qty: Number(l.qty) || 0,
            weight_kg: Number(l.weight_kg) || 0,
            no_of_rolls: Number(l.no_of_rolls) || 0,
            rate: Number(l.rate) || 0,
            amount: Number(l.amount) || 0,
            discount_amount: Number(l.discount_amount) || 0,
            freight_amount: Number(l.freight_amount) || 0,
            other_charges: Number(l.other_charges) || 0,
            taxable_amount: Number(l.taxable_amount) || Number(l.amount) || 0,
            gst_rate: Number(l.gst_rate) || 5.0,
            cgst_rate: Number(l.cgst_rate) || 0,
            cgst_amount: Number(l.cgst_amount) || 0,
            sgst_rate: Number(l.sgst_rate) || 0,
            sgst_amount: Number(l.sgst_amount) || 0,
            igst_rate: Number(l.igst_rate) || 0,
            igst_amount: Number(l.igst_amount) || 0,
            net_amount: Number(l.net_amount) || Number(l.amount) || 0,
          }))
        );
      }
    }
  }, [poQuery.data]);

  // Handle Interstate Toggle and recalculate taxes
  const handleToggleInterstate = (isInter: boolean) => {
    setHead((h) => ({ ...h, is_interstate: isInter }));
    setLines((curr) =>
      curr.map((l) => {
        const taxable = l.taxable_amount || l.amount || 0;
        const gstRate = Number(l.gst_rate) || 5.0;
        let cgst_rate = 0, cgst_amount = 0, sgst_rate = 0, sgst_amount = 0, igst_rate = 0, igst_amount = 0;
        if (isInter) {
          igst_rate = gstRate;
          igst_amount = Math.round((taxable * (gstRate / 100)) * 100) / 100;
        } else {
          cgst_rate = gstRate / 2;
          cgst_amount = Math.round((taxable * (gstRate / 200)) * 100) / 100;
          sgst_rate = gstRate / 2;
          sgst_amount = Math.round((taxable * (gstRate / 200)) * 100) / 100;
        }
        const totalTax = cgst_amount + sgst_amount + igst_amount;
        return {
          ...l,
          cgst_rate,
          cgst_amount,
          sgst_rate,
          sgst_amount,
          igst_rate,
          igst_amount,
          net_amount: Math.round((taxable + totalTax) * 100) / 100,
        };
      })
    );
  };

  // Calculations
  const updateLine = (idx: number, patch: Partial<FabricLine>) => {
    setLines((prev) => {
      const next = [...prev];
      const cur = { ...next[idx], ...patch };
      const qty = Number(cur.qty) || 0;
      const rate = Number(cur.rate) || 0;
      const basicAmt = Math.round(qty * rate * 100) / 100;
      const disc = Number(cur.discount_amount) || 0;
      const freight = Number(cur.freight_amount) || 0;
      const other = Number(cur.other_charges) || 0;
      const taxable = Math.max(0, basicAmt - disc + freight + other);
      cur.amount = basicAmt;
      cur.taxable_amount = taxable;

      const gstRate = Number(cur.gst_rate) || 5.0;
      if (head.is_interstate) {
        cur.igst_rate = gstRate;
        cur.igst_amount = Math.round((taxable * (gstRate / 100)) * 100) / 100;
        cur.cgst_rate = 0;
        cur.cgst_amount = 0;
        cur.sgst_rate = 0;
        cur.sgst_amount = 0;
      } else {
        cur.cgst_rate = gstRate / 2;
        cur.cgst_amount = Math.round((taxable * (gstRate / 200)) * 100) / 100;
        cur.sgst_rate = gstRate / 2;
        cur.sgst_amount = Math.round((taxable * (gstRate / 200)) * 100) / 100;
        cur.igst_rate = 0;
        cur.igst_amount = 0;
      }
      const totalTax = cur.cgst_amount + cur.sgst_amount + cur.igst_amount;
      cur.net_amount = Math.round((taxable + totalTax) * 100) / 100;
      next[idx] = cur;
      return next;
    });
  };

  const totals = useMemo(() => {
    const totalQty = lines.reduce((s, l) => s + (Number(l.qty) || 0), 0);
    const totalWeight = lines.reduce((s, l) => s + (Number(l.weight_kg) || 0), 0);
    const totalRolls = lines.reduce((s, l) => s + (Number(l.no_of_rolls) || 0), 0);
    const basicAmount = lines.reduce((s, l) => s + (Number(l.amount) || 0), 0);
    const taxableAmount = lines.reduce((s, l) => s + (Number(l.taxable_amount) || 0), 0);
    const totalCgst = lines.reduce((s, l) => s + (Number(l.cgst_amount) || 0), 0);
    const totalSgst = lines.reduce((s, l) => s + (Number(l.sgst_amount) || 0), 0);
    const totalIgst = lines.reduce((s, l) => s + (Number(l.igst_amount) || 0), 0);
    const totalTax = totalCgst + totalSgst + totalIgst;
    const itemsNet = lines.reduce((s, l) => s + (Number(l.net_amount) || 0), 0);
    const freight = Number(head.freight_charges) || 0;
    const other = Number(head.other_charges) || 0;
    const roundOff = Number(head.round_off) || 0;
    const grandTotal = Math.round((itemsNet + freight + other + roundOff) * 100) / 100;
    return {
      totalQty,
      totalWeight,
      totalRolls,
      basicAmount,
      taxableAmount,
      totalCgst,
      totalSgst,
      totalIgst,
      totalTax,
      itemsNet,
      freight,
      other,
      roundOff,
      grandTotal,
    };
  }, [lines, head.freight_charges, head.other_charges, head.round_off]);

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
        is_interstate: head.is_interstate ? 1 : 0,
        taxable_amount: totals.taxableAmount,
        cgst_amount: totals.totalCgst,
        sgst_amount: totals.totalSgst,
        igst_amount: totals.totalIgst,
        total_amount: totals.basicAmount,
        tax_amount: totals.totalTax,
        grand_total: totals.grandTotal,
        freight_charges: totals.freight,
        other_charges: totals.other,
        round_off: totals.roundOff,
        approval_state: stateOverride || head.approval_state,
        remarks: head.remarks,
        billing_address: head.billing_address || null,
        shipping_address: head.shipping_address || null,
        shipping_to_party_id: head.shipping_to_party_id ? Number(head.shipping_to_party_id) : null,
        lines: lines.map((l) => ({
          fabric_id: Number(l.fabric_id),
          so_id: l.so_id ? Number(l.so_id) : undefined,
          style_id: l.style_id ? Number(l.style_id) : undefined,
          hsn_code: l.hsn_code || '5208',
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
          taxable_amount: Number(l.taxable_amount),
          gst_rate: Number(l.gst_rate),
          cgst_rate: Number(l.cgst_rate),
          cgst_amount: Number(l.cgst_amount),
          sgst_rate: Number(l.sgst_rate),
          sgst_amount: Number(l.sgst_amount),
          igst_rate: Number(l.igst_rate),
          igst_amount: Number(l.igst_amount),
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
        <div className="flex items-center justify-between mb-3 pb-2 border-b border-slate-100">
          <h2 className="text-xs font-bold text-slate-700 uppercase tracking-wider">Order Parameters</h2>
          <label className="flex items-center gap-2 cursor-pointer font-normal text-xs text-slate-700 bg-sky-50 px-2.5 py-1 rounded-md border border-sky-200">
            <input
              type="checkbox"
              checked={head.is_interstate}
              onChange={(e) => handleToggleInterstate(e.target.checked)}
              className="h-3.5 w-3.5 rounded text-sky-600 focus:ring-sky-500"
            />
            <span className="font-semibold text-slate-800">Inter-state PO (IGST Calculation)</span>
          </label>
        </div>
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
            placeholder="Company billing address with GSTIN..."
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
                <span>Shipping Address (Delivery Location)</span>
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
                label="Destination Unit / Warehouse"
                placeholder="Select unit to auto-fill address..."
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
            placeholder="Delivery address (Dyeing mill, garment unit, or warehouse)..."
          />
        </div>
      </div>

      {/* Fabric Lines Table */}
      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-xs space-y-3">
        <div className="flex items-center justify-between pb-2 border-b border-slate-100">
          <div>
            <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider flex items-center gap-1.5">
              <Layers size={14} className="text-emerald-600" />
              <span>Fabric Line Items ({lines.length})</span>
            </h3>
            <p className="text-[11px] text-slate-400">
              Multiple jobs supported: assign each line item to a Sales Order or Stock, with live tax and amount details
            </p>
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
                <th className="py-2.5 px-3 min-w-[150px]">Fabric Name</th>
                <th className="py-2.5 px-2 min-w-[140px]">I/O (Internal Order) / Job</th>
                <th className="py-2.5 px-2 w-24">Type</th>
                <th className="py-2.5 px-2 w-16">Dia</th>
                <th className="py-2.5 px-2 w-16">GSM</th>
                <th className="py-2.5 px-2 w-20">HSN</th>
                <th className="py-2.5 px-2 w-24">Shade</th>
                <th className="py-2.5 px-2 w-20 text-right">Qty</th>
                <th className="py-2.5 px-2 w-20 text-right">Rate (₹)</th>
                <th className="py-2.5 px-2 w-24 text-right">Taxable (₹)</th>
                {head.is_interstate ? (
                  <>
                    <th className="py-2.5 px-2 w-16 text-center">IGST %</th>
                    <th className="py-2.5 px-2 w-20 text-right">IGST (₹)</th>
                  </>
                ) : (
                  <>
                    <th className="py-2.5 px-2 w-16 text-center">GST %</th>
                    <th className="py-2.5 px-2 w-20 text-right">CGST+SGST (₹)</th>
                  </>
                )}
                <th className="py-2.5 px-2 w-24 text-right">Net (₹)</th>
                <th className="py-2.5 px-2 w-8 text-center"></th>
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
                      className="input py-1 text-xs w-full bg-white"
                    >
                      <option value="">— Select Fabric —</option>
                      {toOptions(fabrics.data).map((o) => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                  </td>
                  <td className="py-2 px-2">
                    <select
                      value={l.so_id || ''}
                      onChange={(e) => updateLine(idx, { so_id: e.target.value })}
                      className="input py-1 text-xs w-full bg-white"
                    >
                      <option value="">Stock / General</option>
                      {toOptions(salesOrders.data).map((so) => (
                        <option key={so.value} value={so.value}>{so.label}</option>
                      ))}
                    </select>
                  </td>
                  <td className="py-2 px-2">
                    <select
                      value={l.fabric_type}
                      onChange={(e) => updateLine(idx, { fabric_type: e.target.value })}
                      className="input py-1 text-xs w-full bg-white"
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
                      value={l.hsn_code}
                      onChange={(e) => updateLine(idx, { hsn_code: e.target.value })}
                      placeholder="5208"
                      className="input py-1 text-xs w-full font-mono"
                    />
                  </td>
                  <td className="py-2 px-2">
                    <input
                      type="text"
                      value={l.shade_code}
                      onChange={(e) => updateLine(idx, { shade_code: e.target.value })}
                      placeholder="NVY-01"
                      className="input py-1 text-xs w-full font-mono text-[11px]"
                    />
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
                      value={l.rate}
                      onChange={(e) => updateLine(idx, { rate: Number(e.target.value) })}
                      className="input py-1 text-xs w-full text-right font-mono font-bold text-brand-700"
                    />
                  </td>
                  <td className="py-2 px-2 text-right font-mono font-medium text-slate-800">
                    ₹{fmtDecimal(l.taxable_amount || l.amount)}
                  </td>
                  {head.is_interstate ? (
                    <>
                      <td className="py-2 px-2 text-center">
                        <input
                          type="number"
                          step="0.1"
                          value={l.gst_rate}
                          onChange={(e) => updateLine(idx, { gst_rate: Number(e.target.value) })}
                          className="input py-1 text-xs w-full text-center bg-purple-50/50 text-purple-700 font-semibold"
                        />
                      </td>
                      <td className="py-2 px-2 text-right font-mono font-semibold text-purple-700">
                        ₹{fmtDecimal(l.igst_amount)}
                      </td>
                    </>
                  ) : (
                    <>
                      <td className="py-2 px-2 text-center">
                        <input
                          type="number"
                          step="0.1"
                          value={l.gst_rate}
                          onChange={(e) => updateLine(idx, { gst_rate: Number(e.target.value) })}
                          className="input py-1 text-xs w-full text-center"
                        />
                      </td>
                      <td className="py-2 px-2 text-right font-mono font-medium text-slate-700">
                        ₹{fmtDecimal((l.cgst_amount || 0) + (l.sgst_amount || 0))}
                      </td>
                    </>
                  )}
                  <td className="py-2 px-2 text-right font-mono font-bold text-slate-900">
                    ₹{fmtDecimal(l.net_amount)}
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
                <td colSpan={7} className="py-3 px-3 text-right text-slate-600">Total Purchase Totals:</td>
                <td className="py-3 px-2 text-right font-mono">{fmtDecimal(totals.totalQty, 2)}</td>
                <td className="py-3 px-2 text-right font-mono text-xs text-slate-500">Taxable:</td>
                <td className="py-3 px-2 text-right font-mono">₹{fmtDecimal(totals.taxableAmount, 2)}</td>
                <td className="py-3 px-2 text-center text-xs text-slate-500">
                  {head.is_interstate ? 'IGST' : 'CGST+SGST'}:
                </td>
                <td className="py-3 px-2 text-right font-mono text-purple-700">
                  ₹{fmtDecimal(head.is_interstate ? totals.totalIgst : (totals.totalCgst + totals.totalSgst), 2)}
                </td>
                <td className="py-3 px-2 text-right font-mono text-base font-black text-slate-900">
                  ₹{fmtDecimal(totals.grandTotal, 2)}
                </td>
                <td></td>
              </tr>
            </tfoot>
          </table>
        </div>

        {/* Footer Financial Adjustments */}
        <div className="mt-4 border-t border-slate-200 bg-slate-50/70 p-4 rounded-xl">
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-4 items-end">
            <div>
              <label className="label text-[11px] font-bold text-slate-700">Freight / Transport Charges (₹)</label>
              <input
                type="number"
                step="10"
                value={head.freight_charges}
                onChange={(e) => setHead((h) => ({ ...h, freight_charges: parseFloat(e.target.value) || 0 }))}
                className="input py-1.5 text-xs text-right font-mono"
                placeholder="0.00"
              />
            </div>

            <div>
              <label className="label text-[11px] font-bold text-slate-700">Other / Unloading Charges (₹)</label>
              <input
                type="number"
                step="10"
                value={head.other_charges}
                onChange={(e) => setHead((h) => ({ ...h, other_charges: parseFloat(e.target.value) || 0 }))}
                className="input py-1.5 text-xs text-right font-mono"
                placeholder="0.00"
              />
            </div>

            <div>
              <label className="label text-[11px] font-bold text-slate-700">Round Off (₹)</label>
              <input
                type="number"
                step="0.01"
                value={head.round_off}
                onChange={(e) => setHead((h) => ({ ...h, round_off: parseFloat(e.target.value) || 0 }))}
                className="input py-1.5 text-xs text-right font-mono"
                placeholder="0.00"
              />
            </div>

            <div className="flex flex-col items-end justify-center bg-white p-3 rounded-lg border border-slate-200 shadow-sm">
              <span className="text-[11px] text-slate-500 font-bold uppercase tracking-wider block">Net Payable Amount</span>
              <span className="text-xl font-black text-brand-900 font-mono">₹{fmtDecimal(totals.grandTotal)}</span>
            </div>
          </div>
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
