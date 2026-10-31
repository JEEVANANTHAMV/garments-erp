import { useState, useMemo, useEffect, useRef, Fragment, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  Menu, X, LogOut, ChevronDown, ChevronRight, Search, Bell, Building2, Star, ArrowLeft, ArrowRight, MessageSquare, LayoutGrid, FileText,
} from 'lucide-react';
import clsx from 'clsx';
import { useAuth } from '../lib/auth';
import { NAV, NAV_BY_PATH, NAV_GROUPS, PROCESS_TABS, matchNav, type NavItem, type NavSection } from '../lib/nav';
import { initials, fmtDate } from '../lib/format';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useDebounced } from '../components/ui';
import { http } from '../lib/api';

export default function AppLayout() {
  const { user, company, companies, switchCompany, logout, canAny } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);
  // desktop sidebar: full (224 px) or icon rail with flyouts (spec §7); remembered per browser
  const [desktopOpen, setDesktopOpen] = useState(() => { try { return localStorage.getItem('erp.nav.collapsed') !== '1'; } catch { return true; } });
  useEffect(() => { try { localStorage.setItem('erp.nav.collapsed', desktopOpen ? '0' : '1'); } catch { /* storage blocked */ } }, [desktopOpen]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [globalSearch, setGlobalSearch] = useState('');
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

  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setMobileOpen(false); setUserMenu(false); setCompanyDropdown(false); setBellOpen(false); setSearchOpen(false); setFlyout(null); setMsgOpen(false); setAppsOpen(false); }
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, []);

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

  // per-user sidebar memory: open steps and favourites (browser storage, best effort)
  const uid = user?.id ?? 0;
  const load = <T,>(k: string, d: T): T => { try { const v = localStorage.getItem(`erp.nav.${k}.${uid}`); return v ? JSON.parse(v) as T : d; } catch { return d; } };
  const save = (k: string, v: unknown) => { try { localStorage.setItem(`erp.nav.${k}.${uid}`, JSON.stringify(v)); } catch { /* storage blocked */ } };
  const [openSecs, setOpenSecs] = useState<string[]>(() => load<string[]>('open', []).slice(-1));
  const [favs, setFavs] = useState<string[]>(() => load('favs', []));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setOpenSecs(load<string[]>('open', []).slice(-1)); setFavs(load('favs', [])); }, [uid]);
  // the step of the page you are on opens by itself
  // exactly one menu screen is "the page you are on" (longest matching path; a hidden tab screen → its parent)
  const match = matchNav(location.pathname);
  const activeTo = match?.item.to;
  const stepIdx = steps.findIndex((s) => s.items.some((i) => i.to === activeTo));
  const step = stepIdx >= 0 ? steps[stepIdx] : undefined;
  const currentSection = activeTo === '/' ? undefined : step?.label;
  useEffect(() => {
    // one step open at a time: the page's own step replaces whatever was open
    if (currentSection) setOpenSecs((o) => { if (o.length === 1 && o[0] === currentSection) return o; const next = [currentSection]; save('open', next); return next; });
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
  const tabGroup = PROCESS_TABS.find((g) => g.tabs.some((t) => t.to === location.pathname));
  // previous / next numbered step (1 · Orders … 14 · Masters & Setup) for the step bar
  const numbered = (s?: { label: string }) => !!s && /^\d+ · /.test(s.label);
  const prevStep = numbered(step) ? steps.slice(0, stepIdx).reverse().find(numbered) : undefined;
  const nextStep = numbered(step) ? steps.slice(stepIdx + 1).find(numbered) : undefined;

  // Every screen: where you are in the flow, the other screens of this step, and the steps either side.
  const stepBar = step && match && activeTo !== '/' && (
    <div id="step-bar" className="mb-4 rounded-xl border border-surface-border bg-white px-3.5 py-2.5 shadow-card">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-small">
        <span className="font-bold text-ink">{step.label.replace(/^(\d+) · /, 'Step $1 · ')}</span>
        <ChevronRight size={12} className="text-ink-muted" />
        {match.detail ? (
          <Link to={match.item.to} className="inline-flex items-center gap-1 font-bold text-brand-700 hover:underline" id="step-back">
            <ArrowLeft size={12} /> {match.item.label}
          </Link>
        ) : <span className="font-bold text-ink">{match.item.label}</span>}
        {!match.detail && (prevStep || nextStep) && (
          <div className="ml-auto flex gap-1.5">
            {prevStep && (
              <Link to={prevStep.items[0].to} id="step-prev" title={`Previous step: ${prevStep.label}`}
                className="inline-flex items-center gap-1 rounded-lg border border-surface-border bg-white px-2.5 py-1 text-small font-semibold text-ink hover:border-surface-input hover:text-ink shadow-subtle transition-all">
                <ArrowLeft size={12} /> {prevStep.label}
              </Link>
            )}
            {nextStep && (
              <Link to={nextStep.items[0].to} id="step-next" title={`Next step: ${nextStep.label}`}
                className="inline-flex items-center gap-1 rounded-lg border border-brand-200 bg-brand-50 px-2.5 py-1 text-small font-bold text-brand-700 hover:bg-brand-100 shadow-subtle transition-all">
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
              className={clsx('whitespace-nowrap rounded-lg border px-3 py-1 text-small font-semibold transition-colors',
                i.to === activeTo
                  ? 'border-brand-600 bg-brand-600 text-white shadow-subtle'
                  : 'border-surface-border bg-white text-ink hover:border-slate-400 hover:text-ink')}>
              {i.label}
            </Link>
          ))}
        </div>
      )}
    </div>
  );

  const notifications = useQuery({
    queryKey: ['notifications'],
    queryFn: async () => (await http.get<{ data: { id: number; title: string; body: string; is_read: number; created_at: string }[] }>('/admin/notifications')).data,
    refetchInterval: 60_000,
  }).data;
  // Messages = the user's own notifications (header message icon); the bell keeps the live alerts.
  const qc = useQueryClient();
  const [msgOpen, setMsgOpen] = useState(false);
  const [appsOpen, setAppsOpen] = useState(false);
  const unreadMsgs = (notifications ?? []).filter((n) => !n.is_read).length;
  const markRead = async (id?: number) => {
    await http.post(id ? `/admin/notifications/${id}/read` : '/admin/notifications/read-all', {});
    void qc.invalidateQueries({ queryKey: ['notifications'] });
  };
  // Header "Search anything": matching screens plus records (orders, POs, styles, jobs, fabrics, parties …)
  const searchTerm = useDebounced(globalSearch.trim(), 250);
  const records = useQuery({
    queryKey: ['global-search', company?.id, searchTerm], enabled: searchTerm.length >= 2, staleTime: 30_000,
    queryFn: async () => (await http.get<{ data: { type: string; id: number; label: string; sub: string | null; to: string }[] }>('/search', { q: searchTerm })).data ?? [],
  });
  const screenHits = globalSearch.trim()
    ? Array.from(new Map(steps.flatMap((sec) => sec.items).filter((i) => i.label.toLowerCase().includes(globalSearch.trim().toLowerCase())).map((i) => [i.to, i])).values()).slice(0, 6)
    : [];
  const recordHits = searchTerm === globalSearch.trim() ? records.data ?? [] : [];
  const recordGroups = Array.from(recordHits.reduce((m, r) => m.set(r.type, [...(m.get(r.type) ?? []), r]), new Map<string, typeof recordHits>()));
  const pickSearch = (to: string) => { goto(to); setSearchOpen(false); setGlobalSearch(''); };
  // live alerts (GRN bills pending, process DCs overdue …) — computed by the server every minute
  const { data: alerts } = useQuery({
    queryKey: ['alerts'],
    queryFn: async () => (await http.get<{ data: { key: string; title: string; body: string; count: number; severity: string; link: string }[] }>('/alerts')).data ?? [],
    refetchInterval: 60_000,
  });
  const [bellOpen, setBellOpen] = useState(false);
  const goto = useNavigate();
  const unread = (alerts ?? []).length;

  const navLink = (item: NavItem, isFav: boolean, child = false) => (
    <div key={item.to} className="group relative">
      <Link to={item.to} onClick={() => setMobileOpen(false)} aria-current={item.to === activeTo ? 'page' : undefined}
        className={clsx(
          'nav-item flex items-center gap-2.5 rounded-md py-2 pr-7 transition-colors', child ? 'pl-8' : 'pl-2.5',
          item.to === activeTo
            ? 'bg-brand-600 text-white'
            : 'text-ink hover:bg-brand-100')}>
        <item.icon size={child ? 15 : 17} className={clsx('shrink-0 transition-colors', item.to === activeTo ? 'text-white' : 'text-ink-secondary')} />
        <span className="nav-label" title={item.label}>{item.label}</span>
      </Link>
      {item.to !== '/' && (
        <button type="button" onClick={() => toggleFav(item.to)} data-fav={item.to}
          title={isFav ? 'Remove from favourites' : 'Add to favourites'} aria-label={isFav ? `Unpin ${item.label}` : `Pin ${item.label}`}
          className={clsx('absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 transition-opacity',
            item.to === activeTo ? 'text-white' : isFav ? 'text-amber-600' : 'text-ink-secondary opacity-0 hover:text-amber-600 focus:opacity-100 group-hover:opacity-100')}>
          <Star size={12} fill={isFav ? 'currentColor' : 'none'} />
        </button>
      )}
    </div>
  );

  // Sidebar groups of the reference design; a step with no group (a role-unhidden old screen) goes under MORE.
  const dashboardItems = sections.find((sec) => sec.label === 'Overview')?.items ?? [];
  const grouped = [...NAV_GROUPS, 'MORE']
    .map((group) => ({ group, secs: sections.filter((sec) => sec.label !== 'Overview' && (sec.group ?? 'MORE') === group) }))
    .filter((g) => g.secs.length);

  // Collapsed rail: one icon per step; hover / focus opens a flyout with the step's screens (works as the tooltip).
  const [flyout, setFlyout] = useState<{ key: string; top: number } | null>(null);
  const flyTimer = useRef<number | undefined>(undefined);
  const openFly = (key: string, el: HTMLElement) => {
    window.clearTimeout(flyTimer.current);
    setFlyout({ key, top: Math.max(8, Math.min(el.getBoundingClientRect().top, window.innerHeight - 360)) });
  };
  const closeFly = () => { window.clearTimeout(flyTimer.current); flyTimer.current = window.setTimeout(() => setFlyout(null), 180); };
  const railSections: NavSection[] = steps.filter((sec) => sec.label !== 'Overview');
  const flySection = flyout && flyout.key !== '/' ? railSections.find((sec) => sec.label === flyout.key) : undefined;
  const railButton = (key: string, label: string, active: boolean, icon: ReactNode, to?: string) => {
    const props = {
      'aria-label': label, 'data-rail': key,
      onMouseEnter: (e: React.MouseEvent<HTMLElement>) => openFly(key, e.currentTarget), onMouseLeave: closeFly,
      onFocus: (e: React.FocusEvent<HTMLElement>) => openFly(key, e.currentTarget), onBlur: closeFly,
      className: clsx('grid h-10 w-10 shrink-0 place-items-center rounded-md transition-colors',
        active ? 'bg-brand-600 text-white' : 'text-ink-secondary hover:bg-brand-100 hover:text-ink'),
    };
    return to
      ? <Link key={key} to={to} aria-current={active ? 'page' : undefined} {...props}>{icon}</Link>
      : <button key={key} type="button" aria-expanded={flyout?.key === key} onClick={(e) => flyout?.key === key ? setFlyout(null) : openFly(key, e.currentTarget)} {...props}>{icon}</button>;
  };
  const flyoutPanel = flyout && (
    <div role="menu" aria-label={flySection ? flySection.menu ?? flySection.label : 'Dashboard'} id="rail-flyout"
      onMouseEnter={() => window.clearTimeout(flyTimer.current)} onMouseLeave={closeFly}
      onFocus={() => window.clearTimeout(flyTimer.current)} onBlur={closeFly}
      className="fixed left-[68px] z-50 max-h-[352px] w-60 overflow-y-auto rounded-lg border border-surface-border bg-white p-1.5 shadow-popover"
      style={{ top: flyout.top }}>
      {flySection ? <>
        <p className="nav-section px-2.5 py-1.5 uppercase text-ink-secondary">{flySection.menu ?? flySection.label}</p>
        {flySection.items.map((i) => (
          <Link key={i.to} role="menuitem" to={i.to} onClick={() => setFlyout(null)} aria-current={i.to === activeTo ? 'page' : undefined}
            className={clsx('nav-item flex items-center gap-2.5 rounded-md px-2.5 py-1.5', i.to === activeTo ? 'bg-brand-600 text-white' : 'text-ink hover:bg-brand-100')}>
            <i.icon size={15} className="shrink-0" /><span className="nav-label">{i.label}</span>
          </Link>
        ))}
      </> : <p className="px-2.5 py-1.5 text-body text-ink">Dashboard</p>}
    </div>
  );

  const rail = (
    <div className="flex h-full flex-col items-center border-r border-surface-border bg-surface-sidebar">
      <Link to="/" className="flex h-[62px] w-full shrink-0 items-center justify-center border-b border-surface-border text-lg font-bold tracking-tight text-ink-heading" aria-label="C-ONE ERP home">C1</Link>
      <nav aria-label="Main navigation" className="flex w-full flex-1 flex-col items-center gap-1 overflow-y-auto py-2" id="side-rail">
        {dashboardItems.map((i) => <Fragment key="/">{railButton('/', i.label, activeTo === '/', <i.icon size={18} />, '/')}{flyout?.key === '/' && flyoutPanel}</Fragment>)}
        {grouped.map(({ group, secs }) => (
          <div key={group} className="flex w-full flex-col items-center gap-1 border-t border-surface-border pt-1">
            {/* the flyout follows its icon in tab order, so Tab moves from the icon into its screens */}
            {secs.map((sec) => { const Icon = sec.icon ?? Menu; return <Fragment key={sec.label}>{railButton(sec.label, sec.menu ?? sec.label, sec.label === currentSection, <Icon size={18} />)}{flyout?.key === sec.label && flyoutPanel}</Fragment>; })}
          </div>
        ))}
      </nav>
    </div>
  );
  const sidebar = (
    <div className="flex h-full flex-col bg-surface-sidebar border-r border-surface-border text-ink">
      <div className="flex h-[62px] shrink-0 items-center border-b border-surface-border px-4">
        <Link to="/" onClick={() => setMobileOpen(false)} className="flex-1" aria-label="C-ONE ERP home">
          <p className="text-[23px] leading-7 tracking-tight text-ink-heading"><strong>C-ONE</strong> <span className="font-normal">ERP</span></p>
          <p className="text-micro text-ink-secondary">Garment Manufacturing</p>
        </Link>
        <button className="rounded-md p-1 text-ink-secondary hover:bg-brand-100 lg:hidden" onClick={() => setMobileOpen(false)} aria-label="Close menu">
          <X size={18} />
        </button>
      </div>

      <div className="shrink-0 px-3 py-2.5">
        <div className="relative">
          <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-secondary" />
          <input value={filter} onChange={(e) => setFilter(e.target.value)}
            aria-label="Filter navigation" placeholder="Find a screen…"
            className="w-full rounded-lg border border-surface-border bg-surface-muted/80 py-1.5 pl-8 pr-2.5 text-xs font-medium text-ink
                       placeholder:text-ink-secondary transition focus:bg-white focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-500/15" />
        </div>
      </div>

      <nav aria-label="Main navigation" className="flex-1 overflow-y-auto px-2.5 pb-4" id="side-nav">
        {!filter && favItems.length > 0 && (
          <div className="mb-2">
            <p className="nav-section flex items-center gap-1.5 px-2 py-1.5 uppercase text-ink-secondary"><Star size={12} /> Favourites</p>
            <div className="space-y-0.5" id="nav-favs">{favItems.map((item) => navLink(item, true))}</div>
          </div>
        )}
        {dashboardItems.map((item) => navLink(item, false))}
        {grouped.map(({ group, secs }) => (
          <div key={group} className="mt-3" data-group={group}>
            <p className="nav-section px-2.5 pb-1 uppercase text-ink-secondary">{group}</p>
            {secs.map((section) => {
              // searching opens every step; otherwise one step open at a time (the page's own step opens by itself)
              const open = !!filter || openSecs.includes(section.label);
              const current = section.label === currentSection;
              const Icon = section.icon;
              return (
                <div key={section.label}>
                  <button onClick={() => toggleSec(section.label)} aria-expanded={open} data-section={section.label}
                    data-current={current || undefined}
                    className={clsx('nav-item flex w-full items-center gap-2.5 rounded-md py-2 pl-2.5 pr-2 text-left transition-colors',
                      current ? 'bg-brand-50 text-brand-700' : 'text-ink hover:bg-brand-100')}>
                    {Icon && <Icon size={17} className={clsx('shrink-0', current ? 'text-brand-600' : 'text-ink-secondary')} />}
                    <span className="nav-label min-w-0 flex-1">{section.menu ?? section.label}</span>
                    <ChevronRight size={14} className={clsx('shrink-0 text-ink-secondary transition-transform', open && 'rotate-90')} />
                  </button>
                  {open && <div className="mb-1 mt-0.5 space-y-0.5">{section.items.map((item) => navLink(item, favs.includes(item.to), true))}</div>}
                </div>
              );
            })}
          </div>
        ))}
        {!sections.length && (
          <p className="px-3 py-6 text-center text-xs font-medium text-ink-secondary">No matching screens</p>
        )}
      </nav>
    </div>
  );

  return (
    <div className="flex h-dvh overflow-hidden">
      <a href="#main-content" className="sr-only focus:not-sr-only focus:absolute focus:z-[60] focus:bg-white focus:p-3">Skip to content</a>
      {/* Desktop sidebar */}
      {desktopOpen
        ? <aside className="app-sidebar hidden w-56 shrink-0 lg:block">{sidebar}</aside>
        : <aside className="app-sidebar hidden w-16 shrink-0 lg:block">{rail}</aside>}

      {/* Mobile drawer */}
      {mobileOpen && (
        <>
          <div className="fixed inset-0 z-40 bg-slate-900/50 lg:hidden" onClick={() => setMobileOpen(false)} />
          <aside className="app-sidebar fixed inset-y-0 left-0 z-50 w-[min(280px,85vw)] lg:hidden">{sidebar}</aside>
        </>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="app-header flex h-[62px] shrink-0 items-center gap-2 border-b border-surface-border bg-white px-3 sm:gap-3 sm:px-4">
          <button className="rounded-lg p-1.5 text-ink-secondary hover:bg-surface-hover lg:hidden"
            onClick={() => setMobileOpen(true)} aria-label="Open menu">
            <Menu size={19} />
          </button>

          <button className="hidden rounded-md p-2 text-ink-secondary hover:bg-surface-hover lg:block"
            onClick={() => setDesktopOpen((v) => !v)} aria-label={desktopOpen ? 'Collapse navigation' : 'Expand navigation'} aria-expanded={desktopOpen}>
            <Menu size={18} />
          </button>
          <div className="relative min-w-0 flex-initial basis-[535px]" onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setSearchOpen(false); }}>
            <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-secondary" />
            <input className="input pl-9" id="global-search" aria-label="Search records and screens" placeholder="Search anything (PO, Style, Job, Fabric, etc...)"
              value={globalSearch} onFocus={() => setSearchOpen(true)} autoComplete="off"
              onChange={(e) => { setGlobalSearch(e.target.value); setSearchOpen(true); }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setSearchOpen(false);
                if (e.key === 'Enter' && globalSearch.trim()) {
                  const first = recordHits[0]?.to ?? screenHits[0]?.to;
                  if (first) pickSearch(first);
                }
              }} />
            {searchOpen && globalSearch.trim() && (
              <div className="absolute left-0 top-full z-30 mt-1 max-h-[420px] w-[min(535px,85vw)] overflow-y-auto rounded-lg border border-surface-border bg-white p-1 shadow-popover" id="global-search-results">
                {recordGroups.map(([type, rows]) => (
                  <div key={type}>
                    <p className="nav-section px-3 pb-0.5 pt-2 uppercase text-ink-secondary">{type}</p>
                    {rows.map((r) => (
                      <Link key={`${r.type}-${r.id}`} to={r.to} onClick={() => { setSearchOpen(false); setGlobalSearch(''); }}
                        className="flex items-center gap-2 rounded px-3 py-1.5 text-body hover:bg-brand-100">
                        <FileText size={15} className="shrink-0 text-ink-secondary" />
                        <span className="min-w-0"><span className="block font-medium text-ink">{r.label}</span>{r.sub && <span className="block text-caption text-ink-secondary">{r.sub}</span>}</span>
                      </Link>
                    ))}
                  </div>
                ))}
                {screenHits.length > 0 && <p className="nav-section px-3 pb-0.5 pt-2 uppercase text-ink-secondary">Screens</p>}
                {screenHits.map((i) => (
                  <Link key={i.to} to={i.to} onClick={() => { setSearchOpen(false); setGlobalSearch(''); }} className="flex items-center gap-2 rounded px-3 py-1.5 text-body hover:bg-brand-100"><i.icon size={15} className="shrink-0 text-ink-secondary" />{i.label}</Link>
                ))}
                {(records.isFetching || searchTerm !== globalSearch.trim()) && globalSearch.trim().length >= 2 && <p className="px-3 py-2 text-small text-ink-secondary">Searching…</p>}
                {!records.isFetching && searchTerm === globalSearch.trim() && !recordHits.length && !screenHits.length && (
                  <p className="px-3 py-3 text-small text-ink-secondary">{globalSearch.trim().length < 2 ? 'Type at least 2 characters' : 'No matching records or screens'}</p>
                )}
              </div>
            )}
          </div>
          <div className="hidden flex-1 xl:block" />

          {/* Accessibility Font Sizer */}
          <div className="hidden xl:flex items-center rounded-lg border border-surface-border bg-surface-header/80 p-0.5" title="Adjust Text Size">
            <button
              type="button"
              title="Small font size"
              onClick={() => setTextSize('sm')}
              className={clsx(
                'rounded px-2 py-0.5 text-caption font-semibold transition-all',
                textSize === 'sm' ? 'bg-white text-brand-700 shadow-sm font-bold' : 'text-ink-secondary hover:text-ink'
              )}
            >
              A-
            </button>
            <button
              type="button"
              title="Default font size"
              onClick={() => setTextSize('md')}
              className={clsx(
                'rounded px-2 py-0.5 text-small font-semibold transition-all',
                textSize === 'md' ? 'bg-white text-brand-700 shadow-sm font-bold' : 'text-ink-secondary hover:text-ink'
              )}
            >
              A
            </button>
            <button
              type="button"
              title="Large font size"
              onClick={() => setTextSize('lg')}
              className={clsx(
                'rounded px-2 py-0.5 text-body font-semibold transition-all',
                textSize === 'lg' ? 'bg-white text-brand-700 shadow-sm font-bold' : 'text-ink-secondary hover:text-ink'
              )}
            >
              A+
            </button>
          </div>

          <div className="relative">
          <button className="relative rounded-lg p-2 text-ink-secondary hover:bg-surface-hover" aria-expanded={bellOpen} aria-label="Alerts" id="btn-bell" onClick={() => setBellOpen((v) => !v)}>
            <Bell size={17} />
            {unread > 0 && (
              <span className="absolute right-1 top-1 grid h-4 min-w-4 place-items-center rounded-full
                               bg-red-500 px-1 text-micro font-semibold text-white">
                {unread > 9 ? '9+' : unread}
              </span>
            )}
          </button>
          {bellOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setBellOpen(false)} />
              <div className="absolute right-0 top-full z-20 mt-1.5 w-[min(384px,90vw)] animate-fade-in rounded-xl border border-surface-border bg-white p-1.5 shadow-popover" id="bell-panel">
                <p className="px-3 py-2 text-caption font-semibold uppercase tracking-wider text-ink-secondary">Alerts</p>
                {(alerts ?? []).map((a) => (
                  <button key={a.key} onClick={() => { setBellOpen(false); goto(a.link); }}
                    className="flex w-full items-start gap-2 rounded-lg px-3 py-2 text-left hover:bg-surface-hover">
                    <span className={clsx('mt-1 h-2 w-2 shrink-0 rounded-full', a.severity === 'danger' ? 'bg-red-500' : a.severity === 'warning' ? 'bg-amber-500' : 'bg-sky-500')} />
                    <span><span className="block text-body font-semibold text-ink">{a.title}</span><span className="block text-small text-ink-secondary">{a.body}</span></span>
                  </button>
                ))}
                {!(alerts ?? []).length && <p className="px-3 py-2 text-small text-ink-muted">No alerts</p>}
              </div>
            </>
          )}
          </div>

          {/* Messages: the user's notifications */}
          <div className="relative">
            <button className="relative rounded-lg p-2 text-ink-secondary hover:bg-surface-hover" aria-expanded={msgOpen} aria-label="Messages" id="btn-messages" onClick={() => setMsgOpen((v) => !v)}>
              <MessageSquare size={17} />
              {unreadMsgs > 0 && <span className="absolute right-1 top-1 grid h-4 min-w-4 place-items-center rounded-full bg-brand-600 px-1 text-micro font-semibold text-white">{unreadMsgs > 9 ? '9+' : unreadMsgs}</span>}
            </button>
            {msgOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setMsgOpen(false)} />
                <div className="absolute right-0 top-full z-20 mt-1.5 w-[min(360px,90vw)] animate-fade-in rounded-xl border border-surface-border bg-white p-1.5 shadow-popover" id="messages-panel">
                  <div className="flex items-center justify-between px-3 py-2">
                    <p className="text-caption font-semibold uppercase tracking-wider text-ink-secondary">Messages</p>
                    {unreadMsgs > 0 && <button className="text-small text-brand-700 hover:underline" onClick={() => void markRead()}>Mark all read</button>}
                  </div>
                  <div className="max-h-80 overflow-y-auto">
                    {(notifications ?? []).map((n) => (
                      <button key={n.id} onClick={() => { if (!n.is_read) void markRead(n.id); }}
                        className="flex w-full items-start gap-2 rounded-lg px-3 py-2 text-left hover:bg-surface-hover">
                        <span className={clsx('mt-1.5 h-2 w-2 shrink-0 rounded-full', n.is_read ? 'bg-transparent' : 'bg-brand-600')} />
                        <span className="min-w-0"><span className={clsx('block text-body', n.is_read ? 'text-ink-secondary' : 'font-semibold text-ink')}>{n.title}</span>
                          {n.body && <span className="block text-small text-ink-secondary">{n.body}</span>}
                          <span className="block text-caption text-ink-secondary">{fmtDate(n.created_at)}</span></span>
                      </button>
                    ))}
                    {!(notifications ?? []).length && <p className="px-3 py-3 text-small text-ink-secondary">No messages</p>}
                  </div>
                </div>
              </>
            )}
          </div>

          {/* App launcher: every module the user can open */}
          <div className="relative hidden sm:block">
            <button className="rounded-lg p-2 text-ink-secondary hover:bg-surface-hover" aria-expanded={appsOpen} aria-label="All modules" id="btn-apps" onClick={() => setAppsOpen((v) => !v)}>
              <LayoutGrid size={17} />
            </button>
            {appsOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setAppsOpen(false)} />
                <div className="absolute right-0 top-full z-20 mt-1.5 max-h-[70vh] w-[min(420px,90vw)] overflow-y-auto animate-fade-in rounded-xl border border-surface-border bg-white p-3 shadow-popover" id="apps-panel">
                  {grouped.map(({ group, secs }) => (
                    <div key={group} className="mb-2">
                      <p className="nav-section px-1 pb-1 uppercase text-ink-secondary">{group}</p>
                      <div className="grid grid-cols-3 gap-1">
                        {secs.map((sec) => { const Icon = sec.icon ?? LayoutGrid; return (
                          <Link key={sec.label} to={sec.items[0].to} onClick={() => setAppsOpen(false)}
                            className="flex flex-col items-center gap-1 rounded-lg px-1 py-2 text-center text-small text-ink hover:bg-brand-100">
                            <span className="grid h-9 w-9 place-items-center rounded-lg bg-brand-100 text-brand-700"><Icon size={18} /></span>
                            <span className="leading-tight">{sec.menu ?? sec.label}</span>
                          </Link>
                        ); })}
                      </div>
                    </div>
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
              aria-label="Switch company" aria-expanded={companyDropdown}
              className="flex items-center gap-2 rounded-lg border border-surface-border bg-white px-3 py-1.5 text-left text-ink transition-all hover:bg-surface-muted hover:border-surface-input shadow-subtle"
              title={companies.length > 1 ? 'Click to switch company' : company?.legal_name}
            >
              <Building2 size={15} className="shrink-0 text-brand-600" />
              <div className="hidden max-w-[170px] truncate md:block">
                <p className="truncate text-small font-bold leading-tight text-ink">
                  {company?.trade_name || company?.legal_name || 'Select Company'}
                </p>
                {company?.gstin && (
                  <p className="tabular-nums text-micro font-semibold leading-tight text-ink-secondary">
                    GST: {company.gstin}
                  </p>
                )}
              </div>
              {companies.length > 1 && (
                <ChevronDown size={13} className="text-ink-secondary" />
              )}
            </button>

            {companyDropdown && companies.length > 1 && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setCompanyDropdown(false)} />
                <div className="absolute right-0 top-full z-20 mt-1.5 w-72 animate-fade-in rounded-xl border border-surface-border bg-white p-1.5 shadow-popover">
                  <p className="px-2.5 py-1 text-caption font-bold uppercase tracking-wider text-ink-secondary">
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
                              : 'hover:bg-surface-muted text-ink'
                          )}
                        >
                          <Building2
                            size={16}
                            className={clsx('mt-0.5 shrink-0', isCurrent ? 'text-brand-600' : 'text-ink-muted')}
                          />
                          <div className="flex-1 min-w-0">
                            <p className="truncate text-body font-bold text-ink">
                              {c.legal_name}
                            </p>
                            {c.trade_name && (
                              <p className="text-caption font-medium text-ink-secondary">{c.trade_name}</p>
                            )}
                            {c.gstin && (
                              <p className="tabular-nums text-micro font-medium text-ink-secondary">GST: {c.gstin}</p>
                            )}
                          </div>
                          {isCurrent && (
                            <span className="shrink-0 rounded bg-brand-200/60 px-1.5 py-0.5 text-micro font-bold text-brand-800">
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
            <button aria-label="User menu" aria-expanded={userMenu} onClick={() => setUserMenu((v) => !v)}
              className="flex items-center gap-2 rounded-lg py-1 pl-1 pr-2 hover:bg-surface-hover transition-colors">
              <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-brand-700 text-xs font-semibold text-white">
                {initials(user?.fullName ?? '?')}
              </div>
              <div className="hidden text-left sm:block">
                <p className="max-w-[140px] truncate text-body font-bold leading-tight text-ink">
                  {user?.fullName}
                </p>
                <p className="text-caption font-semibold leading-tight text-ink-secondary">
                  {user?.roles?.[0]?.replace(/_/g, ' ') ?? 'User'}
                </p>
              </div>
              <ChevronDown size={14} className="text-ink-secondary" />
            </button>

            {userMenu && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setUserMenu(false)} />
                <div className="absolute right-0 top-full z-20 mt-1.5 w-64 animate-fade-in rounded-xl border
                                border-surface-border bg-white p-1.5 shadow-popover">
                  <div className="border-b border-surface-border px-3 py-2.5">
                    <p className="text-body font-medium text-ink">{user?.fullName}</p>
                    <p className="text-caption text-ink-secondary">@{user?.username}</p>
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {user?.roles.map((r) => (
                        <span key={r} className="rounded bg-brand-50 px-1.5 py-0.5 text-micro font-medium text-brand-700">
                          {r.replace(/_/g, ' ')}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div className="border-b border-surface-border px-3 py-2 text-caption text-ink-secondary">
                    <span className="flex items-center gap-1.5 font-medium text-ink">
                      <Building2 size={12} className="text-brand-600" />{company?.trade_name || company?.legal_name}
                    </span>
                    {company?.gstin && <p className="mt-0.5 tabular-nums text-micro text-ink-muted">GST: {company.gstin}</p>}
                  </div>

                  {companies.length > 1 && (
                    <div className="border-b border-surface-border p-1.5">
                      <p className="px-2 py-1 text-micro font-semibold uppercase tracking-wider text-ink-muted">
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
                            'flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left text-small',
                            c.id === company?.id
                              ? 'bg-brand-50 font-semibold text-brand-700'
                              : 'text-ink-secondary hover:bg-surface-header hover:text-ink'
                          )}
                        >
                          <span className="truncate">{c.trade_name || c.legal_name}</span>
                          {c.id === company?.id && (
                            <span className="rounded bg-brand-200/60 px-1 text-micro font-bold text-brand-800">
                              Current
                            </span>
                          )}
                        </button>
                      ))}
                    </div>
                  )}

                  <div className="flex items-center justify-between gap-2 border-b border-surface-border px-3 py-2 xl:hidden">
                    <span className="text-xs text-ink-secondary">Text size</span>
                    {(['sm', 'md', 'lg'] as const).map((size, i) => <button key={size} aria-label={`${['Small', 'Default', 'Large'][i]} text size`} aria-pressed={textSize === size} onClick={() => setTextSize(size)} className={clsx('rounded px-2 py-1 text-xs', textSize === size ? 'bg-brand-100 text-brand-700' : 'text-ink-secondary')}>{['A−', 'A', 'A+'][i]}</button>)}
                  </div>

                  <button onClick={() => void logout()}
                    className="mt-1 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-body
                               text-red-600 hover:bg-red-50">
                    <LogOut size={15} /> Sign out
                  </button>
                </div>
              </>
            )}
          </div>
        </header>

        <main id="main-content" tabIndex={-1} key={location.pathname} className="min-w-0 flex-1 overflow-auto">
          <div className="mx-auto max-w-[1920px] p-3 sm:p-4">
            {stepBar}
            {tabGroup && (
              // Sewing / Checking / Ironing / Packing versions of the same screen, one click apart
              <div className="mb-4 flex gap-1 overflow-x-auto border-b border-surface-border" id="process-tabs">
                {tabGroup.tabs.filter((t) => allowed(t.to)).map((t) => (
                  <NavLink key={t.to} to={t.to} className={({ isActive }) => clsx('-mb-px whitespace-nowrap border-b-2 px-3.5 py-2 text-body font-medium',
                    isActive ? 'border-brand-600 text-brand-700' : 'border-transparent text-ink-secondary hover:text-ink')}>
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
