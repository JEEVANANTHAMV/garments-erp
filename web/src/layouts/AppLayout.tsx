import { useState, useMemo } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import {
  Menu, X, LogOut, ChevronDown, Search, Bell, Building2, User as UserIcon,
} from 'lucide-react';
import clsx from 'clsx';
import { useAuth } from '../lib/auth';
import { NAV } from '../lib/nav';
import { initials } from '../lib/format';
import { useQuery } from '@tanstack/react-query';
import { http } from '../lib/api';

export default function AppLayout() {
  const { user, company, logout, canAny } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [userMenu, setUserMenu] = useState(false);
  const [filter, setFilter] = useState('');
  const location = useLocation();

  // Only render sections the user can actually reach.
  const sections = useMemo(() => NAV
    .map((s) => ({ ...s, items: s.items.filter((i) => canAny(...i.perms)) }))
    .filter((s) => s.items.length)
    .map((s) => filter
      ? { ...s, items: s.items.filter((i) => i.label.toLowerCase().includes(filter.toLowerCase())) }
      : s)
    .filter((s) => s.items.length),
    [canAny, filter, user]);

  const { data: notifications } = useQuery({
    queryKey: ['notifications'],
    queryFn: async () => (await http.get<{ data: { id: number; title: string; body: string; is_read: number }[] }>('/admin/notifications')).data,
    refetchInterval: 60_000,
  });
  const unread = (notifications ?? []).filter((n) => !n.is_read).length;

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

      <nav className="flex-1 overflow-y-auto px-2.5 pb-4">
        {sections.map((section) => (
          <div key={section.label} className="mb-3">
            <p className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
              {section.label}
            </p>
            <div className="space-y-0.5">
              {section.items.map((item) => (
                <NavLink key={item.to} to={item.to} end={item.to === '/'}
                  onClick={() => setMobileOpen(false)}
                  className={({ isActive }) => clsx(
                    'flex items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-[12.5px] transition-colors',
                    isActive
                      ? 'bg-brand-600 font-medium text-white'
                      : 'text-slate-400 hover:bg-white/5 hover:text-slate-100')}>
                  <item.icon size={15} className="shrink-0" />
                  <span className="truncate">{item.label}</span>
                </NavLink>
              ))}
            </div>
          </div>
        ))}
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

          <button className="relative rounded-lg p-2 text-slate-500 hover:bg-surface-hover" aria-label="Notifications">
            <Bell size={17} />
            {unread > 0 && (
              <span className="absolute right-1 top-1 grid h-4 min-w-4 place-items-center rounded-full
                               bg-red-500 px-1 text-[9px] font-semibold text-white">
                {unread > 9 ? '9+' : unread}
              </span>
            )}
          </button>

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
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
