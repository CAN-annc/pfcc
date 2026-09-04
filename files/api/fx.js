/**
 * PFCC — FX Rate Proxy (Vercel Edge Function)
 * ADR-001/002: only currency codes received; no user financial data.
 * GET /api/fx?base=TWD&symbols=USD,JPY
 */
export const config = { runtime: 'edge' };

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  const { searchParams } = new URL(req.url);
  const base    = (searchParams.get('base')    ?? 'TWD').toUpperCase();
  const symbols = (searchParams.get('symbols') ?? 'USD,JPY').toUpperCase();

  // Validate — only currency codes, no user data possible
  const allowed = /^[A-Z,]+$/;
  if (!allowed.test(base) || !allowed.test(symbols)) {
    return json({ error: 'Invalid currency codes' }, 400);
  }

  const apiKey = process.env.EXCHANGERATE_API_KEY;

  try {
    // ExchangeRate-API free plan: https://v6.exchangerate-api.com
    const url = apiKey
      ? `https://v6.exchangerate-api.com/v6/${apiKey}/latest/${base}`
      : `https://open.er-api.com/v6/latest/${base}`;   // fallback: open.er-api (no key needed, 1500/mo)

    const res  = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) throw new Error(`ExchangeRate-API ${res.status}`);
    const data = await res.json();

    if (!data?.rates) throw new Error('no rates in response');

    // Filter to requested symbols only
    const requested = symbols.split(',').filter(Boolean);
    const filtered  = {};
    for (const sym of requested) {
      if (data.rates[sym] != null) filtered[sym] = data.rates[sym];
    }

    return json({
      base,
      rates:      filtered,
      fetched_at: new Date().toISOString(),
      provider:   apiKey ? 'exchangerate-api' : 'open.er-api',
    });

  } catch (err) {
    console.error('[fx]', err.message);
    return json({ error: err.message, fetched_at: new Date().toISOString() }, 503);
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
