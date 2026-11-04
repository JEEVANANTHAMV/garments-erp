/**
 * Photo from the device camera or a file (visitor photo at the gate, driver delivery proof) — client voice notes 04-Nov-2026.
 *
 * Live camera: navigator.mediaDevices.getUserMedia → <video> → canvas snapshot → retake / use. Browsers only allow the
 * camera on https or localhost; on the plain-http server the "Take / choose photo" file input is used instead — on a
 * phone it opens the camera directly (capture attribute). Every photo is scaled to ≤ 1280 px and saved as JPEG before
 * upload (/api/uploads, folder "attachments").
 */
import { useEffect, useRef, useState } from 'react';
import { Camera, ImagePlus, RefreshCw, Check, X, Loader2 } from 'lucide-react';
import { http, ApiError } from '../lib/api';
import { Modal } from './ui';
import { ImageThumbnail } from './ui/ImageUpload';

const MAX_SIDE = 1280;

/** Scale an image source to ≤ 1280 px and encode as JPEG (quality 0.82). */
function toJpeg(src: CanvasImageSource, w: number, h: number): string {
  const k = Math.min(1, MAX_SIDE / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.round(w * k); c.height = Math.round(h * k);
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('Canvas not available');
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.82);
}
async function fileToJpeg(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('Not a readable image')); i.src = url; });
    return toJpeg(img, img.naturalWidth, img.naturalHeight);
  } finally { URL.revokeObjectURL(url); }
}

export const cameraAvailable = () => typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && (typeof window === 'undefined' || window.isSecureContext);

export function PhotoCapture({ value, onChange, label = 'Photo', facing = 'user', filePrefix = 'photo', disabled, required, error }: {
  value?: string | null; onChange: (url: string | null) => void; label?: string; facing?: 'user' | 'environment';
  filePrefix?: string; disabled?: boolean; required?: boolean; error?: string;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [camOpen, setCamOpen] = useState(false);
  const canCam = cameraAvailable();

  const upload = async (dataUrl: string) => {
    setBusy(true); setErr('');
    try {
      if (dataUrl.length > 4 * 1024 * 1024) throw new Error('Photo is too large even after compression');
      const res = await http.post<{ data: { url: string } }>('/uploads', { filename: `${filePrefix}_${Date.now()}.jpg`, data: dataUrl, folder: 'attachments' });
      onChange(res.data.url);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : e instanceof Error ? e.message : 'Upload failed — try again');
    } finally { setBusy(false); }
  };
  const onFile = async (f?: File) => {
    if (!f) return;
    if (!f.type.startsWith('image/')) { setErr('Choose an image file'); return; }
    if (f.size > 20 * 1024 * 1024) { setErr('Image must be under 20 MB'); return; }
    try { await upload(await fileToJpeg(f)); } catch (e) { setErr(e instanceof Error ? e.message : 'Could not read the image'); }
    if (fileRef.current) fileRef.current.value = '';
  };

  return (
    <div data-photo-capture>
      <label className="label">{label}{required && <span className="ml-0.5 text-red-500">*</span>}</label>
      <div className="flex flex-wrap items-center gap-2">
        {value ? <ImageThumbnail url={value} title={label} size="lg" /> : null}
        {canCam && (
          <button type="button" className="btn-secondary btn-sm" disabled={disabled || busy} onClick={() => setCamOpen(true)} data-action="open-camera">
            <Camera size={14} /> {value ? 'Retake' : 'Capture photo'}
          </button>
        )}
        <button type="button" className="btn-secondary btn-sm" disabled={disabled || busy} onClick={() => fileRef.current?.click()} data-action="photo-file">
          {busy ? <Loader2 size={14} className="animate-spin" /> : <ImagePlus size={14} />} {canCam ? 'Upload file' : value ? 'Retake / change' : 'Take / choose photo'}
        </button>
        {value && !disabled && <button type="button" className="btn-ghost btn-sm text-red-700" onClick={() => onChange(null)} data-action="remove-photo"><X size={14} /> Remove</button>}
        <input ref={fileRef} type="file" accept="image/*" capture={facing} className="hidden" onChange={(e) => void onFile(e.target.files?.[0])} data-field="photo-file" />
      </div>
      {!canCam && <p className="mt-1 text-caption text-ink-secondary" data-camera-hint>Live camera needs a secure (https) connection — “Take / choose photo” opens the phone camera or picks a saved photo.</p>}
      {(err || error) && <p className="help-error">{err || error}</p>}
      {camOpen && <CameraDialog facing={facing} onClose={() => setCamOpen(false)} onUse={(d) => { setCamOpen(false); void upload(d); }} onFail={(m) => { setCamOpen(false); setErr(m); }} />}
    </div>
  );
}

function CameraDialog({ facing, onClose, onUse, onFail }: { facing: 'user' | 'environment'; onClose: () => void; onUse: (dataUrl: string) => void; onFail: (msg: string) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const [shot, setShot] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const failRef = useRef(onFail);
  failRef.current = onFail;
  useEffect(() => {
    let alive = true;
    navigator.mediaDevices.getUserMedia({ video: { facingMode: facing, width: { ideal: 1280 } }, audio: false })
      .then((s) => {
        if (!alive) { s.getTracks().forEach((t) => t.stop()); return; }
        stream.current = s;
        if (video.current) { video.current.srcObject = s; void video.current.play().then(() => setReady(true)).catch(() => setReady(true)); }
      })
      .catch((e: Error) => failRef.current(e?.name === 'NotAllowedError' ? 'Camera permission was refused — allow the camera or use "Upload file"' : 'No camera found — use "Upload file"'));
    return () => { alive = false; stream.current?.getTracks().forEach((t) => t.stop()); };
  }, [facing]);
  const snap = () => {
    const v = video.current; if (!v || !v.videoWidth) return;
    setShot(toJpeg(v, v.videoWidth, v.videoHeight));
  };
  return (
    <Modal open onClose={onClose} title="Capture photo" size="md"
      footer={shot
        ? <><button className="btn-secondary" onClick={() => setShot(null)} data-action="retake"><RefreshCw size={14} /> Retake</button><button className="btn-primary" onClick={() => onUse(shot)} data-action="use-photo"><Check size={14} /> Use photo</button></>
        : <><button className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={!ready} onClick={snap} data-action="snap"><Camera size={14} /> Capture</button></>}>
      <div className="flex justify-center rounded-lg bg-surface-muted p-2">
        {shot ? <img src={shot} alt="Captured" className="max-h-[60vh] rounded" /> : <video ref={video} playsInline muted className="max-h-[60vh] w-full rounded" />}
      </div>
    </Modal>
  );
}
