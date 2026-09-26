/**
 * PFCC — Gold Price Proxy (Vercel Edge Function)
 * ADR-001/002: no user financial data ever leaves the device — this endpoint
 * takes no parameters at all, it just asks a public source "what's today's
 * gold price" and relays the number back.
 * GET /api/gold
 *
 * 2026-09-24 新增（使用者要求：購買了實體黃金，需要知道「今天的金價」，加上
 * 購買成本計算盈虧）。這是跑在 Vercel 的伺服器端（Edge Function），不是瀏覽
 * 器——理由跟 /api/quote.js 的台股報價完全一樣：伺服器對伺服器的請求不受
 * CORS 限制，前端直接呼叫公開金價 API 大機率會被瀏覽器擋下。
 *
 * 資料來源：gold-api.com（https://api.gold-api.com/price/XAU）——不需要
 * API 金鑰、回傳乾淨的 JSON（{price, symbol, currency, updatedAt, ...}），
 * 是目前已知最簡單可靠的免費金價來源。只用這一個來源，沒有像 /api/quote.js
 * 的美股/台股那樣做多層 fallback——理由是這裡的取捨跟當初美股最初只接
 * Finnhub 單一來源一樣：先求有、簡單、風險低，之後如果這個來源真的不穩定，
 * 可以再依 market.js 既有的 provider 陣列模式加第二個來源，不需要改動這裡
 * 或呼叫端（market.js 的 refreshGoldPrice()）的介面。
 *
 * 失敗時安靜地回傳 price_usd_oz:null（維持「請手動輸入/稍後再試」的行為，
 * 不會讓整個查價功能掛掉），跟 /api/quote.js、/api/fx.js 的既有設計一致。
 */
export const config = { runtime: 'edge' };

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  try {
    const res = await fetch('https://api.gold-api.com/price/XAU', {
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) throw new Error(`gold-api ${res.status}`);
    const data = await res.json();
    const price = typeof data?.price === 'number' ? data.price : null;
    if (price == null || price <= 0) throw new Error('no price in response');

    // gold-api.com 回傳的是「每金衡盎司美金」（XAU/USD 現貨價），跟大多數
    // 公開金價來源一致——換算成台幣每公克/每台錢的邏輯留在前端 calc.js
    // 做（見 calcGoldAssets），這裡只負責把原始數字忠實地轉發回去。
    return json({
      price_usd_oz: price,
      provider: 'gold-api.com',
      fetched_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[gold]', err.message);
    return json({
      price_usd_oz: null,
      provider: 'error',
      error: err.message,
      fetched_at: new Date().toISOString(),
    });
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
