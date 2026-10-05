/**
 * PFCC — 持股產業別／投資屬性自動判定（Vercel Edge Function）
 * GET /api/classify?items=TW:2330,TW:0050,US:AAPL
 * ADR-001/002：只有「市場＋代號」離開裝置，不帶股數、金額或任何使用者資料。
 *
 * v2.7.1（使用者回報：產業別、投資屬性應該由系統自動判定，不該交給使用者）
 * 全部改成「依公開資料判定」，每一筆結果都附上資料來源與判定理由，畫面上
 * 照實顯示，使用者看得到為什麼這檔被歸在這一類：
 *
 * 產業別
 *   台股個股：證交所 t187ap03_L「產業別」／櫃買中心 mopsfin_t187ap03_O
 *             SecuritiesIndustryCode（兩邊同一套兩位數代碼，例如 24＝半導體）。
 *   台股 ETF：穿透成分股——MoneyDJ「持股分佈(依產業)」（產業名稱跟證交所
 *             分類同一套），0050 會拆成半導體 69%、電子零組件 9%…；海外成分
 *             的 ETF 該頁只有地區，改抓同站 GICS 類股分佈。
 *   美股個股：Finnhub profile2 的 finnhubIndustry，對應到 GICS 11 大類中文名
 *             （跟美股 ETF 穿透用的 MoneyDJ 類股名稱同一套）。
 *   美股 ETF：MoneyDJ「持股分佈(依產業)」（GICS 11 大類）。
 *   債券 ETF（代號結尾 B）：債券。
 *
 * 投資屬性
 *   台股 ETF：證交所 t187ap47_L 的「基金類型」＋「標的指數名稱」——槓桿／
 *             反向、期貨、主動式直接看基金類型；其餘看追蹤的指數名稱（高股息、
 *             債、成長、價值、低波動、特定產業主題），都不是的就是市值型指數。
 *   台股個股：證交所 BWIBBU_d／櫃買 peQryDate 的殖利率、本益比、股價淨值比，
 *             依固定門檻判定（見 classifyStockStyle），門檻與實際數值一起回傳。
 *   美股個股：Finnhub /stock/metric 的同三項指標，門檻依美股水準調整。
 *   美股 ETF：Finnhub profile 沒有 ETF 資料，改用基金名稱關鍵字（Dividend、
 *             Bond、Growth、Value…）判定，理由會註明「依基金名稱」。
 *
 * 任何一個來源失敗都只影響那一部分（回傳 null＋原因），不會整批失敗。
 */
export const config = { runtime: 'edge' };

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS' };
const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; PFCC/2.7; +https://pfcc-psi.vercel.app)', 'Accept': 'application/json, text/html' };

// 證交所／櫃買中心共用的兩位數產業代碼（名稱去掉「業」字，跟 MoneyDJ 的
// 產業名稱寫法一致，兩個來源的結果才能加總在同一類）。
export const TW_INDUSTRY_CODES = {
  '01':'水泥','02':'食品','03':'塑膠','04':'紡織纖維','05':'電機機械','06':'電器電纜','08':'玻璃陶瓷','09':'造紙',
  '10':'鋼鐵','11':'橡膠','12':'汽車','14':'建材營造','15':'航運','16':'觀光餐旅','17':'金融保險','18':'貿易百貨',
  '19':'綜合','20':'其他','21':'化學','22':'生技醫療','23':'油電燃氣','24':'半導體','25':'電腦及週邊設備','26':'光電',
  '27':'通信網路','28':'電子零組件','29':'電子通路','30':'資訊服務','31':'其他電子','32':'文化創意','33':'農業科技',
  '34':'電子商務','35':'綠能環保','36':'數位雲端','37':'運動休閒','38':'居家生活','80':'管理股票','91':'存託憑證',
};

// Finnhub finnhubIndustry → GICS 11 大類（MoneyDJ 美股 ETF 類股分佈用的中文名）。
const FINNHUB_TO_GICS = {
  'Technology':'資訊科技','Semiconductors':'資訊科技','Electrical Equipment':'工業','Communications':'通信服務',
  'Media':'通信服務','Telecommunication':'通信服務','Banking':'金融','Financial Services':'金融','Insurance':'金融',
  'Pharmaceuticals':'健康護理','Biotechnology':'健康護理','Health Care':'健康護理','Life Sciences Tools & Services':'健康護理',
  'Retail':'非必需消費品','Automobiles':'非必需消費品','Hotels, Restaurants & Leisure':'非必需消費品','Textiles, Apparel & Luxury Goods':'非必需消費品',
  'Consumer products':'非必需消費品','Leisure Products':'非必需消費品','Distributors':'非必需消費品','Diversified Consumer Services':'非必需消費品',
  'Food Products':'必需性消費品','Beverages':'必需性消費品','Tobacco':'必需性消費品',
  'Energy':'能源','Oil & Gas':'能源','Utilities':'公用事業','Real Estate':'不動產',
  'Chemicals':'原料','Metals & Mining':'原料','Packaging':'原料','Construction Materials':'原料','Paper & Forest':'原料',
  'Aerospace & Defense':'工業','Airlines':'工業','Building':'工業','Construction':'工業','Machinery':'工業','Logistics & Transportation':'工業',
  'Marine':'工業','Road & Rail':'工業','Industrial Conglomerates':'工業','Commercial Services & Supplies':'工業','Professional Services':'工業',
  'Trading Companies & Distributors':'工業','Transportation Infrastructure':'工業','Auto Components':'非必需消費品',
};
const DEFENSIVE_GICS = new Set(['必需性消費品','公用事業','健康護理']);
const DEFENSIVE_TW = new Set(['食品','油電燃氣']);

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const { searchParams } = new URL(req.url);
  const items = (searchParams.get('items') ?? '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
    .map(s => { const [market, ticker] = s.split(':'); return { market, ticker }; })
    .filter(i => ['TW', 'US'].includes(i.market) && /^[A-Z0-9.\-]{1,12}$/.test(i.ticker ?? ''))
    .slice(0, 60);
  if (!items.length) return json({ error: 'Invalid params' }, 400);
  const results = await classifyItems(items, { fetch: globalThis.fetch, finnhubKey: process.env.FINNHUB_API_KEY });
  return json({ fetched_at: new Date().toISOString(), results });
}

// 依需要的資料來源一次抓齊（同一個來源不重複抓），再逐檔判定。
export async function classifyItems(items, { fetch, finnhubKey }) {
  const tw = items.filter(i => i.market === 'TW'), us = items.filter(i => i.market === 'US');
  const twStocks = tw.filter(i => !isTwEtf(i.ticker)), twEtfs = tw.filter(i => isTwEtf(i.ticker));
  const once = fn => { let p; return () => (p ??= fn().catch(() => null)); };
  const src = {
    twseProfile: once(() => getJson(fetch, 'https://openapi.twse.com.tw/v1/opendata/t187ap03_L')),
    tpexProfile: once(() => getJson(fetch, 'https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O')),
    twseVal:     once(() => getJson(fetch, 'https://www.twse.com.tw/rwd/zh/afterTrading/BWIBBU_d?response=json&selectType=ALL')),
    tpexVal:     once(() => getJson(fetch, 'https://www.tpex.org.tw/www/zh-tw/afterTrading/peQryDate?response=json')),
    twseEtf:     once(() => getJson(fetch, 'https://openapi.twse.com.tw/v1/opendata/t187ap47_L')),
  };
  const out = {};
  await Promise.all([
    ...twStocks.map(async i => { out[`TW:${i.ticker}`] = await classifyTwStock(i.ticker, src); }),
    ...twEtfs.map(async i => { out[`TW:${i.ticker}`] = await classifyTwEtf(i.ticker, src, fetch); }),
    ...us.map(async i => { out[`US:${i.ticker}`] = await classifyUs(i.ticker, fetch, finnhubKey); }),
  ]);
  return out;
}

// 台股 ETF 代號一律是 00 開頭（0050、006208、00878、00679B…）。
export function isTwEtf(t) { return /^00\d{2,4}[A-Z]?$/.test(t); }

async function classifyTwStock(code, src) {
  const r = { industry: null, style: null };
  const [lp, op] = await Promise.all([src.twseProfile(), src.tpexProfile()]);
  let indCode = null, board = null;
  const l = Array.isArray(lp) ? lp.find(x => String(x['公司代號']).trim() === code) : null;
  if (l) { indCode = String(l['產業別'] ?? '').trim(); board = '上市'; }
  else {
    const o = Array.isArray(op) ? op.find(x => String(x.SecuritiesCompanyCode ?? '').trim() === code) : null;
    if (o) { indCode = String(o.SecuritiesIndustryCode ?? '').trim(); board = '上櫃'; }
  }
  const indName = indCode ? (TW_INDUSTRY_CODES[indCode.padStart(2, '0')] ?? null) : null;
  r.industry = indName
    ? { mix: [{ name: indName, pct: 100 }], source: board === '上市' ? '證交所產業別' : '櫃買中心產業別' }
    : { mix: null, reason: (lp || op) ? '證交所與櫃買中心的公司資料都查不到這個代號' : '證交所／櫃買中心暫時連不上' };

  const metrics = await twValuation(code, board, src);
  r.style = metrics
    ? { ...classifyStockStyle(metrics, { market: 'TW', defensive: DEFENSIVE_TW.has(indName) }), metrics,
        source: board === '上櫃' ? '櫃買中心本益比／殖利率' : '證交所本益比／殖利率' }
    : { key: null, reason: '查不到本益比／殖利率資料' };
  return r;
}

async function twValuation(code, board, src) {
  const num = v => { const n = parseFloat(String(v ?? '').replace(/[,%]/g, '')); return Number.isFinite(n) ? n : null; };
  if (board !== '上櫃') {
    const v = await src.twseVal();
    // 欄位：證券代號,證券名稱,收盤價,殖利率(%),股利年度,本益比,股價淨值比,財報年/季
    const row = (v?.data ?? []).find(x => String(x[0]).trim() === code);
    if (row) return { yield: num(row[3]), pe: num(row[5]), pb: num(row[6]), date: v.date ?? null };
  }
  const v = await src.tpexVal();
  // 欄位：股票代號,公司名稱,本益比,每股股利,股利年度,殖利率(%),股價淨值比,財報年/季
  const row = (v?.tables?.[0]?.data ?? []).find(x => String(x[0]).trim() === code);
  if (row) return { yield: num(row[5]), pe: num(row[2]), pb: num(row[6]), date: v.date ?? null };
  return null;
}

// 個股投資屬性：固定門檻，依序判斷，第一個符合的就是答案。
//   高股息：殖利率 ≥ 5%（美股 ≥ 4%）
//   防禦型：民生必需／公用事業／醫療類（台股：食品、油電燃氣）且殖利率 ≥ 2.5%
//   價值型：本益比 ≤ 12 且股價淨值比 ≤ 1.5（美股：≤ 15 且 ≤ 2.5）
//   成長型：本益比 ≥ 25（美股 ≥ 30），或公司虧損（無本益比）但股價淨值比 ≥ 3
//   平衡型：以上皆非
export function classifyStockStyle(m, { market, defensive }) {
  const T = market === 'US' ? { y: 4, pe: 15, pb: 2.5, g: 30 } : { y: 5, pe: 12, pb: 1.5, g: 25 };
  const f = (n, d = 1) => (n == null ? '—' : n.toFixed(d));
  if (m.yield != null && m.yield >= T.y) return { key: 'dividend', reason: `殖利率 ${f(m.yield, 2)}% ≥ ${T.y}%` };
  if (defensive && m.yield != null && m.yield >= 2.5) return { key: 'defensive', reason: `民生／公用類股，殖利率 ${f(m.yield, 2)}% ≥ 2.5%` };
  if (m.pe != null && m.pe > 0 && m.pe <= T.pe && m.pb != null && m.pb <= T.pb) return { key: 'value', reason: `本益比 ${f(m.pe)} ≤ ${T.pe}、淨值比 ${f(m.pb, 2)} ≤ ${T.pb}` };
  if (m.pe != null && m.pe >= T.g) return { key: 'growth', reason: `本益比 ${f(m.pe)} ≥ ${T.g}` };
  if ((m.pe == null || m.pe <= 0) && m.pb != null && m.pb >= 3) return { key: 'growth', reason: `目前虧損（無本益比），淨值比 ${f(m.pb, 2)} ≥ 3` };
  if (m.pe == null && m.yield == null && m.pb == null) return { key: null, reason: '沒有本益比／殖利率資料' };
  return { key: 'balanced', reason: `本益比 ${f(m.pe)}、殖利率 ${f(m.yield, 2)}%，未達其他門檻` };
}

// 台股 ETF 投資屬性：證交所基金類型＋標的指數名稱。
export function classifyEtfStyleTw(fundType, indexName, code) {
  const t = fundType ?? '', n = indexName ?? '';
  const why = () => (n ? `追蹤「${n}」` : (t ? `基金類型「${t}」` : '依證券代號規則'));
  if (/槓桿|反向/.test(t) || /[LR]$/.test(code)) return { key: 'leveraged', reason: why('槓桿／反向型') };
  if (/期貨/.test(t) || /U$/.test(code)) return { key: 'commodity', reason: why('期貨型') };
  if (/債/.test(n) || /B$/.test(code)) return { key: 'bond', reason: why('債券') };
  if (/主動/.test(t)) return { key: 'active', reason: `基金類型為「${t}」` };
  if (/高股息|高息|股利|收益/.test(n)) return { key: 'dividend', reason: why('高股息指數') };
  if (/低波/.test(n)) return { key: 'defensive', reason: why('低波動指數') };
  if (/成長/.test(n)) return { key: 'growth', reason: why('成長指數') };
  if (/價值/.test(n)) return { key: 'value', reason: why('價值指數') };
  if (THEME_RE.test(n)) return { key: 'theme', reason: why('產業／主題指數') };
  if (!n && !t) return { key: null, reason: '證交所 ETF 資料查不到這個代號' };
  return { key: 'index', reason: why('市值型指數') };
}
const THEME_RE = /半導體|科技|電子|5G|AI|人工智慧|電動車|生技|醫療|金融|銀行|REIT|不動產|能源|綠能|網路|雲端|資安|機器人|晶片|航運|軍工|國防|元宇宙|遊戲|消費|品牌/;

async function classifyTwEtf(code, src, fetch) {
  const r = { industry: null, style: null };
  const list = await src.twseEtf();
  const e = Array.isArray(list) ? list.find(x => String(x['基金代號']).trim() === code) : null;
  r.style = { ...classifyEtfStyleTw(e?.['基金類型'], e?.['標的指數/追蹤指數名稱'], code), source: e ? '證交所 ETF 基本資料' : '證券代號規則' };
  if (/B$/.test(code) || r.style.key === 'bond') {
    r.industry = { mix: [{ name: '債券', pct: 100 }], source: '債券 ETF' };
    return r;
  }
  r.industry = await etfLookThrough(fetch, `${code}.TW`);
  return r;
}

// MoneyDJ「持股分佈(依產業)」：Basic0007a 是台股成分（證交所產業名稱），
// Basic0007 是海外成分（GICS 類股）。台股 ETF 先試 0007a，結果如果只有地區／
// 存款（海外成分 ETF）再試 0007。存款、現金不算產業，排除後重新換算成 100%。
const NON_INDUSTRY = /存款|現金|保證金|應收|應付|其他資產|北美|美國|歐洲|日本|亞洲|新興|已開發|全球|中國|香港|區域|附買回|期貨|基金/;
async function etfLookThrough(fetch, etfid) {
  const pages = etfid.endsWith('.TW') ? ['Basic0007a', 'Basic0007'] : ['Basic0007'];
  for (const p of pages) {
    const html = await getText(fetch, `https://www.moneydj.com/ETF/X/Basic/${p}.xdjhtm?etfid=${encodeURIComponent(etfid)}`).catch(() => null);
    const mix = html ? parseIndustryTable(html) : null;
    if (mix && mix.length) return { mix, source: 'MoneyDJ 成分股產業分佈' };
  }
  return { mix: null, reason: '查不到這檔 ETF 的成分股產業分佈' };
}

export function parseIndustryTable(html) {
  const at = html.search(/持股分[佈布]\s*[（(]\s*依產業/);
  if (at < 0) return null;
  const end = html.indexOf('</table>', html.indexOf('<table', at));
  if (end < 0) return null;
  const seg = html.slice(at, end);
  const strip = s => s.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  const rows = [];
  for (const m of seg.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...m[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(c => strip(c[1]));
    const name = cells.find(c => c && !/^[\d,.\-%]+$/.test(c));
    const pct = parseFloat(String(cells[cells.length - 1] ?? '').replace(/[,%]/g, ''));
    if (!name || !Number.isFinite(pct) || /產業|比例|顏色/.test(name)) continue;
    rows.push({ name: name.replace(/業$/, ''), pct });
  }
  const real = rows.filter(r => !NON_INDUSTRY.test(r.name) && r.pct > 0);
  const total = real.reduce((s, r) => s + r.pct, 0);
  if (!real.length || total < 30) return null; // 幾乎都是地區／存款：不是產業表
  return real.map(r => ({ name: r.name, pct: r.pct / total * 100 })).sort((a, b) => b.pct - a.pct);
}

async function classifyUs(ticker, fetch, key) {
  const r = { industry: null, style: null };
  let profile = null, metric = null;
  if (key) {
    [profile, metric] = await Promise.all([
      getJson(fetch, `https://finnhub.io/api/v1/stock/profile2?symbol=${encodeURIComponent(ticker)}&token=${key}`).catch(() => null),
      getJson(fetch, `https://finnhub.io/api/v1/stock/metric?symbol=${encodeURIComponent(ticker)}&metric=all&token=${key}`).catch(() => null),
    ]);
  }
  const isStock = profile && profile.finnhubIndustry;
  if (isStock) {
    const gics = FINNHUB_TO_GICS[profile.finnhubIndustry] ?? profile.finnhubIndustry;
    r.industry = { mix: [{ name: gics, pct: 100 }], source: 'Finnhub 公司產業' };
    const m = metric?.metric ?? {};
    const metrics = { pe: m.peTTM ?? m.peBasicExclExtraTTM ?? null, yield: m.dividendYieldIndicatedAnnual ?? m.currentDividendYieldTTM ?? null, pb: m.pbAnnual ?? m.pbQuarterly ?? null };
    r.style = { ...classifyStockStyle(metrics, { market: 'US', defensive: DEFENSIVE_GICS.has(gics) }), metrics, source: 'Finnhub 本益比／殖利率' };
    return r;
  }
  // 不是個股（Finnhub 沒有公司資料）→ 當作 ETF：產業穿透成分股，屬性看基金名稱。
  r.industry = await etfLookThrough(fetch, ticker);
  const name = (await moneydjEtfName(fetch, ticker)) ?? '';
  r.style = { ...classifyEtfStyleUs(name), source: '依基金名稱' };
  return r;
}

async function moneydjEtfName(fetch, ticker) {
  const html = await getText(fetch, `https://www.moneydj.com/ETF/X/Basic/Basic0007.xdjhtm?etfid=${encodeURIComponent(ticker)}`).catch(() => null);
  const m = html?.match(/<title>([^<]+)<\/title>/i);
  return m ? m[1].replace(/[-－|].*$/, '').trim() : null;
}

export function classifyEtfStyleUs(name) {
  const n = name ?? '';
  const why = () => `基金名稱「${n}」`;
  if (!n) return { key: null, reason: '查不到基金名稱' };
  if (/2x|3x|Ultra|Leveraged|Inverse|Short|槓桿|反向/i.test(n)) return { key: 'leveraged', reason: why('槓桿／反向') };
  if (/Bond|Treasury|Fixed Income|Aggregate|公債|債/i.test(n)) return { key: 'bond', reason: why('債券') };
  if (/Dividend|Yield|Income|股息|股利|收益/i.test(n)) return { key: 'dividend', reason: why('高股息') };
  if (/Min(imum)? Vol|Low Vol|低波/i.test(n)) return { key: 'defensive', reason: why('低波動') };
  if (/Growth|成長/i.test(n)) return { key: 'growth', reason: why('成長') };
  if (/Value|價值/i.test(n)) return { key: 'value', reason: why('價值') };
  if (/Semiconductor|Technology|Tech|Health|Financial|Energy|Real Estate|REIT|Innovation|Clean|半導體|科技|醫療|金融|能源|不動產/i.test(n)) return { key: 'theme', reason: why('產業／主題') };
  return { key: 'index', reason: why('市值型指數') };
}

async function getJson(fetch, url) {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(9000) });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}
async function getText(fetch, url) {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(9000) });
  if (!res.ok) throw new Error(`${res.status}`);
  const buf = await res.arrayBuffer();
  const cs = (res.headers.get('content-type') ?? '').match(/charset=([\w-]+)/i)?.[1]?.toLowerCase() ?? 'utf-8';
  try { return new TextDecoder(cs).decode(buf); } catch { return new TextDecoder('utf-8').decode(buf); }
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, s-maxage=21600', ...CORS } });
}
