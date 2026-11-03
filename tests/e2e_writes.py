"""PFCC 寫入路徑回歸測試（v2.31.0 起）。

在真的瀏覽器（Chromium）裡跑，因為要驗證的是 IndexedDB 交易、多分頁、時區這些
Node 單元測試碰不到的行為。

執行：
    pip install playwright && playwright install chromium   # 第一次
    python tests/e2e_writes.py                               # 在 repo 根目錄
    python tests/e2e_writes.py --only E2,E4                  # 只跑某幾個
    python tests/e2e_writes.py --root /path/to/files         # 對別的版本跑

測試透過網址參數 ?pfcc-test 取得 window.__pfcc（只有帶這個參數時才存在）。
每個測試用全新的瀏覽器環境（全新的 IndexedDB），互不影響。
"""
import argparse, asyncio, json, os, socket, subprocess, sys, time
from playwright.async_api import async_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_ROOT = os.path.join(HERE, '..', 'files')
CHROME = os.environ.get('PFCC_CHROME')  # 例如 /usr/bin/google-chrome；不設就用 Playwright 內建的

SEED = """async (recs) => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('pfcc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  for (const [st, v] of recs) await new Promise((res, rej) => { const t = db.transaction([st], 'readwrite'); t.objectStore(st).put(v); t.oncomplete = res; t.onerror = () => rej(t.error); });
  db.close(); return true;
}"""
DUMP = """async (st) => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('pfcc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const all = await new Promise((res, rej) => { const q = db.transaction([st]).objectStore(st).getAll(); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
  db.close(); return all;
}"""
BASE_SEED = [
    ['accounts', {'id': 'a1', 'name': '薪轉', 'type': 'bank', 'currency': 'TWD', 'balance': 10000, 'include_in_total': True}],
    ['accounts', {'id': 'a2', 'name': '生活', 'type': 'bank', 'currency': 'TWD', 'balance': 0, 'include_in_total': True}],
    ['credit_cards', {'id': 'c1', 'name': '玉山', 'current_balance': 0}],
]


def free_port():
    s = socket.socket(); s.bind(('127.0.0.1', 0)); p = s.getsockname()[1]; s.close(); return p


class Ctx:
    def __init__(self, pw, browser, base):
        self.pw, self.browser, self.base = pw, browser, base

    async def page(self, context=None, clock=None):
        """回傳一個已啟動、略過快速設定精靈、種好基本資料的頁面。"""
        ctx = context or await self.browser.new_context(viewport={'width': 390, 'height': 844}, service_workers='block', timezone_id='Asia/Taipei')
        pg = await ctx.new_page()
        pg.errors = []
        pg.on('pageerror', lambda e: pg.errors.append(str(e)))
        if clock: await pg.clock.install(time=clock)
        await pg.goto(self.base + '/index.html?pfcc-test')
        await pg.wait_for_function('window.__pfcc !== undefined', timeout=15000)
        await pg.wait_for_timeout(800)
        if context is None:
            await pg.evaluate(SEED, BASE_SEED + [['settings', {'key': 'onboarding_completed', 'value': True}]])
            await pg.reload(); await pg.wait_for_function('window.__pfcc !== undefined'); await pg.wait_for_timeout(600)
        return pg

    async def dump(self, pg, st): return await pg.evaluate(DUMP, st)
    async def acc(self, pg, aid): return next(a for a in await self.dump(pg, 'accounts') if a['id'] == aid)['balance']


TESTS = []
def case(tid, title):
    def deco(fn): TESTS.append((tid, title, fn)); return fn
    return deco


@case('E1', '記一筆支出：帳戶扣款、紀錄一筆')
async def e1(c):
    pg = await c.page()
    r = await pg.evaluate("__pfcc.saveExpenseRecord({ date: '2026-11-03', category: 'cat_food', amount: 120, payType: 'account', accId: 'a1' })")
    assert r['ok'], r
    assert await c.acc(pg, 'a1') == 9880
    assert len(await c.dump(pg, 'expense_txns')) == 1


@case('E2', '同一分頁同時記 20 筆支出，餘額一筆都不少扣（R2 同時寫入）')
async def e2(c):
    pg = await c.page()
    await pg.evaluate("Promise.all(Array.from({length: 20}, (_, i) => __pfcc.saveExpenseRecord({ date: '2026-11-03', category: 'cat_food', amount: 100, payType: 'account', accId: 'a1', description: 'n' + i })))")
    bal = await c.acc(pg, 'a1')
    assert bal == 8000, f'餘額應為 8000，實際 {bal}'
    assert len(await c.dump(pg, 'expense_txns')) == 20


@case('E3', '兩個分頁同時各記 10 筆支出，總共扣 20 筆（R2 多分頁）')
async def e3(c):
    pg1 = await c.page()
    pg2 = await c.page(context=pg1.context)
    js = "Promise.all(Array.from({length: 10}, () => __pfcc.saveExpenseRecord({ date: '2026-11-03', category: 'cat_food', amount: 100, payType: 'account', accId: 'a1' })))"
    await asyncio.gather(pg1.evaluate(js), pg2.evaluate(js))
    bal = await c.acc(pg1, 'a1')
    assert bal == 8000, f'餘額應為 8000，實際 {bal}'


@case('E4', '交易中途失敗：帳戶不扣、沒有紀錄、回傳失敗、事件紀錄有一筆（R2 原子性＋R6）')
async def e4(c):
    pg = await c.page()
    # extraFields 放一個不能存進資料庫的值：帳戶扣款寫入之後、支出紀錄寫入時才失敗
    r = await pg.evaluate("__pfcc.saveExpenseRecord({ date: '2026-11-03', category: 'cat_food', amount: 120, payType: 'account', accId: 'a1', extraFields: { bad: () => 1 } }).then(r => ({ ok: r.ok, error: r.error }), e => ({ threw: String(e) }))")
    assert r.get('ok') is False, f'應該回傳 ok:false，實際 {r}'
    assert r.get('error'), r
    assert await c.acc(pg, 'a1') == 10000, '帳戶不應被扣款'
    assert len(await c.dump(pg, 'expense_txns')) == 0, '不應留下紀錄'
    ev = await pg.evaluate('__pfcc.readEventLog()')
    assert any(e['action'] == 'record-expense' for e in ev), ev


@case('E5', '編輯支出 120 → 200：只多扣 80，紀錄仍是一筆')
async def e5(c):
    pg = await c.page()
    r = await pg.evaluate("__pfcc.saveExpenseRecord({ date: '2026-11-03', category: 'cat_food', amount: 120, payType: 'account', accId: 'a1' })")
    r2 = await pg.evaluate(f"__pfcc.saveExpenseRecord({{ editId: '{r['txn']['id']}', date: '2026-11-03', category: 'cat_food', amount: 200, payType: 'account', accId: 'a1' }})")
    assert r2['ok'], r2
    assert await c.acc(pg, 'a1') == 9800
    assert len(await c.dump(pg, 'expense_txns')) == 1


@case('E6', '信用卡支出：待繳增加、帳戶不動；刪除後回到原值')
async def e6(c):
    pg = await c.page()
    r = await pg.evaluate("__pfcc.saveExpenseRecord({ date: '2026-11-03', category: 'cat_food', amount: 300, payType: 'cc', ccId: 'c1' })")
    cc = next(x for x in await c.dump(pg, 'credit_cards') if x['id'] == 'c1')
    assert cc['current_balance'] == 300 and await c.acc(pg, 'a1') == 10000
    await pg.evaluate("t => __pfcc.deleteTxnRecord(t, false)", r['txn'])
    cc = next(x for x in await c.dump(pg, 'credit_cards') if x['id'] == 'c1')
    assert cc['current_balance'] == 0 and len(await c.dump(pg, 'expense_txns')) == 0


@case('E7', '記收入、編輯 5000 → 3000、刪除，帳戶依序正確')
async def e7(c):
    pg = await c.page()
    r = await pg.evaluate("__pfcc.saveIncomeRecord({ date: '2026-11-03', category: 'cat_salary', amount: 5000, accId: 'a1' })")
    assert r['ok'] and await c.acc(pg, 'a1') == 15000
    r2 = await pg.evaluate(f"__pfcc.saveIncomeRecord({{ editId: '{r['txn']['id']}', date: '2026-11-03', category: 'cat_salary', amount: 3000, accId: 'a1' }})")
    assert r2['ok'] and await c.acc(pg, 'a1') == 13000
    await pg.evaluate("t => __pfcc.deleteTxnRecord(t, true)", r2['txn'])
    assert await c.acc(pg, 'a1') == 10000 and len(await c.dump(pg, 'income_txns')) == 0


@case('E8', '收入結清應收款：已收金額、流水帳、帳戶在同一個交易裡更新')
async def e8(c):
    pg = await c.page()
    await pg.evaluate(SEED, [['receivables', {'id': 'r1', 'name': '小明', 'total_amount': 2000, 'received_amount': 0, 'currency': 'TWD'}]])
    r = await pg.evaluate("__pfcc.saveIncomeRecord({ date: '2026-11-03', category: 'cat_receivable', amount: 2500, accId: 'a1', receivableId: 'r1' })")
    assert r['ok'] and r['clampedFrom'] == 2500, r
    recv = (await c.dump(pg, 'receivables'))[0]
    pays = await c.dump(pg, 'receivable_payments')
    assert recv['received_amount'] == 2000 and recv['is_settled'] and len(pays) == 1 and pays[0]['amount'] == 2000
    assert await c.acc(pg, 'a1') == 12000


@case('E9', '轉帳含手續費；同時雙向各 10 筆，兩邊餘額正確（R2 轉帳）')
async def e9(c):
    pg = await c.page()
    r = await pg.evaluate("__pfcc.recordTransfer({ fromId: 'a1', toId: 'a2', fromAmt: 3000, fee: 15 })")
    assert r['ok'], r
    assert await c.acc(pg, 'a1') == 6985 and await c.acc(pg, 'a2') == 3000
    await pg.evaluate("Promise.all([...Array.from({length: 10}, () => __pfcc.recordTransfer({ fromId: 'a1', toId: 'a2', fromAmt: 100 })), ...Array.from({length: 10}, () => __pfcc.recordTransfer({ fromId: 'a2', toId: 'a1', fromAmt: 50 }))])")
    assert await c.acc(pg, 'a1') == 6485 and await c.acc(pg, 'a2') == 3500
    assert len(await c.dump(pg, 'transfer_logs')) == 21


@case('E10', '定期轉帳同一期確認兩次（同時），只記一次')
async def e10(c):
    pg = await c.page()
    await pg.evaluate(SEED, [['recurring_transfers', {'id': 't1', 'name': '存錢', 'from_account_id': 'a1', 'to_account_id': 'a2', 'amount': 1000, 'currency': 'TWD', 'billing_day': 3, 'freq': 'monthly'}]])
    js = "__pfcc.recordTransfer({ fromId: 'a1', toId: 'a2', fromAmt: 1000, recurring: { id: 't1', occ: '2026-11-03' } })"
    res = await pg.evaluate(f"Promise.all([{js}, {js}])")
    assert sum(1 for r in res if r.get('dup')) == 1, res
    assert await c.acc(pg, 'a1') == 9000 and len(await c.dump(pg, 'transfer_logs')) == 1


@case('E11', '轉帳到不存在的帳戶：回傳失敗、兩邊都不動')
async def e11(c):
    pg = await c.page()
    r = await pg.evaluate("__pfcc.recordTransfer({ fromId: 'a1', toId: 'nope', fromAmt: 500 })")
    assert r['ok'] is False and await c.acc(pg, 'a1') == 10000 and len(await c.dump(pg, 'transfer_logs')) == 0


@case('E16', '台北 11/1 早上 7:30：計畫頁是 11 月，不是 10 月（R1）')
async def e16(c):
    ctx = await c.browser.new_context(viewport={'width': 390, 'height': 844}, service_workers='block', timezone_id='Asia/Taipei')
    pg = await ctx.new_page()
    await pg.clock.install(time='2026-10-31T23:30:00Z')  # = 台北 11/1 07:30，UTC 還是 10/31
    await pg.goto(c.base + '/index.html?pfcc-test'); await pg.wait_for_function('window.__pfcc !== undefined'); await pg.wait_for_timeout(500)
    await pg.evaluate(SEED, BASE_SEED + [['settings', {'key': 'onboarding_completed', 'value': True}]])
    await pg.reload(); await pg.wait_for_function('window.__pfcc !== undefined'); await pg.wait_for_timeout(800)
    await pg.locator('#bottomNav [data-view=plan]').click(); await pg.wait_for_timeout(800)
    txt = await pg.locator('.hp-todo b').first.inner_text()
    assert txt.startswith('11 月'), f'應顯示 11 月，實際「{txt}」'


@case('E17', '一般畫面操作沒有任何頁面錯誤')
async def e17(c):
    pg = await c.page()
    for view in ['calendar', 'plan', 'wealth']:
        await pg.locator(f'#bottomNav [data-view={view}]').click(); await pg.wait_for_timeout(500)
    await pg.locator('#moreNavBtn').click(); await pg.locator('#moreSheet [data-view=appsettings]').click(); await pg.wait_for_timeout(600)
    assert not pg.errors, pg.errors


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--root', default=DEFAULT_ROOT)
    ap.add_argument('--only', default='')
    a = ap.parse_args()
    port = free_port()
    srv = subprocess.Popen([sys.executable, '-m', 'http.server', str(port), '-d', a.root], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(0.8)
    only = set(x.strip() for x in a.only.split(',') if x.strip())
    passed = failed = 0
    try:
        async with async_playwright() as pw:
            browser = await pw.chromium.launch(**({'executable_path': CHROME} if CHROME else {}), args=['--no-sandbox'])
            c = Ctx(pw, browser, f'http://127.0.0.1:{port}')
            for tid, title, fn in TESTS:
                if only and tid not in only: continue
                try:
                    await asyncio.wait_for(fn(c), 60)
                    print(f'ok     {tid} {title}'); passed += 1
                except Exception as e:
                    print(f'FAIL   {tid} {title}\n       {type(e).__name__}: {e}'); failed += 1
            await browser.close()
    finally:
        srv.terminate()
    print(f'\n{passed} passed, {failed} failed')
    sys.exit(1 if failed else 0)

if __name__ == '__main__':
    asyncio.run(main())
