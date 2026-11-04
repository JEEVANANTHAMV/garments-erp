import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Search } from 'lucide-react';

/**
 * Type-to-search for every dropdown in the app (client voice notes 04-Nov-2026: "wherever we click a dropdown,
 * let us type a couple of words and pick what is already there — lists get long").
 *
 * Mounted once at the app root. Any single-choice native <select> opens this searchable list instead of the
 * browser's own list: on click, on a typed letter, or on Alt+↓ / F4 / Enter / Space. The choice is written back to
 * the real <select> and a normal `change` event is fired, so every screen's existing onChange logic, validation,
 * forms and tests keep working unchanged.
 *
 * Opt out per element with `data-native-select` (or on any ancestor). Multi-selects, list boxes (size > 1) and
 * touch-first devices (phones / tablets keep their native picker) are left alone.
 */

type Item = { kind: 'option'; index: number; label: string; value: string; disabled: boolean; group?: string }
  | { kind: 'group'; label: string };

const MAX_ROWS = 300;

const eligible = (el: EventTarget | null): HTMLSelectElement | null => {
  const sel = el instanceof HTMLSelectElement ? el : (el instanceof HTMLOptionElement ? el.parentElement?.closest('select') ?? null : null);
  if (!sel || sel.multiple || sel.size > 1 || sel.disabled) return null;
  if (sel.closest('[data-native-select]')) return null;
  return sel;
};

const readItems = (sel: HTMLSelectElement): Item[] => {
  const out: Item[] = [];
  let lastGroup: string | undefined;
  Array.from(sel.options).forEach((o, index) => {
    if (o.hidden || o.style.display === 'none') return;
    const g = o.parentElement instanceof HTMLOptGroupElement ? o.parentElement : null;
    const group = g?.label || undefined;
    if (group && group !== lastGroup) out.push({ kind: 'group', label: group });
    lastGroup = group;
    out.push({ kind: 'option', index, label: (o.label || o.text).trim(), value: o.value, disabled: o.disabled || !!g?.disabled, group });
  });
  return out;
};

/** every typed word must appear somewhere in the option (or its group), in any order */
const matches = (it: Extract<Item, { kind: 'option' }>, words: string[]) => {
  if (!words.length) return true;
  const hay = `${it.label} ${it.group ?? ''}`.toLowerCase();
  return words.every((w) => hay.includes(w));
};

export function chooseOption(sel: HTMLSelectElement, index: number) {
  if (sel.selectedIndex === index) return;
  sel.selectedIndex = index;
  // React's onChange for <select> listens to the native change event
  sel.dispatchEvent(new Event('input', { bubbles: true }));
  sel.dispatchEvent(new Event('change', { bubbles: true }));
}

export function SelectSearch() {
  const [sel, setSel] = useState<HTMLSelectElement | null>(null);
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<Item[]>([]);
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{ left: number; width: number; top?: number; bottom?: number; maxH: number } | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const input = useRef<HTMLInputElement>(null);

  const open = useCallback((s: HTMLSelectElement, seed = '') => {
    s.focus({ preventScroll: true });
    setItems(readItems(s));
    setQuery(seed);
    setSel(s);
  }, []);

  const close = useCallback((refocus = true) => {
    setSel((s) => { if (s && refocus && document.contains(s)) s.focus({ preventScroll: true }); return null; });
    setPos(null);
  }, []);

  // open on click / typed letter instead of the browser's own list
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const coarse = window.matchMedia?.('(pointer: coarse)').matches && !window.matchMedia?.('(any-pointer: fine)').matches;
    if (coarse) return;
    const onDown = (e: MouseEvent) => {
      if (e.button !== 0 || e.ctrlKey || e.metaKey) return;
      const s = eligible(e.target);
      if (!s) return;
      e.preventDefault();
      if (sel === s) { close(); return; }
      open(s);
    };
    const onKey = (e: KeyboardEvent) => {
      const s = eligible(e.target);
      if (!s || e.ctrlKey || e.metaKey) return;
      const typed = e.key.length === 1 && !e.altKey && e.key !== ' ';
      const opener = e.key === 'F4' || (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) || e.key === 'Enter' || e.key === ' ';
      if (!typed && !opener) return;
      e.preventDefault();
      open(s, typed ? e.key : '');
    };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => { document.removeEventListener('mousedown', onDown, true); document.removeEventListener('keydown', onKey, true); };
  }, [sel, open, close]);

  // while open: follow option changes (async lists), close on outside click / the select leaving the page
  useEffect(() => {
    if (!sel) return;
    const mo = new MutationObserver(() => {
      if (!document.contains(sel) || sel.disabled) { close(false); return; }
      setItems(readItems(sel));
    });
    mo.observe(sel, { childList: true, subtree: true, attributes: true, characterData: true });
    const parent = sel.parentElement;
    const pmo = parent ? new MutationObserver(() => { if (!document.contains(sel)) close(false); }) : null;
    if (parent) pmo!.observe(parent, { childList: true });
    const onOutside = (e: MouseEvent) => {
      const t = e.target as Node;
      if (panel.current?.contains(t) || t === sel) return;
      close(false);
    };
    document.addEventListener('mousedown', onOutside);
    return () => { mo.disconnect(); pmo?.disconnect(); document.removeEventListener('mousedown', onOutside); };
  }, [sel, close]);

  // the list floats above everything (fixed portal) — a card with overflow hidden or a modal can't clip it
  useLayoutEffect(() => {
    if (!sel) return;
    const place = () => {
      if (!document.contains(sel)) { close(false); return; }
      const r = sel.getBoundingClientRect();
      if (r.bottom < 0 || r.top > window.innerHeight) { close(false); return; }
      const below = window.innerHeight - r.bottom - 8, above = r.top - 8;
      const up = below < 260 && above > below;
      const width = Math.min(Math.max(r.width, 280), 520, window.innerWidth - 16);
      setPos({
        left: Math.max(8, Math.min(r.left, window.innerWidth - width - 8)), width,
        ...(up ? { bottom: window.innerHeight - r.top + 4 } : { top: r.bottom + 4 }),
        maxH: Math.max(120, Math.min(340, (up ? above : below) - 56)),
      });
    };
    place();
    const onScroll = (e: Event) => { if (panel.current && e.target instanceof Node && panel.current.contains(e.target)) return; place(); };
    window.addEventListener('resize', place);
    window.addEventListener('scroll', onScroll, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', onScroll, true); };
  }, [sel, close]);

  const words = useMemo(() => query.trim().toLowerCase().split(/\s+/).filter(Boolean), [query]);
  const shown = useMemo(() => {
    const opts = items.filter((i): i is Extract<Item, { kind: 'option' }> => i.kind === 'option' && matches(i, words));
    const total = opts.length;
    const keep = new Set(opts.slice(0, MAX_ROWS).map((o) => o.index));
    // keep group headings that still have a visible option
    const rows: Item[] = [];
    let pendingGroup: Item | null = null;
    for (const it of items) {
      if (it.kind === 'group') { pendingGroup = it; continue; }
      if (!keep.has(it.index)) continue;
      if (pendingGroup && it.group === pendingGroup.label) { rows.push(pendingGroup); pendingGroup = null; }
      rows.push(it);
    }
    return { rows, total, options: rows.filter((r): r is Extract<Item, { kind: 'option' }> => r.kind === 'option') };
  }, [items, words]);

  // highlight: the current value when opened without typing, else the first match
  useEffect(() => {
    if (!sel) return;
    const opts = shown.options;
    const cur = !words.length ? opts.findIndex((o) => o.index === sel.selectedIndex) : -1;
    const first = cur >= 0 ? cur : opts.findIndex((o) => !o.disabled);
    setActive(Math.max(0, first));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel, words.join(' ')]);

  useEffect(() => { if (sel && pos) input.current?.focus({ preventScroll: true }); }, [sel, pos]);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-ss-active="true"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active, shown]);

  if (!sel || !pos) return null;

  const pick = (o: Extract<Item, { kind: 'option' }> | undefined) => {
    if (!o || o.disabled) return;
    chooseOption(sel, o.index);
    close();
  };
  const step = (dir: 1 | -1) => {
    const opts = shown.options;
    if (!opts.length) return;
    let i = active;
    for (let n = 0; n < opts.length; n++) {
      i = (i + dir + opts.length) % opts.length;
      if (!opts[i].disabled) break;
    }
    setActive(i);
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const stop = () => { e.preventDefault(); e.stopPropagation(); e.nativeEvent.stopImmediatePropagation(); };
    if (e.key === 'ArrowDown') { stop(); step(1); }
    else if (e.key === 'ArrowUp') { stop(); step(-1); }
    else if (e.key === 'PageDown') { stop(); setActive((a) => Math.min(shown.options.length - 1, a + 8)); }
    else if (e.key === 'PageUp') { stop(); setActive((a) => Math.max(0, a - 8)); }
    else if (e.key === 'Enter') { stop(); pick(shown.options[active]); }
    else if (e.key === 'Escape') { stop(); close(); }
    else if (e.key === 'Tab') { stop(); if (words.length) pick(shown.options[active]); else close(); }
  };

  const listId = 'select-search-list';
  const activeOpt = shown.options[active];
  return createPortal(
    <div ref={panel} id="select-search" role="dialog" aria-label="Search the list"
      className="fixed z-[80] flex flex-col overflow-hidden rounded-lg border border-surface-border bg-white shadow-popover"
      style={{ left: pos.left, width: pos.width, top: pos.top, bottom: pos.bottom }}
      onMouseDown={(e) => { if (e.target !== input.current) e.preventDefault(); }}>
      <div className="flex items-center gap-2 border-b border-surface-border px-2.5 py-1.5">
        <Search size={14} className="shrink-0 text-ink-muted" aria-hidden="true" />
        <input ref={input} id="select-search-input" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onKeyDown}
          placeholder="Type to search…" autoComplete="off" spellCheck={false}
          role="combobox" aria-expanded="true" aria-controls={listId} aria-autocomplete="list"
          aria-activedescendant={activeOpt ? `ss-opt-${activeOpt.index}` : undefined}
          className="min-w-0 flex-1 border-0 bg-transparent py-1 text-body text-ink outline-none placeholder:text-ink-muted" />
        <span className="shrink-0 text-caption tabular-nums text-ink-muted" aria-live="polite">
          {words.length ? `${shown.total} found` : `${shown.total}`}
        </span>
      </div>
      <ul ref={list} id={listId} role="listbox" className="overflow-y-auto py-1" style={{ maxHeight: pos.maxH }}>
        {shown.rows.map((r, i) => r.kind === 'group'
          ? <li key={`g-${r.label}-${i}`} role="presentation" className="px-3 pb-0.5 pt-2 text-caption font-semibold uppercase tracking-wide text-ink-muted">{r.label}</li>
          : (() => {
              const on = activeOpt?.index === r.index;
              const current = sel.selectedIndex === r.index;
              return <li key={r.index} id={`ss-opt-${r.index}`} role="option" aria-selected={current} aria-disabled={r.disabled || undefined}
                data-ss-active={on || undefined} data-value={r.value}
                className={`cursor-pointer px-3 py-1.5 text-body ${r.group ? 'pl-5' : ''} ${r.disabled ? 'cursor-not-allowed text-ink-disabled' : on ? 'bg-brand-50 text-ink-heading' : 'text-ink'} ${current ? 'font-semibold' : ''}`}
                onMouseEnter={() => { if (!r.disabled) setActive(shown.options.indexOf(r)); }}
                onClick={() => pick(r)}>
                {r.label || <span className="text-ink-muted">(blank)</span>}
              </li>;
            })())}
        {!shown.options.length && <li className="px-3 py-3 text-small text-ink-muted">No match for “{query.trim()}”</li>}
        {shown.total > MAX_ROWS && <li className="px-3 py-2 text-caption text-ink-muted">Showing {MAX_ROWS} of {shown.total} — type more to narrow</li>}
      </ul>
    </div>,
    document.body,
  );
}
