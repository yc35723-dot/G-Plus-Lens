# G+Lens

在 Edge、Brave、Vivaldi 等非 Chrome 的 Chromium 瀏覽器上，用框選的方式呼叫 Google 智慧鏡頭（Google Lens）。

按下工具列圖示或右鍵選單 → 畫面凍結變暗 → 拖曳框出要搜尋的區域 → 右側滑出獨立小視窗顯示 Lens 結果。

## 載入未封裝擴充功能

1. 開啟 `brave://extensions`（Edge 為 `edge://extensions`、Vivaldi 為 `vivaldi://extensions`）。
2. 打開「開發人員模式」。
3. 按「載入未封裝項目」，選擇本專案資料夾。
4. 把 `G+Lens` 釘選到工具列。

需要 Chromium 116 以上。

## 使用

- **工具列圖示**或**快捷鍵 `Alt+Shift+L`**：進入框選模式。
- **右鍵 → 用 G+Lens 搜尋**：進入框選模式。
- **右鍵圖片 → 用 G+Lens 搜尋這張圖片**：直接以該圖片所在區域搜尋，跳過框選。
- **拖曳**框出範圍，放開滑鼠立即搜尋。搜尋後遮罩仍保留，方便微調。
- **拖曳框選範圍的四角或四邊**調整大小、**在框內拖曳**重新框選；停手 0.3 秒後自動重新搜尋。
- **Esc**、**右上關閉鈕**或**點框外空白處**都能退出框選模式。

框選小於 12×12 像素視為誤觸，不會觸發搜尋。

## 架構與取捨

| 決策 | 原因 |
| --- | --- |
| 觸發時才注入，不常駐所有網頁 | 權限只需 `activeTab`，平時對任何網站都沒有存取權。 |
| 先截圖再掛遮罩 | 遮罩上顯示的是 `captureVisibleTab` 的凍結畫面，所以不會拍到遮罩、也不受頁面動畫與捲動影響。 |
| Shadow DOM 隔離 | 遮罩與框線不受宿主網頁 CSS 影響，退出時整個 host 節點移除。 |
| 結果用原生 popup 視窗 | 不嵌 iframe、不改任何 HTTP 標頭（不碰 `declarativeNetRequest`），避免 CSP／XFO 造成的一整類問題。 |
| 裁切在 service worker 進行 | 先把截圖解碼成 `ImageBitmap` 再裁切，避免直接對 `<img>` 元素取樣造成的色彩捨入誤差。 |

### 為什麼不能用 `fetch` 上傳

實測（Brave 157）：從擴充功能 service worker 或擴充功能頁面 `fetch` POST 到 `https://lens.google.com/v3/upload` 時，瀏覽器必定附帶 `Origin: chrome-extension://<id>`，Google 直接回 **403 Forbidden**。同一個請求若 `Origin` 為 `null`、`https://lens.google.com` 或任何 https 來源都會回 303。

因此上傳改用**擴充功能頁面的表單 POST 導覽**：表單送出時不帶 `Origin`，Google 回 303 並把彈出視窗導覽到 `https://www.google.com/search?vsrid=…`。彈出視窗因此會直接變成 Lens 結果頁，網址列是原生的，不需要 iframe。

副作用：彈出視窗送出後會離開我們的頁面，所以**無法用程式得知 Google 端是否真的成功**。斷線與明顯的連線失敗會在送出前用一次 `fetch` 預檢攔下；送出後若遇到 Google 限流（`/sorry/`）、同意頁或端點改版（404），使用者會直接看到 Google 自己的頁面。

## 權限

```json
"permissions": ["activeTab", "scripting", "contextMenus", "storage"],
"host_permissions": ["*://lens.google.com/*", "*://www.google.com/*"]
```

- `host_permissions` 只有這兩個 Google 網域，**沒有 `<all_urls>`**。
- `www.google.com` 是必要的：Lens 上傳端點會 303 到 `www.google.com/search`，預檢需要授權才能判斷連線是否正常。
- 沒有 `web_accessible_resources`：面板是本擴充功能自己的視窗，不需要對網頁曝光任何資源。
- 沒有分析、遠端程式碼、使用者追蹤。

## 已知限制

- **Google 端無法驗證**：見上一節。若 Lens 上傳端點改版，需要更新 `shared/lens.js` 的 `LENS_ORIGIN`／`LENS_UPLOAD_PATH`。
- **Google 限流**：短時間內連續測試會看到 `/sorry/index?...`（Google 的自動化流量攔截），這是帳號／IP 層級的限制，換網路或等一段時間即恢復。
- **`captureVisibleTab` 每秒配額**：連續快速觸發會失敗，擴充功能會靜默略過該次。
- **無法在這些頁面使用**：`chrome://`、擴充功能商店、PDF 檢視器、`view-source:`、其他擴充功能頁面。
- **iframe 內的圖片**：右鍵選單在子框架上時會退回框選模式（截圖本身只包含主文件可視區）。
- **彈出視窗會搶焦點**：`type: "popup"` 沒有網址列與分頁列，第一次搜尋後若再搜尋會重用同一個視窗。
- **Google 的淺／深色主題**：結果頁配色由 Google 決定，不受擴充功能控制。

## 介面規格

- 遮罩 `rgba(0, 0, 0, .4)`，框選區保持原亮度。
- 框線 2px 白線、外圍 1px 25% 黑框（白底頁面也看得見），圓角 6px。
- 四角 18px 長、3px 粗的 L 形白色角標。
- 游標為 `crosshair`。
- 彈出視窗寬度為當前視窗的 30%（夾在 360–560px），高度 85%，靠右對齊，垂直置中。
- 介面文字提供英文與繁體中文，預設英文。

## 目錄

```
manifest.json        擴充功能設定
background.js        service worker：選單、截圖、裁切、開窗
content/overlay.js   框選遮罩（注入式，非 content script）
viewer/              彈出視窗頁面：預檢 + 表單上傳 + 備援
shared/              純函式：語言、視窗尺寸、裁切幾何、圖片挑選
_locales/            英文 / 繁體中文
icons/               圖示（tools/make_icons.py 產生）
test/                驗收用固定頁（pattern.html 為逐像素驗證用）
tools/               開發與驗證工具
```

## 驗證

```bash
node tools/serve.mjs test 8471   # 另開一個終端機
node tools/test-all.mjs
```

`tools/test-all.mjs` 會依序啟動 Brave（無頭不可用，會開新視窗），以 CDP 載入擴充功能的測試副本，並驗證：

| 測試 | 內容 | 通過條件 |
| --- | --- | --- |
| `e2e-crop` @1x / 1.25x / 1.5x | 拖曳框選後比對裁切結果與原始截圖 | 幾何完全相符且 **0 個像素差異** |
| `e2e-cleanup` | Esc 退出後的 DOM 狀態 | 節點數回到初始值、host 節點為 0、樣式表數量不變 |
| `e2e-lens` | 表單上傳與彈出視窗導覽 | 視窗最終停留在 `google.com/search?…` |

測試會把 `host_permissions` 臨時加上 `<all_urls>`（僅測試副本，不會動到正式 `manifest.json`），因為 `captureVisibleTab` 需要 `activeTab`，而 CDP 直接呼叫不具備使用者手勢。

其他工具：

- `tools/measure.mjs`：量測截圖與視窗尺寸的比例。
- `tools/compare.py`：用 Pillow 比對兩張 PNG（含差異圖輸出）。
- `tools/serve.mjs`：靜態檔案伺服器，供固定頁使用。

## 開發規則

純 JavaScript（ES Modules），無框架、無打包工具。`content/overlay.js` 會被 `chrome.scripting.executeScript` 直接注入，因此不可是 ES module，也不可使用 `import`。
