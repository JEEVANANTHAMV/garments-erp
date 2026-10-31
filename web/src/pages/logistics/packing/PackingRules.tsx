import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Settings2 } from 'lucide-react';
import { PageHeader, Card, Button, Input, Select, Modal, FormSection, LoadingBlock, EmptyState, Checkbox } from '../../../components/ui';
import { JobSelect } from '../../../components/JobSelect';
import { http } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { useToast } from '../../../hooks/useToast';
import { useLookup } from '../../../hooks/useLookup';
import { fmtDate } from '../../../lib/format';
import { PackingNav, usePackingMeta, errMsg, n, type Rule } from './packingShared';

/** The three packing units the client uses (call 16-Oct-2026). */
export const UNIT_LABEL: Record<string, string> = { SINGLE: 'Single piece', SET: 'Set (TOP + BOTTOM)', MASTER_POLYBAG: 'Master polybag' };
export const UNIT_OPTIONS = [
  { value: 'SINGLE', label: 'Single piece — one garment per polybag (also TOP / BOTTOM packed separately)' },
  { value: 'SET', label: 'Set — all parts of a set (e.g. TOP + BOTTOM) of the same size in one polybag' },
  { value: 'MASTER_POLYBAG', label: 'Master polybag — N individually bagged pieces in one big bag' },
];

/** Packing rules master (doc §4): priority PO → style → buyer → company default; used rules are deactivated, never deleted. */
export function PackingRulesPage() {
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const rules = useQuery({ queryKey: ['packing-rules'], queryFn: async () => (await http.get<{ data: Rule[] }>('/packing/rules')).data });
  const [editing, setEditing] = useState<Partial<Rule> | null>(null);
  const toggle = async (r: Rule) => {
    try { await http.post(`/packing/rules/${r.id}/active`, { is_active: n(r.is_active) ? 0 : 1 }); qc.invalidateQueries({ queryKey: ['packing-rules'] }); toast(n(r.is_active) ? 'Rule deactivated' : 'Rule activated'); } catch (e) { toast(errMsg(e), 'error'); }
  };
  const scope = (r: Rule) => (r.so_id ? `PO / job ${r.job_no}${r.buyer_po_no ? ` (PO ${r.buyer_po_no})` : ''}` : r.style_id ? `Style ${r.style_code}` : r.buyer_id ? `Buyer ${r.buyer_name}` : 'Company default');
  return (
    <div>
      <PageHeader title="Packing rules" breadcrumb={['Logistics', 'Packing']}
        subtitle="Buyer / style / PO packing configuration. The most specific active rule wins (PO → style → buyer → company default) and is snapshotted into each packing order."
        actions={can('PACKING.CREATE') && <Button id="new-rule" onClick={() => setEditing({ packing_mode: 'INDIVIDUAL_PIECE', packing_unit: 'SINGLE', pieces_per_polybag: 1, standard_pieces_per_carton: 50, allow_partial_carton: 1, is_active: 1 })}><Plus size={15} />New rule</Button>} />
      <PackingNav active="/logistics/packing/rules" />
      <Card>
        {rules.isLoading ? <LoadingBlock /> : !rules.data?.length ? <EmptyState title="No packing rules" message="Add a company default rule first (no buyer / style / PO)." /> : (
          <table className="w-full text-body" id="rules-table">
            <thead><tr><th className="th">Code</th><th className="th">Name</th><th className="th">Applies to</th><th className="th">Mode</th><th className="th text-right">Pcs / bag</th><th className="th text-right">Pcs / carton</th>
              <th className="th">Mixing</th><th className="th">Packaging</th><th className="th">Valid</th><th className="th">Used</th><th className="th" /></tr></thead>
            <tbody>{rules.data.map((r) => (
              <tr key={r.id} className={n(r.is_active) ? '' : 'opacity-50'}>
                <td className="td tabular-nums">{r.rule_code} <span className="text-slate-400">r{r.revision}</span></td><td className="td">{r.rule_name}</td><td className="td">{scope(r)}</td>
                <td className="td">{UNIT_LABEL[r.packing_unit ?? 'SINGLE']}{r.packing_unit === 'MASTER_POLYBAG' && r.pieces_per_master_bag ? ` (${r.pieces_per_master_bag} / bag)` : ''}
                  <div className="text-caption text-slate-500">{r.packing_mode === 'INDIVIDUAL_PIECE' ? 'bag each piece' : 'bundle / qty'}</div></td><td className="td text-right">{r.pieces_per_polybag}</td><td className="td text-right">{r.standard_pieces_per_carton}</td>
                <td className="td">{[n(r.allow_mixed_sizes) && 'sizes', n(r.allow_mixed_colours) && 'colours'].filter(Boolean).join(' + ') || 'solid'}{n(r.allow_partial_carton) ? ' · partial' : ''}{n(r.allow_overpack) ? ' · overpack' : ''}</td>
                <td className="td">{r.polybag_trim_name ?? '—'} / {r.carton_trim_name ?? '—'}</td>
                <td className="td">{r.effective_from ? fmtDate(r.effective_from) : '…'} – {r.effective_to ? fmtDate(r.effective_to) : '…'}</td>
                <td className="td">{n(r.used_by) ? `${r.used_by} order(s)` : '—'}
                  {n(r.open_old_rev) ? <div className="text-caption text-amber-700" data-old-rev={r.id} title="Open packing orders made before the last change keep the older revision — open the order → Apply latest rule">{r.open_old_rev} open on an older revision</div> : null}</td>
                <td className="td whitespace-nowrap text-right">
                  {can('PACKING.UPDATE') && <button className="mr-2 text-brand-700 hover:underline" onClick={() => setEditing(r)}>Edit</button>}
                  {can('PACKING.UPDATE') && <button className="text-slate-600 hover:underline" onClick={() => toggle(r)}>{n(r.is_active) ? 'Deactivate' : 'Activate'}</button>}
                </td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </Card>
      {editing && <RuleModal rule={editing} onClose={() => setEditing(null)} onSaved={(row) => {
        setEditing(null); qc.invalidateQueries({ queryKey: ['packing-rules'] });
        toast(n(row?.open_old_rev)
          ? `Saved as revision ${row.revision}. ${row.open_old_rev} open packing order(s) keep the older revision — open the order and click "Apply latest rule" (only before polybags / cartons)`
          : `Packing rule saved${row?.revision ? ` (revision ${row.revision}) — new packing orders use it` : ''}`);
      }} />}
    </div>
  );
}

export function RuleModal({ rule, onClose, onSaved }: { rule: Partial<Rule>; onClose: () => void; onSaved: (row?: any) => void }) {
  const meta = usePackingMeta();
  const buyers = useLookup('buyers');
  const styles = useLookup('styles');
  const [f, setF] = useState<any>({ ...rule, effective_from: rule.effective_from ? String(rule.effective_from).slice(0, 10) : '', effective_to: rule.effective_to ? String(rule.effective_to).slice(0, 10) : '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const set = (k: string) => (e: any) => setF((s: any) => ({ ...s, [k]: e.target.value }));
  const flag = (k: string) => <Checkbox label={({ allow_mixed_sizes: 'Mixed sizes in a carton', allow_mixed_colours: 'Mixed colours in a carton', allow_partial_carton: 'Partial cartons', allow_overpack: 'Overpack above capacity', is_active: 'Active' } as any)[k]}
    checked={!!n(f[k])} onChange={(v: boolean) => setF((s: any) => ({ ...s, [k]: v ? 1 : 0 }))} />;
  const save = async () => {
    setBusy(true); setErr('');
    const id = (v: unknown) => (v ? Number(v) : null);
    const body = { ...f, buyer_id: id(f.buyer_id), style_id: id(f.style_id), so_id: id(f.so_id), polybag_trim_id: id(f.polybag_trim_id), carton_trim_id: id(f.carton_trim_id),
      packing_unit: f.packing_unit ?? 'SINGLE', master_bag_trim_id: id(f.master_bag_trim_id), pieces_per_master_bag: f.pieces_per_master_bag ? Number(f.pieces_per_master_bag) : null,
      effective_from: f.effective_from || null, effective_to: f.effective_to || null };
    try {
      const r = rule.id ? await http.put<{ data: any }>(`/packing/rules/${rule.id}`, body) : await http.post<{ data: any }>('/packing/rules', body);
      onSaved(r.data);
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  const trims = meta.data?.trims ?? [];
  return (
    <Modal open onClose={onClose} size="lg" icon={<Settings2 size={16} />} title={rule.id ? `Edit packing rule ${rule.rule_code}` : 'New packing rule'}
      subtitle={rule.id && n(rule.used_by)
        ? 'Saving makes a new revision. New packing orders use it; orders already made keep their copy until you open them and click "Apply latest rule" (only before polybags / cartons).'
        : 'Leave buyer / style / PO blank for the company default.'}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button id="save-rule" loading={busy} onClick={save}>Save rule</Button></>}>
      {err && <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-body text-red-700">{err}</div>}
      <FormSection title="Rule" cols={4}>
        <Input id="rule-name" label="Rule name" required className="sm:col-span-2" value={f.rule_name ?? ''} onChange={set('rule_name')} />
        <Input label="Effective from" type="date" value={f.effective_from} onChange={set('effective_from')} />
        <Input label="Effective to" type="date" value={f.effective_to} onChange={set('effective_to')} />
      </FormSection>
      <FormSection title="Applies to" cols={3} description="Priority: PO / job → style → buyer → company default">
        <Select label="Buyer" value={f.buyer_id ?? ''} onChange={set('buyer_id')} placeholder="Any buyer" options={(buyers.data ?? []).map((b) => ({ value: b.id, label: b.label }))} />
        <Select label="Style" value={f.style_id ?? ''} onChange={set('style_id')} placeholder="Any style" options={(styles.data ?? []).map((s) => ({ value: s.id, label: `${s.code} · ${s.label}` }))} />
        <JobSelect label="PO / job" by="so_id" placeholder="Any PO" value={f.so_id ?? ''} onPick={(j) => setF((s: any) => ({ ...s, so_id: j?.id ?? null, buyer_id: j?.buyer_id ?? s.buyer_id }))} />
      </FormSection>
      <FormSection title="Packing" cols={4}>
        <Select id="rule-unit" label="Packing unit" className="sm:col-span-4" value={f.packing_unit ?? 'SINGLE'} onChange={set('packing_unit')} options={UNIT_OPTIONS} />
        {(f.packing_unit ?? 'SINGLE') === 'MASTER_POLYBAG' && <>
          <Input id="rule-ppmb" label="Pieces per master polybag" required inputMode="numeric" value={f.pieces_per_master_bag ?? ''} onChange={set('pieces_per_master_bag')}
            hint="Default — the buyer can give another count per order" />
          <Select id="rule-master-bag" label="Master polybag item" className="sm:col-span-3" value={f.master_bag_trim_id ?? ''} onChange={set('master_bag_trim_id')} placeholder="— Master polybag (trims master) —"
            options={trims.filter((t) => t.trim_type === 'POLYBAG').map((t) => ({ value: t.id, label: `${t.trim_code} · ${t.trim_name}` }))} />
        </>}
        <Select id="rule-mode" label="Bagging" value={f.packing_mode} onChange={set('packing_mode')}
          options={[{ value: 'INDIVIDUAL_PIECE', label: 'Bag each piece (polybag entry first)' }, { value: 'BUNDLE_QUANTITY', label: 'By quantity (polybag entry optional)' }]} />
        <Input id="rule-ppp" label="Pieces per polybag" required inputMode="numeric" value={f.pieces_per_polybag ?? ''} onChange={set('pieces_per_polybag')} />
        <Input id="rule-ppc" label="Pieces per carton" required inputMode="numeric" value={f.standard_pieces_per_carton ?? ''} onChange={set('standard_pieces_per_carton')} />
        <Input label="Label template" value={f.label_template ?? ''} onChange={set('label_template')} placeholder="Standard" />
        <Select id="rule-polybag" label="Polybag item" className="sm:col-span-2" value={f.polybag_trim_id ?? ''} onChange={set('polybag_trim_id')} placeholder="— Polybag (trims master) —"
          options={trims.filter((t) => t.trim_type === 'POLYBAG').map((t) => ({ value: t.id, label: `${t.trim_code} · ${t.trim_name}` }))} />
        <Select id="rule-carton" label="Carton item" className="sm:col-span-2" value={f.carton_trim_id ?? ''} onChange={set('carton_trim_id')} placeholder="— Carton (trims master) —"
          options={trims.filter((t) => t.trim_type === 'CARTON').map((t) => ({ value: t.id, label: `${t.trim_code} · ${t.trim_name}` }))} />
      </FormSection>
      <FormSection title="Buyer policy" cols={3}>
        {flag('allow_mixed_sizes')}{flag('allow_mixed_colours')}{flag('allow_partial_carton')}{flag('allow_overpack')}{flag('is_active')}
      </FormSection>
      <FormSection title="Remarks" cols={1}><Input label="Remarks" value={f.remarks ?? ''} onChange={set('remarks')} /></FormSection>
    </Modal>
  );
}
