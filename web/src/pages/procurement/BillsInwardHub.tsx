import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../../lib/auth';
import { SupplierBillsPage } from './SupplierBill';
import KnittingBillsPage from './KnittingBillsPage';
import FabricProcessBillPage from '../production/fabricProcess/BillPage';
import { YarnProcessBillPage } from '../production/yarnProcess/BillTrackingPages';
import { ContractorBillsPage } from '../production/ProcessMasterPage';

/**
 * Bills Inward — every bill that comes in, in one place (client voice note 02-Oct-2026):
 * supplier / purchase bills, knitting job-work, yarn process, fabric process and job-work contractor
 * bills. The separate process bill screens are off the menu; their routes still work.
 */
const TABS = [
  { key: 'SUPPLIER', label: 'Supplier / purchase bills', perms: ['PURCHASE.VIEW'] },
  { key: 'KNITTING', label: 'Knitting job-work', perms: ['PURCHASE.VIEW', 'PRODUCTION.VIEW'] },
  { key: 'YARN_PROCESS', label: 'Yarn process', perms: ['YARN_PROCESS.VIEW'] },
  { key: 'FABRIC_PROCESS', label: 'Fabric process', perms: ['FABRIC_PROCESS.VIEW'] },
  { key: 'CONTRACTOR', label: 'Job-work contractors (stitching etc.)', perms: ['PRODUCTION.VIEW'] },
] as const;

export default function BillsInwardHub() {
  const [params, setParams] = useSearchParams();
  const { can } = useAuth() as any;
  const tabs = TABS.filter((t) => t.perms.some((p) => can(p)));
  const tab = tabs.find((t) => t.key === params.get('tab'))?.key ?? tabs[0]?.key ?? 'SUPPLIER';
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1.5 rounded-xl border border-slate-200 bg-white p-1.5">
        <span className="px-2 text-[11px] font-bold uppercase tracking-wider text-slate-500">Bills Inward</span>
        {tabs.map((t) => (
          <button key={t.key} type="button" id={`bills-tab-${t.key}`}
            onClick={() => setParams({ tab: t.key })}
            className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${tab === t.key ? 'bg-brand-600 text-white' : 'text-slate-600 hover:bg-slate-100'}`}>
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'SUPPLIER' && <SupplierBillsPage />}
      {tab === 'KNITTING' && <KnittingBillsPage />}
      {tab === 'YARN_PROCESS' && <YarnProcessBillPage />}
      {tab === 'FABRIC_PROCESS' && <FabricProcessBillPage />}
      {tab === 'CONTRACTOR' && <ContractorBillsPage />}
    </div>
  );
}
