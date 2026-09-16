/**
 * PFCC — Local Database (IndexedDB)
 * All user financial data lives here. Nothing leaves the device.
 * Schema version: 1
 */

const DB_NAME = 'pfcc';
const DB_VERSION = 10;

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

    // Expense transactions
    const expense = db.createObjectStore('expense_txns', { keyPath: 'id' });
    expense.createIndex('date',       'date');
    expense.createIndex('category',   'category');
    expense.createIndex('account_id', 'account_id');

    // Credit cards
    db.createObjectStore('credit_cards', { keyPath: 'id' });

    // Recurring expenses
    db.createObjectStore('recurring_expenses', { keyPath: 'id' });
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
  // (Guarded to oldVersion >= 1 — see fix note below. A brand-new database,
  // e.g. a private/incognito window or first-ever visit, starts at
  // oldVersion 0 and runs the "oldVersion < 1" block above, which already
  // creates 'txn_categories', 'expense_txns', 'credit_cards' and
  // 'recurring_expenses'. Without this guard, blocks 4-7 tried to create
  // those same four stores again in the same versionchange transaction.
  // IndexedDB throws "An object store with the specified name already
  // exists", which aborts the whole upgrade — exactly the "Version change
  // transaction was aborted in upgradeneeded event handler" error some
  // users hit. The guard is simply "don't run for a fresh oldVersion===0
  // database" — it does NOT restrict these blocks to a narrow version
  // window, so they still correctly fire for any real upgrade path
  // (oldVersion 1 through 9), including one that jumps several versions
  // at once. Fixed 2026-09-16.)
  if (oldVersion < 4 && oldVersion >= 1) {
    const cats = db.createObjectStore('txn_categories', { keyPath: 'id' });
    cats.createIndex('type',       'type');
    cats.createIndex('sort_order', 'sort_order');
  }

  // Version 5: add expense_txns
  if (oldVersion < 5 && oldVersion >= 1) {
    const expense = db.createObjectStore('expense_txns', { keyPath: 'id' });
    expense.createIndex('date',       'date');
    expense.createIndex('category',   'category');
    expense.createIndex('account_id', 'account_id');
  }

  // Version 6: add credit_cards
  if (oldVersion < 6 && oldVersion >= 1) {
    db.createObjectStore('credit_cards', { keyPath: 'id' });
  }

  // Version 7: add recurring_expenses
  if (oldVersion < 7 && oldVersion >= 1) {
    db.createObjectStore('recurring_expenses', { keyPath: 'id' });
  }

  // Version 8: add installments
  if (oldVersion < 8) {
    db.createObjectStore('installments', { keyPath: 'id' });
  }

  // Version 9: add savings_goals
  if (oldVersion < 9) {
    db.createObjectStore('savings_goals', { keyPath: 'id' });
  }

  // Version 10: add balance_adjustments — audit trail for manual "更新餘額"
  // edits (interim step toward a full Reconciliation Adjustment transaction
  // type; see improvement roadmap).
  if (oldVersion < 10) {
    const adj = db.createObjectStore('balance_adjustments', { keyPath: 'id' });
    adj.createIndex('account_id', 'account_id');
    adj.createIndex('created_at', 'created_at');
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

// ─── Default transaction categories ────────────────────────────────────────
// Single source of truth. This used to be duplicated inline in index.html
// (with a different, more complete expense list) while this export sat
// unused — the two had drifted apart. Consolidated here 2026-09-16;
// index.html now imports this instead of keeping its own copy.
export const DEFAULT_CATEGORIES = [
  { id:'cat_salary',     type:'income',  label:'薪資 / 獎金',  icon:'💼', color:'#059669', sort_order:1, is_default:true },
  { id:'cat_div_tw',     type:'income',  label:'股利（台股）', icon:'🏦', color:'#0369A1', sort_order:2, is_default:true },
  { id:'cat_div_us',     type:'income',  label:'股息（美股）', icon:'🌐', color:'#7C3AED', sort_order:3, is_default:true },
  { id:'cat_dca',        type:'income',  label:'定期定額成交', icon:'🔄', color:'#D97706', sort_order:4, is_default:true },
  { id:'cat_fee_rebate', type:'income',  label:'手續費退回',   icon:'↩️', color:'#0891B2', sort_order:5, is_default:true },
  { id:'cat_receivable', type:'income',  label:'應收款入帳',   icon:'✓',  color:'#16803C', sort_order:6, is_default:true },
  { id:'cat_interest',   type:'income',  label:'利息收入',     icon:'🏧', color:'#475569', sort_order:7, is_default:true },
  { id:'cat_other_in',   type:'income',  label:'其他收入',     icon:'＋', color:'#6B7280', sort_order:8, is_default:true },
  { id:'cat_food',       type:'expense', label:'餐飲',         icon:'🍽️', color:'#EA580C', sort_order:1, is_default:true },
  { id:'cat_transport',  type:'expense', label:'交通',         icon:'🚌', color:'#0369A1', sort_order:2, is_default:true },
  { id:'cat_shopping',   type:'expense', label:'購物',         icon:'🛍️', color:'#DB2777', sort_order:3, is_default:true },
  { id:'cat_bill',       type:'expense', label:'帳單 / 水電',  icon:'📄', color:'#475569', sort_order:4, is_default:true },
  { id:'cat_invest_out', type:'expense', label:'投資',         icon:'📈', color:'#7C3AED', sort_order:5, is_default:true },
  { id:'cat_medical',    type:'expense', label:'醫療',         icon:'🏥', color:'#DC2626', sort_order:6, is_default:true },
  { id:'cat_entertain',  type:'expense', label:'娛樂',         icon:'🎬', color:'#D97706', sort_order:7, is_default:true },
  { id:'cat_other_out',  type:'expense', label:'其他支出',     icon:'➖', color:'#6B7280', sort_order:8, is_default:true },
];

// Seed default categories — called once when txn_categories is empty
export async function seedCategoriesIfNeeded(db) {
  const existing = await getAll(db, 'txn_categories').catch(()=>[]);
  if (existing.length > 0) return;
  await putMany(db, 'txn_categories', DEFAULT_CATEGORIES).catch(()=>{});
}

function ts() { return new Date().toISOString(); }
