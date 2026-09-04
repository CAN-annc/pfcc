/**
 * PFCC — Market Quote Proxy (Vercel Edge Function)
 * ADR-001/002: only ticker+market received; no user financial data ever logged.
 * GET /api/quote?ticker=AAPL&market=US
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

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
