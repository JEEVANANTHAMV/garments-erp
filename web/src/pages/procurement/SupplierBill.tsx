import { useState, useEffect, useMemo } from 'react';
import { CrudPage } from '../../components/CrudPage';
import { StatusBadge, Badge, Modal, Input, Select, Button, Spinner } from '../../components/ui';
import { fmtDate, fmtDecimal, humanize, today } from '../../lib/format';
import { useLookup, toOptions } from '../../hooks/useLookup';
import { useToast } from '../../hooks/useToast';
import { http, ApiError } from '../../lib/api';
import { Plus, Trash2, CheckCircle2, Sparkles, Layers } from 'lucide-react';

export const BILL_TYPES = [
  { value: 'YARN_PURCHASE', label: 'Yarn Purchase Bill', icon: '🧵', tone: 'indigo', material: 'YARN' },
  { value: 'YARN_PROCESS', label: 'Yarn Process Bill (Knitting)', icon: '⚙️', tone: 'sky', material: 'YARN' },
  { value: 'FABRIC_PURCHASE', label: 'Fabric Purchase Bill', icon: '🧶', tone: 'purple', material: 'FABRIC' },
  { value: 'FABRIC_PROCESS', label: 'Fabric Process Bill (Dyeing)', icon: '🎨', tone: 'pink', material: 'FABRIC' },
  { value: 'TRIMS_PURCHASE', label: 'Trims Purchase Bill', icon: '✂️', tone: 'amber', material: 'TRIM' },
  { value: 'TRIMS_PROCESS', label: 'Trims Process Bill', icon: '🛠️', tone: 'orange', material: 'TRIM' },
  { value: 'IMPORT_PURCHASE', label: 'Import Purchase Bill', icon: '🚢', tone: 'emerald', material: 'FABRIC' },
  { value: 'IMPORT_PROCESS', label: 'Import Process / Service', icon: '🌐', tone: 'teal', material: 'SERVICE' },
  { value: 'GENERAL', label: 'General Bill', icon: '📦', tone: 'slate', material: 'SERVICE' },
] as const;

interface BillLineItem {
  id?: number;
  po_line_id?: number | null;
  grn_line_id?: number | null;
  material_type: 'YARN' | 'FABRIC' | 'TRIM' | 'SERVICE';
  description: string;
  lot_no?: string;
  no_of_bags?: number;
  no_of_rolls?: number;
  dia?: string;
  gsm?: number;
  color_name?: string;
  size_name?: string;
  bill_qty: number;
  po_qty?: number;
  grn_qty?: number;
  uom_id: number;
  rate: number;
  amount: number;
  gst_rate?: number;
  hsn_code?: string;
  qty_matched?: boolean;
  rate_matched?: boolean;
}

interface InwardBillModalProps {
  open: boolean;
  billId: number | null;
  initialType?: string;
  onClose: () => void;
  onSaved: () => void;
}

function InwardBillModal({ open, billId, initialType, onClose, onSaved }: InwardBillModalProps) {
  const toast = useToast();
  const suppliers = useLookup('suppliers');
  const grns = useLookup('grns');
  const purchaseOrders = useLookup('purchase-orders');
  const currencies = useLookup('currencies');
  const uoms = useLookup('uoms');

  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [fetchingGrn, setFetchingGrn] = useState(false);

  const [billType, setBillType] = useState<string>(
    initialType && initialType !== 'ALL' ? initialType : 'YARN_PURCHASE'
  );

  const [header, setHeader] = useState({
    bill_no: '',
    bill_date: today(),
    supplier_id: '',
    supplier_inv_no: '',
    supplier_inv_date: today(),
    po_id: '',
    grn_id: '',
    knitting_order_id: '',
    fabric_process_order_id: '',
    currency_id: '1',
    gst_type: 'INTRA_STATE',
    exchange_rate: 1.0,
    boe_no: '',
    boe_date: '',
    port_code: '',
    tds_pct: 0.1,
    po_matched: false,
    grn_matched: true,
    gate_matched: false,
    match_status: 'UNMATCHED',
    payment_due_date: '',
    status: 'DRAFT',
    remarks: '',
  });

  const [lines, setLines] = useState<BillLineItem[]>([]);

  // Load existing bill for editing
  useEffect(() => {
    if (!open) return;
    if (billId) {
      setLoading(true);
      http.get<{ data: any }>(`/supplier-bills/${billId}`)
        .then((res) => {
          const b = res.data;
          setHeader({
            bill_no: b.bill_no || '',
            bill_date: b.bill_date?.slice(0, 10) || today(),
            supplier_id: b.supplier_id ? String(b.supplier_id) : '',
            supplier_inv_no: b.supplier_inv_no || '',
            supplier_inv_date: b.supplier_inv_date?.slice(0, 10) || today(),
            po_id: b.po_id ? String(b.po_id) : '',
            grn_id: b.grn_id ? String(b.grn_id) : '',
            knitting_order_id: b.knitting_order_id ? String(b.knitting_order_id) : '',
            fabric_process_order_id: b.fabric_process_order_id ? String(b.fabric_process_order_id) : '',
            currency_id: b.currency_id ? String(b.currency_id) : '1',
            gst_type: b.gst_type || 'INTRA_STATE',
            exchange_rate: Number(b.exchange_rate) || 1.0,
            boe_no: b.boe_no || '',
            boe_date: b.boe_date?.slice(0, 10) || '',
            port_code: b.port_code || '',
            tds_pct: b.subtotal > 0 && b.tds_amount ? Math.round((b.tds_amount / b.subtotal) * 1000) / 10 : 0.1,
            po_matched: Boolean(b.po_matched),
            grn_matched: Boolean(b.grn_matched),
            gate_matched: Boolean(b.gate_matched),
            match_status: b.match_status || 'UNMATCHED',
            payment_due_date: b.payment_due_date?.slice(0, 10) || '',
            status: b.status || 'DRAFT',
            remarks: b.remarks || '',
          });
          setBillType(b.bill_type || 'YARN_PURCHASE');
          if (Array.isArray(b.lines) && b.lines.length > 0) {
            setLines(b.lines.map((l: any) => ({
              ...l,
              bill_qty: Number(l.bill_qty) || 0,
              rate: Number(l.rate) || 0,
              amount: Number(l.amount) || (Number(l.bill_qty || 0) * Number(l.rate || 0)),
              gst_rate: Number(l.gst_rate) || 5,
              no_of_bags: l.no_of_bags != null ? Number(l.no_of_bags) : undefined,
              no_of_rolls: l.no_of_rolls != null ? Number(l.no_of_rolls) : undefined,
              gsm: l.gsm != null ? Number(l.gsm) : undefined,
            })));
          } else {
            initDefaultLine(b.bill_type || 'YARN_PURCHASE');
          }
        })
        .catch((err) => {
          toast(err.message || 'Failed to load bill', 'error');
        })
        .finally(() => setLoading(false));
    } else {
      // New Bill
      const bType = initialType && initialType !== 'ALL' ? initialType : 'YARN_PURCHASE';
      setBillType(bType);
      setHeader({
        bill_no: '',
        bill_date: today(),
        supplier_id: '',
        supplier_inv_no: '',
        supplier_inv_date: today(),
        po_id: '',
        grn_id: '',
        knitting_order_id: '',
        fabric_process_order_id: '',
        currency_id: '1',
        gst_type: 'INTRA_STATE',
        exchange_rate: 1.0,
        boe_no: '',
        boe_date: '',
        port_code: '',
        tds_pct: 0.1,
        po_matched: false,
        grn_matched: false,
        gate_matched: false,
        match_status: 'UNMATCHED',
        payment_due_date: '',
        status: 'DRAFT',
        remarks: '',
      });
      initDefaultLine(bType);
    }
  }, [open, billId, initialType]);

  const initDefaultLine = (type: string) => {
    const isYarn = type.startsWith('YARN');
    const isFab = type.startsWith('FABRIC');
    const isTrim = type.startsWith('TRIM');
    const matType: any = isYarn ? 'YARN' : isFab ? 'FABRIC' : isTrim ? 'TRIM' : 'SERVICE';
    const defaultUom = isYarn ? 5 : isFab ? 9 : 1; // 5: KG, 9: MTR, 1: PCS
    setLines([
      {
        material_type: matType,
        description: isYarn ? '30s Combed Cotton Yarn' : isFab ? 'Single Jersey 160 GSM' : isTrim ? 'Buttons / Zippers' : 'Jobwork Service',
        lot_no: isYarn ? 'LOT-101' : '',
        no_of_bags: isYarn ? 50 : undefined,
        no_of_rolls: isFab ? 20 : undefined,
        dia: isFab ? '32"' : '',
        gsm: isFab ? 160 : undefined,
        color_name: '',
        size_name: '',
        bill_qty: isYarn ? 2500 : isFab ? 1000 : 500,
        po_qty: 0,
        grn_qty: 0,
        uom_id: defaultUom,
        rate: isYarn ? 280 : isFab ? 340 : 1.5,
        amount: isYarn ? 700000 : isFab ? 340000 : 750,
        gst_rate: isTrim ? 18 : 5,
        qty_matched: true,
        rate_matched: true,
      },
    ]);
  };

  // Auto-Fetch Lines from selected GRN
  const handleFetchFromGrn = async () => {
    if (!header.grn_id) {
      toast('Please select a GRN first', 'warning');
      return;
    }

    setFetchingGrn(true);
    try {
      const isYarn = billType.startsWith('YARN');
      const isFab = billType.startsWith('FABRIC');
      let fetchedLines: any[] = [];
      let grnDetails: any = null;

      if (isYarn) {
        try {
          const res = await http.get<{ data: any }>(`/yarn-grns/${header.grn_id}`);
          grnDetails = res.data;
          fetchedLines = res.data.lines || [];
        } catch {
          const res = await http.get<{ data: any }>(`/inventory/grns/${header.grn_id}`);
          grnDetails = res.data;
          fetchedLines = res.data.lines || [];
        }
      } else if (isFab) {
        try {
          const res = await http.get<{ data: any }>(`/fabric-grns/${header.grn_id}`);
          grnDetails = res.data;
          fetchedLines = res.data.lines || [];
        } catch {
          const res = await http.get<{ data: any }>(`/inventory/grns/${header.grn_id}`);
          grnDetails = res.data;
          fetchedLines = res.data.lines || [];
        }
      } else {
        const res = await http.get<{ data: any }>(`/inventory/grns/${header.grn_id}`);
        grnDetails = res.data;
        fetchedLines = res.data.lines || [];
      }

      if (grnDetails) {
        setHeader((prev) => ({
          ...prev,
          supplier_id: grnDetails.supplier_id ? String(grnDetails.supplier_id) : prev.supplier_id,
          po_id: grnDetails.po_id ? String(grnDetails.po_id) : prev.po_id,
          supplier_inv_no: grnDetails.supplier_dc_no || grnDetails.dc_no || prev.supplier_inv_no,
          grn_matched: true,
          match_status: 'FULLY_MATCHED',
        }));
      }

      if (fetchedLines.length > 0) {
        const mapped: BillLineItem[] = fetchedLines.map((l: any) => {
          const qty = Number(l.received_qty) || Number(l.received_weight) || Number(l.qty) || 0;
          const r = Number(l.rate) || Number(l.unit_price) || 0;
          const gst = Number(l.gst_rate) || 5;
          const amt = Math.round(qty * r * 100) / 100;
          return {
            grn_line_id: l.id,
            po_line_id: l.po_line_id,
            material_type: isYarn ? 'YARN' : isFab ? 'FABRIC' : (l.material_type || 'TRIM'),
            description: l.yarn_name || l.yarn_type || l.fabric_name || l.trim_name || l.description || 'Material',
            lot_no: l.lot_no || l.batch_no || '',
            no_of_bags: l.no_of_rolls || l.bags || undefined,
            no_of_rolls: l.no_of_rolls || l.rolls || undefined,
            dia: l.dia ? `${l.dia}"` : '',
            gsm: Number(l.gsm) || undefined,
            color_name: l.color_name || '',
            size_name: l.size_name || '',
            bill_qty: qty,
            po_qty: Number(l.po_qty) || qty,
            grn_qty: qty,
            uom_id: l.uom_id || (isYarn ? 5 : isFab ? 9 : 1),
            rate: r,
            amount: amt,
            gst_rate: gst,
            qty_matched: true,
            rate_matched: true,
          };
        });
        setLines(mapped);
        toast(`Loaded ${mapped.length} item lines from GRN!`, 'success');
      } else {
        toast('No line items found in selected GRN', 'info');
      }
    } catch (err: any) {
      toast(err.message || 'Failed to fetch GRN lines', 'error');
    } finally {
      setFetchingGrn(false);
    }
  };

  // Line editing
  const updateLine = (idx: number, updates: Partial<BillLineItem>) => {
    setLines((prev) => {
      const copy = [...prev];
      const updated = { ...copy[idx], ...updates };
      // Auto recompute amount if qty or rate changes
      if ('bill_qty' in updates || 'rate' in updates) {
        updated.amount = Math.round((Number(updated.bill_qty || 0) * Number(updated.rate || 0)) * 100) / 100;
      }
      copy[idx] = updated;
      return copy;
    });
  };

  const addLine = () => {
    const isYarn = billType.startsWith('YARN');
    const isFab = billType.startsWith('FABRIC');
    const isTrim = billType.startsWith('TRIM');
    setLines((prev) => [
      ...prev,
      {
        material_type: isYarn ? 'YARN' : isFab ? 'FABRIC' : isTrim ? 'TRIM' : 'SERVICE',
        description: '',
        lot_no: '',
        no_of_bags: isYarn ? 0 : undefined,
        no_of_rolls: isFab ? 0 : undefined,
        dia: '',
        gsm: undefined,
        color_name: '',
        size_name: '',
        bill_qty: 0,
        uom_id: isYarn ? 5 : isFab ? 9 : 1,
        rate: 0,
        amount: 0,
        gst_rate: isTrim ? 18 : 5,
        qty_matched: true,
        rate_matched: true,
      },
    ]);
  };

  const removeLine = (idx: number) => {
    if (lines.length <= 1) {
      toast('At least one item line is required', 'warning');
      return;
    }
    setLines((prev) => prev.filter((_, i) => i !== idx));
  };

  const selectedCurrency = (currencies.data || []).find((c: any) => String(c.id) === String(header.currency_id));
  const isForeignCurrency = selectedCurrency && selectedCurrency.code && selectedCurrency.code !== 'INR';
  const isImport = billType.startsWith('IMPORT') || header.gst_type === 'IMPORT' || isForeignCurrency;
  const currencySymbol: string = String(isForeignCurrency ? (selectedCurrency?.symbol || selectedCurrency?.code || 'FC') : '₹');
  const exRate = isImport && Number(header.exchange_rate) > 0 ? Number(header.exchange_rate) : 1.0;

  // Dynamic Financial Summary Calculations
  const totals = useMemo(() => {
    const subtotal = Math.round(lines.reduce((acc, l) => acc + (Number(l.amount) || 0), 0) * 100) / 100;
    const gstAmount = Math.round(
      lines.reduce((acc, l) => {
        const gst = Number(l.gst_rate) || 0;
        const amt = Number(l.amount) || 0;
        return acc + (amt * (gst / 100.0));
      }, 0) * 100
    ) / 100;
    const tdsAmount = Math.round((subtotal * ((Number(header.tds_pct) || 0) / 100.0)) * 100) / 100;
    const totalAmount = Math.round((subtotal + gstAmount - tdsAmount) * 100) / 100;
    const totalQty = lines.reduce((acc, l) => acc + (Number(l.bill_qty) || 0), 0);

    const baseSubtotal = Math.round(subtotal * exRate * 100) / 100;
    const baseGstAmount = Math.round(gstAmount * exRate * 100) / 100;
    const baseTdsAmount = Math.round(tdsAmount * exRate * 100) / 100;
    const baseTotalAmount = Math.round(totalAmount * exRate * 100) / 100;

    return {
      subtotal,
      gstAmount,
      tdsAmount,
      totalAmount,
      totalQty,
      baseSubtotal,
      baseGstAmount,
      baseTdsAmount,
      baseTotalAmount,
    };
  }, [lines, header.tds_pct, exRate]);

  // Save handler
  const handleSave = async () => {
    if (!header.supplier_id) {
      toast('Please select a Supplier / Mill', 'error');
      return;
    }
    if (lines.length === 0 || lines.some((l) => !l.description || l.bill_qty <= 0)) {
      toast('Please fill all line items with valid description and quantity', 'error');
      return;
    }

    setSaving(true);
    try {
      const payload = {
        bill_no: header.bill_no || undefined,
        bill_type: billType,
        bill_date: header.bill_date,
        supplier_id: Number(header.supplier_id),
        supplier_inv_no: header.supplier_inv_no || undefined,
        supplier_inv_date: header.supplier_inv_date || undefined,
        po_id: header.po_id ? Number(header.po_id) : null,
        grn_id: header.grn_id ? Number(header.grn_id) : null,
        knitting_order_id: header.knitting_order_id ? Number(header.knitting_order_id) : null,
        fabric_process_order_id: header.fabric_process_order_id ? Number(header.fabric_process_order_id) : null,
        currency_id: Number(header.currency_id) || 1,
        gst_type: header.gst_type,
        exchange_rate: exRate,
        subtotal: totals.subtotal,
        gst_amount: totals.gstAmount,
        tds_amount: totals.tdsAmount,
        total_amount: totals.totalAmount,
        base_currency_total: totals.baseTotalAmount,
        boe_no: header.boe_no || null,
        boe_date: header.boe_date || null,
        port_code: header.port_code || null,
        po_matched: header.po_matched,
        grn_matched: header.grn_matched,
        gate_matched: header.gate_matched,
        match_status: header.match_status,
        payment_due_date: header.payment_due_date || null,
        status: header.status,
        remarks: header.remarks || null,
        lines: lines.map((l) => ({
          po_line_id: l.po_line_id || null,
          grn_line_id: l.grn_line_id || null,
          material_type: l.material_type,
          description: l.description,
          lot_no: l.lot_no || null,
          no_of_bags: l.no_of_bags != null ? Number(l.no_of_bags) : null,
          no_of_rolls: l.no_of_rolls != null ? Number(l.no_of_rolls) : null,
          dia: l.dia || null,
          gsm: l.gsm != null ? Number(l.gsm) : null,
          color_name: l.color_name || null,
          size_name: l.size_name || null,
          bill_qty: Number(l.bill_qty),
          po_qty: l.po_qty != null ? Number(l.po_qty) : null,
          grn_qty: l.grn_qty != null ? Number(l.grn_qty) : null,
          uom_id: Number(l.uom_id) || 5,
          rate: Number(l.rate),
          amount: Number(l.amount),
          gst_rate: Number(l.gst_rate) || 0,
          hsn_code: l.hsn_code || null,
          qty_matched: Boolean(l.qty_matched),
          rate_matched: Boolean(l.rate_matched),
        })),
      };

      if (billId) {
        await http.put(`/supplier-bills/${billId}`, payload);
        toast('Inward bill updated successfully!', 'success');
      } else {
        const res = await http.post<{ data: { id: number; bill_no: string } }>('/supplier-bills', payload);
        toast(`Inward bill ${res.data.bill_no || 'created'} saved successfully!`, 'success');
      }
      onSaved();
    } catch (err: any) {
      const msg = err instanceof ApiError ? err.message : 'Failed to save inward bill';
      toast(msg, 'error');
    } finally {
      setSaving(false);
    }
  };

  const isYarn = billType.startsWith('YARN');
  const isFab = billType.startsWith('FABRIC');
  const isTrim = billType.startsWith('TRIM');

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={billId ? `Edit Inward Bill #${billId}` : 'New Inward Bill Entry'}
      size="full"
      footer={
        <div className="flex items-center justify-between w-full">
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <span>Lines: <strong>{lines.length}</strong></span>
            <span>•</span>
            <span>Total Qty: <strong>{fmtDecimal(totals.totalQty, 2)}</strong></span>
            <span>•</span>
            <span className="text-brand-700 font-bold">
              Grand Total: ₹{fmtDecimal(totals.totalAmount, 2)}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              onClick={handleSave}
              disabled={saving}
              className="bg-brand-600 hover:bg-brand-700 text-white font-semibold flex items-center gap-1.5"
            >
              {saving ? <Spinner size={14} /> : <CheckCircle2 size={15} />}
              <span>{saving ? 'Saving...' : 'Save Inward Bill'}</span>
            </Button>
          </div>
        </div>
      }
    >
      {loading ? (
        <div className="py-20 text-center text-slate-400">Loading bill details...</div>
      ) : (
        <div className="space-y-4">
          {/* Bill Category Selector Tabs */}
          <div className="p-2 bg-slate-50 rounded-xl border border-slate-200/80 flex items-center gap-1.5 overflow-x-auto">
            {BILL_TYPES.map((bt) => {
              const active = billType === bt.value;
              return (
                <button
                  key={bt.value}
                  type="button"
                  onClick={() => {
                    setBillType(bt.value);
                    if (!billId) initDefaultLine(bt.value);
                  }}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1.5 transition ${
                    active
                      ? 'bg-white text-brand-700 shadow-sm border border-slate-200'
                      : 'text-slate-600 hover:text-slate-900 hover:bg-white/60'
                  }`}
                >
                  <span>{bt.icon}</span>
                  <span>{bt.label}</span>
                </button>
              );
            })}
          </div>

          {/* Header Parameters Grid */}
          <div className="bg-white p-4 rounded-xl border border-slate-200/80 shadow-xs space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
              <Input
                label="Internal Bill No"
                value={header.bill_no}
                onChange={(e) => setHeader((p) => ({ ...p, bill_no: e.target.value }))}
                placeholder="Auto-generated"
              />

              <Input
                label="Bill Date *"
                type="date"
                value={header.bill_date}
                onChange={(e) => setHeader((p) => ({ ...p, bill_date: e.target.value }))}
              />

              <div className="lg:col-span-2">
                <Select
                  label="Supplier / Mill / Processor *"
                  value={header.supplier_id}
                  onChange={(e) => setHeader((p) => ({ ...p, supplier_id: e.target.value }))}
                  options={toOptions(suppliers.data)}
                  placeholder="Select Supplier"
                />
              </div>

              <Input
                label="Supplier Inv / DC No"
                value={header.supplier_inv_no}
                onChange={(e) => setHeader((p) => ({ ...p, supplier_inv_no: e.target.value }))}
                placeholder="INV-12345"
              />

              <Input
                label="Supplier Inv Date"
                type="date"
                value={header.supplier_inv_date}
                onChange={(e) => setHeader((p) => ({ ...p, supplier_inv_date: e.target.value }))}
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3 pt-2 border-t border-slate-100 items-end">
              <div className="lg:col-span-2">
                <Select
                  label="Link GRN Ref"
                  value={header.grn_id}
                  onChange={(e) => setHeader((p) => ({ ...p, grn_id: e.target.value }))}
                  options={toOptions(grns.data)}
                  placeholder="Select GRN to auto-fill"
                />
              </div>

              <div>
                <button
                  type="button"
                  onClick={handleFetchFromGrn}
                  disabled={!header.grn_id || fetchingGrn}
                  className="w-full h-9 inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-lg border border-indigo-300 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 transition disabled:opacity-50"
                  title="Auto-fill lines from selected GRN"
                >
                  <Sparkles size={14} className={fetchingGrn ? 'animate-spin' : ''} />
                  <span>{fetchingGrn ? 'Fetching...' : 'Load from GRN'}</span>
                </button>
              </div>

              <div>
                <Select
                  label="Link Purchase Order"
                  value={header.po_id}
                  onChange={(e) => setHeader((p) => ({ ...p, po_id: e.target.value }))}
                  options={toOptions(purchaseOrders.data)}
                  placeholder="Select PO"
                />
              </div>

              <div>
                <Select
                  label="Currency *"
                  value={header.currency_id}
                  onChange={(e) => setHeader((p) => ({ ...p, currency_id: e.target.value }))}
                  options={toOptions(currencies.data)}
                  placeholder="Currency"
                />
              </div>

              <div>
                <Input
                  label="Payment Due Date"
                  type="date"
                  value={header.payment_due_date}
                  onChange={(e) => setHeader((p) => ({ ...p, payment_due_date: e.target.value }))}
                />
              </div>
            </div>

            {/* GST Tax Type & Import Configuration Row */}
            <div className="pt-3 border-t border-slate-100 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <span className="text-[11px] font-bold text-slate-700 uppercase tracking-wider">GST Tax Nature:</span>
                <div className="inline-flex rounded-lg border border-slate-200 p-0.5 bg-slate-50 text-xs">
                  <button
                    type="button"
                    onClick={() => setHeader((p) => ({ ...p, gst_type: 'INTRA_STATE' }))}
                    className={`px-2.5 py-1 rounded-md font-semibold transition ${
                      header.gst_type === 'INTRA_STATE'
                        ? 'bg-white text-indigo-700 shadow-xs border border-indigo-200'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    Intra-State (CGST + SGST)
                  </button>
                  <button
                    type="button"
                    onClick={() => setHeader((p) => ({ ...p, gst_type: 'INTER_STATE' }))}
                    className={`px-2.5 py-1 rounded-md font-semibold transition ${
                      header.gst_type === 'INTER_STATE'
                        ? 'bg-white text-brand-700 shadow-xs border border-brand-200'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    Inter-State (IGST)
                  </button>
                  <button
                    type="button"
                    onClick={() => setHeader((p) => ({ ...p, gst_type: 'IMPORT' }))}
                    className={`px-2.5 py-1 rounded-md font-semibold transition ${
                      header.gst_type === 'IMPORT'
                        ? 'bg-emerald-600 text-white shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    Overseas Import (Customs IGST)
                  </button>
                </div>
              </div>

              {isForeignCurrency && (
                <div className="flex items-center gap-2 bg-emerald-50 text-emerald-800 border border-emerald-200 px-3 py-1 rounded-lg text-xs font-medium">
                  <span>🌐 Foreign Currency: <strong>{String(selectedCurrency?.code || '')}</strong> ({String(selectedCurrency?.label || selectedCurrency?.code || '')})</span>
                </div>
              )}
            </div>

            {/* Import & Customs Parameters Card (Visible if Import or Foreign Currency selected) */}
            {isImport && (
              <div className="mt-3 p-3 bg-emerald-50/50 border border-emerald-200 rounded-xl space-y-2">
                <div className="flex items-center justify-between pb-1 border-b border-emerald-200/60">
                  <h4 className="text-xs font-bold text-emerald-950 uppercase tracking-wider flex items-center gap-1.5">
                    <span>🚢 Import & Customs Documentation</span>
                  </h4>
                  <span className="text-[11px] text-emerald-700 font-medium">
                    All lines entered in <strong>{selectedCurrency?.code || 'FC'}</strong>, auto-converted to INR for GST & accounts
                  </span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3 pt-1">
                  <div>
                    <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                      Exchange Rate (₹ per 1 {selectedCurrency?.code || 'FC'}) *
                    </label>
                    <input
                      type="number"
                      step="0.0001"
                      value={header.exchange_rate}
                      onChange={(e) => setHeader((p) => ({ ...p, exchange_rate: parseFloat(e.target.value) || 1.0 }))}
                      className="w-full text-xs font-bold text-emerald-800 border border-slate-300 rounded px-2 py-1.5 bg-white"
                      placeholder="e.g. 85.50"
                    />
                  </div>

                  <Input
                    label="Bill of Entry (BOE) No"
                    value={header.boe_no}
                    onChange={(e) => setHeader((p) => ({ ...p, boe_no: e.target.value }))}
                    placeholder="BOE-2026-987654"
                  />

                  <Input
                    label="Bill of Entry Date"
                    type="date"
                    value={header.boe_date}
                    onChange={(e) => setHeader((p) => ({ ...p, boe_date: e.target.value }))}
                  />

                  <Input
                    label="Port Code / Customs Location"
                    value={header.port_code}
                    onChange={(e) => setHeader((p) => ({ ...p, port_code: e.target.value }))}
                    placeholder="e.g. INMAA1 (Chennai Sea)"
                  />
                </div>
              </div>
            )}
          </div>

          {/* Line Items Table Customized by Bill Category */}
          <div className="bg-white p-4 rounded-xl border border-slate-200/80 shadow-xs space-y-3">
            <div className="flex items-center justify-between pb-2 border-b border-slate-100">
              <div className="flex items-center gap-2">
                <Layers size={16} className="text-brand-600" />
                <h3 className="text-xs font-bold text-slate-900 uppercase tracking-wider">
                  Inward Bill Line Items ({lines.length})
                </h3>
                <Badge tone={isYarn ? 'indigo' : isFab ? 'purple' : isTrim ? 'amber' : 'slate'}>
                  {isYarn ? 'Yarn Details (Count / Lot / Bags / Net KG)' : isFab ? 'Fabric Details (Rolls / Dia / GSM / Qty)' : isTrim ? 'Trims (Color / Size / Qty)' : 'General Lines'}
                </Badge>
              </div>

              <div className="flex items-center gap-2">
                <Button size="sm" variant="outline" onClick={addLine} className="text-xs flex items-center gap-1">
                  <Plus size={13} />
                  <span>Add Item Line</span>
                </Button>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="bg-slate-50 text-slate-700 font-bold border-b border-slate-200">
                    <th className="py-2.5 px-3 min-w-[180px]">
                      {isYarn ? 'Yarn Count / Desc *' : isFab ? 'Fabric Construction *' : isTrim ? 'Trim Item *' : 'Description *'}
                    </th>

                    {isYarn && <th className="py-2.5 px-2 w-28">Lot / Batch</th>}
                    {isYarn && <th className="py-2.5 px-2 w-24 text-right">No. Bags</th>}

                    {isFab && <th className="py-2.5 px-2 w-24">Dia</th>}
                    {isFab && <th className="py-2.5 px-2 w-20 text-right">GSM</th>}
                    {isFab && <th className="py-2.5 px-2 w-20 text-right">Rolls</th>}

                    {isTrim && <th className="py-2.5 px-2 w-28">Color</th>}
                    {isTrim && <th className="py-2.5 px-2 w-24">Size</th>}

                    <th className="py-2.5 px-2 w-28 text-right">
                      {isYarn ? 'Net KG *' : isFab ? 'Net Qty *' : 'Qty *'}
                    </th>

                    <th className="py-2.5 px-2 w-24">UOM</th>
                    <th className="py-2.5 px-2 w-28 text-right">Rate (₹) *</th>
                    <th className="py-2.5 px-2 w-20 text-right">GST %</th>
                    <th className="py-2.5 px-3 w-32 text-right text-brand-700">Amount (₹)</th>
                    <th className="py-2.5 px-2 w-10 text-center">Del</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-slate-700">
                  {lines.map((l, idx) => (
                    <tr key={idx} className="hover:bg-slate-50/50">
                      <td className="py-1.5 px-3">
                        <input
                          type="text"
                          value={l.description}
                          onChange={(e) => updateLine(idx, { description: e.target.value })}
                          placeholder={isYarn ? 'e.g. 30s Combed Cotton' : isFab ? 'e.g. Single Jersey 160 GSM' : 'Item name'}
                          className="w-full text-xs font-semibold border border-slate-300 rounded px-2 py-1"
                        />
                      </td>

                      {/* Yarn Specific Columns */}
                      {isYarn && (
                        <>
                          <td className="py-1.5 px-2">
                            <input
                              type="text"
                              value={l.lot_no || ''}
                              onChange={(e) => updateLine(idx, { lot_no: e.target.value })}
                              placeholder="Lot no"
                              className="w-full text-xs font-mono border border-slate-300 rounded px-1.5 py-1"
                            />
                          </td>
                          <td className="py-1.5 px-2 text-right">
                            <input
                              type="number"
                              value={l.no_of_bags ?? ''}
                              onChange={(e) => updateLine(idx, { no_of_bags: parseFloat(e.target.value) || 0 })}
                              placeholder="Bags"
                              className="w-full text-xs text-right border border-slate-300 rounded px-1.5 py-1"
                            />
                          </td>
                        </>
                      )}

                      {/* Fabric Specific Columns */}
                      {isFab && (
                        <>
                          <td className="py-1.5 px-2">
                            <input
                              type="text"
                              value={l.dia || ''}
                              onChange={(e) => updateLine(idx, { dia: e.target.value })}
                              placeholder='e.g. 32"'
                              className="w-full text-xs font-mono border border-slate-300 rounded px-1.5 py-1"
                            />
                          </td>
                          <td className="py-1.5 px-2 text-right">
                            <input
                              type="number"
                              value={l.gsm ?? ''}
                              onChange={(e) => updateLine(idx, { gsm: parseFloat(e.target.value) || 0 })}
                              placeholder="GSM"
                              className="w-full text-xs text-right border border-slate-300 rounded px-1.5 py-1"
                            />
                          </td>
                          <td className="py-1.5 px-2 text-right">
                            <input
                              type="number"
                              value={l.no_of_rolls ?? ''}
                              onChange={(e) => updateLine(idx, { no_of_rolls: parseFloat(e.target.value) || 0 })}
                              placeholder="Rolls"
                              className="w-full text-xs text-right border border-slate-300 rounded px-1.5 py-1"
                            />
                          </td>
                        </>
                      )}

                      {/* Trims Specific Columns */}
                      {isTrim && (
                        <>
                          <td className="py-1.5 px-2">
                            <input
                              type="text"
                              value={l.color_name || ''}
                              onChange={(e) => updateLine(idx, { color_name: e.target.value })}
                              placeholder="Color"
                              className="w-full text-xs border border-slate-300 rounded px-1.5 py-1"
                            />
                          </td>
                          <td className="py-1.5 px-2">
                            <input
                              type="text"
                              value={l.size_name || ''}
                              onChange={(e) => updateLine(idx, { size_name: e.target.value })}
                              placeholder="Size"
                              className="w-full text-xs border border-slate-300 rounded px-1.5 py-1"
                            />
                          </td>
                        </>
                      )}

                      <td className="py-1.5 px-2 text-right">
                        <input
                          type="number"
                          step="0.01"
                          value={l.bill_qty}
                          onChange={(e) => updateLine(idx, { bill_qty: parseFloat(e.target.value) || 0 })}
                          className="w-full text-xs text-right font-bold text-brand-700 border border-slate-300 rounded px-1.5 py-1"
                        />
                      </td>

                      <td className="py-1.5 px-2">
                        <select
                          value={l.uom_id}
                          onChange={(e) => updateLine(idx, { uom_id: parseInt(e.target.value) || 5 })}
                          className="w-full text-xs border border-slate-300 rounded px-1.5 py-1 bg-white"
                        >
                          {(uoms.data || [
                            { id: 5, label: 'KG' },
                            { id: 9, label: 'MTR' },
                            { id: 1, label: 'PCS' },
                            { id: 15, label: 'ROLL' },
                            { id: 17, label: 'CTN' },
                          ]).map((u: any) => (
                            <option key={u.id} value={u.id}>
                              {u.code || u.label}
                            </option>
                          ))}
                        </select>
                      </td>

                      <td className="py-1.5 px-2 text-right">
                        <input
                          type="number"
                          step="0.01"
                          value={l.rate}
                          onChange={(e) => updateLine(idx, { rate: parseFloat(e.target.value) || 0 })}
                          className="w-full text-xs text-right font-medium border border-slate-300 rounded px-1.5 py-1"
                        />
                      </td>

                      <td className="py-1.5 px-2 text-right">
                        <input
                          type="number"
                          step="1"
                          value={l.gst_rate ?? 5}
                          onChange={(e) => updateLine(idx, { gst_rate: parseFloat(e.target.value) || 0 })}
                          className="w-full text-xs text-right border border-slate-300 rounded px-1.5 py-1"
                        />
                      </td>

                      <td className="py-1.5 px-3 text-right font-bold text-brand-700 text-xs font-mono">
                        {fmtDecimal(l.amount, 2)}
                      </td>

                      <td className="py-1.5 px-2 text-center">
                        <button
                          type="button"
                          onClick={() => removeLine(idx)}
                          className="p-1 text-slate-400 hover:text-red-600 rounded"
                        >
                          <Trash2 size={13} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Financial Totals & Verification Card */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* 3-Way Match & Status Card */}
            <div className="p-4 bg-slate-50 rounded-xl border border-slate-200/80 space-y-3">
              <h4 className="text-xs font-bold text-slate-800 uppercase tracking-wider">
                Matching & Verification
              </h4>

              <div className="grid grid-cols-3 gap-2">
                <label className="flex items-center gap-2 p-2 bg-white rounded-lg border border-slate-200 text-xs cursor-pointer">
                  <input
                    type="checkbox"
                    checked={header.po_matched}
                    onChange={(e) => setHeader((p) => ({ ...p, po_matched: e.target.checked }))}
                    className="rounded text-brand-600"
                  />
                  <span className="font-semibold text-slate-700">PO Matched</span>
                </label>

                <label className="flex items-center gap-2 p-2 bg-white rounded-lg border border-slate-200 text-xs cursor-pointer">
                  <input
                    type="checkbox"
                    checked={header.grn_matched}
                    onChange={(e) => setHeader((p) => ({ ...p, grn_matched: e.target.checked }))}
                    className="rounded text-brand-600"
                  />
                  <span className="font-semibold text-slate-700">GRN Matched</span>
                </label>

                <label className="flex items-center gap-2 p-2 bg-white rounded-lg border border-slate-200 text-xs cursor-pointer">
                  <input
                    type="checkbox"
                    checked={header.gate_matched}
                    onChange={(e) => setHeader((p) => ({ ...p, gate_matched: e.target.checked }))}
                    className="rounded text-brand-600"
                  />
                  <span className="font-semibold text-slate-700">Gate Matched</span>
                </label>
              </div>

              <div className="grid grid-cols-2 gap-3 pt-1">
                <div>
                  <label className="block text-[11px] font-semibold text-slate-600">Match Status</label>
                  <select
                    value={header.match_status}
                    onChange={(e) => setHeader((p) => ({ ...p, match_status: e.target.value }))}
                    className="w-full text-xs border border-slate-300 rounded px-2 py-1.5 bg-white font-medium mt-0.5"
                  >
                    <option value="UNMATCHED">Unmatched</option>
                    <option value="PARTIAL">Partial Matched</option>
                    <option value="FULLY_MATCHED">Fully Matched</option>
                    <option value="DISCREPANCY">Discrepancy</option>
                  </select>
                </div>

                <div>
                  <label className="block text-[11px] font-semibold text-slate-600">Bill Status</label>
                  <select
                    value={header.status}
                    onChange={(e) => setHeader((p) => ({ ...p, status: e.target.value }))}
                    className="w-full text-xs border border-slate-300 rounded px-2 py-1.5 bg-white font-medium mt-0.5"
                  >
                    <option value="DRAFT">Draft</option>
                    <option value="VERIFIED">Verified</option>
                    <option value="APPROVED">Approved</option>
                    <option value="PAID">Paid</option>
                    <option value="DISPUTED">Disputed</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-600">Remarks / Discrepancy Notes</label>
                <textarea
                  rows={2}
                  value={header.remarks}
                  onChange={(e) => setHeader((p) => ({ ...p, remarks: e.target.value }))}
                  placeholder="Notes, terms, transport details, lot verification..."
                  className="w-full text-xs border border-slate-300 rounded px-2 py-1 mt-0.5 font-medium"
                />
              </div>
            </div>

            {/* Financial Calculations Card */}
            <div className="p-4 bg-brand-50/40 rounded-xl border border-brand-200/80 space-y-2 text-xs">
              <div className="flex items-center justify-between pb-1 border-b border-brand-200/60">
                <h4 className="text-xs font-bold text-brand-900 uppercase tracking-wider">
                  Invoice Financial Summary
                </h4>
                <span className="font-semibold text-[11px] text-brand-700">
                  {header.gst_type === 'INTRA_STATE' ? 'Intra-State (CGST + SGST)' : header.gst_type === 'INTER_STATE' ? 'Inter-State (IGST)' : 'Overseas Import (Customs)'}
                </span>
              </div>

              <div className="flex items-center justify-between py-0.5">
                <span className="text-slate-600">Taxable Subtotal:</span>
                <span className="font-bold text-slate-900 text-sm">
                  {currencySymbol}{fmtDecimal(totals.subtotal, 2)}
                </span>
              </div>

              {header.gst_type === 'INTRA_STATE' ? (
                <>
                  <div className="flex items-center justify-between py-0.5 text-slate-700">
                    <span className="text-[11.5px] text-slate-500 pl-2">↳ Central GST (CGST 50%):</span>
                    <span className="font-medium text-slate-800 font-mono">
                      {currencySymbol}{fmtDecimal(totals.gstAmount / 2, 2)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between py-0.5 text-slate-700">
                    <span className="text-[11.5px] text-slate-500 pl-2">↳ State GST (SGST 50%):</span>
                    <span className="font-medium text-slate-800 font-mono">
                      {currencySymbol}{fmtDecimal(totals.gstAmount / 2, 2)}
                    </span>
                  </div>
                </>
              ) : (
                <div className="flex items-center justify-between py-0.5 text-slate-700">
                  <span>{header.gst_type === 'IMPORT' ? 'Import IGST / Customs Duty:' : 'Integrated GST (IGST):'}</span>
                  <span className="font-bold text-slate-900 font-mono">
                    {currencySymbol}{fmtDecimal(totals.gstAmount, 2)}
                  </span>
                </div>
              )}

              <div className="flex items-center justify-between py-0.5 text-slate-700">
                <div className="flex items-center gap-1.5">
                  <span>TDS Deduction:</span>
                  <input
                    type="number"
                    step="0.05"
                    value={header.tds_pct}
                    onChange={(e) => setHeader((p) => ({ ...p, tds_pct: parseFloat(e.target.value) || 0 }))}
                    className="w-14 text-[11px] text-right border border-slate-300 rounded px-1 py-0.5 bg-white"
                  />
                  <span className="text-[10px] text-slate-400">%</span>
                </div>
                <span className="font-bold text-red-600">- {currencySymbol}{fmtDecimal(totals.tdsAmount, 2)}</span>
              </div>

              <div className="flex items-center justify-between pt-2 border-t border-brand-200 text-sm">
                <span className="font-extrabold text-brand-900">Total Payable ({selectedCurrency?.code || 'INR'}):</span>
                <span className="font-extrabold text-brand-900 text-base font-mono">
                  {currencySymbol}{fmtDecimal(totals.totalAmount, 2)}
                </span>
              </div>

              {/* Converted INR Section for Imports / Foreign Currency */}
              {(isImport || isForeignCurrency) && (
                <div className="mt-2 pt-2 border-t border-emerald-300/80 bg-emerald-100/60 -mx-2 -mb-2 p-2 rounded-b-lg space-y-1 text-emerald-950">
                  <div className="flex items-center justify-between text-[11px] font-bold">
                    <span>Equivalent Base Value (₹ INR at Rate: {exRate}):</span>
                    <span>Subtotal: ₹{fmtDecimal(totals.baseSubtotal, 2)}</span>
                  </div>
                  <div className="flex items-center justify-between text-[11px]">
                    <span>Customs / IGST in INR: ₹{fmtDecimal(totals.baseGstAmount, 2)}</span>
                    <span className="font-extrabold text-xs text-emerald-900">
                      Total INR: ₹{fmtDecimal(totals.baseTotalAmount, 2)}
                    </span>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}

export function SupplierBillsPage() {
  const [activeTab, setActiveTab] = useState<string>('ALL');
  const [modalState, setModalState] = useState<{ open: boolean; billId: number | null }>({
    open: false,
    billId: null,
  });
  const [refreshKey, setRefreshKey] = useState(0);

  const MATCH_STATUSES = ['UNMATCHED', 'PARTIAL', 'FULLY_MATCHED', 'DISCREPANCY'];
  const STATES = ['DRAFT', 'VERIFIED', 'APPROVED', 'PAID', 'DISPUTED', 'CANCELLED'];

  const typeConfig: Record<string, { label: string; tone: any }> = {
    YARN_PURCHASE: { label: 'Yarn Purchase', tone: 'indigo' },
    YARN_PROCESS: { label: 'Yarn Process', tone: 'sky' },
    FABRIC_PURCHASE: { label: 'Fabric Purchase', tone: 'purple' },
    FABRIC_PROCESS: { label: 'Fabric Process', tone: 'pink' },
    TRIMS_PURCHASE: { label: 'Trims Purchase', tone: 'amber' },
    TRIMS_PROCESS: { label: 'Trims Process', tone: 'orange' },
    IMPORT_PURCHASE: { label: 'Import Purchase', tone: 'emerald' },
    IMPORT_PROCESS: { label: 'Import Process', tone: 'teal' },
    GENERAL: { label: 'General Bill', tone: 'slate' },
  };

  return (
    <div className="space-y-4">
      {/* Category Tabs according to Bills Inward Specification */}
      <div className="bg-white border border-slate-200 rounded-xl p-2 shadow-xs flex flex-wrap items-center gap-1.5 overflow-x-auto">
        <button
          type="button"
          onClick={() => setActiveTab('ALL')}
          className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
            activeTab === 'ALL'
              ? 'bg-slate-900 text-white shadow-xs'
              : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
          }`}
        >
          All Bills Inward
        </button>
        {BILL_TYPES.map((bt) => (
          <button
            key={bt.value}
            type="button"
            onClick={() => setActiveTab(bt.value)}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-all ${
              activeTab === bt.value
                ? 'bg-brand-600 text-white shadow-xs'
                : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
            }`}
          >
            <span>{bt.icon}</span>
            <span>{bt.label}</span>
          </button>
        ))}
      </div>

      <CrudPage
        key={`${activeTab}_${refreshKey}`}
        path="supplier-bills"
        title={activeTab === 'ALL' ? 'Bills Inward (All Invoices)' : `${BILL_TYPES.find(b => b.value === activeTab)?.label ?? 'Bills Inward'}`}
        permission="PURCHASE"
        singular="Inward Bill"
        subtitle="Inward invoice processing for materials (PO/GRN) and processing job-work with detailed line-item breakdown matching legacy ERP"
        defaultSort={{ key: 'bill_date', dir: 'desc' }}
        baseParams={activeTab !== 'ALL' ? { bill_type: activeTab } : undefined}
        onNew={() => setModalState({ open: true, billId: null })}
        onRowClick={(row: any) => setModalState({ open: true, billId: row.id })}
        columns={[
          {
            key: 'bill_no',
            header: 'Bill no',
            sortable: true,
            render: (r: any) => (
              <span className="font-mono text-[12px] font-medium text-brand-700">{r.bill_no}</span>
            ),
          },
          {
            key: 'bill_type',
            header: 'Bill Type',
            render: (r: any) => {
              const cfg = typeConfig[r.bill_type] || { label: r.bill_type || 'General', tone: 'slate' };
              return <Badge tone={cfg.tone}>{cfg.label}</Badge>;
            },
          },
          { key: 'bill_date', header: 'Date', sortable: true, render: (r: any) => fmtDate(r.bill_date) },
          { key: 'supplier_name', header: 'Supplier / Processor' },
          { key: 'supplier_inv_no', header: 'Supplier Inv No' },
          {
            key: 'reference_docs',
            header: 'Linked Reference',
            render: (r: any) => {
              if (r.po_no || r.grn_no) {
                return (
                  <div className="text-[11px] font-mono leading-tight space-y-0.5">
                    {r.po_no && <div><span className="text-slate-400">PO:</span> {r.po_no}</div>}
                    {r.grn_no && <div><span className="text-slate-400">GRN:</span> {r.grn_no}</div>}
                  </div>
                );
              }
              if (r.knitting_order_no) {
                return (
                  <div className="text-[11px] font-mono text-sky-700">
                    <span className="text-slate-400">Knit Order:</span> {r.knitting_order_no}
                  </div>
                );
              }
              if (r.fabric_process_order_no) {
                return (
                  <div className="text-[11px] font-mono text-pink-700">
                    <span className="text-slate-400">Proc Order:</span> {r.fabric_process_order_no}
                  </div>
                );
              }
              return <span className="text-slate-400">—</span>;
            },
          },
          {
            key: 'total_amount',
            header: 'Total Amount',
            align: 'right',
            render: (r: any) => (
              <span className="font-medium text-brand-700">₹{fmtDecimal(r.total_amount, 2)}</span>
            ),
          },
          {
            key: 'match_status',
            header: 'Matching',
            render: (r: any) => {
              const tone =
                r.match_status === 'FULLY_MATCHED'
                  ? 'emerald'
                  : r.match_status === 'PARTIAL'
                  ? 'amber'
                  : r.match_status === 'DISCREPANCY'
                  ? 'red'
                  : 'slate';
              return <Badge tone={tone}>{humanize(r.match_status || 'UNMATCHED')}</Badge>;
            },
          },
          { key: 'status', header: 'Status', render: (r: any) => <StatusBadge value={r.status} /> },
        ]}
        filters={[
          {
            name: 'bill_type',
            label: 'Bill Category',
            options: BILL_TYPES.map((b) => ({ value: b.value, label: b.label })),
          },
          { name: 'supplier_id', label: 'Supplier', lookup: 'suppliers' },
          { name: 'po_id', label: 'PO', lookup: 'purchase-orders' },
          { name: 'grn_id', label: 'GRN', lookup: 'grns' },
          {
            name: 'match_status',
            label: 'Matching',
            options: MATCH_STATUSES.map((v) => ({ value: v, label: humanize(v) })),
          },
          { name: 'status', label: 'Status', options: STATES.map((v) => ({ value: v, label: humanize(v) })) },
        ]}
        modalSize="lg"
        fields={[]}
      />

      {/* Inward Bill Cockpit Modal */}
      {modalState.open && (
        <InwardBillModal
          open={modalState.open}
          billId={modalState.billId}
          initialType={activeTab}
          onClose={() => setModalState({ open: false, billId: null })}
          onSaved={() => {
            setModalState({ open: false, billId: null });
            setRefreshKey((k) => k + 1);
          }}
        />
      )}
    </div>
  );
}

