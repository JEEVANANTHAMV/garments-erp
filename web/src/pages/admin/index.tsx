import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Pencil, Trash2, Save, UserCog, ShieldCheck } from 'lucide-react';
import { DataTable } from '../../components/DataTable';
import {
  PageHeader, Modal, FormSection, ConfirmDialog, Input, Checkbox, Spinner,
  Badge, LoadingBlock, ErrorState, Tabs, SearchInput,
} from '../../components/ui';
import { useList, useRemove, useListState } from '../../hooks/useResource';
import { http, ApiError } from '../../lib/api';
import { useToast } from '../../hooks/useToast';
import { useAuth } from '../../lib/auth';

/* ---------------------------------------------------------------- Users */
export function UsersPage() {
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const { page, setPage } = useListState();
  const [open, setOpen] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [v, setV] = useState<Record<string, any>>({ is_active: 1 });
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [deleting, setDeleting] = useState<number | null>(null);

  const list = useList<any>('admin/users', { page, pageSize: 25 });
  const roles = useQuery({ queryKey: ['lookup', 'roles'], queryFn: async () => (await http.get<{ data: any[] }>('/lookups/roles')).data });

  const openNew = () => { setEditId(null); setV({ is_active: 1 }); setErrors({}); setOpen(true); };
  const openEdit = (r: any) => {
    setEditId(r.id);
    setV({ username: r.username, full_name: r.full_name, email: r.email, is_active: r.is_active, role_ids: r.role_ids ?? [] });
    setErrors({}); setOpen(true);
  };

  const submit = async () => {
    setBusy(true); setErrors({});
    try {
      if (editId) await http.put(`/admin/users/${editId}`, v);
      else await http.post('/admin/users', v);
      toast(`User ${editId ? 'updated' : 'created'}`);
      void qc.invalidateQueries({ queryKey: ['admin/users'] });
      setOpen(false);
    } catch (e) {
      if (e instanceof ApiError) { setErrors(e.fieldErrors); toast(e.message, 'error'); }
    } finally { setBusy(false); }
  };

  const del = useRemove('admin/users', 'User');

  return (
    <>
      <PageHeader title="Users" subtitle="Manage system users and their role assignments"
        actions={can('USER.CREATE') && <button className="btn-primary" onClick={openNew}><Plus size={15} /> New User</button>} />

      <DataTable
        columns={[
          { key: 'username', header: 'Username', sortable: true,
            render: (r: any) => <span className="font-mono text-[12px] font-medium text-brand-700">{r.username}</span> },
          { key: 'full_name', header: 'Full name', sortable: true,
            render: (r: any) => <span className="font-medium text-slate-800">{r.full_name}</span> },
          { key: 'email', header: 'Email' },
          { key: 'roles', header: 'Roles',
            render: (r: any) => <div className="flex flex-wrap gap-1">
              {(r.roles ?? []).map((role: string) => (
                <Badge key={role} tone="blue">{role.replace(/_/g, ' ')}</Badge>
              ))}</div> },
          { key: 'is_active', header: 'Active',
            render: (r: any) => r.is_active
              ? <Badge tone="green">Active</Badge>
              : <Badge tone="slate">Inactive</Badge> },
          { key: '__actions', header: '', align: 'right', width: 'w-20',
            render: (r: any) => (
              <div className="flex justify-end gap-0.5" onClick={(e) => e.stopPropagation()}>
                {can('USER.UPDATE') && (
                  <button onClick={() => openEdit(r)} className="rounded-md p-1.5 text-slate-400 hover:bg-brand-50 hover:text-brand-600">
                    <Pencil size={14} />
                  </button>
                )}
                {can('USER.DELETE') && (
                  <button onClick={() => setDeleting(r.id)} className="rounded-md p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600">
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
            ) },
        ]}
        rows={list.data?.data ?? []}
        loading={list.isLoading} error={list.error} onRetry={() => void list.refetch()}
        rowKey={(r) => r.id}
        pagination={list.data?.pagination} onPage={setPage}
        emptyTitle="No users found" />

      <Modal open={open} onClose={() => setOpen(false)} title={editId ? 'Edit user' : 'New user'} size="md"
        icon={<UserCog size={16} />}
        footer={<>
          <button className="btn-secondary" onClick={() => setOpen(false)} disabled={busy}>Cancel</button>
          <button className="btn-primary" onClick={() => void submit()} disabled={busy}>
            {busy && <Spinner size={14} />}{editId ? 'Save changes' : 'Create user'}
          </button>
        </>}>
        <FormSection title="Account" cols={2}>
          <Input label="Username" required value={v.username ?? ''} error={errors.username}
            onChange={(e) => setV((s) => ({ ...s, username: e.target.value }))} />
          <Input label="Full name" required value={v.full_name ?? ''} error={errors.full_name}
            onChange={(e) => setV((s) => ({ ...s, full_name: e.target.value }))} />
          <Input label="Email" type="email" value={v.email ?? ''} error={errors.email}
            onChange={(e) => setV((s) => ({ ...s, email: e.target.value }))} />
          <div className="flex items-end pb-1.5">
            <Checkbox label="Active" checked={!!v.is_active} onChange={(checked) => setV((s) => ({ ...s, is_active: checked ? 1 : 0 }))} />
          </div>
          {!editId && (
            <Input label="Password" type="password" required value={v.password ?? ''} error={errors.password}
              className="sm:col-span-2" onChange={(e) => setV((s) => ({ ...s, password: e.target.value }))} />
          )}
        </FormSection>
        <FormSection title="Roles" cols={2}>
          {roles.isLoading ? <div className="sm:col-span-2"><LoadingBlock label="Loading roles…" rows={2} /></div>
            : (roles.data ?? []).map((r: any) => (
              <Checkbox key={r.id} label={r.label} disabled={busy}
                checked={(v.role_ids ?? []).includes(r.id)}
                onChange={(checked) => {
                  const cur: number[] = v.role_ids ?? [];
                  setV((s) => ({ ...s, role_ids: checked ? [...cur, r.id] : cur.filter((x) => x !== r.id) }));
                }} />
            ))}
        </FormSection>
      </Modal>

      <ConfirmDialog open={!!deleting} title="Delete user?" busy={del.isPending}
        message="This will permanently remove the user account. Active sessions will be terminated."
        onConfirm={async () => { if (deleting) await del.mutateAsync(deleting).catch(() => {}); setDeleting(null); }}
        onCancel={() => setDeleting(null)} />
    </>
  );
}

/* ---------------------------------------------------------------- Roles */
export function RolesPage() {
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState('details');
  const [editId, setEditId] = useState<number | null>(null);
  const [v, setV] = useState<Record<string, any>>({ is_active: 1 });
  const [permIds, setPermIds] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);

  const roles = useQuery({ queryKey: ['admin/roles'], queryFn: async () => (await http.get<{ data: any[] }>('/admin/roles')).data });
  const perms = useQuery({ queryKey: ['admin/permissions'], queryFn: async () => (await http.get<{ data: any[] }>('/admin/permissions')).data });

  const openEdit = async (role: any) => {
    setEditId(role.id);
    setV({ role_code: role.role_code, role_name: role.role_name, description: role.description, is_active: role.is_active });
    const detail = await http.get<{ data: any }>(`/admin/roles/${role.id}`);
    setPermIds((detail.data.permissions ?? []).map((p: any) => p.id));
    setTab('details'); setOpen(true);
  };

  const submit = async () => {
    setBusy(true);
    try {
      if (editId) await http.put(`/admin/roles/${editId}`, { ...v, permIds });
      else await http.post('/admin/roles', { ...v, permIds });
      toast(`Role ${editId ? 'updated' : 'created'}`);
      void qc.invalidateQueries({ queryKey: ['admin/roles'] });
      setOpen(false);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Could not save role', 'error');
    } finally { setBusy(false); }
  };

  // Group permissions by module for nicer display
  const permsByModule = (perms.data ?? []).reduce<Record<string, any[]>>((acc, p) => {
    const mod = p.module_code ?? 'OTHER';
    if (!acc[mod]) acc[mod] = [];
    acc[mod].push(p);
    return acc;
  }, {});

  return (
    <>
      <PageHeader title="Roles" subtitle="Role definitions and permission assignments"
        actions={can('ROLE.CREATE') && (
          <button className="btn-primary" onClick={() => {
            setEditId(null); setV({ is_active: 1 }); setPermIds([]); setTab('details'); setOpen(true);
          }}><Plus size={15} /> New Role</button>)} />

      <div className="card overflow-hidden">
        {roles.isLoading ? <LoadingBlock /> : (
          <table className="w-full">
            <thead><tr>
              <th className="th">Role code</th><th className="th">Name</th>
              <th className="th">Permissions</th><th className="th">Active</th><th className="th w-20" />
            </tr></thead>
            <tbody>
              {(roles.data ?? []).map((r: any) => (
                <tr key={r.id} className="row-hover cursor-pointer" onClick={() => void openEdit(r)}>
                  <td className="td"><span className="font-mono text-[12px] font-medium text-brand-700">{r.role_code}</span></td>
                  <td className="td font-medium text-slate-800">{r.role_name}</td>
                  <td className="td"><Badge tone="blue">{r.permission_count ?? 0} permissions</Badge></td>
                  <td className="td">{r.is_active ? <Badge tone="green">Active</Badge> : <Badge tone="slate">Inactive</Badge>}</td>
                  <td className="td text-right">
                    <div className="flex justify-end" onClick={(e) => e.stopPropagation()}>
                      <button onClick={() => void openEdit(r)} className="rounded-md p-1.5 text-slate-400 hover:bg-brand-50 hover:text-brand-600">
                        <Pencil size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <Modal open={open} onClose={() => setOpen(false)} title={editId ? `Edit role ${v.role_code ?? ''}` : 'New role'} size="lg"
        icon={<ShieldCheck size={16} />}
        footerStart={<><b>{permIds.length}</b> permission{permIds.length === 1 ? '' : 's'} selected</>}
        footer={<>
          <button className="btn-secondary" onClick={() => setOpen(false)} disabled={busy}>Cancel</button>
          <button className="btn-primary" onClick={() => void submit()} disabled={busy}>
            {busy && <Spinner size={14} />}{editId ? 'Save changes' : 'Create role'}
          </button>
        </>}>
        <Tabs active={tab} onChange={setTab}
          tabs={[{ key: 'details', label: 'Details' }, { key: 'permissions', label: `Permissions (${permIds.length})` }]} />

        {tab === 'details' ? (
          <FormSection cols={3}>
            <Input label="Role code" required value={v.role_code ?? ''}
              onChange={(e) => setV((s) => ({ ...s, role_code: e.target.value }))} />
            <Input label="Role name" required value={v.role_name ?? ''}
              onChange={(e) => setV((s) => ({ ...s, role_name: e.target.value }))} />
            <div className="flex items-end pb-1.5">
              <Checkbox label="Active" checked={!!v.is_active} onChange={(c) => setV((s) => ({ ...s, is_active: c ? 1 : 0 }))} />
            </div>
            <Input label="Description" value={v.description ?? ''} className="sm:col-span-2 lg:col-span-3"
              onChange={(e) => setV((s) => ({ ...s, description: e.target.value }))} />
          </FormSection>
        ) : perms.isLoading ? <LoadingBlock label="Loading permissions…" rows={6} /> : (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-end gap-2">
              <button className="btn-ghost btn-sm" onClick={() => setPermIds([])}>Clear all</button>
              <button className="btn-secondary btn-sm" onClick={() => setPermIds((perms.data ?? []).map((p) => p.id))}>
                Select all
              </button>
            </div>
            {Object.entries(permsByModule).map(([mod, ps]) => (
              <FormSection key={mod} title={mod.replace(/_/g, ' ')} cols={3}>
                {ps.map((p) => (
                  <Checkbox key={p.id} label={p.label ?? p.permission_code} disabled={busy}
                    checked={permIds.includes(p.id)}
                    onChange={(c) => setPermIds((cur) => c ? [...cur, p.id] : cur.filter((x) => x !== p.id))} />
                ))}
              </FormSection>
            ))}
          </div>
        )}
      </Modal>
    </>
  );
}

/* ----------------------------------------------- Company settings */
export function CompanyPage() {
  useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const [v, setV] = useState<Record<string, any>>({});
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const detail = useQuery({
    queryKey: ['admin/company'],
    queryFn: async () => (await http.get<{ data: any }>('/admin/company')).data,
  });

  if (detail.data && !loaded) { setV({ ...detail.data }); setLoaded(true); }

  const save = async () => {
    setBusy(true);
    try {
      await http.put('/admin/company', v);
      toast('Company settings saved');
      void qc.invalidateQueries({ queryKey: ['admin/company'] });
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Could not save', 'error');
    } finally { setBusy(false); }
  };

  if (detail.isLoading) return <div className="card"><LoadingBlock rows={5} /></div>;
  if (detail.error) return <div className="card"><ErrorState error={detail.error} /></div>;

  return (
    <>
      <PageHeader title="Company Settings" subtitle="Legal entity, fiscal year and address"
        actions={<button className="btn-primary" onClick={() => void save()} disabled={busy}>
          {busy && <Spinner size={14} />}<Save size={15} /> Save
        </button>} />

      <div className="card p-5">
        <div className="grid grid-cols-1 gap-x-5 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
          {[
            { k: 'company_code', label: 'Company code' },
            { k: 'legal_name', label: 'Legal name' },
            { k: 'trade_name', label: 'Trade name' },
            { k: 'gstin', label: 'GSTIN' },
            { k: 'pan', label: 'PAN' },
            { k: 'iec_code', label: 'IEC code' },
            { k: 'rcmc_no', label: 'RCMC no' },
            { k: 'cin', label: 'CIN' },
            { k: 'email', label: 'Email' },
            { k: 'phone', label: 'Phone' },
            { k: 'website', label: 'Website', span: 2 },
            { k: 'address_line1', label: 'Address', span: 2 },
            { k: 'city', label: 'City' },
            { k: 'state', label: 'State' },
            { k: 'pincode', label: 'Pincode' },
            { k: 'country', label: 'Country' },
          ].map(({ k, label, span }) => (
            <div key={k} className={span === 2 ? 'sm:col-span-2 lg:col-span-2' : ''}>
              <label className="label">{label}</label>
              <input className="input" value={v[k] ?? ''} onChange={(e) => setV((s) => ({ ...s, [k]: e.target.value }))} />
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

/* ------------------------------------------------- System settings */
export function SettingsPage() {
  const toast = useToast();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);

  const settings = useQuery({
    queryKey: ['admin/settings'],
    queryFn: async () => (await http.get<{ data: any[] }>('/admin/settings')).data,
  });

  const [vals, setVals] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(false);
  const [find, setFind] = useState('');

  if (settings.data && !loaded) {
    const m: Record<string, string> = {};
    for (const s of settings.data) m[s.key] = s.value ?? '';
    setVals(m); setLoaded(true);
  }

  const save = async () => {
    setBusy(true);
    try {
      await http.put('/admin/settings', { settings: Object.entries(vals).map(([k, v]) => ({ key: k, value: v })) });
      toast('Settings saved');
      void qc.invalidateQueries({ queryKey: ['admin/settings'] });
    } catch {
      toast('Could not save settings', 'error');
    } finally { setBusy(false); }
  };

  if (settings.isLoading) return <div className="card"><LoadingBlock rows={5} /></div>;

  return (
    <>
      <PageHeader title="System Settings" subtitle="Configuration keys and application defaults"
        actions={<button className="btn-primary" onClick={() => void save()} disabled={busy}>
          {busy && <Spinner size={14} />}<Save size={15} /> Save all
        </button>} />

      <SearchInput value={find} onChange={setFind} placeholder="Find a setting (key or description)…" className="mb-3 w-full max-w-md" />
      <div className="card p-5">
        <div className="divide-y divide-surface-border" id="settings-list">
          {(settings.data ?? []).filter((s: any) => !find || `${s.key} ${s.description ?? ''}`.toLowerCase().includes(find.toLowerCase())).map((s: any) => {
            // 0 / 1 switches ("1 = … ; 0 = …") show as ON / OFF so nobody has to remember what 1 means (call 14-Oct-2026)
            const isFlag = /(^|[;\s(])1 = /.test(String(s.description ?? '')) && ['0', '1', ''].includes(String(vals[s.key] ?? '').trim());
            const on = String(vals[s.key] ?? '').trim() === '1';
            return (
              <div key={s.key} className="flex flex-wrap items-center gap-4 py-3.5 first:pt-0 last:pb-0" data-setting={s.key}>
                <div className="min-w-0 flex-1">
                  <p className="font-mono text-[12.5px] font-medium text-brand-700">{s.key}</p>
                  {s.description && <p className="text-[11.5px] text-slate-500">{s.description}</p>}
                </div>
                <div className="w-full sm:w-64">
                  {isFlag ? (
                    <button type="button" role="switch" aria-checked={on} disabled={!s.is_editable && s.is_editable !== undefined && s.is_editable !== null && Number(s.is_editable) === 0}
                      onClick={() => setVals((cur) => ({ ...cur, [s.key]: on ? '0' : '1' }))}
                      className={`flex items-center gap-2 rounded-full px-1 py-1 pr-3 text-[12px] font-semibold transition-colors ${on ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-600'}`}>
                      <span className={`h-5 w-9 rounded-full p-0.5 transition-colors ${on ? 'bg-emerald-500' : 'bg-slate-300'}`}>
                        <span className={`block h-4 w-4 rounded-full bg-white shadow transition-transform ${on ? 'translate-x-4' : ''}`} />
                      </span>
                      {on ? 'ON (1)' : 'OFF (0)'}
                    </button>
                  ) : (
                    <input className="input" value={vals[s.key] ?? ''}
                      onChange={(e) => setVals((cur) => ({ ...cur, [s.key]: e.target.value }))} />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}
