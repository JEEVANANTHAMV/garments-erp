import { useEffect, useMemo, useState } from 'react';
import { Button, Input, Modal, LoadingBlock } from '../../components/ui';
import { api } from '../../lib/api';
import { fmtNumber } from '../../lib/format';
import { useToast } from '../../hooks/useToast';
import { useAuth } from '../../lib/auth';
import { errMsg } from './cuttingUi';

/**
 * Lay "Bundles" dialog (client voice note 04-Nov-2026): nothing is bundled
 * until the user enters the pieces per bundle and confirms. When the lay is
 * already bundled it lists the bundles, offers "Regenerate with new size"
 * while every bundle is still GENERATED (nothing moved), and lets the
 * remaining unbundled PCS be bundled on their own.
 */

const LAST_SIZE_KEY = 'lay-bundles:last-size';
const readLastSize = () => { try { return window.localStorage.getItem(LAST_SIZE_KEY) || ''; } catch { return ''; } };
const saveLastSize = (v: number) => { try { window.localStorage.setItem(LAST_SIZE_KEY, String(v)); } catch { /* storage unavailable */ } };

/** Pieces per bundle → number, or an error message. */
export function parseBundleSize(raw: string): { value: number | null; error: string | null } {
  const t = String(raw ?? '').trim();
  if (!t) return { value: null, error: 'Enter how many pieces go in one bundle' };
  if (!/^\d+$/.test(t)) return { value: null, error: 'Pieces per bundle must be a whole number' };
  const v = Number(t);
  if (v < 1) return { value: null, error: 'Pieces per bundle must be at least 1' };
  if (v > 1000) return { value: null, error: 'Pieces per bundle cannot exceed 1000' };
  return { value: v, error: null };
}

/** Bundles the generator makes for these PCS (each cut output / size is bundled on its own). */
function planFor(qtys: number[], size: number) {
  let bundles = 0; let pcs = 0; const lasts = new Set<number>();
  for (const q of qtys) {
    if (q <= 0) continue;
    bundles += Math.ceil(q / size); pcs += q;
    lasts.add(q % size || size);
  }
  return { bundles, pcs, lasts: [...lasts].sort((a, b) => a - b) };
}

export function LayBundlesModal({ lay, onClose, onDone }: { lay: any; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const { can } = useAuth();
  const canRegen = can('PRODUCTION.CREATE') && can('PRODUCTION.UPDATE');
  const [st, setSt] = useState<any>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [mode, setMode] = useState<'generate' | 'regenerate'>('generate');
  const [size, setSize] = useState<string>(readLastSize);
  const [touched, setTouched] = useState(false);
  const [part, setPart] = useState('');
  const [components, setComponents] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setLoadErr(null);
    try {
      const r = await api.get(`/lay-plans/${lay.id}/bundle-status`);
      const d = r.data.data;
      setSt(d);
      setMode(d.remaining_qty > 0 || !d.bundles.count ? 'generate' : 'regenerate');
      if (d.bundles.count) {
        setPart((p) => p || d.bundles.part_name || '');
        setComponents((c) => c || (d.bundles.components || []).join(','));
      }
    } catch (e) { setLoadErr(errMsg(e)); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [lay.id]);

  const parsed = parseBundleSize(size);
  const hasBundles = !!st?.bundles?.count;
  // generate = only the open (unbundled) PCS; regenerate = everything good on the lay
  const qtys: number[] = useMemo(() => {
    if (!st) return [];
    return mode === 'regenerate'
      ? st.outputs.map((o: any) => o.good_qty)
      : st.outputs.filter((o: any) => o.status === 'OPEN').map((o: any) => o.remaining_qty);
  }, [st, mode]);
  const plan = parsed.value ? planFor(qtys, parsed.value) : null;
  const target = mode === 'regenerate' ? st?.good_qty ?? 0 : st?.remaining_qty ?? 0;
  const valid = !!parsed.value && target > 0 && (mode === 'generate' || st?.can_regenerate) && st?.can_generate;

  const submit = async () => {
    setTouched(true);
    if (!valid || !parsed.value) return;
    setBusy(true);
    const body = {
      bundle_size: parsed.value,
      part_name: part.trim() ? part.trim().toUpperCase() : null,
      components: components.split(',').map((c) => c.trim()).filter(Boolean),
    };
    try {
      const r = mode === 'regenerate'
        ? await api.post(`/lay-plans/${lay.id}/bundles/regenerate`, body)
        : await api.post(`/lay-plans/${lay.id}/bundles`, body);
      saveLastSize(parsed.value);
      const d = r.data.data;
      toast(mode === 'regenerate'
        ? `Lay ${lay.lay_no}: ${d.cancelled_count} old bundles cancelled, ${d.count} new bundles of ${parsed.value} PCS`
        : `Lay ${lay.lay_no}: ${d.count} bundles of ${parsed.value} PCS generated`);
      onDone();
      onClose();
    } catch (e) { toast(errMsg(e), 'error'); load(); } finally { setBusy(false); }
  };

  const statusText = st ? Object.entries(st.bundles.statuses || {}).map(([k, v]) => `${v} ${k}`).join(', ') : '';

  return (
    <Modal open onClose={onClose} title={`Bundles — lay ${lay.lay_no}`} size="md"
      subtitle="Cut pieces are grouped into bundles for sewing. Enter the pieces per bundle and confirm."
      footer={<>
        <Button variant="secondary" id="lay-bundles-close" onClick={onClose}>Close</Button>
        {st && target > 0 && (mode === 'generate' || st.can_regenerate) && (
          <Button id="lay-bundles-submit" variant={mode === 'regenerate' ? 'danger' : 'primary'} loading={busy} disabled={!valid || busy}
            onClick={submit}>{mode === 'regenerate' ? 'Regenerate bundles' : 'Generate bundles'}</Button>
        )}
      </>}>
      {loadErr && <p className="text-body text-red-700" id="lay-bundles-error">{loadErr}</p>}
      {!st && !loadErr && <LoadingBlock />}
      {st && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <Stat label="Good PCS cut" value={st.good_qty} />
            <Stat label="Already bundled" value={st.bundled_qty} />
            <Stat label="Left to bundle" value={st.remaining_qty} id="lay-bundles-remaining" strong />
          </div>

          {hasBundles && (
            <div className="rounded-lg border border-surface-border p-3" id="lay-bundles-existing">
              <p className="text-body font-semibold text-ink">
                Existing bundles: {st.bundles.count} bundles · {fmtNumber(st.bundles.pcs)} PCS
                <span className="ml-2 text-small font-normal text-ink-muted">({statusText})</span>
              </p>
              <table className="mt-2 w-full text-small">
                <thead><tr className="text-left text-ink-muted"><th className="py-1">Size</th><th className="py-1 text-right">Bundles</th><th className="py-1 text-right">PCS</th><th className="py-1 text-right">PCS / bundle</th></tr></thead>
                <tbody>
                  {st.bundles.by_size.map((r: any) => (
                    <tr key={r.size_code} className="border-t border-surface-border">
                      <td className="py-1">{r.size_code}</td>
                      <td className="py-1 text-right tabular-nums">{r.bundles}</td>
                      <td className="py-1 text-right tabular-nums">{fmtNumber(r.pcs)}</td>
                      <td className="py-1 text-right tabular-nums">{r.bundle_sizes.join(' / ')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {st.can_regenerate ? (
                <p className="mt-2 text-small text-ink-muted">
                  All bundles are still GENERATED and have not moved, so they can be regenerated with a different size.
                  The old bundles are cancelled (kept for audit) — their printed tags become void.
                </p>
              ) : (
                <div className="mt-2 rounded bg-amber-50 p-2 text-small text-amber-900" id="lay-bundles-locked">
                  <b>Regenerate is locked:</b> {st.blocker_count} bundle(s) already moved or are used downstream
                  {st.blockers?.length ? <> — {st.blockers.slice(0, 5).map((b: any) => `${b.bundle_no} ${b.reason}`).join('; ')}{st.blocker_count > 5 ? ' …' : ''}</> : null}.
                  Bundles can only be regenerated before verification, issue to sewing or any other movement.
                </div>
              )}
            </div>
          )}

          {!st.can_generate && <p className="text-body text-amber-800">This lay is {st.lay_status} — bundles are made only after the lay is cut.</p>}

          {st.can_generate && hasBundles && (
            <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="What to do">
              {st.remaining_qty > 0 && (
                <Button size="sm" id="lay-bundles-mode-generate" variant={mode === 'generate' ? 'primary' : 'outline'} onClick={() => setMode('generate')}>
                  Bundle the remaining {fmtNumber(st.remaining_qty)} PCS
                </Button>
              )}
              {st.can_regenerate && canRegen && (
                <Button size="sm" id="lay-bundles-mode-regenerate" variant={mode === 'regenerate' ? 'primary' : 'outline'} onClick={() => setMode('regenerate')}>
                  Regenerate with new size
                </Button>
              )}
            </div>
          )}

          {st.can_generate && target > 0 && (mode === 'generate' || st.can_regenerate) && (
            <>
              <div className="grid gap-3 sm:grid-cols-3">
                <Input id="lay-bundles-size" label="Pieces per bundle" required type="number" inputMode="numeric" min={1} max={1000} step={1}
                  value={size} autoFocus placeholder="e.g. 20"
                  onChange={(e) => { setSize(e.target.value); setTouched(true); }}
                  error={touched && parsed.error ? parsed.error : undefined} />
                <Input id="lay-bundles-part" label="Garment part" placeholder={st.outputs[0]?.part_name || 'TOP'} value={part}
                  onChange={(e) => setPart(e.target.value.toUpperCase())} />
                <Input id="lay-bundles-components" label="Components (comma separated)" placeholder="FRONT,BACK,SLEEVE" value={components}
                  onChange={(e) => setComponents(e.target.value)} />
              </div>
              <div className="rounded-lg border border-blue-100 bg-blue-50/60 p-3 text-body text-blue-900" id="lay-bundles-preview">
                {plan ? (
                  <>
                    {mode === 'regenerate' && <>Cancels {st.bundles.count} bundles, then makes </>}
                    <b>{plan.bundles} bundles</b> × {parsed.value} PCS for {fmtNumber(plan.pcs)} PCS
                    {plan.lasts.some((l) => l !== parsed.value) && <> · last bundle {plan.lasts.filter((l) => l !== parsed.value).join(' / ')} PCS</>}
                    {qtys.filter((q) => q > 0).length > 1 && <span className="text-blue-800"> (each size is bundled separately)</span>}
                  </>
                ) : <>Enter the pieces per bundle to see how many bundles will be made.</>}
              </div>
            </>
          )}

          {st.can_generate && target === 0 && !hasBundles && <p className="text-body text-ink-muted">This lay has no good PCS to bundle.</p>}
          {st.can_generate && hasBundles && st.remaining_qty === 0 && !st.can_regenerate && (
            <p className="text-body text-ink-muted">All PCS of this lay are bundled.</p>
          )}
        </div>
      )}
    </Modal>
  );
}

function Stat({ label, value, id, strong }: { label: string; value: number; id?: string; strong?: boolean }) {
  return (
    <div className="rounded-lg border border-surface-border px-3 py-2">
      <div className="text-caption text-ink-muted">{label}</div>
      <div className={`tabular-nums text-ink ${strong ? 'text-body font-bold' : 'text-body'}`} id={id}>{fmtNumber(value)} PCS</div>
    </div>
  );
}
