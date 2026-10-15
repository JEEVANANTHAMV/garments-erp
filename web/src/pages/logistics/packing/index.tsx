import { Navigate, Route, Routes } from 'react-router-dom';
import { PackingOrdersPage } from './PackingOrders';
import { PackingOrderDetailPage } from './PackingOrderDetail';
import { PolybagEntryPage } from './PolybagEntry';
import { CartonEntryPage } from './CartonEntry';
import { CartonVerifyPage } from './CartonVerify';
import { PackingRulesPage } from './PackingRules';
import { PackingReportsPage } from './PackingReports';

/**
 * Packing engine screens, mounted once in App.tsx at /logistics/packing/*:
 *   orders · orders/:id · polybag (Individual piece / polybag entry) · cartons (Carton box entry)
 *   verify (scan → verify → seal → label → post) · rules · reports
 */
export function PackingEngineApp() {
  return (
    <Routes>
      <Route index element={<Navigate to="orders" replace />} />
      <Route path="orders" element={<PackingOrdersPage />} />
      <Route path="orders/:id" element={<PackingOrderDetailPage />} />
      <Route path="polybag" element={<PolybagEntryPage />} />
      <Route path="cartons" element={<CartonEntryPage />} />
      <Route path="verify" element={<CartonVerifyPage />} />
      <Route path="rules" element={<PackingRulesPage />} />
      <Route path="reports" element={<PackingReportsPage />} />
      <Route path="*" element={<Navigate to="orders" replace />} />
    </Routes>
  );
}
