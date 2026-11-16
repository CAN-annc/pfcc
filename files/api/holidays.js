/**
 * PFCC — 台股休市日（Vercel Edge Function，v2.30.0）
 * 只收年份，不收任何使用者資料。回傳那一年證交所公布的休市日（YYYY-MM-DD）。
 * GET /api/holidays?year=2027
 * 證交所格式：data = [[日期, 名稱, 說明], ...]；說明含「開始交易」「最後交易」的那幾天照常交易。
 */
export const config = { runtime: 'edge' };

export default async function handler(req) {
  const { searchParams } = new URL(req.url);
  const year = Number(searchParams.get('year'));
  if (!Number.isInteger(year) || year < 2020 || year > 2100) return json({ error: 'Invalid year' }, 400);
  try {
    const url = `https://www.twse.com.tw/rwd/zh/holidaySchedule/holidaySchedule?response=json&queryYear=${year - 1911}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(6000), headers: { 'User-Agent': 'Mozilla/5.0 PFCC' } });
    if (!res.ok) throw new Error(`TWSE ${res.status}`);
    const data = await res.json();
    const rows = Array.isArray(data?.data) ? data.data : [];
    const toISO = s => {
      const m = String(s).match(/(\d{2,4})[-/年](\d{1,2})[-/月](\d{1,2})/);
      if (!m) return null;
      let y = Number(m[1]); if (y < 1000) y += 1911;
      return `${y}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
    };
    const closed = rows
      .filter(r => !/開始交易|最後交易|照常/.test(String(r[2] ?? '') + String(r[1] ?? '')))
      .map(r => toISO(r[0])).filter(d => d && d.startsWith(String(year)));
    if (!closed.length) throw new Error('empty');
    return json({ year, closed: [...new Set(closed)].sort() }, 200, 'public, s-maxage=86400, stale-while-revalidate=604800');
  } catch (e) {
    return json({ error: String(e?.message || e) }, 502);
  }
}

function json(body, status = 200, cache = 'no-store') {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': cache } });
}
