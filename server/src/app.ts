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
