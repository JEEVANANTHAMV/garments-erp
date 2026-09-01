import { type ReactNode } from 'react';
import { ArrowUpDown, ArrowUp, ArrowDown } from 'lucide-react';
import clsx from 'clsx';
import { LoadingBlock, EmptyState, ErrorState, Pager } from './ui';

export interface Column<T> {
  key: string;
  header: string;
  /** Cell renderer. Defaults to the raw value at `key`. */
  render?: (row: T) => ReactNode;
  /** Enables the sort control on this header. */
  sortable?: boolean;
  align?: 'left' | 'right' | 'center';
  width?: string;
  className?: string;
}

interface Props<T> {
  columns: Column<T>[];
  rows: T[];
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  rowKey: (row: T) => string | number;
  onRowClick?: (row: T) => void;
  emptyTitle?: string;
  emptyMessage?: string;
  emptyAction?: ReactNode;
  /** Server-side sorting. */
  sort?: { key: string; dir: 'asc' | 'desc' };
  onSort?: (key: string) => void;
  pagination?: { page: number; totalPages: number; total: number; pageSize: number };
  onPage?: (p: number) => void;
  /** Sticky first column for wide tables. */
  stickyFirst?: boolean;
}

export function DataTable<T>({
  columns, rows, loading, error, onRetry, rowKey, onRowClick,
  emptyTitle = 'Nothing here yet', emptyMessage, emptyAction,
  sort, onSort, pagination, onPage, stickyFirst,
}: Props<T>) {
  if (error) return <div className="card"><ErrorState error={error} onRetry={onRetry} /></div>;

  const align = (a?: string) => a === 'right' ? 'text-right' : a === 'center' ? 'text-center' : 'text-left';

  return (
    <div className="card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr>
              {columns.map((c, i) => (
                <th key={c.key}
                  className={clsx('th', align(c.align), c.width,
                    stickyFirst && i === 0 && 'sticky left-0 z-10 bg-surface-muted')}>
                  {c.sortable && onSort ? (
                    <button onClick={() => onSort(c.key)}
                      className="inline-flex items-center gap-1 hover:text-slate-700">
                      {c.header}
                      {sort?.key === c.key
                        ? (sort.dir === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />)
                        : <ArrowUpDown size={12} className="opacity-40" />}
                    </button>
                  ) : c.header}
                </th>
              ))}
            </tr>
          </thead>
          {!loading && rows.length > 0 && (
            <tbody>
              {rows.map((row) => (
                <tr key={rowKey(row)}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  className={clsx('row-hover', onRowClick && 'cursor-pointer')}>
                  {columns.map((c, i) => (
                    <td key={c.key}
                      className={clsx('td', align(c.align), c.className,
                        stickyFirst && i === 0 && 'sticky left-0 bg-white')}>
                      {c.render ? c.render(row) : renderValue((row as Record<string, unknown>)[c.key])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          )}
        </table>
      </div>

      {loading && <LoadingBlock rows={6} />}
      {!loading && rows.length === 0 && (
        <EmptyState title={emptyTitle} message={emptyMessage} action={emptyAction} />
      )}
      {pagination && onPage && !loading && (
        <Pager {...pagination} onPage={onPage} />
      )}
    </div>
  );
}

function renderValue(v: unknown): ReactNode {
  if (v === null || v === undefined || v === '') return <span className="text-slate-300">—</span>;
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'object') return <span className="text-slate-500 text-xs font-mono">{JSON.stringify(v)}</span>;
  return String(v);
}
