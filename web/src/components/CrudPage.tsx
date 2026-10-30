import { useEffect, useState, type ReactNode } from 'react';
import { Plus, Pencil, Trash2, Filter as FilterIcon } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { useList, useSave, useRemove, useListState } from '../hooks/useResource';
import { useLookup, toOptions, toPlainOptions, useStatuses } from '../hooks/useLookup';
import { DataTable, type Column } from './DataTable';
import {
  PageHeader, Modal, FormSection, ConfirmDialog, SearchInput, Input, Select, Textarea,
  Checkbox, Spinner, useDebounced,
} from './ui';
import { ApiError } from '../lib/api';
import { toDateInput } from '../lib/format';

/** One editable field on the generated form. */
export interface FormField {
  name: string;
  label: string;
  type?: 'text' | 'number' | 'date' | 'time' | 'textarea' | 'select' | 'checkbox' | 'email' | 'color';
  required?: boolean;
  /** Static options for a select. */
  options?: { value: string | number; label: string }[];
  /** Lookup endpoint name — options are fetched and cached. */
  lookup?: string;
  /** Status domain — loads cfg_status rows for that domain. */
  statusDomain?: string;
  /** Grid span out of 2 columns. */
  span?: 1 | 2;
  hint?: string;
  placeholder?: string;
  step?: string;
  /** Default applied when creating a new record — a function is evaluated when the form opens (e.g. now). */
  defaultValue?: string | number | boolean | (() => string | number | boolean);
  /** Shown but not editable (e.g. a system-stamped date / time). */
  readOnly?: boolean;
  /**
   * Lookup select only: when a row is picked, other form fields are filled from it — { targetField: rowKey }
   * (e.g. picking the job fills io_no / style_id / buyer_po_no). Cleared when the select is cleared.
   */
  fill?: Record<string, string>;
  /**
   * Scan box: a scanned / typed (Enter) / pasted code is looked up and the returned values fill the form
   * (e.g. the DC barcode on a gate pass). A warning is shown under the box; the values still fill.
   */
  scan?: (code: string) => Promise<{ values: Record<string, unknown>; warning?: string }>;
}

/** A filter control rendered above the table. */
export interface FilterDef {
  name: string;
  label: string;
  options?: { value: string | number; label: string }[];
  lookup?: string;
  statusDomain?: string;
}

export interface CrudConfig<T> {
  /** API path segment, e.g. 'parties'. */
  path: string;
  title: string;
  subtitle?: string;
  /** Permission prefix, e.g. 'PARTY'. */
  permission: string;
  singular: string;
  columns: Column<T>[];
  fields: FormField[];
  filters?: FilterDef[];
  searchPlaceholder?: string;
  defaultSort?: { key: string; dir: 'asc' | 'desc' };
  /** Extra query params always sent with the list request. */
  baseParams?: Record<string, unknown>;
  /** Custom handler for creating a new record (e.g. navigate to dedicated form). */
  onNew?: () => void;
  /** Row click handler — omit to open the edit modal. */
  onRowClick?: (row: T) => void;
  /** Extra header buttons. */
  headerActions?: ReactNode;
  /** Shown between the page header and the search bar (e.g. role tabs). */
  toolbar?: ReactNode;
  /** Transform a record into form values when editing. */
  toForm?: (row: T) => Record<string, unknown>;
  /** Transform form values into the API payload. */
  toPayload?: (values: Record<string, unknown>) => Record<string, unknown>;
  modalSize?: 'sm' | 'md' | 'lg' | 'xl';
  /** Opens the "new" form pre-filled (e.g. from a scanned DC barcode); a new `key` opens it again. */
  newWith?: { key: number; values: Record<string, unknown> } | null;
}

export function CrudPage<T extends { id: number }>(cfg: CrudConfig<T>) {
  const { can } = useAuth();
  const { page, setPage, search, setSearch, sort, onSort } = useListState(cfg.defaultSort);
  const debounced = useDebounced(search);
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [showFilters, setShowFilters] = useState(false);
  const [editing, setEditing] = useState<T | null | undefined>(undefined);  // undefined = closed, null = new
  const [deleting, setDeleting] = useState<T | null>(null);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  const activeFilters = Object.entries(filters).filter(([, v]) => v !== '');

  const query = useList<T>(cfg.path, {
    page, pageSize: 25, q: debounced || undefined,
    sort: sort.key, dir: sort.dir,
    ...cfg.baseParams,
    ...Object.fromEntries(activeFilters),
  });

  const save = useSave<T>(cfg.path, cfg.singular);
  const remove = useRemove(cfg.path, cfg.singular);

  const openNew = () => {
    const init: Record<string, unknown> = {};
    for (const f of cfg.fields) {
      if (f.defaultValue !== undefined) init[f.name] = typeof f.defaultValue === 'function' ? f.defaultValue() : f.defaultValue;
    }
    setValues(init); setErrors({}); setEditing(null);
  };

  useEffect(() => {
    if (!cfg.newWith) return;
    const init: Record<string, unknown> = {};
    for (const f of cfg.fields) {
      if (f.defaultValue !== undefined) init[f.name] = typeof f.defaultValue === 'function' ? f.defaultValue() : f.defaultValue;
    }
    setValues({ ...init, ...cfg.newWith.values }); setErrors({}); setEditing(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg.newWith?.key]);

  const openEdit = (row: T) => {
    const v = cfg.toForm ? cfg.toForm(row) : { ...(row as Record<string, unknown>) };
    for (const f of cfg.fields) {
      if (f.type === 'date') v[f.name] = toDateInput(v[f.name]);
    }
    setValues(v); setErrors({}); setEditing(row);
  };

  const submit = async () => {
    setErrors({});
    const errs: Record<string, string> = {};
    for (const f of cfg.fields) {
      if (f.required && !f.readOnly) {
        const val = values[f.name];
        if (val === undefined || val === null || val === '' || (typeof val === 'string' && val.trim() === '')) {
          errs[f.name] = `${f.label} is required`;
        }
      }
    }
    if (Object.keys(errs).length > 0) {
      setErrors(errs);
      return;
    }
    const payload = cfg.toPayload ? cfg.toPayload(values) : values;
    try {
      await save.mutateAsync({ id: editing?.id ?? null, body: payload });
      setEditing(undefined);
    } catch (e) {
      if (e instanceof ApiError) setErrors(e.fieldErrors);
    }
  };

  const columns: Column<T>[] = [
    ...cfg.columns,
    ...(can(`${cfg.permission}.UPDATE`) || can(`${cfg.permission}.DELETE`) ? [{
      key: '__actions', header: '', align: 'right' as const, width: 'w-24',
      render: (row: T) => (
        <div className="flex justify-end gap-0.5" onClick={(e) => e.stopPropagation()}>
          {can(`${cfg.permission}.UPDATE`) && (
            <button onClick={() => openEdit(row)} title="Edit"
              className="rounded-md p-1.5 text-slate-400 hover:bg-brand-50 hover:text-brand-700 transition-colors">
              <Pencil size={14} />
            </button>
          )}
          {can(`${cfg.permission}.DELETE`) && (
            <button onClick={() => setDeleting(row)} title="Delete"
              className="rounded-md p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600 transition-colors">
              <Trash2 size={14} />
            </button>
          )}
        </div>
      ),
    }] : []),
  ];

  return (
    <>
      <PageHeader title={cfg.title} subtitle={cfg.subtitle}
        actions={<>
          {cfg.headerActions}
          {can(`${cfg.permission}.CREATE`) && (
            <button className="btn-primary" onClick={cfg.onNew ?? openNew}>
              <Plus size={15} /> New {cfg.singular}
            </button>
          )}
        </>} />
      {cfg.toolbar}

      <div className="mb-3.5 flex flex-wrap items-center gap-2">
        <SearchInput value={search} onChange={setSearch}
          placeholder={cfg.searchPlaceholder ?? `Search ${cfg.title.toLowerCase()}…`}
          className="w-full max-w-sm" />
        {cfg.filters?.length ? (
          <button className={`btn-secondary ${activeFilters.length ? 'border-brand-500 bg-brand-50 text-brand-800 font-semibold' : ''}`}
            onClick={() => setShowFilters((v) => !v)}>
            <FilterIcon size={14} /> Filters
            {activeFilters.length > 0 && (
              <span className="ml-0.5 rounded-full bg-brand-600 px-1.5 text-[10px] text-white">
                {activeFilters.length}
              </span>
            )}
          </button>
        ) : null}
        {activeFilters.length > 0 && (
          <button className="btn-ghost btn-sm" onClick={() => { setFilters({}); setPage(1); }}>
            Clear all
          </button>
        )}
      </div>

      {showFilters && cfg.filters?.length ? (
        <div className="card mb-3 grid grid-cols-1 gap-3 p-3.5 sm:grid-cols-2 lg:grid-cols-4">
          {cfg.filters.map((f) => (
            <FilterControl key={f.name} def={f} value={filters[f.name] ?? ''}
              onChange={(v) => { setFilters((s) => ({ ...s, [f.name]: v })); setPage(1); }} />
          ))}
        </div>
      ) : null}

      <DataTable
        columns={columns}
        rows={query.data?.data ?? []}
        loading={query.isLoading}
        error={query.error}
        onRetry={() => void query.refetch()}
        rowKey={(r) => r.id}
        onRowClick={cfg.onRowClick ?? (can(`${cfg.permission}.UPDATE`) ? openEdit : undefined)}
        sort={sort} onSort={onSort}
        pagination={query.data?.pagination}
        onPage={setPage}
        emptyTitle={`No ${cfg.title.toLowerCase()} found`}
        emptyMessage={search || activeFilters.length
          ? 'Try adjusting your search or filters.'
          : `Get started by creating your first ${cfg.singular.toLowerCase()}.`}
        emptyAction={can(`${cfg.permission}.CREATE`) && !search && !activeFilters.length
          ? <button className="btn-primary" onClick={cfg.onNew ?? openNew}><Plus size={15} /> New {cfg.singular}</button>
          : undefined}
      />

      <Modal
        open={editing !== undefined}
        onClose={() => setEditing(undefined)}
        title={editing ? `Edit ${cfg.singular}` : `New ${cfg.singular}`}
        size={cfg.modalSize ?? defaultModalSize(cfg.fields)}
        footer={<>
          <button className="btn-secondary" onClick={() => setEditing(undefined)} disabled={save.isPending}>
            Cancel
          </button>
          <button className="btn-primary" onClick={() => void submit()} disabled={save.isPending}>
            {save.isPending && <Spinner size={14} />}
            {editing ? 'Save changes' : `Create ${cfg.singular.toLowerCase()}`}
          </button>
        </>}>
        {/* fields are locked while the save is in flight */}
        <fieldset disabled={save.isPending} aria-busy={save.isPending} className="min-w-0">
          <FormSection cols={2}>
            {cfg.fields.map((f) => (
              <FormControl key={f.name} field={f}
                value={values[f.name]}
                error={errors[f.name]}
                onScanned={(vals, warning) => {
                  setValues((s) => ({ ...s, ...vals }));
                  setErrors((prev) => {
                    const next = { ...prev };
                    for (const k of Object.keys(vals)) delete next[k];
                    if (warning) next[f.name] = warning; else delete next[f.name];
                    return next;
                  });
                }}
                onChange={(v, row) => {
                  setValues((s) => ({
                    ...s, [f.name]: v,
                    ...(f.fill ? Object.fromEntries(Object.entries(f.fill).map(([t, k]) => [t, row ? (row[k] ?? null) : v == null ? null : s[t]])) : {}),
                  }));
                  if (errors[f.name]) {
                    setErrors((prev) => {
                      const next = { ...prev };
                      delete next[f.name];
                      return next;
                    });
                  }
                }} />
            ))}
          </FormSection>
        </fieldset>
      </Modal>

      <ConfirmDialog
        open={!!deleting}
        title={`Delete ${cfg.singular.toLowerCase()}?`}
        message={`This will remove the ${cfg.singular.toLowerCase()}. Records referenced elsewhere cannot be deleted.`}
        busy={remove.isPending}
        onCancel={() => setDeleting(null)}
        onConfirm={async () => {
          if (deleting) await remove.mutateAsync(deleting.id).catch(() => {});
          setDeleting(null);
        }} />
    </>
  );
}

/** A scan box on the form: Enter, a paste or leaving the box looks the code up once and fills the form. */
function ScanControl({ field, span, value, error, onChange, onScanned }: {
  field: FormField; span: string; value: unknown; error?: string; onChange: (v: unknown) => void;
  onScanned?: (values: Record<string, unknown>, warning?: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState('');
  const [typed, setTyped] = useState(false);   // leaving the box looks up only what was typed here
  const run = async (raw: string) => {
    const code = raw.trim();
    if (!code || code === done || busy || !field.scan) return;
    setBusy(true); setTyped(false);
    try {
      const r = await field.scan(code);
      setDone(String(r.values[field.name] ?? code));
      onScanned?.(r.values, r.warning);
    } catch (e) {
      setDone(code);
      onScanned?.({ [field.name]: code }, e instanceof ApiError ? e.message : 'Not found');
    } finally { setBusy(false); }
  };
  return <Input className={span} label={field.label} error={error} required={field.required}
    hint={busy ? 'Looking up…' : field.hint} placeholder={field.placeholder} autoComplete="off"
    value={(value as string) ?? ''}
    onChange={(e) => { setTyped(true); onChange(e.target.value === '' ? null : e.target.value); }}
    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void run(e.currentTarget.value); } }}
    onPaste={(e) => { const t = e.clipboardData.getData('text'); if (t.trim()) { e.preventDefault(); onChange(t.trim()); void run(t); } }}
    onBlur={(e) => { if (typed) void run(e.currentTarget.value); }} />;
}

/** Popup width when the screen does not set one: confirmations-sized for ≤3 fields, wider for long forms. */
function defaultModalSize(fields: FormField[]): 'sm' | 'md' | 'lg' {
  if (fields.length <= 3 && !fields.some((f) => f.type === 'textarea' || f.span === 2)) return 'sm';
  return fields.length > 12 ? 'lg' : 'md';
}

/* ----------------------------------------------------- field renderers */

function FormControl({ field, value, error, onChange, onScanned }: {
  field: FormField; value: unknown; error?: string; onChange: (v: unknown, row?: any) => void;
  onScanned?: (values: Record<string, unknown>, warning?: string) => void;
}) {
  const lookup = useLookup(field.lookup ?? null, !!field.lookup);
  const statuses = useStatuses(field.statusDomain ?? '');
  const span = field.span === 2 || field.type === 'textarea' ? 'sm:col-span-2' : '';

  let options = field.options
    ?? (field.lookup ? toOptions(lookup.data) : undefined)
    ?? (field.statusDomain ? toPlainOptions(statuses.data) : undefined);
  // A value saved before the field became a fixed list (typed text on an old record) still shows and is kept.
  if (field.options && value != null && value !== '' && !field.options.some((o) => String(o.value) === String(value))) {
    options = [...field.options, { value: value as string | number, label: `${value} (current)` }];
  }

  if (field.scan) return <ScanControl field={field} span={span} value={value} error={error} onChange={onChange} onScanned={onScanned} />;

  if (field.type === 'checkbox') {
    return (
      <div className={`flex items-end pb-1.5 ${span}`}>
        <Checkbox label={field.label} checked={!!value && value !== 0 && value !== '0'}
          onChange={(v) => onChange(v ? 1 : 0)} />
      </div>
    );
  }

  if (field.type === 'textarea') {
    return <Textarea className={span} label={field.label} error={error} required={field.required}
      hint={field.hint} placeholder={field.placeholder}
      value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)} />;
  }

  if (field.type === 'select' || options) {
    return <Select className={span} label={field.label} error={error} required={field.required}
      hint={field.hint} options={options ?? []}
      placeholder={(field.lookup && lookup.isLoading) || (field.statusDomain && statuses.isLoading) ? 'Loading…' : field.placeholder ?? '— Select —'}
      value={(value as string | number) ?? ''}
      onChange={(e) => {
        const v = e.target.value === '' ? null : e.target.value;
        onChange(v, v != null && field.lookup ? (lookup.data ?? []).find((r: any) => String(r.id) === String(v)) : undefined);
      }} />;
  }

  return <Input className={span} label={field.label} error={error} required={field.required}
    hint={field.hint} placeholder={field.placeholder} disabled={field.readOnly} readOnly={field.readOnly}
    type={field.type === 'color' ? 'color' : field.type ?? 'text'}
    step={field.step ?? (field.type === 'number' ? 'any' : undefined)}
    value={(value as string) ?? ''}
    onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)} />;
}

function FilterControl({ def, value, onChange }: {
  def: FilterDef; value: string; onChange: (v: string) => void;
}) {
  const lookup = useLookup(def.lookup ?? null, !!def.lookup);
  const statuses = useStatuses(def.statusDomain ?? '');
  const options = def.options
    ?? (def.lookup ? toOptions(lookup.data) : undefined)
    ?? (def.statusDomain ? toPlainOptions(statuses.data) : undefined)
    ?? [];
  return (
    <Select label={def.label} placeholder="All" options={options}
      value={value} onChange={(e) => onChange(e.target.value)} />
  );
}
