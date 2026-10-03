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
//
// §四十五之一（2026-10-03，幣別系統擴充）：原本這裡寫死
// `/api/fx?base=TWD&symbols=USD,JPY`，只會抓台幣對美金／日幣兩種匯率。
// 直接讀過部署在 GitHub 上的 fx.js（Vercel Edge Function）原始碼確認過：
// fx.js 本身查詢外部匯率服務時拿到的就是該基準貨幣「全部」貨幣的匯率表，
// symbols 參數只是它自己收到全部資料後、在自己裡面做本地篩選——從來沒有
// 限制過可以查哪些貨幣，所以 fx.js 完全不用改，只要呼叫端自己改成動態組
// symbols 清單即可。
//
// symbols：目前實際在用的外幣幣別清單（呼叫端依帳戶/持股實際用到的幣別
// 動態算出，不含 TWD——TWD 是基準幣，不需要查自己對自己的匯率）。沒有任何
// 外幣在用（例如剛安裝、還沒新增任何帳戶）就直接跳過，不浪費一次 API 呼叫。
export async function refreshFxRates(db, { force = false, symbols = [] } = {}) {
  const list = [...new Set(symbols.filter(c => c && c !== 'TWD'))];
  if (list.length === 0) return null;

  // Check if we already have a fresh rate (< 1 hour old) — force 時完全跳過這段檢查。
  // 用獨立的 '_meta' 記錄存「上次成功抓取的時間」，不再綁定某一個特定幣別
  // 的 fetched_at（舊版寫死檢查 USD_TWD，新版可能根本沒有在用 USD）。
  if (!force) {
    try {
      const meta = await getOne(db, 'fx_rates', '_meta');
      if (meta?.fetched_at) {
        const ageHours = (Date.now() - new Date(meta.fetched_at).getTime()) / 3600000;
        if (ageHours < FX_CACHE_HOURS) return null; // still fresh, skip API call
      }
    } catch(e) { /* no cached rate, proceed to fetch */ }
  }

  try {
    const res = await fetch(`/api/fx?base=TWD&symbols=${list.map(encodeURIComponent).join(',')}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`FX proxy ${res.status}`);
    const data = await res.json();

    const now = new Date().toISOString();
    const result = { fetched_at: now };
    for (const cur of list) {
      const raw = data.rates?.[cur];
      if (!raw) continue; // 這個幣別這次沒查到資料，沿用上次存的（Last Known Rate）
      const rate = +(1 / raw).toFixed(6);
      await putOne(db, 'fx_rates', { pair: `${cur}_TWD`, rate, fetched_at: now, source: 'exchangerate-api' });
      result[`${cur}_TWD`] = rate;
    }
    await putOne(db, 'fx_rates', { pair: '_meta', fetched_at: now });
    return result;
  } catch (err) {
    console.warn('[FX] Live fetch failed, using Last Known Rate:', err.message);
    return null;
  }
}

// ─── Physical Gold Price ──────────────────────────────────────────────────
// 2026-09-24（使用者要求）：實體黃金（金條/金飾/黃金存摺）的「今天的金價」。
// 跟股票報價共用同一套 Last Known Price 架構（存進 market_prices，
// ticker 固定用 'XAU_USD'、market 固定用 'GOLD'），不需要另外開一張表。
// 節流規則沿用 FX 的做法（同一個 FX_CACHE_HOURS 常數）：沒有 force 時 1
// 小時內有快取就跳過，使用者按重新整理／開啟頁面時傳 force:true 一定重抓。
//
// 只用 gold-api.com 單一來源（免金鑰、回傳乾淨的 JSON，見 /api/gold.js 的
// 註解）——跟美股最初只有 Finnhub 單一來源是同樣的取捨，之後如果這個來源
// 不穩定，可以再依 market.js 既有的 provider 陣列模式加第二個來源，不需要
// 改動這裡呼叫端的介面。
export async function refreshGoldPrice(db, { force = false } = {}) {
  if (!force) {
    try {
      const existing = await getOne(db, 'market_prices', 'XAU_USD');
      if (existing?.fetched_at) {
        const ageHours = (Date.now() - new Date(existing.fetched_at).getTime()) / 3600000;
        if (ageHours < FX_CACHE_HOURS) return null; // still fresh, skip API call
      }
    } catch (e) { /* no cached price, proceed to fetch */ }
  }

  try {
    const res = await fetch('/api/gold', { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`gold proxy ${res.status}`);
    const data = await res.json();
    if (data?.price_usd_oz == null) throw new Error('no price in response');

    await savePriceToDb(db, 'XAU_USD', 'GOLD', {
      price: data.price_usd_oz, source: data.provider ?? 'gold_api',
    });
    return { price: data.price_usd_oz, fetched_at: new Date().toISOString() };
  } catch (err) {
    console.warn('[Gold] Live fetch failed, using Last Known Price:', err.message);
    return null;
  }
}

// §四十五之一：回傳形狀改成動態——資料庫裡存了哪些 `<幣別>_TWD` 匯率，就回傳
// 哪些（例如 { USD_TWD, JPY_TWD, EUR_TWD, usd_fetched_at, jpy_fetched_at,
// eur_fetched_at, fetched_at, is_stale }）。USD／JPY 兩個舊鍵名維持不變，
// 既有呼叫端完全不用改；新的幣別自動多出對應的鍵。USD／JPY 沿用舊版寫死
// 的保守預設值（32.5／0.217）當「從來沒抓過」時的最後防線，其他幣別沒有
// 預設值——沒有匯率時 calc.js 的 toTWD() 會自己處理。
export async function getFxRates(db) {
  const all = await getAll(db, 'fx_rates').catch(() => []);
  const result = {};
  let latest = null;
  let metaFetchedAt = null;
  for (const rec of all) {
    if (!rec) continue;
    if (rec.pair === '_meta') { metaFetchedAt = rec.fetched_at ?? null; continue; }
    if (rec.rate == null) continue;
    result[rec.pair] = rec.rate;
    const cur = rec.pair.split('_')[0];
    result[`${cur.toLowerCase()}_fetched_at`] = rec.fetched_at ?? null;
    if (rec.fetched_at && (!latest || rec.fetched_at > latest)) latest = rec.fetched_at;
  }
  if (result.USD_TWD == null) { result.USD_TWD = 32.5;  result.usd_fetched_at = null; }
  if (result.JPY_TWD == null) { result.JPY_TWD = 0.217; result.jpy_fetched_at = null; }
  // 「上次成功抓取的時間」：優先用 '_meta'（每次成功抓取都會更新）；舊版資料
  // 還沒有 '_meta' 時退回用個別幣別裡最新的那一筆。過時判斷也只看這個時間——
  // 不看每個幣別各自的時間，不然使用者不再使用某個幣別之後，那筆不再更新
  // 的舊匯率會讓首頁永遠顯示「匯率可能過時」。
  result.fetched_at = metaFetchedAt ?? latest;
  result.is_stale = isStale(result.fetched_at);
  return result;
}

// §四十五之一：目前支援的幣別清單（介面上可以選的幣別），單一來源，index.html
// 各處幣別下拉選單都從這裡產生。順序就是畫面上的排列順序。
export const SUPPORTED_CURRENCIES = [
  { code: 'TWD', label: '新台幣' },
  { code: 'USD', label: '美元' },
  { code: 'JPY', label: '日圓' },
  { code: 'EUR', label: '歐元' },
  { code: 'CNY', label: '人民幣' },
];

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
