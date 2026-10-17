import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { Factory, AlertCircle, Eye, EyeOff, Building2, ArrowRight, ArrowLeft } from 'lucide-react';
import { useAuth, type Company } from '../lib/auth';
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
  const [companiesToSelect, setCompaniesToSelect] = useState<Company[] | null>(null);
  const [selectingCompanyId, setSelectingCompanyId] = useState<number | null>(null);

  if (loading) {
    return <div className="grid h-screen place-items-center"><Spinner size={26} className="text-brand-600" /></div>;
  }
  if (user) return <Navigate to="/" replace />;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null); setBusy(true);
    try {
      const res = await login(username.trim(), password);
      if (res?.requiresCompanySelection && res.companies && res.companies.length > 0) {
        setCompaniesToSelect(res.companies);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to sign in. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const chooseCompany = async (companyId: number) => {
    setError(null);
    setSelectingCompanyId(companyId);
    try {
      await login(username.trim(), password, companyId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to sign in to selected company. Please try again.');
      setSelectingCompanyId(null);
    }
  };

  return (
    <div className="flex min-h-screen bg-white">
      {/* Brand panel (Pure White / Light Canvas Enterprise Showcase) */}
      <div className="relative hidden w-1/2 flex-col justify-between border-r border-surface-border bg-surface-canvas p-12 text-slate-900 lg:flex">
        <div className="relative flex items-center gap-3">
          <div className="grid h-11 w-11 place-items-center rounded-xl bg-brand-50 border border-brand-200/80 text-brand-700 shadow-subtle">
            <Factory size={22} />
          </div>
          <div>
            <p className="text-[15px] font-bold text-slate-900 tracking-tight">Garment Manufacturing ERP</p>
            <p className="text-xs text-slate-500">Tiruppur Export House Edition</p>
          </div>
        </div>

        <div className="relative max-w-lg">
          <div className="inline-flex items-center gap-1.5 rounded-full border border-brand-200 bg-brand-50 px-3 py-1 text-[11.5px] font-semibold text-brand-700 mb-4">
            <span className="h-1.5 w-1.5 rounded-full bg-brand-600" />
            Next-Gen Enterprise Platform
          </div>
          <h2 className="text-3xl font-bold leading-tight tracking-tight text-slate-900">
            From buyer enquiry<br />to bill of lading.
          </h2>
          <p className="mt-4 text-[14px] leading-relaxed text-slate-600">
            One connected system across sampling, costing, orders, MRP, procurement,
            production, quality, packing, export documentation and finance.
          </p>
          <div className="mt-8 grid grid-cols-3 gap-3 border-t border-surface-border pt-6">
            {[['111', 'Tables'], ['15', 'Modules'], ['133', 'Permissions']].map(([n, l]) => (
              <div key={l} className="rounded-xl border border-surface-border bg-white p-3.5 shadow-subtle">
                <p className="text-xl font-bold text-slate-900">{n}</p>
                <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mt-0.5">{l}</p>
              </div>
            ))}
          </div>
        </div>
        <p className="relative text-[11px] text-slate-400">
          © {new Date().getFullYear()} Garment ERP · Built for export manufacturing
        </p>
      </div>

      {/* Form panel */}
      <div className="flex w-full items-center justify-center bg-white px-6 py-10 lg:w-1/2">
        <div className="w-full max-w-[420px]">
          <div className="mb-7 lg:hidden">
            <div className="mb-3 grid h-11 w-11 place-items-center rounded-xl bg-brand-50 border border-brand-200/80 text-brand-700 shadow-subtle">
              <Factory size={22} />
            </div>
            <h1 className="text-xl font-bold tracking-tight text-slate-900">Garment ERP</h1>
          </div>

          {companiesToSelect ? (
            /* Multi-Company Selection Screen */
            <div className="animate-fade-in">
              <div className="mb-6 flex items-center justify-between">
                <div>
                  <h2 className="text-[22px] font-semibold tracking-tight text-slate-900">Select Company</h2>
                  <p className="mt-1 text-[13px] text-slate-500">
                    Choose which company / GST entity you want to enter:
                  </p>
                </div>
              </div>

              {error && (
                <div className="mb-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-[13px] text-red-800">
                  <AlertCircle size={16} className="mt-px shrink-0" />
                  <span>{error}</span>
                </div>
              )}

              <div className="space-y-3">
                {companiesToSelect.map((comp) => {
                  const isBusy = selectingCompanyId === comp.id;
                  return (
                    <button
                      key={comp.id}
                      type="button"
                      data-company-id={comp.id}
                      disabled={selectingCompanyId !== null}
                      onClick={() => void chooseCompany(comp.id)}
                      className="group flex w-full items-center justify-between rounded-xl border border-surface-border bg-white p-4 text-left shadow-sm transition-all hover:border-brand-500 hover:shadow-md disabled:opacity-60"
                    >
                      <div className="flex items-start gap-3.5">
                        <div className="mt-0.5 grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-600 group-hover:bg-brand-600 group-hover:text-white transition-colors">
                          <Building2 size={20} />
                        </div>
                        <div>
                          <p className="text-[14px] font-semibold text-slate-900 group-hover:text-brand-700">
                            {comp.legal_name}
                          </p>
                          {comp.trade_name && (
                            <p className="text-[12px] font-medium text-slate-600">
                              {comp.trade_name}
                            </p>
                          )}
                          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-500">
                            <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono font-medium text-slate-700">
                              {comp.company_code}
                            </span>
                            {comp.gstin && (
                              <span className="rounded bg-emerald-50 px-1.5 py-0.5 font-mono text-emerald-700">
                                GST: {comp.gstin}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                      <div className="ml-2 text-slate-400 group-hover:text-brand-600">
                        {isBusy ? <Spinner size={18} /> : <ArrowRight size={18} />}
                      </div>
                    </button>
                  );
                })}
              </div>

              <button
                type="button"
                onClick={() => { setCompaniesToSelect(null); setError(null); }}
                className="mt-6 flex items-center gap-1.5 text-[13px] font-medium text-slate-500 hover:text-slate-800"
              >
                <ArrowLeft size={15} /> Back to credentials
              </button>
            </div>
          ) : (
            /* Standard Login Form */
            <>
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
                  {busy && <Spinner size={15} />}{busy ? 'Verifying…' : 'Sign in'}
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
            </>
          )}
        </div>
      </div>
    </div>
  );
}
