import { chartColors } from '../../theme/designTokens.js';

export interface OutputRow {
  id: number; output_date: string; style_id: number | null; style_code: string | null;
  stage_id: number | null; stage_name: string | null; actual_good: number | string;
}
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
  const stages = new Map<string, { key: string; name: string; color: string }>();
  const styles = new Map<string, { name: string; value: number; color: string }>();
  for (const row of rows) {
    const date = row.output_date.slice(0, 10);
    const key = `stage_${row.stage_id ?? 'unassigned'}`;
    const name = row.stage_name || 'Unassigned';
    if (!stages.has(key)) {
      const tone = /cut/i.test(name) ? chartColors.cutting : /sew|stitch/i.test(name) ? chartColors.sewing
        : /finish|iron/i.test(name) ? chartColors.finishing : /pack/i.test(name) ? chartColors.packing : chartColors.other;
      stages.set(key, { key, name, color: tone });
    }
    const qty = Number(row.actual_good) || 0;
    const day = dates.get(date) ?? { date };
    day[key] = Number(day[key] ?? 0) + qty;
    dates.set(date, day);
    const styleKey = String(row.style_id ?? 'unassigned');
    const style = styles.get(styleKey) ?? { name: row.style_code || 'Unassigned', value: 0, color: chartPalette[styles.size % chartPalette.length] };
    style.value += qty;
    styles.set(styleKey, style);
  }
  return {
    days: [...dates.values()].sort((a, b) => String(a.date).localeCompare(String(b.date))),
    stages: [...stages.values()], styles: [...styles.values()].filter((s) => s.value > 0),
  };
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
