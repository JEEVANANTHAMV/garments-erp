import type { ReactNode } from 'react';

/**
 * Building blocks for the Yarn / Fabric PO line editor (client 04-Nov-2026: one long table row made every field a tiny,
 * overlapping box). Each PO line is a card; its fields sit in labelled rows on an auto-fill grid that adds or drops
 * columns with the space the card has (no fixed column widths), so nothing is clipped at 1024 px or overlaps at 1440 px.
 * DOM order = visual order = tab order: left → right, then the next row.
 */

/** One PO line: a header strip (line no + live summary), the field rows, then the amounts strip. */
export function PoLineCard({ index, summary, children, testId }: { index: number; summary?: ReactNode; children: ReactNode; testId: string }) {
  return (
    <div className="rounded-lg border border-surface-border bg-white shadow-xs" data-po-line={index} data-testid={testId}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-surface-divider bg-surface-muted/60 px-3 py-1.5 rounded-t-lg">
        <span className="inline-flex h-6 min-w-6 items-center justify-center rounded-full bg-white border border-surface-border px-2 text-caption font-bold text-ink tabular-nums">
          {index + 1}
        </span>
        <div className="min-w-0 flex-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-small text-ink-secondary">{summary}</div>
      </div>
      <div className="space-y-3 p-3">{children}</div>
    </div>
  );
}

/** A row of labelled fields; columns are ≥ 9.5rem wide and fill the card. */
export function PoLineRow({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))] gap-x-3 gap-y-2.5">{children}</div>;
}

/** A labelled field. `wide` takes two columns (item / composition names). */
export function PoLineField({ label, htmlFor, wide, children }: { label: ReactNode; htmlFor?: string; wide?: boolean; children: ReactNode }) {
  return (
    <div className={`min-w-0 ${wide ? 'col-span-2' : ''}`}>
      <label htmlFor={htmlFor} className="mb-1 block truncate text-caption font-semibold uppercase tracking-wide text-ink-secondary">
        {label}
      </label>
      {children}
    </div>
  );
}

/** Computed amounts of a line (read-only), right-aligned under the fields, with the line's actions at the end. */
export function PoLineAmounts({ items, actions }: { items: { label: string; value: ReactNode; strong?: boolean; tone?: string }[]; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-end gap-x-6 gap-y-2 border-t border-surface-divider pt-2.5">
      {items.map((it) => (
        <div key={it.label} className="text-right">
          <div className="text-caption font-semibold uppercase tracking-wide text-ink-secondary">{it.label}</div>
          <div className={`tabular-nums whitespace-nowrap ${it.strong ? 'text-body-lg font-bold' : 'text-body font-medium'} ${it.tone || 'text-ink'}`}>{it.value}</div>
        </div>
      ))}
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}
