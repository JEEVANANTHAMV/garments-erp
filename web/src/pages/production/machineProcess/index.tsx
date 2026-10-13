import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Tabs } from '../../../components/ui';
import { type Kind, LABEL, usePerm } from './shared';
import { DashboardTab } from './Dashboard';
import { JobsTab } from './Jobs';
import { ProductionTab, ProductionForm } from './Production';
import { MaterialTab } from './Material';
import { MastersTab } from './Masters';
import { ReportsTab } from './Reports';

/**
 * Embroidery / Printing — machine output & costing (client developer documents + voice note 13-Oct-2026).
 * Process DC outward / inward still move the panels; this screen records what the machine did and what it cost.
 */
function MachineProcessPage({ kind }: { kind: Kind }) {
  const p = usePerm(kind);
  const [sp, setSp] = useSearchParams();
  const tab = sp.get('tab') ?? 'dashboard';
  const [prod, setProd] = useState<{ id?: number; jobId?: number } | null>(null);
  const [prodKey, setProdKey] = useState(0);
  const openProd = (o: { id?: number; jobId?: number }) => { setProd(o); setProdKey((k) => k + 1); };
  if (!p.view) return <p className="p-6 text-sm text-slate-500">You do not have access to {LABEL[kind].toLowerCase()} — ask for the {kind}.VIEW permission.</p>;
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">{LABEL[kind]} — machine output & costing</h1>
        <p className="text-sm text-slate-500">
          {kind === 'EMBROIDERY'
            ? 'Machines, designs, thread recipes, jobs, store issue, daily machine output (heads, stitches, downtime, reject / rework) and cost per good piece / per 1,000 stitches'
            : 'Machines, artwork, dyes & chemical recipes, jobs, store issue, daily machine output (downtime, reject / rework) and cost per good piece / per KG'}
        </p>
      </div>
      <Tabs active={tab} onChange={(k) => setSp({ tab: k })} tabs={[
        { key: 'dashboard', label: 'Dashboard' }, { key: 'jobs', label: 'Jobs' }, { key: 'production', label: 'Production entry' },
        { key: 'material', label: 'Material issue / return' }, { key: 'reports', label: 'Reports' }, { key: 'masters', label: 'Masters' },
      ]} />
      {tab === 'dashboard' && <DashboardTab kind={kind} />}
      {tab === 'jobs' && <JobsTab kind={kind} onNewProduction={(jobId) => openProd({ jobId })} onOpenProduction={(id) => openProd({ id })} />}
      {tab === 'production' && <ProductionTab key={prodKey} kind={kind} onOpen={openProd} />}
      {tab === 'material' && <MaterialTab kind={kind} />}
      {tab === 'reports' && <ReportsTab kind={kind} />}
      {tab === 'masters' && <MastersTab kind={kind} />}
      {prod && <ProductionForm key={prodKey} kind={kind} id={prod.id} jobId={prod.jobId} onClose={() => { setProd(null); setProdKey((k) => k + 1); }} />}
    </div>
  );
}

export const EmbroideryMachinePage = () => <MachineProcessPage kind="EMBROIDERY" />;
export const PrintingMachinePage = () => <MachineProcessPage kind="PRINTING" />;
