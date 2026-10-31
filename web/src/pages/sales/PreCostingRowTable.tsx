import type { ReactNode } from 'react';
import { Plus, Trash2 } from 'lucide-react';

/**
 * Editable row grid used by the Pre-Costing Cutting / Processes / Finishing &
 * Packing / Other Direct tabs. Enter on the last numeric cell of a row moves to
 * the next row, and on the last row adds a new one (same as the Sewing SMV list).
 */
export interface RowColumn {
  key: string;
  label: string;
  type: 'text' | 'number' | 'select';
  /** Fixed list, or per row (e.g. a master list plus the row's own older value). */
  options?: { value: string; label: string }[] | ((row: any) => { value: string; label: string }[]);
  step?: string;
  placeholder?: string;
  /** Cell is read-only for this row (e.g. consumption on a per-PC process). */
  disabled?: (row: any) => boolean;
  /** Extra text after the input (unit). */
  suffix?: (row: any) => ReactNode;
  width?: string;
}

interface Props {
  gridId: string;
  rows: any[];
  onChange: (rows: any[]) => void;
  columns: RowColumn[];
  newRow: () => any;
  amount: (row: any, index: number) => number;
  amountLabel?: string;
  totalLabel: string;
  total: number;
  addLabel: string;
  emptyText?: string;
}

const cellCls = 'rounded border border-surface-border px-1.5 py-0.5 text-xs disabled:bg-surface-header disabled:text-ink-muted';

export function PreCostingRowTable({
  gridId, rows, onChange, columns, newRow, amount, amountLabel = 'Cost / Pc (₹)',
  totalLabel, total, addLabel, emptyText = 'No rows yet — add one below.',
}: Props) {
  const lastNumericCol = columns.map((c) => c.type).lastIndexOf('number');

  const focusCell = (row: number, col = 0) => {
    setTimeout(() => {
      document.querySelector<HTMLElement>(`[data-grid="${gridId}"][data-row="${row}"][data-col="${col}"]`)?.focus();
    }, 0);
  };

  const addRow = () => {
    onChange([...rows, { _key: `${gridId}_${Date.now()}`, ...newRow() }]);
    focusCell(rows.length);
  };

  const setCell = (i: number, key: string, value: unknown) =>
    onChange(rows.map((r, idx) => (idx === i ? { ...r, [key]: value } : r)));

  return (
    <div className="space-y-2">
      <div className="overflow-x-auto rounded-lg border border-surface-border">
        <table className="w-full text-left text-xs tabular-nums">
          <thead className="bg-surface-muted text-ink font-sans font-bold border-b border-surface-border">
            <tr>
              <th className="py-2.5 px-3 w-8">#</th>
              {columns.map((c) => (
                <th key={c.key} className={`py-2.5 px-3 ${c.type === 'number' ? 'text-right' : ''}`}>{c.label}</th>
              ))}
              <th className="py-2.5 px-3 text-right">{amountLabel}</th>
              <th className="py-2.5 px-2 w-10" />
            </tr>
          </thead>
          <tbody className="divide-y divide-surface-divider">
            {rows.length === 0 && (
              <tr>
                <td colSpan={columns.length + 3} className="py-4 px-3 text-center font-sans text-ink-muted">{emptyText}</td>
              </tr>
            )}
            {rows.map((row, i) => (
              <tr key={row._key || i}>
                <td className="py-2 px-3 text-ink-muted">{i + 1}</td>
                {columns.map((c, j) => {
                  const disabled = c.disabled?.(row) ?? false;
                  const common = {
                    'data-grid': gridId, 'data-row': i, 'data-col': j, disabled,
                  };
                  return (
                    <td key={c.key} className={`py-1 px-2 ${c.type === 'number' ? 'text-right whitespace-nowrap' : 'font-sans'}`}>
                      {c.type === 'select' ? (
                        <select
                          {...common}
                          value={row[c.key] ?? ''}
                          onChange={(e) => setCell(i, c.key, e.target.value)}
                          className={`${cellCls} font-sans ${c.width ?? 'w-full'}`}
                        >
                          {(typeof c.options === 'function' ? c.options(row) : c.options ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </select>
                      ) : c.type === 'number' ? (
                        <>
                          <input
                            {...common}
                            type="number"
                            step={c.step ?? '0.01'}
                            value={disabled ? '' : (row[c.key] ?? '')}
                            placeholder={disabled ? '—' : c.placeholder}
                            onChange={(e) => setCell(i, c.key, e.target.value === '' ? '' : Number(e.target.value))}
                            onKeyDown={(e) => {
                              if (e.key !== 'Enter') return;
                              e.preventDefault();
                              if (j !== lastNumericCol) return;
                              if (i === rows.length - 1) addRow();
                              else focusCell(i + 1);
                            }}
                            className={`${cellCls} text-right tabular-nums font-bold text-brand-700 ${c.width ?? 'w-24'}`}
                          />
                          {c.suffix && <span className="ml-1 font-sans text-caption text-ink-secondary">{c.suffix(row)}</span>}
                        </>
                      ) : (
                        <input
                          {...common}
                          type="text"
                          value={row[c.key] ?? ''}
                          placeholder={c.placeholder}
                          onChange={(e) => setCell(i, c.key, e.target.value)}
                          className={`${cellCls} font-semibold text-ink ${c.width ?? 'w-full'}`}
                        />
                      )}
                    </td>
                  );
                })}
                <td className="py-2 px-3 text-right font-bold text-brand-900">₹{amount(row, i).toFixed(3)}</td>
                <td className="py-1 px-2 text-center">
                  <button
                    type="button"
                    title="Delete row"
                    className="text-ink-muted hover:text-rose-600"
                    onClick={() => onChange(rows.filter((_, idx) => idx !== i))}
                  >
                    <Trash2 size={13} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot className="bg-surface-muted font-bold border-t border-surface-border">
            <tr>
              <td colSpan={columns.length + 1} className="py-2.5 px-3 text-right font-sans">{totalLabel}</td>
              <td className="py-2.5 px-3 text-right text-brand-900 font-bold">₹{total.toFixed(2)}</td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
      <div className="flex items-center justify-between text-caption text-ink-secondary">
        <span>Press Enter in the last numeric cell to go to the next row (adds a row on the last one).</span>
        <button type="button" className="btn-secondary btn-xs flex items-center gap-1" onClick={addRow}>
          <Plus size={13} /> {addLabel}
        </button>
      </div>
    </div>
  );
}
