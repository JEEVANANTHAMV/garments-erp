import { Router } from 'express';
import { labMastersRouter } from './labMasters.routes.js';
import { labRequestRouter } from './labRequest.routes.js';
import { labTrialRouter } from './labTrial.routes.js';
import { labReportRouter } from './labReport.routes.js';

/**
 * Lab management — washing, garment sample & textile testing (client spec 02-Nov-2026, Phase 1). Mounted at /api/lab.
 *   masters   /categories /units /methods /parameters /wash-processes /machines /test-plans /users /form-options
 *   request   /jobs /requests /requests/:id/{submit,return,cancel,close,samples} /samples/:id/{issue,consume,return,retain,dispose,label} /attachments
 *   trial     /trials /trials/:id/{start,complete,cancel,measurements,results/evaluate,results/:pid/override,results/:pid/source,deviations,submit}
 *   report    /reports /reports/export /reports/:id/{lab-approve,qa-approve,return,retest,pdf,release,revise,production-reference}
 *             /production-references /dashboard/summary
 */
export const labRouter = Router();
labRouter.use('/', labMastersRouter);
labRouter.use('/', labRequestRouter);
labRouter.use('/', labTrialRouter);
labRouter.use('/', labReportRouter);
