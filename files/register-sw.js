/**
 * Service Worker registration — injected into index.html
 *
 * 2026-09 更新：原本的版本只有「註冊＋呼叫 reg.update()」，這解決不了
 * 「iPhone 加到主畫面後不會自動更新」的問題——因為瀏覽器預設規則是：
 * 新版 Service Worker 下載安裝完成後會先進入 waiting（等待）狀態，
 * 要等「所有還開著的舊分頁／舊視窗都關閉」之後才會真正接手生效。
 * 加到主畫面的 PWA 很少被使用者「完全關閉」（iOS 通常只是切到背景、
 * 暫停執行，不是真的結束程序），所以新版可能會一直卡在 waiting、
 * 使用者感覺「怎麼更新後畫面都沒變」。
 *
 * 這次改成主動偵測＋提示的流程：偵測到有新版本在等待時，畫面下方會
 * 跳出一個「發現新版本，點一下即可更新」的提示條，使用者按下後才會
 * 立刻切換到新版並重新整理，不會在使用中途無預警自動刷新畫面。
 *
 * 重要澄清：這個更新機制只影響「網頁程式碼／畫面」這一層的快取版本，
 * 跟資料完全無關。記帳資料、設定等都存在 IndexedDB，這是綁在「網站
 * 網域本身」的儲存空間，不會因為 Service Worker 有沒有更新、有沒有
 * 重新分享到主畫面而被清空或需要重新輸入——除非使用者自己在 iOS
 * 設定裡手動清除這個網站的資料，或整個移除又重新安裝。
 *
 * 但這個提示條要真的「一按就生效」，还需要 sw.js（Service Worker
 * 本體）那邊配合加兩行：
 *
 *   1. 監聽這裡送出的訊息，收到就呼叫 self.skipWaiting()：
 *        self.addEventListener('message', (event) => {
 *          if (event.data && event.data.type === 'SKIP_WAITING') {
 *            self.skipWaiting();
 *          }
 *        });
 *
 *   2. 在 activate 事件裡呼叫 clients.claim()，讓新版立刻接管所有
 *      已開啟的頁面（原本可能已經有 activate 監聽器，把這行加進去
 *      即可，不用整個重寫）：
 *        self.addEventListener('activate', (event) => {
 *          event.waitUntil(clients.claim());
 *          // ...原本 activate 裡其他清快取之類的邏輯照舊保留
 *        });
 *
 * 我目前沒看過 sw.js 的內容，所以沒辦法直接幫你把這兩段加進去——
 * 如果方便的話，把 sw.js 也傳給我，我可以直接幫你改好；或是你也可以
 * 照著上面的說明自己加這兩小段。沒有加這兩段之前，這個提示條還是會
 * 出現、按「立即更新」至少會把提示關掉，但新版仍要等下次完全關閉
 * 重開才會真正生效（跟原本行為一樣）；加上去之後才會「按下去馬上
 * 生效＋自動重新整理」。
 */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' })
      .then(reg => {
        console.log('[SW] registered, scope:', reg.scope);
        // 每次載入頁面都主動檢查一次是否有新版本
        reg.update();

        // 這次一進來就已經有新版本在等待中——代表現在看到的其實是舊畫面
        if (reg.waiting) showUpdateBanner(reg);

        // 頁面開著期間，偵測到新版本開始下載安裝，安裝完成後再提示
        reg.addEventListener('updatefound', () => {
          const installing = reg.installing;
          if (!installing) return;
          installing.addEventListener('statechange', () => {
            if (installing.state === 'installed' && navigator.serviceWorker.controller) {
              showUpdateBanner(reg);
            }
          });
        });
      })
      .catch(err => console.warn('[SW] registration failed:', err));

    // 新版 Service Worker 接手控制後，重新整理一次頁面才能真正套用新版
    // （只會在使用者按下「立即更新」、且 sw.js 有回應 skipWaiting 之後才會觸發）
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloading) return;
      reloading = true;
      window.location.reload();
    });
  });
}

function showUpdateBanner(reg) {
  if (document.getElementById('sw-update-banner')) return; // 避免重複顯示
  const bar = document.createElement('div');
  bar.id = 'sw-update-banner';
  bar.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:99999;background:#111827;color:#fff;' +
    'padding:12px 16px;display:flex;align-items:center;justify-content:space-between;gap:12px;' +
    'font-size:14px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;' +
    'box-shadow:0 -2px 8px rgba(0,0,0,.2)';
  const label = document.createElement('span');
  label.textContent = '發現新版本，點一下即可更新';
  const btn = document.createElement('button');
  btn.textContent = '立即更新';
  btn.style.cssText = 'background:#2563EB;color:#fff;border:none;border-radius:6px;' +
    'padding:6px 14px;font-size:14px;cursor:pointer;white-space:nowrap;flex-shrink:0';
  btn.addEventListener('click', () => {
    if (reg.waiting) {
      reg.waiting.postMessage({ type: 'SKIP_WAITING' });
    }
    bar.remove();
  });
  bar.appendChild(label);
  bar.appendChild(btn);
  document.body.appendChild(bar);
}
