/**
 * PFCC — Market Data Service
 *
 * ADR-001 / ADR-002 compliance:
 * - Provider abstraction: swap sources without touching Investment UI
 * - Last Known Price always persisted to IndexedDB
 * - User financial data never sent to any external service
 * - Only ticker + market leave the device
 */

import { getAll, getOne, putOne, putMany } from './db.js';

// ─── Provider registry ────────────────────────────────────────────────────────
// Priority order: first provider that succeeds wins.
// 'manual' is the final fallback — it never fails, it just returns null price.

const US_PROVIDERS = ['vercel_proxy', 'manual'];
const TW_PROVIDERS = ['manual']; // V1: TW stocks use manual price entry

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Refresh prices for a list of tickers.
 * Always saves successful results to IndexedDB.
 * Returns { updated: [...], failed: [...] }
 */
export async function refreshPrices(db, holdings) {
  const usTickers = [...new Set(
    holdings.filter(h => h.market === 'US').map(h => h.ticker)
  )];
  const twTickers = [...new Set(
    holdings.filter(h => h.market === 'TW').map(h => h.ticker)
  )];

  const results = { updated: [], failed: [] };

  // US stocks — try providers in order
  for (const ticker of usTickers) {
    const result = await fetchWithFallback(ticker, 'US', US_PROVIDERS);
    if (result) {
      await savePriceToDb(db, ticker, 'US', result);
      results.updated.push(ticker);
    } else {
      results.failed.push(ticker);
    }
  }

  // TW stocks — manual only in V1; mark as needing user input
  for (const ticker of twTickers) {
    const existing = await getOne(db, 'market_prices', ticker);
    if (!existing) {
      // First time — seed a placeholder so UI can prompt user
      await savePriceToDb(db, ticker, 'TW', {
        price: null, source: 'manual', needs_update: true,
      });
    }
  }

  return results;
}

/**
 * Get the best available price for a ticker.
 * Returns Last Known Price if live fetch is unavailable.
 */
export async function getPrice(db, ticker) {
  return getOne(db, 'market_prices', ticker);
}

/**
 * Manually set a price (for TW stocks or user overrides).
 */
export async function setManualPrice(db, ticker, market, price) {
  return savePriceToDb(db, ticker, market, {
    price,
    source: 'manual',
    needs_update: false,
  });
}

// ─── FX Rates ─────────────────────────────────────────────────────────────────

export async function refreshFxRates(db) {
  try {
    // Vercel proxy forwards to ExchangeRate-API
    // Only currency codes are sent — no user data
    const res = await fetch('/api/fx?base=TWD&symbols=USD,JPY', {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`FX proxy ${res.status}`);
    const data = await res.json();

    // data.rates: { USD: 0.03077, JPY: 4.6 } (TWD base)
    // We want: how many TWD per 1 USD / JPY
    const usdRate = data.rates?.USD ? +(1 / data.rates.USD).toFixed(4) : null;
    const jpyRate = data.rates?.JPY ? +(1 / data.rates.JPY).toFixed(6) : null;

    const now = new Date().toISOString();
    if (usdRate) await putOne(db, 'fx_rates', { pair: 'USD_TWD', rate: usdRate, fetched_at: now, source: 'exchangerate-api' });
    if (jpyRate) await putOne(db, 'fx_rates', { pair: 'JPY_TWD', rate: jpyRate, fetched_at: now, source: 'exchangerate-api' });

    return { usdRate, jpyRate, fetched_at: now };
  } catch (err) {
    console.warn('[FX] Live fetch failed, using Last Known Rate:', err.message);
    return null;
  }
}

export async function getFxRates(db) {
  const [usd, jpy] = await Promise.all([
    getOne(db, 'fx_rates', 'USD_TWD'),
    getOne(db, 'fx_rates', 'JPY_TWD'),
  ]);
  return {
    USD_TWD: usd?.rate ?? 32.5,   // fallback if never fetched
    JPY_TWD: jpy?.rate ?? 0.217,
    usd_fetched_at: usd?.fetched_at ?? null,
    jpy_fetched_at: jpy?.fetched_at ?? null,
    is_stale: isStale(usd?.fetched_at) || isStale(jpy?.fetched_at),
  };
}

// ─── Internals ────────────────────────────────────────────────────────────────

async function fetchWithFallback(ticker, market, providers) {
  for (const provider of providers) {
    if (provider === 'manual') return null; // manual = no auto fetch
    const result = await fetchFromProvider(provider, ticker, market);
    if (result?.price != null) return result;
  }
  return null;
}

async function fetchFromProvider(provider, ticker, market) {
  if (provider === 'vercel_proxy') {
    try {
      // Only ticker + market sent to proxy. No user data.
      const res = await fetch(
        `/api/quote?ticker=${encodeURIComponent(ticker)}&market=${market}`,
        { signal: AbortSignal.timeout(8000) }
      );
      if (!res.ok) throw new Error(`proxy ${res.status}`);
      const data = await res.json();
      if (data?.price == null) throw new Error('no price in response');
      return { price: data.price, source: 'vercel_proxy', provider_detail: data.provider };
    } catch (err) {
      console.warn(`[Market] ${provider} failed for ${ticker}:`, err.message);
      return null;
    }
  }
  return null;
}

async function savePriceToDb(db, ticker, market, { price, source, needs_update = false, provider_detail = null }) {
  const now = new Date().toISOString();
  const existing = await getOne(db, 'market_prices', ticker);
  await putOne(db, 'market_prices', {
    ticker,
    market,
    price:          price ?? existing?.price ?? null,
    source:         source ?? 'unknown',
    provider_detail,
    needs_update,
    fetched_at:     price != null ? now : (existing?.fetched_at ?? null),
    updated_at:     now,
  });
}

function isStale(isoString) {
  if (!isoString) return true;
  const ageHours = (Date.now() - new Date(isoString).getTime()) / 3600000;
  return ageHours > 24;
}
