import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Building2, MapPin, Users, Landmark, ShoppingBag,
  Save, ArrowLeft, Plus, Trash2, ShieldCheck
} from 'lucide-react';
import { useItem, useSave } from '../../hooks/useResource';
import { useLookup } from '../../hooks/useLookup';
import { useToast } from '../../hooks/useToast';
import { Spinner } from '../../components/ui';

interface AddressItem {
  id?: number;
  address_name?: string;
  address_type: 'REGISTERED' | 'BILLING' | 'SHIPPING' | 'FACTORY' | 'WAREHOUSE';
  address_line1: string;
  address_line2?: string;
  address_line3?: string;
  city?: string;
  district?: string;
  state?: string;
  country_id?: number;
  pincode?: string;
  phone?: string;
  mobile?: string;
  email?: string;
  remarks?: string;
  is_default?: boolean | number;
  is_active?: boolean | number;
}

interface ContactItem {
  id?: number;
  contact_name: string;
  designation?: string;
  department?: string;
  email?: string;
  phone?: string;
  mobile?: string;
  whatsapp_no?: string;
  is_primary?: boolean | number;
  is_accounts_contact?: boolean | number;
  is_purchase_contact?: boolean | number;
  is_merchandising_contact?: boolean | number;
  remarks?: string;
  is_active?: boolean | number;
}

interface BankItem {
  id?: number;
  bank_name: string;
  branch_name?: string;
  account_name?: string;
  account_type?: 'CURRENT' | 'SAVINGS' | 'EEFC' | 'OD';
  account_no?: string;
  ifsc_code?: string;
  swift_code?: string;
  iban?: string;
  micr_code?: string;
  currency_id?: number;
  branch_address?: string;
  remarks?: string;
  is_default?: boolean | number;
}

const TDS_SECTIONS = [
  { value: '194C', label: '194C - Payment to Contractors / Job-Work (1% / 2%)', rate: '1% - 2%' },
  { value: '194Q', label: '194Q - Purchase of Goods > ₹50 Lakhs (0.1%)', rate: '0.1%' },
  { value: '194J', label: '194J - Professional & Technical Fees (2% / 10%)', rate: '2% / 10%' },
  { value: '194H', label: '194H - Commission or Brokerage / Buying Agents (5%)', rate: '5%' },
  { value: '194I_PLANT', label: '194I(a) - Rent on Machinery & Equipment (2%)', rate: '2%' },
  { value: '194I_BUILDING', label: '194I(b) - Rent on Land, Building & Factory Shed (10%)', rate: '10%' },
  { value: '194A', label: '194A - Interest other than securities (10%)', rate: '10%' },
  { value: '194R', label: '194R - Business Perquisites & Benefits (10%)', rate: '10%' },
  { value: '195', label: '195 - Payments to Non-Resident / Foreign Entity', rate: 'As per DTAA' },
];

const TCS_SECTIONS = [
  { value: '206C(1H)', label: '206C(1H) - TCS on Sale of Goods > ₹50 Lakhs (0.1%)', rate: '0.1%' },
  { value: '206C(1)', label: '206C(1) - TCS on Scrap & Waste Material (1%)', rate: '1%' },
];

export function PartyDetailPage() {
  const { id } = useParams();
  const isNew = !id || id === 'new';
  const nav = useNavigate();
  const toast = useToast();

  const [tab, setTab] = useState('general');
  const [selectedAddressIdx, setSelectedAddressIdx] = useState(0);
  const [selectedBankIdx, setSelectedBankIdx] = useState(0);
  const [selectedContactIdx, setSelectedContactIdx] = useState(0);

  const { data: countries } = useLookup('countries');
  const { data: currencies } = useLookup('currencies');

  const itemQuery = useItem<any>('parties', isNew ? 0 : Number(id));
  const saveMutation = useSave<any>('parties', 'Business Partner');

  const [form, setForm] = useState<any>({
    party_code: '',
    party_name: '',
    legal_name: '',
    short_name: '',
    is_buyer: 1,
    is_customer: 1,
    is_supplier: 0,
    is_vendor: 0,
    is_agent: 0,
    party_type: 'EXPORT',
    country_id: 101, // India default or null
    currency_id: 1,
    gstin: '',
    pan: '',
    tan: '',
    cin: '',
    tax_id_foreign: '',
    msme_type: 'NA',
    udyam_no: '',
    udyam_date: '',
    iec_no: '',
    tds_applicable: 0,
    tds_section: '',
    tcs_applicable: 0,
    tcs_section: '',
    payment_terms: 'LC 60 DAYS',
    default_incoterm: 'FOB',
    default_pol: 'Tuticorin (INTUT)',
    default_pod: '',
    default_aql: '2.5',
    brand_name: '',
    buyer_category: 'Regular',
    season: 'SS26',
    quality_standard: 'As per Tech Pack',
    lab_testing_required: 1,
    compliance_certifications: 'OEKO-TEX, BSCI, GOTS',
    packing_instructions: '',
    special_instructions: '',
    credit_limit: 0,
    credit_days: 45,
    email: '',
    phone: '',
    website: '',
    remarks: '',
    is_active: 1,
    addresses: [] as AddressItem[],
    contacts: [] as ContactItem[],
    banks: [] as BankItem[],
  });

  useEffect(() => {
    if (itemQuery.data?.data) {
      const d = itemQuery.data.data;
      setForm({
        ...d,
        addresses: d.addresses || [],
        contacts: d.contacts || [],
        banks: d.banks || [],
      });
    }
  }, [itemQuery.data]);

  const handleField = (key: string, val: any) => {
    setForm((prev: any) => ({ ...prev, [key]: val }));
  };

  const handleSave = async (saveAndNew = false) => {
    if (!form.party_code?.trim() || !form.party_name?.trim()) {
      toast('Partner Code and Partner Name are required', 'error');
      setTab('general');
      return;
    }

    try {
      const payload = {
        ...form,
        credit_limit: Number(form.credit_limit) || 0,
        credit_days: Number(form.credit_days) || 0,
        country_id: form.country_id ? Number(form.country_id) : null,
        currency_id: form.currency_id ? Number(form.currency_id) : null,
      };

      await saveMutation.mutateAsync({ id: isNew ? null : Number(id), body: payload });
      toast(isNew ? 'Business partner created successfully' : 'Business partner updated');

      if (saveAndNew) {
        nav('/masters/parties/new');
        setForm({
          party_code: '',
          party_name: '',
          is_buyer: 1,
          is_customer: 1,
          party_type: 'EXPORT',
          is_active: 1,
          addresses: [],
          contacts: [],
          banks: [],
        });
        setTab('general');
      } else {
        nav('/masters/parties');
      }
    } catch (err: any) {
      toast(`Save failed: ${err.message || 'Error occurred'}`, 'error');
    }
  };

  // Address helpers
  const addAddress = () => {
    const newAddr: AddressItem = {
      address_name: `Address ${form.addresses.length + 1}`,
      address_type: 'SHIPPING',
      address_line1: '',
      city: '',
      state: 'Tamil Nadu',
      country_id: form.country_id,
      pincode: '',
      is_default: form.addresses.length === 0 ? 1 : 0,
      is_active: 1,
    };
    setForm((prev: any) => ({ ...prev, addresses: [...prev.addresses, newAddr] }));
    setSelectedAddressIdx(form.addresses.length);
  };

  const removeAddress = (index: number) => {
    setForm((prev: any) => ({
      ...prev,
      addresses: prev.addresses.filter((_: any, i: number) => i !== index),
    }));
    if (selectedAddressIdx >= index && selectedAddressIdx > 0) {
      setSelectedAddressIdx(selectedAddressIdx - 1);
    }
  };

  const updateAddress = (key: keyof AddressItem, val: any) => {
    setForm((prev: any) => {
      const updated = [...prev.addresses];
      if (updated[selectedAddressIdx]) {
        updated[selectedAddressIdx] = { ...updated[selectedAddressIdx], [key]: val };
      }
      return { ...prev, addresses: updated };
    });
  };

  // Bank helpers
  const addBank = () => {
    const newBank: BankItem = {
      bank_name: 'HDFC Bank Ltd.',
      branch_name: '',
      account_name: form.party_name,
      account_type: 'CURRENT',
      account_no: '',
      ifsc_code: '',
      swift_code: '',
      is_default: form.banks.length === 0 ? 1 : 0,
    };
    setForm((prev: any) => ({ ...prev, banks: [...prev.banks, newBank] }));
    setSelectedBankIdx(form.banks.length);
  };

  const removeBank = (index: number) => {
    setForm((prev: any) => ({
      ...prev,
      banks: prev.banks.filter((_: any, i: number) => i !== index),
    }));
    if (selectedBankIdx >= index && selectedBankIdx > 0) {
      setSelectedBankIdx(selectedBankIdx - 1);
    }
  };

  const updateBank = (key: keyof BankItem, val: any) => {
    setForm((prev: any) => {
      const updated = [...prev.banks];
      if (updated[selectedBankIdx]) {
        updated[selectedBankIdx] = { ...updated[selectedBankIdx], [key]: val };
      }
      return { ...prev, banks: updated };
    });
  };

  // Contact helpers
  const addContact = () => {
    const newContact: ContactItem = {
      contact_name: '',
      designation: 'Merchandiser',
      department: 'Merchandising',
      email: '',
      mobile: '',
      phone: '',
      is_primary: form.contacts.length === 0 ? 1 : 0,
      is_active: 1,
    };
    setForm((prev: any) => ({ ...prev, contacts: [...prev.contacts, newContact] }));
    setSelectedContactIdx(form.contacts.length);
  };

  const removeContact = (index: number) => {
    setForm((prev: any) => ({
      ...prev,
      contacts: prev.contacts.filter((_: any, i: number) => i !== index),
    }));
    if (selectedContactIdx >= index && selectedContactIdx > 0) {
      setSelectedContactIdx(selectedContactIdx - 1);
    }
  };

  const updateContact = (key: keyof ContactItem, val: any) => {
    setForm((prev: any) => {
      const updated = [...prev.contacts];
      if (updated[selectedContactIdx]) {
        updated[selectedContactIdx] = { ...updated[selectedContactIdx], [key]: val };
      }
      return { ...prev, contacts: updated };
    });
  };

  const currentAddress = form.addresses[selectedAddressIdx] || null;
  const currentBank = form.banks[selectedBankIdx] || null;
  const currentContact = form.contacts[selectedContactIdx] || null;

  if (itemQuery.isLoading) {
    return (
      <div className="flex h-96 items-center justify-center">
        <Spinner size={28} />
      </div>
    );
  }

  const TABS = [
    { key: 'general', label: 'General', icon: Building2 },
    { key: 'address', label: 'Address', count: form.addresses.length, icon: MapPin },
    { key: 'contacts', label: 'Contacts', count: form.contacts.length, icon: Users },
    { key: 'statutory', label: 'Statutory', icon: ShieldCheck },
    { key: 'bank', label: 'Bank', count: form.banks.length, icon: Landmark },
    { key: 'buyer', label: 'Buyer Details', icon: ShoppingBag },
  ];

  return (
    <div className="space-y-4 pb-12">
      {/* Top Action Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-surface-border bg-white p-4 rounded-xl shadow-card">
        <div className="flex items-center gap-3">
          <button onClick={() => nav('/masters/parties')} className="btn-secondary btn-sm" title="Back">
            <ArrowLeft size={16} />
          </button>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-bold text-slate-900">
                {isNew ? 'Create Business Partner' : form.party_name || 'Business Partner'}
              </h1>
              <span className="font-mono text-xs font-semibold px-2 py-0.5 rounded bg-brand-50 text-brand-700">
                {form.party_code || 'BP-NEW'}
              </span>
              <span className={`badge ${form.is_active ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-600'}`}>
                {form.is_active ? 'Active' : 'Inactive'}
              </span>
            </div>
            <p className="text-xs text-slate-500">
              Manage multi-role partner profiles, addresses, contacts, tax compliance and banking.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button onClick={() => nav('/masters/parties')} className="btn-secondary btn-sm">
            Cancel
          </button>
          <button onClick={() => void handleSave(true)} disabled={saveMutation.isPending} className="btn-secondary btn-sm">
            Save & New
          </button>
          <button onClick={() => void handleSave(false)} disabled={saveMutation.isPending} className="btn-primary btn-sm flex items-center gap-1.5">
            <Save size={14} />
            {saveMutation.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>

      {/* Main Tab Navigation */}
      <div className="flex items-center gap-1 border-b border-surface-border bg-white px-3 py-1.5 rounded-xl shadow-card">
        {TABS.map((t) => {
          const Icon = t.icon;
          const isActive = tab === t.key;
          return (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg transition-all ${
                isActive
                  ? 'bg-brand-600 text-white shadow-sm'
                  : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
              }`}
            >
              <Icon size={14} />
              <span>{t.label}</span>
              {t.count !== undefined && t.count > 0 && (
                <span className={`px-1.5 py-0.2 rounded-full text-[10px] ${
                  isActive ? 'bg-white/20 text-white' : 'bg-slate-200 text-slate-700'
                }`}>
                  {t.count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Tab 1: General */}
      {tab === 'general' && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          {/* Basic Info */}
          <div className="card p-5 lg:col-span-2 space-y-4">
            <h3 className="text-sm font-bold text-slate-800 border-b border-surface-border pb-2">
              Basic Information
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="label">BP Code *</label>
                <input
                  className="input font-mono font-semibold text-brand-700"
                  value={form.party_code}
                  onChange={(e) => handleField('party_code', e.target.value.toUpperCase())}
                  placeholder="e.g. B001 or BP000123"
                />
              </div>
              <div>
                <label className="label">BP Display Name *</label>
                <input
                  className="input"
                  value={form.party_name}
                  onChange={(e) => handleField('party_name', e.target.value)}
                  placeholder="e.g. H&M Hennes & Mauritz AB"
                />
              </div>
              <div>
                <label className="label">Legal Name</label>
                <input
                  className="input"
                  value={form.legal_name || ''}
                  onChange={(e) => handleField('legal_name', e.target.value)}
                  placeholder="Registered corporate name"
                />
              </div>
              <div>
                <label className="label">Short / Trade Name</label>
                <input
                  className="input"
                  value={form.short_name || ''}
                  onChange={(e) => handleField('short_name', e.target.value)}
                  placeholder="Short name or brand identifier"
                />
              </div>
            </div>

            {/* BP Roles Checklist */}
            <div className="pt-2">
              <label className="label">Business Partner Roles *</label>
              <div className="flex flex-wrap gap-3 p-3 bg-slate-50 border border-surface-border rounded-lg">
                {[
                  { key: 'is_buyer', label: 'Buyer', color: 'blue' },
                  { key: 'is_customer', label: 'Customer', color: 'indigo' },
                  { key: 'is_supplier', label: 'Supplier', color: 'emerald' },
                  { key: 'is_vendor', label: 'Job Worker / CMT', color: 'purple' },
                  { key: 'is_agent', label: 'Buying Agent', color: 'amber' },
                ].map((r) => (
                  <label key={r.key} className="flex items-center gap-2 cursor-pointer text-xs font-semibold text-slate-700">
                    <input
                      type="checkbox"
                      className="rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                      checked={!!form[r.key]}
                      onChange={(e) => handleField(r.key, e.target.checked ? 1 : 0)}
                    />
                    <span>{r.label}</span>
                  </label>
                ))}
              </div>
            </div>

            {/* Classification */}
            <h3 className="text-sm font-bold text-slate-800 border-b border-surface-border pt-4 pb-2">
              Trading & Classification
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label className="label">Partner Type</label>
                <select
                  className="input"
                  value={form.party_type}
                  onChange={(e) => handleField('party_type', e.target.value)}
                >
                  <option value="EXPORT">Export</option>
                  <option value="DOMESTIC">Domestic</option>
                  <option value="BOTH">Both</option>
                </select>
              </div>
              <div>
                <label className="label">Country</label>
                <select
                  className="input"
                  value={form.country_id || ''}
                  onChange={(e) => handleField('country_id', e.target.value)}
                >
                  <option value="">Select Country</option>
                  {(countries || []).map((c: any) => (
                    <option key={c.id} value={c.id}>{c.name} ({c.iso2})</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label">Default Currency</label>
                <select
                  className="input"
                  value={form.currency_id || ''}
                  onChange={(e) => handleField('currency_id', e.target.value)}
                >
                  <option value="">Select Currency</option>
                  {(currencies || []).map((c: any) => (
                    <option key={c.id} value={c.id}>{c.code} - {c.name}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-2">
              <div>
                <label className="label">Email Address</label>
                <input
                  type="email"
                  className="input"
                  value={form.email || ''}
                  onChange={(e) => handleField('email', e.target.value)}
                  placeholder="contact@company.com"
                />
              </div>
              <div>
                <label className="label">Phone</label>
                <input
                  className="input"
                  value={form.phone || ''}
                  onChange={(e) => handleField('phone', e.target.value)}
                  placeholder="+91 421 220 1234"
                />
              </div>
              <div>
                <label className="label">Website</label>
                <input
                  className="input"
                  value={form.website || ''}
                  onChange={(e) => handleField('website', e.target.value)}
                  placeholder="https://company.com"
                />
              </div>
            </div>

            <div>
              <label className="label">General Remarks</label>
              <textarea
                className="input h-20"
                value={form.remarks || ''}
                onChange={(e) => handleField('remarks', e.target.value)}
                placeholder="Internal partner notes, delivery instructions or credit history..."
              />
            </div>
          </div>

          {/* Quick Summary Card */}
          <div className="space-y-4">
            <div className="card p-5 space-y-4">
              <h3 className="text-sm font-bold text-slate-800 border-b border-surface-border pb-2">
                Status & Overview
              </h3>
              <div className="space-y-3 text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-slate-500">Active Status</span>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={!!form.is_active}
                      onChange={(e) => handleField('is_active', e.target.checked ? 1 : 0)}
                      className="rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                    />
                    <span className="font-semibold text-slate-700">{form.is_active ? 'Active' : 'Inactive'}</span>
                  </label>
                </div>
                <div className="flex items-center justify-between border-t border-slate-100 pt-2">
                  <span className="text-slate-500">Credit Days</span>
                  <span className="font-bold text-slate-800">{form.credit_days || 0} Days</span>
                </div>
                <div className="flex items-center justify-between border-t border-slate-100 pt-2">
                  <span className="text-slate-500">Default Terms</span>
                  <span className="font-semibold text-brand-700">{form.payment_terms || '—'}</span>
                </div>
                <div className="flex items-center justify-between border-t border-slate-100 pt-2">
                  <span className="text-slate-500">Total Addresses</span>
                  <span className="font-bold text-slate-800">{form.addresses.length}</span>
                </div>
                <div className="flex items-center justify-between border-t border-slate-100 pt-2">
                  <span className="text-slate-500">Contact Persons</span>
                  <span className="font-bold text-slate-800">{form.contacts.length}</span>
                </div>
                <div className="flex items-center justify-between border-t border-slate-100 pt-2">
                  <span className="text-slate-500">Bank Accounts</span>
                  <span className="font-bold text-slate-800">{form.banks.length}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Tab 2: Address */}
      {tab === 'address' && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-4">
          {/* Left list of address types */}
          <div className="card p-3 space-y-2">
            <div className="flex items-center justify-between pb-2 border-b border-surface-border">
              <span className="text-xs font-bold text-slate-700 uppercase tracking-wide">Addresses</span>
              <button onClick={addAddress} className="btn-primary btn-sm py-1 px-2 text-[11px] flex items-center gap-1">
                <Plus size={12} /> Add
              </button>
            </div>
            {form.addresses.length === 0 ? (
              <div className="p-4 text-center text-xs text-slate-400">
                No addresses added yet. Click "+ Add" to add registered, billing or shipping address.
              </div>
            ) : (
              <div className="space-y-1">
                {form.addresses.map((addr: AddressItem, i: number) => (
                  <div
                    key={i}
                    onClick={() => setSelectedAddressIdx(i)}
                    className={`flex items-center justify-between p-2.5 rounded-lg cursor-pointer transition-colors text-xs ${
                      selectedAddressIdx === i
                        ? 'bg-brand-50 border border-brand-200 text-brand-900 font-semibold'
                        : 'hover:bg-slate-50 text-slate-700 border border-transparent'
                    }`}
                  >
                    <div className="flex items-center gap-2 truncate">
                      <MapPin size={14} className={selectedAddressIdx === i ? 'text-brand-600' : 'text-slate-400'} />
                      <span className="truncate">{addr.address_name || `${addr.address_type} Address`}</span>
                    </div>
                    {addr.is_default ? (
                      <span className="px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800 text-[10px] font-bold">Primary</span>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Right Address Editor */}
          <div className="card p-5 lg:col-span-3 space-y-4">
            {currentAddress ? (
              <>
                <div className="flex items-center justify-between border-b border-surface-border pb-3">
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-bold text-slate-800">
                      {currentAddress.address_name || 'Address Details'}
                    </h3>
                    {currentAddress.is_default ? (
                      <span className="badge bg-emerald-100 text-emerald-800 text-[10px]">Primary Address</span>
                    ) : null}
                  </div>
                  <button
                    onClick={() => removeAddress(selectedAddressIdx)}
                    className="btn-danger btn-sm py-1 px-2.5 text-xs flex items-center gap-1"
                  >
                    <Trash2 size={13} /> Delete Address
                  </button>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <div>
                    <label className="label">Address Name</label>
                    <input
                      className="input"
                      value={currentAddress.address_name || ''}
                      onChange={(e) => updateAddress('address_name', e.target.value)}
                      placeholder="e.g. Registered Office, Tiruppur Unit 1"
                    />
                  </div>
                  <div>
                    <label className="label">Address Type *</label>
                    <select
                      className="input"
                      value={currentAddress.address_type}
                      onChange={(e) => updateAddress('address_type', e.target.value as any)}
                    >
                      <option value="REGISTERED">Registered Address</option>
                      <option value="BILLING">Billing Address</option>
                      <option value="SHIPPING">Shipping Address (Port / Warehouse)</option>
                      <option value="FACTORY">Factory / Production Unit</option>
                      <option value="WAREHOUSE">Warehouse / Store</option>
                    </select>
                  </div>
                  <div className="flex items-center pt-6">
                    <label className="flex items-center gap-2 cursor-pointer text-xs font-semibold text-slate-700">
                      <input
                        type="checkbox"
                        checked={!!currentAddress.is_default}
                        onChange={(e) => updateAddress('is_default', e.target.checked ? 1 : 0)}
                        className="rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                      />
                      <span>Set as Primary Address</span>
                    </label>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <div>
                    <label className="label">Address Line 1 *</label>
                    <input
                      className="input"
                      value={currentAddress.address_line1}
                      onChange={(e) => updateAddress('address_line1', e.target.value)}
                      placeholder="Door No, Street Name"
                    />
                  </div>
                  <div>
                    <label className="label">Address Line 2</label>
                    <input
                      className="input"
                      value={currentAddress.address_line2 || ''}
                      onChange={(e) => updateAddress('address_line2', e.target.value)}
                      placeholder="Area, Landmark"
                    />
                  </div>
                  <div>
                    <label className="label">Address Line 3</label>
                    <input
                      className="input"
                      value={currentAddress.address_line3 || ''}
                      onChange={(e) => updateAddress('address_line3', e.target.value)}
                      placeholder="Extended address details"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
                  <div>
                    <label className="label">City *</label>
                    <input
                      className="input"
                      value={currentAddress.city || ''}
                      onChange={(e) => updateAddress('city', e.target.value)}
                      placeholder="City (e.g. Tiruppur)"
                    />
                  </div>
                  <div>
                    <label className="label">District</label>
                    <input
                      className="input"
                      value={currentAddress.district || ''}
                      onChange={(e) => updateAddress('district', e.target.value)}
                      placeholder="District"
                    />
                  </div>
                  <div>
                    <label className="label">State *</label>
                    <input
                      className="input"
                      value={currentAddress.state || ''}
                      onChange={(e) => updateAddress('state', e.target.value)}
                      placeholder="State (e.g. Tamil Nadu)"
                    />
                  </div>
                  <div>
                    <label className="label">Pincode / Postal Code *</label>
                    <input
                      className="input"
                      value={currentAddress.pincode || ''}
                      onChange={(e) => updateAddress('pincode', e.target.value)}
                      placeholder="Pincode (e.g. 641602)"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <div>
                    <label className="label">Phone</label>
                    <input
                      className="input"
                      value={currentAddress.phone || ''}
                      onChange={(e) => updateAddress('phone', e.target.value)}
                      placeholder="Landline / Direct number"
                    />
                  </div>
                  <div>
                    <label className="label">Mobile</label>
                    <input
                      className="input"
                      value={currentAddress.mobile || ''}
                      onChange={(e) => updateAddress('mobile', e.target.value)}
                      placeholder="Mobile number"
                    />
                  </div>
                  <div>
                    <label className="label">Email</label>
                    <input
                      className="input"
                      type="email"
                      value={currentAddress.email || ''}
                      onChange={(e) => updateAddress('email', e.target.value)}
                      placeholder="location@company.com"
                    />
                  </div>
                </div>
              </>
            ) : (
              <div className="p-12 text-center text-slate-400">
                <MapPin size={32} className="mx-auto mb-2 text-slate-300" />
                <p className="text-sm font-semibold">No address selected</p>
                <button onClick={addAddress} className="btn-primary btn-sm mt-3">
                  + Add First Address
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Tab 3: Contacts */}
      {tab === 'contacts' && (
        <div className="space-y-4">
          <div className="card overflow-hidden">
            <div className="flex items-center justify-between p-4 border-b border-surface-border bg-slate-50/50">
              <div>
                <h3 className="text-sm font-bold text-slate-800">Contact Persons</h3>
                <p className="text-xs text-slate-500">Key contacts for merchandising, accounts, purchase & logistics</p>
              </div>
              <button onClick={addContact} className="btn-primary btn-sm flex items-center gap-1">
                <Plus size={14} /> Add Contact
              </button>
            </div>

            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-surface-border bg-slate-50 text-slate-500 font-bold uppercase text-[11px]">
                  <th className="p-3 text-left">#</th>
                  <th className="p-3 text-left">Name</th>
                  <th className="p-3 text-left">Designation</th>
                  <th className="p-3 text-left">Department</th>
                  <th className="p-3 text-left">Mobile / WhatsApp</th>
                  <th className="p-3 text-left">Email</th>
                  <th className="p-3 text-center">Primary</th>
                  <th className="p-3 text-center">Accounts</th>
                  <th className="p-3 text-center">Merchandising</th>
                  <th className="p-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {form.contacts.length === 0 ? (
                  <tr>
                    <td colSpan={10} className="p-8 text-center text-slate-400">
                      No contacts added yet. Click "+ Add Contact" to add merchandisers or managers.
                    </td>
                  </tr>
                ) : (
                  form.contacts.map((c: ContactItem, i: number) => (
                    <tr key={i} className={selectedContactIdx === i ? 'bg-brand-50/60' : 'hover:bg-slate-50'}>
                      <td className="p-3 text-slate-400">{i + 1}</td>
                      <td className="p-3 font-semibold text-slate-800">{c.contact_name || '—'}</td>
                      <td className="p-3 text-slate-600">{c.designation || '—'}</td>
                      <td className="p-3 text-slate-600">{c.department || '—'}</td>
                      <td className="p-3 font-mono">{c.mobile || c.whatsapp_no || '—'}</td>
                      <td className="p-3 text-brand-600">{c.email || '—'}</td>
                      <td className="p-3 text-center">
                        {c.is_primary ? <span className="px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800 font-bold">Yes</span> : '—'}
                      </td>
                      <td className="p-3 text-center">
                        {c.is_accounts_contact ? <span className="px-1.5 py-0.5 rounded bg-blue-100 text-blue-800 font-bold">Yes</span> : '—'}
                      </td>
                      <td className="p-3 text-center">
                        {c.is_merchandising_contact ? <span className="px-1.5 py-0.5 rounded bg-purple-100 text-purple-800 font-bold">Yes</span> : '—'}
                      </td>
                      <td className="p-3 text-right space-x-2">
                        <button
                          onClick={() => setSelectedContactIdx(i)}
                          className="text-xs font-semibold text-brand-600 hover:text-brand-800"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => removeContact(i)}
                          className="text-xs font-semibold text-red-600 hover:text-red-800"
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {/* Contact Edit Drawer / Box */}
          {currentContact && (
            <div className="card p-5 space-y-4">
              <h3 className="text-sm font-bold text-slate-800 border-b border-surface-border pb-2">
                Edit Contact Details (#{selectedContactIdx + 1})
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
                <div>
                  <label className="label">Contact Name *</label>
                  <input
                    className="input"
                    value={currentContact.contact_name}
                    onChange={(e) => updateContact('contact_name', e.target.value)}
                    placeholder="Full name"
                  />
                </div>
                <div>
                  <label className="label">Designation</label>
                  <input
                    className="input"
                    value={currentContact.designation || ''}
                    onChange={(e) => updateContact('designation', e.target.value)}
                    placeholder="e.g. Sourcing Manager"
                  />
                </div>
                <div>
                  <label className="label">Department</label>
                  <select
                    className="input"
                    value={currentContact.department || ''}
                    onChange={(e) => updateContact('department', e.target.value)}
                  >
                    <option value="Merchandising">Merchandising</option>
                    <option value="Sourcing">Sourcing / Purchase</option>
                    <option value="Accounts">Accounts / Finance</option>
                    <option value="Quality">Quality / Compliance</option>
                    <option value="Logistics">Logistics / Shipping</option>
                    <option value="Management">Management</option>
                  </select>
                </div>
                <div>
                  <label className="label">Email Address *</label>
                  <input
                    type="email"
                    className="input"
                    value={currentContact.email || ''}
                    onChange={(e) => updateContact('email', e.target.value)}
                    placeholder="person@buyer.com"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div>
                  <label className="label">Mobile Number</label>
                  <input
                    className="input"
                    value={currentContact.mobile || ''}
                    onChange={(e) => updateContact('mobile', e.target.value)}
                    placeholder="+91 98765 43210"
                  />
                </div>
                <div>
                  <label className="label">WhatsApp Number</label>
                  <input
                    className="input"
                    value={currentContact.whatsapp_no || ''}
                    onChange={(e) => updateContact('whatsapp_no', e.target.value)}
                    placeholder="+91 98765 43210"
                  />
                </div>
                <div>
                  <label className="label">Phone / Extension</label>
                  <input
                    className="input"
                    value={currentContact.phone || ''}
                    onChange={(e) => updateContact('phone', e.target.value)}
                    placeholder="Direct office phone"
                  />
                </div>
              </div>

              <div className="flex flex-wrap gap-4 pt-2 p-3 bg-slate-50 rounded-lg border border-surface-border">
                <label className="flex items-center gap-2 cursor-pointer text-xs font-semibold text-slate-700">
                  <input
                    type="checkbox"
                    checked={!!currentContact.is_primary}
                    onChange={(e) => updateContact('is_primary', e.target.checked ? 1 : 0)}
                    className="rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                  />
                  <span>Primary Contact</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer text-xs font-semibold text-slate-700">
                  <input
                    type="checkbox"
                    checked={!!currentContact.is_merchandising_contact}
                    onChange={(e) => updateContact('is_merchandising_contact', e.target.checked ? 1 : 0)}
                    className="rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                  />
                  <span>Merchandising Contact</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer text-xs font-semibold text-slate-700">
                  <input
                    type="checkbox"
                    checked={!!currentContact.is_accounts_contact}
                    onChange={(e) => updateContact('is_accounts_contact', e.target.checked ? 1 : 0)}
                    className="rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                  />
                  <span>Accounts / Billing Contact</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer text-xs font-semibold text-slate-700">
                  <input
                    type="checkbox"
                    checked={!!currentContact.is_purchase_contact}
                    onChange={(e) => updateContact('is_purchase_contact', e.target.checked ? 1 : 0)}
                    className="rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                  />
                  <span>Purchase / Sourcing Contact</span>
                </label>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Tab 4: Statutory & Taxes */}
      {tab === 'statutory' && (
        <div className="card p-5 space-y-6">
          <div>
            <h3 className="text-sm font-bold text-slate-800 border-b border-surface-border pb-2">
              GST & Direct Tax Details (Domestic & Overseas)
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-4 pt-3">
              <div>
                <label className="label">GSTIN (India)</label>
                <input
                  className="input font-mono font-semibold"
                  value={form.gstin || ''}
                  onChange={(e) => handleField('gstin', e.target.value.toUpperCase())}
                  placeholder="33AABCT1234B1Z5"
                  maxLength={15}
                />
              </div>
              <div>
                <label className="label">PAN (Income Tax)</label>
                <input
                  className="input font-mono font-semibold"
                  value={form.pan || ''}
                  onChange={(e) => handleField('pan', e.target.value.toUpperCase())}
                  placeholder="AABCT1234B"
                  maxLength={10}
                />
              </div>
              <div>
                <label className="label">TAN No.</label>
                <input
                  className="input font-mono"
                  value={form.tan || ''}
                  onChange={(e) => handleField('tan', e.target.value.toUpperCase())}
                  placeholder="CHNA12345D"
                  maxLength={15}
                />
              </div>
              <div>
                <label className="label">Foreign Tax ID (VAT / EIN)</label>
                <input
                  className="input font-mono"
                  value={form.tax_id_foreign || ''}
                  onChange={(e) => handleField('tax_id_foreign', e.target.value)}
                  placeholder="Overseas VAT / EIN ID"
                />
              </div>
            </div>
          </div>

          <div>
            <h3 className="text-sm font-bold text-slate-800 border-b border-surface-border pb-2">
              MSME / Udyam & Export Registration
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-4 pt-3">
              <div>
                <label className="label">MSME Type (Section 43B-h)</label>
                <select
                  className="input"
                  value={form.msme_type || 'NA'}
                  onChange={(e) => handleField('msme_type', e.target.value)}
                >
                  <option value="NA">Not Applicable / Large</option>
                  <option value="MICRO">Micro Enterprise</option>
                  <option value="SMALL">Small Enterprise</option>
                  <option value="MEDIUM">Medium Enterprise</option>
                </select>
              </div>
              <div>
                <label className="label">Udyam Registration No.</label>
                <input
                  className="input font-mono"
                  value={form.udyam_no || ''}
                  onChange={(e) => handleField('udyam_no', e.target.value)}
                  placeholder="UDYAM-TN-02-0001234"
                />
              </div>
              <div>
                <label className="label">IEC No. (Import Export Code)</label>
                <input
                  className="input font-mono font-semibold"
                  value={form.iec_no || ''}
                  onChange={(e) => handleField('iec_no', e.target.value.toUpperCase())}
                  placeholder="0412001234"
                />
              </div>
              <div>
                <label className="label">CIN (Corporate ID)</label>
                <input
                  className="input font-mono"
                  value={form.cin || ''}
                  onChange={(e) => handleField('cin', e.target.value)}
                  placeholder="U17110TN2015PTC098765"
                />
              </div>
            </div>
          </div>

          <div>
            <h3 className="text-sm font-bold text-slate-800 border-b border-surface-border pb-2">
              TDS & TCS Applicability
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-4 pt-3">
              <div>
                <label className="label">TDS Applicable</label>
                <select
                  className="input font-semibold"
                  value={form.tds_applicable ? '1' : '0'}
                  onChange={(e) => {
                    const isYes = e.target.value === '1';
                    handleField('tds_applicable', isYes ? 1 : 0);
                    if (!isYes) {
                      handleField('tds_section', '');
                    } else if (!form.tds_section) {
                      handleField('tds_section', '194C');
                    }
                  }}
                >
                  <option value="0">No</option>
                  <option value="1">Yes</option>
                </select>
              </div>

              {form.tds_applicable ? (
                <div>
                  <label className="label">TDS Section *</label>
                  <select
                    className="input font-medium text-slate-800"
                    value={form.tds_section || '194C'}
                    onChange={(e) => handleField('tds_section', e.target.value)}
                  >
                    <option value="">Select TDS Section</option>
                    {TDS_SECTIONS.map((sec) => (
                      <option key={sec.value} value={sec.value}>
                        {sec.label}
                      </option>
                    ))}
                  </select>
                </div>
              ) : (
                <div>
                  <label className="label text-slate-400">TDS Section</label>
                  <input
                    className="input bg-slate-50 text-slate-400 cursor-not-allowed"
                    disabled
                    value="Not Applicable"
                  />
                </div>
              )}

              <div>
                <label className="label">TCS Applicable</label>
                <select
                  className="input font-semibold"
                  value={form.tcs_applicable ? '1' : '0'}
                  onChange={(e) => {
                    const isYes = e.target.value === '1';
                    handleField('tcs_applicable', isYes ? 1 : 0);
                    if (!isYes) {
                      handleField('tcs_section', '');
                    } else if (!form.tcs_section) {
                      handleField('tcs_section', '206C(1H)');
                    }
                  }}
                >
                  <option value="0">No</option>
                  <option value="1">Yes</option>
                </select>
              </div>

              {form.tcs_applicable ? (
                <div>
                  <label className="label">TCS Section *</label>
                  <select
                    className="input font-medium text-slate-800"
                    value={form.tcs_section || '206C(1H)'}
                    onChange={(e) => handleField('tcs_section', e.target.value)}
                  >
                    <option value="">Select TCS Section</option>
                    {TCS_SECTIONS.map((sec) => (
                      <option key={sec.value} value={sec.value}>
                        {sec.label}
                      </option>
                    ))}
                  </select>
                </div>
              ) : (
                <div>
                  <label className="label text-slate-400">TCS Section</label>
                  <input
                    className="input bg-slate-50 text-slate-400 cursor-not-allowed"
                    disabled
                    value="Not Applicable"
                  />
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Tab 5: Bank Accounts */}
      {tab === 'bank' && (
        <div className="space-y-4">
          <div className="card overflow-hidden">
            <div className="flex items-center justify-between p-4 border-b border-surface-border bg-slate-50/50">
              <div>
                <h3 className="text-sm font-bold text-slate-800">Bank Accounts</h3>
                <p className="text-xs text-slate-500">Accounts for wire transfers, LC remittances, and vendor payments</p>
              </div>
              <button onClick={addBank} className="btn-primary btn-sm flex items-center gap-1">
                <Plus size={14} /> Add Bank Account
              </button>
            </div>

            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-surface-border bg-slate-50 text-slate-500 font-bold uppercase text-[11px]">
                  <th className="p-3 text-left">#</th>
                  <th className="p-3 text-left">Bank Name</th>
                  <th className="p-3 text-left">Branch</th>
                  <th className="p-3 text-left">Account Name</th>
                  <th className="p-3 text-left">Account No.</th>
                  <th className="p-3 text-left">IFSC Code</th>
                  <th className="p-3 text-left">SWIFT Code</th>
                  <th className="p-3 text-left">Account Type</th>
                  <th className="p-3 text-center">Primary</th>
                  <th className="p-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {form.banks.length === 0 ? (
                  <tr>
                    <td colSpan={10} className="p-8 text-center text-slate-400">
                      No bank accounts added yet. Click "+ Add Bank Account" to add settlement accounts.
                    </td>
                  </tr>
                ) : (
                  form.banks.map((b: BankItem, i: number) => (
                    <tr key={i} className={selectedBankIdx === i ? 'bg-brand-50/60' : 'hover:bg-slate-50'}>
                      <td className="p-3 text-slate-400">{i + 1}</td>
                      <td className="p-3 font-semibold text-slate-800">{b.bank_name}</td>
                      <td className="p-3 text-slate-600">{b.branch_name || '—'}</td>
                      <td className="p-3 text-slate-600">{b.account_name || '—'}</td>
                      <td className="p-3 font-mono font-medium">{b.account_no || '—'}</td>
                      <td className="p-3 font-mono text-slate-600">{b.ifsc_code || '—'}</td>
                      <td className="p-3 font-mono text-slate-600">{b.swift_code || '—'}</td>
                      <td className="p-3 text-slate-600">{b.account_type || 'CURRENT'}</td>
                      <td className="p-3 text-center">
                        {b.is_default ? <span className="px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800 font-bold">Yes</span> : '—'}
                      </td>
                      <td className="p-3 text-right space-x-2">
                        <button
                          onClick={() => setSelectedBankIdx(i)}
                          className="text-xs font-semibold text-brand-600 hover:text-brand-800"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => removeBank(i)}
                          className="text-xs font-semibold text-red-600 hover:text-red-800"
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {/* Bank Editor */}
          {currentBank && (
            <div className="card p-5 space-y-4">
              <h3 className="text-sm font-bold text-slate-800 border-b border-surface-border pb-2">
                Edit Bank Account (#{selectedBankIdx + 1})
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
                <div>
                  <label className="label">Bank Name *</label>
                  <input
                    className="input"
                    value={currentBank.bank_name}
                    onChange={(e) => updateBank('bank_name', e.target.value)}
                    placeholder="e.g. HDFC Bank Ltd. / HSBC"
                  />
                </div>
                <div>
                  <label className="label">Branch Name</label>
                  <input
                    className="input"
                    value={currentBank.branch_name || ''}
                    onChange={(e) => updateBank('branch_name', e.target.value)}
                    placeholder="Branch name or city"
                  />
                </div>
                <div>
                  <label className="label">Account Name *</label>
                  <input
                    className="input"
                    value={currentBank.account_name || ''}
                    onChange={(e) => updateBank('account_name', e.target.value)}
                    placeholder="Beneficiary Account Name"
                  />
                </div>
                <div>
                  <label className="label">Account Type</label>
                  <select
                    className="input"
                    value={currentBank.account_type || 'CURRENT'}
                    onChange={(e) => updateBank('account_type', e.target.value as any)}
                  >
                    <option value="CURRENT">Current Account</option>
                    <option value="SAVINGS">Savings Account</option>
                    <option value="EEFC">EEFC (Exchange Earner's Foreign Currency)</option>
                    <option value="OD">Overdraft / Cash Credit</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
                <div>
                  <label className="label">Account Number *</label>
                  <input
                    className="input font-mono font-semibold"
                    value={currentBank.account_no || ''}
                    onChange={(e) => updateBank('account_no', e.target.value)}
                    placeholder="Bank Account Number"
                  />
                </div>
                <div>
                  <label className="label">IFSC Code (Domestic INR)</label>
                  <input
                    className="input font-mono"
                    value={currentBank.ifsc_code || ''}
                    onChange={(e) => updateBank('ifsc_code', e.target.value.toUpperCase())}
                    placeholder="e.g. HDFC0001234"
                  />
                </div>
                <div>
                  <label className="label">SWIFT Code (Overseas / Forex)</label>
                  <input
                    className="input font-mono"
                    value={currentBank.swift_code || ''}
                    onChange={(e) => updateBank('swift_code', e.target.value.toUpperCase())}
                    placeholder="e.g. HDFCINBBXXX"
                  />
                </div>
                <div>
                  <label className="label">IBAN No.</label>
                  <input
                    className="input font-mono"
                    value={currentBank.iban || ''}
                    onChange={(e) => updateBank('iban', e.target.value)}
                    placeholder="International Bank Account No."
                  />
                </div>
              </div>

              <div className="flex items-center gap-2 pt-2">
                <label className="flex items-center gap-2 cursor-pointer text-xs font-semibold text-slate-700">
                  <input
                    type="checkbox"
                    checked={!!currentBank.is_default}
                    onChange={(e) => updateBank('is_default', e.target.checked ? 1 : 0)}
                    className="rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                  />
                  <span>Primary Bank Account for Payments / Remittances</span>
                </label>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Tab 6: Buyer Details */}
      {tab === 'buyer' && (
        <div className="card p-5 space-y-6">
          <div>
            <h3 className="text-sm font-bold text-slate-800 border-b border-surface-border pb-2">
              Buyer Commercial & Shipping Defaults
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-4 pt-3">
              <div>
                <label className="label">Brand / Customer Code</label>
                <input
                  className="input"
                  value={form.brand_name || ''}
                  onChange={(e) => handleField('brand_name', e.target.value)}
                  placeholder="e.g. H&M DIVIDED / LOGG"
                />
              </div>
              <div>
                <label className="label">Default Incoterm</label>
                <select
                  className="input"
                  value={form.default_incoterm || 'FOB'}
                  onChange={(e) => handleField('default_incoterm', e.target.value)}
                >
                  <option value="FOB">FOB - Free on Board</option>
                  <option value="CIF">CIF - Cost, Insurance & Freight</option>
                  <option value="CFR">CFR - Cost and Freight</option>
                  <option value="EXW">EXW - Ex Works</option>
                  <option value="DDP">DDP - Delivered Duty Paid</option>
                  <option value="DAP">DAP - Delivered at Place</option>
                  <option value="FCA">FCA - Free Carrier</option>
                </select>
              </div>
              <div>
                <label className="label">Port of Loading (POL)</label>
                <input
                  className="input"
                  value={form.default_pol || ''}
                  onChange={(e) => handleField('default_pol', e.target.value)}
                  placeholder="e.g. Tuticorin (INTUT) / Chennai (INMAA)"
                />
              </div>
              <div>
                <label className="label">Port of Discharge (POD)</label>
                <input
                  className="input"
                  value={form.default_pod || ''}
                  onChange={(e) => handleField('default_pod', e.target.value)}
                  placeholder="e.g. Rotterdam (NLRTM) / Hamburg"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-4 gap-4 pt-3">
              <div>
                <label className="label">Payment Terms</label>
                <input
                  className="input"
                  value={form.payment_terms || ''}
                  onChange={(e) => handleField('payment_terms', e.target.value)}
                  placeholder="e.g. LC 60 DAYS / TT 30 DAYS"
                />
              </div>
              <div>
                <label className="label">Credit Days</label>
                <input
                  type="number"
                  className="input"
                  value={form.credit_days || 0}
                  onChange={(e) => handleField('credit_days', e.target.value)}
                />
              </div>
              <div>
                <label className="label">Credit Limit (USD/INR)</label>
                <input
                  type="number"
                  className="input"
                  value={form.credit_limit || 0}
                  onChange={(e) => handleField('credit_limit', e.target.value)}
                />
              </div>
              <div>
                <label className="label">AQL Standard</label>
                <select
                  className="input"
                  value={form.default_aql || '2.5'}
                  onChange={(e) => handleField('default_aql', e.target.value)}
                >
                  <option value="1.0">AQL 1.0 (Strict)</option>
                  <option value="1.5">AQL 1.5 (High Quality)</option>
                  <option value="2.5">AQL 2.5 (Industry Standard)</option>
                  <option value="4.0">AQL 4.0 (Promotional)</option>
                </select>
              </div>
            </div>
          </div>

          <div>
            <h3 className="text-sm font-bold text-slate-800 border-b border-surface-border pb-2">
              Quality, Compliance & Packaging Requirements
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-3">
              <div>
                <label className="label">Quality Standard</label>
                <input
                  className="input"
                  value={form.quality_standard || ''}
                  onChange={(e) => handleField('quality_standard', e.target.value)}
                  placeholder="e.g. As per Tech Pack & Golden Sample"
                />
              </div>
              <div>
                <label className="label">Compliance Certifications</label>
                <input
                  className="input"
                  value={form.compliance_certifications || ''}
                  onChange={(e) => handleField('compliance_certifications', e.target.value)}
                  placeholder="OEKO-TEX, BSCI, GOTS, SEDEX"
                />
              </div>
              <div className="flex items-center pt-6">
                <label className="flex items-center gap-2 cursor-pointer text-xs font-semibold text-slate-700">
                  <input
                    type="checkbox"
                    checked={!!form.lab_testing_required}
                    onChange={(e) => handleField('lab_testing_required', e.target.checked ? 1 : 0)}
                    className="rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                  />
                  <span>Mandatory Lab Testing (Color Fastness, Shrinkage, GSM)</span>
                </label>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-3">
              <div>
                <label className="label">Packing Instructions</label>
                <textarea
                  className="input h-20"
                  value={form.packing_instructions || ''}
                  onChange={(e) => handleField('packing_instructions', e.target.value)}
                  placeholder="e.g. Single pc polybag with silica gel, 60 pcs per 5-ply export carton, barcode label on top left..."
                />
              </div>
              <div>
                <label className="label">Special Instructions & Marking</label>
                <textarea
                  className="input h-20"
                  value={form.special_instructions || ''}
                  onChange={(e) => handleField('special_instructions', e.target.value)}
                  placeholder="Carton side marking format, hanger packing, metal detection certificate requirements..."
                />
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
