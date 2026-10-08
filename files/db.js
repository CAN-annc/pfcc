/**
 * PFCC — Local Database (IndexedDB)
 * All user financial data lives here. Nothing leaves the device.
 * Schema version: 1
 */

const DB_NAME = 'pfcc';
const DB_VERSION = 16;

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

  // Version 16（2026-09-29，追查「電腦版資產趨勢一直無法記錄」第四次回報，
  // 這次使用者的錯誤訊息終於明確指出「NotFoundError: One of the specified
  // object stores was not found」）：真正的原因不是 calc.js 的任何計算，是
  // 這台裝置（電腦版瀏覽器）的 IndexedDB 資料庫裡根本沒有 asset_snapshots
  // 這張表。
  //
  // 根本原因在上面「Version 3」那個區塊的判斷條件：
  // `if (oldVersion < 3 && oldVersion >= 2)`——這個寫法只有在裝置「升級前
  // 剛好停在版本 2」時才會執行。但 IndexedDB 的升級機制是「一次直接跳到
  // 最新版本」，oldVersion 在整個 onupgradeneeded 呼叫期間是固定不變的一個
  // 數字（裝置升級前的版本），不會隨著中間跑過的每個 if 區塊往上遞增。如果
  // 這台裝置最早建立資料庫的當下，程式碼還停留在版本 1（也就是說這是一台
  // 比較早開始使用這個 App 的裝置——這裡合理推測電腦版比手機版更早開始
  // 用），那麼它從版本 1 一路跳到版本 15 的那次升級，oldVersion 從頭到尾
  // 都是 1，「Version 3」那個區塊要求 `oldVersion >= 2`，對這台裝置永遠是
  // false——income_txns、asset_snapshots 這兩張表就這樣被跳過、從來沒有
  // 被建立過。而且因為 IndexedDB 的資料庫版本號本身照樣會往上升級到 15
  // （中間某一個區塊沒有執行，不會讓整個升級失敗或跳出任何錯誤，是完全
  // 靜默的），這台裝置之後每次打開 App，資料庫版本已經是最新的 15，
  // onupgradeneeded 根本不會再被觸發，這兩張表就永遠不會自動補上——直到
  // 現在把 DB_VERSION 再往上跳一碼，才會讓它有機會重新執行一次。
  //
  // 這也完整解釋了所有觀察到的現象：手機版一直正常（大概是比較晚才開始用
  // 這個 App，那時候版本 1 的程式碼其實已經包含 income_txns／
  // asset_snapshots 了，資料庫從一開始就是完整的）；電腦版偏偏只有「資產
  // 趨勢」這個唯一會用到 asset_snapshots 的功能一直失敗、其他功能都正常
  // （因為其他所有資料表都是透過沒有這個漏洞的區塊建立的，只有這一個區塊
  // 用了 `oldVersion >= 2` 這種過窄的判斷式）；卅七、卅八兩批花了很多力氣
  // 防呆的所有計算其實從頭到尾都沒有錯——因為問題根本不是「算出來的數字
  // 不對」，是「連寫進資料庫這一步都做不到，因為資料庫裡根本沒有這張表」。
  //
  // 修正：不再依賴容易算錯的 oldVersion 區間判斷，改成直接檢查「這張表現在
  // 存不存在」——用 IndexedDB 內建的 db.objectStoreNames.contains(...)，不
  // 管這台裝置實際的升級歷史路徑多麼曲折，只要這張表現在真的不存在，就補
  // 建立；已經有這兩張表的裝置（例如手機版）這裡完全不會執行任何動作，不
  // 影響任何現有資料——這也是這個 App 目前唯一已知會被這個漏洞影響的兩張
  // 表，其餘表格的建立條件都是 `oldVersion >= 1`（涵蓋所有非全新裝置）或
  // 完全沒有下限（涵蓋所有裝置），沒有這種「只有停在特定版本才會執行」的
  // 過窄寫法，因此沒有同樣的風險。
  if (!db.objectStoreNames.contains('income_txns')) {
    const income = db.createObjectStore('income_txns', { keyPath: 'id' });
    income.createIndex('date',     'date');
    income.createIndex('category', 'category');
    income.createIndex('account_id', 'account_id');
  }
  if (!db.objectStoreNames.contains('asset_snapshots')) {
    const snap = db.createObjectStore('asset_snapshots', { keyPath: 'id' });
    snap.createIndex('date', 'date');
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
// v2.21.0（使用者決定）：主分類／子分類。parent_id 指向主分類（主分類本身是
// null）；group:'save' 是「存下來的」（投資、儲蓄險——錢沒有花掉，只是換地方
// 放，不算消費）；irregular_default 是預設算「一次性收入」（不進每月計畫基準）。
// 舊版就有的分類沿用原本的 id（舊紀錄不用改），見 index.html migrateCategoryTreeV1。
const _PC = {cat_food:'#EA580C', cat_housing:'#0F766E', cat_transport:'#0369A1', cat_shopping:'#DB2777', cat_daily:'#65A30D', cat_digital:'#4F46E5', cat_entertain:'#D97706', cat_edu:'#7C3AED', cat_medical:'#DC2626', cat_insurance:'#0891B2', cat_social:'#BE185D', cat_tax:'#57534E', cat_other_out:'#6B7280', cat_saving:'#15803D', cat_inc_active:'#059669', cat_inc_invest:'#0369A1', cat_other_in:'#6B7280'};
const _sub = (parent, type, list, startOrder = 1) => list.map(([id, label, icon, extra], i) =>
  ({ id, type, label, icon, color: _PC[parent] || '#6B7280', sort_order: startOrder + i, is_default: true, parent_id: parent, ...(extra || {}) }));
export const DEFAULT_CATEGORIES = [
  // ── 支出：主分類 ──
  { id:'cat_food',       type:'expense', label:'飲食',     icon:'🍽️', color:'#EA580C', sort_order:1,  is_default:true, parent_id:null },
  { id:'cat_housing',    type:'expense', label:'居住',     icon:'🏠', color:'#0F766E', sort_order:2,  is_default:true, parent_id:null },
  { id:'cat_transport',  type:'expense', label:'交通',     icon:'🚌', color:'#0369A1', sort_order:3,  is_default:true, parent_id:null },
  { id:'cat_shopping',   type:'expense', label:'購物',     icon:'🛍️', color:'#DB2777', sort_order:4,  is_default:true, parent_id:null },
  { id:'cat_daily',      type:'expense', label:'生活用品', icon:'🧴', color:'#65A30D', sort_order:5,  is_default:true, parent_id:null },
  { id:'cat_digital',    type:'expense', label:'數位',     icon:'📱', color:'#4F46E5', sort_order:6,  is_default:true, parent_id:null },
  { id:'cat_entertain',  type:'expense', label:'娛樂',     icon:'🎬', color:'#D97706', sort_order:7,  is_default:true, parent_id:null },
  { id:'cat_edu',        type:'expense', label:'教育',     icon:'📚', color:'#7C3AED', sort_order:8,  is_default:true, parent_id:null },
  { id:'cat_medical',    type:'expense', label:'醫療保健', icon:'🏥', color:'#DC2626', sort_order:9,  is_default:true, parent_id:null },
  { id:'cat_insurance',  type:'expense', label:'保險',     icon:'🛡️', color:'#0891B2', sort_order:10, is_default:true, parent_id:null },
  { id:'cat_social',     type:'expense', label:'人情',     icon:'🎁', color:'#BE185D', sort_order:11, is_default:true, parent_id:null },
  { id:'cat_tax',        type:'expense', label:'稅費',     icon:'🧾', color:'#57534E', sort_order:12, is_default:true, parent_id:null },
  { id:'cat_other_out',  type:'expense', label:'其他',     icon:'➖', color:'#6B7280', sort_order:13, is_default:true, parent_id:null },
  { id:'cat_saving',     type:'expense', label:'存下來的', icon:'🏦', color:'#15803D', sort_order:14, is_default:true, parent_id:null, group:'save' },
  // ── 支出：子分類 ──
  ..._sub('cat_food', 'expense', [['cat_food_breakfast','早餐','🥐'],['cat_food_lunch','午餐','🍱'],['cat_food_dinner','晚餐','🍲'],['cat_food_supper','宵夜','🌙'],['cat_food_snack','點心','🍰'],['cat_food_drink','飲料','🧋'],['cat_food_party','聚餐','🍻'],['cat_food_grocery','買菜','🥬']]),
  ..._sub('cat_housing', 'expense', [['cat_house_rent','房租／房貸','🔑'],['cat_bill','水電瓦斯','💡'],['cat_house_mgmt','管理費','🏢'],['cat_house_net','網路','🌐'],['cat_house_repair','修繕','🔧']]),
  ..._sub('cat_transport', 'expense', [['cat_tr_hsr','高鐵','🚄'],['cat_tr_tra','台鐵','🚆'],['cat_tr_mrt','捷運','🚇'],['cat_tr_bus','公車','🚌'],['cat_tr_taxi','計程車','🚕'],['cat_tr_fuel','加油','⛽'],['cat_tr_park','停車','🅿️'],['cat_tr_service','汽機車保養','🛠️']]),
  ..._sub('cat_shopping', 'expense', [['cat_shop_clothes','服飾','👕'],['cat_shop_makeup','化妝品','💄'],['cat_shop_skin','保養品','🧴'],['cat_shop_3c','3C 家電','💻']]),
  ..._sub('cat_daily', 'expense', [['cat_daily_clean','清潔用品','🧽'],['cat_daily_hygiene','衛生用品','🧻']]),
  ..._sub('cat_digital', 'expense', [['cat_dig_phone','電信費','📶'],['cat_dig_app','App 訂閱','📲'],['cat_dig_stream','影音串流','📺']]),
  ..._sub('cat_entertain', 'expense', [['cat_ent_movie','電影','🎞️'],['cat_ent_ktv','唱歌','🎤'],['cat_ent_travel','旅遊','✈️'],['cat_ent_hobby','興趣','🎨']]),
  ..._sub('cat_edu', 'expense', [['cat_edu_course','課程','🎓'],['cat_edu_book','書籍','📖'],['cat_edu_gym','健身','🏋️']]),
  ..._sub('cat_medical', 'expense', [['cat_med_clinic','看診','🩺'],['cat_med_drug','藥品','💊'],['cat_med_supp','保健食品','🫙']]),
  ..._sub('cat_insurance', 'expense', [['cat_ins_health','健康險','❤️'],['cat_ins_accident','意外險','🩹'],['cat_ins_vehicle','汽機車險','🚗']]),
  ..._sub('cat_social', 'expense', [['cat_soc_envelope','紅白包','🧧'],['cat_soc_gift','禮物','🎁']]),
  ..._sub('cat_tax', 'expense', [['cat_tax_income','所得稅','🧾'],['cat_tax_license','牌照稅','🚘'],['cat_tax_fuel','燃料稅','⛽'],['cat_tax_land','地價稅','🗺️'],['cat_tax_house','房屋稅','🏠']]),
  ..._sub('cat_other_out', 'expense', [['cat_bad_debt_writeoff','呆帳沖銷','🗑️']]),
  ..._sub('cat_saving', 'expense', [['cat_invest_out','投資','📈',{ group:'save' }],['cat_savings_ins','儲蓄險','🏦',{ group:'save' }]]),
  // ── 收入 ──
  { id:'cat_inc_active', type:'income', label:'主動收入',   icon:'💼', color:'#059669', sort_order:1, is_default:true, parent_id:null },
  { id:'cat_inc_invest', type:'income', label:'投資與被動', icon:'📈', color:'#0369A1', sort_order:2, is_default:true, parent_id:null },
  { id:'cat_other_in',   type:'income', label:'其他',       icon:'＋', color:'#6B7280', sort_order:3, is_default:true, parent_id:null },
  ..._sub('cat_inc_active', 'income', [['cat_salary','薪資','💼'],['cat_bonus','獎金','🎉',{ irregular_default:true }],['cat_inc_freelance','兼職接案','🧑‍💻'],['cat_inc_commission','佣金','🤝']]),
  ..._sub('cat_inc_invest', 'income', [['cat_interest','利息','🏧'],['cat_div_tw','股利（台股）','🏦'],['cat_div_us','股息（美股）','🌐'],['cat_inc_rent','租金','🏘️',{ passive:true }],['cat_realized','已實現損益','💹',{ irregular_default:true }],['cat_dca','定期定額成交','🔄']]),
  ..._sub('cat_other_in', 'income', [['cat_inc_refund','退稅補助','🏛️',{ irregular_default:true }],['cat_inc_gift','紅包贈與','🧧',{ irregular_default:true }],['cat_inc_secondhand','二手變賣','♻️',{ irregular_default:true }],['cat_inc_lottery','發票中獎','🎫',{ irregular_default:true }],['cat_fee_rebate','手續費退回','↩️'],['cat_receivable','應收款入帳','✓']]),
];
// 舊版預設分類的名稱——使用者沒改過名才換成新名稱（改過的保留）。
export const LEGACY_CATEGORY_LABELS = {
  cat_food:'餐飲', cat_medical:'醫療', cat_bill:'帳單 / 水電', cat_other_out:'其他支出',
  cat_salary:'薪資 / 獎金', cat_interest:'利息收入', cat_other_in:'其他收入', cat_realized:'投資已實現損益',
};

// Seed default categories — called once when txn_categories is empty
export async function seedCategoriesIfNeeded(db) {
  const existing = await getAll(db, 'txn_categories').catch(()=>[]);
  if (existing.length > 0) return;
  await putMany(db, 'txn_categories', DEFAULT_CATEGORIES).catch(()=>{});
}

function ts() { return new Date().toISOString(); }
