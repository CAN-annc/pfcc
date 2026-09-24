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

/**
 * Estimated interest for a time deposit, using the standard simple-interest
 * (non-compounding) bank convention: principal × annual rate × days / 365.
 * Returns null when there isn't enough information yet (principal, rate,
 * start date and maturity date all required) — callers should treat null as
 * "can't estimate yet", not zero. This is a pure estimate for display only;
 * the actual figure entered at maturity (openDepositMatureModal) always wins.
 */
export function calcExpectedInterest(principal, interestRate, startDate, maturityDate) {
  if (!principal || !interestRate || !startDate || !maturityDate) return null;
  const days = Math.round((new Date(maturityDate) - new Date(startDate)) / 86400000);
  if (!(days > 0)) return null;
  return principal * (interestRate / 100) * days / 365;
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

    // A manually-entered price (manual_price) is never treated as stale —
    // there is no "fetched_at" to judge it against, and the user just typed
    // it in themselves, so there is nothing to warn about.
    const stale = !h.manual_price && !!p && isStalePrice(p.fetched_at);
    if (stale) staleTickers.push(h.ticker);

    // 2026-09-24（使用者要求）：成本／未實現損益是選填的——使用者先前明確
    // 表示不想追蹤股票成本（見路線圖「八」：「這太複雜了，我只想紀錄持有就
    // 可以」），這次改口要求「由使用者自行決定要不要填寫」，所以維持選填、
    // 沒有填 cost_basis 的持倉完全不受影響、不強迫使用者去查每一筆的成本。
    // cost_basis 存的是「每股成本」，幣別跟持倉本身相同（美股存美金成本、
    // 台股存台幣成本，不用使用者自己換算）；未實現損益先在原幣別算出來，
    // 再用目前即時匯率（跟市值換算用的是同一份 fxRates）換算成台幣，這樣
    // 美股的損益金額才會跟著匯率變動更新，不是存檔當下鎖住的數字。
    const hasCostBasis = h.cost_basis != null && h.cost_basis > 0;
    const unrealizedLocal = (hasCostBasis && price != null) ? (price - h.cost_basis) * h.shares : null;
    const unrealizedTWD   = unrealizedLocal != null ? toTWD(unrealizedLocal, h.currency, fxRates) : null;
    const unrealizedPct   = (hasCostBasis && price != null) ? ((price - h.cost_basis) / h.cost_basis) * 100 : null;

    return {
      ...h,
      price,
      priceSource:     h.manual_price ? 'manual' : (p?.source ?? null),
      priceFetchedAt:  h.manual_price ? null : (p?.fetched_at ?? null),
      needsPriceUpdate: p?.needs_update ?? (price == null),
      isStale: stale,
      marketValueLocal,
      marketValueTWD,
      hasCostBasis,
      unrealizedLocal,
      unrealizedTWD,
      unrealizedPct,
      pctOfPortfolio: null, // filled in below once totalTWD is known
      brokerage: brokMap[h.brokerage_id],
    };
  });

  // 持股佔比（見使用者 2026-09-24 要求）：每一檔佔整體投資市值的百分比，
  // 純粹是市值的比例關係，跟上面的成本／損益（可能沒填）完全無關，市值
  // 缺價的持倉（marketValueTWD 是 null）自然沒有百分比可以算。
  enriched.forEach(h => {
    h.pctOfPortfolio = (h.marketValueTWD != null && totalTWD > 0) ? (h.marketValueTWD / totalTWD) * 100 : null;
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

// ─── Other Assets（其他資產：儲蓄型保單價值／不動產市價）──────────────────────
// 2026-09-24 新增。跟現金／定存／投資不同，這兩種資產完全沒有可以自動查詢
// 的市價來源，`current_value` 就是使用者自己輸入、自己更新的數字，這裡純粹
// 是分組加總換算成台幣，沒有任何估算或推算邏輯。
export function calcOtherAssets(otherAssets, fxRates) {
  let totalTWD = 0;
  const enriched = (otherAssets ?? []).map(a => {
    const valueTWD = toTWD(a.current_value ?? 0, a.currency ?? 'TWD', fxRates);
    totalTWD += valueTWD;
    return { ...a, valueTWD };
  });
  const byType = { insurance: [], realestate: [] };
  enriched.forEach(a => { (byType[a.type] ??= []).push(a); });
  return { enriched, byType, totalTWD };
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
 * Same lookup as resolveBudget, but returns the whole effective record
 * (not just .amount) — needed once a budgets row can also carry
 * `allocation_mode` ('fixed'|'percent'|'remainder') and `percent`, for the
 * income-allocation cascade (see calcIncomeAllocationCascade below). A
 * record with no `allocation_mode` is an old-style row and should be
 * treated as 'fixed', same as before this field existed.
 */
export function resolveBudgetRecord(budgets, categoryId, monthStr) {
  const candidates = budgets
    .filter(b => (b.category_id ?? null) === (categoryId ?? null) && b.effective_month <= monthStr)
    .sort((a, b) => b.effective_month.localeCompare(a.effective_month));
  return candidates[0] ?? null;
}

/**
 * Historical-FX-rate-aware TWD value of one income_txns row. See §九之一
 * (roadmap) — before this feature, the income modal's amount field was
 * ALWAYS entered in TWD regardless of which account it was deposited into
 * (the field was literally labelled "金額（TWD）"), which was itself a bug
 * (a foreign-currency account's balance got the raw TWD number added to it
 * as if it were that account's own currency). New-style records (this
 * feature onward) carry `fx_rate_twd` — the TWD value of 1 unit of
 * whatever `currency` the amount was actually entered in, snapshotted at
 * save time so it stays historically accurate even if today's live rate
 * has since moved. `amount * fx_rate_twd` is that locked TWD value.
 * Old-style records (no `fx_rate_twd`) predate currency support entirely —
 * for these, `amount` already IS the TWD value (per the old always-TWD
 * convention), so it's returned as-is. Converting it again using the
 * linked account's currency would be wrong: the number was never actually
 * denominated in that account's currency to begin with.
 */
export function resolveIncomeAmountTwd(txn) {
  if (txn.fx_rate_twd != null) return (txn.amount || 0) * txn.fx_rate_twd;
  return txn.amount || 0;
}

/**
 * Historical-FX-rate-aware TWD value of one expense_txns row. Unlike
 * income, the expense modal always deducted `amount` directly from
 * whichever account/credit card was chosen, in THAT account's own
 * currency (no TWD-only assumption) — so old-style records (no
 * `fx_rate_twd`) genuinely are denominated in the linked account's
 * currency, not TWD. Best-effort backfill for those: look up the
 * account's CURRENT currency and convert using TODAY's live rate (we
 * have no record of what the real rate was back then — this is an
 * approximation for old data only, same caveat as the deposit page's
 * "system estimate" figures elsewhere in the app). A credit-card payment
 * or an entry with no linked account has no currency to look up and is
 * assumed TWD, matching credit_cards having no currency field of its own.
 * New-style records carry `fx_rate_twd` — the locked snapshot from save
 * time — and use that instead, same as income.
 */
export function resolveExpenseAmountTwd(txn, accounts = [], fxRates = {}) {
  if (txn.fx_rate_twd != null) return (txn.amount || 0) * txn.fx_rate_twd;
  const acc = txn.account_id ? accounts.find(a => a.id === txn.account_id) : null;
  if (acc && acc.currency !== 'TWD') return toTWD(txn.amount || 0, acc.currency, fxRates);
  return txn.amount || 0;
}

/**
 * Sums expense_txns (t.date is 'YYYY-MM-DD') whose month matches monthStr
 * ('YYYY-MM'), converting each row to TWD via resolveExpenseAmountTwd so
 * foreign-currency expenses don't get added to TWD ones as raw numbers.
 * `accounts`/`fxRates` are only needed for old-style rows without a
 * locked `fx_rate_twd` snapshot — omit them and old foreign-currency rows
 * fall back to being treated as TWD (same as before this feature). Used
 * to compare against resolveBudget(...)'s total for a "本月預算" progress
 * card.
 */
export function calcMonthlyExpenseTotal(expenseTxns, monthStr, accounts = [], fxRates = {}) {
  return expenseTxns
    .filter(t => (t.date || '').slice(0, 7) === monthStr)
    .reduce((sum, t) => sum + resolveExpenseAmountTwd(t, accounts, fxRates), 0);
}

/**
 * Same idea as calcMonthlyExpenseTotal but broken down by t.category (the
 * txn_categories id). Used by the 預算 page to show each category's spend
 * next to whatever budget resolveBudget(budgets, categoryId, monthStr)
 * resolves for it. Returns a plain { [categoryId]: totalAmount } map —
 * categories with zero spend this month are simply absent (not 0). Amounts
 * are TWD-converted the same way as calcMonthlyExpenseTotal.
 */
export function calcMonthlyExpenseByCategory(expenseTxns, monthStr, accounts = [], fxRates = {}) {
  const byCat = {};
  for (const t of expenseTxns) {
    if ((t.date || '').slice(0, 7) !== monthStr) continue;
    const cid = t.category ?? '__uncategorized__';
    byCat[cid] = (byCat[cid] || 0) + resolveExpenseAmountTwd(t, accounts, fxRates);
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

// ─── Dividends（股利／股息，簡化版）──────────────────────────────────────────
// 2026-09-24 新增。使用者一開始想要的是像其他理財 App 那樣的完整配息排程
// （每檔個股各自的除息日、股利率、待入帳/已入帳狀態），討論後決定做簡化
// 版：股利本來就已經是使用者用「新增收入」記錄的一般收入，只要選對分類
// （DEFAULT_CATEGORIES 裡本來就有的 cat_div_tw「股利（台股）」、cat_div_us
// 「股息（美股）」），這裡單純把這些收入依年份加總，不需要任何新的資料表
// 或排程邏輯。傳入的 incomeTxns 應該是完整的 income_txns 陣列，這裡自己
// 篩選分類、自己用 resolveIncomeAmountTwd 換算成台幣（歷史匯率快照優先，
// 沒有快照的舊資料退回原始金額，邏輯跟其他收入加總完全一致）。
export function calcDividendByYear(incomeTxns, categoryIds = ['cat_div_tw', 'cat_div_us']) {
  const byYear = {};
  for (const t of incomeTxns ?? []) {
    if (!categoryIds.includes(t.category)) continue;
    const year = (t.date || '').slice(0, 4);
    if (!year) continue;
    byYear[year] = (byYear[year] || 0) + resolveIncomeAmountTwd(t);
  }
  return Object.entries(byYear)
    .map(([year, totalTWD]) => ({ year, totalTWD }))
    .sort((a, b) => a.year.localeCompare(b.year));
}

// ─── Today's Spending Allowance（今天還能花）───────────────────────────────
// 2026-09-24 新增，取材自使用者參考的記帳機器人截圖：把「本月預算」換成
// 更即時、更直覺的「今天還能花多少」。刻意重用既有的 budgetInfo（本月總
// 預算 vs 本月至今已花費，見 loadData() 的 resolveBudget／
// calcMonthlyExpenseTotal），不是另外一套獨立的固定支出／儲蓄預留計算——
// 參考截圖的機器人是把「總預算 - 固定支出 - 預留儲蓄」除以剩餘天數，但這個
// App 的「本月預算」本來就是使用者自己設定的一個總額，已經花掉的本來就會
// 反映在 spent 裡，不需要重複扣一次固定支出，作法更單純：
//   今天還能花 = （本月預算 - 本月至今已花費）÷（本月剩餘天數，含今天）
// 隨著使用者記帳，spent 增加、daysLeft 每天遞減，每天打開 App 都會重新算出
// 當下最新的建議金額，不需要另外存一份「今日已用」的獨立狀態。
// budgetInfo 是 null（使用者沒設定本月預算）時，回傳 null，呼叫端不顯示這
// 張卡片——跟本月預算卡片「沒設定就不顯示」是同一個既有原則。
export function calcTodayAllowance(budgetInfo, fromDate = new Date()) {
  if (!budgetInfo) return null;
  const remaining = budgetInfo.amount - budgetInfo.spent;
  const year = fromDate.getFullYear(), month = fromDate.getMonth() + 1, day = fromDate.getDate();
  const totalDays = daysInMonth(year, month);
  const daysLeft = Math.max(1, totalDays - day + 1);
  const perDay = remaining / daysLeft;
  return { remaining, daysLeft, perDay, totalBudget: budgetInfo.amount, spent: budgetInfo.spent };
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

export function calcBucketSpent(expenseTxns, bucketId, accounts = [], fxRates = {}) {
  return expenseTxns
    .filter(t => t.bucket_id === bucketId)
    .reduce((sum, t) => sum + resolveExpenseAmountTwd(t, accounts, fxRates), 0);
}

export function calcProjectSpent(expenseTxns, projectId, accounts = [], fxRates = {}) {
  return expenseTxns
    .filter(t => t.project_id === projectId)
    .reduce((sum, t) => sum + resolveExpenseAmountTwd(t, accounts, fxRates), 0);
}

/**
 * Total realized income for a given month (YYYY-MM), same filter-by-date-
 * prefix-and-sum shape as calcMonthlyExpenseTotal. `excludeCategories` lets
 * a caller drop category ids that shouldn't count as "new" income for a
 * given purpose — e.g. 應收款入帳 (settling a receivable) isn't really new
 * money, it's collecting on money that was already counted as an asset, so
 * the Bucket auto-contribution feature excludes 'cat_receivable' by default.
 * Everything else (salary, side income, interest, one-off sales, etc.)
 * counts, per the user's own definition: any recorded income transaction.
 */
export function calcMonthlyIncomeTotal(incomeTxns, monthStr, excludeCategories = []) {
  return incomeTxns
    .filter(t => t.date && t.date.startsWith(monthStr) && !excludeCategories.includes(t.category))
    .reduce((sum, t) => sum + resolveIncomeAmountTwd(t), 0);
}

/**
 * A Bucket's effective monthly contribution target, regardless of which
 * mode it's configured in:
 *  - 'fixed'   → the stored monthly_amount (or null if not set)
 *  - 'percent' → income_percent% of the month's realized income (or null
 *                if income_percent isn't set)
 * Returns null when there isn't enough info to compute a number — callers
 * should treat that as "no contribution plan set", not zero.
 */
export function calcBucketMonthlyContribution(bucket, monthlyIncomeTotal) {
  if (bucket.contribution_mode === 'percent') {
    if (!bucket.income_percent) return null;
    return monthlyIncomeTotal * (bucket.income_percent / 100);
  }
  return bucket.monthly_amount || null;
}

/**
 * Rough "how many months until this Bucket hits its target" estimate, given
 * how much is still needed and the current monthly contribution rate.
 * Returns 0 if already at/over target, null if it can't be estimated
 * (no contribution rate, or the rate is 0 — would never get there).
 */
export function calcMonthsToTarget(remainingToTarget, monthlyContribution) {
  if (remainingToTarget <= 0) return 0;
  if (!monthlyContribution || monthlyContribution <= 0) return null;
  return Math.ceil(remainingToTarget / monthlyContribution);
}

/**
 * Sum of income_percent across active, percent-mode Buckets — used to warn
 * (not block) when the user's percentages across all Buckets add up to more
 * than 100% of their income. `excludeBucketId` lets the edit modal exclude
 * the bucket currently being edited so it can add back in the value the
 * user is actively typing.
 */
export function calcTotalIncomePercent(buckets, excludeBucketId = null) {
  return buckets
    .filter(b => b.status !== 'closed' && b.contribution_mode === 'percent' && b.id !== excludeBucketId)
    .reduce((sum, b) => sum + (b.income_percent || 0), 0);
}

/**
 * The full income → allocation waterfall for one month: income, minus
 * Bucket contributions, minus fixed-amount category budgets, minus
 * percentage-of-remainder category budgets (e.g. "可投資股票"), with
 * whatever's left split evenly across any 'remainder'-mode categories.
 * Each stage's base is the pool left over from the stage before it — a
 * 'percent' category's amount is % of what's left AFTER fixed categories,
 * not a % of raw income, matching the order the user actually thinks in
 * (must-pay fixed costs come out first, discretionary % after).
 *
 * Pure/no side effects — this only computes numbers. Actually writing the
 * automatic Bucket withdrawal `shortfall` implies is index.html's job (see
 * syncEmergencyFundShortfall), since that's a real database write.
 *
 * @param {number} income - this month's calcMonthlyIncomeTotal(...)
 * @param {Array<{id,name,amount}>} bucketContributions - active Buckets'
 *        calcBucketMonthlyContribution(...) results; entries with
 *        amount <= 0 are ignored.
 * @param {Array<{id,name,mode:'fixed'|'percent'|'remainder',amount,percent}>} categoryBudgets
 * @returns {{
 *   income:number, buckets:Array, bucketTotal:number, afterBuckets:number,
 *   fixedCategories:Array, fixedTotal:number, afterFixed:number,
 *   shortfall:number,
 *   percentBase:number, percentCategories:Array, percentTotal:number, afterPercent:number,
 *   remainderCategories:Array, remainderEach:number, remainderTotal:number,
 *   netSettlement:number,
 * }} `shortfall` is > 0 exactly when fixed-mode category budgets exceed
 *    what's left after Bucket contributions — the amount an emergency-fund
 *    Bucket would need to cover. `netSettlement` is income minus everything
 *    actually allocated this month; it goes negative by exactly that same
 *    shortfall amount when one occurs (fixed obligations still get their
 *    full amount either way — the shortfall is what makes the month's
 *    settlement negative, not a reduction of the fixed categories).
 */
export function calcIncomeAllocationCascade(income, bucketContributions = [], categoryBudgets = []) {
  const buckets = bucketContributions.filter(b => b.amount > 0);
  const bucketTotal = buckets.reduce((s, b) => s + b.amount, 0);
  const afterBuckets = income - bucketTotal;

  const fixedCategories = categoryBudgets.filter(c => c.mode === 'fixed' && c.amount > 0);
  const fixedTotal = fixedCategories.reduce((s, c) => s + c.amount, 0);
  const afterFixed = afterBuckets - fixedTotal;
  const shortfall = afterFixed < 0 ? -afterFixed : 0;

  // Percentage-mode categories (e.g. 可投資股票) are a % of whatever's left
  // after fixed obligations — never a % of a negative number; a shortfall
  // means there's nothing left over for these, not a negative budget.
  const percentBase = Math.max(afterFixed, 0);
  const percentCategories = categoryBudgets
    .filter(c => c.mode === 'percent' && c.percent > 0)
    .map(c => ({ ...c, amount: percentBase * c.percent / 100 }));
  const percentTotal = percentCategories.reduce((s, c) => s + c.amount, 0);
  const afterPercent = percentBase - percentTotal;

  const remainderCats = categoryBudgets.filter(c => c.mode === 'remainder');
  const remainderEach = remainderCats.length > 0 ? afterPercent / remainderCats.length : 0;
  const remainderCategories = remainderCats.map(c => ({ ...c, amount: remainderEach }));
  const remainderTotal = remainderCategories.reduce((s, c) => s + c.amount, 0);

  const netSettlement = income - bucketTotal - fixedTotal - percentTotal - remainderTotal;

  return {
    income, buckets, bucketTotal, afterBuckets,
    fixedCategories, fixedTotal, afterFixed, shortfall,
    percentBase, percentCategories, percentTotal, afterPercent,
    remainderCategories, remainderEach, remainderTotal,
    netSettlement,
  };
}

// ─── Grand total ─────────────────────────────────────────────────────────────

// 2026-09-24 新增 otherAssetsTWD（選填參數，預設 0）——其他資產（保單價值／
// 不動產）計入淨資產，跟現金／定存／投資一樣是「真的算你的」資產，不像應收
// 款那樣刻意不計入。舊的呼叫端（沒傳這個參數）行為完全不變。
export function calcNetWorth({ cashTWD, depositTWD, investmentTWD, otherAssetsTWD = 0 }) {
  return cashTWD + depositTWD + investmentTWD + otherAssetsTWD;
}

// ─── Upcoming Reminders ────────────────────────────────────────────────────
// Dashboard "近期到期／即將繳款" card (見路線圖「六、第六階段」).
// Sources included: deposit maturity, credit card due day / actual due
// date, recurring-expense billing_day ('monthly'/'yearly'), billing_weekday
// ('weekly' — see daysToWeekday below), next_date ('custom'-interval),
// installment due_day, and recurring-income billing_day (an upcoming
// expected deposit, not an obligation — see the 'recurringincome' entries
// below). All amounts returned are already TWD (matches how each source
// store records amounts elsewhere in the app), so callers don't need
// fxRates.
//
// Weekly recurring expenses: until this feature, `recurring_expenses` only
// stored a generic "day" number with no day-of-week semantics for 'weekly'
// items, so no reliable next-occurrence date could be derived and they were
// excluded outright. Fixed by adding `billing_weekday` (0=Sun..6=Sat),
// specific to 'weekly' mode — the old generic day field stays reserved for
// 'monthly'/'yearly'.

function daysToMonthDay(day, fromDate = new Date()) {
  if (!day) return null;
  const today = new Date(fromDate); today.setHours(0, 0, 0, 0);
  const target = new Date(today);
  target.setDate(day);
  if (target <= today) target.setMonth(target.getMonth() + 1);
  return Math.ceil((target - today) / 86400000);
}

/**
 * Days until the next occurrence of a given day-of-week (0=Sun..6=Sat),
 * counting today (0) as a match. Same "next occurrence, never in the past"
 * shape as daysToMonthDay above.
 */
function daysToWeekday(weekday, fromDate = new Date()) {
  if (weekday == null) return null;
  const today = new Date(fromDate); today.setHours(0, 0, 0, 0);
  const diff = (weekday - today.getDay() + 7) % 7;
  return diff;
}

/**
 * @param {object} sources
 * @param {Array}  sources.depositItems     — calcDepositAssets(...).items (has principalTWD)
 * @param {Array}  sources.creditCards      — from 'credit_cards' store
 * @param {Array}  sources.recurringExpenses — from 'recurring_expenses' store
 * @param {Array}  sources.installments      — from 'installments' store
 * @param {Array}  sources.recurringIncome   — from 'recurring_income' store
 * @param {object} [opts]
 * @param {number} [opts.windowDays=14] — only include items due within this many days (0 = today)
 * @returns {Array<{type:string,id:string,label:string,daysUntil:number,amount:number|null}>}
 *          sorted soonest-first
 */
export function calcUpcomingReminders(
  { depositItems = [], creditCards = [], recurringExpenses = [], installments = [], recurringIncome = [] },
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
    } else if (r.freq === 'weekly') {
      days = daysToWeekday(r.billing_weekday);
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

  // 固定收入 (recurring_income) — an expected deposit, not an obligation;
  // only monthly billing_day is supported (matches recurring_income's own
  // "monthly amount only" scope from 七之一 — no yearly/custom here yet).
  for (const inc of recurringIncome) {
    if (!inc.billing_day) continue;
    const days = daysToMonthDay(inc.billing_day);
    if (days == null || days > windowDays) continue;
    items.push({
      type: 'recurringincome', id: inc.id, label: `${inc.name} 預計入帳`,
      daysUntil: days, amount: inc.amount ?? null,
    });
  }

  items.sort((a, b) => a.daysUntil - b.daysUntil);
  return items;
}

// ─── Full calendar view (§十五) ────────────────────────────────────────────────
// calcUpcomingReminders above answers "what's due in the next N days" for the
// homepage reminder card. The full calendar page needs a different shape of
// answer — "what occurs on each day of THIS displayed month" — for an
// arbitrary month, not just a rolling window from today. These are the date-
// math helpers that make that possible, plus two new recurring source types
// (recurring_transfers, dca_schedules) that came out of a 2026-09-19 audit
// against the user's original account-holdings notes: 定期換匯 and 定期定額
// stock purchases were both real recurring commitments with no data model
// anywhere in the app, so neither could ever show up on a calendar.

function daysInMonth(year, month) { return new Date(year, month, 0).getDate(); } // month is 1-indexed
function clampDay(day, year, month) { return Math.min(Math.max(1, day), daysInMonth(year, month)); }
function pad2(n) { return String(n).padStart(2, '0'); }

function monthlyDateInMonth(billingDay, year, month) {
  if (!billingDay) return null;
  return `${year}-${pad2(month)}-${pad2(clampDay(billingDay, year, month))}`;
}
function yearlyDateInMonth(billingMonth, billingDay, year, month) {
  if (!billingMonth || !billingDay || billingMonth !== month) return null;
  return monthlyDateInMonth(billingDay, year, month);
}
function weeklyDatesInMonth(weekday, year, month) {
  if (weekday == null) return [];
  const n = daysInMonth(year, month);
  const dates = [];
  for (let d = 1; d <= n; d++) {
    if (new Date(year, month - 1, d).getDay() === weekday) dates.push(`${year}-${pad2(month)}-${pad2(d)}`);
  }
  return dates;
}
// "every N months from this anchor date" — used for both recurring_expenses'
// existing 'custom' frequency and the two new recurring types below. Anchor
// is whatever date the record's `next_date`/`start_date` field holds; an
// occurrence lands in the target month iff the month distance from the
// anchor to the target is an exact multiple of N (works both forward and
// backward from the anchor, so past months on the calendar show correctly
// too, not just future ones).
function customDateInMonth(anchorDateStr, everyNMonths, year, month) {
  if (!anchorDateStr || !everyNMonths) return null;
  const anchor = new Date(anchorDateStr + (anchorDateStr.length <= 7 ? '-01' : ''));
  if (isNaN(anchor)) return null;
  const ay = anchor.getFullYear(), am = anchor.getMonth() + 1, ad = anchor.getDate();
  const diffMonths = (year - ay) * 12 + (month - am);
  if (diffMonths % everyNMonths !== 0) return null;
  return monthlyDateInMonth(ad, year, month);
}

/**
 * @param {object} sources — same shape as calcUpcomingReminders, plus:
 * @param {Array}  sources.recurringTransfers — from 'recurring_transfers' store
 * @param {Array}  sources.dcaSchedules       — from 'dca_schedules' store
 * @param {number} year, {number} month (1-indexed)
 * @returns {Array<{date, type, id, label, amountLabel}>} sorted by date
 */
export function calcMonthCalendarItems(
  { depositItems = [], creditCards = [], recurringExpenses = [], installments = [],
    recurringIncome = [], recurringTransfers = [], dcaSchedules = [] },
  year, month
) {
  const items = [];
  const monthPrefix = `${year}-${pad2(month)}`;

  for (const d of depositItems) {
    if (d.status && d.status !== 'active') continue;
    if (!d.maturity_date || !d.maturity_date.startsWith(monthPrefix)) continue;
    items.push({ date: d.maturity_date, type: 'deposit', id: d.id, refId: d.id,
      label: `${d.bank?.name ?? ''} ${d.label ?? '定存'}到期`.trim(),
      amountLabel: d.principalTWD != null ? `NT$ ${fmt(d.principalTWD)}` : null });
  }

  for (const c of creditCards) {
    if (!((c.current_balance || 0) > 0)) continue;
    let date = null;
    if (c.actual_due_date && c.actual_due_date.startsWith(monthPrefix)) date = c.actual_due_date;
    else if (c.due_day) date = monthlyDateInMonth(c.due_day, year, month);
    if (!date) continue;
    items.push({ date, type: 'creditcard', id: c.id, refId: c.id, label: `${c.name} 繳款`, amountLabel: `NT$ ${fmt(c.current_balance)}` });
  }

  for (const r of recurringExpenses) {
    if (r.is_expired) continue;
    let dates = [];
    if (r.freq === 'monthly') { const dt = monthlyDateInMonth(r.billing_day, year, month); if (dt) dates = [dt]; }
    else if (r.freq === 'yearly') { const dt = yearlyDateInMonth(r.billing_month, r.billing_day, year, month); if (dt) dates = [dt]; }
    else if (r.freq === 'weekly') { dates = weeklyDatesInMonth(r.billing_weekday, year, month); }
    else if (r.freq === 'custom') { const dt = customDateInMonth(r.next_date, r.custom_months, year, month); if (dt) dates = [dt]; }
    dates.forEach(date => items.push({ date, type: 'recurring', id: r.id, refId: r.id, label: r.name,
      amountLabel: r.amount != null ? fmtCurrency(r.amount, r.currency || 'TWD') : null }));
  }

  for (const i of installments) {
    if (!i.due_day || (i.paid_periods || 0) >= i.total_periods) continue;
    const date = monthlyDateInMonth(i.due_day, year, month);
    if (!date) continue;
    items.push({ date, type: 'installment', id: i.id, refId: i.id, label: `${i.name} 分期`,
      amountLabel: `NT$ ${fmt(i.per_amount ?? Math.round(i.total_amount / i.total_periods))}` });
  }

  for (const inc of recurringIncome) {
    if (!inc.billing_day) continue;
    const date = monthlyDateInMonth(inc.billing_day, year, month);
    if (!date) continue;
    items.push({ date, type: 'recurringincome', id: inc.id, refId: inc.id, label: `${inc.name} 預計入帳`,
      amountLabel: inc.amount != null ? `+NT$ ${fmt(inc.amount)}` : null });
  }

  for (const t of recurringTransfers) {
    if (t.is_expired) continue;
    let date = null;
    if (t.freq === 'monthly') date = monthlyDateInMonth(t.billing_day, year, month);
    else if (t.freq === 'custom') date = customDateInMonth(t.next_date, t.custom_months, year, month);
    if (!date) continue;
    items.push({ date, type: 'transfer', id: t.id, refId: t.id, label: t.name,
      amountLabel: t.amount != null ? fmtCurrency(t.amount, t.currency || 'TWD') : null });
  }

  for (const s of dcaSchedules) {
    if (s.is_expired) continue;
    let date = null;
    if (s.freq === 'monthly') date = monthlyDateInMonth(s.billing_day, year, month);
    else if (s.freq === 'custom') date = customDateInMonth(s.next_date, s.custom_months, year, month);
    if (!date) continue;
    items.push({ date, type: 'dca', id: s.id, refId: s.id, label: `${s.name} 定期定額`,
      amountLabel: s.amount != null ? fmtCurrency(s.amount, s.currency || 'TWD') : null });
  }

  items.sort((a, b) => a.date.localeCompare(b.date));
  return items;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function isStalePrice(fetchedAt) {
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
