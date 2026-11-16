/**
 * PFCC 範例資料（v2.30.0，只在預覽版、而且資料庫是空的時候自動載入）。
 * 全部是編的數字，結構接近實際使用的情況：兩家銀行、兩張信用卡（自動扣繳）、
 * 台股與美股、定期定額、定存、階段目標、應付款、近三個月的收支。
 */
const pad = n => String(n).padStart(2, '0');
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

export function buildSampleData(today = new Date()) {
  const now = new Date().toISOString();
  const T = iso(today);
  const ymOf = (back) => { const d = new Date(today.getFullYear(), today.getMonth() - back, 1); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; };
  const day = (ym, d) => `${ym}-${pad(d)}`;

  const banks = [
    { id: 'sb_a', name: '星海銀行', sort_order: 1 },
    { id: 'sb_b', name: '山嵐銀行', sort_order: 2 },
  ];
  const accounts = [
    { id: 'sa_salary', bank_id: 'sb_a', name: '薪轉活存', currency: 'TWD', balance: 86420, role: 'income', include_in_total: true, show_in_menu: true, created_at: now },
    { id: 'sa_ef', bank_id: 'sb_b', name: '預備金活存', currency: 'TWD', balance: 92000, include_in_total: true, show_in_menu: true, created_at: now },
    { id: 'sa_settle', bank_id: 'sb_a', name: '台股交割戶', currency: 'TWD', balance: 18350, brokerage_id: 'sk_tw', include_in_total: true, show_in_menu: true, created_at: now },
    { id: 'sa_usd', bank_id: 'sb_a', name: '外幣活存', currency: 'USD', balance: 640.5, brokerage_id: 'sk_us', include_in_total: true, show_in_menu: false, created_at: now },
    { id: 'sa_cash', bank_id: null, name: '錢包', currency: 'TWD', balance: 2350, include_in_total: true, show_in_menu: true, created_at: now },
  ];
  const credit_cards = [
    { id: 'sc_1', name: '星海卡', billing_day: 27, due_day: 12, pay_account_id: 'sa_salary', current_balance: 0, auto_pay: true, autopay_from: ymOf(-1), payments: [], created_at: now },
    { id: 'sc_2', name: '山嵐卡', billing_day: 5, due_day: 20, pay_account_id: 'sa_salary', current_balance: 0, auto_pay: true, autopay_from: ymOf(-1), payments: [], created_at: now },
  ];
  const brokerages = [
    { id: 'sk_tw', name: '星海證券', market: 'TW', market_label: '台股', bank_id: 'sb_a', sort_order: 1 },
    { id: 'sk_us', name: '星海複委託', market: 'US', market_label: '美股', bank_id: 'sb_a', sort_order: 2 },
  ];
  const H = (id, brok, ticker, name, market, type, shares, cost, currency) => ({ id, brokerage_id: brok, ticker, name, market, asset_type: type, shares, cost_basis: cost, currency, created_at: now });
  const holdings = [
    H('sh_0050', 'sk_tw', '0050', '元大台灣50', 'TW', 'etf', 420, 168.5, 'TWD'),
    H('sh_006208', 'sk_tw', '006208', '富邦台50', 'TW', 'etf', 300, 98.2, 'TWD'),
    H('sh_2330', 'sk_tw', '2330', '台積電', 'TW', 'stock', 40, 905, 'TWD'),
    H('sh_voo', 'sk_us', 'VOO', 'Vanguard S&P 500 ETF', 'US', 'etf', 3.21458, 512.3, 'USD'),
  ];
  const market_prices = [
    { ticker: '0050', price: 192.4, updated_at: now }, { ticker: '006208', price: 112.6, updated_at: now },
    { ticker: '2330', price: 1085, updated_at: now }, { ticker: 'VOO', price: 571.8, updated_at: now },
  ];
  const stock_trades = holdings.map(h => ({ id: `st_open_${h.id}`, kind: 'opening', holding_id: h.id, holding_key: h.id, brokerage_id: h.brokerage_id,
    ticker: h.ticker, name: h.name, market: h.market, currency: h.currency, date: day(ymOf(3), 1), settle_date: day(ymOf(3), 1),
    shares: h.shares, total_cost: +(h.shares * h.cost_basis).toFixed(6), price: h.cost_basis, fee: 0, tax: 0,
    account_id: null, balance_applied: false, pending_settle: false, created_at: now, note: '期初' }));
  const dca_schedules = [
    { id: 'sd_1', holding_id: 'sh_0050', name: '0050 元大台灣50', amount: 5000, currency: 'TWD', account_id: 'sa_settle', pay_with: 'account', freq: 'monthly', billing_day: 6, is_expired: false, last_confirmed_date: T, note: '' },
    { id: 'sd_2', holding_id: 'sh_006208', name: '006208 富邦台50', amount: 1000, currency: 'TWD', account_id: null, pay_with: 'points', freq: 'monthly', billing_day: 16, is_expired: false, last_confirmed_date: T, note: '刷卡點數扣' },
  ];
  const time_deposits = [
    { id: 'stdp_1', bank_id: 'sb_b', label: '一年期定存', currency: 'TWD', principal: 100000, interest_rate: 1.7, start_date: iso(addDays(today, -200)), maturity_date: iso(addDays(today, 165)), auto_renew: true, status: 'active', note: '' },
  ];
  const recurring_expenses = [
    { id: 'sr_rent', name: '房租', amount: 15000, freq: 'monthly', billing_day: 5, spend_category: 'cat_house_rent', category: 'general', pay_type: 'account', account_id: 'sa_salary', pay_mode: 'auto', currency: 'TWD', is_expired: false, note: '' },
    { id: 'sr_phone', name: '電信費', amount: 599, freq: 'monthly', billing_day: 15, spend_category: 'cat_dig_phone', category: 'general', pay_type: 'cc', cc_id: 'sc_1', pay_mode: 'auto', currency: 'TWD', is_expired: false, note: '' },
    { id: 'sr_stream', name: '影音串流', amount: 390, freq: 'monthly', billing_day: 20, spend_category: 'cat_dig_stream', category: 'general', pay_type: 'cc', cc_id: 'sc_2', pay_mode: 'auto', currency: 'TWD', is_expired: false, note: '' },
    { id: 'sr_app', name: '繪圖 App 年費', amount: 2990, freq: 'yearly', billing_month: 3, billing_day: 10, spend_category: 'cat_dig_app', category: 'subscription', pay_type: 'cc', cc_id: 'sc_1', pay_mode: 'auto', currency: 'TWD', is_expired: false, note: '' },
  ];
  // 存錢目標：預備金 → 買車 → 房屋（階段目標）、旅行基金（獨立，薪水 5%）
  const buckets = [
    { id: 'sg_ef', name: '緊急預備金', target_amount: 250000, goal_kind: 'stage', stage_order: 1, is_emergency_fund: true, store_account_id: 'sa_ef', contribution_mode: 'fixed', monthly_amount: 8000, status: 'active', reminders: [{ type: 'full' }], created_at: now },
    { id: 'sg_car', name: '買車', target_amount: 600000, goal_kind: 'stage', stage_order: 2, contribution_mode: 'fixed', monthly_amount: 8000, status: 'active', reminders: [{ type: 'full' }, { id: 'r_car', type: 'amount', amount: 200000, text: '存到 20 萬了，可以開始看車' }], created_at: now },
    { id: 'sg_house', name: '房屋', target_amount: 2050000, goal_kind: 'stage', stage_order: 3, house_plan: true, contribution_mode: 'fixed', monthly_amount: 8000, status: 'active', reminders: [{ type: 'full' }], created_at: now },
    { id: 'sg_trip', name: '旅行基金', target_amount: 60000, goal_kind: 'independent', contribution_mode: 'percent', income_percent: 5, status: 'active', reminders: [{ type: 'full' }], created_at: now },
  ];
  const bucket_allocations = [
    { id: 'sal_1', bucket_id: 'sg_ef', amount: 84000, date: day(ymOf(3), 10), note: '期初', created_at: now },
    { id: 'sal_2', bucket_id: 'sg_ef', amount: 8000, date: day(ymOf(1), 10), note: '每月規劃', created_at: now },
    { id: 'sal_3', bucket_id: 'sg_trip', amount: 12500, date: day(ymOf(1), 10), note: '每月規劃', created_at: now },
  ];
  const payables = [
    { id: 'sp_1', name: '先墊的演唱會門票', amount: 3200, currency: 'TWD', to: '朋友小林', due_date: iso(addDays(today, 5)), status: 'open', note: '', created_at: now },
  ];
  // 近三個月的收支
  const E = [], I = [];
  let n = 0;
  const ex = (date, category, description, amount, pay) => E.push({ id: `se_${++n}`, date, category, description, amount,
    pay_type: pay === 'cash' ? 'cash' : pay.startsWith('sc_') ? 'cc' : 'account', account_id: pay === 'cash' ? 'sa_cash' : pay.startsWith('sc_') ? null : pay,
    cc_id: pay.startsWith('sc_') ? pay : null, note: '', bucket_id: null, project_id: null, currency: 'TWD', fx_rate_twd: 1, affects_balance: true, defer_balance_effect: false, created_at: now });
  for (let back = 2; back >= 0; back--) {
    const ym = ymOf(back);
    const lastDay = back === 0 ? today.getDate() : 28;
    I.push({ id: `si_sal_${ym}`, date: day(ym, 5), category: 'cat_salary', description: '薪水', amount: 52000, account_id: 'sa_salary', currency: 'TWD', fx_rate_twd: 1, affects_balance: true, created_at: now });
    if (back === 1) I.push({ id: `si_div_${ym}`, date: day(ym, 18), category: 'cat_div_tw', description: '0050 配息', amount: 1260, account_id: 'sa_settle', currency: 'TWD', fx_rate_twd: 1, affects_balance: true, irregular: true, created_at: now });
    const plan = [
      [5, 'cat_house_rent', '房租', 15000, 'sa_salary'], [1, 'cat_food_breakfast', '早餐', 65, 'cash'], [2, 'cat_food_lunch', '午餐便當', 120, 'cash'], [3, 'cat_food_drink', '飲料', 55, 'sc_1'],
      [4, 'cat_tr_mrt', '捷運', 300, 'sc_2'], [6, 'cat_food_dinner', '晚餐', 210, 'sc_1'], [8, 'cat_daily', '洗衣精、衛生紙', 389, 'sc_1'],
      [10, 'cat_food_party', '朋友聚餐', 680, 'sc_2'], [12, 'cat_shop_clothes', '冬季外套', 1490, 'sc_1'], [14, 'cat_food_lunch', '午餐', 140, 'cash'],
      [17, 'cat_ent_movie', '電影', 320, 'sc_2'], [19, 'cat_food_snack', '麵包', 85, 'cash'], [21, 'cat_shop_skin', '保養品', 760, 'sc_1'],
      [22, 'cat_food_drink', '咖啡', 60, 'sc_1'], [24, 'cat_tr_taxi', '計程車', 245, 'sc_2'], [25, 'cat_edu_book', '書', 380, 'sc_1'],
      [26, 'cat_food_dinner', '晚餐', 190, 'sc_1'], [27, 'cat_food_lunch', '午餐', 130, 'sc_1'],
    ];
    for (const [d, c, desc, amt, pay] of plan) if (d <= lastDay) ex(day(ym, d), c, desc, amt, pay);
  }
  // 信用卡待繳＝還沒繳的刷卡（自動扣繳從下個月開始，過去的期別當作已經繳了）
  const cardPaidUpTo = { sc_1: ymOf(0), sc_2: ymOf(0) };
  return {
    banks, accounts, credit_cards, brokerages, holdings, market_prices, stock_trades, dca_schedules, time_deposits,
    recurring_expenses: recurring_expenses.map(r => ({ ...r, last_confirmed_date: T, created_at: now })),
    buckets, bucket_allocations, payables, expense_txns: E, income_txns: I,
    _cardPaidUpTo: cardPaidUpTo,
  };
}
