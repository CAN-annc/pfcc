// node --test tests/   （純計算函式的回歸測試；v2.30.0 起）
import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../files/calc.js';

test('業務日期用本地時間', () => {
  const d = new Date(2026, 10, 15, 7, 30); // 台灣 11/15 07:30 → UTC 還是 11/14
  assert.equal(C.localISODate(d), '2026-11-15');
  assert.equal(C.currentMonthStr(new Date(2026, 11, 1, 1, 0)), '2026-12');
});

test('台股 T+2 跳過週末與休市', () => {
  const H = new Set(C.TW_HOLIDAYS_FALLBACK[2026]);
  assert.equal(C.settleDateFor('TW', '2026-11-19', H), '2026-11-23'); // 週四 → 週一
  assert.equal(C.settleDateFor('TW', '2026-12-23', H), '2026-12-28'); // 12/25 休市
  assert.equal(C.settleDateFor('US', '2026-11-19', H), '2026-11-19');
  assert.equal(C.nextBusinessDay('2026-11-22', H), '2026-11-23');
});

test('估算股數：台股整數、美股 5 位小數', () => {
  assert.equal(C.estimateShares({ amount: 5000, price: 92.6, fee: 1, market: 'TW' }), 53);
  assert.equal(C.estimateShares({ amount: 100, price: 603.21, fee: 0.2, market: 'US' }), 0.16544);
  assert.equal(C.twFee(4630), 20);
  assert.equal(C.twFee(100000), 142);
  // 零股：2301 10 股 × 213.5 → 3；2330 2 股 × 2240 → 6（台新 11/18 交割款 6,624）
  assert.equal(C.twFee(2135, 10), 3);
  assert.equal(C.twFee(4480, 2), 6);
  assert.equal(2135 + 4480 + C.twFee(2135, 10) + C.twFee(4480, 2), 6624);
});

test('平均成本法：買、買、賣', () => {
  const t = [
    { id: 'o', kind: 'opening', date: '2026-01-01', shares: 100, total_cost: 9000 },
    { id: 'b', kind: 'buy', date: '2026-02-01', shares: 100, total_cost: 11000 },
    { id: 's', kind: 'sell', date: '2026-03-01', shares: 50, proceeds: 6000 },
  ];
  const p = C.calcPositionFromTrades(t, 'avg');
  assert.equal(p.shares, 150);
  assert.equal(p.totalCost, 15000);
  assert.equal(p.avgCost, 100);
  assert.equal(p.realized.s, 1000);
});

test('先進先出：賣出先扣最早的', () => {
  const t = [
    { id: 'a', kind: 'buy', date: '2026-01-01', shares: 1, total_cost: 100 },
    { id: 'b', kind: 'buy', date: '2026-02-01', shares: 1, total_cost: 200 },
    { id: 's', kind: 'sell', date: '2026-03-01', shares: 1, proceeds: 250 },
  ];
  const p = C.calcPositionFromTrades(t, 'fifo');
  assert.equal(p.shares, 1); assert.equal(p.totalCost, 200); assert.equal(p.realized.s, 150);
});

test('分割與配股', () => {
  const t = [
    { id: 'a', kind: 'buy', date: '2026-01-01', shares: 10, total_cost: 1000 },
    { id: 'x', kind: 'split', date: '2026-02-01', ratio: 4 },
    { id: 'd', kind: 'stock_dividend', date: '2026-03-01', shares: 2 },
  ];
  const p = C.calcPositionFromTrades(t, 'avg');
  assert.equal(p.shares, 42); assert.equal(p.totalCost, 1000);
});

import { ccPayYmOfDate, ccStatementOf, ccCurrentPeriods } from '../files/calc.js';
test('信用卡帳單期：結帳 27、繳款 12', () => {
  const card = { id: 'c', billing_day: 27, due_day: 12 };
  assert.equal(ccPayYmOfDate(card, '2026-10-27'), '2026-11');
  assert.equal(ccPayYmOfDate(card, '2026-10-28'), '2026-12');
  const ex = [
    { id: 1, date: '2026-10-05', amount: 100, pay_type: 'cc', cc_id: 'c' },
    { id: 2, date: '2026-10-25', amount: 500, pay_type: 'cc', cc_id: 'c', cc_pay_period: '2026-12' },
    { id: 3, date: '2026-10-29', amount: 40, pay_type: 'cc', cc_id: 'c' },
  ];
  const s = ccStatementOf(card, ex, '2026-11');
  assert.equal(s.total, 100);
  assert.equal(s.near.length, 1); assert.equal(s.near[0].next, true);
  const p = ccCurrentPeriods({ ...card, last_paid_period: '2026-10' }, ex, new Date(2026, 10, 1));
  assert.equal(p.billed.payYm, '2026-11'); assert.equal(p.open.total, 540);
});
test('信用卡帳單期：繳款日大於結帳日 → 同月繳', () => {
  assert.equal(ccPayYmOfDate({ billing_day: 5, due_day: 20 }, '2026-10-03'), '2026-10');
});

import { goalStages, calcBucketPlanContribution } from '../files/calc.js';
test('階段目標：前一個存滿才輪到下一個', () => {
  const bs = [{ id: 'car', goal_kind: 'stage', stage_order: 2, target_amount: 100 }, { id: 'ef', goal_kind: 'stage', stage_order: 1, target_amount: 50 }, { id: 'trip' }];
  let g = goalStages(bs, b => ({ ef: 10, car: 0 })[b.id] || 0);
  assert.equal(g.current.id, 'ef'); assert.ok(g.queued.has('car'));
  g = goalStages(bs, b => ({ ef: 50, car: 0 })[b.id] || 0);
  assert.equal(g.current.id, 'car'); assert.ok(g.filled.has('ef'));
  assert.equal(calcBucketPlanContribution({ monthly_amount: 1000, stage_queued: true }, 0).amount, 0);
  assert.equal(calcBucketPlanContribution({ monthly_amount: 1000, stage_split: true }, 0).amount, 500);
});

test('分期：開始月份之前、已付過的月份都不出現', () => {
  const inst = [{ id: 'n', name: '明年保費', due_day: 12, total_periods: 12, paid_periods: 0, start_date: '2027-01-12' },
                { id: 'o', name: '今年保費', due_day: 12, total_periods: 12, paid_periods: 11, last_paid_ym: '2026-11' }];
  const items = (y, m) => calcMonthCalendarItems({ installments: inst }, y, m).filter(x => x.type === 'installment').map(x => x.id);
  assert.deepEqual(items(2026, 11), []);
  assert.deepEqual(items(2026, 12), ['o']);
  assert.deepEqual(items(2027, 1), ['n', 'o']);
});

import { calcMonthCalendarItems } from '../files/calc.js';
import { calcMonthlyPlan, calcAvgLivingSpend, setCategoryTree } from '../files/calc.js';
test('v2.31.0 每月計畫：還沒開始的分期不算進這個月', () => {
  const inst = [{ id: 'old', name: '今年保費', total_periods: 12, paid_periods: 9, per_amount: 1401, start_date: '2026-02-21' },
                { id: 'new', name: '明年保費', total_periods: 12, paid_periods: 0, per_amount: 1426, start_date: '2027-02-21' }];
  assert.deepEqual(calcMonthlyPlan({ installments: inst, ym: '2026-11' }).fixed.items.map(x => x.id), ['old']);
  assert.equal(calcMonthlyPlan({ installments: inst, ym: '2027-02' }).fixed.total, 1401 + 1426);
});
test('v2.31.0 生活費平均：已是固定支出的主分類不算', () => {
  setCategoryTree([{ id: 'cat_insurance', type: 'expense' }, { id: 'cat_life_ins', parent_id: 'cat_insurance', type: 'expense' }, { id: 'cat_food', type: 'expense' }]);
  const tx = [{ date: '2026-10-05', category: 'cat_food', amount: 1000 }, { date: '2026-10-12', category: 'cat_life_ins', amount: 3400 }];
  const today = new Date(2026, 10, 20);
  assert.equal(calcAvgLivingSpend(tx, [], {}, 1, today).total, 4400);
  assert.equal(calcAvgLivingSpend(tx, [], {}, 1, today, ['cat_insurance']).total, 1000);
});

import { evalAmountExpr } from '../files/calc.js';
test('v2.31.0 金額算式', () => {
  assert.equal(evalAmountExpr('65+45'), 110);
  assert.equal(evalAmountExpr('380/2'), 190);
  assert.equal(evalAmountExpr('380÷2'), 190);
  assert.equal(evalAmountExpr('120×3-10'), 350);
  assert.equal(evalAmountExpr('(100+50)*2'), 300);
  assert.equal(evalAmountExpr('1,200'), 1200);
  assert.equal(evalAmountExpr('100/3'), 33.33);
  assert.equal(evalAmountExpr('65+'), null);
  assert.equal(evalAmountExpr('5/0'), null);
  assert.equal(evalAmountExpr('alert(1)'), null);
});

test('v2.31.0 定期定額：開始前、已確認那期之前的月份不出現', () => {
  const s = { id: 'd1', name: '0050', freq: 'monthly', billing_day: 5, amount: 5000 };
  const cal = (o, m) => calcMonthCalendarItems({ dcaSchedules: [{ ...s, ...o }] }, 2026, m).filter(x => x.type === 'dca').length;
  assert.equal(cal({ last_confirmed_date: '2026-09-05' }, 8), 0);
  assert.equal(cal({ last_confirmed_date: '2026-09-05' }, 10), 1);
  assert.equal(cal({ start_date: '2026-09-01' }, 8), 0);
  assert.equal(cal({ start_date: '2026-09-01' }, 9), 1);
});

test('分期未繳餘額：只算還沒記的期數、未開始的不算', () => {
  const r = C.calcInstallmentRemaining([
    { id: 'a', name: '保險', total_amount: 40887, total_periods: 12, per_amount: 3407, paid_periods: 4, start_date: '2026-08-01' },
    { id: 'b', name: '已繳完', total_amount: 3000, total_periods: 3, paid_periods: 3 },
    { id: 'c', name: '還沒開始', total_amount: 6000, total_periods: 6, paid_periods: 0, start_date: '2027-01-01' },
  ], new Date(2026, 10, 21));
  assert.equal(r.total, 3407 * 8);
  assert.deepEqual(r.items.map(i => i.id), ['a']);
});

test('退款扣掉、代墊不算花費', () => {
  const tx = [
    { id: 'a', date: '2026-11-03', category: 'cat_shop', amount: 1000, fx_rate_twd: 1 },
    { id: 'r', date: '2026-11-10', category: 'cat_shop', amount: -300, fx_rate_twd: 1, refund_of: 'a' },
    { id: 'f', date: '2026-11-05', category: 'cat_shop', amount: 500, fx_rate_twd: 1, fronted_recv_id: 'x' },
  ];
  assert.equal(C.calcMonthlyExpenseTotal(tx, '2026-11'), 700);
  assert.equal(C.resolveExpenseAmountTwd(tx[2]), 0);
});

test('含股利總報酬', () => {
  const r = C.calcTotalReturn({ marketValueTWD: 90000, unrealizedTWD: -10000, dividendsTWD: 4000 });
  assert.equal(r.total, -6000);
  assert.equal(Math.round(r.pct * 10) / 10, -6);
  assert.equal(C.calcTotalReturn({ marketValueTWD: NaN, unrealizedTWD: 0 }), null);
});

test('必要性：類別預設、子分類、類別設定、單筆覆寫', () => {
  C.setCategoryTree([{ id: 'cat_food' }, { id: 'cat_food_drink', parent_id: 'cat_food' }, { id: 'cat_food_lunch', parent_id: 'cat_food' }, { id: 'cat_shopping' }]);
  assert.equal(C.isEssentialCategory('cat_food_lunch'), true);
  assert.equal(C.isEssentialCategory('cat_food_drink'), false);
  assert.equal(C.isEssentialCategory('cat_shopping', [{ id: 'cat_shopping', essential: true }]), true);
  assert.equal(C.isEssentialTxn({ category: 'cat_shopping', essential: true }), true);
  const tx = [
    { date: '2026-10-05', category: 'cat_food_lunch', amount: 600, fx_rate_twd: 1 },
    { date: '2026-10-06', category: 'cat_food_drink', amount: 400, fx_rate_twd: 1 },
  ];
  assert.equal(C.calcEssentialShare(tx, [], { months: 3, today: new Date(2026, 10, 21) }), 0.6);
});
