/**
 * PFCC — Local Database (IndexedDB)
 * All user financial data lives here. Nothing leaves the device.
 * Schema version: 1
 */

const DB_NAME = 'pfcc';
const DB_VERSION = 4;

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

    // Transfer history log
    const logs = db.createObjectStore('transfer_logs', { keyPath: 'id' });
    logs.createIndex('created_at', 'created_at');

    // Income transactions
    const income = db.createObjectStore('income_txns', { keyPath: 'id' });
    income.createIndex('date',     'date');
    income.createIndex('category', 'category');
    income.createIndex('account_id', 'account_id');

    // Asset snapshots for historical tracking
    const snap = db.createObjectStore('asset_snapshots', { keyPath: 'id' });
    snap.createIndex('date', 'date');

    // User-editable transaction categories
    const cats = db.createObjectStore('txn_categories', { keyPath: 'id' });
    cats.createIndex('type',       'type');       // 'income' | 'expense'
    cats.createIndex('sort_order', 'sort_order');
  }

  // Version 2: add transfer_logs if upgrading from v1
  if (oldVersion < 2 && oldVersion >= 1) {
    const logs = db.createObjectStore('transfer_logs', { keyPath: 'id' });
    logs.createIndex('created_at', 'created_at');
  }

  // Version 3: add income_txns + asset_snapshots
  if (oldVersion < 3 && oldVersion >= 2) {
    const income = db.createObjectStore('income_txns', { keyPath: 'id' });
    income.createIndex('date',     'date');
    income.createIndex('category', 'category');
    income.createIndex('account_id', 'account_id');

    const snap = db.createObjectStore('asset_snapshots', { keyPath: 'id' });
    snap.createIndex('date', 'date');
  }

  // Version 4: add txn_categories
  if (oldVersion < 4) {
    const cats = db.createObjectStore('txn_categories', { keyPath: 'id' });
    cats.createIndex('type',       'type');
    cats.createIndex('sort_order', 'sort_order');
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
// 只設定 app 基本設定，不預填任何個人資料
// 每個使用者自己在設定頁面新增銀行、帳戶、持股等資料

export async function seedIfNeeded(db) {
  if (await getSetting(db, 'seeded_v1')) return;
  await setSetting(db, 'seeded_v1', true);
  await setSetting(db, 'base_currency', 'TWD');
}

// Seed default categories — called once when txn_categories is empty
export async function seedCategoriesIfNeeded(db) {
  const existing = await getAll(db, 'txn_categories').catch(()=>[]);
  if (existing.length > 0) return;

  const DEFAULT_INCOME = [
    { id:'cat_salary',      type:'income', label:'薪資 / 獎金',   icon:'💼', color:'#059669', sort_order:1,  is_default:true },
    { id:'cat_div_tw',      type:'income', label:'股利（台股）',   icon:'🏦', color:'#0369A1', sort_order:2,  is_default:true },
    { id:'cat_div_us',      type:'income', label:'股息（美股）',   icon:'🌐', color:'#7C3AED', sort_order:3,  is_default:true },
    { id:'cat_dca',         type:'income', label:'定期定額成交',   icon:'🔄', color:'#D97706', sort_order:4,  is_default:true },
    { id:'cat_fee_rebate',  type:'income', label:'手續費退回',     icon:'↩️', color:'#0891B2', sort_order:5,  is_default:true },
    { id:'cat_receivable',  type:'income', label:'應收款入帳',     icon:'✓',  color:'#16803C', sort_order:6,  is_default:true },
    { id:'cat_interest',    type:'income', label:'利息收入',       icon:'🏧', color:'#475569', sort_order:7,  is_default:true },
    { id:'cat_other_in',    type:'income', label:'其他收入',       icon:'＋', color:'#6B7280', sort_order:8,  is_default:true },
  ];
  await putMany(db, 'txn_categories', DEFAULT_INCOME).catch(()=>{});
}

function ts() { return new Date().toISOString(); }
