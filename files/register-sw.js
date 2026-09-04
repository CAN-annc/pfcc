/**
 * Service Worker registration — injected into index.html
 */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' })
      .then(reg => {
        console.log('[SW] registered, scope:', reg.scope);
        // Check for updates on each page load
        reg.update();
      })
      .catch(err => console.warn('[SW] registration failed:', err));
  });
}
