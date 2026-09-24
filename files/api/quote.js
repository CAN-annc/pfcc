/**
 * PFCC — Market Quote Proxy (Vercel Edge Function)
 * ADR-001/002: only ticker+market received; no user financial data ever logged.
 * GET /api/quote?ticker=AAPL&market=US
 *
 * 2026-09-24 更新：market=TW 原本是寫死回傳 price:null（V1 只支援手動輸入）。
 * 這次補上台股報價的實際抓取邏輯。這段程式碼是跑在 Vercel 的伺服器端
 * （Edge Function），不是瀏覽器——CORS 是瀏覽器才有的安全機制，伺服器對
 * 伺服器的請求不受它限制，所以之前在 index.html 前端直接呼叫這些端點會
 * 被 net::ERR_FAILED 擋下的問題，搬到這裡執行就不會再發生（這正是美股
 * market=US 這條路走 Finnhub 能穩定運作、而前端直接打證交所/Yahoo 一直
 * 失敗的根本差異）。
 *
 * 依序嘗試三個公開資料來源，第一個成功就採用，全部失敗則安靜地回傳
 * price:null（維持原本「請手動輸入」的行為，不會讓整個查價功能掛掉）：
 *   1. mis.twse.com.tw 即時查價（上市 tse_/上櫃 otc_ 前綴各試一次）
 *   2. openapi.twse.com.tw 證交所開放資料（STOCK_DAY_ALL，官方公開 API，
 *      一次回傳全部上市股票，在這個 Function 的記憶體裡快取 10 分鐘再重抓；
 *      注意 Edge Function 不保證每次呼叫都重用同一份記憶體，這個快取只是
 *      「有的話就用、沒有就重抓」的最佳努力優化，不是必要條件；只有上市
 *      股票的資料，不含上櫃）
 *   3. Yahoo Finance 非官方報價 API（.TW 上市／.TWO 上櫃各試一次）
 *
 * 這裡完全不會碰使用者的集保帳號或任何登入資訊——只是把股票代號丟給
 * 公開的報價服務查詢，跟 ADR-001/002「只有 ticker+market 離開裝置」的
 * 原則一致。
 */
export const config = { runtime: 'edge' };

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  const { searchParams } = new URL(req.url);
  const ticker = (searchParams.get('ticker') ?? '').toUpperCase().trim();
  const market = (searchParams.get('market') ?? '').toUpperCase().trim();

  if (!ticker || !['TW','US'].includes(market)) {
    return json({ error: 'Invalid params' }, 400);
  }

  if (market === 'TW') {
    try {
      const price = await fetchTwPrice(ticker);
      if (price != null) {
        return json({ ticker, market, price, currency: 'TWD',
                      provider: 'tw-multi', fetched_at: new Date().toISOString() });
      }
    } catch (err) {
      console.error(`[quote:TW] ${ticker}:`, err.message);
    }
    return json({ ticker, market, price: null, currency: 'TWD',
                  provider: 'none', message: 'Enter price manually', fetched_at: new Date().toISOString() });
  }

  const apiKey = process.env.FINNHUB_API_KEY;
  if (!apiKey) return json({ error: 'Provider not configured' }, 503);

  try {
    const res  = await fetch(
      `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(ticker)}&token=${apiKey}`,
      { signal: AbortSignal.timeout(6000) }
    );
    if (!res.ok) throw new Error(`Finnhub ${res.status}`);
    const data = await res.json();
    if (!data?.c || data.c === 0) throw new Error('zero price');

    return json({ ticker, market, price: data.c, currency: 'USD',
                  provider: 'finnhub', fetched_at: new Date().toISOString() });
  } catch (err) {
    console.error(`[quote] ${ticker}:`, err.message);
    return json({ ticker, market, price: null, currency: 'USD',
                  provider: 'error', error: err.message, fetched_at: new Date().toISOString() });
  }
}

// ─── TW price: 伺服器端依序嘗試三個來源 ────────────────────────────────
let _twOpenApiCache = null; // { map: Map<code, price>, ts: number }（best-effort）

async function fetchTwOpenApiMap() {
  const now = Date.now();
  if (_twOpenApiCache && (now - _twOpenApiCache.ts) < 10 * 60 * 1000) return _twOpenApiCache.map;
  try {
    const res = await fetch('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL', { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return _twOpenApiCache?.map ?? null;
    const arr = await res.json();
    const map = new Map();
    for (const row of (Array.isArray(arr) ? arr : [])) {
      const price = parseFloat(row.ClosingPrice);
      if (row.Code && !isNaN(price) && price > 0) map.set(row.Code, price);
    }
    _twOpenApiCache = { map, ts: now };
    return map;
  } catch (e) {
    return _twOpenApiCache?.map ?? null; // 抓失敗就沿用舊快取（若有）
  }
}

async function fetchTwPriceFromMis(ticker) {
  for (const prefix of ['tse', 'otc']) {
    try {
      const res = await fetch(`https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${prefix}_${ticker}.tw&json=1&delay=0`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) continue;
      const data = await res.json();
      const row = (data.msgArray || [])[0];
      if (!row) continue;
      // z：即時成交價；收盤後／未成交時常是 "-"，退回 y（昨日收盤價）。
      const price = parseFloat(row.z) || parseFloat(row.y) || null;
      if (price != null && price > 0) return price;
    } catch (e) { /* 換下一個前綴 */ }
  }
  return null;
}

async function fetchTwPriceFromYahoo(ticker) {
  for (const suffix of ['TW', 'TWO']) {
    try {
      const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${ticker}.${suffix}`, { signal: AbortSignal.timeout(6000) });
      if (!res.ok) continue;
      const data = await res.json();
      const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
      if (typeof price === 'number' && price > 0) return price;
    } catch (e) { /* 換下一個後綴 */ }
  }
  return null;
}

async function fetchTwPrice(ticker) {
  const fromMis = await fetchTwPriceFromMis(ticker);
  if (fromMis != null) return fromMis;
  const openApiMap = await fetchTwOpenApiMap().catch(() => null);
  if (openApiMap && openApiMap.has(ticker)) {
    const p = openApiMap.get(ticker);
    if (p > 0) return p;
  }
  return await fetchTwPriceFromYahoo(ticker);
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
