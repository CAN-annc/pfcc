/**
 * PFCC — Asset Calculation Engine
 * Pure functions. No DB calls. No side effects.
 * All monetary values in TWD unless suffixed with currency.
 */

// ─── Currency conversion ──────────────────────────────────────────────────────

// §卅七（2026-09-29，使用者回報「電腦版資產趨勢仍然無法紀錄」追查後修正）：
// 這裡原本假設 amount 一定是乾淨的數字，但任何一筆髒資料——例如帳戶餘額被
// 存成空字串 ''（`??` 只擋 null/undefined，不會擋空字串）——都會讓下游
// `totalTWD += toTWD(...)` 這種 `+=` 累加，一旦其中一次相加碰到字串，就會
// 從「數字相加」變成「字串接龍」（例如 0 + '' 會變成字串 '0'，之後所有加總
// 全部質變成字串），netWorth 最後算出來就不是一個有效數字，
// recordDailySnapshot() 的 Number.isFinite() 檢查會判定失敗、快照存不進去，
// 而且不會有任何錯誤訊息。這裡是全站幾乎每一筆金額換算台幣都會經過的單一
// 關卡，統一在這裡用 Number(...) 強制轉型、轉不出有效數字就當 0 處理，從
// 源頭擋掉任何髒資料，不用在每個呼叫端各自防呆。
export function toTWD(amount, currency, fxRates) {
  const n = Number(amount);
  const amt = Number.isFinite(n) ? n : 0;
  if (!currency || currency === 'TWD') return amt;
  // §四十五之一（2026-10-03，幣別系統擴充）：改成通用查表——任何幣別只要
  // fxRates 裡有 `<幣別>_TWD` 這個鍵就能換算（見 market.js 的 getFxRates，
  // 回傳形狀已經是動態的），不再只認得 USD／JPY 兩種。
  const rate = fxRates?.[`${currency}_TWD`];
  if (rate != null && Number.isFinite(Number(rate))) return amt * Number(rate);
  // 沒有這個幣別的匯率資料（極少見：剛新增第一個這種幣別的帳戶、背景匯率還
  // 沒抓回來）——USD／JPY 沿用舊版的保守預設值；其他幣別沒有可靠的預設值，
  // 維持舊版「不認得的幣別原樣傳回」的行為，等匯率抓回來後就會自動更正。
  if (currency === 'USD') return amt * 32.5;
  if (currency === 'JPY') return amt * 0.217;
  return amt;
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
    // 2026-09-24（追查「資產趨勢完全沒有紀錄」時發現的防呆）：acc.balance
    // 理論上不該是 null/undefined，但任何一筆髒資料（例如透過還原備份時
    // 版本不對齊、或手動編輯過 IndexedDB）都會讓 toTWD(undefined, ...) 算出
    // NaN，NaN 會一路污染 totalTWD → netWorth，害 recordDailySnapshot() 的
    // `if (!netWorth) return` 永遠判定「沒有淨資產」而跳過寫入快照，且不會
    // 拋出任何錯誤、使用者完全看不到問題所在。用 ?? 0 兜底，缺值當作 0 元
    // 處理，不讓單一一筆髒資料拖垮整個總資產計算。
    const balTWD = toTWD(acc.balance ?? 0, acc.currency, fxRates);
    const countInTotal = acc.include_in_total !== false;

    if (countInTotal) {
      totalTWD += balTWD;
      // §卅七：這裡原本直接用 acc.balance（沒有 toTWD 那層防呆），同一種空
      // 字串髒資料一樣會讓這個依幣別小計質變成字串——雖然這個小計目前沒有
      // 直接餵進 netWorth，但既然要修就一併補齊，不留一個沒防到的角落。
      const n = Number(acc.balance);
      byCurrency[acc.currency] = (byCurrency[acc.currency] ?? 0) + (Number.isFinite(n) ? n : 0);
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
      const principalTWD = toTWD(d.principal ?? 0, d.currency, fxRates); // 見 calcCashAssets 同一則 2026-09-24 註解：防止缺值造成 NaN 污染 netWorth
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
    const marketValueLocal = price != null ? (h.shares ?? 0) * price : null; // 見 calcCashAssets 同一則 2026-09-24 註解：防止缺值造成 NaN 污染 netWorth
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

// ─── Physical Gold ─────────────────────────────────────────────────────────
// 2026-09-24（使用者要求）：實體黃金（金條/金飾/黃金存摺）——台灣慣用的計價
// 單位是「台錢」（1 台錢＝3.75 公克），也支援公克／金衡盎司，方便直接對照
// 國際金價（通常以每金衡盎司美金報價）。價格來源見 market.js 的
// refreshGoldPrice()（呼叫新的 /api/gold 代理，存進既有 market_prices 的
// Last Known Price 架構，ticker 固定 'XAU_USD'）。

const GOLD_GRAMS_PER_TAEL = 3.75;       // 台錢（台兩制）
const GOLD_GRAMS_PER_OZ   = 31.1034768; // 金衡盎司（troy ounce）

/** Converts a holding's weight+unit into grams. Unrecognized/missing unit falls back to 'tael' (the common Taiwan quoting unit). */
export function goldToGrams(weight, unit) {
  // §卅八之一再補記（2026-09-29，追查「資產趨勢仍然無法紀錄」第三次復發時
  // 發現的漏洞）：全站其他每一種資產類別（現金／定存／投資／其他資產）的
  // 台幣小計都是透過 toTWD() 這個單一關卡防呆的，只有實體黃金是例外——
  // calcGoldAssets() 下面的 totalTWD 是直接用「公克數 × 每公克台幣單價」
  // 相乘算出來，沒有經過 toTWD()，所以 toTWD() 那層防呆完全保護不到這裡。
  // 這裡原本用 `weight ?? 0`，`??` 只擋 null/undefined，擋不住空字串或其他
  // 非數字字串（例如透過還原備份、或手動編輯過 IndexedDB 導致 weight 變成
  // 一個非數字字串）——一旦 weight 是這種髒資料，`w * GOLD_GRAMS_PER_TAEL`
  // 這類乘法會算出 NaN，NaN 會一路污染 calcGoldAssets 的 totalTWD →
  // calcNetWorth() 加總 → netWorth，跟 §卅七／§卅八之一防過的字串污染是
  // 同一種問題、只是換了一個沒防到的角落。改成跟 toTWD() 同一套
  // Number(...) + Number.isFinite 防呆，轉不出有效數字就當 0 處理。
  const n = Number(weight);
  const w = Number.isFinite(n) ? n : 0;
  if (unit === 'gram') return w;
  if (unit === 'oz')   return w * GOLD_GRAMS_PER_OZ;
  return w * GOLD_GRAMS_PER_TAEL;
}

/**
 * goldPriceUsdOz: 目前的國際金價（每金衡盎司美金），來自 market_prices 的
 * Last Known Price（沒抓到過就是 null，畫面上會提示手動查詢/等待更新，不會
 * 憑空估一個數字）。回傳 enriched 持有清單（含每筆換算後的公克數、TWD 市值、
 * 選填成本的未實現損益）、總市值 TWD，以及方便畫面顯示的「每公克／每台錢
 * 台幣」單價。
 */
export function calcGoldAssets(goldHoldings, goldPriceUsdOz, fxRates) {
  const pricePerGramTwd = goldPriceUsdOz != null
    ? toTWD(goldPriceUsdOz / GOLD_GRAMS_PER_OZ, 'USD', fxRates)
    : null;
  const pricePerTaelTwd = pricePerGramTwd != null ? pricePerGramTwd * GOLD_GRAMS_PER_TAEL : null;
  let totalTWD = 0;
  const enriched = (goldHoldings ?? []).map(g => {
    const grams = goldToGrams(g.weight, g.unit); // 已在 goldToGrams() 內防呆過 weight
    const valueTWD = pricePerGramTwd != null ? grams * pricePerGramTwd : null;
    // 雙重防呆（跟 calcCashAssets 的 byCurrency 累加同一種寫法）：即使
    // goldToGrams() 已經擋掉 weight 本身的髒資料，這裡仍用 Number.isFinite
    // 再檢查一次才累加進 totalTWD，避免將來這個函式的計算方式改變時，又
    // 重蹈「有一個角落沒防到」的覆轍。
    if (valueTWD != null) {
      const vn = Number(valueTWD);
      totalTWD += Number.isFinite(vn) ? vn : 0;
    }
    const hasCostBasis = g.cost_total != null && g.cost_total > 0;
    const unrealizedTWD = (hasCostBasis && valueTWD != null) ? (valueTWD - g.cost_total) : null;
    const unrealizedPct = (hasCostBasis && valueTWD != null) ? ((valueTWD - g.cost_total) / g.cost_total) * 100 : null;
    return { ...g, grams, valueTWD, hasCostBasis, unrealizedTWD, unrealizedPct };
  });
  return { enriched, totalTWD, pricePerGramTwd, pricePerTaelTwd };
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

// v2.4.0：同一個月份如果存了好幾筆（例如先在「設定預算」改過、又在快速設定
// 精靈改一次），原本只比 effective_month，同月份的幾筆誰排前面取決於資料庫
// 裡隨機 id 的順序——畫面可能顯示舊的那個數字。改成同月份再比 created_at，
// 一律以最後存的那筆為準。
function budgetRecordNewestFirst(a, b) {
  return b.effective_month.localeCompare(a.effective_month)
    || String(b.created_at ?? '').localeCompare(String(a.created_at ?? ''));
}

export function resolveBudget(budgets, categoryId, monthStr) {
  const candidates = budgets
    .filter(b => (b.category_id ?? null) === (categoryId ?? null) && b.effective_month <= monthStr)
    .sort(budgetRecordNewestFirst);
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
    .sort(budgetRecordNewestFirst);
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

// ─── 收入分配法（類別群組監控 ／ 保險每月約當支出）──────────────────────────
// 2026-10-01 新增。這兩個函式是「收入分配法」功能的資料層：類別群組監控卡片
// 不是新的一套獨立記帳/預算機制，純粹是把好幾個既有支出類別的本月花費加總，
// 跟卡片上一個共用的監控上限做比較；跟每個類別各自在「設定預算」頁可能已經
// 設定的固定/百分比/剩餘平分模式完全獨立並存，不互相取代。

/**
 * 一組支出類別（類別群組的 categoryIds）當月花費加總，直接重用
 * calcMonthlyExpenseByCategory 算出的逐類別加總表，純粹多一層 reduce。
 */
export function calcCategoryGroupSpent(expenseTxns, categoryIds, monthStr, accounts = [], fxRates = {}) {
  const byCat = calcMonthlyExpenseByCategory(expenseTxns, monthStr, accounts, fxRates);
  return (categoryIds || []).reduce((sum, cid) => sum + (byCat[cid] || 0), 0);
}

/**
 * 單筆定期支出換算成「每月約當」TWD 金額，依頻率換算（跟記帳管理定期支出頁
 * 頂部「每月平均」統計卡用的是同一套邏輯，這裡抽成可重用的純函式）：
 *   monthly → 原數字；yearly → ÷12；weekly → ×52÷12；custom → ÷custom_months
 * 换算不出來（頻率缺資訊）回傳 0，不拋錯、不中斷加總。
 */
export function calcRecurringMonthlyEquivalent(item, fxRates = {}) {
  const a = toTWD(item.amount, item.currency || 'TWD', fxRates);
  if (item.freq === 'monthly') return a;
  if (item.freq === 'weekly')  return a * 52 / 12;
  if (item.freq === 'custom' && item.custom_months) return a / item.custom_months;
  if (item.freq === 'yearly')  return a / 12;
  return 0;
}

/**
 * 「保費每月約當支出」——收入分配法裡「風險規避」這類錢罐的下限（floor）就
 * 是從這裡算出來的，不是寫死的數字。兩個來源都算，互不重複：
 *   - recurring_expenses 裡 category === 'insurance' 且未結束的項目（保費用
 *     定期支出記錄，例如銀行帳戶自動扣款月繳/年繳保費）
 *   - installments 裡 is_insurance === true 且尚未繳完的項目（保費用信用卡
 *     分期，例如年繳保費刷卡拆 12 期）
 * 兩邊是完全獨立的旗標（recurring 用既有「類別」下拉多一個選項、installment
 * 用新增的獨立勾選框），因為一筆保費只會透過其中一種方式記錄，不會同時出現
 * 在兩邊，加總不會重複計算。
 */
export function calcInsuranceMonthlyEquivalent(recurringExpenses = [], installments = [], fxRates = {}) {
  const fromRecurring = recurringExpenses
    .filter(i => i.category === 'insurance' && !i.is_expired)
    .reduce((sum, i) => sum + calcRecurringMonthlyEquivalent(i, fxRates), 0);
  const fromInstallments = installments
    .filter(i => i.is_insurance && (i.paid_periods || 0) < i.total_periods)
    .reduce((sum, i) => sum + (i.per_amount ?? Math.round(i.total_amount / i.total_periods)), 0);
  return fromRecurring + fromInstallments;
}

/**
 * 收入分配法的錢罐滑桿：拖動其中一個百分比時，依比例從其他（未鎖定的）錢罐
 * 「借」或「還」差額，確保總和永遠精準等於 100、且每個數字都是整數。
 *
 * 跟畫面稿（討論階段用來驗證這個演算法的設計稿）完全同一套邏輯、逐行照搬，
 * 只是把畫面稿裡 fund.locked 的鎖定概念泛化成一般的 jars（在真正的 App 裡只
 * 用在法則卡片本身的錢罐，不再有「專款」這層子層級——見本檔案開頭「收入分
 * 配法」相關說明：資金池底下的子項目就是既有的 Projects，Projects 本來就沒
 * 有獨立的預算/百分比欄位，所以不會有巢狀的第二層滑桿）。
 *
 * jars: [{key, percent, locked?, minPercent?}]　idx: 被拖動的那一個的索引
 * newVal: 使用者拖到的目標百分比（會先被夾到 [自己的 minPercent 無條件進位, 100]）
 * 回傳：同樣形狀的新陣列（不修改傳入的 jars）。
 */
export function rebalanceJarPercents(jars, idx, newVal) {
  const next = jars.map(j => ({ ...j }));
  const floors = next.map(j => j.minPercent ? Math.ceil(j.minPercent) : 0);
  const target = Math.max(floors[idx], Math.min(100, Math.round(Number(newVal))));

  const otherIdx = next.map((_, i) => i).filter(i => i !== idx && !next[i].locked);
  if (otherIdx.length === 0) return next;

  const othersOldTotal = otherIdx.reduce((s, i) => s + next[i].percent, 0);
  const othersFloorTotal = otherIdx.reduce((s, i) => s + floors[i], 0);
  const othersRoom = othersOldTotal - othersFloorTotal;

  let delta = target - next[idx].percent;
  let finalTarget = target;
  if (delta > othersRoom) { delta = othersRoom; finalTarget = next[idx].percent + delta; }
  if (delta === 0) return next;

  next[idx].percent = finalTarget;

  let remaining = -delta;
  const pool = otherIdx.map(i => ({ i, percent: next[i].percent, floor: floors[i] }));
  let guard = 0;
  while (remaining !== 0 && guard < 10) {
    guard++;
    const flexible = pool.filter(p => remaining < 0 ? (p.percent > p.floor) : true);
    if (flexible.length === 0) break;
    const basis = flexible.reduce((s, p) => s + (remaining < 0 ? (p.percent - p.floor) : p.percent), 0);
    if (basis <= 0) break;
    let distributedThisRound = 0;
    flexible.forEach((p, k) => {
      const weight = (remaining < 0 ? (p.percent - p.floor) : p.percent) / basis;
      let change = (k === flexible.length - 1) ? (remaining - distributedThisRound) : Math.round(remaining * weight);
      if (remaining < 0) change = Math.max(change, -(p.percent - p.floor));
      distributedThisRound += change;
      p.percent += change;
    });
    remaining -= distributedThisRound;
  }
  pool.forEach(p => { next[p.i].percent = p.percent; });
  return next;
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
// §卅七：最後一道防線——即使上游哪個小計不知為何還是傳了非數字進來，這裡也
// 不會再讓 netWorth 整個變成非數字，單純把那個小計當 0 處理。
export function calcNetWorth({ cashTWD, depositTWD, investmentTWD, otherAssetsTWD = 0, goldTWD = 0 }) {
  const n = v => Number.isFinite(v) ? v : 0;
  return n(cashTWD) + n(depositTWD) + n(investmentTWD) + n(otherAssetsTWD) + n(goldTWD);
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

// §卅八：把「還有幾天」換算回實際的 YYYY-MM-DD，好跟 last_confirmed_date
// 比對（daysToMonthDay 等函式只回傳天數，沒有連同算好的日期一起回傳）。
function isoDateAfterDays(days, fromDate = new Date()) {
  const d = new Date(fromDate); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
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
    // §卅八：跟月曆頁同一種修正——這一期已經在 last_confirmed_date 確認過
    // 就不要再提醒，不然首頁「近期到期」卡片也會一直卡著同一筆不消失。
    if (isoDateAfterDays(days) === r.last_confirmed_date) continue;
    items.push({ type: 'recurring', id: r.id, label: r.name, daysUntil: days, amount: r.amount ?? null });
  }

  for (const i of installments) {
    if (!i.due_day || (i.paid_periods || 0) >= i.total_periods) continue;
    const days = daysToMonthDay(i.due_day);
    if (days == null || days > windowDays) continue;
    // §卅九（2026-09-29，使用者回報手機版「確認本期」仍重複出現，追查後發現
    // 這裡跟下面 calcMonthCalendarItems 的分期付款分支都漏掉了這個檢查）：
    // 分期付款用「確認本期付款」確認時，寫的是 last_paid_ym（年-月，不是完整
    // 日期，見 index.html 的 instConfirmSave）——這裡原本完全沒有比對這個欄位，
    // 所以不管使用者確認過幾次，這張「近期到期」卡片都會一直提醒同一期，就跟
    // §卅八修正 recurringExpenses 之前一樣的問題，只是分期付款這條路徑當時漏改。
    if (isoDateAfterDays(days).slice(0, 7) === i.last_paid_ym) continue;
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

  // §卅八（2026-09-29，使用者回報「按確認本期之後，變成有兩筆電話費，而那
  // 個要我確認的仍然存在」追查後修正）：原本這裡完全不知道使用者已經按過
  // 「確認本期」——沒有任何欄位記錄「這一期處理過了」，所以不管確認幾次，
  // 同一天的提醒都會一直出現，使用者如果又點一次「確認本期」就會建立第二
  // 筆一模一樣的支出紀錄。修法：確認本期存檔成功後（見 index.html
  // expenseModalSave），會把這筆定期支出的 last_confirmed_date 設成剛確認
  // 的那一天，這裡只要看到某個算出來的日期剛好等於 last_confirmed_date，
  // 就跳過、不再產生提醒——下個月的日期不會相等，自然會正常出現。
  for (const r of recurringExpenses) {
    if (r.is_expired) continue;
    let dates = [];
    if (r.freq === 'monthly') { const dt = monthlyDateInMonth(r.billing_day, year, month); if (dt) dates = [dt]; }
    else if (r.freq === 'yearly') { const dt = yearlyDateInMonth(r.billing_month, r.billing_day, year, month); if (dt) dates = [dt]; }
    else if (r.freq === 'weekly') { dates = weeklyDatesInMonth(r.billing_weekday, year, month); }
    else if (r.freq === 'custom') { const dt = customDateInMonth(r.next_date, r.custom_months, year, month); if (dt) dates = [dt]; }
    dates.filter(date => date !== r.last_confirmed_date).forEach(date => items.push({ date, type: 'recurring', id: r.id, refId: r.id, label: r.name,
      amountLabel: r.amount != null ? fmtCurrency(r.amount, r.currency || 'TWD') : null }));
  }

  // §卅九（2026-09-29，使用者回報手機版「收支紀錄」頁月曆上，已經按過「確認
  // 本期付款」的分期付款，同一天還是一直顯示「確認本期」，有重複記帳的風險）：
  // 追查後發現這裡漏掉了跟上面 recurring／下面 transfer／dca 同一種檢查——
  // 分期付款本身其實早就有 last_paid_ym 這個欄位（§廿九之三就有，記的是
  // 「年-月」而不是完整日期，因為分期付款用月份而不是精確日期判斷「這期是否
  // 已確認」，見 renderInstallment() 自己的 due 篩選邏輯，那裡本來就有比對這
  // 個欄位、是對的）——只有這個月曆用的 calcMonthCalendarItems 從來沒有比對
  // 過它，才會讓使用者已經用「確認本期付款」處理過的那一期，只要月曆還停在
  // 同一個月，就一直重新出現同一顆「確認本期」按鈕。
  for (const i of installments) {
    if (!i.due_day || (i.paid_periods || 0) >= i.total_periods) continue;
    const date = monthlyDateInMonth(i.due_day, year, month);
    if (!date || monthPrefix === i.last_paid_ym) continue;
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

  // §卅八：同一種修正——定期轉帳／換匯這裡如果沒補，重複點「確認並記錄」會
  // 把同一筆錢真的再轉一次，比支出重複記一筆更嚴重。
  for (const t of recurringTransfers) {
    if (t.is_expired) continue;
    let date = null;
    if (t.freq === 'monthly') date = monthlyDateInMonth(t.billing_day, year, month);
    else if (t.freq === 'custom') date = customDateInMonth(t.next_date, t.custom_months, year, month);
    if (!date || date === t.last_confirmed_date) continue;
    items.push({ date, type: 'transfer', id: t.id, refId: t.id, label: t.name,
      amountLabel: t.amount != null ? fmtCurrency(t.amount, t.currency || 'TWD') : null });
  }

  // §卅八：同一種修正——定期定額同樣會重複入帳、重複增加持股股數。
  for (const s of dcaSchedules) {
    if (s.is_expired) continue;
    let date = null;
    if (s.freq === 'monthly') date = monthlyDateInMonth(s.billing_day, year, month);
    else if (s.freq === 'custom') date = customDateInMonth(s.next_date, s.custom_months, year, month);
    if (!date || date === s.last_confirmed_date) continue;
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
  const symbols = { TWD: 'NT$', USD: 'US$', JPY: '¥', EUR: '€', CNY: 'CN¥' };
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

/**
 * §四十二（2026-10-03）：「是否影響帳戶餘額」機制統一——拿掉原本依「回溯
 * 幾天」決定開關預設值的啟發式判斷（daysAgo／3 天門檻），改成單一欄位，
 * 新增紀錄一律預設開啟；真正「什麼時候套用」改由存檔當下的「交易日期 vs.
 * 今天」單純比對決定（見 index.html 的 expenseModalSave／incomeModalSave），
 * 不再需要這支函式，也不需要 daysAgo() 這個只服務它的小工具——兩個都在這次
 * 一併移除。
 */

// ─── §四十七（2026-10-03）資料健檢 ─────────────────────────────────────────────

const HEALTH_DAY_MS = 86400000;
function healthDaysBetween(fromIso, toIso) {
  if (!fromIso || !toIso) return null;
  const a = new Date(String(fromIso).slice(0, 10) + 'T00:00:00');
  const b = new Date(String(toIso).slice(0, 10) + 'T00:00:00');
  if (isNaN(a) || isNaN(b)) return null;
  return Math.round((b - a) / HEALTH_DAY_MS);
}
function healthIso(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function healthClampDay(day, y, m) { return Math.min(Math.max(1, day), new Date(y, m, 0).getDate()); }

/**
 * 某個定期項目（定期支出／定期定額／定期轉帳）「今天或之前最近的一次排定日期」。
 * 算不出來（週期資訊不完整）回傳 null。純函式，給資料健檢判斷「是不是逾期很久
 * 都沒確認」用。
 */
export function lastOccurrenceOnOrBefore(item, todayStr) {
  if (!item || !todayStr) return null;
  const today = new Date(todayStr + 'T00:00:00');
  if (item.freq === 'monthly' && item.billing_day) {
    let y = today.getFullYear(), m = today.getMonth() + 1;
    let d = new Date(y, m - 1, healthClampDay(item.billing_day, y, m));
    if (d > today) { m -= 1; if (m < 1) { m = 12; y -= 1; } d = new Date(y, m - 1, healthClampDay(item.billing_day, y, m)); }
    return healthIso(d);
  }
  if (item.freq === 'yearly' && item.billing_month && item.billing_day) {
    let y = today.getFullYear();
    let d = new Date(y, item.billing_month - 1, healthClampDay(item.billing_day, y, item.billing_month));
    if (d > today) { y -= 1; d = new Date(y, item.billing_month - 1, healthClampDay(item.billing_day, y, item.billing_month)); }
    return healthIso(d);
  }
  if (item.freq === 'weekly' && item.billing_weekday != null) {
    const back = (today.getDay() - item.billing_weekday + 7) % 7;
    const d = new Date(today); d.setDate(today.getDate() - back);
    return healthIso(d);
  }
  if (item.next_date) {
    const nd = /^\d{4}-\d{2}$/.test(item.next_date) ? `${item.next_date}-01` : item.next_date;
    return nd <= todayStr ? nd : null;
  }
  return null;
}

/**
 * 資料健檢：主動找出「資料可能有問題，建議回頭確認一下」的地方。純函式，
 * 不碰資料庫——呼叫端把需要的資料一次傳進來。每一筆發現都是統一形狀：
 *   { type, severity, title, description, link }
 *   - type：項目類型（下面 7 種之一）
 *   - severity：'warn'（比較可能真的有問題）／'info'（提醒確認即可）
 *   - title／description：畫面上顯示的標題與說明
 *   - link：{ view, tab? }——點下去要前往處理的頁面
 * 7 項檢查（使用者確認一次全部做完）：
 *   1 stale_price         持股報價過期已久（超過 7 天沒更新，或從沒抓到過）
 *   2 excluded_nonzero    標記「不計入總資產」的帳戶，餘額卻不是 0
 *   3 hidden_active       標記「首頁隱藏」的帳戶，最近 30 天內仍有收支紀錄
 *   4 overdue_unconfirmed 定期支出／定期定額／定期轉帳，最近一期已過 7 天以上
 *                         還沒確認（只檢查「曾經確認過」的項目——從來沒用過
 *                         「確認本期」的項目，無法判斷使用者是不是另外記帳）
 *   5 stale_receivable    應收款超過 90 天沒有任何收款活動，也沒標記不再追討
 *   6 stale_cc_balance    信用卡待繳金額不是 0，但超過 45 天沒有任何變動
 *   7 negative_no_note    帳戶餘額是負數，又沒有任何備註說明
 */
export function runDataHealthChecks(data = {}) {
  const {
    today = new Date().toISOString().slice(0, 10),
    accounts = [], holdings = [], prices = [], expenseTxns = [], incomeTxns = [],
    recurringExpenses = [], dcaSchedules = [], recurringTransfers = [],
    receivables = [], receivablePayments = [], creditCards = [],
  } = data;
  const findings = [];
  const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

  // 1 持股報價過期已久
  const priceMap = Object.fromEntries(prices.map(p => [p.ticker, p]));
  const staleTickers = [];
  for (const h of holdings) {
    if (!(num(h.shares) > 0)) continue;
    const p = priceMap[h.ticker];
    const age = p?.fetched_at ? healthDaysBetween(p.fetched_at, today) : null;
    if (!p || p.price == null || age == null || age > 7) staleTickers.push(h.ticker);
  }
  if (staleTickers.length > 0) {
    const uniq = [...new Set(staleTickers)];
    findings.push({
      type: 'stale_price', severity: 'warn',
      title: `${uniq.length} 檔持股的報價超過 7 天沒有更新`,
      description: `${uniq.slice(0, 6).join('、')}${uniq.length > 6 ? ' 等' : ''}——總資產裡的投資市值可能跟現在差很多。可以按右上角重新整理，抓不到的話到投資持倉頁手動輸入目前價格。`,
      // v2.3.0：帶上第一檔過期的代號，「前往」直接打開它的手動輸入價格視窗。
      link: { view: 'holdings', action: 'price', ticker: uniq[0] },
    });
  }

  // 2 不計入總資產、但餘額不是 0
  for (const a of accounts) {
    if (a.include_in_total === false && num(a.balance) !== 0) {
      findings.push({
        type: 'excluded_nonzero', severity: 'info',
        title: `「${a.name}」設定為不計入總資產，但餘額不是 0`,
        description: `目前餘額 ${num(a.balance)} ${a.currency || 'TWD'}。如果這個帳戶其實還在用，可能要改回計入總資產；如果已經不用了，可能忘了把餘額歸零。`,
        link: { view: 'settings', action: 'account', id: a.id },
      });
    }
  }

  // 3 首頁隱藏、但最近仍有交易
  for (const a of accounts) {
    if (a.show_on_home !== false) continue;
    const recent = [...expenseTxns, ...incomeTxns].some(t =>
      t.account_id === a.id && t.date && t.date <= today && healthDaysBetween(t.date, today) <= 30);
    if (recent) {
      findings.push({
        type: 'hidden_active', severity: 'info',
        title: `「${a.name}」在首頁是隱藏的，但最近 30 天還有收支紀錄`,
        description: '如果這個帳戶還在日常使用，可能是忘了取消「首頁隱藏」——隱藏的帳戶不會出現在資產總覽的帳戶清單裡。',
        link: { view: 'settings', action: 'account', id: a.id },
      });
    }
  }

  // 4 定期項目逾期很久沒確認
  const recurringGroups = [
    { list: recurringExpenses, kind: '定期支出', tab: 'recurring' },
    { list: dcaSchedules, kind: '定期定額', tab: 'dcaschedule' },
    { list: recurringTransfers, kind: '定期轉帳', tab: 'rectransfer' },
  ];
  for (const g of recurringGroups) {
    for (const item of g.list) {
      if (item.is_expired) continue;
      if (!item.last_confirmed_date) continue;
      if (item.end_date && item.end_date < today) continue;
      const occ = lastOccurrenceOnOrBefore(item, today);
      if (!occ || item.last_confirmed_date >= occ) continue;
      const late = healthDaysBetween(occ, today);
      if (late == null || late < 7) continue;
      findings.push({
        type: 'overdue_unconfirmed', severity: 'warn',
        title: `${g.kind}「${item.name || '未命名'}」已經逾期 ${late} 天還沒確認`,
        description: `最近一期排定在 ${occ}，到現在還沒按「確認本期」，帳戶餘額可能跟實際對不起來。如果這一期其實沒有發生，可以忽略這則提醒。`,
        // v2.3.0：「前往」直接打開逾期那一期的「確認本期」視窗。
        link: { view: 'txnmanage', tab: g.tab, action: 'confirm', id: item.id, occ },
      });
    }
  }

  // 5 應收款很久沒有收款活動
  const lastPayByRecv = {};
  for (const p of receivablePayments) {
    if (!p.receivable_id || !p.date) continue;
    if (!lastPayByRecv[p.receivable_id] || p.date > lastPayByRecv[p.receivable_id]) lastPayByRecv[p.receivable_id] = p.date;
  }
  for (const r of receivables) {
    if (r.is_settled || r.write_off) continue;
    const last = [lastPayByRecv[r.id], r.created_at ? String(r.created_at).slice(0, 10) : null].filter(Boolean).sort().pop();
    const idle = last ? healthDaysBetween(last, today) : null;
    if (idle == null || idle < 90) continue;
    findings.push({
      type: 'stale_receivable', severity: 'info',
      title: `應收款「${r.name}」已經 ${idle} 天沒有任何收款`,
      description: `還有 ${num(r.total_amount) - num(r.received_amount)} 元沒收到。可以聯絡對方確認，或者如果確定收不回來，可以標記「不再追討」。`,
      link: { view: 'settings', action: 'receivable', id: r.id },
    });
  }

  // 6 信用卡待繳金額很久沒變動
  for (const c of creditCards) {
    if (num(c.current_balance) === 0) continue;
    const txnDates = expenseTxns.filter(t => t.cc_id === c.id && t.date && t.date <= today).map(t => t.date);
    const stamps = [...txnDates, c.balance_updated_at ? String(c.balance_updated_at).slice(0, 10) : null].filter(Boolean).sort();
    const last = stamps.pop();
    if (!last) continue;
    const idle = healthDaysBetween(last, today);
    if (idle == null || idle < 45) continue;
    findings.push({
      type: 'stale_cc_balance', severity: 'info',
      title: `信用卡「${c.name}」的待繳金額已經 ${idle} 天沒有變動`,
      description: `目前記錄的待繳金額是 ${num(c.current_balance)} 元。如果這期帳單已經繳過、或金額已經變了，記得回來更新。`,
      link: { view: 'txnmanage', tab: 'creditcard', action: 'creditcard', id: c.id },
    });
  }

  // 7 負數餘額又沒有備註
  for (const a of accounts) {
    if (num(a.balance) < 0 && !String(a.note || '').trim()) {
      findings.push({
        type: 'negative_no_note', severity: 'warn',
        title: `「${a.name}」的餘額是負數`,
        description: `目前餘額 ${num(a.balance)} ${a.currency || 'TWD'}，一般帳戶不太會是負數，可能是某筆紀錄記錯。如果是正常情況（例如透支、預借），可以在帳戶的「備註」寫一下原因，這則提醒就不會再出現。`,
        link: { view: 'settings', action: 'account', id: a.id },
      });
    }
  }

  // warn 排前面
  findings.sort((x, y) => (x.severity === y.severity ? 0 : x.severity === 'warn' ? -1 : 1));
  return findings;
}
