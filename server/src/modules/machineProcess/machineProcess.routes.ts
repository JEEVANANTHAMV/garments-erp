import { Router } from 'express';
import { BadRequest } from '../../core/errors.js';
import type { Kind } from './mpCalc.js';
import { mountMasters } from './mpMasters.js';
import { mountProduction } from './mpProduction.js';
import { mountReports } from './mpReports.js';

/**
 * Embroidery / printing machine output & costing (client developer documents, voice note 13-Oct-2026).
 * One engine, mounted twice: /api/embroidery/* and /api/printing/* (doc §24 / §22 endpoints).
 * Process DC outward / inward (processDc.routes.ts) still moves the panels / garments; a job can be
 * linked to the DC it came on.
 */
export function machineProcessRouter(kind: Kind) {
  const router = Router();
  // every :id in the module is a positive integer
  for (const p of ['id', 'productionId']) {
    router.param(p, (_req, _res, next, v) => (/^[1-9]\d{0,17}$/.test(String(v)) ? next() : next(BadRequest(`Invalid ${p} "${v}"`))));
  }
  mountMasters(router, kind);
  mountProduction(router, kind);
  mountReports(router, kind);
  return router;
}
