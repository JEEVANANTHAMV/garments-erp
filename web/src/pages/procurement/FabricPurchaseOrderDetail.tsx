import { useState, useEffect, useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft, Save, CheckCircle, Plus, Trash2, Layers,
  FileSpreadsheet, PackageCheck, Building2, Truck, RotateCcw,
  Globe, Sparkles
} from 'lucide-react';
import { http, ApiError } from '../../lib/api';
import { useQuotedRates, matchQuote } from '../../lib/quotedRates';
import { useJobBoms, bomItemLabel, type JobBomItem } from '../../lib/jobBom';
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
  /** BOM line picked on this row (UI only — selects the BOM option). */
  _bom?: number;
  fabric_name?: string;
  fabric_category: 'Grey Fabric' | 'Dyed Fabric';
  fabric_type: string;
  dia: string;
  gsm: string;
  composition: string;
  color_name: string;
  yarn_count_str: string;
  shade_code: string;
  pantone_spec: string;
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
  fabric_category: 'Grey Fabric',
  fabric_type: 'Knitted',
  dia: '',
  gsm: '',
  composition: '',
  color_name: '',
  yarn_count_str: '',
  shade_code: '',
  pantone_spec: '',
  print_flag: false,
  print_color: '',
  finish: '',
  mill_id: '',
  hsn_code: '5208',
  uom_id: 5, // KG
  qty: 0,
  weight_kg: 0,
  no_of_rolls: 0,
  rate: 0,
  amount: 0,
  discount_amount: 0,
  freight_amount: 0,
  other_charges: 0,
  taxable_amount: 0,
  gst_rate: 5.0,
  cgst_rate: 2.5,
  cgst_amount: 0,
  sgst_rate: 2.5,
  sgst_amount: 0,
  igst_rate: 0,
  igst_amount: 0,
  net_amount: 0,
});

/** A job (sales order) from GET /procurement/jobs — the "IO No" selector. */
interface JobOption {
  id: number;
  so_no: string;
  io_no: string | null;
  job_no: string;
  buyer_name?: string | null;
  label: string;
  plan_cut_qty: number;
  styles: { style_id: number; style_code: string; style_name: string; plan_cut_qty: number }[];
}

/** Amount / taxable / GST split of a fabric line (IGST when inter-state, else CGST + SGST). */
function withFabricTotals(cur: FabricLine, isInterstate: boolean): FabricLine {
  const l = { ...cur };
  l.amount = Math.round((Number(l.qty) || 0) * (Number(l.rate) || 0) * 100) / 100;
  const taxable = Math.max(0, l.amount - (Number(l.discount_amount) || 0) + (Number(l.freight_amount) || 0) + (Number(l.other_charges) || 0));
  l.taxable_amount = taxable;
  const gstRate = Number(l.gst_rate) || 0;
  if (isInterstate) {
    l.igst_rate = gstRate;
    l.igst_amount = Math.round((taxable * (gstRate / 100)) * 100) / 100;
    l.cgst_rate = 0; l.cgst_amount = 0; l.sgst_rate = 0; l.sgst_amount = 0;
  } else {
    l.cgst_rate = gstRate / 2;
    l.cgst_amount = Math.round((taxable * (gstRate / 200)) * 100) / 100;
    l.sgst_rate = gstRate / 2;
    l.sgst_amount = l.cgst_amount;
    l.igst_rate = 0; l.igst_amount = 0;
  }
  l.net_amount = Math.round((taxable + l.cgst_amount + l.sgst_amount + l.igst_amount) * 100) / 100;
  return l;
}

const FABRIC_TYPE_LABEL: Record<string, string> = { KNIT: 'Knitted', WOVEN: 'Woven', NONWOVEN: 'Non-Woven' };

export default function FabricPurchaseOrderDetailPage() {
  const { id } = useParams();
  const isNew = !id || id === 'new';
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();

  const [saving, setSaving] = useState(false);
  const [showQuoteModal, setShowQuoteModal] = useState(false);

  // Lookups
  const suppliers = useLookup('suppliers');
  const styles = useLookup('styles');
  const fabrics = useLookup('fabrics');
  // GSM / Dia come from their masters on each line (client 05-Oct-2026 — the fabric master no longer carries them)
  const gsmList = useLookup('gsm');
  const diaList = useLookup('dias');
  const pickList = (rows: any[] | undefined, cur: string) => {
    const vals = [...new Set((rows ?? []).map((r: any) => { const v = String(r.code ?? r.label); return /^\d+(\.\d+)?$/.test(v) ? String(Number(v)) : v; }))];
    return cur && !vals.includes(String(cur)) ? [String(cur), ...vals] : vals;
  };
  const uoms = useLookup('uoms');
  const parties = useLookup('parties');
  const currencies = useLookup('currencies');

  const COMPANY_DEFAULT_ADDRESS = "CK Exports\n123 Textile Park, Dharapuram Road\nTirupur - 641604, Tamil Nadu\nGSTIN: 33AAAAA0000A1Z5";

  // Header state
  const [head, setHead] = useState({
    id: isNew ? undefined : Number(id),
    po_no: '',
    internal_ir_no: '',
    so_id: '',
    po_date: today(),
    supplier_id: '',
    style_id: '',
    currency_id: '1',
    exchange_rate: 1.0,
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
    tcs_applicable: false,
    tcs_section: '206C(1H)',
    tcs_rate: 0.1,
  });

  const [lines, setLines] = useState<FabricLine[]>([emptyFabricLine()]);
  const [filterBomOnly, setFilterBomOnly] = useState(false);

  // Selected Currency Info
  const selectedCurrency = (currencies.data as any[])?.find((c: any) => String(c.id) === String(head.currency_id));
  const currSymbol = selectedCurrency?.symbol || '₹';
  const currCode = selectedCurrency?.code || 'INR';
  const isForeignCurrency = currCode !== 'INR' && Number(head.exchange_rate) > 0 && Number(head.exchange_rate) !== 1.0;

  // Jobs (sales orders) for the IO No selector
  const { data: jobs = [] } = useQuery({
    queryKey: ['procurement-jobs'],
    queryFn: async () => (await http.get<{ data: JobOption[] }>('/procurement/jobs')).data || [],
    staleTime: 60 * 1000,
  });
  const selectedJob = jobs.find((j) => String(j.id) === String(head.so_id));
  const jobOptions = jobs.map((j) => ({ value: j.id, label: j.label }));
  const styleOptions = selectedJob
    ? selectedJob.styles.map((st) => ({ value: st.style_id, label: `${st.style_code} — ${st.style_name}` }))
    : toOptions(styles.data);

  // Last BOM loaded for the selected job (banner + "BOM items only" filter)
  const [bomData, setBomData] = useState<any>(null);
  const [bomLoading, setBomLoading] = useState(false);
  const bomFabrics: any[] = bomData?.fabrics || [];

  /** Fabric PO line from a BOM line: qty = BOM requirement for the job, rate = fabric std rate. */
  const bomToFabricLine = (bf: any, isInterstate: boolean): FabricLine => {
    const qty = Number(bf.final_requirement ?? bf.order_required_qty) || 0;
    const isKg = String(bf.uom_code || '').toUpperCase() === 'KG';
    return withFabricTotals({
      ...emptyFabricLine(),
      so_id: bf.so_id ? String(bf.so_id) : '',
      style_id: bf.style_id ? String(bf.style_id) : '',
      fabric_id: bf.fabric_id ? String(bf.fabric_id) : '',
      fabric_name: bf.fabric_name || bf.material_name || '',
      _bom: bf.bom_line_id ? Number(bf.bom_line_id) : undefined,
      // Grey / Dyed and the dyed colour come from the BOM line (else a colour-wise line is dyed)
      fabric_category: bf.dye_type === 'DYED' ? 'Dyed Fabric' : bf.dye_type === 'GREY' ? 'Grey Fabric' : (bf.color_id ? 'Dyed Fabric' : 'Grey Fabric'),
      fabric_type: FABRIC_TYPE_LABEL[bf.fabric_master_type] || bf.fabric_master_type || 'Knitted',
      dia: bf.fabric_dia ? `${Number(bf.fabric_dia)}"` : '',
      gsm: bf.fabric_gsm ? String(bf.fabric_gsm) : '',
      composition: bf.fabric_composition || '',
      color_name: bf.purchase_color_name ?? bf.color_name ?? '',
      uom_id: Number(bf.uom_id) || 5,
      qty,
      weight_kg: isKg ? qty : 0,
      rate: Number(bf.std_rate) || 0,
    }, isInterstate);
  };

  // Supplier's quotation: the PO takes its CONFIRMED rate and GST % for the same material / BOM line
  const quoted = useQuotedRates('FABRIC', head.supplier_id);
  const quoteArgs = (it: any) => ({ bom_line_id: it.bom_line_id ?? it._bom, material_id: it.fabric_id, color_id: it.color_id, size_id: it.size_id, so_id: it.so_id });
  const withQuote = (l: FabricLine, it: any): FabricLine => {
    const q = matchQuote(quoted.data, quoteArgs(it));
    return q ? withFabricTotals({ ...l, rate: q.rate, gst_rate: q.gst_rate }, head.is_interstate) : l;
  };
  // Supplier chosen / changed on a new PO: re-price the lines this supplier has quoted
  useEffect(() => {
    if (!isNew || !quoted.data?.length) return;
    let n = 0; let qno = '';
    const next = lines.map((l) => {
      const q = matchQuote(quoted.data, quoteArgs({ ...l, _bom: l._bom }));
      if (!q || (Number(l.rate) === q.rate && Number(l.gst_rate) === q.gst_rate)) return l;
      n++; qno = q.quotation_no;
      return withFabricTotals({ ...l, rate: q.rate, gst_rate: q.gst_rate }, head.is_interstate);
    });
    if (n) { setLines(next); toast(`${n} line(s) priced from quotation ${qno} (confirmed rate + GST)`, 'info'); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quoted.data]);

  // Line-level pick: the row's job + style → that job's BOM fabrics with their requirement
  const lineStyle = (l: FabricLine) => l.style_id || head.style_id || '';
  const jobBoms = useJobBoms(lines.map((l) => ({ so_id: l.so_id, style_id: lineStyle(l) })));
  const pickBomFabric = (idx: number, l: FabricLine, it: JobBomItem) => {
    const next = withQuote(bomToFabricLine(it, head.is_interstate), it);
    const quotedLine = !!matchQuote(quoted.data, quoteArgs(it));
    updateLine(idx, { ...next, _key: l._key, id: l.id, _bom: it.bom_line_id,
      rate: quotedLine || !(Number(l.rate) > 0) ? next.rate : l.rate, gst_rate: quotedLine ? next.gst_rate : l.gst_rate });
  };

  /** Loads the job's BOM fabric lines into the PO (asks before replacing entered lines). */
  const loadBomForJob = async (soId: string, styleId?: string) => {
    if (!soId) return;
    setBomLoading(true);
    try {
      const qs = new URLSearchParams({ so_id: soId });
      if (styleId) qs.set('style_id', styleId);
      const res = await http.get<{ data: any }>(`/boms/for-job?${qs.toString()}`);
      const data = res.data;
      setBomData(data);
      (data?.warnings || []).forEach((w: string) => toast(w, 'warning'));
      const fabricsInBom: any[] = data?.fabrics || [];
      if (!fabricsInBom.length) {
        toast(`BOM ${data?.bom?.bom_no || ''} of this job has no fabric items`, 'warning');
        return;
      }
      const hasEntered = lines.some((l) => l.fabric_id || Number(l.qty) > 0);
      if (hasEntered && !window.confirm(`Replace the ${lines.length} existing line(s) with ${fabricsInBom.length} fabric item(s) from the job's BOM?`)) return;
      setLines(fabricsInBom.map((bf) => withQuote(bomToFabricLine(bf, head.is_interstate), bf)));
      toast(`Loaded ${fabricsInBom.length} fabric item(s) from BOM ${data.bom?.bom_no || ''}`, 'success');
    } catch (err: any) {
      setBomData(null);
      toast(err instanceof ApiError ? err.message : 'Failed to load the BOM of this job', 'error');
    } finally {
      setBomLoading(false);
    }
  };

  /** IO No picked: link the job, default its style, auto-load its BOM fabrics. */
  const handleJobChange = (soId: string) => {
    const job = jobs.find((j) => String(j.id) === soId);
    const styleId = job && job.styles.length === 1 ? String(job.styles[0].style_id) : '';
    setHead((h) => ({ ...h, so_id: soId, internal_ir_no: job?.job_no || '', style_id: styleId }));
    setBomData(null);
    if (soId) void loadBomForJob(soId);
  };

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
        internal_ir_no: d.internal_ir_no || '',
        so_id: d.so_id ? String(d.so_id) : '',
        po_date: d.po_date?.slice(0, 10) || today(),
        supplier_id: String(d.supplier_id || ''),
        style_id: String(d.style_id || ''),
        currency_id: String(d.currency_id || '1'),
        exchange_rate: Number(d.exchange_rate || 1.0),
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
        tcs_applicable: !!d.tcs_applicable,
        tcs_section: d.tcs_section || '206C(1H)',
        tcs_rate: Number(d.tcs_rate) || 0.1,
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
            fabric_category: l.fabric_category || 'Grey Fabric',
            fabric_type: l.fabric_type || 'Knitted',
            dia: l.dia || '',
            gsm: l.gsm || '',
            composition: l.composition || '',
            color_name: l.color_name || l.color_id || '',
            yarn_count_str: l.yarn_count_str || '',
            shade_code: l.shade_code || '',
            pantone_spec: l.pantone_spec || '',
            print_flag: !!l.print_flag,
            print_color: l.print_color || '',
            finish: l.finish || '',
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
      next[idx] = withFabricTotals({ ...next[idx], ...patch }, head.is_interstate);
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
    const baseBeforeTcs = itemsNet + freight + other;
    const tcsAmt = head.tcs_applicable
      ? Math.round(((baseBeforeTcs * (Number(head.tcs_rate) || 0)) / 100) * 100) / 100
      : 0;
    const grandTotal = Math.round((baseBeforeTcs + tcsAmt + roundOff) * 100) / 100;
    // Grey / Dyed split
    let greyQty = 0, dyedQty = 0;
    for (const l of lines) {
      const q = Number(l.qty) || 0;
      if (l.fabric_category === 'Dyed Fabric') dyedQty += q;
      else greyQty += q;
    }
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
      greyQty,
      dyedQty,
      tcsAmt,
    };
  }, [lines, head.freight_charges, head.other_charges, head.round_off, head.tcs_applicable, head.tcs_rate]);

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
    if (lines.length === 0 || lines.some((l) => !l.fabric_id || !(Number(l.qty) > 0))) {
      toast('Every line needs a fabric and a quantity greater than zero', 'warning');
      return;
    }

    setSaving(true);
    try {
      const payload = {
        po_no: head.po_no || undefined,
        internal_ir_no: head.internal_ir_no || null,
        so_id: head.so_id ? Number(head.so_id) : null,
        po_date: head.po_date,
        supplier_id: Number(head.supplier_id),
        style_id: head.style_id ? Number(head.style_id) : undefined,
        po_type: 'MATERIAL',
        order_type: head.order_type,
        currency_id: Number(head.currency_id || 1),
        exchange_rate: Number(head.exchange_rate || 1.0),
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
        tcs_applicable: head.tcs_applicable ? 1 : 0,
        tcs_section: head.tcs_applicable ? head.tcs_section : null,
        tcs_rate: head.tcs_applicable ? Number(head.tcs_rate) : 0,
        tcs_amount: totals.tcsAmt,
        approval_state: stateOverride || head.approval_state,
        remarks: head.remarks,
        billing_address: head.billing_address || null,
        shipping_address: head.shipping_address || null,
        shipping_to_party_id: head.shipping_to_party_id ? Number(head.shipping_to_party_id) : null,
        lines: lines.map((l) => {
          const isDyed = l.fabric_category === 'Dyed Fabric';
          return {
            fabric_id: Number(l.fabric_id),
            so_id: l.so_id ? Number(l.so_id) : undefined,
            style_id: l.style_id ? Number(l.style_id) : undefined,
            hsn_code: l.hsn_code || '5208',
            material_type: 'FABRIC',
            description: `${l.fabric_category} — ${l.composition} ${l.fabric_type} ${l.gsm} GSM`,
            fabric_category: l.fabric_category,
            fabric_type: l.fabric_type,
            color_name: l.color_name || null,
            dia: l.dia,
            gsm: l.gsm,
            composition: l.composition,
            yarn_count_str: l.yarn_count_str || null,
            shade_code: l.shade_code || null,
            pantone_spec: isDyed ? (l.pantone_spec || null) : null,
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
          };
        }),
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
      const res = await http.get<{ data: any[] }>('/quotations?quotation_type=FABRIC&quotation_category=PURCHASE&pageSize=200');
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
      if (res.data.unresolved_lines) {
        toast(`${res.data.unresolved_lines} line(s) have no fabric master — pick the fabric on the PO and approve it`, 'warning');
      }
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
              {isForeignCurrency && (
                <span className="px-2 py-0.5 text-[11px] font-bold rounded-full bg-amber-100 text-amber-800 border border-amber-300 flex items-center gap-1">
                  <Globe size={11} /> IMPORT PO ({currCode})
                </span>
              )}
            </div>
             <p className="text-xs text-slate-500 mt-0.5">
              Grey / Dyed fabric purchase — Knitted / Woven specifications, roll targets, and rates
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

      {/* Header Fields Card — same layout as the Yarn PO */}
      <div className="bg-white p-4 rounded-xl border border-slate-200/80 shadow-sm space-y-4">
        <div className="text-xs font-semibold text-slate-900 uppercase tracking-wider flex items-center justify-between pb-2 border-b border-slate-100">
          <div className="flex items-center gap-1.5">
            <Layers size={14} className="text-sky-600" />
            <span>Purchase Order Details</span>
          </div>
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

        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">
          <Input
            label="PO Number"
            value={head.po_no}
            onChange={(e) => setHead((p) => ({ ...p, po_no: e.target.value }))}
            placeholder="Auto-generated if blank"
            disabled={!isNew}
          />

          <Input
            label="PO Date"
            type="date"
            value={head.po_date}
            onChange={(e) => setHead((p) => ({ ...p, po_date: e.target.value }))}
          />

          <Input
            label="Required Delivery Date"
            type="date"
            value={head.delivery_date}
            onChange={(e) => setHead((p) => ({ ...p, delivery_date: e.target.value }))}
          />

          <Select
            label="Fabric Mill / Supplier *"
            value={head.supplier_id}
            onChange={(e) => setHead((p) => ({ ...p, supplier_id: e.target.value }))}
            options={toOptions(suppliers.data)}
            placeholder="Select Supplier"
          />

          <Select
            label="IO No (Internal Order)"
            value={head.so_id || (head.internal_ir_no ? '__unlinked' : '')}
            onChange={(e) => e.target.value !== '__unlinked' && handleJobChange(e.target.value)}
            options={jobOptions}
            placeholder="Select Job / IO No"
          >
            {!head.so_id && head.internal_ir_no && (
              <option value="__unlinked">{head.internal_ir_no} (not linked to a job)</option>
            )}
          </Select>

          <Select
            label="Style No"
            value={head.style_id}
            onChange={(e) => setHead((p) => ({ ...p, style_id: e.target.value }))}
            options={styleOptions}
            placeholder={selectedJob ? 'All styles of the job' : 'Select Style'}
          />

          <Input
            label="Payment Terms"
            value={head.payment_terms}
            onChange={(e) => setHead((p) => ({ ...p, payment_terms: e.target.value }))}
            placeholder="e.g. 30 Days Net"
          />

          <Select
            label="Currency *"
            options={toOptions(currencies.data)}
            value={head.currency_id}
            onChange={(e) => {
              const cid = e.target.value;
              const cur = (currencies.data as any[])?.find((c: any) => String(c.id) === cid);
              setHead((h) => ({
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
            value={head.exchange_rate}
            disabled={!isForeignCurrency}
            onChange={(e) => setHead((p) => ({ ...p, exchange_rate: Number(e.target.value) }))}
            placeholder="1.0000"
          />

          <Input
            label="Approval State"
            value={head.approval_state === 'APPROVED' ? 'Approved & Active' : head.approval_state === 'DRAFT' ? 'Draft' : head.approval_state}
            disabled
            hint="Use Save Draft / Approve PO"
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
            onChange={(e) => setHead((p) => ({ ...p, order_type: e.target.value }))}
          />

          <div className="sm:col-span-4">
            <Input
              label="Remarks / Contract Specifications"
              value={head.remarks}
              onChange={(e) => setHead((p) => ({ ...p, remarks: e.target.value }))}
              placeholder="Special instructions..."
            />
          </div>
        </div>
      </div>

      {/* BOM Linkage & Auto-Fill Banner (Clip 4) */}
      {head.so_id && (
        <div className="rounded-xl border border-sky-200 bg-gradient-to-r from-sky-50/80 via-white to-sky-50/50 p-4 shadow-xs">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-start gap-3">
              <span className="p-2 rounded-lg bg-sky-100 text-sky-700 mt-0.5">
                <Sparkles size={16} />
              </span>
              <div>
                <div className="flex items-center gap-2">
                  <h4 className="text-xs font-bold text-sky-950 uppercase tracking-wide">
                    Bill of Materials (BOM) Fabric Integration
                  </h4>
                  {bomData?.bom && (
                    <span className="bg-sky-100 text-sky-800 text-[10.5px] font-bold px-2 py-0.5 rounded border border-sky-300">
                      BOM: {bomData.bom.bom_no} · v{bomData.bom.version}
                    </span>
                  )}
                </div>
                <p className="text-[11px] text-slate-600 mt-0.5">
                  {bomLoading
                    ? 'Loading the BOM of this job…'
                    : bomData
                      ? `${bomFabrics.length} fabric item(s) in the BOM of job ${bomData.job_no || head.internal_ir_no} (plan-cut ${fmtDecimal(bomData.order_qty, 0)} pcs).`
                      : `Load the fabric items of job ${head.internal_ir_no || ''} from its Bill of Materials.`}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              {bomFabrics.length > 0 && (
                <label className="flex items-center gap-1.5 text-xs text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={filterBomOnly}
                    onChange={(e) => setFilterBomOnly(e.target.checked)}
                    className="rounded border-slate-300 text-sky-600 focus:ring-sky-500"
                  />
                  <span>Show BOM Items Only</span>
                </label>
              )}
              <button
                type="button"
                disabled={bomLoading}
                onClick={() => void loadBomForJob(head.so_id, head.style_id)}
                className="btn-primary text-xs py-1.5 px-3 flex items-center gap-1 bg-sky-600 hover:bg-sky-700 border-sky-600 shadow-xs text-white disabled:opacity-50"
              >
                <Sparkles size={13} /> {bomData ? 'Reload Fabric from BOM' : 'Load Fabric from BOM'}
              </button>
            </div>
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
                <th className="py-2.5 px-2 w-8 text-center">#</th>
                <th className="py-2.5 px-2 min-w-[130px]">IO No</th>
                <th className="py-2.5 px-2 min-w-[110px]">Style</th>
                <th className="py-2.5 px-2 min-w-[150px]">Fabric</th>
                <th className="py-2.5 px-2 w-24">Grey / Dyed</th>
                <th className="py-2.5 px-2 w-20">Color</th>
                <th className="py-2.5 px-2 w-24">Pantone / Spec</th>
                <th className="py-2.5 px-2 w-28">Composition</th>
                <th className="py-2.5 px-2 w-16">Counts</th>
                <th className="py-2.5 px-2 w-16">GSM</th>
                <th className="py-2.5 px-2 w-16">Dia</th>
                <th className="py-2.5 px-2 w-20 text-right">Qty</th>
                <th className="py-2.5 px-2 min-w-[84px] whitespace-nowrap">UOM</th>
                <th className="py-2.5 px-2 w-20 text-right">Rate (₹)</th>
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
                <th className="py-2.5 px-2 w-24 text-right">Amount (₹)</th>
                <th className="py-2.5 px-2 w-8 text-center"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {lines.map((l, idx) => {
                const isDyed = l.fabric_category === 'Dyed Fabric';
                const lineBom = jobBoms.itemsFor(l.so_id, lineStyle(l), ['FABRIC']).filter((it) => it.fabric_id);
                return (
                <tr key={l._key} className="hover:bg-slate-50/50">
                  {/* # S NO */}
                  <td className="py-2 px-2 text-center text-slate-400 font-mono text-[11px]">{idx + 1}</td>
                  {/* I/O Num (Sales Order / Job) */}
                  <td className="py-2 px-2">
                    <select
                      value={l.so_id || ''}
                      onChange={(e) => updateLine(idx, { so_id: e.target.value, _bom: undefined })}
                      className="input py-1 text-xs w-full bg-white"
                    >
                      <option value="">Stock / General</option>
                      {jobs.map((j) => (
                        <option key={j.id} value={j.id}>{j.job_no}</option>
                      ))}
                    </select>
                  </td>
                  {/* Style */}
                  <td className="py-2 px-2">
                    <select
                      value={l.style_id || ''}
                      onChange={(e) => updateLine(idx, { style_id: e.target.value, _bom: undefined })}
                      className="input py-1 text-xs w-full bg-white"
                    >
                      <option value="">—</option>
                      {(() => {
                        const job = jobs.find((j) => String(j.id) === String(l.so_id));
                        return job
                          ? job.styles.map((st) => <option key={st.style_id} value={st.style_id}>{st.style_code} — {st.style_name}</option>)
                          : toOptions(styles.data).map((st) => <option key={st.value} value={st.value}>{st.label}</option>);
                      })()}
                    </select>
                  </td>
                  {/* Fabric */}
                  <td className="py-2 px-2">
                    <select
                      value={l._bom && lineBom.some((it) => it.bom_line_id === l._bom) ? `bom:${l._bom}` : l.fabric_id}
                      onChange={(e) => {
                        if (e.target.value.startsWith('bom:')) {
                          const it = lineBom.find((x) => `bom:${x.bom_line_id}` === e.target.value);
                          if (it) pickBomFabric(idx, l, it);
                          return;
                        }
                        // A fabric that is on this job's BOM once fills from the BOM (qty, colour, dia, GSM)
                        const inBom = lineBom.filter((x) => String(x.fabric_id) === e.target.value);
                        if (inBom.length === 1) { pickBomFabric(idx, l, inBom[0]); return; }
                        if (inBom.length > 1) toast(`${inBom.length} BOM lines use this fabric (colour wise) — pick the line from the BOM group to load its qty`, 'info');
                        const fab: any = (fabrics.data || []).find((x: any) => String(x.id) === e.target.value);
                        updateLine(idx, {
                          _bom: undefined,
                          fabric_id: e.target.value,
                          fabric_name: fab?.label || fab?.fabric_name || '',
                          dia: fab?.dia_inch ? `${Number(fab.dia_inch)}"` : l.dia,
                          uom_id: Number(fab?.base_uom) || l.uom_id,
                          ...(() => {
                            const q = matchQuote(quoted.data, { material_id: e.target.value, so_id: l.so_id });
                            return q ? { rate: q.rate, gst_rate: q.gst_rate } : { rate: Number(l.rate) > 0 ? l.rate : (Number(fab?.std_rate) || 0) };
                          })(),
                        });
                      }}
                      className="input py-1 text-xs w-full bg-white"
                    >
                      <option value="">{jobBoms.statusFor(l.so_id, lineStyle(l)) === 'loading' ? 'Loading BOM…' : '— Select Fabric —'}</option>
                      {lineBom.length > 0 && (
                        <optgroup label="BOM of this job (qty = requirement)">
                          {lineBom.map((it) => <option key={it.bom_line_id} value={`bom:${it.bom_line_id}`}>{bomItemLabel(it)}</option>)}
                        </optgroup>
                      )}
                      <optgroup label="All fabrics">
                        {((filterBomOnly && bomFabrics.length > 0)
                          ? (fabrics.data || []).filter((f: any) => bomFabrics.some((bf: any) => Number(bf.fabric_id) === Number(f.id)))
                          : (fabrics.data || [])
                        ).map((o: any) => (
                          <option key={o.id} value={o.id}>{o.fabric_name || o.fabric_code || o.label}</option>
                        ))}
                      </optgroup>
                    </select>
                  </td>
                  {/* Grey / Dyed Fabric Category */}
                  <td className="py-2 px-2">
                    <select
                      value={l.fabric_category}
                      onChange={(e) => updateLine(idx, { fabric_category: e.target.value as 'Grey Fabric' | 'Dyed Fabric' })}
                      className={`text-xs rounded border py-1 px-1.5 font-semibold w-full ${
                        isDyed
                          ? 'bg-purple-50 text-purple-700 border-purple-300'
                          : 'bg-amber-50 text-amber-800 border-amber-300'
                      }`}
                    >
                      <option value="Grey Fabric">Grey Fabric</option>
                      <option value="Dyed Fabric">Dyed Fabric</option>
                    </select>
                  </td>
                  {/* Color */}
                  <td className="py-2 px-2">
                    <input
                      type="text"
                      value={l.color_name}
                      onChange={(e) => updateLine(idx, { color_name: e.target.value })}
                      placeholder="Navy"
                      className="input py-1 text-xs w-full"
                    />
                  </td>
                  {/* Pantone / Spec — only for Dyed Fabric */}
                  <td className="py-2 px-2">
                    {isDyed ? (
                      <input
                        type="text"
                        value={l.pantone_spec}
                        onChange={(e) => updateLine(idx, { pantone_spec: e.target.value })}
                        placeholder="19-4052 TCX"
                        className="input py-1 text-xs w-full font-mono text-purple-700 bg-purple-50/30"
                      />
                    ) : (
                      <span className="text-slate-300 text-[11px] block text-center">—</span>
                    )}
                  </td>
                  {/* Composition */}
                  <td className="py-2 px-2">
                    <input
                      type="text"
                      value={l.composition}
                      onChange={(e) => updateLine(idx, { composition: e.target.value })}
                      placeholder="100% Cotton"
                      className="input py-1 text-xs w-full"
                    />
                  </td>
                  {/* Counts (yarn count used in the fabric) */}
                  <td className="py-2 px-2">
                    <input
                      type="text"
                      value={l.yarn_count_str}
                      onChange={(e) => updateLine(idx, { yarn_count_str: e.target.value })}
                      placeholder="30s"
                      className="input py-1 text-xs w-full font-mono"
                    />
                  </td>
                  {/* GSM */}
                  <td className="py-2 px-2">
                    <select value={l.gsm ?? ''} id={`fpo-line-${idx}-gsm`} onChange={(e) => updateLine(idx, { gsm: e.target.value })} className="input py-1 text-xs w-full">
                      <option value="">—</option>
                      {pickList(gsmList.data as any, l.gsm).map((g) => <option key={g} value={g}>{g}</option>)}
                    </select>
                  </td>
                  {/* DIA */}
                  <td className="py-2 px-2">
                    <select value={l.dia ?? ''} id={`fpo-line-${idx}-dia`} onChange={(e) => updateLine(idx, { dia: e.target.value })} className="input py-1 text-xs w-full">
                      <option value="">—</option>
                      {pickList(diaList.data as any, l.dia).map((d) => <option key={d} value={d}>{d}</option>)}
                    </select>
                  </td>
                  {/* Qty */}
                  <td className="py-2 px-2">
                    <input
                      type="number"
                      step="0.01"
                      value={l.qty}
                      onChange={(e) => updateLine(idx, { qty: Number(e.target.value) })}
                      className="input py-1 text-xs w-full text-right font-mono font-bold"
                    />
                  </td>
                  {/* UOM */}
                  <td className="py-2 px-2">
                    <select
                      value={l.uom_id}
                      onChange={(e) => updateLine(idx, { uom_id: Number(e.target.value) })}
                      className="input py-1 !px-1.5 text-xs w-full min-w-[76px] bg-white font-semibold"
                    >
                      {(uoms.data || []).map((u) => (
                        <option key={u.id} value={u.id}>{u.code || u.label}</option>
                      ))}
                    </select>
                  </td>
                  {/* Rate */}
                  <td className="py-2 px-2">
                    <input
                      type="number"
                      step="0.01"
                      value={l.rate}
                      onChange={(e) => updateLine(idx, { rate: Number(e.target.value) })}
                      className="input py-1 text-xs w-full text-right font-mono font-bold text-brand-700"
                    />
                  </td>
                  {/* GST / IGST */}
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
                  {/* Amount */}
                  <td className="py-2 px-2 text-right font-mono font-bold text-slate-900">
                    ₹{fmtDecimal(l.net_amount)}
                  </td>
                  {/* Delete */}
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
                );
              })}
            </tbody>
            <tfoot className="bg-slate-50/80 border-t border-slate-200 font-bold text-slate-800">
              <tr>
                <td colSpan={12} className="py-3 px-3 text-right text-slate-600">
                  <span className="mr-4">Grey: <span className="font-mono text-amber-700">{fmtDecimal(totals.greyQty)}</span></span>
                  <span className="mr-4">Dyed: <span className="font-mono text-purple-700">{fmtDecimal(totals.dyedQty)}</span></span>
                  Total Qty:
                </td>
                <td className="py-3 px-2 text-right font-mono">{fmtDecimal(totals.totalQty, 2)}</td>
                <td className="py-3 px-2 text-right font-mono text-xs text-slate-500">Taxable:</td>
                {head.is_interstate ? (
                  <>
                    <td className="py-3 px-2 text-center text-xs text-slate-500">IGST:</td>
                    <td className="py-3 px-2 text-right font-mono text-purple-700">
                      ₹{fmtDecimal(totals.totalIgst, 2)}
                    </td>
                  </>
                ) : (
                  <>
                    <td className="py-3 px-2 text-center text-xs text-slate-500">CGST+SGST:</td>
                    <td className="py-3 px-2 text-right font-mono text-purple-700">
                      ₹{fmtDecimal(totals.totalCgst + totals.totalSgst, 2)}
                    </td>
                  </>
                )}
                <td className="py-3 px-2 text-right font-mono text-base font-black text-slate-900">
                  ₹{fmtDecimal(totals.grandTotal, 2)}
                </td>
                <td></td>
              </tr>
            </tfoot>
          </table>
        </div>

        {/* Footer Financial Adjustments & TCS */}
        <div className="mt-4 border-t border-slate-200 bg-slate-50/70 p-4 rounded-xl">
          <div className="grid grid-cols-1 sm:grid-cols-5 gap-4 items-end">
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

            <div className="p-2.5 rounded-lg border border-amber-200 bg-amber-50/60 space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="flex items-center gap-1.5 text-[11px] font-bold text-amber-900 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={head.tcs_applicable}
                    onChange={(e) => setHead((h) => ({ ...h, tcs_applicable: e.target.checked }))}
                    className="rounded border-amber-300 text-amber-600 focus:ring-amber-500"
                  />
                  <span>TCS Applicable</span>
                </label>
                {head.tcs_applicable && (
                  <span className="text-[11px] font-bold font-mono text-amber-800">
                    + ₹{fmtDecimal(totals.tcsAmt)}
                  </span>
                )}
              </div>
              {head.tcs_applicable && (
                <div className="flex items-center gap-1.5 text-[11px]">
                  <select
                    value={head.tcs_section}
                    onChange={(e) => setHead((h) => ({ ...h, tcs_section: e.target.value }))}
                    className="input py-0.5 px-1.5 text-[10px] w-24"
                  >
                    <option value="206C(1H)">206C(1H)</option>
                    <option value="206C(1)">206C(1)</option>
                  </select>
                  <input
                    type="number"
                    step="0.01"
                    value={head.tcs_rate}
                    onChange={(e) => setHead((h) => ({ ...h, tcs_rate: parseFloat(e.target.value) || 0 }))}
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
                  INR Converted: ₹{fmtDecimal(totals.grandTotal * Number(head.exchange_rate), 2)}
                </span>
              )}
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
