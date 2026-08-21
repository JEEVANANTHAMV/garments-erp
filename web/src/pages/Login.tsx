import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { Factory, AlertCircle, Eye, EyeOff } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { ApiError } from '../lib/api';
import { Spinner } from '../components/ui';

const DEMO_ACCOUNTS = [
  ['admin', 'Super Administrator'],
  ['merch', 'Merchandiser'],
  ['prod', 'Production Manager'],
  ['qc', 'QC Inspector'],
  ['store', 'Store Keeper'],
  ['purchase', 'Purchase Officer'],
  ['export', 'Export Executive'],
  ['accounts', 'Accountant'],
];

export default function Login() {
  const { user, login, loading } = useAuth();
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('Admin@123');
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (loading) {
    return <div className="grid h-screen place-items-center"><Spinner size={26} className="text-brand-600" /></div>;
  }
  if (user) return <Navigate to="/" replace />;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null); setBusy(true);
    try {
      await login(username.trim(), password);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to sign in. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen">
      {/* Brand panel */}
      <div className="relative hidden w-1/2 flex-col justify-between bg-slate-900 p-12 text-white lg:flex">
        <div className="absolute inset-0 opacity-[0.07]"
          style={{ backgroundImage: 'radial-gradient(circle at 1px 1px, white 1px, transparent 0)', backgroundSize: '28px 28px' }} />
        <div className="relative flex items-center gap-3">
          <div className="grid h-11 w-11 place-items-center rounded-xl bg-brand-600">
            <Factory size={22} />
          </div>
          <div>
            <p className="text-[15px] font-semibold">Garment Manufacturing ERP</p>
            <p className="text-xs text-slate-400">Tiruppur Export House Edition</p>
          </div>
        </div>

        <div className="relative">
          <h2 className="text-3xl font-semibold leading-tight">
            From buyer enquiry<br />to bill of lading.
          </h2>
          <p className="mt-4 max-w-md text-[14px] leading-relaxed text-slate-400">
            One connected system across sampling, costing, orders, MRP, procurement,
            production, quality, packing, export documentation and finance.
          </p>
          <div className="mt-8 grid grid-cols-3 gap-4 border-t border-white/10 pt-6">
            {[['111', 'Tables'], ['15', 'Modules'], ['133', 'Permissions']].map(([n, l]) => (
              <div key={l}>
                <p className="text-xl font-semibold text-white">{n}</p>
                <p className="text-[11px] uppercase tracking-wide text-slate-500">{l}</p>
              </div>
            ))}
          </div>
        </div>
        <p className="relative text-[11px] text-slate-600">
          © {new Date().getFullYear()} Garment ERP · Built for export manufacturing
        </p>
      </div>

      {/* Form panel */}
      <div className="flex w-full items-center justify-center bg-surface-muted px-6 py-10 lg:w-1/2">
        <div className="w-full max-w-[380px]">
          <div className="mb-7 lg:hidden">
            <div className="mb-3 grid h-11 w-11 place-items-center rounded-xl bg-brand-600 text-white">
              <Factory size={22} />
            </div>
            <h1 className="text-xl font-semibold text-slate-900">Garment ERP</h1>
          </div>

          <h2 className="text-[22px] font-semibold tracking-tight text-slate-900">Sign in</h2>
          <p className="mt-1 text-[13px] text-slate-500">Enter your credentials to continue.</p>

          <form onSubmit={submit} className="mt-6 space-y-4">
            {error && (
              <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-[13px] text-red-800">
                <AlertCircle size={16} className="mt-px shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <div>
              <label className="label" htmlFor="username">Username</label>
              <input id="username" className="input" value={username} autoComplete="username"
                onChange={(e) => setUsername(e.target.value)} required autoFocus />
            </div>

            <div>
              <label className="label" htmlFor="password">Password</label>
              <div className="relative">
                <input id="password" type={showPw ? 'text' : 'password'} className="input pr-10"
                  value={password} autoComplete="current-password"
                  onChange={(e) => setPassword(e.target.value)} required />
                <button type="button" onClick={() => setShowPw((v) => !v)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                  aria-label={showPw ? 'Hide password' : 'Show password'}>
                  {showPw ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>

            <button type="submit" className="btn-primary w-full py-2.5" disabled={busy}>
              {busy && <Spinner size={15} />}{busy ? 'Signing in…' : 'Sign in'}
            </button>
          </form>

          <div className="mt-7 rounded-xl border border-surface-border bg-white p-3.5">
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              Demo accounts · password <code className="font-mono text-brand-700">Admin@123</code>
            </p>
            <div className="grid grid-cols-2 gap-1">
              {DEMO_ACCOUNTS.map(([u, role]) => (
                <button key={u} type="button"
                  onClick={() => { setUsername(u); setPassword('Admin@123'); setError(null); }}
                  className="rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-brand-50">
                  <span className="block font-mono text-[12px] font-medium text-brand-700">{u}</span>
                  <span className="block text-[10.5px] text-slate-500">{role}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
