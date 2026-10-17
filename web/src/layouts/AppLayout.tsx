import { useState, useMemo, useEffect } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  Menu, X, LogOut, ChevronDown, ChevronRight, Search, Bell, Building2, Star, Clock, ArrowLeft, ArrowRight,
} from 'lucide-react';
import clsx from 'clsx';
import { useAuth } from '../lib/auth';
import { NAV, NAV_BY_PATH, PROCESS_TABS, matchNav, type NavItem } from '../lib/nav';
import { initials } from '../lib/format';
import { useQuery } from '@tanstack/react-query';
import { http } from '../lib/api';

export default function AppLayout() {
  const { user, company, companies, switchCompany, logout, canAny } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [userMenu, setUserMenu] = useState(false);
  const [companyDropdown, setCompanyDropdown] = useState(false);
  const [filter, setFilter] = useState('');
  const [textSize, setTextSize] = useState<'sm' | 'md' | 'lg'>(() => {
    return (localStorage.getItem('erp.textSize') as 'sm' | 'md' | 'lg') || 'md';
  });
  const location = useLocation();

  useEffect(() => {
    document.documentElement.setAttribute('data-text-size', textSize);
    localStorage.setItem('erp.textSize', textSize);
  }, [textSize]);

  // The steps the user can reach (the step bar walks these), and the same filtered by the sidebar search.
  // admin menu switches (MENU_* settings) — e.g. Line QC stays off until the client turns it on
  const { data: uiFlags } = useQuery({
    queryKey: ['ui-flags'],
    queryFn: async () => (await http.get<{ data: Record<string, boolean> }>('/admin/ui-flags')).data ?? {},
    staleTime: 5 * 60_000,
  });
  const flagOn = (i: NavItem) => !i.flag || !!uiFlags?.[i.flag];
  // per-role menu overrides set in Admin → Menu Access (visibility only; permissions still apply)
  const { data: myMenu } = useQuery({
    queryKey: ['my-menu', user?.id],
    queryFn: async () => (await http.get<{ data: { hide: string[]; show: string[] } }>('/admin/my-menu')).data ?? { hide: [], show: [] },
    staleTime: 5 * 60_000,
  });
  const menuOn = (i: NavItem) => (!i.hidden || !!myMenu?.show.includes(i.to)) && !myMenu?.hide.includes(i.to);
  const steps = useMemo(() => NAV
    .map((s) => ({ ...s, items: s.items.filter((i) => menuOn(i) && flagOn(i) && canAny(...i.perms)) }))
    .filter((s) => s.items.length),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [canAny, user, uiFlags, myMenu]);
  const sections = useMemo(() => steps
    .map((s) => filter
      ? { ...s, items: s.items.filter((i) => i.label.toLowerCase().includes(filter.toLowerCase()) || s.label.toLowerCase().includes(filter.toLowerCase())) }
      : s)
    .filter((s) => s.items.length),
    [steps, filter]);

  // per-user sidebar memory: open steps, favourites, recent screens (browser storage, best effort)
  const uid = user?.id ?? 0;
  const load = <T,>(k: string, d: T): T => { try { const v = localStorage.getItem(`erp.nav.${k}.${uid}`); return v ? JSON.parse(v) as T : d; } catch { return d; } };
  const save = (k: string, v: unknown) => { try { localStorage.setItem(`erp.nav.${k}.${uid}`, JSON.stringify(v)); } catch { /* storage blocked */ } };
  const [openSecs, setOpenSecs] = useState<string[]>(() => load<string[]>('open', []).slice(-1));
  const [favs, setFavs] = useState<string[]>(() => load('favs', []));
  const [recent, setRecent] = useState<string[]>(() => load('recent', []));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setOpenSecs(load<string[]>('open', []).slice(-1)); setFavs(load('favs', [])); setRecent(load('recent', [])); }, [uid]);
  // the step of the page you are on opens by itself; the visit goes to "Recent"
  // exactly one menu screen is "the page you are on" (longest matching path; a hidden tab screen → its parent)
  const match = matchNav(location.pathname);
  const activeTo = match?.item.to;
  const stepIdx = steps.findIndex((s) => s.items.some((i) => i.to === activeTo));
  const step = stepIdx >= 0 ? steps[stepIdx] : undefined;
  const currentSection = activeTo === '/' ? undefined : step?.label;
  useEffect(() => {
    // one step open at a time: the page's own step replaces whatever was open
    if (currentSection) setOpenSecs((o) => { if (o.length === 1 && o[0] === currentSection) return o; const next = [currentSection]; save('open', next); return next; });
    if (NAV_BY_PATH.has(location.pathname) && location.pathname !== '/') {
      setRecent((r) => { const next = [location.pathname, ...r.filter((p) => p !== location.pathname)].slice(0, 6); save('recent', next); return next; });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname, currentSection]);
  const toggleSec = (label: string) => {
    // accordion: opening a step closes the previously open one; clicking the open step folds it
    const next = openSecs.includes(label) ? [] : [label];
    setOpenSecs(next); save('open', next);
  };
  const toggleFav = (to: string) => {
    const next = favs.includes(to) ? favs.filter((x) => x !== to) : [...favs, to];
    setFavs(next); save('favs', next);
  };
  const allowed = (to: string) => { const i = NAV_BY_PATH.get(to); return i && canAny(...i.perms) ? i : null; };
  const reachable = (to: string) => { const i = allowed(to); return i && menuOn(i) && flagOn(i) ? i : null; };
  const favItems = favs.map(reachable).filter(Boolean) as NavItem[];
  const recentItems = (recent.filter((p) => !favs.includes(p) && p !== location.pathname).map(reachable).filter(Boolean) as NavItem[]).slice(0, 5);
  const tabGroup = PROCESS_TABS.find((g) => g.tabs.some((t) => t.to === location.pathname));
  // previous / next numbered step (1 · Orders … 14 · Masters & Setup) for the step bar
  const numbered = (s?: { label: string }) => !!s && /^\d+ · /.test(s.label);
  const prevStep = numbered(step) ? steps.slice(0, stepIdx).reverse().find(numbered) : undefined;
  const nextStep = numbered(step) ? steps.slice(stepIdx + 1).find(numbered) : undefined;

  // Every screen: where you are in the flow, the other screens of this step, and the steps either side.
  const stepBar = step && match && activeTo !== '/' && (
    <div id="step-bar" className="mb-4 rounded-xl border border-surface-border bg-white px-3.5 py-2.5 shadow-card">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[12px]">
        <span className="font-bold text-slate-700">{step.label.replace(/^(\d+) · /, 'Step $1 · ')}</span>
        <ChevronRight size={12} className="text-slate-400" />
        {match.detail ? (
          <Link to={match.item.to} className="inline-flex items-center gap-1 font-bold text-brand-700 hover:underline" id="step-back">
            <ArrowLeft size={12} /> {match.item.label}
          </Link>
        ) : <span className="font-extrabold text-slate-900">{match.item.label}</span>}
        {!match.detail && (prevStep || nextStep) && (
          <div className="ml-auto flex gap-1.5">
            {prevStep && (
              <Link to={prevStep.items[0].to} id="step-prev" title={`Previous step: ${prevStep.label}`}
                className="inline-flex items-center gap-1 rounded-lg border border-surface-border bg-white px-2.5 py-1 text-[11.5px] font-semibold text-slate-700 hover:border-slate-300 hover:text-slate-900 shadow-subtle transition-all">
                <ArrowLeft size={12} /> {prevStep.label}
              </Link>
            )}
            {nextStep && (
              <Link to={nextStep.items[0].to} id="step-next" title={`Next step: ${nextStep.label}`}
                className="inline-flex items-center gap-1 rounded-lg border border-brand-200 bg-brand-50 px-2.5 py-1 text-[11.5px] font-bold text-brand-700 hover:bg-brand-100 shadow-subtle transition-all">
                {nextStep.label} <ArrowRight size={12} />
              </Link>
            )}
          </div>
        )}
      </div>
      {!match.detail && step.items.length > 1 && (
        <div className="mt-2.5 flex gap-1.5 overflow-x-auto pb-0.5" id="step-screens">
          {step.items.map((i) => (
            <Link key={i.to} to={i.to} aria-current={i.to === activeTo ? 'page' : undefined}
              className={clsx('whitespace-nowrap rounded-lg border px-3 py-1 text-[11.5px] font-semibold transition-colors',
                i.to === activeTo
                  ? 'border-brand-600 bg-brand-600 text-white shadow-subtle'
                  : 'border-surface-border bg-white text-slate-700 hover:border-slate-400 hover:text-slate-900')}>
              {i.label}
            </Link>
          ))}
        </div>
      )}
    </div>
  );

  const notifications = useQuery({
    queryKey: ['notifications'],
    queryFn: async () => (await http.get<{ data: { id: number; title: string; body: string; is_read: number }[] }>('/admin/notifications')).data,
    refetchInterval: 60_000,
  }).data;
  // live alerts (GRN bills pending, process DCs overdue …) — computed by the server every minute
  const { data: alerts } = useQuery({
    queryKey: ['alerts'],
    queryFn: async () => (await http.get<{ data: { key: string; title: string; body: string; count: number; severity: string; link: string }[] }>('/alerts')).data ?? [],
    refetchInterval: 60_000,
  });
  const [bellOpen, setBellOpen] = useState(false);
  const goto = useNavigate();
  const unread = (notifications ?? []).filter((n) => !n.is_read).length + (alerts ?? []).length;

  const navLink = (item: NavItem, isFav: boolean) => (
    <div key={item.to} className="group relative">
      <Link to={item.to} onClick={() => setMobileOpen(false)} aria-current={item.to === activeTo ? 'page' : undefined}
        className={clsx(
          'flex items-center gap-2.5 rounded-lg py-[7.5px] pl-2.5 pr-7 text-[12.5px] transition-all',
          item.to === activeTo
            ? 'bg-brand-50 font-bold text-brand-900 shadow-subtle border border-brand-200/80'
            : 'font-semibold text-slate-800 hover:bg-slate-100 hover:text-slate-950')}>
        <item.icon size={15} className={clsx('shrink-0 transition-colors', item.to === activeTo ? 'text-brand-600' : 'text-slate-500 group-hover:text-slate-900')} />
        <span className="truncate" title={item.label}>{item.label}</span>
      </Link>
      {item.to !== '/' && (
        <button type="button" onClick={() => toggleFav(item.to)} data-fav={item.to}
          title={isFav ? 'Remove from favourites' : 'Add to favourites'} aria-label={isFav ? `Unpin ${item.label}` : `Pin ${item.label}`}
          className={clsx('absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 transition-opacity',
            isFav ? 'text-amber-500' : 'text-slate-400 opacity-0 hover:text-amber-500 focus:opacity-100 group-hover:opacity-100')}>
          <Star size={12} fill={isFav ? 'currentColor' : 'none'} />
        </button>
      )}
    </div>
  );

  const sidebar = (
    <div className="flex h-full flex-col bg-white border-r border-surface-border text-slate-800">
      <div className="flex h-14 shrink-0 items-center gap-2.5 border-b border-surface-border px-4">
        <div className="grid h-8 w-8 place-items-center rounded-lg bg-brand-50 border border-brand-200/80 text-sm font-bold text-brand-700 shadow-subtle">
          {company ? initials(company.trade_name || company.legal_name) : 'ER'}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-bold text-slate-900 tracking-tight">
            {company?.trade_name || company?.legal_name || 'Garment ERP'}
          </p>
          <p className="truncate text-[10.5px] font-semibold text-slate-500">Manufacturing SaaS</p>
        </div>
        <button className="rounded-md p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-800 lg:hidden" onClick={() => setMobileOpen(false)} aria-label="Close menu">
          <X size={18} />
        </button>
      </div>

      <div className="shrink-0 px-3 py-2.5">
        <div className="relative">
          <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
          <input value={filter} onChange={(e) => setFilter(e.target.value)}
            placeholder="Find a screen…"
            className="w-full rounded-lg border border-surface-border bg-slate-50/80 py-1.5 pl-8 pr-2.5 text-xs font-medium text-slate-900
                       placeholder:text-slate-500 transition focus:bg-white focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-500/15" />
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto px-2.5 pb-4" id="side-nav">
        {!filter && favItems.length > 0 && (
          <div className="mb-2">
            <p className="flex items-center gap-1.5 px-2 py-1.5 text-[10.5px] font-bold uppercase tracking-wider text-amber-700"><Star size={12} /> Favourites</p>
            <div className="space-y-0.5" id="nav-favs">{favItems.map((item) => navLink(item, true))}</div>
          </div>
        )}
        {!filter && recentItems.length > 0 && (
          <div className="mb-2">
            <p className="flex items-center gap-1.5 px-2 py-1.5 text-[10.5px] font-bold uppercase tracking-wider text-slate-700"><Clock size={12} /> Recent</p>
            <div className="space-y-0.5" id="nav-recent">{recentItems.map((item) => navLink(item, false))}</div>
          </div>
        )}
        {sections.map((section) => {
          // searching opens every step; a one-screen step (Overview) has no header
          const single = section.label === 'Overview'; // only the dashboard has no step header (a role may see one screen of a step — it still gets its header)
          const open = !!filter || single || openSecs.includes(section.label);
          return (
            <div key={section.label} className={clsx('mb-1 rounded-lg', open && !single && 'bg-slate-50/50')}>
              {!single && (
                // open step: lit header; the step of the page you are on: brand accent bar + brand count
                <button onClick={() => toggleSec(section.label)} aria-expanded={open} data-section={section.label}
                  data-current={section.label === currentSection || undefined}
                  className={clsx('relative flex w-full items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-left text-[11px] font-bold uppercase tracking-wider transition-colors',
                    section.label === currentSection
                      ? 'bg-brand-50 text-brand-900'
                      : open ? 'bg-slate-100/90 text-slate-900' : 'text-slate-700 hover:bg-slate-100/70 hover:text-slate-950')}>
                  {section.label === currentSection && <span className="absolute inset-y-1 left-0 w-[3px] rounded-full bg-brand-600" />}
                  {open ? <ChevronDown size={12} className="shrink-0 text-slate-600" /> : <ChevronRight size={12} className="shrink-0 text-slate-600" />}
                  <span className="flex-1 truncate">{section.label}</span>
                  <span className={clsx('rounded-full px-1.5 text-[9.5px] font-bold',
                    section.label === currentSection ? 'bg-brand-200 text-brand-900' : open ? 'bg-slate-200 text-slate-800' : 'bg-slate-200/70 text-slate-700')}>
                    {section.items.length}
                  </span>
                </button>
              )}
              {open && <div className={clsx('space-y-0.5', !single && 'mb-1 mt-0.5 pb-1')}>{section.items.map((item) => navLink(item, favs.includes(item.to)))}</div>}
            </div>
          );
        })}
        {!sections.length && (
          <p className="px-3 py-6 text-center text-xs font-medium text-slate-500">No matching screens</p>
        )}
      </nav>
    </div>
  );

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Desktop sidebar */}
      <aside className="hidden w-[248px] shrink-0 lg:block">{sidebar}</aside>

      {/* Mobile drawer */}
      {mobileOpen && (
        <>
          <div className="fixed inset-0 z-40 bg-slate-900/50 lg:hidden" onClick={() => setMobileOpen(false)} />
          <aside className="fixed inset-y-0 left-0 z-50 w-[264px] lg:hidden">{sidebar}</aside>
        </>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-surface-border bg-white px-4">
          <button className="rounded-lg p-1.5 text-slate-500 hover:bg-surface-hover lg:hidden"
            onClick={() => setMobileOpen(true)} aria-label="Open menu">
            <Menu size={19} />
          </button>

          <div className="flex-1" />

          {/* Accessibility Font Sizer */}
          <div className="flex items-center rounded-lg border border-surface-border bg-slate-100/80 p-0.5" title="Adjust Text Size">
            <button
              type="button"
              title="Small font size"
              onClick={() => setTextSize('sm')}
              className={clsx(
                'rounded px-2 py-0.5 text-[11px] font-semibold transition-all',
                textSize === 'sm' ? 'bg-white text-brand-700 shadow-sm font-bold' : 'text-slate-500 hover:text-slate-800'
              )}
            >
              A-
            </button>
            <button
              type="button"
              title="Default font size"
              onClick={() => setTextSize('md')}
              className={clsx(
                'rounded px-2 py-0.5 text-[12px] font-semibold transition-all',
                textSize === 'md' ? 'bg-white text-brand-700 shadow-sm font-bold' : 'text-slate-500 hover:text-slate-800'
              )}
            >
              A
            </button>
            <button
              type="button"
              title="Large font size"
              onClick={() => setTextSize('lg')}
              className={clsx(
                'rounded px-2 py-0.5 text-[13px] font-semibold transition-all',
                textSize === 'lg' ? 'bg-white text-brand-700 shadow-sm font-bold' : 'text-slate-500 hover:text-slate-800'
              )}
            >
              A+
            </button>
          </div>

          <div className="relative">
          <button className="relative rounded-lg p-2 text-slate-500 hover:bg-surface-hover" aria-label="Notifications" id="btn-bell" onClick={() => setBellOpen((v) => !v)}>
            <Bell size={17} />
            {unread > 0 && (
              <span className="absolute right-1 top-1 grid h-4 min-w-4 place-items-center rounded-full
                               bg-red-500 px-1 text-[9px] font-semibold text-white">
                {unread > 9 ? '9+' : unread}
              </span>
            )}
          </button>
          {bellOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setBellOpen(false)} />
              <div className="absolute right-0 top-full z-20 mt-1.5 w-96 animate-fade-in rounded-xl border border-surface-border bg-white p-1.5 shadow-popover" id="bell-panel">
                <p className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500">Alerts</p>
                {(alerts ?? []).map((a) => (
                  <button key={a.key} onClick={() => { setBellOpen(false); goto(a.link); }}
                    className="flex w-full items-start gap-2 rounded-lg px-3 py-2 text-left hover:bg-surface-hover">
                    <span className={clsx('mt-1 h-2 w-2 shrink-0 rounded-full', a.severity === 'danger' ? 'bg-red-500' : a.severity === 'warning' ? 'bg-amber-500' : 'bg-sky-500')} />
                    <span><span className="block text-[12.5px] font-semibold text-slate-800">{a.title}</span><span className="block text-[11.5px] text-slate-500">{a.body}</span></span>
                  </button>
                ))}
                {!(alerts ?? []).length && <p className="px-3 py-2 text-[12px] text-slate-400">No alerts</p>}
                {(notifications ?? []).length > 0 && <p className="mt-1 border-t border-surface-border px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500">Notifications</p>}
                {(notifications ?? []).slice(0, 8).map((n) => (
                  <div key={n.id} className={clsx('rounded-lg px-3 py-1.5 text-[12px]', n.is_read ? 'text-slate-500' : 'font-medium text-slate-800')}>{n.title}{n.body ? <span className="block text-[11px] font-normal text-slate-500">{n.body}</span> : null}</div>
                ))}
              </div>
            </>
          )}
          </div>

          {/* Active Company Switcher Pill */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setCompanyDropdown((v) => !v)}
              className="flex items-center gap-2 rounded-lg border border-surface-border bg-white px-3 py-1.5 text-left text-slate-700 transition-all hover:bg-slate-50 hover:border-slate-300 shadow-subtle"
              title={companies.length > 1 ? 'Click to switch company' : company?.legal_name}
            >
              <Building2 size={15} className="shrink-0 text-brand-600" />
              <div className="hidden max-w-[170px] truncate md:block">
                <p className="truncate text-[12px] font-bold leading-tight text-slate-900">
                  {company?.trade_name || company?.legal_name || 'Select Company'}
                </p>
                {company?.gstin && (
                  <p className="font-mono text-[10px] font-semibold leading-tight text-slate-600">
                    GST: {company.gstin}
                  </p>
                )}
              </div>
              {companies.length > 1 && (
                <ChevronDown size={13} className="text-slate-500" />
              )}
            </button>

            {companyDropdown && companies.length > 1 && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setCompanyDropdown(false)} />
                <div className="absolute right-0 top-full z-20 mt-1.5 w-72 animate-fade-in rounded-xl border border-surface-border bg-white p-1.5 shadow-popover">
                  <p className="px-2.5 py-1 text-[10.5px] font-bold uppercase tracking-wider text-slate-600">
                    Switch Company
                  </p>
                  <div className="mt-1 space-y-1">
                    {companies.map((c) => {
                      const isCurrent = c.id === company?.id;
                      return (
                        <button
                          key={c.id}
                          type="button"
                          disabled={isCurrent}
                          onClick={() => {
                            setCompanyDropdown(false);
                            void switchCompany(c.id);
                          }}
                          className={clsx(
                            'flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors',
                            isCurrent
                              ? 'bg-brand-50 text-brand-900 cursor-default'
                              : 'hover:bg-slate-50 text-slate-700'
                          )}
                        >
                          <Building2
                            size={16}
                            className={clsx('mt-0.5 shrink-0', isCurrent ? 'text-brand-600' : 'text-slate-400')}
                          />
                          <div className="flex-1 min-w-0">
                            <p className="truncate text-[12.5px] font-bold text-slate-900">
                              {c.legal_name}
                            </p>
                            {c.trade_name && (
                              <p className="text-[11px] font-medium text-slate-600">{c.trade_name}</p>
                            )}
                            {c.gstin && (
                              <p className="font-mono text-[10px] font-medium text-slate-500">GST: {c.gstin}</p>
                            )}
                          </div>
                          {isCurrent && (
                            <span className="shrink-0 rounded bg-brand-200/60 px-1.5 py-0.5 text-[9.5px] font-bold text-brand-800">
                              Active
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </>
            )}
          </div>

          <div className="relative">
            <button onClick={() => setUserMenu((v) => !v)}
              className="flex items-center gap-2 rounded-lg py-1 pl-1 pr-2 hover:bg-surface-hover transition-colors">
              <div className="grid h-7 w-7 place-items-center rounded-full bg-brand-50 border border-brand-200/80 text-[11px] font-bold text-brand-700 shadow-subtle">
                {initials(user?.fullName ?? '?')}
              </div>
              <div className="hidden text-left sm:block">
                <p className="max-w-[140px] truncate text-[12.5px] font-bold leading-tight text-slate-900">
                  {user?.fullName}
                </p>
                <p className="text-[10.5px] font-semibold leading-tight text-slate-600">
                  {user?.roles?.[0]?.replace(/_/g, ' ') ?? 'User'}
                </p>
              </div>
              <ChevronDown size={14} className="text-slate-500" />
            </button>

            {userMenu && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setUserMenu(false)} />
                <div className="absolute right-0 top-full z-20 mt-1.5 w-64 animate-fade-in rounded-xl border
                                border-surface-border bg-white p-1.5 shadow-popover">
                  <div className="border-b border-surface-border px-3 py-2.5">
                    <p className="text-[13px] font-medium text-slate-800">{user?.fullName}</p>
                    <p className="text-[11px] text-slate-500">@{user?.username}</p>
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {user?.roles.map((r) => (
                        <span key={r} className="rounded bg-brand-50 px-1.5 py-0.5 text-[10px] font-medium text-brand-700">
                          {r.replace(/_/g, ' ')}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div className="border-b border-surface-border px-3 py-2 text-[11px] text-slate-500">
                    <span className="flex items-center gap-1.5 font-medium text-slate-700">
                      <Building2 size={12} className="text-brand-600" />{company?.trade_name || company?.legal_name}
                    </span>
                    {company?.gstin && <p className="mt-0.5 font-mono text-[10px] text-slate-400">GST: {company.gstin}</p>}
                  </div>

                  {companies.length > 1 && (
                    <div className="border-b border-surface-border p-1.5">
                      <p className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                        Switch Company
                      </p>
                      {companies.map((c) => (
                        <button
                          key={c.id}
                          type="button"
                          disabled={c.id === company?.id}
                          onClick={() => {
                            setUserMenu(false);
                            void switchCompany(c.id);
                          }}
                          className={clsx(
                            'flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left text-[12px]',
                            c.id === company?.id
                              ? 'bg-brand-50 font-semibold text-brand-700'
                              : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                          )}
                        >
                          <span className="truncate">{c.trade_name || c.legal_name}</span>
                          {c.id === company?.id && (
                            <span className="rounded bg-brand-200/60 px-1 text-[9px] font-bold text-brand-800">
                              Current
                            </span>
                          )}
                        </button>
                      ))}
                    </div>
                  )}

                  <button onClick={() => void logout()}
                    className="mt-1 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[13px]
                               text-red-600 hover:bg-red-50">
                    <LogOut size={15} /> Sign out
                  </button>
                </div>
              </>
            )}
          </div>
        </header>

        <main key={location.pathname} className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-[1600px] p-4 sm:p-6">
            {stepBar}
            {tabGroup && (
              // Sewing / Checking / Ironing / Packing versions of the same screen, one click apart
              <div className="mb-4 flex gap-1 overflow-x-auto border-b border-surface-border" id="process-tabs">
                {tabGroup.tabs.filter((t) => allowed(t.to)).map((t) => (
                  <NavLink key={t.to} to={t.to} className={({ isActive }) => clsx('-mb-px whitespace-nowrap border-b-2 px-3.5 py-2 text-[13px] font-medium',
                    isActive ? 'border-brand-600 text-brand-700' : 'border-transparent text-slate-500 hover:text-slate-800')}>
                    {t.label}
                  </NavLink>
                ))}
              </div>
            )}
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
