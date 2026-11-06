import { useState, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Pencil, Trash2, Save, UserCog, ShieldCheck, Building2, Users, ArrowRightLeft, Upload } from 'lucide-react';
import clsx from 'clsx';
import { DataTable } from '../../components/DataTable';
import {
  PageHeader, Modal, FormSection, ConfirmDialog, Input, Checkbox, Spinner,
  Badge, LoadingBlock, Tabs, SearchInput,
} from '../../components/ui';
import { useList, useRemove, useListState } from '../../hooks/useResource';
import { http, ApiError } from '../../lib/api';
import { useToast } from '../../hooks/useToast';
import { useAuth } from '../../lib/auth';
import { NAV } from '../../lib/nav';
import { useSearchParams } from 'react-router-dom';
import { MailSettingsPanel } from './MailSettings';

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
            render: (r: any) => <span className="tabular-nums text-small font-medium text-brand-700">{r.username}</span> },
          { key: 'full_name', header: 'Full name', sortable: true,
            render: (r: any) => <span className="font-medium text-ink">{r.full_name}</span> },
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
                  <button onClick={() => openEdit(r)} className="rounded-md p-1.5 text-ink-muted hover:bg-brand-50 hover:text-brand-600">
                    <Pencil size={14} />
                  </button>
                )}
                {can('USER.DELETE') && (
                  <button onClick={() => setDeleting(r.id)} className="rounded-md p-1.5 text-ink-muted hover:bg-red-50 hover:text-red-600">
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
                  <td className="td"><span className="tabular-nums text-small font-medium text-brand-700">{r.role_code}</span></td>
                  <td className="td font-medium text-ink">{r.role_name}</td>
                  <td className="td"><Badge tone="blue">{r.permission_count ?? 0} permissions</Badge></td>
                  <td className="td">{r.is_active ? <Badge tone="green">Active</Badge> : <Badge tone="slate">Inactive</Badge>}</td>
                  <td className="td text-right">
                    <div className="flex justify-end" onClick={(e) => e.stopPropagation()}>
                      <button onClick={() => void openEdit(r)} className="rounded-md p-1.5 text-ink-muted hover:bg-brand-50 hover:text-brand-600">
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

/* ----------------------------------------------- Company logo (client 06-Nov-2026: printed on every PO / DC) */
const LOGO_MAX_BYTES = 1024 * 1024;
function CompanyLogoBox({ logoPath, companyId, onChange }: { logoPath: string | null; companyId: number | null; onChange: (row: any) => void }) {
  const qs = companyId ? `?company_id=${companyId}` : '';
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [bust, setBust] = useState(0);
  const upload = async (file: File | undefined) => {
    if (!file) return;
    if (!/^image\/(png|jpe?g)$/i.test(file.type)) { toast('Choose a PNG or JPG image', 'error'); return; }
    if (file.size > LOGO_MAX_BYTES) { toast('The logo must be 1 MB or smaller', 'error'); return; }
    setBusy(true);
    try {
      const data = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.onerror = () => reject(new Error('Could not read the file'));
        r.readAsDataURL(file);
      });
      const res = await http.post<{ data: any }>(`/admin/company/logo${qs}`, { filename: file.name, data });
      onChange(res.data);
      setBust(Date.now());
      toast('Logo saved — it prints on every PO and DC');
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Could not upload the logo', 'error');
    } finally { setBusy(false); }
  };
  const remove = async () => {
    if (!window.confirm('Remove the company logo from all prints?')) return;
    setBusy(true);
    try {
      const res = await http.del<{ data: any }>(`/admin/company/logo${qs}`);
      onChange(res.data);
      toast('Logo removed');
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Could not remove the logo', 'error');
    } finally { setBusy(false); }
  };
  return (
    <div className="mb-5 flex flex-wrap items-center gap-4 rounded border border-surface-border p-3" data-testid="company-logo-box">
      <div className="flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded border border-surface-border bg-surface-muted">
        {logoPath
          ? <img src={`${logoPath}${bust ? `?v=${bust}` : ''}`} alt="Company logo" className="max-h-full max-w-full object-contain" data-testid="company-logo-img" />
          : <Building2 size={28} className="text-ink-muted" />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-body font-semibold text-ink">Company logo</div>
        <div className="text-caption text-ink-muted">Printed on the left of every purchase order and delivery challan. PNG or JPG, up to 1 MB; a square logo prints best.</div>
      </div>
      <div className="flex flex-wrap gap-2">
        <label className={clsx('btn-secondary cursor-pointer', busy && 'pointer-events-none opacity-60')}>
          {busy ? <Spinner size={14} /> : <Upload size={14} />} {logoPath ? 'Change logo' : 'Upload logo'}
          <input type="file" accept="image/png,image/jpeg" className="hidden" data-testid="company-logo-input"
            onChange={(e) => { void upload(e.target.files?.[0]); e.target.value = ''; }} />
        </label>
        {logoPath && (
          <button type="button" className="btn-secondary" onClick={() => void remove()} disabled={busy}>
            <Trash2 size={14} /> Remove
          </button>
        )}
      </div>
    </div>
  );
}

/* ----------------------------------------------- Company settings */
export function CompanyPage() {
  const { company, switchCompany, user } = useAuth();
  // super admin: activate / deactivate a company (server refuses the current / home / last active company)
  const completeSetup = async (r: any) => {
    try {
      const res = await http.post<{ data: { setup: Record<string, number> } }>(`/admin/companies/${r.id}/provision`, { copy_masters: { tax: true, ledger: true } });
      const added = Object.values(res.data.setup ?? {}).reduce((a, n) => a + Number(n || 0), 0);
      toast(added ? `${r.legal_name}: ${added} missing setup records added` : `${r.legal_name} is already fully set up`);
    } catch (e: any) { toast(e?.message || 'Could not complete the setup', 'error'); }
  };
  const toggleActive = async (r: any) => {
    if (r.is_active && !window.confirm(`Deactivate ${r.legal_name}? Nobody can sign in to it until it is activated again.`)) return;
    try {
      await http.put(`/admin/companies/${r.id}/active`, { is_active: !r.is_active });
      toast(r.is_active ? `${r.legal_name} deactivated` : `${r.legal_name} activated`);
      void companiesList.refetch();
    } catch (e: any) { toast(e?.message || 'Could not change the company status', 'error'); }
  };
  const toast = useToast();
  const qc = useQueryClient();
  const [tab, setTab] = useState<'all' | 'active'>('all');
  // company being edited on the details tab: null = the signed-in company; another id = super admin editing it
  const [editCompanyId, setEditCompanyId] = useState<number | null>(null);
  const [newLogo, setNewLogo] = useState<{ name: string; data: string } | null>(null);
  const [v, setV] = useState<Record<string, any>>({});
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  // New Company Modal state
  const [createOpen, setCreateOpen] = useState(false);
  const [newCompany, setNewCompany] = useState<Record<string, any>>({
    company_code: '',
    legal_name: '',
    trade_name: '',
    gstin: '',
    pan: '',
    iec_code: '',
    cin: '',
    state: 'Tamil Nadu',
    state_gst_code: '33',
    city: 'Tiruppur',
    pincode: '',
    address_line1: '',
    address_line2: '',
    phone: '',
    email: '',
    website: '',
    assigned_user_ids: [], copy_masters: { tax: true, ledger: true, colors: true, sizeGroups: true, gsm: true, dia: true, yarnCounts: true, compositions: true },
  });
  const [createBusy, setCreateBusy] = useState(false);

  // User access modal state
  const [userAccessCompany, setUserAccessCompany] = useState<{ id: number; legal_name: string } | null>(null);
  const [selectedUserIds, setSelectedUserIds] = useState<number[]>([]);
  const [accessBusy, setAccessBusy] = useState(false);

  // Queries
  const companiesList = useQuery({
    queryKey: ['admin/companies'],
    queryFn: async () => (await http.get<{ data: any[] }>('/admin/companies')).data,
  });

  const editQs = editCompanyId && editCompanyId !== company?.id ? `?company_id=${editCompanyId}` : '';
  const detail = useQuery({
    queryKey: ['admin/company', editQs],
    queryFn: async () => (await http.get<{ data: any }>(`/admin/company${editQs}`)).data,
  });
  const openEdit = (id: number | null) => {
    setEditCompanyId(id && id !== company?.id ? id : null);
    setLoaded(false);
    setTab('active');
  };

  const allUsers = useQuery({
    queryKey: ['admin/users/all-for-mapping'],
    queryFn: async () => (await http.get<{ data: any[] }>('/admin/users?pageSize=200')).data,
    enabled: createOpen,
  });

  const companyUsers = useQuery({
    queryKey: ['admin/company-users', userAccessCompany?.id],
    queryFn: async () => (await http.get<{ data: any[] }>(`/admin/company-users/${userAccessCompany!.id}`)).data,
    enabled: !!userAccessCompany,
  });

  useEffect(() => {
    if (companyUsers.data) {
      setSelectedUserIds(companyUsers.data.filter((u: any) => u.has_access).map((u: any) => u.id));
    }
  }, [companyUsers.data]);

  if (detail.data && !loaded) { setV({ ...detail.data }); setLoaded(true); }

  const saveActive = async () => {
    setBusy(true);
    try {
      await http.put(`/admin/company${editQs}`, v);
      toast('Company settings saved');
      void qc.invalidateQueries({ queryKey: ['admin/company'] });
      void qc.invalidateQueries({ queryKey: ['admin/companies'] });
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Could not save', 'error');
    } finally { setBusy(false); }
  };

  const handleCreateCompany = async () => {
    if (!newCompany.company_code.trim()) {
      toast('Company code is required', 'error');
      return;
    }
    if (!newCompany.legal_name.trim()) {
      toast('Legal name is required', 'error');
      return;
    }
    setCreateBusy(true);
    try {
      const r = await http.post<{ data: { setup?: Record<string, number> } }>('/admin/companies', newLogo ? { ...newCompany, logo: newLogo.data } : newCompany);
      const setup = r.data?.setup ?? {};
      const total = Object.values(setup).reduce((a, n) => a + Number(n || 0), 0);
      toast(`Company created and set up (${total} setup records). Use Switch to open it.`);
      setCreateOpen(false);
      void qc.invalidateQueries({ queryKey: ['admin/companies'] });
      void qc.invalidateQueries({ queryKey: ['admin/company'] });
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Could not create company', 'error');
    } finally {
      setCreateBusy(false);
    }
  };

  const handleSaveAccess = async () => {
    if (!userAccessCompany) return;
    setAccessBusy(true);
    try {
      await http.put(`/admin/company-users/${userAccessCompany.id}`, { userIds: selectedUserIds });
      toast('User access updated successfully!');
      setUserAccessCompany(null);
      void qc.invalidateQueries({ queryKey: ['admin/companies'] });
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Could not update user access', 'error');
    } finally {
      setAccessBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Companies & Organizations"
        subtitle="Manage legal entities, GST accounts, and user access permissions"
        actions={
          tab === 'all' ? (
            <button
              className="btn-primary"
              onClick={() => {
                setNewLogo(null);
                setNewCompany({
                  company_code: '',
                  legal_name: '',
                  trade_name: '',
                  gstin: '',
                  pan: '',
                  iec_code: '',
                  cin: '',
                  state: 'Tamil Nadu',
                  state_gst_code: '33',
                  city: 'Tiruppur',
                  pincode: '',
                  address_line1: '',
                  address_line2: '',
                  phone: '',
                  email: '',
                  website: '',
                  assigned_user_ids: [], copy_masters: { tax: true, ledger: true, colors: true, sizeGroups: true, gsm: true, dia: true, yarnCounts: true, compositions: true },
                });
                setCreateOpen(true);
              }}
            >
              <Plus size={15} /> New Company (Add GST Entity)
            </button>
          ) : (
            <button className="btn-primary" onClick={() => void saveActive()} disabled={busy}>
              {busy && <Spinner size={14} />}<Save size={15} /> Save Settings
            </button>
          )
        }
      />

      <Tabs
        tabs={[
          { key: 'all', label: 'All Companies / நிறுவனங்கள்', count: companiesList.data?.length },
          { key: 'active', label: `Company Details (${(detail.data?.company_code ?? company?.company_code) ?? ''})` },
        ]}
        active={tab}
        onChange={(k) => { if (k === 'active' && tab !== 'active') openEdit(null); else setTab(k as 'all' | 'active'); }}
      />

      {tab === 'all' && (
        <div className="space-y-4">
          <DataTable
            columns={[
              {
                key: 'company_code',
                header: 'Code',
                render: (r: any) => (
                  <span className="tabular-nums text-body font-bold text-brand-700">
                    {r.company_code}
                  </span>
                ),
              },
              {
                key: 'legal_name',
                header: 'Legal Entity & Trade Name',
                render: (r: any) => (
                  <div>
                    <span className="font-semibold text-ink">{r.legal_name}</span>
                    {r.trade_name && (
                      <span className="block text-small text-ink-secondary">{r.trade_name}</span>
                    )}
                  </div>
                ),
              },
              {
                key: 'gstin',
                header: 'GSTIN / PAN',
                render: (r: any) => (
                  <div className="tabular-nums text-small">
                    {r.gstin ? (
                      <span className="font-medium text-ink">{r.gstin}</span>
                    ) : (
                      <span className="text-ink-muted">—</span>
                    )}
                    {r.pan && <span className="block text-caption text-ink-secondary">PAN: {r.pan}</span>}
                  </div>
                ),
              },
              {
                key: 'location',
                header: 'Location',
                render: (r: any) => (
                  <span className="text-small text-ink-secondary">
                    {[r.city, r.state].filter(Boolean).join(', ') || '—'}
                  </span>
                ),
              },
              {
                key: 'branch_count',
                header: 'Branches',
                render: (r: any) => (
                  <Badge tone="slate">{r.branch_count ?? 1} branch</Badge>
                ),
              },
              {
                key: 'user_count',
                header: 'Users Mapped',
                render: (r: any) => (
                  <Badge tone="blue">{r.user_count ?? 0} users</Badge>
                ),
              },
              {
                key: 'status',
                header: 'Status',
                render: (r: any) => {
                  const isCurrent = r.id === company?.id;
                  if (!r.is_active) return <Badge tone="red">Inactive</Badge>;
                  return isCurrent ? (
                    <Badge tone="green" className="font-semibold">
                      Current Active
                    </Badge>
                  ) : (
                    <Badge tone="slate">Ready</Badge>
                  );
                },
              },
              {
                key: '__actions',
                header: '',
                align: 'right',
                width: 'w-48',
                render: (r: any) => {
                  const isCurrent = r.id === company?.id;
                  return (
                    <div className="ml-auto flex max-w-[15rem] flex-wrap justify-end gap-1.5 whitespace-normal" onClick={(e) => e.stopPropagation()}>
                      {(isCurrent || !!user?.isSuperAdmin) && (
                        <button type="button" data-co-edit={r.id}
                          onClick={() => openEdit(r.id)}
                          className="btn-secondary !px-2.5 !py-1 text-small gap-1 hover:border-brand-500 hover:text-brand-700"
                          title="Edit company details and logo">
                          <Pencil size={12} /> Edit
                        </button>
                      )}
                      {!isCurrent && !!user?.isSuperAdmin && !!r.is_active && (
                        <button type="button" data-co-provision={r.id}
                          onClick={() => void completeSetup(r)}
                          className="btn-secondary !px-2.5 !py-1 text-small"
                          title="Copy any missing setup (settings, stages, stores, T&A …) from the current company — safe to run again">
                          Complete setup
                        </button>
                      )}
                      {!isCurrent && !!user?.isSuperAdmin && (
                        <button type="button" data-co-active={r.id}
                          onClick={() => void toggleActive(r)}
                          className={`btn-secondary !px-2.5 !py-1 text-small ${r.is_active ? 'hover:border-red-400 hover:text-red-700' : 'hover:border-emerald-500 hover:text-emerald-700'}`}
                          title={r.is_active ? 'Deactivate — nobody can sign in to it until reactivated' : 'Activate this company again'}>
                          {r.is_active ? 'Deactivate' : 'Activate'}
                        </button>
                      )}
                      {!isCurrent && !!r.is_active && (
                        <button
                          type="button"
                          onClick={() => void switchCompany(r.id)}
                          className="btn-secondary !px-2.5 !py-1 text-small gap-1 hover:border-brand-500 hover:text-brand-700"
                          title="Switch into this company"
                        >
                          <ArrowRightLeft size={12} /> Switch
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => setUserAccessCompany({ id: r.id, legal_name: r.legal_name })}
                        className="btn-secondary !px-2.5 !py-1 text-small gap-1"
                        title="Manage which users can access this company"
                      >
                        <Users size={12} /> User Access
                      </button>
                    </div>
                  );
                },
              },
            ]}
            rows={companiesList.data ?? []}
            loading={companiesList.isLoading}
            error={companiesList.error}
            onRetry={() => void companiesList.refetch()}
            rowKey={(r) => r.id}
            emptyTitle="No companies found"
          />
        </div>
      )}

      {tab === 'active' && (
        <div className="card p-5">
          <div className="mb-4 flex items-center gap-2 border-b border-surface-border pb-3">
            <Building2 size={18} className="text-brand-600" />
            <h3 className="text-body-lg font-semibold text-ink">
              Editing: {v.legal_name ?? company?.legal_name} ({v.company_code ?? company?.company_code})
            </h3>
          </div>
          <CompanyLogoBox
            logoPath={v.logo_path ?? null}
            companyId={editQs ? editCompanyId : null}
            onChange={(row) => {
              setV((x) => ({ ...x, logo_path: row?.logo_path ?? null }));
              void qc.invalidateQueries({ queryKey: ['admin/company'] });
              void qc.invalidateQueries({ queryKey: ['admin/companies'] });
            }}
          />
          <div className="grid grid-cols-1 gap-x-5 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
            {[
              { k: 'company_code', label: 'Company code', disabled: true },
              { k: 'legal_name', label: 'Legal name' },
              { k: 'trade_name', label: 'Trade name' },
              { k: 'gstin', label: 'GSTIN' },
              { k: 'pan', label: 'PAN' },
              { k: 'iec_code', label: 'IEC code' },
              { k: 'rex_no', label: 'REX no (EU GSP)' },
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
            ].map(({ k, label, span, disabled }: any) => (
              <div key={k} className={span === 2 ? 'sm:col-span-2 lg:col-span-2' : ''}>
                <label className="label">{label}</label>
                <input
                  className="input"
                  disabled={disabled}
                  value={v[k] ?? ''}
                  onChange={(e) => setV((s) => ({ ...s, [k]: e.target.value }))}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* New Company Creation Modal */}
      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Create New Company / புதிய நிறுவனம்"
        subtitle="Add a new company entity / GST account with its own numbering series and roles"
        size="lg"
        icon={<Building2 size={18} className="text-brand-600" />}
        footer={
          <>
            <button className="btn-secondary" onClick={() => setCreateOpen(false)} disabled={createBusy}>
              Cancel
            </button>
            <button className="btn-primary" onClick={() => void handleCreateCompany()} disabled={createBusy}>
              {createBusy && <Spinner size={14} />} Create Company
            </button>
          </>
        }
      >
        <div className="space-y-4 py-1">
          <div className="flex flex-wrap items-center gap-4 rounded border border-surface-border p-3" data-testid="new-company-logo">
            <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded border border-surface-border bg-surface-muted">
              {newLogo ? <img src={newLogo.data} alt="New company logo" className="max-h-full max-w-full object-contain" /> : <Building2 size={24} className="text-ink-muted" />}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-body font-semibold text-ink">Company logo (optional)</div>
              <div className="text-caption text-ink-muted">{newLogo ? newLogo.name : 'Printed on every PO and DC. PNG or JPG, up to 1 MB — can also be added later via Edit.'}</div>
            </div>
            <div className="flex gap-2">
              <label className="btn-secondary cursor-pointer">
                <Upload size={14} /> {newLogo ? 'Change' : 'Choose logo'}
                <input type="file" accept="image/png,image/jpeg" className="hidden" data-testid="new-company-logo-input"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = '';
                    if (!f) return;
                    if (!/^image\/(png|jpe?g)$/i.test(f.type)) { toast('Choose a PNG or JPG image', 'error'); return; }
                    if (f.size > LOGO_MAX_BYTES) { toast('The logo must be 1 MB or smaller', 'error'); return; }
                    const rd = new FileReader();
                    rd.onload = () => setNewLogo({ name: f.name, data: String(rd.result) });
                    rd.readAsDataURL(f);
                  }} />
              </label>
              {newLogo && <button type="button" className="btn-secondary" onClick={() => setNewLogo(null)}><Trash2 size={14} /> Remove</button>}
            </div>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="label font-semibold text-ink">Company Code * (e.g. TEX02)</label>
              <input
                className="input tabular-nums font-bold uppercase"
                placeholder="e.g. TEX02"
                value={newCompany.company_code}
                onChange={(e) => setNewCompany({ ...newCompany, company_code: e.target.value.toUpperCase() })}
                required
              />
            </div>
            <div>
              <label className="label font-semibold text-ink">Legal Name *</label>
              <input
                className="input"
                placeholder="e.g. Kongu Apparels Private Limited"
                value={newCompany.legal_name}
                onChange={(e) => setNewCompany({ ...newCompany, legal_name: e.target.value })}
                required
              />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div>
              <label className="label">Trade Name</label>
              <input
                className="input"
                placeholder="e.g. Kongu Apparels"
                value={newCompany.trade_name}
                onChange={(e) => setNewCompany({ ...newCompany, trade_name: e.target.value })}
              />
            </div>
            <div>
              <label className="label">GSTIN (15 Digits)</label>
              <input
                className="input tabular-nums"
                placeholder="e.g. 33AABCK9999Z1ZR"
                maxLength={15}
                value={newCompany.gstin}
                onChange={(e) => setNewCompany({ ...newCompany, gstin: e.target.value.toUpperCase() })}
              />
            </div>
            <div>
              <label className="label">PAN</label>
              <input
                className="input tabular-nums"
                placeholder="e.g. AABCK9999Z"
                maxLength={10}
                value={newCompany.pan}
                onChange={(e) => setNewCompany({ ...newCompany, pan: e.target.value.toUpperCase() })}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div>
              <label className="label">City</label>
              <input
                className="input"
                value={newCompany.city}
                onChange={(e) => setNewCompany({ ...newCompany, city: e.target.value })}
              />
            </div>
            <div>
              <label className="label">State</label>
              <input
                className="input"
                value={newCompany.state}
                onChange={(e) => setNewCompany({ ...newCompany, state: e.target.value })}
              />
            </div>
            <div>
              <label className="label">Pincode</label>
              <input
                className="input"
                value={newCompany.pincode}
                onChange={(e) => setNewCompany({ ...newCompany, pincode: e.target.value })}
              />
            </div>
          </div>

          <div>
            <label className="label">Address</label>
            <input
              className="input"
              placeholder="e.g. SF No. 45, Avinashi Road, Tiruppur"
              value={newCompany.address_line1}
              onChange={(e) => setNewCompany({ ...newCompany, address_line1: e.target.value })}
            />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="label">Phone</label>
              <input
                className="input"
                placeholder="+91 421 220 0000"
                value={newCompany.phone}
                onChange={(e) => setNewCompany({ ...newCompany, phone: e.target.value })}
              />
            </div>
            <div>
              <label className="label">Email</label>
              <input
                className="input"
                placeholder="info@konguapparels.in"
                value={newCompany.email}
                onChange={(e) => setNewCompany({ ...newCompany, email: e.target.value })}
              />
            </div>
          </div>

          {/* settings, process stages + operations, warehouses, FY, reference lists, calendar / T&A are always copied */}
          <div className="rounded-xl border border-surface-border bg-surface-muted p-3" id="nc-copy-masters">
            <label className="label !mb-1 font-semibold text-ink">Copy masters from this company</label>
            <p className="mb-2 text-small text-ink-secondary">Configuration (settings, number series, roles, process stages &amp; operations, stores, financial year, T&amp;A) is always set up.</p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {([['tax', 'Tax rates'], ['ledger', 'Ledger accounts'], ['colors', 'Colours'], ['sizeGroups', 'Size groups'],
                ['gsm', 'GSM'], ['dia', 'Dia'], ['yarnCounts', 'Yarn counts'], ['compositions', 'Compositions']] as const).map(([k, label]) => (
                <label key={k} className="flex items-center gap-2 rounded-lg border border-surface-border bg-white px-2 py-1.5 text-small">
                  <input type="checkbox" checked={!!newCompany.copy_masters?.[k]}
                    onChange={(e) => setNewCompany({ ...newCompany, copy_masters: { ...(newCompany.copy_masters ?? {}), [k]: e.target.checked } })} />
                  {label}
                </label>
              ))}
            </div>
          </div>

          {allUsers.data && allUsers.data.length > 0 && (
            <div className="mt-2 rounded-xl border border-surface-border bg-surface-muted p-3">
              <label className="label !mb-2 font-semibold text-ink">
                Grant Initial Login Access To Users:
              </label>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 max-h-36 overflow-y-auto">
                {allUsers.data.map((u: any) => {
                  const checked = newCompany.assigned_user_ids.includes(u.id);
                  return (
                    <label
                      key={u.id}
                      className="flex items-center gap-2 rounded-lg bg-white px-2 py-1.5 text-small border border-surface-border cursor-pointer hover:bg-brand-50"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => {
                          const next = e.target.checked
                            ? [...newCompany.assigned_user_ids, u.id]
                            : newCompany.assigned_user_ids.filter((id: number) => id !== u.id);
                          setNewCompany({ ...newCompany, assigned_user_ids: next });
                        }}
                        className="rounded border-surface-input text-brand-600 focus:ring-brand-500/30"
                      />
                      <span className="truncate font-medium text-ink">
                        {u.full_name} <span className="tabular-nums text-ink-muted">({u.username})</span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </Modal>

      {/* User Access Modal */}
      <Modal
        open={!!userAccessCompany}
        onClose={() => setUserAccessCompany(null)}
        title={`User Access · ${userAccessCompany?.legal_name ?? ''}`}
        subtitle="Select which staff members are permitted to log in and switch into this company"
        size="md"
        icon={<Users size={18} className="text-brand-600" />}
        footer={
          <>
            <button className="btn-secondary" onClick={() => setUserAccessCompany(null)} disabled={accessBusy}>
              Cancel
            </button>
            <button className="btn-primary" onClick={() => void handleSaveAccess()} disabled={accessBusy}>
              {accessBusy && <Spinner size={14} />} Save Access
            </button>
          </>
        }
      >
        {companyUsers.isLoading ? (
          <LoadingBlock rows={4} />
        ) : (
          <div className="space-y-2 py-2 max-h-[420px] overflow-y-auto">
            {(companyUsers.data ?? []).map((u: any) => {
              const isChecked = selectedUserIds.includes(u.id);
              return (
                <label
                  key={u.id}
                  className={clsx(
                    'flex items-center justify-between rounded-xl border p-3 cursor-pointer transition-colors',
                    isChecked ? 'border-brand-500 bg-brand-50/50' : 'border-surface-border bg-white hover:bg-surface-muted'
                  )}
                >
                  <div className="flex items-center gap-3">
                    <input
                      type="checkbox"
                      checked={isChecked}
                      onChange={(e) => {
                        if (e.target.checked) {
                          setSelectedUserIds([...selectedUserIds, u.id]);
                        } else {
                          setSelectedUserIds(selectedUserIds.filter((id) => id !== u.id));
                        }
                      }}
                      className="h-4 w-4 rounded border-surface-input text-brand-600 focus:ring-brand-500/30"
                    />
                    <div>
                      <p className="text-body font-semibold text-ink">{u.full_name}</p>
                      <p className="tabular-nums text-caption text-ink-secondary">@{u.username} {u.email ? `· ${u.email}` : ''}</p>
                    </div>
                  </div>
                  {isChecked && (
                    <span className="rounded bg-brand-100 px-2 py-0.5 text-micro font-bold text-brand-700">
                      Access Granted
                    </span>
                  )}
                </label>
              );
            })}
          </div>
        )}
      </Modal>
    </>
  );
}

/* ------------------------------------------------- System settings */
/** Settings with a fixed set of values: shown as a dropdown instead of a text box. */
const SETTING_CHOICES: Record<string, { value: string; label: string }[]> = {
  // client 05-Nov-2026: printout design for POs / DCs (each Print / PDF button can still pick the other one)
  PRINT_TEMPLATE: [{ value: 'COLOUR', label: 'Colour — light professional colours' }, { value: 'BW', label: 'Black & White — bordered, for B/W printers' }],
  PURCHASE_EXCESS_CONTROL: [{ value: 'BLOCK', label: 'BLOCK — refuse the PO' }, { value: 'WARN', label: 'WARN — save with a warning' }, { value: 'OFF', label: 'OFF' }],
};

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
  // Settings tabs: system keys | Mail (SMTP) for e-mailing POs (client 04-Nov-2026) — /admin/settings?tab=mail
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'mail' ? 'mail' : 'system';
  const tabs = (
    <Tabs tabs={[{ key: 'system', label: 'System settings' }, { key: 'mail', label: 'Mail (SMTP)' }]} active={tab}
      onChange={(k) => setParams(k === 'mail' ? { tab: 'mail' } : {}, { replace: true })} />
  );

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

  if (tab === 'mail') {
    return (
      <>
        <PageHeader title="Mail (SMTP)" subtitle="Outgoing mail server for e-mailing purchase orders to suppliers" />
        {tabs}
        <MailSettingsPanel />
      </>
    );
  }

  if (settings.isLoading) return <div className="card"><LoadingBlock rows={5} /></div>;

  return (
    <>
      <PageHeader title="System Settings" subtitle="Configuration keys and application defaults"
        actions={<button className="btn-primary" onClick={() => void save()} disabled={busy}>
          {busy && <Spinner size={14} />}<Save size={15} /> Save all
        </button>} />
      {tabs}

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
                  <p className="tabular-nums text-body font-medium text-brand-700">{s.key}</p>
                  {s.description && <p className="text-small text-ink-secondary">{s.description}</p>}
                </div>
                <div className="w-full sm:w-64">
                  {SETTING_CHOICES[s.key] ? (
                    <select className="input" id={`setting-${s.key}`} value={String(vals[s.key] ?? '').toUpperCase()}
                      disabled={s.is_editable !== undefined && s.is_editable !== null && Number(s.is_editable) === 0}
                      onChange={(e) => setVals((cur) => ({ ...cur, [s.key]: e.target.value }))}>
                      {!SETTING_CHOICES[s.key].some((o) => o.value === String(vals[s.key] ?? '').toUpperCase()) && <option value={vals[s.key] ?? ''}>{vals[s.key] || '— not set —'}</option>}
                      {SETTING_CHOICES[s.key].map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  ) : isFlag ? (
                    <button type="button" role="switch" aria-checked={on} disabled={!s.is_editable && s.is_editable !== undefined && s.is_editable !== null && Number(s.is_editable) === 0}
                      onClick={() => setVals((cur) => ({ ...cur, [s.key]: on ? '0' : '1' }))}
                      className={`flex items-center gap-2 rounded-full px-1 py-1 pr-3 text-small font-semibold transition-colors ${on ? 'bg-emerald-100 text-emerald-800' : 'bg-surface-header text-ink-secondary'}`}>
                      <span className={`h-5 w-9 rounded-full p-0.5 transition-colors ${on ? 'bg-emerald-500' : 'bg-surface-input'}`}>
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

/* ------------------------------------------------------------ Menu access */
/**
 * Per-role menu visibility (client call 15-Oct-2026: "nothing is deleted — only visibility; show modules user-wise").
 * Default = the standard menu (permissions decide). Hide = off this role's menu. Show = put a normally hidden
 * (older / tab) screen on it. Permissions still decide what a user can open and do.
 */
export function MenuAccessPage() {
  const toast = useToast();
  const qc = useQueryClient();
  const roles = useQuery({ queryKey: ['admin/roles'], queryFn: async () => (await http.get<{ data: any[] }>('/admin/roles')).data });
  const [roleId, setRoleId] = useState<string>('');
  const [find, setFind] = useState('');
  const [modes, setModes] = useState<Record<string, 'HIDE' | 'SHOW' | ''>>({});
  const [busy, setBusy] = useState(false);
  const current = useQuery({
    queryKey: ['admin/menu-access', roleId],
    enabled: !!roleId,
    queryFn: async () => (await http.get<{ data: { path: string; mode: 'HIDE' | 'SHOW' }[] }>(`/admin/menu-access?role_id=${roleId}`)).data,
  });
  useEffect(() => {
    if (!current.data) return;
    const m: Record<string, 'HIDE' | 'SHOW' | ''> = {};
    for (const r of current.data) m[r.path] = r.mode;
    setModes(m);
  }, [current.data]);
  const saved = new Map((current.data ?? []).map((r) => [r.path, r.mode]));
  const changed = Object.entries(modes).filter(([p, m]) => (saved.get(p) ?? '') !== m);

  const save = async () => {
    setBusy(true);
    try {
      await http.put('/admin/menu-access', { role_id: Number(roleId), items: changed.map(([path, mode]) => ({ path, mode: mode || null })) });
      toast('Menu access saved — users of this role see it on their next page load');
      void qc.invalidateQueries({ queryKey: ['admin/menu-access', roleId] });
      void qc.invalidateQueries({ queryKey: ['my-menu'] });
    } catch (e: any) { toast(e?.message || 'Could not save', 'error'); } finally { setBusy(false); }
  };

  const q = find.trim().toLowerCase();
  return (
    <>
      <PageHeader title="Menu Access" subtitle="Show or hide menu screens for a role — visibility only, nothing is deleted; permissions still apply"
        actions={<button className="btn-primary" id="ma-save" disabled={!roleId || !changed.length || busy} onClick={() => void save()}>
          {busy && <Spinner size={14} />}<Save size={15} /> Save{changed.length ? ` (${changed.length})` : ''}
        </button>} />
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <div className="w-72">
          <label className="label">Role</label>
          <select className="input" id="ma-role" value={roleId} onChange={(e) => { setRoleId(e.target.value); setModes({}); }}>
            <option value="">— choose a role —</option>
            {(roles.data ?? []).map((r: any) => <option key={r.id} value={r.id}>{r.role_name ?? r.role_code}</option>)}
          </select>
        </div>
        <SearchInput value={find} onChange={setFind} placeholder="Find a screen…" className="w-72" />
      </div>
      {!roleId ? <div className="card p-6 text-body text-ink-secondary">Choose a role to see its menu.</div>
        : current.isLoading ? <div className="card"><LoadingBlock rows={6} /></div> : (
        <div className="space-y-3" id="ma-list">
          {NAV.map((sec) => {
            const items = sec.items.filter((i) => !q || `${i.label} ${i.to} ${sec.label}`.toLowerCase().includes(q));
            if (!items.length) return null;
            return (
              <div key={sec.label} className="card p-4">
                <h3 className="mb-2 text-small font-semibold uppercase tracking-wider text-ink-secondary">{sec.label}</h3>
                <div className="divide-y divide-surface-border">
                  {items.map((i) => {
                    const m = modes[i.to] ?? '';
                    return (
                      <div key={i.to} className="flex flex-wrap items-center gap-3 py-2" data-menu-path={i.to}>
                        <div className="min-w-0 flex-1">
                          <p className="text-body font-medium text-ink">{i.label}
                            {i.hidden && <Badge tone="slate" className="ml-2">hidden by default</Badge>}</p>
                          <p className="tabular-nums text-caption text-ink-muted">{i.to} · needs {i.perms.join(' or ')}</p>
                        </div>
                        <div className="flex overflow-hidden rounded-lg border border-surface-border text-small">
                          {([['', 'Default'], ['SHOW', 'Show'], ['HIDE', 'Hide']] as const).map(([v, label]) => (
                            <button key={v} type="button" data-mode={v || 'DEFAULT'}
                              onClick={() => setModes((cur) => ({ ...cur, [i.to]: v }))}
                              className={`px-3 py-1 ${m === v ? (v === 'HIDE' ? 'bg-red-600 text-white' : v === 'SHOW' ? 'bg-emerald-600 text-white' : 'bg-slate-700 text-white') : 'text-ink-secondary hover:bg-surface-muted'}`}>
                              {label}
                            </button>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
