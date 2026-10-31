import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateOutput, aggregateStock, businessDate, monthRange } from './model.ts';

test('dashboard date uses India time at UTC day boundaries', () => {
  assert.equal(businessDate(new Date('2026-10-30T20:00:00Z')), '2026-10-31');
});

test('period boundaries handle new years and leap years without including future days', () => {
  assert.deepEqual(monthRange('2026-01-15', true), { dateFrom: '2025-12-01', dateTo: '2025-12-31' });
  assert.deepEqual(monthRange('2024-03-01', true), { dateFrom: '2024-02-01', dateTo: '2024-02-29' });
  assert.deepEqual(monthRange('2026-10-05'), { dateFrom: '2026-10-01', dateTo: '2026-10-05' });
});

test('output aggregates shifts by date and stage, while preserving style totals', () => {
  const rows = [
    { id: 1, output_date: '2026-10-02', style_id: 10, style_code: 'TS-01', stage_id: 2, stage_name: 'Sewing', actual_good: '1200' },
    { id: 2, output_date: '2026-10-01', style_id: 10, style_code: 'TS-01', stage_id: 1, stage_name: 'Cutting', actual_good: 2000 },
    { id: 3, output_date: '2026-10-02', style_id: 11, style_code: 'TS-02', stage_id: 2, stage_name: 'Sewing', actual_good: 350 },
    { id: 4, output_date: '2026-10-02', style_id: null, style_code: null, stage_id: null, stage_name: null, actual_good: 15 },
  ];
  const result = aggregateOutput(rows);
  assert.deepEqual(result.days, [
    { date: '2026-10-01', stage_1: 2000 },
    { date: '2026-10-02', stage_2: 1550, stage_unassigned: 15 },
  ]);
  assert.deepEqual(result.styles.map(({ name, value }) => ({ name, value })), [
    { name: 'TS-01', value: 3200 }, { name: 'TS-02', value: 350 }, { name: 'Unassigned', value: 15 },
  ]);
  assert.equal(result.styles.reduce((sum, s) => sum + s.value, 0), 3565);
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
  assert.deepEqual(aggregateOutput([]), { days: [], stages: [], styles: [] });
  assert.deepEqual(aggregateStock([]), { items: [], totals: [] });
});
