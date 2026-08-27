import { useState, useRef, type ChangeEvent, type DragEvent } from 'react';
import { UploadCloud, X, ZoomIn, Image as ImageIcon, Loader2, Link as LinkIcon, Check } from 'lucide-react';
import { http, ApiError } from '../../lib/api';
import { useToast } from '../../hooks/useToast';

interface ImageUploadProps {
  value?: string | null;
  onChange: (url: string | null) => void;
  disabled?: boolean;
  label?: string;
  hint?: string;
  folder?: 'styles' | 'documents' | 'attachments';
  aspectRatio?: 'square' | 'wide' | 'auto';
  className?: string;
}

export function ImageUpload({
  value,
  onChange,
  disabled = false,
  label = 'Garment Photo / Tech Sketch',
  hint = 'PNG, JPG, JPEG, WEBP or SVG up to 10MB',
  folder = 'styles',
  className = '',
}: ImageUploadProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const toast = useToast();
  const [uploading, setUploading] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [showUrlInput, setShowUrlInput] = useState(false);
  const [urlDraft, setUrlDraft] = useState('');
  const [isZoomOpen, setIsZoomOpen] = useState(false);

  const handleFile = async (file: File) => {
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      toast('Please select a valid image file (PNG, JPG, WEBP, etc.)', 'error');
      return;
    }

    if (file.size > 10 * 1024 * 1024) {
      toast('Image file size must be less than 10MB', 'error');
      return;
    }

    setUploading(true);
    try {
      const reader = new FileReader();
      reader.onload = async (e) => {
        const base64 = e.target?.result as string;
        try {
          const res = await http.post<{ data: { url: string } }>('/uploads', {
            filename: file.name,
            data: base64,
            folder,
          });
          onChange(res.data.url);
          toast('Garment image uploaded successfully');
        } catch (err) {
          toast(err instanceof ApiError ? err.message : 'Failed to upload image', 'error');
        } finally {
          setUploading(false);
        }
      };
      reader.onerror = () => {
        toast('Failed to read image file', 'error');
        setUploading(false);
      };
      reader.readAsDataURL(file);
    } catch {
      setUploading(false);
    }
  };

  const onFileInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) void handleFile(file);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (!disabled) setIsDragging(true);
  };

  const onDragLeave = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    if (disabled) return;
    const file = e.dataTransfer.files?.[0];
    if (file) void handleFile(file);
  };

  const applyUrlDraft = () => {
    if (!urlDraft.trim()) return;
    onChange(urlDraft.trim());
    setUrlDraft('');
    setShowUrlInput(false);
    toast('Image URL applied');
  };

  return (
    <div className={className}>
      {label && (
        <div className="mb-1.5 flex items-center justify-between">
          <label className="text-[12px] font-semibold text-slate-700">{label}</label>
          {!disabled && (
            <button
              type="button"
              onClick={() => setShowUrlInput((s) => !s)}
              className="inline-flex items-center gap-1 text-[11px] font-medium text-brand-600 hover:text-brand-700"
            >
              <LinkIcon size={12} />
              {showUrlInput ? 'Cancel URL' : 'Use web URL'}
            </button>
          )}
        </div>
      )}

      {showUrlInput && !disabled && (
        <div className="mb-2.5 flex items-center gap-2">
          <input
            type="url"
            placeholder="https://example.com/garment-sketch.png"
            value={urlDraft}
            onChange={(e) => setUrlDraft(e.target.value)}
            className="input text-xs py-1.5"
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                applyUrlDraft();
              }
            }}
          />
          <button
            type="button"
            onClick={applyUrlDraft}
            disabled={!urlDraft.trim()}
            className="btn-primary text-xs py-1.5 px-3"
          >
            <Check size={13} /> Apply
          </button>
        </div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/jpg,image/webp,image/gif,image/svg+xml"
        className="hidden"
        onChange={onFileInputChange}
        disabled={disabled || uploading}
      />

      {value ? (
        /* Image Preview Box */
        <div className="relative group overflow-hidden rounded-xl border border-slate-200 bg-slate-50 shadow-2xs aspect-4/3 max-h-[260px] flex items-center justify-center">
          <img
            src={value}
            alt={label}
            className="h-full w-full object-contain p-2 transition-transform duration-300 group-hover:scale-102"
          />

          {/* Action Overlay */}
          <div className="absolute inset-0 bg-slate-950/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2 backdrop-blur-[2px]">
            <button
              type="button"
              onClick={() => setIsZoomOpen(true)}
              className="rounded-lg bg-white/90 p-2 text-slate-800 hover:bg-white hover:text-brand-700 shadow-md transition"
              title="Zoom in"
            >
              <ZoomIn size={16} />
            </button>

            {!disabled && (
              <>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="rounded-lg bg-white/90 px-2.5 py-1.5 text-xs font-semibold text-slate-800 hover:bg-white hover:text-brand-700 shadow-md transition flex items-center gap-1.5"
                  title="Replace image"
                >
                  <UploadCloud size={14} /> Replace
                </button>

                <button
                  type="button"
                  onClick={() => onChange(null)}
                  className="rounded-lg bg-white/90 p-2 text-red-600 hover:bg-red-50 hover:text-red-700 shadow-md transition"
                  title="Remove image"
                >
                  <X size={16} />
                </button>
              </>
            )}
          </div>
        </div>
      ) : (
        /* Empty Dropzone Box */
        <div
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          onClick={() => !disabled && !uploading && fileInputRef.current?.click()}
          className={`relative flex flex-col items-center justify-center rounded-xl border-2 border-dashed p-6 text-center transition-all ${
            isDragging
              ? 'border-brand-500 bg-brand-50/60 ring-4 ring-brand-100'
              : 'border-slate-200/90 bg-slate-50/50 hover:bg-slate-50 hover:border-brand-300'
          } ${disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}
        >
          {uploading ? (
            <div className="flex flex-col items-center py-3">
              <Loader2 className="h-8 w-8 animate-spin text-brand-600 mb-2" />
              <p className="text-xs font-semibold text-slate-700">Uploading garment image…</p>
            </div>
          ) : (
            <div className="flex flex-col items-center py-2">
              <div className="mb-2.5 flex h-11 w-11 items-center justify-center rounded-xl bg-white border border-slate-200 text-brand-600 shadow-2xs">
                <UploadCloud size={20} />
              </div>
              <p className="text-xs font-semibold text-slate-800">
                <span className="text-brand-600 hover:underline">Click to upload</span> or drag and drop
              </p>
              <p className="mt-1 text-[11px] text-slate-400">{hint}</p>
            </div>
          )}
        </div>
      )}

      {/* Fullscreen Zoom Lightbox Modal */}
      {isZoomOpen && value && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-sm animate-in fade-in duration-200"
          onClick={() => setIsZoomOpen(false)}
        >
          <div
            className="relative max-h-[90vh] max-w-[90vw] overflow-hidden rounded-2xl bg-white p-3 shadow-2xl border border-slate-700/50"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between pb-2 border-b border-slate-100 mb-2 px-1">
              <span className="text-xs font-semibold text-slate-700">{label}</span>
              <button
                type="button"
                onClick={() => setIsZoomOpen(false)}
                className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
              >
                <X size={18} />
              </button>
            </div>
            <img
              src={value}
              alt={label}
              className="max-h-[78vh] max-w-full rounded-lg object-contain"
            />
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Thumbnail component for tables & lists with instant lightbox preview.
 */
export function ImageThumbnail({
  url,
  alt,
  title,
  size = 'md',
  onClick,
}: {
  url?: string | null;
  alt?: string;
  title?: string;
  size?: 'sm' | 'md' | 'lg';
  onClick?: () => void;
}) {
  const [zoomOpen, setZoomOpen] = useState(false);

  const sizeClasses = {
    sm: 'h-8 w-8 text-xs',
    md: 'h-11 w-11 text-sm',
    lg: 'h-14 w-14 text-base',
  }[size];

  const handleClick = (e: React.MouseEvent) => {
    if (url) {
      e.stopPropagation();
      if (onClick) {
        onClick();
      } else {
        setZoomOpen(true);
      }
    }
  };

  return (
    <>
      <div
        onClick={handleClick}
        className={`${sizeClasses} shrink-0 overflow-hidden rounded-lg border border-slate-200 bg-slate-100 flex items-center justify-center ${
          url ? 'cursor-pointer hover:ring-2 hover:ring-brand-400/50 transition shadow-2xs group relative' : ''
        }`}
        title={title || alt || 'Garment Photo'}
      >
        {url ? (
          <>
            <img src={url} alt={alt || 'Garment'} className="h-full w-full object-cover" />
            <div className="absolute inset-0 bg-slate-900/30 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
              <ZoomIn size={14} className="text-white drop-shadow" />
            </div>
          </>
        ) : (
          <ImageIcon className="h-4 w-4 text-slate-300" />
        )}
      </div>

      {zoomOpen && url && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-sm animate-in fade-in duration-200"
          onClick={() => setZoomOpen(false)}
        >
          <div
            className="relative max-h-[90vh] max-w-[90vw] overflow-hidden rounded-2xl bg-white p-3 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between pb-2 border-b border-slate-100 mb-2 px-1">
              <span className="text-xs font-semibold text-slate-700">{title || alt || 'Garment Photo'}</span>
              <button
                type="button"
                onClick={() => setZoomOpen(false)}
                className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
              >
                <X size={18} />
              </button>
            </div>
            <img
              src={url}
              alt={alt || 'Garment'}
              className="max-h-[78vh] max-w-full rounded-lg object-contain"
            />
          </div>
        </div>
      )}
    </>
  );
}
