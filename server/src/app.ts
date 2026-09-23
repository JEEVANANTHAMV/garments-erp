import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import path from 'path';
import fs from 'fs';
import { env } from './config/env.js';
import { pingDb } from './config/db.js';
import { authenticate } from './middleware/auth.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { buildResourceRouter } from './core/crud.js';
import { masterResources } from './modules/resources/masters.js';
import { transactionResources } from './modules/resources/transactions.js';

import { authRouter } from './modules/auth/auth.routes.js';
import { adminRouter } from './modules/admin/admin.routes.js';
import { lookupRouter } from './modules/lookup/lookup.routes.js';
import { styleRouter } from './modules/style/style.routes.js';
import { bomRouter } from './modules/bom/bom.routes.js';
import { salesOrderRouter } from './modules/sales/salesOrder.routes.js';
import { inventoryRouter } from './modules/inventory/inventory.routes.js';
import { mrpRouter } from './modules/mrp/mrp.routes.js';
import { cartonRouter } from './modules/packing/packing.routes.js';
import { dashboardRouter } from './modules/dashboard/dashboard.routes.js';
import { reportsRouter } from './modules/reports/reports.routes.js';
import { uploadRouter } from './modules/upload/upload.routes.js';
import { gstRouter } from './modules/gst/gst.routes.js';
import { wipRouter } from './modules/production/wip.routes.js';
import { costingRouter } from './modules/costing/costing.routes.js';
import { cadRouter } from './modules/cad/cad.routes.js';
import { fabricYarnProcurementRouter } from './modules/procurement/fabricYarnProcurement.routes.js';
import { cuttingPlanRouter } from './modules/production/cuttingPlan.routes.js';
import { shipmentRouter } from './modules/packing/shipment.routes.js';
import { productionStagesRouter } from './modules/production/productionStages.routes.js';
import { productionFloorRouter } from './modules/production/productionFloor.routes.js';
import { processDcRouter } from './modules/production/processDc.routes.js';
import { cuttingExecutionRouter } from './modules/production/cuttingExecution.routes.js';
import { cuttingReconciliationRouter } from './modules/production/cuttingReconciliation.routes.js';
import { traceabilityRouter } from './modules/production/traceability.routes.js';
import { cuttingReportsRouter } from './modules/production/cuttingReports.routes.js';
import { knittingRouter } from './modules/knitting/knitting.routes.js';
import { processRouteRouter } from './modules/yarnProcess/processRoute.routes.js';
import { yarnProcessRouter } from './modules/yarnProcess/yarnProcess.routes.js';
import { processFlowRouter } from './modules/yarnProcess/processFlow.routes.js';
import { collarRouter } from './modules/yarnProcess/collar.routes.js';
import { knittingProductionRouter } from './modules/yarnProcess/knittingProduction.routes.js';
import { processReportsRouter } from './modules/yarnProcess/processReports.routes.js';
import { revisionRouter } from './modules/yarnProcess/revision.routes.js';
import { fabricProcessingRouter } from './modules/fabricProcessing/fabricProcessing.routes.js';
import { trimProcurementRouter } from './modules/procurement/trimProcurement.routes.js';
import { purchaseReturnRouter } from './modules/procurement/purchaseReturn.routes.js';
import { tnaRouter } from './modules/tna/tna.routes.js';

export function createApp() {
  const app = express();

  app.set('trust proxy', 1);
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(cors({ origin: env.corsOrigin, credentials: true }));
  app.use(compression());
  app.use(express.json({ limit: '25mb' }));
  app.use(express.urlencoded({ extended: true, limit: '25mb' }));
  if (!env.isProd) app.use(morgan('dev'));

  // Ensure uploads directory exists and serve static uploads
  const uploadsDir = path.resolve(process.cwd(), 'uploads');
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }
  app.use('/uploads', express.static(uploadsDir));

  // ---------------------------------------------------------- health
  app.get('/api/health', async (_req, res) => {
    try {
      await pingDb();
      res.json({ status: 'ok', db: 'connected', time: new Date().toISOString() });
    } catch (err) {
      res.status(503).json({ status: 'degraded', db: 'unreachable', error: (err as Error).message });
    }
  });

  // ------------------------------------------------------------ auth
  app.use('/api/auth', authRouter);

  // Everything below requires a valid token.
  const api = express.Router();
  api.use(authenticate);

  api.use('/admin', adminRouter);
  api.use('/lookups', lookupRouter);
  api.use('/lookup', lookupRouter);
  api.use('/dashboard', dashboardRouter);
  api.use('/reports', reportsRouter);

  // Hand-built modules with domain logic.
  api.use('/styles', styleRouter);
  api.use('/boms', bomRouter);
  api.use('/sales-orders', salesOrderRouter);
  api.use('/inventory', inventoryRouter);
  api.use('/mrp', mrpRouter);
  api.use('/uploads', uploadRouter);
  api.use('/gst', gstRouter);
  api.use('/', cartonRouter);          // /packings/:id/cartons, /cartons/:id
  api.use('/production', wipRouter);   // /production/wip-summary, /production/daily-dashboard, etc.
  api.use('/', costingRouter);          // /production-costs/order-data/:id, /pre-costings/style-data/:id, etc.
  api.use('/', cadRouter);              // /cad-requirements, /cad-requirements/:id/calculate, etc.
  api.use('/', fabricYarnProcurementRouter); // /fabric-purchase-orders, /fabric-grns, /yarn-grns, etc.
  api.use('/', cuttingPlanRouter);            // /cutting-plans, /bundles, /fg-receipts
  api.use('/', shipmentRouter);               // /packing-lists, /shipments, /dispatches, /available-packages
  api.use('/', productionStagesRouter);       // /fabric-issues, /lay-plans, /cut-piece-qc, /bundles/generate-detailed
  api.use('/', productionFloorRouter);        // /bundles/scan, /sewing, /finishing, /final-qc
  api.use('/', processDcRouter);              // /process-dcs (bundle DCs: stitching/ironing/packing), /bundle-stock/available
  api.use('/', cuttingExecutionRouter);       // /marker-versions, /size-consumptions, /lay-plans/:id/execute, /cut-outputs
  api.use('/', cuttingReconciliationRouter);  // /cutting-reconciliation(s), /cutting-plans/:id/losses
  api.use('/', traceabilityRouter);           // /production/io/:ioNo/styles, /io/:ioNo/traceability, /traceability/search
  api.use('/', cuttingReportsRouter);         // /cutting-reports, /cutting-reports/:key (doc §22)
  api.use('/', knittingRouter);               // /knitting/orders, /knitting/yarn-issues, /knitting/rolls, etc.
  // Yarn process module (doc §4-§20): routes, dyeing/winding/twisting, the shared
  // reserve→issue→receipt→QC engine, collar knitting, and process reporting.
  api.use('/', processRouteRouter);           // /process-routes
  api.use('/', yarnProcessRouter);            // /yarn-processes (dyeing / winding / twisting)
  api.use('/', processFlowRouter);            // /process-issues, /process-receipts, /process-qc
  api.use('/', collarRouter);                 // /collars, /collar-programs, /collar-productions
  api.use('/', knittingProductionRouter);     // /knitting-productions, /knitting-rolls
  api.use('/', processReportsRouter);         // /process-traceability/:yarnId, /reports/*
  api.use('/', revisionRouter);               // /process-revisions
  api.use('/', fabricProcessingRouter);       // /fabric-processing/orders, /fabric-processing/rolls, etc.
  api.use('/', trimProcurementRouter);        // /trim-pos, /trim-grns, /trim-stock
  api.use('/', purchaseReturnRouter);         // /purchase-returns, /purchase-returns/grn/:id, etc.
  api.use('/tna', tnaRouter);                 // /tna, /tna/:id, /tna/dashboard, /tna/templates, etc.

  // Metadata-driven resources.
  const registry = [...masterResources, ...transactionResources];
  for (const cfg of registry) {
    api.use(`/${cfg.path}`, buildResourceRouter(cfg));
  }

  // Machine-readable list of generated resources — handy for the frontend and docs.
  api.get('/_resources', (_req, res) => {
    res.json({
      data: registry.map((r) => ({
        path: r.path, table: r.table, label: r.label, permission: r.permission,
        filters: r.filters ?? [], searchable: r.searchable ?? [],
        children: (r.children ?? []).map((c) => c.key),
      })),
    });
  });

  app.use('/api', api);
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
