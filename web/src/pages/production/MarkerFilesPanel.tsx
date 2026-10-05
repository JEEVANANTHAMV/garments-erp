import { useState } from 'react';
import { createPortal } from 'react-dom';
import { http } from '../../lib/api';
import { useToast } from '../../hooks/useToast';
import { fmtDateTime } from '../../lib/format';

/**
 * Marker picture + files on a CAD marker (client voice note 05-Oct-2026): the marker report PDF printed by the CAD
 * (Gemini / Lectra) is uploaded on the marker; its layout picture shows beside the marker (small JPEG, loaded lazily,
 * click to enlarge) and its figures fill the marker on "Apply". The CAD file itself (.ord, .dxf …) is kept for reference.
 */
export interface MarkerFile {
  id: number; marker_ref: string; kind: 'REPORT' | 'CAD' | 'IMAGE'; file_name: string; file_url: string; file_size: number | null;
  image_url: string | null; image_w: number | null; image_h: number | null; uploaded_at: string; uploaded_by_name: string | null;
  parsed: null | {
    error?: string; order_name?: string | null; model?: string | null; marker_width_in?: number | null; marker_length_m?: number | null;
    efficiency_pct?: number | null; ratio_sizes?: string[]; ratios?: number[]; sizes?: string[]; quantities?: number[];
    garments_per_marker?: number | null; panels_per_marker?: number | null; used_sqm?: number | null; wasted_sqm?: number | null; average_m?: number | null;
  };
}

export function MarkerThumb({ url, size = 28, alt = 'marker' }: { url?: string | null; size?: number; alt?: string }) {
  if (!url) return null;
  return <img src={url} alt={alt} loading="lazy" style={{ width: size, height: size }} className="rounded border border-slate-200 bg-white object-contain" />;
}

export function MarkerFilesPanel({ cadId, markerRef, files, onFiles, onApply, disabled }: {
  cadId: number | null; markerRef: string; files: MarkerFile[]; onFiles: (all: MarkerFile[]) => void;
  onApply: (p: NonNullable<MarkerFile['parsed']>) => void; disabled?: boolean;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [zoom, setZoom] = useState<string | null>(null);
  const mine = files.filter((f) => f.marker_ref === markerRef);
  const report = mine.find((f) => f.kind === 'REPORT');
  const pic = mine.find((f) => f.image_url)?.image_url ?? null;

  const upload = async (fl: File | null) => {
    if (!fl || !cadId) return;
    if (fl.size > 15 * 1024 * 1024) { toast('The file is over 15 MB', 'error'); return; }
    setBusy(true);
    try {
      const data: string = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej; r.readAsDataURL(fl); });
      const r = await http.post<{ data: MarkerFile; files: MarkerFile[] }>(`/cad-requirements/${cadId}/marker-files`, { marker_ref: markerRef, file_name: fl.name, data });
      onFiles((r as any).files ?? []);
      const f = r.data;
      if (f?.kind === 'REPORT' && f.parsed && !f.parsed.error) toast(`Marker report read: ${f.parsed.marker_length_m ?? '—'} m × ${f.parsed.marker_width_in ?? '—'}", ${f.parsed.efficiency_pct ?? '—'}% — press Apply to fill the marker`);
      else if (f?.parsed?.error) toast(f.parsed.error, 'warning');
      else toast(`${fl.name} attached to marker ${markerRef}`);
    } catch (e: any) { toast(e?.message || 'Upload failed', 'error'); } finally { setBusy(false); }
  };
  const remove = async (f: MarkerFile) => {
    if (!cadId || !window.confirm(`Remove ${f.file_name} from marker ${markerRef}?`)) return;
    try { await http.del(`/cad-requirements/${cadId}/marker-files/${f.id}`); onFiles(files.filter((x) => x.id !== f.id)); }
    catch (e: any) { toast(e?.message || 'Could not remove', 'error'); }
  };

  const p = report?.parsed;
  return (
    <div className="rounded-lg border border-indigo-100 bg-indigo-50/40 p-3" id={`marker-files-${markerRef}`}>
      <div className="flex flex-wrap items-start gap-4">
        <div className="shrink-0">
          {pic ? (
            <button type="button" onClick={() => setZoom(pic)} title="Click to enlarge" className="block" id={`marker-pic-${markerRef}`}>
              <img src={pic} alt={`Marker ${markerRef}`} loading="lazy" className="h-36 w-36 rounded border border-slate-300 bg-white object-contain" />
            </button>
          ) : (
            <div className="flex h-36 w-36 items-center justify-center rounded border border-dashed border-slate-300 bg-white p-2 text-center text-[11px] text-slate-400">
              No marker picture — upload the marker report PDF
            </div>
          )}
        </div>
        <div className="min-w-[260px] flex-1 space-y-2 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-bold text-slate-700">Marker report / CAD file</span>
            {cadId ? (
              <label className={`cursor-pointer rounded border border-indigo-300 bg-white px-2 py-1 font-semibold text-indigo-700 hover:bg-indigo-50 ${busy || disabled ? 'pointer-events-none opacity-50' : ''}`}>
                {busy ? 'Uploading…' : 'Upload PDF / CAD file'}
                <input type="file" className="hidden" id={`marker-upload-${markerRef}`} accept=".pdf,.ord,.gemx,.dxf,.plx,.hpgl,.plt,.mrk,.jpg,.jpeg,.png,.webp"
                  onChange={(e) => { void upload(e.target.files?.[0] ?? null); e.target.value = ''; }} />
              </label>
            ) : <span className="text-amber-700">Save the CAD first, then upload the marker report</span>}
          </div>
          {p && !p.error && (
            <div className="rounded border bg-white p-2" id={`marker-report-${markerRef}`}>
              <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 md:grid-cols-4">
                <span>Width <b>{p.marker_width_in ?? '—'}"</b></span>
                <span>Length <b>{p.marker_length_m ?? '—'} m</b></span>
                <span>Efficiency <b>{p.efficiency_pct ?? '—'}%</b></span>
                <span>Average <b>{p.average_m ?? '—'} m</b></span>
                <span className="col-span-2">Ratio <b>{(p.ratio_sizes ?? []).map((s, i) => `${s}:${p.ratios?.[i]}`).join(' · ') || '—'}</b></span>
                <span>Garments <b>{p.garments_per_marker ?? '—'}</b></span>
                <span>Panels <b>{p.panels_per_marker ?? '—'}</b></span>
              </div>
              {!disabled && <button type="button" id={`marker-apply-${markerRef}`} className="mt-1 rounded bg-indigo-600 px-2 py-0.5 font-semibold text-white" onClick={() => onApply(p)}>Apply to marker {markerRef}</button>}
            </div>
          )}
          {mine.length > 0 && (
            <ul className="space-y-0.5">
              {mine.map((f) => (
                <li key={f.id} className="flex items-center gap-2">
                  <span className={`rounded px-1 text-[10px] font-bold ${f.kind === 'REPORT' ? 'bg-indigo-100 text-indigo-800' : f.kind === 'IMAGE' ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-200 text-slate-700'}`}>{f.kind === 'REPORT' ? 'PDF' : f.kind}</span>
                  <a href={f.file_url} target="_blank" rel="noreferrer" className="truncate text-brand-700 hover:underline">{f.file_name}</a>
                  <span className="text-slate-400">{f.file_size ? `${Math.round(f.file_size / 1024)} KB` : ''} · {fmtDateTime(f.uploaded_at)}</span>
                  {!disabled && <button type="button" className="text-red-500" onClick={() => void remove(f)}>×</button>}
                </li>
              ))}
            </ul>
          )}
          {mine.some((f) => f.kind === 'CAD') && !pic && <p className="text-[11px] text-slate-500">A CAD file (.ord …) is kept for reference; its marker picture comes from the marker report PDF.</p>}
        </div>
      </div>
      {zoom && createPortal(
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-6" onClick={() => setZoom(null)}>
          <img src={zoom} alt={`Marker ${markerRef}`} className="max-h-full max-w-full rounded bg-white" />
        </div>, document.body)}
    </div>
  );
}
