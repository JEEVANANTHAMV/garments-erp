/**
 * Moved: the knitting yarn issue DC PDF is built on the shared print engine in yarnIssueDcPrint.ts
 * (client voice notes 05-Nov-2026 — one design family for every PO / DC). Kept as a re-export for older imports.
 */
export { renderKnitDcPdf as renderYarnIssueDcPdf, yarnNameForPrint, type KnitDcPrint as YarnIssueDcPdf } from './yarnIssueDcPrint.js';
