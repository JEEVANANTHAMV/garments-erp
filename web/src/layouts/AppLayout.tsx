import { useState, useMemo, useEffect } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  Menu, X, LogOut, ChevronDown, ChevronRight, Search, Bell, Building2, Star, Clock,
} from 'lucide-react';
import clsx from 'clsx';
import { useAuth } from '../lib/auth';
import { NAV, NAV_BY_PATH, PROCESS_TABS, type NavItem } from '../lib/nav';
import { initials } from '../lib/format';
import { useQuery } from '@tanstack/react-query';
import { http } from '../lib/api';

export default function AppLayout() {
  const { user, company, logout, canAny } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [userMenu, setUserMenu] = useState(false);
  const [filter, setFilter] = useState('');
  const [textSize, setTextSize] = useState<'sm' | 'md' | 'lg'>(() => {
    return (localStorage.getItem('erp.textSize') as 'sm' | 'md' | 'lg') || 'md';
  });
  const location = useLocation();

  useEffect(() => {
    document.documentElement.setAttribute('data-text-size', textSize);
    localStorage.setItem('erp.textSize', textSize);
  }, [textSize]);

  // Only render sections the user can actually reach.
  const sections = useMemo(() => NAV
    .map((s) => ({ ...s, items: s.items.filter((i) => !i.hidden && canAny(...i.perms)) }))
    .filter((s) => s.items.length)
    .map((s) => filter
      ? { ...s, items: s.items.filter((i) => i.label.toLowerCase().includes(filter.toLowerCase()) || s.label.toLowerCase().includes(filter.toLowerCase())) }
      : s)
    .filter((s) => s.items.length),
    [canAny, filter, user]);

  // per-user sidebar memory: open steps, favourites, recent screens (browser storage, best effort)
  const uid = user?.id ?? 0;
  const load = <T,>(k: string, d: T): T => { try { const v = localStorage.getItem(`erp.nav.${k}.${uid}`); return v ? JSON.parse(v) as T : d; } catch { return d; } };
  const save = (k: string, v: unknown) => { try { localStorage.setItem(`erp.nav.${k}.${uid}`, JSON.stringify(v)); } catch { /* storage blocked */ } };
  const [openSecs, setOpenSecs] = useState<string[]>(() => load('open', []));
  const [favs, setFavs] = useState<string[]>(() => load('favs', []));
  const [recent, setRecent] = useState<string[]>(() => load('recent', []));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setOpenSecs(load('open', [])); setFavs(load('favs', [])); setRecent(load('recent', [])); }, [uid]);
  // the step of the page you are on opens by itself; the visit goes to "Recent"
  const currentSection = sections.find((s) => s.items.some((i) => i.to !== '/' && (location.pathname === i.to || location.pathname.startsWith(`${i.to}/`))))?.label;
  useEffect(() => {
    if (currentSection) setOpenSecs((o) => { if (o.includes(currentSection)) return o; const next = [...o, currentSection]; save('open', next); return next; });
    if (NAV_BY_PATH.has(location.pathname) && location.pathname !== '/') {
      setRecent((r) => { const next = [location.pathname, ...r.filter((p) => p !== location.pathname)].slice(0, 6); save('recent', next); return next; });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname, currentSection]);
  const toggleSec = (label: string) => {
    const next = openSecs.includes(label) ? openSecs.filter((x) => x !== label) : [...openSecs, label];
    setOpenSecs(next); save('open', next);
  };
  const toggleFav = (to: string) => {
    const next = favs.includes(to) ? favs.filter((x) => x !== to) : [...favs, to];
    setFavs(next); save('favs', next);
  };
  const allowed = (to: string) => { const i = NAV_BY_PATH.get(to); return i && canAny(...i.perms) ? i : null; };
  const reachable = (to: string) => { const i = allowed(to); return i && !i.hidden ? i : null; };
  const favItems = favs.map(reachable).filter(Boolean) as NavItem[];
  const recentItems = (recent.filter((p) => !favs.includes(p) && p !== location.pathname).map(reachable).filter(Boolean) as NavItem[]).slice(0, 5);
  const tabGroup = PROCESS_TABS.find((g) => g.tabs.some((t) => t.to === location.pathname));

  const { data: notifications } = useQuery({
    queryKey: ['notifications'],
    queryFn: async () => (await http.get<{ data: { id: number; title: string; body: string; is_read: number }[] }>('/admin/notifications')).data,
    refetchInterval: 60_000,
  });
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
      <NavLink to={item.to} end={item.to === '/'}
        onClick={() => setMobileOpen(false)}
        className={({ isActive }) => clsx(
          'flex items-center gap-2.5 rounded-lg py-[7px] pl-2.5 pr-7 text-[12.5px] transition-colors',
          isActive
            ? 'bg-brand-600 font-medium text-white'
            : 'text-slate-400 hover:bg-white/5 hover:text-slate-100')}>
        <item.icon size={15} className="shrink-0" />
        <span className="truncate">{item.label}</span>
      </NavLink>
      {item.to !== '/' && (
        <button type="button" onClick={() => toggleFav(item.to)} data-fav={item.to}
          title={isFav ? 'Remove from favourites' : 'Add to favourites'} aria-label={isFav ? `Unpin ${item.label}` : `Pin ${item.label}`}
          className={clsx('absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 transition-opacity',
            isFav ? 'text-amber-400' : 'text-slate-500 opacity-0 hover:text-amber-300 focus:opacity-100 group-hover:opacity-100')}>
          <Star size={12} fill={isFav ? 'currentColor' : 'none'} />
        </button>
      )}
    </div>
  );

  const sidebar = (
    <div className="flex h-full flex-col bg-slate-900 text-slate-300">
      <div className="flex h-14 shrink-0 items-center gap-2.5 border-b border-white/10 px-4">
        <div className="grid h-8 w-8 place-items-center rounded-lg bg-brand-600 text-sm font-bold text-white">
          {company ? initials(company.trade_name || company.legal_name) : 'ER'}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-semibold text-white">
            {company?.trade_name || company?.legal_name || 'Garment ERP'}
          </p>
          <p className="truncate text-[10px] text-slate-400">Manufacturing ERP</p>
        </div>
        <button className="lg:hidden" onClick={() => setMobileOpen(false)} aria-label="Close menu">
          <X size={18} />
        </button>
      </div>

      <div className="shrink-0 px-3 py-2.5">
        <div className="relative">
          <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
          <input value={filter} onChange={(e) => setFilter(e.target.value)}
            placeholder="Find a screen…"
            className="w-full rounded-lg border border-white/10 bg-white/5 py-1.5 pl-8 pr-2 text-xs text-slate-200
                       placeholder:text-slate-500 focus:border-brand-500 focus:outline-none" />
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto px-2.5 pb-4" id="side-nav">
        {!filter && favItems.length > 0 && (
          <div className="mb-2">
            <p className="flex items-center gap-1.5 px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-amber-400/90"><Star size={11} /> Favourites</p>
            <div className="space-y-0.5" id="nav-favs">{favItems.map((item) => navLink(item, true))}</div>
          </div>
        )}
        {!filter && recentItems.length > 0 && (
          <div className="mb-2">
            <p className="flex items-center gap-1.5 px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500"><Clock size={11} /> Recent</p>
            <div className="space-y-0.5" id="nav-recent">{recentItems.map((item) => navLink(item, false))}</div>
          </div>
        )}
        {sections.map((section) => {
          // searching opens every step; a one-screen step (Overview) has no header
          const single = section.items.length === 1;
          const open = !!filter || single || openSecs.includes(section.label);
          return (
            <div key={section.label} className="mb-1">
              {!single && (
                <button onClick={() => toggleSec(section.label)} aria-expanded={open} data-section={section.label}
                  className={clsx('flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-[10.5px] font-semibold uppercase tracking-wider hover:bg-white/5',
                    section.label === currentSection ? 'text-white' : 'text-slate-400')}>
                  {open ? <ChevronDown size={12} className="shrink-0" /> : <ChevronRight size={12} className="shrink-0" />}
                  <span className="flex-1 truncate">{section.label}</span>
                  <span className="rounded-full bg-white/5 px-1.5 text-[9.5px] font-medium text-slate-500">{section.items.length}</span>
                </button>
              )}
              {open && <div className="mb-2 mt-0.5 space-y-0.5">{section.items.map((item) => navLink(item, favs.includes(item.to)))}</div>}
            </div>
          );
        })}
        {!sections.length && (
          <p className="px-3 py-6 text-center text-xs text-slate-500">No matching screens</p>
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

          <div className="relative">
            <button onClick={() => setUserMenu((v) => !v)}
              className="flex items-center gap-2 rounded-lg py-1 pl-1 pr-2 hover:bg-surface-hover">
              <div className="grid h-7 w-7 place-items-center rounded-full bg-brand-100 text-[11px] font-semibold text-brand-700">
                {initials(user?.fullName ?? '?')}
              </div>
              <div className="hidden text-left sm:block">
                <p className="max-w-[140px] truncate text-[12.5px] font-medium leading-tight text-slate-800">
                  {user?.fullName}
                </p>
                <p className="text-[10.5px] leading-tight text-slate-500">
                  {user?.roles?.[0]?.replace(/_/g, ' ') ?? 'User'}
                </p>
              </div>
              <ChevronDown size={14} className="text-slate-400" />
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
                    <span className="flex items-center gap-1.5">
                      <Building2 size={12} />{company?.legal_name}
                    </span>
                  </div>
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
