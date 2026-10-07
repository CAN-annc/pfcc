/**
 * PFCC Service Worker — Offline-First (ADR-002)
 *
 * Cache strategy:
 *   App shell (HTML/JS/CSS) → Cache First, network fallback
 *   /api/* (market data)    → Network Only, never cached
 *   Fonts / CDN assets      → Stale While Revalidate
 *
 * User financial data lives in IndexedDB only — SW never touches it.
 *
 * §卅七之一（2026-09-29，使用者回報「換了新檔案、也用了 register-sw.js 的
 * 更新提示，畫面還是一直是舊版；用無痕視窗開就正常」）：追查後發現真正的
 * 根本原因在這個檔案本身——瀏覽器判斷「Service Worker 有沒有新版本」，是
 * 直接比對 sw.js 這個檔案本身的內容有沒有變byte-by-byte，完全不知道、也不
 * 關心 index.html／calc.js 等其他檔案內容是否換新了。過去每次交付都只換
 * index.html（或這次的 index.html＋calc.js），從來沒有動過 sw.js，所以
 * 瀏覽器其實從頭到尾都覺得「Service Worker 沒有新版本」，install／activate
 * 事件根本沒有被觸發過，register-sw.js 裡準備好的「立即更新」流程也就一直
 * 沒有機會執行——這解釋了為什麼一般視窗一直吃到舊版，而無痕視窗（沒有任何
 * 既有快取、會重新安裝一次 Service Worker）卻能立刻看到新版本。
 *
 * 修法：CACHE_NAME 加上版本號，之後每次交付會影響 index.html／calc.js／
 * db.js／market.js 等「app shell」檔案的新批次，都會把這個版本號往上跳一碼
 * （v2、v3、……）。只要 sw.js 這個檔案本身的內容有變，瀏覽器就一定會偵測到
 * 「有新版本」，走一次 install（重新抓最新的 app shell 檔案進新的快取）→
 * self.skipWaiting()（不用等舊分頁關閉，立刻生效）→ activate（刪掉舊版
 * 快取、self.clients.claim() 接管所有已開啟的分頁）→ 觸發
 * register-sw.js 裡監聽的 controllerchange → 自動重新整理一次頁面。整個
 * 流程原本就已經寫好、邏輯正確，只是從來沒有被觸發過而已。
 *
 * 另外把 install 階段抓 app shell 檔案的 fetch 改成明確帶 {cache:'reload'}
 * （見 shellRequests()）——不然 fetch() 預設仍然會遵守瀏覽器自己的 HTTP
 * 快取規則，如果網站伺服器本身有設定快取表頭，有可能連這個「重新安裝」的
 * fetch 都被瀏覽器自己的 HTTP 快取擋下來、拿到的還是舊內容，等於白做。加上
 * cache:'reload' 強制略過瀏覽器的 HTTP 快取，確保 install 階段真的是跟
 * 伺服器要最新版本。
 */

const CACHE_NAME  = 'pfcc-shell-v34'; // 2026-10-07：v2.13.0（預備金存放帳戶、收入穩定度建議月數、獎金預設放預備金），index.html／calc.js 異動。
// （上一版 v15，2026-10-02：「新增收入」轉入帳戶／「應收款入帳」選擇帳戶新增「顯示外幣帳戶」勾選（預設只顯示台幣）＋「新增現金帳戶」快速新增捷徑，index.html 異動，版本號照約定往上跳一碼。）
const SHELL_URLS  = ['/', '/index.html', '/db.js', '/market.js', '/calc.js', '/manifest.json'];

// 把 SHELL_URLS 轉成帶 {cache:'reload'} 的 Request 物件——理由見上方檔頭註解。
function shellRequests() {
  return SHELL_URLS.map(u => new Request(u, { cache: 'reload' }));
}

// ── Install: pre-cache app shell ──────────────────────────────────────────────
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(c => c.addAll(shellRequests()))
      .then(() => self.skipWaiting())
  );
});

// ── Activate: delete old caches ───────────────────────────────────────────────
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ── Fetch: route by resource type ─────────────────────────────────────────────
self.addEventListener('fetch', (e) => {
  const { request } = e;
  const url = new URL(request.url);

  // API calls (market data / FX) → Network Only, never cache
  // User data never flows through here — IndexedDB is accessed directly by the page.
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(fetch(request));
    return;
  }

  // External fonts / CDN → Stale While Revalidate
  // v2.11.0：只限字型／CDN 這幾個靜態資源網域。原本所有跨網域請求都走這裡，
  // 連瀏覽器直接查的證交所開放資料、匯率等「要即時」的資料也會先拿到上一次
  // 的快取版本；其他跨網域請求現在完全不攔，交給瀏覽器照常處理。
  if (url.origin !== self.location.origin) {
    if (STATIC_CDN_HOSTS.includes(url.hostname)) e.respondWith(staleWhileRevalidate(request));
    return;
  }

  // App shell → Cache First, fallback to network then offline page
  e.respondWith(
    caches.match(request)
      .then(cached => {
        if (cached) {
          // Kick off background refresh — §卅七之一：這裡也加上 cache:'reload'，
          // 理由跟 install 階段一樣，避免瀏覽器自己的 HTTP 快取讓這個「背景
          // 重新整理」變成白做工。注意：不能用 `new Request(request, {...})`
          // 包一層再 fetch——如果 request 是「頁面導覽」本身（mode 是
          // 'navigate'），瀏覽器規格不允許用建構子帶著額外選項去複製一個
          // navigate 模式的 Request，會直接丟出錯誤。改用 request.url（純
          // 網址字串）搭配 fetch() 的第二個參數，完全繞開這個限制，效果
          // 一樣是「強制略過 HTTP 快取、跟伺服器要最新版本」。
          fetch(request.url, { cache: 'reload' }).then(res => {
            if (res.ok) caches.open(CACHE_NAME).then(c => c.put(request, res));
          }).catch(() => {});
          return cached;
        }
        return fetch(request).then(res => {
          if (res.ok && request.method === 'GET') {
            const clone = res.clone();
            caches.open(CACHE_NAME).then(c => c.put(request, clone));
          }
          return res;
        }).catch(() => caches.match('/index.html')); // offline fallback
      })
  );
});

const STATIC_CDN_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com', 'cdnjs.cloudflare.com', 'cdn.jsdelivr.net', 'unpkg.com'];
async function staleWhileRevalidate(request) {
  const cached = await caches.match(request);
  const fetchPromise = fetch(request).then(res => {
    // 先複製再回傳——原本在非同步的 then 裡才 clone，頁面可能已經開始讀取
    // 本體，clone 會失敗。
    if (res.ok) { const copy = res.clone(); caches.open(CACHE_NAME).then(c => c.put(request, copy)); }
    return res;
  }).catch(() => cached);
  return cached ?? fetchPromise;
}
