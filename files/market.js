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
// 2026-09-22 修正：V1 台股原本只有 'manual'（前端直接呼叫 mis.twse.com.tw／
// openapi.twse.com.tw／Yahoo Finance 全部被瀏覽器 CORS 擋下，net::ERR_FAILED，
// 詳見這次對話紀錄的 Console 截圖）。改成跟美股同一套架構：先試
// vercel_proxy（呼叫同網域的 /api/quote，由伺服器端去抓資料，沒有 CORS
// 限制），失敗才退回 manual。2026-09-24：/api/quote 這個後端路由已經
// 加上 market=TW 的分支（依序嘗試 mis.twse.com.tw／證交所開放資料／
// Yahoo Finance 三個來源，第一個成功就用），這裡不用再改——見
// fetchFromProvider() 的 vercel_proxy 分支，呼叫方式跟 US 完全共用同一段
// 程式碼，只有 market 參數不同。
const TW_PROVIDERS = ['vercel_proxy', 'manual'];

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

  // TW stocks — 2026-09-22 起改成跟 US 同一套 fetchWithFallback 流程
  // （先試 vercel_proxy，失敗才算 failed）；vercel_proxy 也失敗、且這檔
  // 從來沒抓到過價格時，才種一筆佔位資料讓畫面提示使用者手動輸入——
  // 這段行為跟修改前完全相同，只是現在「先自動試一次」而不是直接跳過。
  for (const ticker of twTickers) {
    const result = await fetchWithFallback(ticker, 'TW', TW_PROVIDERS);
    if (result) {
      await savePriceToDb(db, ticker, 'TW', result);
      results.updated.push(ticker);
    } else {
      results.failed.push(ticker);
      const existing = await getOne(db, 'market_prices', ticker);
      if (!existing) {
        // First time — seed a placeholder so UI can prompt user
        await savePriceToDb(db, ticker, 'TW', {
          price: null, source: 'manual', needs_update: true,
        });
      }
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

const FX_CACHE_HOURS = 1; // 背景自動抓取的節流：沒有 force 時，1 小時內不重複打 API

// 2026-09-24（使用者要求）：原本「1 小時內不重複抓取」是寫死的、沒有任何
// 繞過方式——就算使用者手動按重新整理／重整頁面，只要距離上次抓取不到
// 1 小時就直接跳過，畫面上的匯率完全不會變。改成加一個 { force } 選項：
//   - force 沒給或 false：維持原本行為，1 小時內有快取就直接跳過（給定時
//     自動背景刷新用，避免每次頁面重新整理、每個分頁都各自狂打 API）。
//   - force: true：不管快取多新，一定重新呼叫 /api/fx 抓最新匯率（給使用者
//     按「重新整理」按鈕、或重新整理／開啟頁面時用，滿足「使用者想要更新
//     的時候就可以按按鈕或重新整理頁面」這個需求）。
// 呼叫端（index.html）另外會加一個每小時跑一次的背景計時器，滿足「每 1
// 小時自動抓取」；頁面載入時、以及使用者按下重新整理按鈕時則都傳 force:true。
export async function refreshFxRates(db, { force = false } = {}) {
  // Check if we already have a fresh rate (< 1 hour old) — force 時完全跳過這段檢查
  if (!force) {
    try {
      const [usd] = await Promise.all([getOne(db, 'fx_rates', 'USD_TWD')]);
      if (usd?.fetched_at) {
        const ageHours = (Date.now() - new Date(usd.fetched_at).getTime()) / 3600000;
        if (ageHours < FX_CACHE_HOURS) return null; // still fresh, skip API call
      }
    } catch(e) { /* no cached rate, proceed to fetch */ }
  }

  try {
    const res = await fetch('/api/fx?base=TWD&symbols=USD,JPY', {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`FX proxy ${res.status}`);
    const data = await res.json();

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
