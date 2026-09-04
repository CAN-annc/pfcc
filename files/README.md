# PFCC — 個人財務控制台

Local-First Personal Finance Command Center

## 架構

- **所有財務資料**：存在裝置本地 IndexedDB，不上傳任何伺服器
- **App 本體**：Vercel 靜態托管
- **市場報價 / 匯率**：透過 Vercel Edge Function 代理，只傳股票代號 / 幣別

## 快速開始

```bash
# 本地預覽
npx serve . -p 3000

# 部署到 Vercel
npm i -g vercel
vercel --prod
```

## 設定 API Keys（Vercel Dashboard）

1. `FINNHUB_API_KEY` — 美股報價（[免費申請](https://finnhub.io/register)）
2. `EXCHANGERATE_API_KEY` — 匯率（可選，不設定會用 open.er-api.com 免費版）

## 備份 & 還原

- 點擊右上角 ↓ 按鈕匯出 JSON 備份
- 點擊右上角 ↑ 按鈕從備份匯入（會覆蓋現有資料）
- 換裝置時：舊裝置匯出 → 傳給自己 → 新裝置匯入

## 台股報價

V1 台股採手動輸入參考價。點擊持倉旁的「輸入價格」按鈕更新。

## 檔案結構

```
pfcc/
├── index.html      # 主應用（Dashboard）
├── db.js           # IndexedDB schema + CRUD
├── market.js       # Market data service（Provider 抽象層）
├── calc.js         # 計算引擎（純函式）
├── sw.js           # Service Worker（Offline-First）
├── register-sw.js  # SW 註冊
├── manifest.json   # PWA manifest
├── vercel.json     # Vercel 設定
├── api/
│   ├── quote.js    # 股票報價 Proxy（Edge Function）
│   └── fx.js       # 匯率 Proxy（Edge Function）
└── icons/
    ├── icon-192.png
    └── icon-512.png
```
