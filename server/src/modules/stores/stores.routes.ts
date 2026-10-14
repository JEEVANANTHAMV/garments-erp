import { Router } from 'express';
import { BadRequest } from '../../core/errors.js';
import { openingAuditRouter } from './openingAudit.routes.js';
import { deliveryRouter } from './delivery.routes.js';
import { billSpecialRouter } from './billSpecial.routes.js';
import { scrapRouter } from './scrap.routes.js';

/**
 * Stores transactions (client tracker 14-Oct-2026), mounted at /api/stores:
 *   stock-items · opening-stock · stock-audit · deliveries (stock / general) · bill-tracker · special-requests · scrap-rejections · reports/*
 * Client rule "No delete / edit option to be provided": nothing here is ever deleted; drafts are cancelled with a reason.
 */
export const storesRouter = Router();
storesRouter.use(openingAuditRouter);
storesRouter.use(deliveryRouter);
storesRouter.use(billSpecialRouter);
storesRouter.use(scrapRouter);
storesRouter.delete('/{*rest}', (_req, _res, next) =>
  next(BadRequest('Stores documents are never deleted. Cancel a draft with a reason; posted documents stay as they are (correct stock with a Stock Audit).')));
