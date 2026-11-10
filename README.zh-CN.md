# ziwei-mcp — 紫微斗数 MCP 服务端

> 🌐 [English](README.md) | [繁體中文](README.zh-TW.md) | **简体中文**

> 本文件为 README.md 的简体中文版本，内容以英文版为准。

以确定性方式排盘的[紫微斗数](https://en.wikipedia.org/wiki/Ziwei_doushu)命盘 + 四化层级
服务器，透过**两种 MCP transport** 提供服务：stdio（Phase 1，本地端客户端）与 Streamable
HTTP（Phase 2，`http.ts`，LAN／远端客户端，bearer token）。无状态（出生资料于每次呼叫时
提供，不作任何储存），服务器内部完全不使用 LLM —— 纯引擎运算。

## 目录结构与边界

- `tools.ts` — 共用工具实作 + 与 transport 无关的 JSON-RPC dispatcher，
  由两个进入点**原封不动（VERBATIM）**汇入（单一事实来源；无分叉逻辑）。
- `index.ts` — Phase 1 进入点：stdin/stdout 上以换行分隔的 JSON-RPC 2.0
  （仅用 stdlib，**不需要 npm install**）；是 `tools.ts` 之上的轻量接线。
- 引擎（唯读，锁定 `906bd93`）：`../../vendor/ziwei-doushu/lib/ziwei/`
  （`algorithm.generateChart`、`sihua.*`、`true-solar-time.*`）。绝不修改。
- 真太阳时修正于 `tools.ts` 内套用：引擎的 `generateChart`（≥ 906bd93）仅在
  同时提供 `origInput` 钟表时间区块时才会消费 `birthInfo.longitude`，本服务
  并不发送该区块；因此该修正（经度 + 均时差 → 时辰地支 + 日偏移，
  `next-day` 晚子规则）在呼叫引擎**之前**套用 —— 与 `scripts/ziwei-chart.ts`
  完全相同的单一修正路径，输出字节相同。
- `http.ts` — Phase 2 进入点：以 `node:http` 实作 MCP **Streamable HTTP**
  纯 JSON 回应模式的 daemon（见下文 HTTP 章节）。绑定 `0.0.0.0:9878`，
  每个 `/mcp` 请求都必须附 bearer token。
- `batch-stats-worker.mts` + `batch-stats-job.mts` — `ziwei_batch_stats` 的
  子行程辅助工具（以 `node:worker_threads` 平行列举日期，仅用 stdlib；
  由 `tools.ts` 透过 vendored tsx binary 衍生 —— 同一引擎、同一锁定
  commit、无需 npm install）。
- `.token` — HTTP bearer token（随机 256-bit hex，**chmod 600**）。绝不记录于
  log、绝不印出；仅以路径引用。
- 本服务刻意置于 git fork（`vendor/ziwei-doushu`）**之外**，该 fork 保持纯
  引擎角色，以便干净地与上游同步。出处声明：上游
  [github.com/Renhuai123/ziwei-doushu](https://github.com/Renhuai123/ziwei-doushu)
  （MIT）。fork 的真太阳时修正于此处镜射保留，并未 upstream 至 vendor。

## 安装

需求：

- **Node.js ≥ 20**（仅用 stdlib —— 本服务无需 npm install）。
- **引擎依赖：** 需要一份 vendored 的紫微斗数引擎副本，锁定至
  [github.com/Renhuai123/ziwei-doushu](https://github.com/Renhuai123/ziwei-doushu)
  的 commit `906bd93`（MIT；资料集为 CC BY 4.0 —— 见 `NOTICE`）。引擎**不会**
  随本 repository 一并散布；请将你自己的 checkout 放在
  `<repo-root>/vendor/ziwei-doushu/`（目录唯读），并在该目录内完成
  `node_modules` 安装。执行本服务所用的 `tsx` binary 即来自该 vendored
  `node_modules`：

```bash
git clone https://github.com/Renhuai123/ziwei-doushu vendor/ziwei-doushu
( cd vendor/ziwei-doushu && git checkout 906bd93 && npm install )
```

本服务随后汇入 `vendor/ziwei-doushu/lib/ziwei/*`（algorithm、sihua、
true-solar-time、yunxian-context、constants、cities、lunar-solar、
heming-knowledge），以及来自 vendored `node_modules` 的 `lunar-javascript`。
其余全部为 Node stdlib。

## 独立执行

```bash
vendor/ziwei-doushu/node_modules/.bin/tsx services/ziwei-mcp/index.ts
```

然后在 stdin 输入 JSON-RPC 行（每行一条）。stdout 只用于协议；log 输出至 stderr。

```
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"cli","version":"0"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"ziwei_chart","arguments":{"year":1986,"month":12,"day":8,"hour":23,"minute":45,"gender":"male","longitude":114.2}}}
```

未知方法 → JSON-RPC `-32601`；工具层级的验证错误会回传 `result.isError:true`
（协议不受影响）；格式不良的行 → `-32700`。

## HTTP daemon（Phase 2）—— 远端存取

```bash
systemctl --user start ziwei-mcp     # 开机自动恢复的 unit（Linger=yes，已 enable）
journalctl --user -u ziwei-mcp -f    # log（绝不含 token）
bash services/ziwei-mcp/tests/http-tests.sh   # 对线上 daemon 的 38 项断言
```

- **URL：** `http://<host>:9878/mcp`（LAN 主机请自行代换位址；daemon 绑定 0.0.0.0）。
  部署时已验证 port 9878 为空闲；若启动时被占用，daemon 会自动递增
  （取 ≥ 9878 的下一个空埠）并在 log 中记录实际 port。
- **Auth：** `Authorization: Bearer *** services/ziwei-mcp/.token)` 或 `?token=***<t>`
  query param（两者皆可，常数时间比对）。缺少／错误 → **401**。
- **`GET /health`** — 无需 auth、不含命盘资料：`{"status":"ok","server":"ziwei-mcp","version":"0.3.0"}`。
- **Transport 模式（Streamable HTTP 规范）：**
  - **JSON 回应模式**（预设）：POST 单一 JSON-RPC 讯息或批次阵列，
    取回 `application/json`（仅通知的 POST 回 202）。
  - **SSE 串流模式**：`GET /mcp` 附 `Accept: text/event-stream`（＋ auth）
    开启 server-push 串流 —— `Content-Type: text/event-stream`、no-cache、
    keep-alive。回应标头 `Mcp-Session-Id` 带有一条串流一个 UUID。
    串流以每 20 s 一次的 SSE **comment ping** 保持健康（可覆写：
    `ZIWEI_MCP_SSE_KEEPALIVE_MS`）；最多 16 条并发串流
    （`ZIWEI_MCP_SSE_MAX_STREAMS`，超出 → 503）。附该标头的 `DELETE /mcp`
    会关闭串流（200）；未知／没有的 id → 404。客户端断线会被侦测并
    自动清理。
  - **不附** `Accept: text/event-stream` 的 `GET /mcp` → **405**（`Allow:
    GET, POST, DELETE`）—— 只有在明确进行 SSE 协商时才开启串流。
  - 无论有无 `Mcp-Session-Id` 标头，POST 内容的 dispatch 方式完全相同：
    **回应一律以 JSON 于 POST 连线返回**（规范允许），绝不会改送到
    SSE 串流。这使不含标头的 curl 路径与前一版保持 byte 相同。我们的
    工具只有 request/response 往来，因此直至今日都不会有任何
    server 发起的 JSON-RPC 讯息被推到串流上 —— 串流的存在是为了那些
    必须保持连线才能接驳、且具备 push 能力的 MCP 客户端。
- **并发模型：** Node 单执行绪 event loop；排盘运算为同步 CPU（约 10–50 ms），
  请求自然串行 —— 无共享状态，任何并发下都安全。body 上限 1 MiB。

远端客户端设定范例（多数 MCP 客户端接受以 `url` 栏位取代 `command` 来接
streamable HTTP；请代换 `<host>` 并从 `.token` 读取 token）：

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

## 工具（10 个 —— 格局批次 2026-11-10）

| 工具 | 一句话说明 |
|---|---|
| `ziwei_chart` | 由国历出生资料产生完整本命盘 JSON（提供 `longitude` 时套用真太阳时修正） |
| `ziwei_patterns` | 2026-11-10 新增：格局辨识 ＋ 命宫摘要 —— 41 个通用识别器 ＋《紫微斗数全书》卷一严格格表（定贵／定富／定贫贱，带原书条目号），`patterns[].strict` 区分两族 |
| `ziwei_sihua_layers` | 四化层级：大限／流年／流月 ＋ 流日／流时（日与时：仅供参考） |
| `ziwei_from_city` | 以城市名称（中文或常见英文名）排盘，经 vendored `cities.ts` 解析；明确提供 `longitude` 时以其为准 |
| `ziwei_solar_lunar` | 双向国历⇄农历转换 ＋ 结果之四柱（1900–2050） |
| `ziwei_selftest` | 内建黄金标准回归自测 → `{pass, checks[]}`，确定性 |
| `ziwei_compatibility` | 合盘：以 vendored `heming-knowledge.ts` 作双人比较 —— 结构化发现，不捏造分数 |
| `ziwei_batch_stats` | 于确定性的日×时列举上的语料分布（`hours:"all"` 自 2026-11-04 起为预设；非随机抽样；非人口代表性）。计数为**每星出现次数**而非每命盘 —— 总和可能超过 `chartsComputed`；见下方说明 |
| `ziwei_school_compare` | 同一出生日期依引擎支援的每个约定（lateZishi × leapMonth）分别排盘 ＋ 差异摘要 |
| `ziwei_render` | 十二宫格以纯字串 SVG 呈现（4×4 ＋ 中央 meta，siHua 以颜色区分） |

呼叫范例（一律透过 `tools/call` 的 params.arguments）：

```jsonc
// ziwei_patterns —— 出生参数同 ziwei_chart；可选 leapMonth 闰月约定
{"year":1986,"month":12,"day":8,"hour":23,"minute":45,"gender":"male","longitude":114.2}
// ziwei_from_city —— 「Hong Kong」等同经度 114.2
{"year":1986,"month":12,"day":8,"hour":23,"minute":45,"gender":"male","city":"Hong Kong"}
// ziwei_solar_lunar —— 只能提供其中一端
{"lunar":{"year":1986,"month":11,"day":8}}
// ziwei_selftest —— 无需参数
{}
// ziwei_compatibility —— 两个出生资料
{"a":{"year":1986,"month":12,"day":8,"hour":23,"minute":45,"gender":"male","longitude":114.2},
 "b":{"year":1994,"month":6,"day":15,"hour":8,"minute":0,"gender":"female"}}
// ziwei_batch_stats —— 确定性的日×时统计（预设 hours:"all"）
{"question":"wuxingJu-distribution","gender":"male","yearFrom":1950,"yearTo":2000,"maxCharts":5000}
// ziwei_batch_stats —— 旧式单一时辰模式（重现 2026-11-04 之前的行为）
{"question":"wuxingJu-distribution","gender":"male","yearFrom":1950,"yearTo":1950,"hours":[6]}
// ziwei_sihua_layers —— 流日/流时层级需要 flowDate（流时另需 flowHour）
{"year":2026,"gender":"male","birth":{"year":1986,"month":12,"day":8,"hour":23,"minute":45,"longitude":114.2},
 "layers":["liuri","liushi"],"flowDate":{"year":2026,"month":11,"day":3},"flowHour":10}
// ziwei_school_compare / ziwei_render —— 出生资料格式同 ziwei_chart
{"year":1986,"month":12,"day":8,"hour":23,"minute":45,"gender":"male","longitude":114.2}
```

### `ziwei_chart`

完整本命盘 JSON（宫位、星曜、亮度、siHua 标记、大限、四柱）。

| 栏位 | 型别 | 备注 |
|---|---|---|
| `year` `month` `day` | int | 国历（格里高利）日期；不存在的日期会被拒绝 |
| `hour` | int 0-23 | 当地**时钟**小时（`23` → 晚子：命盘日期进一位） |
| `minute` | int 0-59 | |
| `gender` | `"male"`\|`"female"` | |
| `longitude` | number? | 东经度数；启用真太阳时修正 |
| `latitude` | number? | 可接受但不生效（修正仅使用经度 + 均时差） |
| `leapMonth` | `"split"`\|`"next-month"`\|`"prev-month"`\|`"origin-month"`? | 2026-11-10：闰月归属约定（预设 `split` = 月中分界，主流口径；`next-month` = 倪师派；无效值会被明确错误拒绝）。省略时维持引擎预设 —— 输出与 2026-11-10 之前的呼叫字节完全相同 |

结果：`{ meta: {effectiveDate, hourBranch, trueSolarTime, fourPillars, rawInput, ...}, chart: <完整 ZiweiChart> }`。
未提供 `longitude` 时修正不生效（同一命盘；`meta.trueSolarTime:null`）。

> **`birthInfo` vs `meta.rawInput`（2026-11-04）：** `chart.birthInfo` 反映的是
> **引擎修正后的有效输入**（例如 23:00 的晚子出生会显示 `day+1`、`hour:0`）。
> 若要回显呼叫端的**原始**数值，请读 `meta.rawInput`
> （`{year,month,day,hour,minute,gender[,longitude][,latitude][,leapMonth]}`）——
> 依原样收到的精确参数，绝未被位移。正午案例亦同：引擎会正规化
> 小时的表示方式。

### `ziwei_patterns`（2026-11-10 新增）

于内部产生的本命盘之上做确定性的格局辨识 ＋ 命宫摘要。出生参数与
`ziwei_chart` 完全相同（含 `longitude` 真太阳时修正与 `leapMonth` 闰月约定）；
`ziwei_chart` 本身的输出形状保持不变。

两族辨识器，以 `patterns[].strict` 区分：

- **strict `true`** —— 《紫微斗数全书》卷一的四张格表（定贵局 27 / 定富局 6 /
  定贫贱局 8；定杂局非本命盘可判）。依原书注文逐字判定，不放宽。每条命中
  在 `source` 带原书条目号（`《紫微斗数全书·卷一·定贵局》第N条`），
  `description` 即原书注文。
- **strict `false`** —— 41 个通用识别器（机月同梁、杀破狼、府相朝垣……），
  带分层 `conditions`（`required` / `bonus` / `breaking`），其中四化加分线经
  引擎的 `palaceHasSiHua` / `sanFangHasSiHua` 判定。

`mingGong` 携带命宫脉络：`branch`、`mainStars`、`nature`、`keywords`；命宫
空宫时另有 `borrowedFrom` 块，标出所借对宫之宫名与主星（空宫借星）。
`counts` 给出 `{total, strict, loose}`。

```jsonc
// 黄金锚点盘
{"year":1986,"month":12,"day":8,"hour":23,"minute":45,"gender":"male","longitude":114.2}
// 命宫空宫范例 —— 会回报 borrowedFrom
{"year":1990,"month":5,"day":20,"hour":8,"minute":0,"gender":"female"}
```

### `ziwei_sihua_layers`

于内部产生的本命盘之上叠加四化层级。键为中文：`禄/权/科/忌`；每个转化经
`chart.palaces[].stars[].name` 对应到 `{star, palace}`。

| 栏位 | 型别 | 备注 |
|---|---|---|
| `year` | int | 该层级窗口的西元年（提供 `yearWindow` 时可省略） |
| `yearWindow` | string? | 2026-11-04：以干支对（例如 `"丙午"`）取代 `year` —— 天干地支直接取自该对，消除流年/流月/流日/流时的立春边界陷阱 |
| `gender` | `"male"`\|`"female"` | |
| `birth` | object | `{year,month,day,hour,minute,longitude?}` —— 语义同 `ziwei_chart` |
| `layers` | array | `"daxian"`、`"liunian"`、`"liuyue"`、`"liuri"`、`"liushi"` 的任意组合 |
| `month` | int 1-12? | **国历**月份，除非提供 `lunarMonth`/`flowDate` 否则 `liuyue` 需要（于月中内部转换为农历月） |
| `lunarMonth` | int 1-12? | 直接以农历月作 `liuyue`（取代 `month` 的另一选择） |
| `flowDate` | `{year,month,day}`? | 2026-11-04：提供时也会**逐日**解析 `liuyue` —— 可定住闰月跨段边界（`liuri`/`liushi` 本来就必须提供） |

层级语义（依 `references/time-layers.md`）：

- `daxian` — 天干 = **大限宫天干**，非出生年天干
  （`getDaXianSiHua`）；含 `ageRanges`、`currentLayerIndex`、`ageRange`、`xuSui`
  （虚岁 = 该年 − 农历生年 + 1）。幼年年份以 `CHILDHOOD_DAXIAN_INDEX` 解析。
- `liunian` — 天干 = 年干（`(year-4)%10`）。
- `liuyue` — 五虎遁月干（`getLiuYueSiHua`）；闰月带其基准月的天干。
  **FIXED 2026-11-04：** 年干现在取自流日日期立春精确的干支年
  （引擎 `getEightChar().getYear()`），而非请求的西历年份 —— 旧式两套来源
  混用的做法对立春前的国历日期（约 2 月 4 日前）是错的：例如 2026-01 属
  乙巳年农历十一月 → 戊子（旧结果 庚 ✗）；2025-01 → 甲辰年十二月 → 丁丑
  （旧 己 ✗）；2027-01 → 丙午年十二月 → 辛丑（旧 癸 ✗）。立春后的行为不变
  （2026-03 = 丙午正月 = 庚寅，已验证）。回应中会回显 `yearStemUsed` +
  `ganzhiYear` 供客户端稽核。**FIXED 2026-11-04（2，闰月跨段）；UNIFIED
  2026-11-05：** 提供 `flowDate` 时农历月**逐日**解析 —— 2023-04-25 是三月初六
  → 天干丙，而 2023-04-05 是闰二月十五 → 天干乙（癸卯年五虎遁）。仅给月份
  （单独 `month`）现在对所有跨段类型采**单一统一规则**：**解析为该国历月份
  15 日所在的农历月**（月中规则）。旧式专为闰月设计的「后段」特例已移除。
  若要精确定住某一天请提供 `flowDate`。仅按月查询的决策栏位为描述性的
  `monthSpan`（该国历月所涵盖农历月的有序清单，各含 `{lunarMonth, isLeap}`，
  已去重）与 `resolvedAs`（指明取样日期的精确解析结果，例如
  `m1 (lunar month containing 2026-03-15)`）。`ambiguousMonth: true` 基于向后
  相容保留，但在仅按月路径上实质恒为 true（农历月约 29.5 日比任何国历月
  都短，因此首日与末日必然不同 —— 恒定的布尔值不带讯号）；`note` 会指向
  `monthSpan`/`resolvedAs`。参考值（仅按月）：2023-04 → **乙**（2023-04-15 =
  闰二月十五；旧式后段规则为 丙 —— 唯一一次天干改变）、2026-01 → **戊**、
  2026-03 → **庚**。一月自测检查（#9/#10）不变。

#### 月制惯例（农历月 —— 若你遵循节气月惯例请务必阅读）

**本引擎的 `liuyue` 使用农历月**：五虎遁套用于 queried 日期**转换后的农历月**，
闰月带其基准月的天干。主流飞星实务多以**节气月**替代（清明起即属辰月，
不论农历日期）。两套惯例于月份边界附近会结构性分岔 —— 例如 2026 年 1 月中旬：
农历惯例得 **戊子**，节气惯例得 **辛丑**。目前并无 `solarTerm` 模式
（设计决定尚未作出）。若你的做法遵循节气，请预期月份边界处的差异；
请使用 `flowDate` 定住确切日期，并稽核每个流月 payload 中的
`lunarMonth`/`isLeapMonth`。
- `liuri`/`liushi` — 日/时天干；不受上述 bug 影响（内部使用农历年／日干，
  并非两套来源混用）。
- `yearWindow`（FEATURE A）— `"丙午"` ≡ `year:2026`；无效的干支对（不明字元或
  六十甲子配对错误，例如 `"甲丑"`）→ `isError`。每个层级都会回显
  `yearStemUsed`/`ganzhiYear`。仅提供 `yearWindow` 时，历法查询（大限区间、
  国历→农历月）使用符合该干支对的代表性现代周期年份 1984–2043。

## 测试

```bash
bash services/ziwei-mcp/tests/run-tests.sh     # stdio A-G，9/9（E = 全工具批次，F = bugfix/feature 回归含 2026-11-05 统一跨段规则，G = 2026-11-05 深度修正套件：镜射交叉检查、jiFlags、lunarMonth 四路径表、边界、日位移、ignoredKeys）
bash services/ziwei-mcp/tests/http-tests.sh    # HTTP：auth、protocol、batch、gold、SSE、全部工具 + 2026-11-04/05 断言（38）
```

黄金基准锚点（全数在 repo 内、自给自足）：`tests/gold/chart-1986.json`
（ziwei_chart byte 相同；chart 物件绝不可改变）与 `tests/gold/render-default-1986.svg`
（预设 render byte 相同）。

参考（黄金标准）出生资料 —— 一个刻意非任何真实人物的**合成**基准日期：
`1986-12-08 23:45 male lon 114.2` → 有效日期 `1986-12-09`，四柱
丙寅/庚子/丁亥/庚子，命宫 子·天同(旺)（太阴同宫），土五局，命主 贪狼，
身主 天梁，生年四化：天同禄→命宫，天机权→官禄，文昌科→夫妻，廉贞忌→子女。

## 变更记录

正式日期式变更记录见 **[CHANGES.md](CHANGES.md)**（Keep a Changelog 格式，最新在上）。
以下逐段为各版本的详细叙述性记录。

## 变更记录 —— 2026-11-10（格局批次：`ziwei_patterns` 工具 ＋ `leapMonth` 参数）

**新工具 `ziwei_patterns`** —— 专用的格局辨识 ＋ 命宫摘要，基于引擎的
`detectPatterns` / `getMingGongSummary`（引擎锁定 `495b79e` → `906bd93`，后者新增
《紫微斗数全书》卷一严格格表与修正后的四化加分逻辑）。`ziwei_chart` 的输出
形状未变（黄金命盘输出经验证前后字节相同）；新工具的存在使既有消费方
完全不会看到形状变化。

**`leapMonth` 参数**（`ziwei_chart` 与 `ziwei_patterns` 两者）：可选闰月约定
`split`（预设）/ `next-month` / `prev-month` / `origin-month`，透传至引擎。
无效值以列出可接受值的清晰 ToolError 拒绝（引擎本身会抛 `RangeError` ——
上游 #71 —— 本包装层将其干净地呈现）。省略该参数即维持引擎预设（`split`）
与 2026-11-10 之前的精确字节。

**自测：** `ziwei_selftest` 新增检查 14–17（共 17 项）：黄金盘检出格局清单、
四化加分反向控制（文昌化科位于黄金盘三方四正之外 → `再会化科` 加分
必须**不**触发），以及两个严格卷一表的正例 fixture（1978-07-01 11:00 male →
七杀朝斗 定贵局第11条 ＋ 杀破狼 化禄/化权 加分经 `sanFangHasSiHua` 触发；
1990-05-20 08:00 female → 坐贵向贵 定贵局第9条）。黄金锚点盘本身触发零个
严格条目（天同太阴在子与 49 条格表均不符）—— 改以 fixture 锁定。

**交叉核对：** 工具的格局清单与 CLI 参考（`scripts/ziwei-chart.ts` 的
`detectPatterns` 输出）在黄金盘与 fixture 盘上完全一致。

**版本：** stdio 0.1.0 → **0.3.0**，HTTP 0.2.0 → **0.3.0**（统一；两个 transport
都携带新工具）。`tools/list` 现返回 10 个工具。

**契约：** 黄金 `ziwei_chart` 输出字节相同；预设 render SVG 字节相同；
`ziwei_chart` 仅增加 `leapMonth`（输入）与 `meta.leapMonth` /
`meta.rawInput.leapMonth`（提供时回显）。本批次无 vendor 变更 —— 引擎已在
906bd93。

## 变更记录 —— 2026-11-05 07:45（深度审查修正：镜射测试、lunarMonth 路径、jiFlags、async batch_stats、参数卫生）

来自 2026-11-05 深度审查的六项修正。黄金命盘 + 预设 render SVG 全程
byte 相同；自测现为 **13 项检查**（新增 `lunarMonthDirect2026`）。

1. **`ziwei_compatibility` 镜射测试方向相反（CRITICAL）。** 交叉检查拿每一方
   夫妻宫的星曜对比其**自己**的命宫，而非对方的 —— `tianZuoZhiHe` 因此永远
   无法表达方法论 §2。现修正为：A 的夫妻星 ⊂ B 的命宫 **且** B 的夫妻星 ⊂ A 的命宫。
   **可观察差异：** `tianZuoZhiHe` 现在可以为 `true`（旧版实质恒为 false）；
   `aFuqiStarsInBMing` / `bFuqiStarsInAMing` 现在如实回报真正的交叉重叠
   （旧版自我过滤）。黄金正面案例：`{a:1970-05-15 10:00 male, b:1988-11-15
   10:00 female}` → 武曲⊂(武曲天府) + 破军⊂(破军) → `true`。自配对（a=b）只有在
   自己夫妻宫的星曜刚好也在自己命宫时才平凡为 true —— 一般命盘（例如黄金
   出生资料）仍为 `false`；明细字串会点名该规则。
2. **`ziwei_sihua_layers` 直接 `lunarMonth` 路径的两套来源 bug（CRITICAL）。**
   农历月的**数字**被当作**国历**月份喂入，因此 `lunarMonth:1` 永远以国历
   1 月 15 日解析 = 立春前 → 年干错一个干支年（2026 正月曾回传 戊/乙巳
   而非 庚/丙午）。现改经 vendored 农历表解析：参考 = 农历（year, m, 15）对应的
   国历日期。m1 于 2022–2028 的四路径一致性成立（壬 甲 丙 戊 庚 壬 甲）。m12
   边界：月中落在次年立春前 → 天干仍属 `year` 的干支年（2026 m12 → 国历
   2027-01-22 → 丙午 → 辛，不变）。新增 `isLeapMonth:true` 验证：无闰月之年
   或错误闰月 → `isError`（旧版静默忽略）。Schema 明确文件化 `isLeapMonth`。
3. **`jiFlags` 夫妻比较形同虚设（MAJOR）。** 引擎宫位名称除命宫外均不带「宫」
   后缀；`jiPalace === '夫妻宫'` 永远匹配不到。修正为 `'夫妻'` —— 化忌入对方
   夫妻宫的旗标现在生效（已验证配对：A 1960-01-05 00:00 male → 文曲化忌落入
   B 1963-07-05 00:00 male 的夫妻宫）。
4. **`ziwei_batch_stats` 阻塞 event loop（MAJOR）。** 同步 `execFileSync`（最长
   120 s）改为 async `spawn`；`dispatch()` 现在是 async，两个进入点都会 await。
   **可观察差异：** 完整范围批次执行期间 `/health` 仍于 <50 ms 回应
   （预设 1950–2000 统计期间实测 13–23 ms × 3）。其余输出契约不变。
5. **未知参数会被回显而非静默丢弃。** Schema 宣告 `additionalProperties:false`
   但执行面维持宽容以兼容客户端相容性（硬拒绝会破坏既有呼叫端）。当出现
   未知的顶层参数时，回应 meta 中会出现 `meta.ignoredKeys` +
   `meta.ignoredKeysNote`，精确列出被忽略的栏位。
6. **次要群组：** `year` + `yearWindow` 并存 → `isError`（旧版静默拆来源）；
   `ziwei_solar_lunar` 国历方向限定 1900–2050（超出范围曾回传看似合理但错误的
   日期；现为 `isError`，与农历方向一致）；liushi `flowHour:23` 现套用与本命
   解析器相同的次日位移（旧版用同日的日干 —— 已验证：2026-11-05 23:xx ==
   2026-11-06 00:00 层级，甲申）；README/http-tests 断言数修正为 38
   （旧为「21」/「32」，皆过期）。

## 变更记录 —— 2026-11-05 05:01（流月仅按月查询的描述性 span 栏位，审查者第三轮跟进）

**仅新增：** 仅按月的 `liuyue` payload 增加两个描述性栏位：

- **`monthSpan`** —— 该国历月所涵盖农历月的有序阵列，各含
  `{lunarMonth, isLeap}`，已去重（未跨段的月份 → 单元素阵列）。
  例：`{2026, month:3}` → `[{lunarMonth:1,isLeap:false},{lunarMonth:2,isLeap:false}]`。
- **`resolvedAs`** —— 指明取样日期的确定性解析字串，
  例如 `m1 (lunar month containing 2026-03-15)`。

**为何不用布尔值：** 统一月中规则之后，`ambiguousMonth:true` 几乎会在
**每一次**仅按月查询触发（农历月约 29.5 日比任何国历月都短，因此首日与
末日必然不同）。恒定的布尔值不是讯号 —— 任何写 `if (ambiguousMonth) warn()`
的客户端会得到 100% 警告率，最终干脆关闭警告，连真正模糊案例的讯号也一并
丧失。因此 `ambiguousMonth` 降级为向后相容旗标（数值/语义不变），
`monthSpan`/`resolvedAs` 成为决策栏位；`note` 现已明确说明。`flowDate` 仍是
精确路径 —— flowDate payload 保持 byte 相同（该路径无新栏位）。黄金命盘 +
预设 render SVG byte 相同；自测维持 12 项检查。

## 变更记录 —— 2026-11-05（统一仅按月 tie-break，审查者第三轮）

**`liuyue` 仅按月解析现在对所有跨段类型采单一规则：**

- **月中规则：** 单独 `month` 查询解析为该国历月 **15 日**所在的农历月。
  专属于闰月的「后段」特例已**移除** —— 两条路径（闰月/普通）现在的
  tie-break 完全相同。
- **`ambiguousMonth` 标记**任何**边界跨段：** 当国历月的首日与末日映射到
  不同农历月（不论闰与否），旗标 + `note`（建议 `flowDate`）即触发。由于
  农历月（约 29.5 日）比任何国历月都短，几乎每个仅按月查询现在都会被
  如实标记，而非像过去那样静默选择前段、只在罕见闰跨段才警告
  （第二轮的不对称）。
- **为何不选「后段遍布」**（审查者的另一方案）：就一月而言，后段（例如
  2025-01-29/31）已是**下一个**干支年的农历正月，而立春推得的年干仍是
  **当前**年 —— 将正月与立春前的年干配对，会重新引入已两度修正的两套
  来源 bug 类别（2026-11-04 #1/#4）。月中取样绝不会落入该缺口窗口。
  已验证的后果：后段方案会使 2026-01 戊→己翻转、2025-01 落入缺口窗口的
  乱数；月中规则让两项一月自测检查（#9 丁、#10 戊）原封不动通过。
- **可观察变化：** 2023-04 仅按月 **丙 → 乙**（2023-04-15 = 闰二月十五 →
  闰二月基准月干 乙）—— 唯一一次天干改变。新增旗标、天干不变：
  2026-01 → 戊+旗标、2025-01 → 丁+旗标、2026-03 → 庚+旗标。所有 `flowDate`
  结果不变（逐日路径未动：2023-04-25 → 丙、2023-04-05 → 乙）。黄金命盘 +
  预设 render SVG byte 相同。
- **自测：** 检查 12 `ordinaryStraddle2026Mar` 锁住普通边界防线（仅按月
  2026-03 → 天干 庚 **且** `ambiguousMonth` true）。检查数 ≥ 12。
  Fail-first：测试先于修正撰写，确认对旧码失败（2026-03 无旗标、2026-01
  无旗标、2023-04 → 丙），再转为通过。
- **契约：** 9 个工具不变；无 vendor/engine 变更。

## 变更记录 —— 2026-11-04（bugfix + feature 批次，由外部客户端测试发现）

**Bug 修正**（每项皆 fail-first：回归测试先确认对旧码失败，再修正，再确认
通过 —— 见 `tests/run-tests.sh` 区段 F）：

1. **流月天干于立春/农历年边界的错误（CRITICAL）。** 五虎遁的年干取自
   *请求的西历年份*，而月份数字取自*农历*转换 —— 两套来源，对立春前的
   日期是错的。现两者都由同一流日日期透过引擎自身立春精确的表推得。
   修正数值：2025-01 → 丁（旧 己）、2026-01 → 戊（旧 庚）、2027-01 → 辛（旧 癸）。
   payload 会回显 `yearStemUsed` + `ganzhiYear`。已检查 `liuri`/`liushi` ——
   它们**不**共用此 bug（天干来源不同），维持原样。
1b. **流月闰月跨段（当日晚间修正）。** 跨越闰月边界的国历月（2023-04：
   4/19 前属闰二月，之后属三月）以月中取样解析 —— 每个四月日期都回传
   闰月段（乙 ✗；2023-04-25 = 三月初六应为 丙）。现 `flowDate` 会逐日解析
   农历月；跨段月份的单独 `month` 查询回传后段的干加 `ambiguousMonth: true`
   + `note`。自测检查 11（`liuyueStem2023Apr25` → 丙）将其锁住；检查数 ≥ 11。
   上方**月制惯例**说明文件化了农历月选择的根因。
   *（2026-11-05 已被取代：后段 tie-break 已由统一月中规则取代 —— 见上方
   2026-11-05 变更记录。）*
2. **`birthInfo` 回显修正后的值而非原始输入。** `chart.birthInfo` 刻意不变
   （byte 相同契约）；每个 `ziwei_chart` 结果新增 `meta.rawInput` 以回显精确的
   呼叫端参数。整合者：请读 `meta.rawInput` 而非 `birthInfo` 取得原始数值。
3. **`ziwei_batch_stats` 固定时辰偏差。** 预设现为 `hours:"all"` —— 于日 × 12
   时辰做统计（于槽位空间做跨距细分）。`hours:[6]`（或旧式 `hourBranch`）
   重现旧版正午专用的行为。`maxCharts` 上限（预设 5000）使预设 1950–2000
   执行约 25 s（实测 24.9 s、4968 盘）—— 远低于 120 s 子行程限制；不设上限的
   完整统计约需 2.5 分钟，刻意不作预设。

**`ziwei_batch_stats` 计数说明（2026-11-04）：** 分布计数为**每星出现次数，
非每命盘** —— 命宫含两颗主星的命盘（例如太阳巨门）会同时贡献两笔计数，
因此 `sum(counts)` 可能超过 `chartsComputed`（线上验证：1985–86 为 5833 vs
4380）。若不先说明此点，请勿以计数除以 `chartsComputed` 宣称人口占比。
结果 meta 现也会于 `chartsComputed` 旁输出 `sumOfCounts` 供稽核。

**新功能：** A) `ziwei_sihua_layers` 的 `yearWindow` 干支模式（见上）；
B) `ziwei_compatibility` 的 `daXianCheck` 区块 —— 双方目前大限宫位地支/天干
＋旗标（同地支、同天干、同干支＝两者皆是、各方大限干之忌飞入对方命宫）；
纯结构、不加评分；C) `ziwei_render` 的 `layers:["liunian"|"daxian"]` 叠图
（虚线角标 + 图例列、第二色 `#7a4dbf`；`flowYear` 选定流年；预设纯本命 SVG
与前一版输出 byte 相同 —— 以 `tests/gold/` 为锚）。

**自测：** `ziwei_selftest` 新增检查 9–10 —— 一月立春边界的月干
（2026-01 → 戊、2025-01 → 丁），由引擎自身表格确定性计算；检查 11
（2026-11-04 晚间）加入闰月跨段案例（2023-04-25 → 丙）。检查数 ≥ 11。

**契约：** 工具数不变（9）；黄金命盘输出 byte 相同；`ziwei_chart` 仅新增
`meta.rawInput`。无 vendor/engine 变更。

## Phase 2 说明（2026-11-01 交付）

工具逻辑移入 `tools.ts`，以 `dispatch()` 作为与 transport 无关的处理者；
两种 transport 都是其上的薄壳。若未来设计需要引入状态（储存命盘），
必须以每次呼叫选择加入 —— 让服务器可稽核的正是不变的无状态契约。

### Phase 2b —— SSE 串流模式（2026-11-01）

`GET /mcp` 现在支援 SSE（见上方 Transport 模式）。Session 模型：每条开启的
串流一个随机 UUID，仅保存在记忆体 Map 中让 `DELETE` 能定位它 —— 其余什么
都不存，daemon 跨请求保持无状态。刻意保留的规范取舍：
- POST 回应即使附带 session id 仍留在 POST 连线（JSON 模式）—— 没有双路径
  回应路由，对既有客户端零回归风险。
- 没有 `initialize` 发起的 session 生命周期（无 per-session 状态、逾期或
  隔离）—— id 只与其串流同生灭。
- 串流只带 comment（keep-alive）而不带 JSON-RPC 框，因为没有任何工具
  有内容要 push。

## 授权条款

MIT —— 见 [LICENSE](LICENSE)。Copyright (c) 2026 PeterYuen。

第三方出处声明：本服务**包装但不散布**来自
[github.com/Renhuai123/ziwei-doushu](https://github.com/Renhuai123/ziwei-doushu)
的紫微斗数引擎（引擎原始码 MIT、资料集 CC BY 4.0）。本 repository 未复制
任何引擎原始码或资料集内容 —— 使用者须依安装章节自行 vendor 锁定副本
（`906bd93`）。见 [NOTICE](NOTICE)。