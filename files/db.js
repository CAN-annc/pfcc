/**
 * PFCC — Local Database (IndexedDB)
 * All user financial data lives here. Nothing leaves the device.
 * Schema version: 1
 */

const DB_NAME = 'pfcc';
const DB_VERSION = 12;

export function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    // e.target.transaction is passed through so version 12+ blocks can add
    // an index to an EXISTING store (expense_txns) — that needs a
    // reference to the live versionchange transaction, not a fresh
    // db.transaction() call, which IndexedDB refuses while an upgrade is
    // already in progress.
    req.onupgradeneeded = (e) => createSchema(e.target.result, e.oldVersion, e.target.transaction);
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror   = (e) => reject(e.target.error);
  });
}

function createSchema(db, oldVersion, tx) {
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

  // Version 11: add recurring_income + budgets — supports the new
  // onboarding wizard (固定收入 / 本月預算 steps), see roadmap doc.
  // recurring_income: reference-only list of recurring income sources
  // (salary, side income…). Mirrors recurring_expenses' role — it does NOT
  // auto-post to income_txns, same as recurring_expenses doesn't auto-post
  // to expense_txns; it's just a reference for reminders and future
  // "investable amount" calculations.
  // budgets: effective-dated setting, not one row per month. A row means
  // "starting this month, the budget is X"; the budget for any given month
  // is whichever row has the latest effective_month <= that month. This
  // lets a later month silently inherit the last value that was set,
  // while past months keep showing what was actually in effect then, even
  // after a later change. category_id is null for the total budget set by
  // the onboarding wizard; per-category budgets (a separate, larger
  // feature, not yet built) will use the same store and the same
  // lookup rule.
  if (oldVersion < 11) {
    const recInc = db.createObjectStore('recurring_income', { keyPath: 'id' });
    recInc.createIndex('account_id', 'account_id');

    const budgets = db.createObjectStore('budgets', { keyPath: 'id' });
    budgets.createIndex('category_id', 'category_id');
    budgets.createIndex('effective_month', 'effective_month');
  }

  // Version 12: Bucket／Project (資金池／專案), Phase 3 of the roadmap.
  // `savings_goals` (v9) is NOT deleted here — its records are migrated to
  // `buckets` by a plain JS routine at app startup (index.html,
  // migrateSavingsGoalsToBuckets), not inside this versionchange
  // transaction. Doing the copy with ordinary getAll/putOne after the
  // upgrade finishes is far simpler and safer than driving an async cursor
  // loop from inside onupgradeneeded, and the old store is harmless to
  // leave in place — nothing reads from it anymore once migrated.
  //
  // Design (see roadmap doc §Bucket/Project design discussion): a Bucket
  // is a purely VIRTUAL planning layer, not a real sub-account —
  // allocating money into one (bucket_allocations) does NOT touch any
  // account balance and is NOT part of net worth, because the money never
  // actually moved. The only real money movement is spending: an
  // expense_txns record tagged with bucket_id/project_id is an ordinary
  // real expense (already deducts from a real account/credit card via the
  // existing expense flow) that also counts against that bucket's
  // allocated total. A Project has no budget of its own — what it "can"
  // spend is whatever its parent Bucket currently has left
  // (allocated − spent across the whole bucket), by design.
  if (oldVersion < 12) {
    const buckets = db.createObjectStore('buckets', { keyPath: 'id' });
    buckets.createIndex('status', 'status');

    // Ledger of virtual "I'm earmarking this much for X" entries. No
    // account_id — allocations are intentionally not tied to any real
    // account.
    const alloc = db.createObjectStore('bucket_allocations', { keyPath: 'id' });
    alloc.createIndex('bucket_id', 'bucket_id');
    alloc.createIndex('date', 'date');

    const projects = db.createObjectStore('projects', { keyPath: 'id' });
    projects.createIndex('bucket_id', 'bucket_id');
    projects.createIndex('status', 'status');

    // expense_txns already exists (created in the oldVersion<1 block) —
    // add two new optional indexes to it via the live upgrade transaction
    // rather than db.createObjectStore. Existing rows simply don't have
    // these fields yet and are excluded from the index until edited,
    // which IndexedDB handles fine.
    const expenseStore = tx.objectStore('expense_txns');
    if (!expenseStore.indexNames.contains('bucket_id'))  expenseStore.createIndex('bucket_id', 'bucket_id');
    if (!expenseStore.indexNames.contains('project_id')) expenseStore.createIndex('project_id', 'project_id');
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
