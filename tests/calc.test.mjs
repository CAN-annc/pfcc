// PFCC 純計算回歸測試（v2.31.0 起）。執行：npm test（在 files/ 目錄），或
//   TZ=Asia/Taipei node --test tests/
// 這些測試固定用台北時區跑，因為 R1 的問題只在 UTC 以東的時區出現。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as calc from '../files/calc.js';

test('時區：測試必須在 Asia/Taipei 跑', () => {
  assert.equal(new Date('2026-11-02T23:30:00Z').getHours(), 7, '請用 TZ=Asia/Taipei 執行');
});

test('R1 localDate：台北早上 7:30 是當天，不是 UTC 的前一天', () => {
  assert.equal(calc.localDate(new Date('2026-11-02T23:30:00Z')), '2026-11-03');
});

test('R1 currentMonthStr：11/1 早上 7:30 已經是 11 月', () => {
  assert.equal(calc.currentMonthStr(new Date('2026-10-31T23:30:00Z')), '2026-11');
});

test('R1 跨年：1/1 00:30 是新的一年', () => {
  assert.equal(calc.localDate(new Date('2026-12-31T16:30:00Z')), '2027-01-01');
  assert.equal(calc.localMonth(new Date('2026-12-31T16:30:00Z')), '2027-01');
});

test('R1 晚上 23:59 仍是當天', () => {
  assert.equal(calc.localDate(new Date('2026-11-03T15:59:00Z')), '2026-11-03');
});

test('R1 calc.js 不再用 toISOString 算業務日期', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../files/calc.js', import.meta.url), 'utf8');
  assert.equal(/toISOString\(\)\.slice\(0,\s*(7|10)\)/.test(src), false);
});

test('R1 index.html 不再用 toISOString 算業務日期', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../files/index.html', import.meta.url), 'utf8');
  const hits = src.split('\n').filter(l => /toISOString\(\)\.slice\(0,\s*(7|10)\)/.test(l));
  assert.deepEqual(hits, []);
});
