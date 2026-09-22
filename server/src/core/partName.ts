import { queryOne, txQueryOne, type Tx } from '../config/db.js';

/**
 * Garment part a document belongs to.
 *
 * The part is chosen once, next to the colour, on the Sales Order line and
 * must then follow the order through knitting, cutting, production, packing
 * and shipment (a TOP and a BOTTOM on the same order are usually different
 * colours and different fabrics, so the part cannot be re-guessed downstream).
 */
export const PART_NAMES = ['TOP', 'BOTTOM', 'COLLAR', 'CUFF', 'FOLDING', 'OTHER'] as const;
export type PartName = (typeof PART_NAMES)[number];

export function isPartName(v: unknown): v is PartName {
  return typeof v === 'string' && (PART_NAMES as readonly string[]).includes(v);
}

/** Read part_name straight off a Sales Order line. */
export async function partFromSoLine(soLineId: number | null | undefined): Promise<PartName | null> {
  if (!soLineId) return null;
  const row = await queryOne<{ part_name: string | null }>(
    'SELECT part_name FROM trx_sales_order_line WHERE id = ?',
    [soLineId],
  );
  return isPartName(row?.part_name) ? row!.part_name as PartName : null;
}

/** Transactional variant of {@link partFromSoLine}. */
export async function txPartFromSoLine(tx: Tx, soLineId: number | null | undefined): Promise<PartName | null> {
  if (!soLineId) return null;
  const row = await txQueryOne<{ part_name: string | null }>(
    tx, 'SELECT part_name FROM trx_sales_order_line WHERE id = ?', [soLineId],
  );
  return isPartName(row?.part_name) ? row!.part_name as PartName : null;
}

/**
 * Resolve the part for a downstream document.
 *
 * The Sales Order line is the source of truth: when the document is linked to
 * one, that line's part wins over whatever the client sent, so the part cannot
 * drift between stages. An explicit value is honoured only when there is no
 * linked SO line (or the line has no part set).
 */
export async function resolvePartName(
  soLineId: number | null | undefined,
  explicit?: string | null,
  fallback: PartName | null = null,
): Promise<PartName | null> {
  const fromLine = await partFromSoLine(soLineId);
  if (fromLine) return fromLine;
  if (isPartName(explicit)) return explicit;
  return fallback;
}

/** Transactional variant of {@link resolvePartName}. */
export async function txResolvePartName(
  tx: Tx,
  soLineId: number | null | undefined,
  explicit?: string | null,
  fallback: PartName | null = null,
): Promise<PartName | null> {
  const fromLine = await txPartFromSoLine(tx, soLineId);
  if (fromLine) return fromLine;
  if (isPartName(explicit)) return explicit;
  return fallback;
}
