import { chartColors } from '../../theme/designTokens.js';

/** One row of GET /dashboard/output: good pieces for a day, stage and style. */
export interface OutputRow { output_date: string; stage: string; style_code: string | null; qty: number | string }

// The four stages of the reference chart, in floor order, with the spec's series colours.
export const STAGES = [
  { key: 'CUTTING', name: 'Cutting', color: chartColors.cutting },
  { key: 'SEWING', name: 'Sewing', color: chartColors.sewing },
  { key: 'FINISHING', name: 'Finishing', color: chartColors.finishing },
  { key: 'PACKING', name: 'Packing', color: chartColors.packing },
];
export interface StockRow {
  fabric_id: number; item_name: string; uom_code: string | null;
  total_in: number | string; total_out: number | string; balance: number | string;
}
export const chartPalette = Object.values(chartColors) as string[];
export const businessDate = (date = new Date()) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(date);

export function monthRange(date: string, previous = false) {
  const [year, month] = date.split('-').map(Number);
  const start = new Date(Date.UTC(year, month - 1 - Number(previous), 1));
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0));
  return { dateFrom: start.toISOString().slice(0, 10), dateTo: previous ? end.toISOString().slice(0, 10) : date };
}

export function aggregateOutput(rows: OutputRow[]) {
  const dates = new Map<string, Record<string, string | number>>();
  const styles = new Map<string, { name: string; value: number; color: string }>();
  const totals: Record<string, number> = {};
  for (const row of rows) {
    const date = row.output_date.slice(0, 10);
    const qty = Number(row.qty) || 0;
    const day = dates.get(date) ?? { date };
    day[row.stage] = Number(day[row.stage] ?? 0) + qty;
    dates.set(date, day);
    totals[row.stage] = (totals[row.stage] ?? 0) + qty;
    // Style mix counts sewn pieces (each garment once), not every stage it passed through.
    if (row.stage !== 'SEWING') continue;
    const name = row.style_code || 'Unassigned';
    const style = styles.get(name) ?? { name, value: 0, color: chartPalette[styles.size % chartPalette.length] };
    style.value += qty;
    styles.set(name, style);
  }
  return {
    days: [...dates.values()].sort((a, b) => String(a.date).localeCompare(String(b.date))),
    stages: STAGES, totals, styles: [...styles.values()].filter((s) => s.value > 0),
  };
}

/** The same days of the previous month (1st … same date, clamped to that month's end) for fair trends. */
export function samePeriodLastMonth(date: string) {
  const [year, month, day] = date.split('-').map(Number);
  const start = new Date(Date.UTC(year, month - 2, 1));
  const last = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).getUTCDate();
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), Math.min(day, last)));
  return { dateFrom: start.toISOString().slice(0, 10), dateTo: end.toISOString().slice(0, 10) };
}

/** Percent change; null when there is nothing to compare against. */
export function trendPct(current: number, previous: number) {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous <= 0) return null;
  return Math.round(((current - previous) / previous) * 100);
}

// Keep units separate: kilograms and metres must never be added together.
export function aggregateStock(rows: StockRow[]) {
  const items = new Map<string, StockRow>();
  const totals = new Map<string, number>();
  for (const row of rows) {
    const unit = row.uom_code || 'Unspecified unit';
    const key = `${row.fabric_id}:${unit}`;
    const item = items.get(key) ?? { ...row, total_in: 0, total_out: 0, balance: 0 };
    item.total_in = Number(item.total_in) + Number(row.total_in);
    item.total_out = Number(item.total_out) + Number(row.total_out);
    item.balance = Number(item.balance) + Number(row.balance);
    items.set(key, item);
    totals.set(unit, (totals.get(unit) ?? 0) + Number(row.balance));
  }
  return { items: [...items.values()], totals: [...totals].map(([unit, value]) => ({ unit, value })) };
}
