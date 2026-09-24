/**
 * PFCC — Local Database (IndexedDB)
 * All user financial data lives here. Nothing leaves the device.
 * Schema version: 1
 */

const DB_NAME = 'pfcc';
const DB_VERSION = 15;

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

    // 實體黃金（金條/金飾/黃金存摺等）——這個 store 從 schema 版本 1 就存在，
    // 但一直沒有對應的畫面/計算邏輯，等於是空殼欄位。2026-09-24（使用者要求
    // 「還有購買實體黃金，需要知道今天的金價，加上購買成本計算盈虧」）才正式
    // 補上：每筆記錄 {id, name, weight, unit('tael'|'gram'|'oz'), cost_total
    // (選填，購入總成本 TWD), purchase_date, note, updated_at}——沒有新增索引，
    // 因為這通常只是少數幾筆個人黃金持有，用不到查詢索引，跟 other_assets
    // （其他資產）需要依 type 分組不同。價格來自新的 /api/gold 代理（見
    // market.js 的 refreshGoldPrice()），一樣存進既有的 market_prices（Last
    // Known Price）架構，ticker 固定用 'XAU_USD'，不需要另外開表。
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

  // Version 13: recurring_transfers (定期轉帳／定期換匯) + dca_schedules
  // (定期定額股票排程) — see roadmap §十五. Both surfaced from a 2026-09-19
  // audit against the user's own account-holdings notes: recurring internal
  // moves between the user's own accounts (e.g. "每月13日從台幣活存換匯200
  // 美金") and recurring scheduled stock purchases (e.g. "0050：每月5號／22
  // 號各扣5000元") were both real recurring commitments with no data model
  // anywhere in the app — neither recurring_expenses (money leaving to a
  // third party) nor DCA's existing income-modal entry (records a purchase
  // AFTER it happens, no schedule/reminder) fit either case. Both new
  // stores follow recurring_expenses' reference-list shape (schema-less,
  // no dedicated indexes beyond the FK lookups below) and feed the new full
  // calendar page (§十五) the same way recurring_expenses/installments/
  // credit_cards/time_deposits already do via calcMonthCalendarItems.
  if (oldVersion < 13) {
    const recTransfer = db.createObjectStore('recurring_transfers', { keyPath: 'id' });
    recTransfer.createIndex('from_account_id', 'from_account_id');
    recTransfer.createIndex('to_account_id', 'to_account_id');

    const dcaSchedules = db.createObjectStore('dca_schedules', { keyPath: 'id' });
    dcaSchedules.createIndex('holding_id', 'holding_id');
  }

  // Version 14: receivable_payments (應收款流水帳) — see roadmap §十五之六.
  // 應收款一直只存一個 received_amount 累計數字，使用者若分好幾次收到款項
  // （例如先收 300、再收 5000⋯），完全看不出中間過程。這個新表是一個「附加式
  // 稽核紀錄」——received_amount 仍然是唯一權威的即時餘額（calcReceivables()
  // 等所有既有讀取路徑都不用改），這個表只負責記錄每一筆變動是「什麼時候、
  // 收了多少」，供畫面上展開查看用。三個既有的寫入點（openIncomeModal 結清、
  // renderTransfer 應收款入帳、recvModalSave 手動補登）都會在更新
  // received_amount 的同時，呼叫 addReceivablePayment() 補一筆流水帳。
  if (oldVersion < 14) {
    const recvPay = db.createObjectStore('receivable_payments', { keyPath: 'id' });
    recvPay.createIndex('receivable_id', 'receivable_id');
    recvPay.createIndex('date', 'date');
  }

  // Version 15: other_assets（其他資產——儲蓄型保單價值、不動產市價）。
  // 2026-09-24 使用者要求：只有「有累積現金價值」的保單（儲蓄險／還本型／
  // 投資型保單／終身壽險）才算資產，消費型保險（定期壽險、意外險、醫療險）
  // 沒有價值可以拿回來，不算——所以這裡刻意不是「保險」分類，而是使用者自
  // 己認定「這筆有價值」才手動新增一筆。跟不動產一樣，兩者都沒有即時市價可
  // 以自動抓，只能使用者自己定期查保單價值準備金／實價登錄，手動輸入、更新
  // 數字——`current_value` 沒有「本金＋利率」這種公式可以推算，每次異動都是
  // 使用者直接覆寫這個數字，`updated_at` 用來在畫面上提示「上次更新是多久以
  // 前」，提醒使用者定期回來更新，行為類似定存但沒有到期日、沒有計息公式。
  if (oldVersion < 15) {
    const other = db.createObjectStore('other_assets', { keyPath: 'id' });
    other.createIndex('type', 'type'); // 'insurance' | 'realestate'
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
  // 應收款「不再追討」時自動沖銷用——見 index.html 的 ensureBadDebtCategory()，
  // 該函式會在既有使用者（categories 表已經 seed 過、不會再跑
  // seedCategoriesIfNeeded）身上以相同 id 補建這筆分類。
  { id:'cat_bad_debt_writeoff', type:'expense', label:'呆帳沖銷', icon:'🗑️', color:'#991B1B', sort_order:9, is_default:true },
];

// Seed default categories — called once when txn_categories is empty
export async function seedCategoriesIfNeeded(db) {
  const existing = await getAll(db, 'txn_categories').catch(()=>[]);
  if (existing.length > 0) return;
  await putMany(db, 'txn_categories', DEFAULT_CATEGORIES).catch(()=>{});
}

function ts() { return new Date().toISOString(); }
