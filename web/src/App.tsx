import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from './lib/auth';
import { ToastProvider } from './hooks/useToast';
import AppLayout from './layouts/AppLayout';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';

/* Masters */
import {
  PartiesPage, PartyDetailPage, ProductsPage, YarnsPage, YarnDetailPage, FabricsPage, FabricDetailPage, TrimsPage,
  ColorsPage, WarehousesPage, WarehouseBinsPage, BranchesPage, UnitsPage, SizeGroupsPage, BatchesPage,
} from './pages/masters';
import { StylesPage, StyleDetailPage } from './pages/masters/Styles';
import { BomsPage, BomDetailPage } from './pages/masters/Boms';

/* Sales */
import { EnquiriesPage, SamplesPage, QuotationsPage } from './pages/sales';
import CostingsPage from './pages/sales/Costings';
import SalesOrdersPage from './pages/sales/SalesOrders';
import SalesOrderDetail from './pages/sales/SalesOrderDetail';

/* Gate & Security */
import { GateInwardsPage, GateOutwardsPage } from './pages/gate';

/* Procurement */
import { MrpPage, PurchaseOrdersPage, GrnPage, MaterialIssuePage } from './pages/procurement';

/* Inventory */
import { StockPage, StockLedgerPage } from './pages/inventory';

/* Production */
import {
  ProductionPlansPage, ProductionOrdersPage,
  CuttingPage, StitchingPage, PrintingPage, EmbroideryPage,
  WashingPage, FinishingPage, ProcessTransactionsPage,
} from './pages/production';

/* Quality */
import { QcInspectionsPage, DefectsPage } from './pages/quality';

/* Logistics & Export */
import {
  PackingsPage, DispatchesPage, ContainersPage,
  ExportInvoicesPage, PackingListsPage, ShippingBillsPage, ShipmentsPage, CertificatesPage,
} from './pages/logistics';

/* Finance */
import {
  VouchersPage, ReceiptsPage, PaymentsPage, IncentivesPage,
  LedgerAccountsPage, TaxRatesPage,
} from './pages/finance';

/* Reports */
import { ReportsPage, AuditPage } from './pages/reports';

/* Admin */
import { UsersPage, RolesPage, CompanyPage, SettingsPage } from './pages/admin';

/* ------------------------------------------------------------------ */

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
  },
});

function RequireAuth({ children }: { children: React.ReactNode }) {
  const token = localStorage.getItem('erp.accessToken');
  if (!token) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <ToastProvider>
          <BrowserRouter>
            <Routes>
              {/* Public */}
              <Route path="/login" element={<Login />} />

              {/* Protected — wrapped in the app shell */}
              <Route element={<RequireAuth><AppLayout /></RequireAuth>}>
                <Route index element={<Dashboard />} />

                {/* Masters */}
                <Route path="masters">
                  <Route path="parties" element={<PartiesPage />} />
                  <Route path="parties/new" element={<PartyDetailPage />} />
                  <Route path="parties/:id" element={<PartyDetailPage />} />
                  <Route path="products" element={<ProductsPage />} />
                  <Route path="yarns" element={<YarnsPage />} />
                  <Route path="yarns/:id" element={<YarnDetailPage />} />
                  <Route path="fabrics" element={<FabricsPage />} />
                  <Route path="fabrics/:id" element={<FabricDetailPage />} />
                  <Route path="trims" element={<TrimsPage />} />
                  <Route path="colors" element={<ColorsPage />} />
                  <Route path="warehouses" element={<WarehousesPage />} />
                  <Route path="warehouse-bins" element={<WarehouseBinsPage />} />
                  <Route path="branches" element={<BranchesPage />} />
                  <Route path="units" element={<UnitsPage />} />
                  <Route path="size-groups" element={<SizeGroupsPage />} />
                  <Route path="styles" element={<StylesPage />} />
                  <Route path="styles/:id" element={<StyleDetailPage />} />
                  <Route path="boms" element={<BomsPage />} />
                  <Route path="boms/:id" element={<BomDetailPage />} />
                </Route>

                {/* Sales */}
                <Route path="sales">
                  <Route path="enquiries" element={<EnquiriesPage />} />
                  <Route path="samples" element={<SamplesPage />} />
                  <Route path="costings" element={<CostingsPage />} />
                  <Route path="quotations" element={<QuotationsPage />} />
                  <Route path="orders" element={<SalesOrdersPage />} />
                  <Route path="orders/:id" element={<SalesOrderDetail />} />
                </Route>

                {/* Gate & Security */}
                <Route path="gate">
                  <Route path="inwards" element={<GateInwardsPage />} />
                  <Route path="outwards" element={<GateOutwardsPage />} />
                </Route>

                {/* Procurement */}
                <Route path="procurement">
                  <Route path="mrp" element={<MrpPage />} />
                  <Route path="purchase-orders" element={<PurchaseOrdersPage />} />
                  <Route path="grns" element={<GrnPage />} />
                </Route>

                {/* Inventory */}
                <Route path="inventory">
                  <Route path="stock" element={<StockPage />} />
                  <Route path="ledger" element={<StockLedgerPage />} />
                  <Route path="issues" element={<MaterialIssuePage />} />
                  <Route path="batches" element={<BatchesPage />} />
                </Route>

                {/* Production */}
                <Route path="production">
                  <Route path="plans" element={<ProductionPlansPage />} />
                  <Route path="orders" element={<ProductionOrdersPage />} />
                  <Route path="cuttings" element={<CuttingPage />} />
                  <Route path="stitchings" element={<StitchingPage />} />
                  <Route path="printings" element={<PrintingPage />} />
                  <Route path="embroideries" element={<EmbroideryPage />} />
                  <Route path="washings" element={<WashingPage />} />
                  <Route path="finishings" element={<FinishingPage />} />
                  <Route path="process-transactions" element={<ProcessTransactionsPage />} />
                </Route>

                {/* Quality */}
                <Route path="quality">
                  <Route path="inspections" element={<QcInspectionsPage />} />
                  <Route path="defects" element={<DefectsPage />} />
                </Route>

                {/* Logistics & Export */}
                <Route path="logistics">
                  <Route path="packings" element={<PackingsPage />} />
                  <Route path="dispatches" element={<DispatchesPage />} />
                  <Route path="containers" element={<ContainersPage />} />
                </Route>
                <Route path="export">
                  <Route path="invoices" element={<ExportInvoicesPage />} />
                  <Route path="packing-lists" element={<PackingListsPage />} />
                  <Route path="shipping-bills" element={<ShippingBillsPage />} />
                  <Route path="shipments" element={<ShipmentsPage />} />
                  <Route path="certificates" element={<CertificatesPage />} />
                </Route>

                {/* Finance */}
                <Route path="finance">
                  <Route path="vouchers" element={<VouchersPage />} />
                  <Route path="receipts" element={<ReceiptsPage />} />
                  <Route path="payments" element={<PaymentsPage />} />
                  <Route path="incentives" element={<IncentivesPage />} />
                  <Route path="ledger-accounts" element={<LedgerAccountsPage />} />
                  <Route path="tax-rates" element={<TaxRatesPage />} />
                </Route>

                {/* Reports */}
                <Route path="reports" element={<ReportsPage />} />
                <Route path="reports/audit" element={<AuditPage />} />

                {/* Admin */}
                <Route path="admin">
                  <Route path="users" element={<UsersPage />} />
                  <Route path="roles" element={<RolesPage />} />
                  <Route path="company" element={<CompanyPage />} />
                  <Route path="settings" element={<SettingsPage />} />
                </Route>

                {/* Catch-all */}
                <Route path="*" element={<Navigate to="/" replace />} />
              </Route>
            </Routes>
          </BrowserRouter>
        </ToastProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}
