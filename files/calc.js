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
    totalTWD += balTWD;

    // By currency
    byCurrency[acc.currency] = (byCurrency[acc.currency] ?? 0) + acc.balance;

    // By bank
    const bankId = acc.bank_id ?? '__cash__';
    if (!byBank[bankId]) {
      byBank[bankId] = {
        bank: bankMap[bankId] ?? { id: '__cash__', name: '現金', color: '#6B7280' },
        accounts: [],
        totalTWD: 0,
      };
    }
    byBank[bankId].accounts.push({ ...acc, balTWD });
    byBank[bankId].totalTWD += balTWD;
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

// ─── Grand total ─────────────────────────────────────────────────────────────

export function calcNetWorth({ cashTWD, depositTWD, investmentTWD }) {
  return cashTWD + depositTWD + investmentTWD;
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
  const formatted = new Intl.NumberFormat('zh-TW', {
    minimumFractionDigits: currency === 'TWD' ? 0 : 2,
    maximumFractionDigits: currency === 'TWD' ? 0 : (currency === 'JPY' ? 0 : 2),
  }).format(Math.abs(amount));
  return sign + (amount < 0 ? '−' : '') + formatted;
}

export function fmtCurrency(amount, currency) {
  const symbols = { TWD: 'NT$', USD: 'US$', JPY: '¥' };
  return (symbols[currency] ?? currency + ' ') + fmt(amount, { currency });
}

export function fmtDate(isoString) {
  if (!isoString) return '—';
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
