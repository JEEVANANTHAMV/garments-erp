import { useState, useEffect, useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft, Save, Plus, Trash2, Disc,
  PackageCheck, FileSpreadsheet, Building2, Truck, RotateCcw,
  Globe, Sparkles
} from 'lucide-react';
import { http, ApiError } from '../../lib/api';
import { useLookup, toOptions } from '../../hooks/useLookup';
import { useToast } from '../../hooks/useToast';
import { Input, Select, StatusBadge, Modal } from '../../components/ui';
import { fmtDecimal, today } from '../../lib/format';

interface YarnLine {
  id?: number;
  _key: string;
  so_id?: string | number;
  style_id?: string | number;
  yarn_id: string | number;
  yarn_name?: string;
  yarn_type: 'Grey Yarn' | 'Dyed Yarn';
  purchase_basis: 'DIRECT_KG' | 'PACK_BAG';
  yarn_count_str: string;
  yarn_category: string;
  composition: string;
  shade_code: string;
  color_name?: string;
  dyeing_mill_id: string;
  hsn_code: string;
  packs: number;
  pack_weight_kg: number;
  qty: number; // Total KG
  uom_id: number;
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
  hsn_code: '5205',
  packs: 50,
  pack_weight_kg: 45.36,
  qty: 2268,
  uom_id: 5, // KG
  rate: 220.0,
  amount: 498960,
  discount_amount: 0,
  freight_amount: 0,
  other_charges: 0,
  taxable_amount: 498960,
  gst_rate: 5.0,
  cgst_rate: 2.5,
  cgst_amount: 12474,
  sgst_rate: 2.5,
  sgst_amount: 12474,
  igst_rate: 0,
  igst_amount: 0,
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
  const salesOrders = useLookup('sales-orders');
  const parties = useLookup('parties');
  const currencies = useLookup('currencies');

  const COMPANY_DEFAULT_ADDRESS = "CK Exports\n123 Textile Park, Dharapuram Road\nTirupur - 641604, Tamil Nadu\nGSTIN: 33AAAAA0000A1Z5";

  const [saving, setSaving] = useState(false);
  const [quoteModalOpen, setQuoteModalOpen] = useState(false);
  const [selectedQuoteId, setSelectedQuoteId] = useState<string>('');
  const [filterBomOnly, setFilterBomOnly] = useState(false);

  // PO Header State
  const [header, setHeader] = useState({
    po_no: '',
    po_date: today(),
    delivery_date: '',
    internal_ir_no: 'IR-2026-0001',
    supplier_id: '',
    style_id: '',
    currency_id: '1',
    exchange_rate: 1.0,
    payment_terms: '30 Days Credit',
    remarks: '',
    approval_state: 'APPROVED',
    billing_address: COMPANY_DEFAULT_ADDRESS,
    shipping_address: '',
    shipping_to_party_id: '',
    is_interstate: false,
    freight_charges: 0,
    other_charges: 0,
    tcs_applicable: false,
    tcs_section: '206C(1H)',
    tcs_rate: 0.1,
    round_off: 0,
  });

  const [lines, setLines] = useState<YarnLine[]>([emptyYarnLine()]);

  // Selected Currency Info
  const selectedCurrency = (currencies.data as any[])?.find((c: any) => String(c.id) === String(header.currency_id));
  const currSymbol = selectedCurrency?.symbol || '₹';
  const currCode = selectedCurrency?.code || 'INR';
  const isForeignCurrency = currCode !== 'INR' && Number(header.exchange_rate) > 0 && Number(header.exchange_rate) !== 1.0;

  // BOM Integration Query when Style is selected (Clip 4)
  const { data: bomData } = useQuery({
    queryKey: ['bom-for-job-yarn', header.style_id],
    queryFn: async () => {
      if (!header.style_id) return null;
      const res = await http.get<{ data: any }>(`/api/boms/for-job?style_id=${header.style_id}`);
      return res.data;
    },
    enabled: Boolean(header.style_id),
  });

  const bomYarns = bomData?.yarns || [];

  const handleLoadFromBOM = () => {
    if (!bomYarns.length) {
      toast('No yarn items found in active BOM for this style', 'warning');
      return;
    }
    const newLines: YarnLine[] = bomYarns.map((by: any) => {
      const reqKg = Number(by.total_required_qty || by.consumption_per_pc || 100);
      const rate = Number(by.rate || 220);
      const taxable = Math.round(reqKg * rate * 100) / 100;
      const gstRate = 5.0;
      const tax = Math.round((taxable * (gstRate / 100)) * 100) / 100;
      return {
        _key: `yl_${++yseq}`,
        so_id: '',
        style_id: header.style_id,
        yarn_id: by.yarn_id ? String(by.yarn_id) : '',
        yarn_name: by.yarn_name || by.item_name || '',
        yarn_type: (by.yarn_type || 'Grey Yarn') as any,
        purchase_basis: 'DIRECT_KG',
        yarn_count_str: by.yarn_count_str || '30s',
        yarn_category: by.yarn_category || 'Combed',
        composition: by.composition || '100% Cotton',
        shade_code: by.shade_code || '',
        dyeing_mill_id: '',
        hsn_code: '5205',
        packs: 0,
        pack_weight_kg: 0,
        qty: reqKg,
        uom_id: 5,
        rate,
        amount: taxable,
        discount_amount: 0,
        freight_amount: 0,
        other_charges: 0,
        taxable_amount: taxable,
        gst_rate: gstRate,
        cgst_rate: header.is_interstate ? 0 : 2.5,
        cgst_amount: header.is_interstate ? 0 : tax / 2,
        sgst_rate: header.is_interstate ? 0 : 2.5,
        sgst_amount: header.is_interstate ? 0 : tax / 2,
        igst_rate: header.is_interstate ? gstRate : 0,
        igst_amount: header.is_interstate ? tax : 0,
        net_amount: taxable + tax,
      };
    });
    setLines(newLines);
    toast(`Loaded ${newLines.length} yarn items from BOM!`, 'success');
  };

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
        currency_id: String(existingPo.currency_id || '1'),
        exchange_rate: Number(existingPo.exchange_rate || 1.0),
        payment_terms: existingPo.payment_terms || '',
        remarks: existingPo.remarks || '',
        approval_state: existingPo.approval_state || 'APPROVED',
        billing_address: existingPo.billing_address || COMPANY_DEFAULT_ADDRESS,
        shipping_address: existingPo.shipping_address || '',
        shipping_to_party_id: existingPo.shipping_to_party_id ? String(existingPo.shipping_to_party_id) : '',
        is_interstate: !!existingPo.is_interstate,
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
          so_id: l.so_id || '',
          style_id: l.style_id || '',
          yarn_id: l.yarn_id || '',
          yarn_name: l.yarn_name,
          yarn_type: (l.yarn_type as any) || 'Grey Yarn',
          purchase_basis: (l.purchase_basis as any) || 'DIRECT_KG',
          yarn_count_str: l.yarn_count_str || '30s',
          yarn_category: l.yarn_category || 'Combed',
          composition: l.composition || '100% Cotton',
          shade_code: l.shade_code || '',
          dyeing_mill_id: l.dyeing_mill_id ? String(l.dyeing_mill_id) : '',
          hsn_code: l.hsn_code || '5205',
          packs: Number(l.packs) || 0,
          pack_weight_kg: Number(l.pack_weight_kg) || 0,
          qty: Number(l.qty) || 0,
          uom_id: l.uom_id || 5,
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
        }));
        setLines(mappedLines);
      }
    }
  }, [existingPo, isNew]);

  // Handle Interstate Toggle and recalculate tax distribution across lines
  const handleToggleInterstate = (isInter: boolean) => {
    setHeader((h) => ({ ...h, is_interstate: isInter }));
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
      const taxable = Math.max(0, cur.amount - (Number(cur.discount_amount) || 0) + (Number(cur.freight_amount) || 0) + (Number(cur.other_charges) || 0));
      cur.taxable_amount = taxable;

      const gstRate = Number(cur.gst_rate) || 5.0;
      if (header.is_interstate) {
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
    let taxableAmount = 0;
    let totalCgst = 0;
    let totalSgst = 0;
    let totalIgst = 0;
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
      taxableAmount += Number(l.taxable_amount) || 0;
      totalCgst += Number(l.cgst_amount) || 0;
      totalSgst += Number(l.sgst_amount) || 0;
      totalIgst += Number(l.igst_amount) || 0;
      net += Number(l.net_amount) || 0;
    }

    const freight = Number(header.freight_charges) || 0;
    const other = Number(header.other_charges) || 0;
    const baseBeforeTcs = net + freight + other;
    const tcsAmt = header.tcs_applicable ? Math.round(((baseBeforeTcs * (Number(header.tcs_rate) || 0)) / 100) * 100) / 100 : 0;
    const roundOff = Number(header.round_off) || 0;
    const grandTotal = Math.round((baseBeforeTcs + tcsAmt + roundOff) * 100) / 100;

    return {
      totalKg,
      greyKg,
      dyedKg,
      totalPacks,
      gross,
      taxableAmount,
      totalCgst,
      totalSgst,
      totalIgst,
      net,
      freight,
      other,
      tcsAmt,
      roundOff,
      grandTotal,
    };
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
        currency_id: Number(header.currency_id || 1),
        exchange_rate: Number(header.exchange_rate || 1.0),
        is_interstate: header.is_interstate ? 1 : 0,
        taxable_amount: totals.taxableAmount,
        cgst_amount: totals.totalCgst,
        sgst_amount: totals.totalSgst,
        igst_amount: totals.totalIgst,
        total_amount: totals.gross,
        tax_amount: totals.totalCgst + totals.totalSgst + totals.totalIgst,
        grand_total: totals.grandTotal,
        freight_charges: totals.freight,
        other_charges: totals.other,
        round_off: totals.roundOff,
        lines: lines.map((l) => ({
          material_type: 'YARN',
          yarn_id: Number(l.yarn_id) || null,
          so_id: l.so_id ? Number(l.so_id) : null,
          style_id: l.style_id ? Number(l.style_id) : null,
          hsn_code: l.hsn_code || '5205',
          description: l.yarn_name || `${l.yarn_type} ${l.yarn_count_str}`,
          yarn_type: l.yarn_type,
          purchase_basis: l.purchase_basis,
          yarn_count_str: l.yarn_count_str,
          yarn_category: l.yarn_category,
          composition: l.composition,
          shade_code: l.yarn_type === 'Dyed Yarn' ? (l.shade_code || l.color_name || null) : null,
          color_name: l.yarn_type === 'Dyed Yarn' ? (l.color_name || l.shade_code || null) : null,
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
          taxable_amount: l.taxable_amount,
          gst_rate: l.gst_rate,
          cgst_rate: l.cgst_rate,
          cgst_amount: l.cgst_amount,
          sgst_rate: l.sgst_rate,
          sgst_amount: l.sgst_amount,
          igst_rate: l.igst_rate,
          igst_amount: l.igst_amount,
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
              {isForeignCurrency && (
                <span className="px-2 py-0.5 text-[11px] font-bold rounded-full bg-amber-100 text-amber-800 border border-amber-300 flex items-center gap-1">
                  <Globe size={11} /> IMPORT PO ({currCode})
                </span>
              )}
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
        <div className="text-xs font-semibold text-slate-900 uppercase tracking-wider flex items-center justify-between pb-2 border-b border-slate-100">
          <div className="flex items-center gap-1.5">
            <Disc size={14} className="text-amber-600" />
            <span>Purchase Order Details</span>
          </div>
          <label className="flex items-center gap-2 cursor-pointer font-normal text-xs text-slate-700 bg-amber-50/60 px-2.5 py-1 rounded-md border border-amber-200">
            <input
              type="checkbox"
              checked={header.is_interstate}
              onChange={(e) => handleToggleInterstate(e.target.checked)}
              className="h-3.5 w-3.5 rounded text-amber-600 focus:ring-amber-500"
            />
            <span className="font-semibold text-slate-800">Inter-state PO (IGST Calculation)</span>
          </label>
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
            label="Currency *"
            options={toOptions(currencies.data)}
            value={header.currency_id}
            onChange={(e) => {
              const cid = e.target.value;
              const cur = (currencies.data as any[])?.find((c: any) => String(c.id) === cid);
              setHeader((h) => ({
                ...h,
                currency_id: cid,
                exchange_rate: cur?.code === 'INR' ? 1.0 : (h.exchange_rate && h.exchange_rate !== 1.0 ? h.exchange_rate : (cur?.code === 'USD' ? 84.50 : cur?.code === 'EUR' ? 91.20 : 1.0)),
              }));
            }}
          />

          <Input
            label="Exchange Rate (to INR)"
            type="number"
            step="0.0001"
            value={header.exchange_rate}
            disabled={!isForeignCurrency}
            onChange={(e) => setHeader((p) => ({ ...p, exchange_rate: Number(e.target.value) }))}
            placeholder="1.0000"
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

      {/* BOM Linkage & Auto-Fill Banner (Clip 4) */}
      {header.style_id && (
        <div className="rounded-xl border border-amber-200 bg-gradient-to-r from-amber-50/80 via-white to-amber-50/50 p-4 shadow-xs">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-start gap-3">
              <span className="p-2 rounded-lg bg-amber-100 text-amber-700 mt-0.5">
                <Sparkles size={16} />
              </span>
              <div>
                <div className="flex items-center gap-2">
                  <h4 className="text-xs font-bold text-amber-950 uppercase tracking-wide">
                    Bill of Materials (BOM) Yarn Integration
                  </h4>
                  {bomData?.bom && (
                    <span className="bg-amber-100 text-amber-800 text-[10.5px] font-bold px-2 py-0.5 rounded border border-amber-300">
                      BOM: {bomData.bom.bom_no} · v{bomData.bom.version}
                    </span>
                  )}
                </div>
                <p className="text-[11px] text-slate-600 mt-0.5">
                  {bomYarns.length > 0
                    ? `Found ${bomYarns.length} planned yarn specification(s) in BOM for this Style/Job.`
                    : 'No yarn items explicitly defined in BOM for this style.'}
                </p>
              </div>
            </div>
            {bomYarns.length > 0 && (
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-1.5 text-xs text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={filterBomOnly}
                    onChange={(e) => setFilterBomOnly(e.target.checked)}
                    className="rounded border-slate-300 text-amber-600 focus:ring-amber-500"
                  />
                  <span>Show BOM Items Only</span>
                </label>
                <button
                  type="button"
                  onClick={handleLoadFromBOM}
                  className="btn-primary text-xs py-1.5 px-3 flex items-center gap-1 bg-amber-600 hover:bg-amber-700 border-amber-600 shadow-xs text-white"
                >
                  <Sparkles size={13} /> Load Yarn from BOM
                </button>
              </div>
            )}
          </div>
        </div>
      )}

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
              <tr className="bg-slate-50 text-slate-600 font-semibold border-b border-slate-200 text-[11px] uppercase tracking-wider">
                <th className="py-2.5 px-2 w-8 text-center">#</th>
                <th className="py-2.5 px-2 min-w-[130px]">I/O Num</th>
                <th className="py-2.5 px-2 min-w-[110px]">Style</th>
                <th className="py-2.5 px-2 min-w-[150px]">Yarn</th>
                <th className="py-2.5 px-2 w-24">Grey / Dyed</th>
                <th className="py-2.5 px-2 w-24">Color / Shade</th>
                <th className="py-2.5 px-2 w-16">Count</th>
                <th className="py-2.5 px-2 w-28">Composition</th>
                <th className="py-2.5 px-2 w-16">HSN</th>
                <th className="py-2.5 px-2 w-20">Basis</th>
                <th className="py-2.5 px-2 text-center">Packs × Wt</th>
                <th className="py-2.5 px-2 text-right">Total KG</th>
                <th className="py-2.5 px-2 text-right">Rate/KG (₹)</th>
                <th className="py-2.5 px-2 text-right">Taxable (₹)</th>
                {header.is_interstate ? (
                  <>
                    <th className="py-2.5 px-2 text-center">IGST %</th>
                    <th className="py-2.5 px-2 text-right">IGST (₹)</th>
                  </>
                ) : (
                  <>
                    <th className="py-2.5 px-2 text-center">GST %</th>
                    <th className="py-2.5 px-2 text-right">CGST+SGST (₹)</th>
                  </>
                )}
                <th className="py-2.5 px-2 text-right">Net (₹)</th>
                <th className="py-2.5 px-2 w-8 text-center"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-slate-700">
              {lines.map((l, idx) => {
                const isDyed = l.yarn_type === 'Dyed Yarn';
                const isPack = l.purchase_basis === 'PACK_BAG';

                return (
                  <tr key={l._key || idx} className="hover:bg-slate-50/70 transition">
                    {/* # S NO */}
                    <td className="py-2.5 px-2 text-center text-slate-400 font-mono text-[11px]">{idx + 1}</td>

                    {/* I/O Num (Sales Order / Job) */}
                    <td className="py-2.5 px-2 min-w-[130px]">
                      <select
                        value={l.so_id || ''}
                        onChange={(e) => updateLine(idx, { so_id: e.target.value })}
                        className="w-full text-xs rounded border border-slate-300 py-1 px-1 bg-white"
                      >
                        <option value="">Stock / General</option>
                        {toOptions(salesOrders.data).map((so) => (
                          <option key={so.value} value={so.value}>
                            {so.label}
                          </option>
                        ))}
                      </select>
                    </td>

                    {/* Style */}
                    <td className="py-2.5 px-2">
                      <select
                        value={l.style_id || ''}
                        onChange={(e) => updateLine(idx, { style_id: e.target.value })}
                        className="w-full text-xs rounded border border-slate-300 py-1 px-1 bg-white"
                      >
                        <option value="">—</option>
                        {toOptions(styles.data).map((st) => (
                          <option key={st.value} value={st.value}>
                            {st.label}
                          </option>
                        ))}
                      </select>
                    </td>

                    {/* Yarn Master Selection */}
                    <td className="py-2.5 px-2 min-w-[140px]">
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
                        className="w-full text-xs rounded border border-slate-300 py-1 px-1.5 focus:border-amber-500 bg-white"
                      >
                        <option value="">Select Yarn</option>
                        {((filterBomOnly && bomYarns.length > 0)
                          ? (yarns.data || []).filter((y: any) => bomYarns.some((by: any) => Number(by.yarn_id) === Number(y.id)))
                          : (yarns.data || [])
                        ).map((o: any) => (
                          <option key={o.id} value={o.id}>
                            {o.yarn_name || o.yarn_code || o.label}
                          </option>
                        ))}
                      </select>
                    </td>

                    {/* Grey / Dyed Yarn Type */}
                    <td className="py-2.5 px-2">
                      <select
                        value={l.yarn_type}
                        onChange={(e) =>
                          updateLine(idx, { yarn_type: e.target.value as 'Grey Yarn' | 'Dyed Yarn' })
                        }
                        className={`text-xs rounded border py-1 px-1.5 font-semibold w-full ${
                          isDyed
                            ? 'bg-purple-50 text-purple-700 border-purple-300'
                            : 'bg-amber-50 text-amber-800 border-amber-300'
                        }`}
                      >
                        <option value="Grey Yarn">Grey Yarn</option>
                        <option value="Dyed Yarn">Dyed Yarn</option>
                      </select>
                    </td>

                    {/* Color / Shade */}
                    <td className="py-2.5 px-2">
                      {isDyed ? (
                        <input
                          type="text"
                          value={l.shade_code || l.color_name || ''}
                          onChange={(e) =>
                            updateLine(idx, {
                              shade_code: e.target.value,
                              color_name: e.target.value,
                            })
                          }
                          className="w-24 text-xs border border-purple-300 bg-purple-50/40 rounded px-1.5 py-1"
                          placeholder="Shade / Color"
                        />
                      ) : (
                        <span className="text-slate-400 text-[11px] block text-center">—</span>
                      )}
                    </td>

                    {/* Count */}
                    <td className="py-2.5 px-2">
                      <input
                        type="text"
                        value={l.yarn_count_str}
                        onChange={(e) => updateLine(idx, { yarn_count_str: e.target.value })}
                        className="w-14 text-xs font-mono font-medium border border-slate-300 rounded px-1.5 py-1"
                        placeholder="30s"
                      />
                    </td>

                    {/* Composition */}
                    <td className="py-2.5 px-2">
                      <input
                        type="text"
                        value={l.composition}
                        onChange={(e) => updateLine(idx, { composition: e.target.value })}
                        className="w-full text-xs border border-slate-300 rounded px-1.5 py-1"
                        placeholder="100% Cotton"
                      />
                    </td>

                    {/* HSN Code */}
                    <td className="py-2.5 px-2">
                      <input
                        type="text"
                        value={l.hsn_code}
                        onChange={(e) => updateLine(idx, { hsn_code: e.target.value })}
                        className="w-14 text-xs font-mono border border-slate-300 rounded px-1 py-1"
                        placeholder="5205"
                      />
                    </td>

                    {/* Purchase Basis: DIRECT_KG vs PACK_BAG */}
                    <td className="py-2.5 px-2">
                      <select
                        value={l.purchase_basis}
                        onChange={(e) =>
                          updateLine(idx, { purchase_basis: e.target.value as any })
                        }
                        className="text-xs rounded border border-slate-300 py-1 px-1 font-medium text-slate-700 bg-white"
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
                        className="w-16 text-xs text-right font-medium border border-slate-300 rounded px-1.5 py-1"
                      />
                    </td>

                    {/* Taxable Amount */}
                    <td className="py-2.5 px-2 text-right font-medium text-slate-800">
                      ₹{fmtDecimal(l.taxable_amount || l.amount)}
                    </td>

                    {/* GST / IGST Fields */}
                    {header.is_interstate ? (
                      <>
                        <td className="py-2.5 px-2 text-center">
                          <select
                            value={l.gst_rate}
                            onChange={(e) =>
                              updateLine(idx, { gst_rate: parseFloat(e.target.value) || 0 })
                            }
                            className="text-xs rounded border border-purple-300 py-1 px-1 text-center bg-purple-50/40 font-semibold text-purple-800"
                          >
                            <option value="5">5%</option>
                            <option value="12">12%</option>
                            <option value="18">18%</option>
                            <option value="0">0%</option>
                          </select>
                        </td>
                        <td className="py-2.5 px-2 text-right font-semibold text-purple-700">
                          ₹{fmtDecimal(l.igst_amount)}
                        </td>
                      </>
                    ) : (
                      <>
                        <td className="py-2.5 px-2 text-center">
                          <select
                            value={l.gst_rate}
                            onChange={(e) =>
                              updateLine(idx, { gst_rate: parseFloat(e.target.value) || 0 })
                            }
                            className="text-xs rounded border border-slate-300 py-1 px-1 text-center bg-white"
                          >
                            <option value="5">5%</option>
                            <option value="12">12%</option>
                            <option value="18">18%</option>
                            <option value="0">0%</option>
                          </select>
                        </td>
                        <td className="py-2.5 px-2 text-right font-medium text-slate-700">
                          ₹{fmtDecimal((l.cgst_amount || 0) + (l.sgst_amount || 0))}
                        </td>
                      </>
                    )}

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
          <div className="grid grid-cols-2 sm:grid-cols-6 gap-4 text-xs pb-3 border-b border-slate-200">
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
              <span className="text-slate-500 block">Total Bags</span>
              <span className="font-bold text-slate-800 text-sm">{totals.totalPacks} Bags</span>
            </div>
            <div>
              <span className="text-slate-500 block">Taxable Amount</span>
              <span className="font-bold text-slate-800 text-sm">₹{fmtDecimal(totals.taxableAmount)}</span>
            </div>
            <div>
              <span className="text-slate-500 block">
                {header.is_interstate ? 'IGST (Inter-state)' : 'CGST + SGST'}
              </span>
              <span className="font-bold text-purple-700 text-sm">
                {header.is_interstate
                  ? `₹${fmtDecimal(totals.totalIgst)}`
                  : `₹${fmtDecimal(totals.totalCgst + totals.totalSgst)}`}
              </span>
            </div>
            <div className="text-right sm:text-left">
              <span className="text-slate-500 block">Net PO Value</span>
              <span className="font-bold text-emerald-700 text-sm">₹{fmtDecimal(totals.grandTotal)}</span>
            </div>
          </div>

          {/* Footer Financial Adjustments & TCS */}
          <div className="grid grid-cols-1 sm:grid-cols-5 gap-4 items-end">
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

            <div>
              <label className="label text-[11px] font-bold text-slate-700">Round Off (₹)</label>
              <input
                type="number"
                step="0.01"
                value={header.round_off}
                onChange={(e) => setHeader((h) => ({ ...h, round_off: parseFloat(e.target.value) || 0 }))}
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
              <span className="text-[11px] text-slate-500 font-bold uppercase tracking-wider block">Net Payable Amount ({currCode})</span>
              <span className="text-xl font-black text-brand-900 font-mono">{currSymbol}{fmtDecimal(totals.grandTotal)}</span>
              {isForeignCurrency && (
                <span className="text-xs font-bold text-amber-900 mt-0.5">
                  INR Converted: ₹{fmtDecimal(totals.grandTotal * Number(header.exchange_rate), 2)}
                </span>
              )}
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
