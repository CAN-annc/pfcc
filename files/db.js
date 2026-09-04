/**
 * PFCC — Local Database (IndexedDB)
 * All user financial data lives here. Nothing leaves the device.
 * Schema version: 1
 */

const DB_NAME = 'pfcc';
const DB_VERSION = 1;

export function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => createSchema(e.target.result, e.oldVersion);
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror   = (e) => reject(e.target.error);
  });
}

function createSchema(db, oldVersion) {
  if (oldVersion < 1) {
    const banks = db.createObjectStore('banks', { keyPath: 'id' });
    banks.createIndex('sort_order', 'sort_order');

    const accounts = db.createObjectStore('accounts', { keyPath: 'id' });
    accounts.createIndex('bank_id',      'bank_id');
    accounts.createIndex('currency',     'currency');
    accounts.createIndex('account_type', 'account_type');

    const deposits = db.createObjectStore('time_deposits', { keyPath: 'id' });
    deposits.createIndex('bank_id',       'bank_id');
    deposits.createIndex('maturity_date', 'maturity_date');
    deposits.createIndex('status',        'status');

    const brokerages = db.createObjectStore('brokerages', { keyPath: 'id' });
    brokerages.createIndex('bank_id', 'bank_id');
    brokerages.createIndex('market',  'market');

    const holdings = db.createObjectStore('holdings', { keyPath: 'id' });
    holdings.createIndex('brokerage_id', 'brokerage_id');
    holdings.createIndex('ticker',       'ticker');
    holdings.createIndex('market',       'market');

    // Last Known Price — survives offline / API outages
    const prices = db.createObjectStore('market_prices', { keyPath: 'ticker' });
    prices.createIndex('fetched_at', 'fetched_at');
    prices.createIndex('market',     'market');

    db.createObjectStore('gold_holdings', { keyPath: 'id' });

    const recv = db.createObjectStore('receivables', { keyPath: 'id' });
    recv.createIndex('is_settled', 'is_settled');

    // pair key: 'USD_TWD', 'JPY_TWD'
    const fx = db.createObjectStore('fx_rates', { keyPath: 'pair' });
    fx.createIndex('fetched_at', 'fetched_at');

    db.createObjectStore('settings', { keyPath: 'key' });
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function idbReq(r) {
  return new Promise((res, rej) => {
    r.onsuccess = (e) => res(e.target.result);
    r.onerror   = (e) => rej(e.target.error);
  });
}

function txDone(t) {
  return new Promise((res, rej) => {
    t.oncomplete = res;
    t.onerror    = () => rej(t.error);
    t.onabort    = () => rej(t.error);
  });
}

export async function getAll(db, store) {
  const t = db.transaction([store], 'readonly');
  return idbReq(t.objectStore(store).getAll());
}

export async function getByIndex(db, store, index, value) {
  const t = db.transaction([store], 'readonly');
  return idbReq(t.objectStore(store).index(index).getAll(value));
}

export async function getOne(db, store, key) {
  const t = db.transaction([store], 'readonly');
  return idbReq(t.objectStore(store).get(key));
}

export async function putOne(db, store, record) {
  const t = db.transaction([store], 'readwrite');
  idbReq(t.objectStore(store).put(record));
  return txDone(t);
}

export async function putMany(db, store, records) {
  const t = db.transaction([store], 'readwrite');
  const s = t.objectStore(store);
  records.forEach(r => s.put(r));
  return txDone(t);
}

export async function getSetting(db, key, def = null) {
  const r = await getOne(db, 'settings', key);
  return r ? r.value : def;
}

export async function setSetting(db, key, value) {
  return putOne(db, 'settings', { key, value });
}

// ─── Seed ─────────────────────────────────────────────────────────────────────

export async function seedIfNeeded(db) {
  if (await getSetting(db, 'seeded_v1')) return;

  await putMany(db, 'banks', [
    { id: 'bank_first',   name: '第一銀行', short: 'First',   color: '#16803C', sort_order: 1 },
    { id: 'bank_ctbc',    name: '中國信託', short: 'CTBC',    color: '#DC2626', sort_order: 2 },
    { id: 'bank_taishin', name: '台新銀行', short: 'Taishin', color: '#DB2777', sort_order: 3 },
    { id: 'bank_cathay',  name: '國泰世華', short: 'Cathay',  color: '#B45309', sort_order: 4 },
    { id: 'bank_esun',    name: '玉山銀行', short: 'E.Sun',   color: '#0369A1', sort_order: 5 },
  ]);

  await putMany(db, 'accounts', [
    { id: 'acc_wallet',            bank_id: null,           name: '錢包現金',       account_type: 'cash',     currency: 'TWD', balance: 6000,    updated_at: ts() },
    { id: 'acc_first_twd',         bank_id: 'bank_first',   name: '台幣活存',       account_type: 'checking', currency: 'TWD', balance: 30094,   updated_at: ts() },
    { id: 'acc_ctbc_twd_main',     bank_id: 'bank_ctbc',    name: '台幣主帳戶',     account_type: 'checking', currency: 'TWD', balance: 23787,   updated_at: ts() },
    { id: 'acc_ctbc_twd_sub',      bank_id: 'bank_ctbc',    name: '台幣子帳戶',     account_type: 'savings',  currency: 'TWD', balance: 304,     updated_at: ts() },
    { id: 'acc_ctbc_usd_inv',      bank_id: 'bank_ctbc',    name: 'USD 外幣活存',   account_type: 'foreign',  currency: 'USD', balance: 2713.18, updated_at: ts() },
    { id: 'acc_ctbc_usd_settle',   bank_id: 'bank_ctbc',    name: 'USD 交割戶',     account_type: 'foreign',  currency: 'USD', balance: 124.56,  updated_at: ts() },
    { id: 'acc_ctbc_jpy',          bank_id: 'bank_ctbc',    name: 'JPY 外幣活存',   account_type: 'foreign',  currency: 'JPY', balance: 854,     updated_at: ts() },
    { id: 'acc_taishin_twd',       bank_id: 'bank_taishin', name: '台幣活存',       account_type: 'checking', currency: 'TWD', balance: 21939,   updated_at: ts() },
    { id: 'acc_taishin_twd_settle',bank_id: 'bank_taishin', name: '台幣交割戶',     account_type: 'checking', currency: 'TWD', balance: 569,     updated_at: ts() },
    { id: 'acc_taishin_usd',       bank_id: 'bank_taishin', name: 'USD 外幣活存',   account_type: 'foreign',  currency: 'USD', balance: 187.8,   updated_at: ts() },
    { id: 'acc_taishin_jpy',       bank_id: 'bank_taishin', name: 'JPY 外幣活存',   account_type: 'foreign',  currency: 'JPY', balance: 11225,   updated_at: ts() },
    { id: 'acc_cathay_twd',        bank_id: 'bank_cathay',  name: '台幣活存',       account_type: 'checking', currency: 'TWD', balance: 25690,   updated_at: ts() },
    { id: 'acc_cathay_jpy',        bank_id: 'bank_cathay',  name: 'JPY 外幣活存',   account_type: 'foreign',  currency: 'JPY', balance: 2463,    updated_at: ts() },
  ]);

  await putMany(db, 'time_deposits', [
    { id: 'dep_taishin_usd', bank_id: 'bank_taishin', label: 'USD 定存', currency: 'USD',
      principal: 504.15, interest_rate: null, start_date: null,
      maturity_date: '2026-09-15', maturity_account_id: 'acc_taishin_usd',
      status: 'active', note: '' },
  ]);

  await putMany(db, 'brokerages', [
    { id: 'brok_taishin_tw', bank_id: 'bank_taishin', name: '台新證券', market: 'TW', sort_order: 1 },
    { id: 'brok_taishin_us', bank_id: 'bank_taishin', name: '台新證券', market: 'US', sort_order: 2 },
    { id: 'brok_cathay_tw',  bank_id: 'bank_cathay',  name: '國泰證券', market: 'TW', sort_order: 3 },
    { id: 'brok_cathay_us',  bank_id: 'bank_cathay',  name: '國泰證券', market: 'US', sort_order: 4 },
    { id: 'brok_ctbc_tw',    bank_id: 'bank_ctbc',    name: '中信證券', market: 'TW', sort_order: 5 },
    { id: 'brok_ctbc_us',    bank_id: 'bank_ctbc',    name: '中信證券', market: 'US', sort_order: 6 },
  ]);

  await putMany(db, 'holdings', [
    { id:'h_ts_0050',   brokerage_id:'brok_taishin_tw', ticker:'0050',   name:'元大台灣50',        market:'TW', asset_type:'etf',   currency:'TWD', shares:1710,   manual_price:null },
    { id:'h_ts_006208', brokerage_id:'brok_taishin_tw', ticker:'006208', name:'富邦台50',           market:'TW', asset_type:'etf',   currency:'TWD', shares:358,    manual_price:null },
    { id:'h_ts_00770',  brokerage_id:'brok_taishin_tw', ticker:'00770',  name:'國泰全球品牌50',    market:'TW', asset_type:'etf',   currency:'TWD', shares:1430,   manual_price:null },
    { id:'h_ts_1101',   brokerage_id:'brok_taishin_tw', ticker:'1101',   name:'台泥',              market:'TW', asset_type:'stock', currency:'TWD', shares:1000,   manual_price:null },
    { id:'h_ts_2330',   brokerage_id:'brok_taishin_tw', ticker:'2330',   name:'台積電',            market:'TW', asset_type:'stock', currency:'TWD', shares:40,     manual_price:null },
    { id:'h_ts_2382',   brokerage_id:'brok_taishin_tw', ticker:'2382',   name:'廣達',              market:'TW', asset_type:'stock', currency:'TWD', shares:350,    manual_price:null },
    { id:'h_ts_2882',   brokerage_id:'brok_taishin_tw', ticker:'2882',   name:'國泰金',            market:'TW', asset_type:'stock', currency:'TWD', shares:350,    manual_price:null },
    { id:'h_ts_3693',   brokerage_id:'brok_taishin_tw', ticker:'3693',   name:'營邦',              market:'TW', asset_type:'stock', currency:'TWD', shares:159,    manual_price:null },
    { id:'h_ts_6127',   brokerage_id:'brok_taishin_tw', ticker:'6127',   name:'九豪',              market:'TW', asset_type:'stock', currency:'TWD', shares:593,    manual_price:null },
    { id:'h_ts_6584',   brokerage_id:'brok_taishin_tw', ticker:'6584',   name:'南俊國際',          market:'TW', asset_type:'stock', currency:'TWD', shares:60,     manual_price:null },
    { id:'h_ts_goog',   brokerage_id:'brok_taishin_us', ticker:'GOOG',   name:'Alphabet',          market:'US', asset_type:'stock', currency:'USD', shares:0.5719, manual_price:null },
    { id:'h_ts_nvda',   brokerage_id:'brok_taishin_us', ticker:'NVDA',   name:'NVIDIA',            market:'US', asset_type:'stock', currency:'USD', shares:3.3491, manual_price:null },
    { id:'h_ts_qqq',    brokerage_id:'brok_taishin_us', ticker:'QQQ',    name:'Invesco QQQ',       market:'US', asset_type:'etf',   currency:'USD', shares:0.5507, manual_price:null },
    { id:'h_ts_qqqm',   brokerage_id:'brok_taishin_us', ticker:'QQQM',   name:'Invesco QQQM',      market:'US', asset_type:'etf',   currency:'USD', shares:0.6772, manual_price:null },
    { id:'h_ts_spcx',   brokerage_id:'brok_taishin_us', ticker:'SPCX',   name:'SPCX',              market:'US', asset_type:'etf',   currency:'USD', shares:2,      manual_price:null },
    { id:'h_ts_voo',    brokerage_id:'brok_taishin_us', ticker:'VOO',    name:'Vanguard S&P 500',  market:'US', asset_type:'etf',   currency:'USD', shares:0.5755, manual_price:null },
    { id:'h_ct_0050',   brokerage_id:'brok_cathay_tw',  ticker:'0050',   name:'元大台灣50',        market:'TW', asset_type:'etf',   currency:'TWD', shares:10,     manual_price:null },
    { id:'h_ct_voo',    brokerage_id:'brok_cathay_us',  ticker:'VOO',    name:'Vanguard S&P 500',  market:'US', asset_type:'etf',   currency:'USD', shares:0.9945, manual_price:null },
    { id:'h_cb_6584',   brokerage_id:'brok_ctbc_tw',    ticker:'6584',   name:'南俊國際',          market:'TW', asset_type:'stock', currency:'TWD', shares:30,     manual_price:null },
    { id:'h_cb_tsm',    brokerage_id:'brok_ctbc_us',    ticker:'TSM',    name:'TSMC ADR',          market:'US', asset_type:'stock', currency:'USD', shares:4,      manual_price:null },
    { id:'h_cb_dell',   brokerage_id:'brok_ctbc_us',    ticker:'DELL',   name:'Dell Technologies', market:'US', asset_type:'stock', currency:'USD', shares:5,      manual_price:null },
    { id:'h_cb_now',    brokerage_id:'brok_ctbc_us',    ticker:'NOW',    name:'ServiceNow',        market:'US', asset_type:'stock', currency:'USD', shares:22,     manual_price:null },
    { id:'h_cb_tsla',   brokerage_id:'brok_ctbc_us',    ticker:'TSLA',   name:'Tesla',             market:'US', asset_type:'stock', currency:'USD', shares:5,      manual_price:null },
  ]);

  await putMany(db, 'receivables', [
    { id:'recv_po', name:'PO 欠款', total_amount:58100,  received_amount:0, currency:'TWD', note:'預計匯入第一銀行', is_settled:false, created_at:ts() },
    { id:'recv_yu', name:'YU 欠款', total_amount:79636,  received_amount:0, currency:'TWD', note:'預計匯入第一銀行', is_settled:false, created_at:ts() },
  ]);

  await setSetting(db, 'seeded_v1', true);
  await setSetting(db, 'base_currency', 'TWD');
}

function ts() { return new Date().toISOString(); }
