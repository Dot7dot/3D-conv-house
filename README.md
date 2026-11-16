# 🏠 3D-conv-house（3D 轉換屋）

把 2D 圖片轉成可以放進遊戲的 3D 物件（`.glb`）。

每一種物件（卡片、帽子、書本…）的做法都不一樣，常常需要針對物件特別調整，所以**每種物件由各自的 repo 負責轉換**，
3D-conv-house 只當作統一的入口與 UI：

```
                       ┌── 🃏 卡片 ── Dot7dot/card-uploader   ✅ 已上線
3D-conv-house (UI) ────┼── 🎩 帽子 ── Dot7dot/3D-conv-hat     ⏳ 即將推出
                       └── 📕 書本 ── Dot7dot/3D-conv-book    ⏳ 即將推出
```

使用流程：

1. 右上 **ITEMS** 選擇要轉換的物件
2. 3D-conv-house 向該轉換器詢問「需要哪些圖片、有哪些選項」，右側顯示說明，左側出現對應的上傳格
3. 依照說明上傳圖片、調整設定，按 **開始轉換**
4. 左側出現可以旋轉的 3D 預覽，按 **下載 .glb** 即可放進 Unity、Godot、three.js、Blender 等

## 快速開始（本機）

需要 Node.js **22.13 以上**。目前的測試版本會連到 **card-uploader**，所以兩個都要啟動：

```bash
# 終端機 1：卡片轉換器（card-uploader）
cd card-uploader
npm install
npm start            # http://localhost:3000

# 終端機 2：3D-conv-house
cd 3D-conv-house
npm install
npm start            # 打開 http://localhost:4000
```

選「🃏 卡片」→ 上傳正面（與背面）圖 → 開始轉換 → 下載 `card-xxx.glb`。

### 環境變數

| 變數 | 預設 | 說明 |
| --- | --- | --- |
| `PORT` | `4000` | 伺服器埠號 |
| `CONVERTER_<ID>_URL` | `converters.json` 裡的 `url` | 覆寫某個轉換器的網址，例如 `CONVERTER_CARD_URL=https://card-uploader.onrender.com` |
| `MAX_UPLOAD_MB` | `40` | 單次轉換上傳的總大小上限 |

## 新增一種物件（轉換器）

1. 在新的 repo（例如 `3D-conv-hat`）實作下面的 **轉換器協定**
2. 在 `converters.json` 加一筆（或把原本 `url: null` 的那筆填上網址）：

```json
{ "id": "hat", "name": "帽子", "icon": "🎩", "repo": "Dot7dot/3D-conv-hat", "url": "https://3d-conv-hat.onrender.com" }
```

| 欄位 | 說明 |
| --- | --- |
| `id` | 小寫英數與 `-`，也用在 `CONVERTER_<ID>_URL` |
| `name` / `icon` | ITEMS 下拉選單顯示的名稱 |
| `repo` | GitHub repo，顯示在說明區 |
| `url` | 轉換器的網站根網址；`null` 代表「即將推出」，選單裡會顯示但無法選 |
| `path` | 轉換 API 的路徑，預設 `/api/convert` |

UI 完全依照轉換器回傳的 manifest 產生，新增物件**不需要改 3D-conv-house 的程式**。

## 轉換器協定 `3d-conv/1`

轉換器只要提供兩個 API（以 `path` = `/api/convert` 為例）：

### `GET /api/convert/manifest`

告訴 UI 需要上傳什麼、有哪些選項：

```json
{
  "protocol": "3d-conv/1",
  "id": "card",
  "name": "卡片",
  "description": "把卡牌圖片轉成 3D 卡片",
  "instructions": ["請上傳 1～2 張圖片：", "① 正面（必填）…", "② 背面（選填）…"],
  "inputs": [
    { "key": "front", "label": "正面", "required": true,  "accept": ["image/png", "image/jpeg"], "hint": "卡面圖", "image": { "maxDimension": 2048 } },
    { "key": "back",  "label": "背面", "required": false, "accept": ["image/png", "image/jpeg"], "hint": "卡背圖" }
  ],
  "options": [
    { "key": "thickness", "label": "厚度", "type": "number", "unit": "mm", "default": 0.6, "min": 0.1, "max": 50, "step": 0.1 },
    { "key": "edgeColor", "label": "側邊顏色", "type": "color", "default": "#f4f1ea" },
    { "key": "aspect", "label": "寬高比", "type": "select", "default": "image", "choices": [{ "value": "image", "label": "依圖片" }] }
  ],
  "output": { "format": "glb", "mimeType": "model/gltf-binary", "extension": ".glb" }
}
```

- `inputs[].image.maxDimension`：有設定時，瀏覽器會先把圖片轉正（EXIF）、縮到長邊不超過這個值，再轉成 PNG（原圖可能透明時）或 JPG 上傳，
  所以手機照片、WEBP、HEIC（瀏覽器能讀時）都能用
- `options[].type`：`number`、`color`（`#rrggbb`）、`select`、`text`

### `POST /api/convert`

`multipart/form-data`：每個 input 的 `key` 是一個檔案欄位，每個 option 的 `key` 是一個文字欄位。

- 成功：`200`，內容是 3D 檔（`Content-Type: model/gltf-binary`），可以加 `Content-Disposition` 與 `X-Model-Dimensions`（例如 `63x88x0.6mm`，會顯示在預覽上方）
- 失敗：`4xx` + `{ "error": "給使用者看的訊息" }`，3D-conv-house 會原封不動顯示給使用者

## 3D-conv-house 的 API

| 方法 | 路徑 | 說明 |
| --- | --- | --- |
| `GET` | `/api/converters` | 所有物件：`[{ id, name, icon, repo, available }]` |
| `GET` | `/api/converters/:id/manifest` | 轉接到該轉換器的 manifest |
| `POST` | `/api/converters/:id/convert` | 把上傳內容直接轉送給轉換器，回傳 3D 檔 |

瀏覽器只跟 3D-conv-house 溝通，轉換器的網址不會暴露給使用者，也不用處理 CORS。
轉換器在免費主機休眠時（例如 Render 閒置 15 分鐘），第一次讀取 manifest 最多等約 75 秒，UI 會顯示「正在喚醒」。

## 部署到網路上（Render 免費方案）

1. 先依照 card-uploader 的 README 部署好卡片轉換器，記下它的網址
2. 到 [render.com](https://render.com) → **New → Blueprint**，選這個 repo，Render 會讀取 `render.yaml`
3. `CONVERTER_CARD_URL` 填入 card-uploader 的網址（例如 `https://card-uploader.onrender.com`），按 **Deploy**

## 開發

```bash
npm run dev   # 存檔自動重啟
npm test      # 測試（用假的轉換器，不需要啟動 card-uploader）
```

```
converters.json   物件清單：每種物件對應哪個轉換器 repo
src/
  server.js       啟動伺服器
  app.js          物件清單、manifest 轉接、轉換轉送
public/           UI（純 HTML/CSS/JS，無需建置）；3D 預覽使用 <model-viewer>，由伺服器從 node_modules 提供
test/             API 測試
render.yaml       Render 部署設定
```
