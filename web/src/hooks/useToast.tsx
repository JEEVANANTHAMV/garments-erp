import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { CheckCircle2, AlertCircle, Info, X } from 'lucide-react';

type Kind = 'success' | 'error' | 'info';
interface Toast { id: number; kind: Kind; message: string; }

const ToastCtx = createContext<{
  toast: (message: string, kind?: Kind) => void;
} | null>(null);

let seq = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);

  const toast = useCallback((message: string, kind: Kind = 'success') => {
    const id = ++seq;
    setItems((s) => [...s, { id, kind, message }]);
    setTimeout(() => setItems((s) => s.filter((t) => t.id !== id)), 4500);
  }, []);

  const dismiss = (id: number) => setItems((s) => s.filter((t) => t.id !== id));

  const style: Record<Kind, string> = {
    success: 'border-emerald-200 bg-emerald-50 text-emerald-900',
    error: 'border-red-200 bg-red-50 text-red-900',
    info: 'border-blue-200 bg-blue-50 text-blue-900',
  };
  const Icon = { success: CheckCircle2, error: AlertCircle, info: Info };

  return (
    <ToastCtx.Provider value={{ toast }}>
      {children}
      <div className="fixed bottom-5 right-5 z-[100] flex w-[360px] max-w-[calc(100vw-2.5rem)] flex-col gap-2">
        {items.map((t) => {
          const I = Icon[t.kind];
          return (
            <div key={t.id}
              className={`animate-fade-in flex items-start gap-2.5 rounded-lg border px-3.5 py-3 shadow-popover ${style[t.kind]}`}
              role="status">
              <I size={17} className="mt-px shrink-0" />
              <p className="flex-1 text-[13px] leading-snug">{t.message}</p>
              <button onClick={() => dismiss(t.id)} className="shrink-0 opacity-50 hover:opacity-100"
                aria-label="Dismiss">
                <X size={15} />
              </button>
            </div>
          );
        })}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast() {
  const c = useContext(ToastCtx);
  if (!c) throw new Error('useToast must be used inside <ToastProvider>');
  return c.toast;
}
