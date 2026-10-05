/**
 * PFCC — 持股產業別／投資屬性自動判定（Vercel Edge Function）
 * GET /api/classify?items=TW:2330,TW:0050,US:AAPL   （?probe=1：各資料來源連線診斷）
 * ADR-001/002：只有「市場＋代號」離開裝置，不帶股數、金額或任何使用者資料。
 *
 * v2.7.1 起產業別、投資屬性由系統依公開資料判定（使用者：這不該交給使用者
 * 選），每一筆結果附資料來源與判定理由。v2.7.3 依實測調整資料來源——證交所
 * 會擋雲端主機（openapi 逾時、網站 403），改用從 Vercel 連得到的來源：
 *
 * 產業別
 *   上櫃個股：櫃買中心 openapi mopsfin_t187ap03_O（官方兩位數產業代碼）。
 *   上市個股：Yahoo 奇摩股市公司基本資料「產業類別」（與證交所分類同名）。
 *   台股 ETF：MoneyDJ「持股分佈(依產業)」穿透成分股（0050 → 半導體 69%…）；
 *             海外成分 ETF 該頁只有地區，改抓同站 GICS 類股分佈。
 *   美股個股：Finnhub profile2 finnhubIndustry → GICS 11 大類中文名。
 *   美股 ETF：MoneyDJ「持股分佈(依產業)」（GICS）。債券 ETF：債券。
 *
 * 投資屬性
 *   個股：本益比／殖利率／股價淨值比（上櫃＝櫃買 openapi；上市＝MoneyDJ 個股
 *         基本資料，數字與證交所公布一致；美股＝Finnhub），門檻見 classifyStockStyle。
 *   ETF：MoneyDJ ETF 基本資料的基金名稱＋追蹤指數，加證交所代號規則
 *         （B 債券、L／R 槓桿反向、U 期貨），見 classifyEtfStyle。
 *
 * 任何一個來源失敗只影響那一部分（回傳 null＋原因），不會整批失敗。
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
  // 診斷用：列出各資料來源從 Vercel 連得到連不到（不含任何使用者資料）。
  if (searchParams.get('probe') === '1') return json(await probeSources(globalThis.fetch));
  const items = (searchParams.get('items') ?? '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
    .map(s => { const [market, ticker] = s.split(':'); return { market, ticker }; })
    .filter(i => ['TW', 'US'].includes(i.market) && /^[A-Z0-9.\-]{1,12}$/.test(i.ticker ?? ''))
    .slice(0, 60);
  if (!items.length) return json({ error: 'Invalid params' }, 400);
  const diag = {};
  const results = await classifyItems(items, { fetch: globalThis.fetch, finnhubKey: process.env.FINNHUB_API_KEY, diag });
  // sources：每個資料來源的狀態與耗時，前端不用，是給除錯看的（不含任何使用者資料）。
  return json({ fetched_at: new Date().toISOString(), results, sources: diag });
}

// v2.7.3：實測（?probe=1）從 Vercel 連證交所的 openapi.twse.com.tw 會逾時、
// www.twse.com.tw 回 403——證交所擋掉雲端主機，所以上市公司的資料改用連得到
// 的來源（數字跟證交所公布的一致，例如台積電本益比 28.98、殖利率 0.88%、
// 淨值比 10.08 兩邊相同）：
//   上櫃：櫃買中心 openapi（公司產業別 mopsfin_t187ap03_O、本益比
//         tpex_mainboard_peratio_analysis）——官方來源，連得到。
//   上市：產業別＝Yahoo 奇摩股市「公司基本資料」的產業類別（同證交所分類）；
//         本益比／殖利率／淨值比＝MoneyDJ 個股基本資料。
//   ETF：MoneyDJ ETF 基本資料的「追蹤指數」＋基金名稱判定屬性、
//         「持股分佈(依產業)」穿透成分股產業。
// 所有來源一開始就並行發出、每個 8 秒逾時，不會因為一個來源慢就整批逾時。
export async function classifyItems(items, { fetch, finnhubKey, diag = {} }) {
  const tw = items.filter(i => i.market === 'TW'), us = items.filter(i => i.market === 'US');
  const twStocks = tw.filter(i => !isTwEtf(i.ticker)), twEtfs = tw.filter(i => isTwEtf(i.ticker));
  const timed = (name, fn) => {
    const t0 = Date.now();
    return fn().then(v => { diag[name] = { ok: v != null, ms: Date.now() - t0 }; return v; },
                     e => { diag[name] = { ok: false, ms: Date.now() - t0, error: String(e?.message ?? e) }; return null; });
  };
  const need = twStocks.length > 0;
  const src = {
    tpexProfile: need ? timed('tpex_profile', () => getJson(fetch, 'https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O')) : null,
    tpexVal: need ? timed('tpex_val', () => getJson(fetch, 'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_peratio_analysis').then(normTpexOpenVal)) : null,
  };
  const out = {};
  await Promise.all([
    ...twStocks.map(async i => { out[`TW:${i.ticker}`] = await classifyTwStock(i.ticker, src, fetch, timed); }),
    ...twEtfs.map(async i => { out[`TW:${i.ticker}`] = await classifyTwEtf(i.ticker, fetch, timed); }),
    ...us.map(async i => { out[`US:${i.ticker}`] = await classifyUs(i.ticker, fetch, finnhubKey, timed); }),
  ]);
  return out;
}

const num = v => { const n = parseFloat(String(v ?? '').replace(/[,%]/g, '')); return Number.isFinite(n) ? n : null; };
function normTpexOpenVal(v) {
  if (!Array.isArray(v)) return null;
  const m = new Map();
  for (const r of v) m.set(String(r.SecuritiesCompanyCode).trim(), { pe: num(r.PriceEarningRatio), yield: num(r.YieldRatio ?? r.DividendYield), pb: num(r.PriceBookRatio) });
  return m.size ? m : null;
}
const strip = s => String(s ?? '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

// MoneyDJ 個股基本資料（zca）：<td class="t4t1">本益比</td><td class="t3n1">29.85</td>
export function parseMoneydjValuation(html) {
  const pick = label => {
    const m = html.match(new RegExp(`>\\s*${label}\\s*</td>\\s*<td[^>]*>([\\s\\S]*?)</td>`));
    return m ? num(strip(m[1])) : null;
  };
  const r = { pe: pick('本益比'), yield: pick('殖利率'), pb: pick('股價淨值比') };
  return r.pe == null && r.yield == null && r.pb == null ? null : r;
}
// Yahoo 奇摩股市公司基本資料：…<span>產業類別</span></span><div …>半導體</div> 或 "ySector":"半導體"
export function parseYahooSector(html) {
  const m = html.match(/產業類別<\/span>\s*<\/span>\s*<div[^>]*>([^<]+)</) ?? html.match(/"ySector"\s*:\s*"([^"]+)"/);
  const name = m ? strip(m[1]).replace(/業$/, '') : '';
  return name || null;
}

// 台股 ETF 代號一律是 00 開頭（0050、006208、00878、00679B…）。
export function isTwEtf(t) { return /^00\d{2,4}[A-Z]?$/.test(t); }

async function classifyTwStock(code, src, fetch, timed) {
  const r = { industry: null, style: null };
  const [op, ov, yhTW, zca] = await Promise.all([
    src.tpexProfile, src.tpexVal,
    timed(`yahoo_${code}`, () => getText(fetch, `https://tw.stock.yahoo.com/quote/${code}.TW/profile`).then(parseYahooSector)),
    timed(`moneydj_${code}`, () => getText(fetch, `https://www.moneydj.com/z/zc/zca/zca_${code}.djhtm`).then(parseMoneydjValuation)),
  ]);
  const o = Array.isArray(op) ? op.find(x => String(x.SecuritiesCompanyCode ?? '').trim() === code) : null;
  let indName = null, indSource = null;
  if (o) { indName = TW_INDUSTRY_CODES[String(o.SecuritiesIndustryCode ?? '').trim().padStart(2, '0')] ?? null; indSource = '櫃買中心產業別'; }
  if (!indName && yhTW) { indName = yhTW; indSource = '產業類別（Yahoo 奇摩股市，同證交所分類）'; }
  if (!indName && !o) {
    const yhTWO = await timed(`yahoo_${code}_two`, () => getText(fetch, `https://tw.stock.yahoo.com/quote/${code}.TWO/profile`).then(parseYahooSector));
    if (yhTWO) { indName = yhTWO; indSource = '產業類別（Yahoo 奇摩股市，同櫃買分類）'; }
  }
  r.industry = indName ? { mix: [{ name: indName, pct: 100 }], source: indSource }
    : { mix: null, reason: '櫃買中心與 Yahoo 奇摩股市都查不到這個代號的產業' };

  const fromO = ov?.get(code);
  const metrics = fromO ?? zca ?? null;
  r.style = metrics
    ? { ...classifyStockStyle(metrics, { market: 'TW', defensive: DEFENSIVE_TW.has(indName) }), metrics,
        source: fromO ? '櫃買中心本益比／殖利率' : '本益比／殖利率（MoneyDJ 個股資料）' }
    : { key: null, reason: '櫃買中心與 MoneyDJ 都查不到這個代號的本益比' };
  return r;
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

// ETF 投資屬性：依基金名稱＋追蹤指數（MoneyDJ ETF 基本資料），加上證交所
// 代號規則（B＝債券、L／R＝槓桿反向、U＝期貨）。依序判斷，第一個符合的就是答案。
export function classifyEtfStyle(code, fundName, indexName) {
  const f = fundName ?? '', n = indexName ?? '', both = `${f} ${n}`;
  const why = () => (n ? `追蹤「${n}」` : f ? `基金名稱「${f}」` : '依證券代號規則');
  if (/[LR]$/.test(code) || /正2|反1|反向|槓桿|2X|3X|Ultra|Leveraged|Inverse|\bShort\b/i.test(both)) return { key: 'leveraged', reason: f ? `基金名稱「${f}」` : '代號 L／R 結尾' };
  if (/U$/.test(code) || /期貨|Futures/i.test(both)) return { key: 'commodity', reason: why() };
  if (/B$/.test(code) || /債|Bond|Treasury|Fixed Income|Aggregate/i.test(both)) return { key: 'bond', reason: why() };
  if (/主動|Active/i.test(f)) return { key: 'active', reason: `基金名稱「${f}」` };
  if (/高股息|高息|股利|收益|Dividend|High Yield|Income/i.test(both)) return { key: 'dividend', reason: why() };
  if (/低波|Min(imum)? Vol|Low Vol/i.test(both)) return { key: 'defensive', reason: why() };
  if (/成長|Growth/i.test(both)) return { key: 'growth', reason: why() };
  if (/價值|Value/i.test(both)) return { key: 'value', reason: why() };
  if (THEME_RE.test(both)) return { key: 'theme', reason: why() };
  if (!f && !n) return { key: null, reason: '查不到這檔 ETF 的基本資料' };
  return { key: 'index', reason: why() };
}
const THEME_RE = /半導體|科技|電子|5G|AI|人工智慧|電動車|生技|醫療|金融|銀行|REIT|不動產|能源|綠能|網路|雲端|資安|機器人|晶片|航運|軍工|國防|元宇宙|遊戲|消費|品牌|Semiconductor|Technology|Tech\b|Health|Financial|Energy|Real Estate|Innovation|Clean/i;

// MoneyDJ ETF 基本資料（Basic0004）：<td>追蹤指數</td><td>MSCI臺灣ESG永續高股息精選30指數</td>
export function parseMoneydjEtfBasic(html) {
  const cell = label => {
    const i = html.indexOf(label);
    if (i < 0) return null;
    const after = html.slice(i + label.length, i + label.length + 1500);
    const m = after.match(/<td[^>]*>([\s\S]*?)<\/td>/i);
    const v = m ? strip(m[1]) : '';
    return v && v !== '--' ? v : null;
  };
  const title = html.match(/<title>([^<]+)<\/title>/i)?.[1] ?? '';
  return { index: cell('追蹤指數') ?? cell('標的指數'), name: cell('基金名稱') ?? (strip(title).replace(/[-－|(（].*$/, '').trim() || null) };
}

async function classifyTwEtf(code, fetch, timed) {
  const r = { industry: null, style: null };
  const basic = await timed(`moneydj_basic_${code}`, () => getText(fetch, `https://www.moneydj.com/ETF/X/Basic/Basic0004.xdjhtm?etfid=${code}.TW`).then(parseMoneydjEtfBasic));
  r.style = { ...classifyEtfStyle(code, basic?.name, basic?.index), source: basic ? 'MoneyDJ ETF 基本資料' : '證券代號規則' };
  if (r.style.key === 'bond') {
    r.industry = { mix: [{ name: '債券', pct: 100 }], source: '債券 ETF' };
    return r;
  }
  r.industry = await etfLookThrough(fetch, `${code}.TW`, timed);
  return r;
}

// MoneyDJ「持股分佈(依產業)」：Basic0007a 是台股成分（證交所產業名稱），
// Basic0007 是海外成分（GICS 類股）。台股 ETF 先試 0007a，結果如果只有地區／
// 存款（海外成分 ETF）再試 0007。存款、現金不算產業，排除後重新換算成 100%。
const NON_INDUSTRY = /附條件|存款|現金|保證金|應收|應付|其他資產|北美|美國|歐洲|日本|亞洲|新興|已開發|全球|中國|香港|區域|附買回|期貨|基金/;
async function etfLookThrough(fetch, etfid, timed = (n, f) => f().catch(() => null)) {
  const pages = etfid.endsWith('.TW') ? ['Basic0007a', 'Basic0007'] : ['Basic0007'];
  for (const p of pages) {
    const html = await timed(`moneydj_${p}_${etfid}`, () => getText(fetch, `https://www.moneydj.com/ETF/X/Basic/${p}.xdjhtm?etfid=${encodeURIComponent(etfid)}`));
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

async function classifyUs(ticker, fetch, key, timed) {
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
  const [ind, basic] = await Promise.all([
    etfLookThrough(fetch, ticker, timed),
    timed(`moneydj_basic_${ticker}`, () => getText(fetch, `https://www.moneydj.com/ETF/X/Basic/Basic0004.xdjhtm?etfid=${encodeURIComponent(ticker)}`).then(parseMoneydjEtfBasic)),
  ]);
  r.industry = ind;
  r.style = { ...classifyEtfStyle(ticker, basic?.name, basic?.index), source: basic ? 'MoneyDJ ETF 基本資料' : '—' };
  return r;
}

async function getJson(fetch, url) {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}
async function getText(fetch, url) {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`${res.status}`);
  const buf = await res.arrayBuffer();
  const cs = (res.headers.get('content-type') ?? '').match(/charset=([\w-]+)/i)?.[1]?.toLowerCase() ?? 'utf-8';
  try { return new TextDecoder(cs).decode(buf); } catch { return new TextDecoder('utf-8').decode(buf); }
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, s-maxage=21600', ...CORS } });
}

const PROBE_URLS = [
  'https://openapi.twse.com.tw/v1/exchangeReport/BWIBBU_ALL',
  'https://openapi.twse.com.tw/v1/opendata/t187ap03_L',
  'https://openapi.twse.com.tw/v1/opendata/t187ap47_L',
  'https://www.twse.com.tw/rwd/zh/afterTrading/BWIBBU_d?response=json&selectType=ALL',
  'https://www.twse.com.tw/exchangeReport/BWIBBU_ALL?response=json',
  'https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O',
  'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_peratio_analysis',
  'https://www.tpex.org.tw/www/zh-tw/afterTrading/peQryDate?response=json',
  'https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=tse_2330.tw',
  'https://www.moneydj.com/z/zc/zca/zca_2330.djhtm',
  'https://tw.stock.yahoo.com/quote/2330.TW',
  'https://www.moneydj.com/ETF/X/Basic/Basic0004.xdjhtm?etfid=0050.TW',
];
async function probeSources(fetch) {
  const out = {};
  await Promise.all(PROBE_URLS.map(async u => {
    const t0 = Date.now();
    try {
      const res = await fetch(u, { headers: UA, signal: AbortSignal.timeout(9000) });
      const text = await res.text();
      out[u] = { status: res.status, ms: Date.now() - t0, bytes: text.length, head: text.slice(0, 80) };
    } catch (e) { out[u] = { error: String(e?.message ?? e), ms: Date.now() - t0 }; }
  }));
  return out;
}
