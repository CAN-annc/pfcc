/**
 * PFCC — Asset Calculation Engine
 * Pure functions. No DB calls. No side effects.
 * All monetary values in TWD unless suffixed with currency.
 */

// ─── Currency conversion ──────────────────────────────────────────────────────

export function toTWD(amount, currency, fxRates) {
  if (currency === 'TWD') return amount;
  if (currency === 'USD') return amount * (fxRates.USD_TWD ?? 32.5);
  if (currency === 'JPY') return amount * (fxRates.JPY_TWD ?? 0.217);
  return amount; // unknown currency — return as-is
}

// ─── Cash & Bank ──────────────────────────────────────────────────────────────

/**
 * Returns grouped cash assets:
 * { byBank, byCurrency, totalTWD }
 */
export function calcCashAssets(accounts, banks, fxRates) {
  const bankMap = Object.fromEntries(banks.map(b => [b.id, b]));

  const byBank = {};
  const byCurrency = { TWD: 0, USD: 0, JPY: 0 };
  let totalTWD = 0;

  for (const acc of accounts) {
    const balTWD = toTWD(acc.balance, acc.currency, fxRates);
    const countInTotal = acc.include_in_total !== false;

    if (countInTotal) {
      totalTWD += balTWD;
      byCurrency[acc.currency] = (byCurrency[acc.currency] ?? 0) + acc.balance;
    }

    // By bank (always include for display purposes)
    const bankId = acc.bank_id ?? '__cash__';
    if (!byBank[bankId]) {
      byBank[bankId] = {
        bank: bankMap[bankId] ?? { id: '__cash__', name: '現金', color: '#6B7280' },
        accounts: [],
        totalTWD: 0,
      };
    }
    byBank[bankId].accounts.push({ ...acc, balTWD });
    if (countInTotal) byBank[bankId].totalTWD += balTWD;
  }

  return { byBank, byCurrency, totalTWD };
}

// ─── Time Deposits ────────────────────────────────────────────────────────────

export function calcDepositAssets(deposits, banks, fxRates) {
  const bankMap = Object.fromEntries(banks.map(b => [b.id, b]));
  let totalTWD = 0;
  const items = deposits
    .filter(d => d.status === 'active')
    .map(d => {
      const principalTWD = toTWD(d.principal, d.currency, fxRates);
      totalTWD += principalTWD;
      return { ...d, principalTWD, bank: bankMap[d.bank_id] };
    });
  return { items, totalTWD };
}

// ─── Investments ──────────────────────────────────────────────────────────────

/**
 * Returns grouped investment assets.
 * Holdings with no price show shares but no market value.
 * { byMarket, byBrokerage, totalTWD, hasMissingPrices, staleTickers }
 */
export function calcInvestmentAssets(holdings, brokerages, prices, fxRates) {
  const brokMap  = Object.fromEntries(brokerages.map(b => [b.id, b]));
  const priceMap = Object.fromEntries(prices.map(p => [p.ticker, p]));

  let totalTWD       = 0;
  let hasMissingPrices = false;
  const staleTickers = [];

  const enriched = holdings.map(h => {
    const p = priceMap[h.ticker];
    const price = h.manual_price ?? p?.price ?? null;
    const marketValueLocal = price != null ? h.shares * price : null;
    const marketValueTWD   = marketValueLocal != null
      ? toTWD(marketValueLocal, h.currency, fxRates)
      : null;

    if (marketValueTWD != null) totalTWD += marketValueTWD;
    else hasMissingPrices = true;

    if (p && isStalePrice(p.fetched_at)) staleTickers.push(h.ticker);

    return {
      ...h,
      price,
      priceSource:     h.manual_price ? 'manual' : (p?.source ?? null),
      priceFetchedAt:  h.manual_price ? null : (p?.fetched_at ?? null),
      needsPriceUpdate: p?.needs_update ?? (price == null),
      marketValueLocal,
      marketValueTWD,
      brokerage: brokMap[h.brokerage_id],
    };
  });

  // Group by market
  const byMarket = {};
  for (const h of enriched) {
    if (!byMarket[h.market]) byMarket[h.market] = { holdings: [], totalTWD: 0 };
    byMarket[h.market].holdings.push(h);
    byMarket[h.market].totalTWD += h.marketValueTWD ?? 0;
  }

  // Group by brokerage
  const byBrokerage = {};
  for (const h of enriched) {
    const bid = h.brokerage_id;
    if (!byBrokerage[bid]) {
      byBrokerage[bid] = { brokerage: h.brokerage, holdings: [], totalTWD: 0 };
    }
    byBrokerage[bid].holdings.push(h);
    byBrokerage[bid].totalTWD += h.marketValueTWD ?? 0;
  }

  return { enriched, byMarket, byBrokerage, totalTWD, hasMissingPrices, staleTickers };
}

// ─── Receivables ──────────────────────────────────────────────────────────────

export function calcReceivables(receivables) {
  const pending = receivables.filter(r => !r.is_settled);
  const totalTWD = pending.reduce(
    (sum, r) => sum + (r.total_amount - r.received_amount), 0
  );
  return { pending, totalTWD };
}

// ─── Budgets (effective-dated) ─────────────────────────────────────────────
// A `budgets` row means "starting this month, the budget is X" — there is
// NOT one row per month. To find the budget in effect for a given month,
// take whichever row (matching category_id) has the latest effective_month
// that is <= the month being asked about. A month with no row of its own
// silently inherits the most recent earlier setting; a past month keeps
// showing what was in effect back then even after a later change.
// categoryId: null = the total budget. monthStr / rows use 'YYYY-MM'.

export function currentMonthStr(fromDate = new Date()) {
  return fromDate.toISOString().slice(0, 7);
}

export function resolveBudget(budgets, categoryId, monthStr) {
  const candidates = budgets
    .filter(b => (b.category_id ?? null) === (categoryId ?? null) && b.effective_month <= monthStr)
    .sort((a, b) => b.effective_month.localeCompare(a.effective_month));
  return candidates[0]?.amount ?? null;
}

/**
 * Sums expense_txns (t.date is 'YYYY-MM-DD', t.amount already in the app's
 * display currency) whose month matches monthStr ('YYYY-MM'). Used to
 * compare against resolveBudget(...)'s total for a "本月預算" progress card.
 */
export function calcMonthlyExpenseTotal(expenseTxns, monthStr) {
  return expenseTxns
    .filter(t => (t.date || '').slice(0, 7) === monthStr)
    .reduce((sum, t) => sum + (t.amount || 0), 0);
}

/**
 * Same idea as calcMonthlyExpenseTotal but broken down by t.category (the
 * txn_categories id). Used by the 預算 page to show each category's spend
 * next to whatever budget resolveBudget(budgets, categoryId, monthStr)
 * resolves for it. Returns a plain { [categoryId]: totalAmount } map —
 * categories with zero spend this month are simply absent (not 0).
 */
export function calcMonthlyExpenseByCategory(expenseTxns, monthStr) {
  const byCat = {};
  for (const t of expenseTxns) {
    if ((t.date || '').slice(0, 7) !== monthStr) continue;
    const cid = t.category ?? '__uncategorized__';
    byCat[cid] = (byCat[cid] || 0) + (t.amount || 0);
  }
  return byCat;
}

/**
 * Sums whatever per-category budget is currently in effect (via
 * resolveBudget) across a list of category ids, for the 預算 page's
 * "分類預算加總 vs 總預算" sanity check — categories with no budget set
 * contribute 0, they don't block the sum.
 */
export function calcAllocatedBudget(budgets, categoryIds, monthStr) {
  return categoryIds.reduce(
    (sum, cid) => sum + (resolveBudget(budgets, cid, monthStr) ?? 0), 0
  );
}

// ─── Buckets / Projects (virtual funds-envelope model) ─────────────────────
// A Bucket is a purely virtual planning layer, NOT a real sub-account: an
// allocation (bucket_allocations) is just "I'm earmarking this much for
// X" and never touches any account balance or net worth — the money never
// actually moved. The only real money movement is spending: expense_txns
// tagged with bucket_id/project_id are ordinary real expenses (they
// already deduct from a real account/credit card elsewhere) that also
// count against the bucket's allocated total. A Project has no budget of
// its own by design — see calcBucketRemaining below.

export function calcBucketAllocated(allocations, bucketId) {
  return allocations
    .filter(a => a.bucket_id === bucketId)
    .reduce((sum, a) => sum + (a.amount || 0), 0);
}

export function calcBucketSpent(expenseTxns, bucketId) {
  return expenseTxns
    .filter(t => t.bucket_id === bucketId)
    .reduce((sum, t) => sum + (t.amount || 0), 0);
}

export function calcProjectSpent(expenseTxns, projectId) {
  return expenseTxns
    .filter(t => t.project_id === projectId)
    .reduce((sum, t) => sum + (t.amount || 0), 0);
}

// ─── Grand total ─────────────────────────────────────────────────────────────

export function calcNetWorth({ cashTWD, depositTWD, investmentTWD }) {
  return cashTWD + depositTWD + investmentTWD;
}

// ─── Upcoming Reminders ────────────────────────────────────────────────────
// Dashboard "近期到期／即將繳款" card.
// V1 scope: only sources with an unambiguous next date are included —
// deposit maturity, credit card due day / actual due date, recurring
// billing_day for 'monthly' & 'yearly' frequencies, recurring next_date for
// 'custom'-interval items, and installment due_day. Recurring items with
// freq === 'weekly' are NOT included: the current data model stores only a
// generic "day" field for them with no day-of-week semantics, so a reliable
// next-occurrence date can't be derived without a schema change — flagged
// as a follow-up, not solved here.
// All amounts returned are already TWD (matches how each source store
// records amounts elsewhere in the app), so callers don't need fxRates.

function daysToMonthDay(day, fromDate = new Date()) {
  if (!day) return null;
  const today = new Date(fromDate); today.setHours(0, 0, 0, 0);
  const target = new Date(today);
  target.setDate(day);
  if (target <= today) target.setMonth(target.getMonth() + 1);
  return Math.ceil((target - today) / 86400000);
}

/**
 * @param {object} sources
 * @param {Array}  sources.depositItems     — calcDepositAssets(...).items (has principalTWD)
 * @param {Array}  sources.creditCards      — from 'credit_cards' store
 * @param {Array}  sources.recurringExpenses — from 'recurring_expenses' store
 * @param {Array}  sources.installments      — from 'installments' store
 * @param {object} [opts]
 * @param {number} [opts.windowDays=14] — only include items due within this many days (0 = today)
 * @returns {Array<{type:string,id:string,label:string,daysUntil:number,amount:number|null}>}
 *          sorted soonest-first
 */
export function calcUpcomingReminders(
  { depositItems = [], creditCards = [], recurringExpenses = [], installments = [] },
  { windowDays = 14 } = {}
) {
  const items = [];

  for (const d of depositItems) {
    if (d.status && d.status !== 'active') continue;
    const days = daysUntil(d.maturity_date);
    if (days == null || days > windowDays) continue;
    items.push({
      type: 'deposit', id: d.id,
      label: `${d.bank?.name ?? ''} ${d.label ?? '定存'}到期`.trim(),
      daysUntil: days, amount: d.principalTWD ?? null,
    });
  }

  for (const c of creditCards) {
    if (!((c.current_balance || 0) > 0)) continue;
    const days = c.actual_due_date ? daysUntil(c.actual_due_date) : daysToMonthDay(c.due_day);
    if (days == null || days > windowDays) continue;
    items.push({ type: 'creditcard', id: c.id, label: `${c.name} 繳款`, daysUntil: days, amount: c.current_balance });
  }

  for (const r of recurringExpenses) {
    if (r.is_expired) continue;
    let days = null;
    if (r.freq === 'monthly') {
      days = daysToMonthDay(r.billing_day);
    } else if (r.freq === 'yearly' && r.billing_month && r.billing_day) {
      const today = new Date(); today.setHours(0, 0, 0, 0);
      let target = new Date(today.getFullYear(), r.billing_month - 1, r.billing_day);
      if (target <= today) target.setFullYear(target.getFullYear() + 1);
      days = Math.ceil((target - today) / 86400000);
    } else if (r.freq === 'custom') {
      days = daysUntil(r.next_date);
    }
    if (days == null || days > windowDays) continue;
    items.push({ type: 'recurring', id: r.id, label: r.name, daysUntil: days, amount: r.amount ?? null });
  }

  for (const i of installments) {
    if (!i.due_day || (i.paid_periods || 0) >= i.total_periods) continue;
    const days = daysToMonthDay(i.due_day);
    if (days == null || days > windowDays) continue;
    items.push({
      type: 'installment', id: i.id, label: `${i.name} 分期`,
      daysUntil: days, amount: i.per_amount ?? Math.round(i.total_amount / i.total_periods),
    });
  }

  items.sort((a, b) => a.daysUntil - b.daysUntil);
  return items;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isStalePrice(fetchedAt) {
  if (!fetchedAt) return true;
  const ageHours = (Date.now() - new Date(fetchedAt).getTime()) / 3600000;
  return ageHours > 24;
}

// ─── Formatting ───────────────────────────────────────────────────────────────

export function fmt(amount, { currency = 'TWD', compact = false, showSign = false } = {}) {
  if (amount == null || isNaN(amount)) return '—';
  const sign = showSign && amount > 0 ? '+' : '';
  if (compact && Math.abs(amount) >= 1_000_000) {
    return sign + (amount / 1_000_000).toFixed(2) + 'M';
  }
  if (compact && Math.abs(amount) >= 1_000) {
    return sign + (amount / 1_000).toFixed(1) + 'K';
  }
  const maxFrac = currency === 'TWD' ? 0 : (currency === 'JPY' ? 0 : 2);
  const minFrac = Math.min(maxFrac, currency === 'TWD' ? 0 : (currency === 'JPY' ? 0 : 2));
  const formatted = new Intl.NumberFormat('zh-TW', {
    minimumFractionDigits: minFrac,
    maximumFractionDigits: maxFrac,
  }).format(Math.abs(amount));
  return sign + (amount < 0 ? '−' : '') + formatted;
}

export function fmtCurrency(amount, currency) {
  const symbols = { TWD: 'NT$', USD: 'US$', JPY: '¥' };
  return (symbols[currency] ?? currency + ' ') + fmt(amount, { currency });
}

export function fmtDate(isoString) {
  if (!isoString) return '—';
  // Handle YYYY-MM format (no day)
  if (/^\d{4}-\d{2}$/.test(isoString)) {
    const [y, m] = isoString.split('-');
    return `${y}/${m}`;
  }
  return new Date(isoString).toLocaleDateString('zh-TW', {
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
}

export function fmtDateTime(isoString) {
  if (!isoString) return '—';
  return new Date(isoString).toLocaleString('zh-TW', {
    month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
}

export function daysUntil(dateString) {
  if (!dateString) return null;
  const target = new Date(dateString);
  const today  = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((target - today) / 86400000);
}

/**
 * Human-readable label for a daysUntil() result.
 * Handles the overdue case (days < 0) explicitly — several call sites used
 * to render this as a raw negative number (e.g. "-1 天後到期"), which is
 * what showed up for a deposit that matured yesterday and hadn't been
 * processed yet. Fixed 2026-09-16.
 */
export function fmtDaysLabel(days) {
  if (days == null) return '';
  if (days < 0) return `已到期 ${Math.abs(days)} 天`;
  if (days === 0) return '今天到期';
  return `${days} 天後`;
}
