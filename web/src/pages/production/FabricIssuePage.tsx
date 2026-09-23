import { useState, useEffect, useMemo } from 'react';
import { Card, Badge, Button, Input, DataTable, Textarea, Modal } from '../../components/ui';
import { api } from '../../lib/api';
import { fmtDate, fmtNumber, today } from '../../lib/format';
import { useToast } from '../../hooks/useToast';
import { SearchSelect, ScanInput, StatusChip, Qty, UomInput, errMsg } from './cuttingUi';

/**
 * Fabric DC (doc §6) — roll-wise issue of real roll stock to a cut order.
 * Rolls come from trx_fabric_roll (QC accepted, same fabric, available KG),
 * picked from a searchable list or scanned by roll number.
 */
export function FabricIssuePage() {
  const toast = useToast();
  const [issues, setIssues] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [plans, setPlans] = useState<any[]>([]);
  const [showNew, setShowNew] = useState(false);
  const [detail, setDetail] = useState<any>(null);

  const fetchIssues = () => {
    setLoading(true);
    api.get('/fabric-issues').then(r => setIssues(r.data.data || [])).finally(() => setLoading(false));
  };
  useEffect(() => {
    fetchIssues();
    api.get('/cutting-plans').then(r => setPlans(r.data.data || []));
  }, []);

  const openDetail = (id: number) => api.get(`/fabric-issues/${id}`).then(r => setDetail(r.data.data))
    .catch(e => toast(errMsg(e), 'error'));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Fabric DC — Issue to Cutting</h1>
          <p className="text-sm text-slate-500">Roll-wise issue from fabric roll stock. Issued KG is not consumption — actual consumption is recorded at lay execution.</p>
        </div>
        <Button onClick={() => setShowNew(true)}>+ New Fabric DC</Button>
      </div>

      <Card>
        <DataTable
          data={issues}
          loading={loading}
          columns={[
            { key: 'issue_no', header: 'DC No', sortable: true, render: (r: any) => (
              <button className="font-mono text-xs font-semibold text-brand-700 hover:underline" onClick={() => openDetail(r.id)}>{r.issue_no}</button>) },
            { key: 'issue_date', header: 'Date', sortable: true, render: (r: any) => fmtDate(r.issue_date) },
            { key: 'plan_no', header: 'Cut Order', render: (r: any) => (
              <div><span className="font-mono text-xs">{r.plan_no}</span> <StatusChip status={r.plan_status} /></div>) },
            { key: 'io_no', header: 'I/O No', render: (r: any) => <Badge variant="outline">{r.io_no}</Badge> },
            { key: 'style_code', header: 'Style' },
            { key: 'fabric_name', header: 'Fabric' },
            { key: 'route', header: 'From → To', render: (r: any) => <span className="text-xs">{r.from_location || '—'} → {r.to_location || '—'}</span> },
            { key: 'total_rolls', header: 'Rolls', align: 'right' as const, render: (r: any) => fmtNumber(r.total_rolls) },
            { key: 'total_kg', header: 'Issued', align: 'right' as const, render: (r: any) => <Qty v={r.total_kg} uom="KG" dp={3} /> },
            { key: 'consumed_kg', header: 'Consumed', align: 'right' as const, render: (r: any) => <Qty v={r.consumed_kg} uom="KG" dp={3} /> },
            { key: 'returned_kg', header: 'Returned', align: 'right' as const, render: (r: any) => <Qty v={r.returned_kg} uom="KG" dp={3} /> },
            { key: 'status', header: 'Status', render: (r: any) => <StatusChip status={r.status} /> },
          ]}
        />
      </Card>

      {showNew && (
        <NewDcModal plans={plans} onClose={() => setShowNew(false)}
          onSaved={() => { setShowNew(false); fetchIssues(); }} />
      )}
      {detail && (
        <DcDetailModal dc={detail} onClose={() => setDetail(null)}
          onChanged={() => { openDetail(detail.id); fetchIssues(); }} />
      )}
    </div>
  );
}

function NewDcModal({ plans, onClose, onSaved }: { plans: any[]; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [header, setHeader] = useState<any>({
    issue_date: today(), cutting_plan_id: '', from_location: 'FABRIC STORE', to_location: '', remarks: '',
  });
  const [stock, setStock] = useState<any[]>([]);
  const [lines, setLines] = useState<any[]>([]);
  const [saving, setSaving] = useState(false);
  const plan = plans.find(p => String(p.id) === String(header.cutting_plan_id));
  const openPlans = plans.filter(p => !['CLOSED', 'CANCELLED'].includes(p.status));

  useEffect(() => {
    setLines([]); setStock([]);
    if (!header.cutting_plan_id) return;
    api.get(`/cutting-plans/${header.cutting_plan_id}/issuable-rolls`).then(r => setStock(r.data.data || []))
      .catch(e => toast(errMsg(e), 'error'));
    setHeader((h: any) => ({ ...h, to_location: plan?.cutting_location || h.to_location }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [header.cutting_plan_id]);

  const addRoll = (roll: any) => {
    if (!roll) return;
    if (lines.some(l => l.fabric_roll_id === roll.id)) { toast(`Roll ${roll.roll_no} is already on this DC`, 'warning'); return; }
    setLines(ls => [...ls, { fabric_roll_id: roll.id, roll, issue_kg: Number(roll.available_kg) }]);
  };
  const onScan = (code: string) => {
    const roll = stock.find(r => String(r.roll_no).toUpperCase() === code.toUpperCase());
    if (!roll) { toast(`Roll ${code} is not issuable for this cut order (wrong fabric, QC not accepted, closed or nothing available)`, 'error'); return; }
    addRoll(roll);
  };
  const totalKg = lines.reduce((a, l) => a + (Number(l.issue_kg) || 0), 0);
  const overLines = lines.filter(l => Number(l.issue_kg) > Number(l.roll.available_kg) + 0.0005 || !(Number(l.issue_kg) > 0));

  const rollOptions = useMemo(() => stock
    .filter(r => !lines.some(l => l.fabric_roll_id === r.id))
    .map(r => ({
      value: r.id,
      label: `${r.roll_no} · Lot ${r.lot_no || '—'} · ${r.shade || ''}`,
      sub: `${r.fabric_name || ''} · GSM ${r.gsm ?? '—'} · Dia ${r.dia ?? '—'} · GRN ${r.grn_no || '—'} · ${r.warehouse_name || ''} ${r.location_bin || ''}`,
      right: `${fmtNumber(r.available_kg, 3)} KG avail.`,
    })), [stock, lines]);

  const save = async () => {
    if (!header.cutting_plan_id) return toast('Select a cut order', 'error');
    if (!lines.length) return toast('Add at least one roll', 'error');
    if (overLines.length) return toast(`Roll ${overLines[0].roll.roll_no}: issue KG must be > 0 and ≤ available KG`, 'error');
    setSaving(true);
    try {
      await api.post('/fabric-issues', {
        ...header, cutting_plan_id: Number(header.cutting_plan_id),
        rolls: lines.map(l => ({ fabric_roll_id: l.fabric_roll_id, issue_kg: Number(l.issue_kg) })),
      });
      toast('Fabric DC posted');
      onSaved();
    } catch (e) { toast(errMsg(e, 'Failed to issue fabric'), 'error'); } finally { setSaving(false); }
  };

  return (
    <Modal open onClose={onClose} title="New Fabric DC (roll-wise)" size="xl"
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button onClick={save} loading={saving} disabled={!lines.length}>Post DC · {fmtNumber(totalKg, 3)} KG</Button>
      </>}>
      <div className="space-y-5">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
          <SearchSelect label="Cut Order" required value={header.cutting_plan_id}
            onChange={v => setHeader({ ...header, cutting_plan_id: v })}
            options={openPlans.map(p => ({ value: p.id, label: `${p.plan_no} · ${p.io_no} · ${p.style_code || ''}`, sub: p.fabric_name, right: p.status }))} />
          <Input label="DC Date" type="date" value={header.issue_date} onChange={e => setHeader({ ...header, issue_date: e.target.value })} />
          <Input label="From Location (store)" value={header.from_location} onChange={e => setHeader({ ...header, from_location: e.target.value })} />
          <Input label="To Location (cutting)" value={header.to_location} onChange={e => setHeader({ ...header, to_location: e.target.value })} />
        </div>
        {plan && (
          <div className="flex flex-wrap gap-4 rounded-lg border border-indigo-100 bg-indigo-50/60 px-3 py-2 text-xs text-indigo-900">
            <span>I/O <b className="font-mono">{plan.io_no}</b></span>
            <span>Style <b>{plan.style_code}</b></span>
            <span>Fabric <b>{plan.fabric_name || 'any'}</b></span>
            <span>Order <b>{fmtNumber(plan.order_qty)} PCS</b></span>
            <span>Required <b>{fmtNumber(plan.fabric_req_kg, 2)} KG</b></span>
          </div>
        )}

        {header.cutting_plan_id && (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <SearchSelect label={`Pick roll from stock (${stock.length} issuable)`} value=""
              onChange={v => addRoll(stock.find(r => String(r.id) === v))} options={rollOptions}
              placeholder="Search roll no / lot / GRN…" />
            <ScanInput label="Scan roll barcode (roll no)" onScan={onScan} />
          </div>
        )}

        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-xs">
            <thead className="border-b bg-slate-50 text-left text-slate-600">
              <tr>
                <th className="p-2">Roll No</th><th className="p-2">Lot</th><th className="p-2">Shade</th>
                <th className="p-2">GSM</th><th className="p-2">Dia</th><th className="p-2">GRN</th>
                <th className="p-2 text-right">Roll Weight</th><th className="p-2 text-right">Available</th>
                <th className="p-2 text-right w-40">Issue (KG)</th><th className="w-8" />
              </tr>
            </thead>
            <tbody>
              {lines.length === 0 && (
                <tr><td colSpan={10} className="p-4 text-center text-slate-400">No rolls added — pick from stock or scan a roll barcode.</td></tr>
              )}
              {lines.map((l, i) => {
                const bad = Number(l.issue_kg) > Number(l.roll.available_kg) + 0.0005 || !(Number(l.issue_kg) > 0);
                return (
                  <tr key={l.fabric_roll_id} className="border-b">
                    <td className="p-2 font-mono font-semibold">{l.roll.roll_no}</td>
                    <td className="p-2">{l.roll.lot_no}</td><td className="p-2">{l.roll.shade}</td>
                    <td className="p-2">{l.roll.gsm}</td><td className="p-2">{l.roll.dia}</td><td className="p-2">{l.roll.grn_no}</td>
                    <td className="p-2 text-right"><Qty v={l.roll.weight_kg} uom="KG" dp={3} /></td>
                    <td className="p-2 text-right"><Qty v={l.roll.available_kg} uom="KG" dp={3} className="font-semibold text-emerald-700" /></td>
                    <td className="p-1.5">
                      <UomInput uom="KG" value={l.issue_kg} min={0}
                        onChange={v => setLines(ls => ls.map((x, j) => j === i ? { ...x, issue_kg: v } : x))} />
                      {bad && <p className="mt-0.5 text-[10px] text-red-600">Must be &gt; 0 and ≤ available</p>}
                    </td>
                    <td className="p-2 text-center">
                      <button className="font-bold text-red-500" onClick={() => setLines(ls => ls.filter((_, j) => j !== i))}>×</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
            {lines.length > 0 && (
              <tfoot><tr className="font-semibold">
                <td className="p-2" colSpan={8}>{lines.length} roll(s)</td>
                <td className="p-2 text-right"><Qty v={totalKg} uom="KG" dp={3} /></td><td />
              </tr></tfoot>
            )}
          </table>
        </div>
        <Textarea label="Remarks" rows={2} value={header.remarks} onChange={e => setHeader({ ...header, remarks: e.target.value })} />
      </div>
    </Modal>
  );
}

function DcDetailModal({ dc, onClose, onChanged }: { dc: any; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const [ret, setRet] = useState<Record<number, { kg: string; reason: string }>>({});
  const [saving, setSaving] = useState(false);
  const closed = ['CLOSED', 'CANCELLED'].includes(dc.plan_status);

  const submitReturn = async () => {
    const rolls = Object.entries(ret).filter(([, v]) => Number(v.kg) > 0)
      .map(([id, v]) => ({ fabric_issue_roll_id: Number(id), return_kg: Number(v.kg), reason: v.reason || null }));
    if (!rolls.length) return toast('Enter the KG to return on at least one roll', 'error');
    setSaving(true);
    try {
      await api.post(`/fabric-issues/${dc.id}/returns`, { return_date: today(), to_location: dc.from_location, rolls });
      toast('Fabric returned to store');
      setRet({});
      onChanged();
    } catch (e) { toast(errMsg(e), 'error'); } finally { setSaving(false); }
  };

  return (
    <Modal open onClose={onClose} title={`Fabric DC ${dc.issue_no}`} size="xl"
      footer={<>
        <Button variant="ghost" onClick={onClose}>Close</Button>
        {!closed && <Button onClick={submitReturn} loading={saving}>Post Fabric Return</Button>}
      </>}>
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3 text-xs md:grid-cols-5">
          <div><p className="text-slate-400">Cut Order</p><p className="font-mono font-semibold">{dc.plan_no}</p><StatusChip status={dc.plan_status} /></div>
          <div><p className="text-slate-400">I/O · Style</p><p className="font-semibold">{dc.io_no} · {dc.style_code}</p></div>
          <div><p className="text-slate-400">Fabric</p><p className="font-semibold">{dc.fabric_name}</p></div>
          <div><p className="text-slate-400">From → To</p><p className="font-semibold">{dc.from_location || '—'} → {dc.to_location || '—'}</p></div>
          <div><p className="text-slate-400">Date</p><p className="font-semibold">{fmtDate(dc.issue_date)}</p></div>
        </div>
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-xs">
            <thead className="border-b bg-slate-50 text-left text-slate-600">
              <tr>
                <th className="p-2">Roll</th><th className="p-2">Lot / Shade</th><th className="p-2">GRN</th>
                <th className="p-2 text-right">Issued</th><th className="p-2 text-right">Consumed</th>
                <th className="p-2 text-right">Returned</th><th className="p-2 text-right">With cutting</th>
                <th className="p-2">Status</th>{!closed && <th className="p-2 w-56">Return now</th>}
              </tr>
            </thead>
            <tbody>
              {dc.rolls.map((r: any) => (
                <tr key={r.id} className="border-b">
                  <td className="p-2 font-mono font-semibold">{r.roll_no}{r.is_legacy ? <span className="ml-1 text-[10px] text-amber-600">(free-text)</span> : null}</td>
                  <td className="p-2">{r.lot_no} / {r.shade}</td>
                  <td className="p-2">{r.grn_no || '—'}</td>
                  <td className="p-2 text-right"><Qty v={r.issue_kg} uom="KG" dp={3} /></td>
                  <td className="p-2 text-right"><Qty v={r.consumed_kg} uom="KG" dp={3} /></td>
                  <td className="p-2 text-right"><Qty v={r.returned_kg} uom="KG" dp={3} /></td>
                  <td className="p-2 text-right font-semibold"><Qty v={r.remaining_kg} uom="KG" dp={3} /></td>
                  <td className="p-2"><StatusChip status={r.roll_status} /></td>
                  {!closed && (
                    <td className="p-1.5">
                      {r.roll_status !== 'CLOSED' && Number(r.remaining_kg) > 0 ? (
                        <div className="flex gap-1">
                          <UomInput uom="KG" value={ret[r.id]?.kg ?? ''} min={0} className="w-28"
                            onChange={v => setRet(s => ({ ...s, [r.id]: { kg: v, reason: s[r.id]?.reason ?? '' } }))} />
                          <input className="input" placeholder="Reason" value={ret[r.id]?.reason ?? ''}
                            onChange={e => setRet(s => ({ ...s, [r.id]: { kg: s[r.id]?.kg ?? '', reason: e.target.value } }))} />
                        </div>
                      ) : <span className="text-slate-400">—</span>}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {dc.returns?.length > 0 && (
          <div>
            <h4 className="mb-1 text-xs font-semibold text-slate-600">Returns</h4>
            <ul className="space-y-0.5 text-xs text-slate-600">
              {dc.returns.map((r: any) => (
                <li key={r.id}><span className="font-mono">{r.return_no}</span> · {fmtDate(r.return_date)} · <Qty v={r.return_kg} uom="KG" dp={3} /> · {r.reason || '—'} · {r.created_by_name}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Modal>
  );
}
