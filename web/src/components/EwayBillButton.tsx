import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { Truck } from 'lucide-react';
import clsx from 'clsx';
import { http } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Badge, Button } from './ui';

/** Documents that move goods on the road and can carry a GST e-way bill. */
export type EwbSourceType = 'DISPATCH' | 'PROCESS_DC' | 'PURCHASE_RETURN' | 'GATE_OUTWARD' | 'STOCK_DELIVERY' | 'COMMERCIAL_INVOICE';

export interface EwbLink {
  id: number; doc_no: string; status: string; ewb_no: string | null; valid_upto: string | null;
  view_status: 'DRAFT' | 'ACTIVE' | 'PART_A' | 'EXPIRED';
}

const VIEW: Record<EwbLink['view_status'], { label: string; tone: string }> = {
  DRAFT:   { label: 'Draft',       tone: 'slate' },
  ACTIVE:  { label: 'Active',      tone: 'green' },
  PART_A:  { label: 'Part A only', tone: 'amber' },
  EXPIRED: { label: 'Expired',     tone: 'red' },
};

/** "22 Oct 23:59" */
const fmtValidity = (v: string | null) => {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  const day = d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
  return `${day} ${time}`;
};

/**
 * The live (non-cancelled) e-way bill made from a document, or null.
 * Shared query key, so a page and its EwayBillButton make one request.
 */
export function useEwayBill(sourceType: EwbSourceType, sourceId: number | string | null | undefined) {
  const { can } = useAuth();
  const id = Number(sourceId);
  return useQuery({
    queryKey: ['eway-bills', 'by-source', sourceType, id],
    queryFn: async () => (await http.get<{ data: EwbLink | null }>('/eway-bills/by-source', { type: sourceType, id })).data,
    enabled: id > 0 && can('EWAY.VIEW'),
  });
}

/**
 * E-way bill action for a saved road-movement document: "Generate e-way bill" when none exists,
 * else the EWB number (doc no while still a draft) with its status, linking to the editor.
 * `compact` is the small icon-and-text variant for table rows. Renders nothing for an unsaved document.
 */
export function EwayBillButton({ sourceType, sourceId, compact }: {
  sourceType: EwbSourceType; sourceId: number | string | null | undefined; compact?: boolean;
}) {
  const { can } = useAuth();
  const nav = useNavigate();
  const id = Number(sourceId);
  const { data: ewb, isLoading } = useEwayBill(sourceType, sourceId);

  if (!(id > 0) || !can('EWAY.VIEW')) return null;
  // Table rows are often clickable: keep the click on the button.
  const stop = (e: React.MouseEvent) => e.stopPropagation();

  if (isLoading) {
    return compact
      ? <span className="text-caption text-ink-muted" data-ewb-source={sourceType}>…</span>
      : null;
  }

  if (!ewb) {
    if (!can('EWAY.CREATE')) {
      return compact ? <span className="text-caption text-ink-muted" data-ewb-source={sourceType}>—</span> : null;
    }
    const go = (e: React.MouseEvent) => {
      e.stopPropagation();
      nav(`/logistics/eway-bills/new?source_type=${sourceType}&source_id=${id}`);
    };
    return compact ? (
      <button type="button" id={`ewb-btn-${sourceType.toLowerCase()}-${id}`} data-ewb-source={sourceType} onClick={go}
        title="Generate e-way bill"
        className="inline-flex items-center gap-1 whitespace-nowrap text-caption font-medium text-brand-600 hover:text-brand-700 hover:underline">
        <Truck size={12} /> Generate
      </button>
    ) : (
      <Button type="button" variant="outline" id="ewb-btn" data-ewb-source={sourceType} onClick={go}
        className="inline-flex items-center gap-1.5">
        <Truck size={14} /> Generate e-way bill
      </Button>
    );
  }

  const v = VIEW[ewb.view_status] ?? VIEW.DRAFT;
  const expired = ewb.view_status === 'EXPIRED';
  const label = ewb.ewb_no ? `EWB ${ewb.ewb_no}` : ewb.doc_no;
  const validity = ewb.ewb_no && ewb.valid_upto && ewb.view_status !== 'DRAFT'
    ? `${expired ? 'expired' : 'valid till'} ${fmtValidity(ewb.valid_upto)}` : '';
  const title = [label, v.label, validity].filter(Boolean).join(' · ');

  return compact ? (
    <Link to={`/logistics/eway-bills/${ewb.id}`} id={`ewb-btn-${sourceType.toLowerCase()}-${id}`} data-ewb-source={sourceType}
      data-ewb-status={ewb.view_status} onClick={stop} title={title}
      className={clsx('inline-flex items-center gap-1 whitespace-nowrap text-caption font-medium hover:underline',
        expired ? 'text-red-600' : 'text-ink')}>
      <Truck size={12} /> {ewb.ewb_no ?? ewb.doc_no}
      <Badge tone={v.tone} className="!px-1.5 !py-0 !text-micro">{v.label}</Badge>
    </Link>
  ) : (
    <Link to={`/logistics/eway-bills/${ewb.id}`} id="ewb-btn" data-ewb-source={sourceType}
      data-ewb-status={ewb.view_status} onClick={stop} title="Open e-way bill"
      className={clsx('inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors',
        expired ? 'border-red-300 bg-red-50 text-red-700 hover:bg-red-100' : 'border-surface-input bg-white text-ink hover:bg-surface-muted')}>
      <Truck size={14} />
      <span>{label}</span>
      <Badge tone={v.tone}>{v.label}</Badge>
      {validity && <span className={expired ? 'text-red-600' : 'text-ink-secondary'}>{validity}</span>}
    </Link>
  );
}
