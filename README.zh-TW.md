# ziwei-mcp — 紫微斗數 MCP 服務端

> 🌐 [English](README.md) | **繁體中文** | [简体中文](README.zh-CN.md)
>
> 本文為 README.md 的繁體中文版本，內容以英文版為準。

以確定性方式排盤的[紫微斗數](https://en.wikipedia.org/wiki/Ziwei_doushu)命盤 + 四化層級
伺服器，透過**兩種 MCP transport** 提供服務：stdio（Phase 1，本地端客戶端）與 Streamable
HTTP（Phase 2，`http.ts`，LAN／遠端客戶端，bearer token）。無狀態（出生資料於每次呼叫時
提供，不作任何儲存），伺服器內部完全不使用 LLM —— 純引擎運算。

## 目錄結構與邊界

- `tools.ts` — 共用工具實作 + 與 transport 無關的 JSON-RPC dispatcher，
  由兩個進入點**原封不動（VERBATIM）**匯入（單一事實來源；無分叉邏輯）。
- `index.ts` — Phase 1 進入點：stdin/stdout 上以換行分隔的 JSON-RPC 2.0
  （僅用 stdlib，**不需要 npm install**）；是 `tools.ts` 之上的輕量接線。
- 引擎（唯讀，鎖定 `906bd93`）：`../../vendor/ziwei-doushu/lib/ziwei/`
  （`algorithm.generateChart`、`sihua.*`、`true-solar-time.*`）。絕不修改。
- 真太陽時修正於 `tools.ts` 內套用：引擎的 `generateChart`（≥ 906bd93）僅在
  同時提供 `origInput` 鐘錶時間區塊時才會消費 `birthInfo.longitude`，本服務
  並不發送該區塊；因此該修正（經度 + 均時差 → 時辰地支 + 日偏移，
  `next-day` 晚子規則）在呼叫引擎**之前**套用 —— 與 `scripts/ziwei-chart.ts`
  完全相同的單一修正路徑，輸出位元組相同。
- `http.ts` — Phase 2 進入點：以 `node:http` 實作 MCP **Streamable HTTP**
  純 JSON 回應模式的 daemon（見下文 HTTP 章節）。綁定 `0.0.0.0:9878`，
  每個 `/mcp` 請求都必須附 bearer token。
- `batch-stats-worker.mts` + `batch-stats-job.mts` — `ziwei_batch_stats` 的
  子行程輔助工具（以 `node:worker_threads` 平行列舉日期，僅用 stdlib；
  由 `tools.ts` 透過 vendored tsx binary 衍生 —— 同一引擎、同一鎖定
  commit、無需 npm install）。
- `.token` — HTTP bearer token（隨機 256-bit hex，**chmod 600**）。絕不記錄於
  log、絕不印出；僅以路徑引用。
- 本服務刻意置於 git fork（`vendor/ziwei-doushu`）**之外**，該 fork 保持純
  引擎角色，以便乾淨地與上游同步。出處聲明：上游
  [github.com/Renhuai123/ziwei-doushu](https://github.com/Renhuai123/ziwei-doushu)
  （MIT）。fork 的真太陽時修正於此處鏡射保留，並未 upstream 至 vendor。

## 安裝

需求：

- **Node.js ≥ 20**（僅用 stdlib —— 本服務無需 npm install）。
- **引擎依賴：** 需要一份 vendored 的紫微斗數引擎副本，鎖定至
  [github.com/Renhuai123/ziwei-doushu](https://github.com/Renhuai123/ziwei-doushu)
  的 commit `906bd93`（MIT；資料集為 CC BY 4.0 —— 見 `NOTICE`）。引擎**不會**
  隨本 repository 一併散布；請將你自己的 checkout 放在
  `<repo-root>/vendor/ziwei-doushu/`（目錄唯讀），並在該目錄內完成
  `node_modules` 安裝。執行本服務所用的 `tsx` binary 即來自該 vendored
  `node_modules`：

```bash
git clone https://github.com/Renhuai123/ziwei-doushu vendor/ziwei-doushu
( cd vendor/ziwei-doushu && git checkout 906bd93 && npm install )
```

本服務隨後匯入 `vendor/ziwei-doushu/lib/ziwei/*`（algorithm、sihua、
true-solar-time、yunxian-context、constants、cities、lunar-solar、
heming-knowledge），以及來自 vendored `node_modules` 的 `lunar-javascript`。
其餘全部為 Node stdlib。

## 獨立執行

```bash
vendor/ziwei-doushu/node_modules/.bin/tsx services/ziwei-mcp/index.ts
```

然後在 stdin 輸入 JSON-RPC 行（每行一條）。stdout 只用於協議；log 輸出至 stderr。

```
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"cli","version":"0"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"ziwei_chart","arguments":{"year":1986,"month":12,"day":8,"hour":23,"minute":45,"gender":"male","longitude":114.2}}}
```

未知方法 → JSON-RPC `-32601`；工具層級的驗證錯誤會回傳 `result.isError:true`
（協議不受影響）；格式不良的行 → `-32700`。

## HTTP daemon（Phase 2）—— 遠端存取

```bash
systemctl --user start ziwei-mcp     # 開機自動恢復的 unit（Linger=yes，已 enable）
journalctl --user -u ziwei-mcp -f    # log（絕不含 token）
bash services/ziwei-mcp/tests/http-tests.sh   # 對線上 daemon 的 38 項斷言
```

- **URL：** `http://<host>:9878/mcp`（LAN 主機請自行代換位址；daemon 綁定 0.0.0.0）。
  部署時已驗證 port 9878 為空閒；若啟動時被佔用，daemon 會自動遞增
  （取 ≥ 9878 的下一個空埠）並在 log 中記錄實際 port。
- **Auth：** `Authorization: Bearer *** services/ziwei-mcp/.token)` 或 `?token=***<t>`
  query param（兩者皆可，常數時間比對）。缺少／錯誤 → **401**。
- **`GET /health`** — 無需 auth、不含命盤資料：`{"status":"ok","server":"ziwei-mcp","version":"0.3.1"}`。
- **Transport 模式（Streamable HTTP 規範）：**
  - **JSON 回應模式**（預設）：POST 單一 JSON-RPC 訊息或批次陣列，
    取回 `application/json`（僅通知的 POST 回 202）。
  - **SSE 串流模式**：`GET /mcp` 附 `Accept: text/event-stream`（＋ auth）
    開啟 server-push 串流 —— `Content-Type: text/event-stream`、no-cache、
    keep-alive。回應標頭 `Mcp-Session-Id` 帶有一條串流一個 UUID。
    串流以每 20 s 一次的 SSE **comment ping** 保持健康（可覆寫：
    `ZIWEI_MCP_SSE_KEEPALIVE_MS`）；最多 16 條併發串流
    （`ZIWEI_MCP_SSE_MAX_STREAMS`，超出 → 503）。附該標頭的 `DELETE /mcp`
    會關閉串流（200）；未知／沒有的 id → 404。客戶端斷線會被偵測並
    自動清理。
  - **不附** `Accept: text/event-stream` 的 `GET /mcp` → **405**（`Allow:
    GET, POST, DELETE`）—— 只有在明確進行 SSE 協商時才開啟串流。
  - 無論有無 `Mcp-Session-Id` 標頭，POST 內容的 dispatch 方式完全相同：
    **回應一律以 JSON 於 POST 連線返回**（規範允許），絕不會改送到
    SSE 串流。這使不含標頭的 curl 路徑與前一版保持 byte 相同。我們的
    工具只有 request/response 往來，因此直至今日都不會有任何
    server 發起的 JSON-RPC 訊息被推到串流上 —— 串流的存在是為了那些
    必須保持連線才能接駁、且具備 push 能力的 MCP 客戶端。
- **併發模型：** Node 單執行緒 event loop；排盤運算為同步 CPU（約 10–50 ms），
  請求自然串行 —— 無共享狀態，任何併發下都安全。body 上限 1 MiB。

遠端客戶端設定範例（多數 MCP 客戶端接受以 `url` 欄位取代 `command` 來接
streamable HTTP；請代換 `<host>` 並從 `.token` 讀取 token）：

```json
{
  "mcpServers": {
    "ziwei-mcp": {
      "url": "http://127.0.0.1:9878/mcp",
      "headers": { "Authorization": "Bearer <token-from-.token>" }
    }
  }
}
```

## 工具（10 個 —— 格局批次 2026-11-10）

| 工具 | 一句話說明 |
|---|---|
| `ziwei_chart` | 由國曆出生資料產生完整本命盤 JSON（提供 `longitude` 時套用真太陽時修正） |
| `ziwei_patterns` | 2026-11-10 新增：格局辨識 ＋ 命宮摘要 —— 41 個通用識別器 ＋《紫微斗數全書》卷一嚴格格表（定貴／定富／定貧賤，帶原書條目號），`patterns[].strict` 區分兩族 |
| `ziwei_sihua_layers` | 四化層級：大限／流年／流月 ＋ 流日／流時（日與時：僅供參考） |
| `ziwei_from_city` | 以城市名稱（中文或常見英文名）排盤，經 vendored `cities.ts` 解析；明確提供 `longitude` 時以其為準 |
| `ziwei_solar_lunar` | 雙向國曆⇄農曆轉換 ＋ 結果之四柱（1900–2050） |
| `ziwei_selftest` | 內建黃金標準回歸自測 → `{pass, checks[]}`，確定性 |
| `ziwei_compatibility` | 合盤：以 vendored `heming-knowledge.ts` 作雙人比較 —— 結構化發現，不捏造分數 |
| `ziwei_batch_stats` | 於確定性的日×時列舉上的語料分佈（`hours:"all"` 自 2026-11-04 起為預設；非隨機抽樣；非人口代表性）。計數為**每星出現次數**而非每命盤 —— 總和可能超過 `chartsComputed`；見下方說明 |
| `ziwei_school_compare` | 同一出生日期依引擎支援的每個約定（lateZishi × leapMonth）分別排盤 ＋ 差異摘要 |
| `ziwei_render` | 十二宮格以純字串 SVG 呈現（4×4 ＋ 中央 meta，siHua 以顏色區分） |

呼叫範例（一律透過 `tools/call` 的 params.arguments）：

```jsonc
// ziwei_patterns —— 出生參數同 ziwei_chart；可選 leapMonth 閏月約定
{"year":1986,"month":12,"day":8,"hour":23,"minute":45,"gender":"male","longitude":114.2}
// ziwei_from_city —— 「Hong Kong」等同經度 114.2
{"year":1986,"month":12,"day":8,"hour":23,"minute":45,"gender":"male","city":"Hong Kong"}
// ziwei_solar_lunar —— 只能提供其中一端
{"lunar":{"year":1986,"month":11,"day":8}}
// ziwei_selftest —— 無需參數
{}
// ziwei_compatibility —— 兩個出生資料
{"a":{"year":1986,"month":12,"day":8,"hour":23,"minute":45,"gender":"male","longitude":114.2},
 "b":{"year":1994,"month":6,"day":15,"hour":8,"minute":0,"gender":"female"}}
// ziwei_batch_stats —— 確定性的日×時統計（預設 hours:"all"）
{"question":"wuxingJu-distribution","gender":"male","yearFrom":1950,"yearTo":2000,"maxCharts":5000}
// ziwei_batch_stats —— 舊式單一時辰模式（重現 2026-11-04 之前的行為）
{"question":"wuxingJu-distribution","gender":"male","yearFrom":1950,"yearTo":1950,"hours":[6]}
// ziwei_sihua_layers —— 流日/流時層級需要 flowDate（流時另需 flowHour）
{"year":2026,"gender":"male","birth":{"year":1986,"month":12,"day":8,"hour":23,"minute":45,"longitude":114.2},
 "layers":["liuri","liushi"],"flowDate":{"year":2026,"month":11,"day":3},"flowHour":10}
// ziwei_school_compare / ziwei_render —— 出生資料格式同 ziwei_chart
{"year":1986,"month":12,"day":8,"hour":23,"minute":45,"gender":"male","longitude":114.2}
```

### `ziwei_chart`

完整本命盤 JSON（宮位、星曜、亮度、siHua 標記、大限、四柱）。

| 欄位 | 型別 | 備註 |
|---|---|---|
| `year` `month` `day` | int | 國曆（格里高利）日期；不存在的日期會被拒絕 |
| `hour` | int 0-23 | 當地**時鐘**小時（`23` → 晚子：命盤日期進一位） |
| `minute` | int 0-59 | |
| `gender` | `"male"`\|`"female"` | |
| `longitude` | number? | 東經度數；啟用真太陽時修正 |
| `latitude` | number? | 可接受但不生效（修正僅使用經度 + 均時差） |
| `leapMonth` | `"split"`\|`"next-month"`\|`"prev-month"`\|`"origin-month"`? | 2026-11-10：闰月歸屬約定（預設 `split` = 月中分界，主流口徑；`next-month` = 倪師派；無效值會被明確錯誤拒絕）。省略時維持引擎預設 —— 輸出與 2026-11-10 之前的呼叫位元組完全相同 |

結果：`{ meta: {effectiveDate, hourBranch, trueSolarTime, fourPillars, rawInput, ...}, chart: <完整 ZiweiChart> }`。
未提供 `longitude` 時修正不生效（同一命盤；`meta.trueSolarTime:null`）。

> **`birthInfo` vs `meta.rawInput`（2026-11-04）：** `chart.birthInfo` 反映的是
> **引擎修正後的有效輸入**（例如 23:00 的晚子出生會顯示 `day+1`、`hour:0`）。
> 若要回顯呼叫端的**原始**數值，請讀 `meta.rawInput`
> （`{year,month,day,hour,minute,gender[,longitude][,latitude][,leapMonth]}`）——
> 依原樣收到的精確參數，絕未被位移。正午案例亦同：引擎會正規化
> 小時的表示方式。

### `ziwei_patterns`（2026-11-10 新增）

於內部產生的本命盤之上做確定性的格局辨識 ＋ 命宮摘要。出生參數與
`ziwei_chart` 完全相同（含 `longitude` 真太陽時修正與 `leapMonth` 闰月約定）；
`ziwei_chart` 本身的輸出形狀保持不變。

兩族識別器，以 `patterns[].strict` 區分：

- **strict `true`** —— 《紫微斗數全書》卷一的四張格表（定貴局 27 / 定富局 6 /
  定貧賤局 8；定雜局非本命盤可判）。依原書注文逐字判定，不放寬。每條命中
  在 `source` 帶原書條目號（`《紫微斗數全書·卷一·定貴局》第N條`），
  `description` 即原書注文。
- **strict `false`** —— 41 個通用識別器（機月同梁、殺破狼、府相朝垣……），
  帶分層 `conditions`（`required` / `bonus` / `breaking`），其中四化加分線經
  引擎的 `palaceHasSiHua` / `sanFangHasSiHua` 判定。

`mingGong` 攜帶命宮脈絡：`branch`、`mainStars`、`nature`、`keywords`；命宮
空宮時另有 `borrowedFrom` 塊，標出所借對宮之宮名與主星（空宮借星）。
`counts` 給出 `{total, strict, loose}`。

```jsonc
// 黃金錨點盤
{"year":1986,"month":12,"day":8,"hour":23,"minute":45,"gender":"male","longitude":114.2}
// 命宮空宮範例 —— 會回報 borrowedFrom
{"year":1990,"month":5,"day":20,"hour":8,"minute":0,"gender":"female"}
```

### `ziwei_sihua_layers`

於內部產生的本命盤之上疊加四化層級。鍵為中文：`禄/权/科/忌`；每個轉化經
`chart.palaces[].stars[].name` 對應到 `{star, palace}`。

| 欄位 | 型別 | 備註 |
|---|---|---|
| `year` | int | 該層級窗口的西元年（提供 `yearWindow` 時可省略） |
| `yearWindow` | string? | 2026-11-04：以干支對（例如 `"丙午"`）取代 `year` —— 天干地支直接取自該對，消除流年/流月/流日/流時的立春邊界陷阱 |
| `gender` | `"male"`\|`"female"` | |
| `birth` | object | `{year,month,day,hour,minute,longitude?}` —— 語義同 `ziwei_chart` |
| `layers` | array | `"daxian"`、`"liunian"`、`"liuyue"`、`"liuri"`、`"liushi"` 的任意組合 |
| `month` | int 1-12? | **國曆**月份，除非提供 `lunarMonth`/`flowDate` 否則 `liuyue` 需要（於月中內部轉換為農曆月） |
| `lunarMonth` | int 1-12? | 直接以農曆月作 `liuyue`（取代 `month` 的另一選擇） |
| `flowDate` | `{year,month,day}`? | 2026-11-04：提供時也會**逐日**解析 `liuyue` —— 可定住閏月跨段邊界（`liuri`/`liushi` 本來就必須提供） |

層級語義（依 `references/time-layers.md`）：

- `daxian` — 天干 = **大限宮天干**，非出生年天干
  （`getDaXianSiHua`）；含 `ageRanges`、`currentLayerIndex`、`ageRange`、`xuSui`
  （虛歲 = 該年 − 農曆生年 + 1）。幼年年份以 `CHILDHOOD_DAXIAN_INDEX` 解析。
- `liunian` — 天干 = 年干（`(year-4)%10`）。
- `liuyue` — 五虎遁月干（`getLiuYueSiHua`）；閏月帶其基準月的天干。
  **FIXED 2026-11-04：** 年干現在取自流日日期立春精確的干支年
  （引擎 `getEightChar().getYear()`），而非請求的西曆年份 —— 舊式兩套來源
  混用的做法對立春前的國曆日期（約 2 月 4 日前）是錯的：例如 2026-01 屬
  乙巳年農曆十一月 → 戊子（舊結果 庚 ✗）；2025-01 → 甲辰年十二月 → 丁丑
  （舊 己 ✗）；2027-01 → 丙午年十二月 → 辛丑（舊 癸 ✗）。立春後的行為不變
  （2026-03 = 丙午正月 = 庚寅，已驗證）。回應中會回顯 `yearStemUsed` +
  `ganzhiYear` 供客戶端稽核。**FIXED 2026-11-04（2，閏月跨段）；UNIFIED
  2026-11-05：** 提供 `flowDate` 時農曆月**逐日**解析 —— 2023-04-25 是三月初六
  → 天干丙，而 2023-04-05 是閏二月十五 → 天干乙（癸卯年五虎遁）。僅給月份
  （單獨 `month`）現在對所有跨段類型採**單一統一規則**：**解析為該國曆月份
  15 日所在的農曆月**（月中規則）。舊式專為閏月設計的「後段」特例已移除。
  若要精確定住某一天請提供 `flowDate`。僅按月查詢的決策欄位為描述性的
  `monthSpan`（該國曆月所涵蓋農曆月的有序清單，各含 `{lunarMonth, isLeap}`，
  已去重）與 `resolvedAs`（指明取樣日期的精確解析結果，例如
  `m1 (lunar month containing 2026-03-15)`）。`ambiguousMonth: true` 基於向後
  相容保留，但在僅按月路徑上實質恆為 true（農曆月約 29.5 日比任何國曆月
  都短，因此首日與末日必然不同 —— 恆定的布林值不帶訊號）；`note` 會指向
  `monthSpan`/`resolvedAs`。參考值（僅按月）：2023-04 → **乙**（2023-04-15 =
  閏二月十五；舊式後段規則為 丙 —— 唯一一次天干改變）、2026-01 → **戊**、
  2026-03 → **庚**。一月自測檢查（#9/#10）不變。

#### 月制慣例（農曆月 —— 若你遵循節氣月慣例請務必閱讀）

**本引擎的 `liuyue` 使用農曆月**：五虎遁套用於 queried 日期**轉換後的農曆月**，
閏月帶其基準月的天干。主流飛星實務多以**節氣月**替代（清明起即屬辰月，
不論農曆日期）。兩套慣例於月份邊界附近會結構性分岔 —— 例如 2026 年 1 月中旬：
農曆慣例得 **戊子**，節氣慣例得 **辛丑**。目前並無 `solarTerm` 模式
（設計決定尚未作出）。若你的做法遵循節氣，請預期月份邊界處的差異；
請使用 `flowDate` 定住確切日期，並稽核每個流月 payload 中的
`lunarMonth`/`isLeapMonth`。
- `liuri`/`liushi` — 日/時天干；不受上述 bug 影響（內部使用農曆年／日干，
  並非兩套來源混用）。
- `yearWindow`（FEATURE A）— `"丙午"` ≡ `year:2026`；無效的干支對（不明字元或
  六十甲子配對錯誤，例如 `"甲丑"`）→ `isError`。每個層級都會回顯
  `yearStemUsed`/`ganzhiYear`。僅提供 `yearWindow` 時，曆法查詢（大限區間、
  國曆→農曆月）使用符合該干支對的代表性現代週期年份 1984–2043。

## 測試

```bash
bash services/ziwei-mcp/tests/run-tests.sh     # stdio A-G，9/9（E = 全工具批次，F = bugfix/feature 回歸含 2026-11-05 統一跨段規則，G = 2026-11-05 深度修正套件：鏡射交叉檢查、jiFlags、lunarMonth 四路徑表、邊界、日位移、ignoredKeys）
bash services/ziwei-mcp/tests/http-tests.sh    # HTTP：auth、protocol、batch、gold、SSE、全部工具 + 2026-11-04/05 斷言（38）
```

黃金基準錨點（全數在 repo 內、自給自足）：`tests/gold/chart-1986.json`
（ziwei_chart byte 相同；chart 物件絕不可改變）與 `tests/gold/render-default-1986.svg`
（預設 render byte 相同）。

參考（黃金標準）出生資料 —— 一個刻意非任何真實人物的**合成**基準日期：
`1986-12-08 23:45 male lon 114.2` → 有效日期 `1986-12-09`，四柱
丙寅/庚子/丁亥/庚子，命宮 子·天同(旺)（太陰同宮），土五局，命主 貪狼，
身主 天梁，生年四化：天同祿→命宮，天機權→官禄，文昌科→夫妻，廉貞忌→子女。

## 變更記錄

正式日期式變更記錄見 **[CHANGES.md](CHANGES.md)**（Keep a Changelog 格式，最新在上）。
以下逐段為各版本的詳細敘述性記錄。

## 變更記錄 —— 2026-11-11（v0.3.1：batch-stats OOM 加固）

**`ziwei_batch_stats` 記憶體限幅** —— 批次工作行程原先最多平行 12 個執行緒，
各自載入引擎與農曆表；在記憶體緊張的主機上，核心 oom-killer 會殺死子行程
（exit 137），而工具將其掩蓋為 120 秒逾時。現依可用記憶體（`freemem()`，
約每工作行程 512 MB）連同 CPU 平行度一併限幅工作行程數，OOM 遭殺時以
明確的 `killed by SIGKILL (likely OOM …)` 錯誤呈現並載明啟動時可用記憶體。
新增測試章節 H 覆蓋此迴歸。黃金 `ziwei_chart` 輸出不變（位元組相同）。

**版本：** 兩個 transport 均為 **0.3.1**。

## 變更記錄 —— 2026-11-10（格局批次：`ziwei_patterns` 工具 ＋ `leapMonth` 參數）

**新工具 `ziwei_patterns`** —— 專用的格局辨識 ＋ 命宮摘要，基於引擎的
`detectPatterns` / `getMingGongSummary`（引擎鎖定 `495b79e` → `906bd93`，後者新增
《紫微斗數全書》卷一嚴格格表與修正後的四化加分邏輯）。`ziwei_chart` 的輸出
形狀未變（黃金命盤輸出經驗證前後位元組相同）；新工具的存在使既有消費方
完全不會看到形狀變化。

**`leapMonth` 參數**（`ziwei_chart` 與 `ziwei_patterns` 兩者）：可選闰月約定
`split`（預設）/ `next-month` / `prev-month` / `origin-month`，透傳至引擎。
無效值以列出可接受值的清晰 ToolError 拒絕（引擎本身會拋 `RangeError` ——
上游 #71 —— 本包裝層將其乾淨地呈現）。省略該參數即維持引擎預設（`split`）
與 2026-11-10 之前的精確位元組。

**自測：** `ziwei_selftest` 新增檢查 14–17（共 17 項）：黃金盤檢出格局清單、
四化加分反向控制（文昌化科位於黃金盤三方四正之外 → `再會化科` 加分
必須**不**觸發），以及兩個嚴格卷一表的正例 fixture（1978-07-01 11:00 male →
七殺朝斗 定貴局第11條 ＋ 殺破狼 化禄/化权 加分經 `sanFangHasSiHua` 觸發；
1990-05-20 08:00 female → 坐貴向貴 定貴局第9條）。黃金錨點盤本身觸發零個
嚴格條目（天同太陰在子與 49 條格表均不符）—— 改以 fixture 鎖定。

**交叉核對：** 工具的格局清單與 CLI 參考（`scripts/ziwei-chart.ts` 的
`detectPatterns` 輸出）在黃金盤與 fixture 盤上完全一致。

**版本：** stdio 0.1.0 → **0.3.0**，HTTP 0.2.0 → **0.3.0**（統一；兩個 transport
都攜帶新工具）。`tools/list` 現返回 10 個工具。

**契約：** 黃金 `ziwei_chart` 輸出位元組相同；預設 render SVG 位元組相同；
`ziwei_chart` 僅增加 `leapMonth`（輸入）與 `meta.leapMonth` /
`meta.rawInput.leapMonth`（提供時回顯）。本批次無 vendor 變更 —— 引擎已在
906bd93。

## 變更記錄 —— 2026-11-05 07:45（深度審查修正：鏡射測試、lunarMonth 路徑、jiFlags、async batch_stats、參數衛生）

來自 2026-11-05 深度審查的六項修正。黃金命盤 + 預設 render SVG 全程
byte 相同；自測現為 **13 項檢查**（新增 `lunarMonthDirect2026`）。

1. **`ziwei_compatibility` 鏡射測試方向相反（CRITICAL）。** 交叉檢查拿每一方
   夫妻宮的星曜對比其**自己**的命宮，而非對方的 —— `tianZuoZhiHe` 因此永遠
   無法表達方法論 §2。現修正為：A 的夫妻星 ⊂ B 的命宮 **且** B 的夫妻星 ⊂ A 的命宮。
   **可觀察差異：** `tianZuoZhiHe` 現在可以為 `true`（舊版實質恆為 false）；
   `aFuqiStarsInBMing` / `bFuqiStarsInAMing` 現在如實回報真正的交叉重疊
   （舊版自我過濾）。黃金正面案例：`{a:1970-05-15 10:00 male, b:1988-11-15
   10:00 female}` → 武曲⊂(武曲天府) + 破军⊂(破军) → `true`。自配對（a=b）只有在
   自己夫妻宮的星曜剛好也在自己命宮時才平凡為 true —— 一般命盤（例如黃金
   出生資料）仍為 `false`；明細字串會點名該規則。
2. **`ziwei_sihua_layers` 直接 `lunarMonth` 路徑的兩套來源 bug（CRITICAL）。**
   農曆月的**數字**被當作**國曆**月份餵入，因此 `lunarMonth:1` 永遠以國曆
   1 月 15 日解析 = 立春前 → 年干錯一個干支年（2026 正月曾回傳 戊/乙巳
   而非 庚/丙午）。現改經 vendored 農曆表解析：參考 = 農曆（year, m, 15）對應的
   國曆日期。m1 於 2022–2028 的四路徑一致性成立（壬 甲 丙 戊 庚 壬 甲）。m12
   邊界：月中落在次年立春前 → 天干仍屬 `year` 的干支年（2026 m12 → 國曆
   2027-01-22 → 丙午 → 辛，不變）。新增 `isLeapMonth:true` 驗證：無閏月之年
   或錯誤閏月 → `isError`（舊版靜默忽略）。Schema 明確文件化 `isLeapMonth`。
3. **`jiFlags` 夫妻比較形同虛設（MAJOR）。** 引擎宮位名稱除命宮外均不帶「宮」
   後綴；`jiPalace === '夫妻宫'` 永遠匹配不到。修正為 `'夫妻'` —— 化忌入對方
   夫妻宮的旗標現在生效（已驗證配對：A 1960-01-05 00:00 male → 文曲化忌落入
   B 1963-07-05 00:00 male 的夫妻宮）。
4. **`ziwei_batch_stats` 阻塞 event loop（MAJOR）。** 同步 `execFileSync`（最長
   120 s）改為 async `spawn`；`dispatch()` 現在是 async，兩個進入點都會 await。
   **可觀察差異：** 完整範圍批次執行期間 `/health` 仍於 <50 ms 回應
   （預設 1950–2000 統計期間實測 13–23 ms × 3）。其餘輸出契約不變。
5. **未知參數會被回顯而非靜默丟棄。** Schema 宣告 `additionalProperties:false`
   但執行面維持寬容以兼容客戶端相容性（硬拒絕會破壞既有呼叫端）。當出現
   未知的頂層參數時，回應 meta 中會出現 `meta.ignoredKeys` +
   `meta.ignoredKeysNote`，精確列出被忽略的欄位。
6. **次要群組：** `year` + `yearWindow` 並存 → `isError`（舊版靜默拆來源）；
   `ziwei_solar_lunar` 國曆方向限定 1900–2050（超出範圍曾回傳看似合理但錯誤的
   日期；現為 `isError`，與農曆方向一致）；liushi `flowHour:23` 現套用與本命
   解析器相同的次日位移（舊版用同日的日干 —— 已驗證：2026-11-05 23:xx ==
   2026-11-06 00:00 層級，甲申）；README/http-tests 斷言數修正為 38
   （舊為「21」/「32」，皆過期）。

## 變更記錄 —— 2026-11-05 05:01（流月僅按月查詢的描述性 span 欄位，審查者第三輪跟進）

**僅新增：** 僅按月的 `liuyue` payload 增加兩個描述性欄位：

- **`monthSpan`** —— 該國曆月所涵蓋農曆月的有序陣列，各含
  `{lunarMonth, isLeap}`，已去重（未跨段的月份 → 單元素陣列）。
  例：`{2026, month:3}` → `[{lunarMonth:1,isLeap:false},{lunarMonth:2,isLeap:false}]`。
- **`resolvedAs`** —— 指明取樣日期的確定性解析字串，
  例如 `m1 (lunar month containing 2026-03-15)`。

**為何不用布林值：** 統一月中規則之後，`ambiguousMonth:true` 幾乎會在
**每一次**僅按月查詢觸發（農曆月約 29.5 日比任何國曆月都短，因此首日與
末日必然不同）。恆定的布林值不是訊號 —— 任何寫 `if (ambiguousMonth) warn()`
的客戶端會得到 100% 警告率，最終乾脆關閉警告，連真正模糊案例的訊號也一併
喪失。因此 `ambiguousMonth` 降級為向後相容旗標（數值/語義不變），
`monthSpan`/`resolvedAs` 成為決策欄位；`note` 現已明確說明。`flowDate` 仍是
精確路徑 —— flowDate payload 保持 byte 相同（該路徑無新欄位）。黃金命盤 +
預設 render SVG byte 相同；自測維持 12 項檢查。

## 變更記錄 —— 2026-11-05（統一僅按月 tie-break，審查者第三輪）

**`liuyue` 僅按月解析現在對所有跨段類型採單一規則：**

- **月中規則：** 單獨 `month` 查詢解析為該國曆月 **15 日**所在的農曆月。
  專屬於閏月的「後段」特例已**移除** —— 兩條路徑（閏月/普通）現在的
  tie-break 完全相同。
- **`ambiguousMonth` 標記**任何**邊界跨段：** 當國曆月的首日與末日映射到
  不同農曆月（不論閏與否），旗標 + `note`（建議 `flowDate`）即觸發。由於
  農曆月（約 29.5 日）比任何國曆月都短，幾乎每個僅按月查詢現在都會被
  如實標記，而非像過去那樣靜默選擇前段、只在罕見閏跨段才警告
  （第二輪的不對稱）。
- **為何不選「後段遍佈」**（審查者的另一方案）：就一月而言，後段（例如
  2025-01-29/31）已是**下一個**干支年的農曆正月，而立春推得的年干仍是
  **當前**年 —— 將正月與立春前的年干配對，會重新引入已兩度修正的兩套
  來源 bug 類別（2026-11-04 #1/#4）。月中取樣絕不會落入該缺口窗口。
  已驗證的後果：後段方案會使 2026-01 戊→己翻轉、2025-01 落入缺口窗口的
  亂數；月中規則讓兩項一月自測檢查（#9 丁、#10 戊）原封不動通過。
- **可觀察變化：** 2023-04 僅按月 **丙 → 乙**（2023-04-15 = 閏二月十五 →
  閏二月基準月干 乙）—— 唯一一次天干改變。新增旗標、天干不變：
  2026-01 → 戊+旗標、2025-01 → 丁+旗標、2026-03 → 庚+旗標。所有 `flowDate`
  結果不變（逐日路徑未動：2023-04-25 → 丙、2023-04-05 → 乙）。黃金命盤 +
  預設 render SVG byte 相同。
- **自測：** 檢查 12 `ordinaryStraddle2026Mar` 鎖住普通邊界防線（僅按月
  2026-03 → 天干 庚 **且** `ambiguousMonth` true）。檢查數 ≥ 12。
  Fail-first：測試先於修正撰寫，確認對舊碼失敗（2026-03 無旗標、2026-01
  無旗標、2023-04 → 丙），再轉為通過。
- **契約：** 9 個工具不變；無 vendor/engine 變更。

## 變更記錄 —— 2026-11-04（bugfix + feature 批次，由外部客戶端測試發現）

**Bug 修正**（每項皆 fail-first：回歸測試先確認對舊碼失敗，再修正，再確認
通過 —— 見 `tests/run-tests.sh` 區段 F）：

1. **流月天干於立春/農曆年邊界的錯誤（CRITICAL）。** 五虎遁的年干取自
   *請求的西曆年份*，而月份數字取自*農曆*轉換 —— 兩套來源，對立春前的
   日期是錯的。現兩者都由同一流日日期透過引擎自身立春精確的表推得。
   修正數值：2025-01 → 丁（舊 己）、2026-01 → 戊（舊 庚）、2027-01 → 辛（舊 癸）。
   payload 會回顯 `yearStemUsed` + `ganzhiYear`。已檢查 `liuri`/`liushi` ——
   它們**不**共用此 bug（天干來源不同），維持原樣。
1b. **流月閏月跨段（當日晚间修正）。** 跨越閏月邊界的國曆月（2023-04：
   4/19 前屬閏二月，之後屬三月）以月中取樣解析 —— 每個四月日期都回傳
   閏月段（乙 ✗；2023-04-25 = 三月初六應為 丙）。現 `flowDate` 會逐日解析
   農曆月；跨段月份的單獨 `month` 查詢回傳後段的干加 `ambiguousMonth: true`
   + `note`。自測檢查 11（`liuyueStem2023Apr25` → 丙）將其鎖住；檢查數 ≥ 11。
   上方**月制慣例**說明文件化了農曆月選擇的根因。
   *（2026-11-05 已被取代：後段 tie-break 已由統一月中規則取代 —— 見上方
   2026-11-05 變更記錄。）*
2. **`birthInfo` 回顯修正後的值而非原始輸入。** `chart.birthInfo` 刻意不變
   （byte 相同契約）；每個 `ziwei_chart` 結果新增 `meta.rawInput` 以回顯精確的
   呼叫端參數。整合者：請讀 `meta.rawInput` 而非 `birthInfo` 取得原始數值。
3. **`ziwei_batch_stats` 固定時辰偏差。** 預設現為 `hours:"all"` —— 於日 × 12
   時辰做統計（於槽位空間做跨距細分）。`hours:[6]`（或舊式 `hourBranch`）
   重現舊版正午專用的行為。`maxCharts` 上限（預設 5000）使預設 1950–2000
   執行約 25 s（實測 24.9 s、4968 盤）—— 遠低於 120 s 子行程限制；不設上限的
   完整統計約需 2.5 分鐘，刻意不作預設。

**`ziwei_batch_stats` 計數說明（2026-11-04）：** 分佈計數為**每星出現次數，
非每命盤** —— 命宮含兩顆主星的命盤（例如太陽巨門）會同時貢獻兩筆計數，
因此 `sum(counts)` 可能超過 `chartsComputed`（線上驗證：1985–86 為 5833 vs
4380）。若不先說明此點，請勿以計數除以 `chartsComputed` 宣稱人口占比。
結果 meta 現也會於 `chartsComputed` 旁輸出 `sumOfCounts` 供稽核。

**新功能：** A) `ziwei_sihua_layers` 的 `yearWindow` 干支模式（見上）；
B) `ziwei_compatibility` 的 `daXianCheck` 區塊 —— 雙方目前大限宮位地支/天干
＋旗標（同地支、同天干、同干支＝兩者皆是、各方大限干之忌飛入對方命宮）；
純結構、不加評分；C) `ziwei_render` 的 `layers:["liunian"|"daxian"]` 疊圖
（虛線角標 + 圖例列、第二色 `#7a4dbf`；`flowYear` 選定流年；預設純本命 SVG
與前一版輸出 byte 相同 —— 以 `tests/gold/` 為錨）。

**自測：** `ziwei_selftest` 新增檢查 9–10 —— 一月立春邊界的月干
（2026-01 → 戊、2025-01 → 丁），由引擎自身表格確定性計算；檢查 11
（2026-11-04 晚間）加入閏月跨段案例（2023-04-25 → 丙）。檢查數 ≥ 11。

**契約：** 工具數不變（9）；黃金命盤輸出 byte 相同；`ziwei_chart` 僅新增
`meta.rawInput`。無 vendor/engine 變更。

## Phase 2 說明（2026-11-01 交付）

工具邏輯移入 `tools.ts`，以 `dispatch()` 作為與 transport 無關的處理者；
兩種 transport 都是其上的薄殼。若未來設計需要引入狀態（儲存命盤），
必須以每次呼叫選擇加入 —— 讓伺服器可稽核的正是不變的無狀態契約。

### Phase 2b —— SSE 串流模式（2026-11-01）

`GET /mcp` 現在支援 SSE（見上方 Transport 模式）。Session 模型：每條開啟的
串流一個隨機 UUID，僅保存在記憶體 Map 中讓 `DELETE` 能定位它 —— 其餘什麼
都不存，daemon 跨請求保持無狀態。刻意保留的規範取捨：
- POST 回應即使附帶 session id 仍留在 POST 連線（JSON 模式）—— 沒有雙路徑
  回應路由，對既有客戶端零回歸風險。
- 沒有 `initialize` 發起的 session 生命週期（無 per-session 狀態、逾期或
  隔離）—— id 只與其串流同生滅。
- 串流只帶 comment（keep-alive）而不帶 JSON-RPC 框，因為沒有任何工具
  有內容要 push。

## 授權條款

MIT —— 見 [LICENSE](LICENSE)。Copyright (c) 2026 PeterYuen。

第三方出處聲明：本服務**包裝但不散布**來自
[github.com/Renhuai123/ziwei-doushu](https://github.com/Renhuai123/ziwei-doushu)
的紫微斗數引擎（引擎原始碼 MIT、資料集 CC BY 4.0）。本 repository 未複製
任何引擎原始碼或資料集內容 —— 使用者須依安裝章節自行 vendor 鎖定副本
（`906bd93`）。見 [NOTICE](NOTICE)。