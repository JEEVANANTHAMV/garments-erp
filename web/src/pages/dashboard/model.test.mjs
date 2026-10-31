import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateOutput, aggregateStock, businessDate, monthRange, samePeriodLastMonth, trendPct, STAGES } from './model.ts';

test('dashboard date uses India time at UTC day boundaries', () => {
  assert.equal(businessDate(new Date('2026-10-30T20:00:00Z')), '2026-10-31');
});

test('period boundaries handle new years and leap years without including future days', () => {
  assert.deepEqual(monthRange('2026-01-15', true), { dateFrom: '2025-12-01', dateTo: '2025-12-31' });
  assert.deepEqual(monthRange('2024-03-01', true), { dateFrom: '2024-02-01', dateTo: '2024-02-29' });
  assert.deepEqual(monthRange('2026-10-05'), { dateFrom: '2026-10-01', dateTo: '2026-10-05' });
});

test('output sums each day by stage; style mix counts sewn pieces only', () => {
  const rows = [
    { output_date: '2026-10-02', stage: 'SEWING', style_code: 'TS-01', qty: '1200' },
    { output_date: '2026-10-01', stage: 'CUTTING', style_code: 'TS-01', qty: 2000 },
    { output_date: '2026-10-02', stage: 'SEWING', style_code: 'TS-02', qty: 350 },
    { output_date: '2026-10-02', stage: 'PACKING', style_code: 'TS-01', qty: 900 },
    { output_date: '2026-10-02', stage: 'SEWING', style_code: null, qty: 15 },
  ];
  const result = aggregateOutput(rows);
  assert.deepEqual(result.days, [
    { date: '2026-10-01', CUTTING: 2000 },
    { date: '2026-10-02', SEWING: 1565, PACKING: 900 },
  ]);
  assert.deepEqual(result.totals, { SEWING: 1565, CUTTING: 2000, PACKING: 900 });
  assert.deepEqual(result.styles.map(({ name, value }) => ({ name, value })), [
    { name: 'TS-01', value: 1200 }, { name: 'TS-02', value: 350 }, { name: 'Unassigned', value: 15 },
  ]);
  assert.deepEqual(result.stages.map((s) => s.key), ['CUTTING', 'SEWING', 'FINISHING', 'PACKING']);
});

test('trend compares month-to-date with the same days of last month', () => {
  assert.deepEqual(samePeriodLastMonth('2026-10-31'), { dateFrom: '2026-09-01', dateTo: '2026-09-30' });
  assert.deepEqual(samePeriodLastMonth('2026-03-30'), { dateFrom: '2026-02-01', dateTo: '2026-02-28' });
  assert.deepEqual(samePeriodLastMonth('2026-01-15'), { dateFrom: '2025-12-01', dateTo: '2025-12-15' });
  assert.equal(trendPct(112, 100), 12);
  assert.equal(trendPct(80, 100), -20);
  assert.equal(trendPct(5, 0), null);
});

test('fabric balances combine bins but never combine different units or mutate source rows', () => {
  const rows = [
    { fabric_id: 1, item_name: 'Jersey', uom_code: 'KG', total_in: '1200.50', total_out: '300', balance: '900.50' },
    { fabric_id: 1, item_name: 'Jersey', uom_code: 'KG', total_in: '600', total_out: '100', balance: '500' },
    { fabric_id: 1, item_name: 'Jersey', uom_code: 'M', total_in: '200', total_out: '50', balance: '150' },
    { fabric_id: 2, item_name: 'Rib', uom_code: 'KG', total_in: '10', total_out: '20', balance: '-10' },
  ];
  const before = structuredClone(rows);
  const result = aggregateStock(rows);
  assert.equal(result.items.length, 3);
  assert.equal(result.items[0].balance, 1400.5);
  assert.deepEqual(result.totals, [{ unit: 'KG', value: 1390.5 }, { unit: 'M', value: 150 }]);
  assert.deepEqual(rows, before);
});

test('empty data produces empty charts and balances', () => {
  assert.deepEqual(aggregateOutput([]), { days: [], stages: STAGES, totals: {}, styles: [] });
  assert.deepEqual(aggregateStock([]), { items: [], totals: [] });
});
