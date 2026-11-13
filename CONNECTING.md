# ziwei-mcp — Connection Info (for testing in other systems)

**Server:** ziwei-mcp · two transports:
- **stdio** v0.3.2 (Phase 1) — local processes only
- **Streamable HTTP** v0.3.2 (Phase 2) — LAN/remote via URL, bearer-token

**Engine:** vendored ziwei-doushu @ `906bd93` (engine @ upstream 21114e3 + true-solar longitude fix) (MIT, upstream github.com/Renhuai123/ziwei-doushu)
Both transports share one implementation module (`tools.ts`) — identical tool behaviour.

## Phase 2: HTTP (remote systems — this is what you want for cross-host testing)

**URL:** `http://<host>:9878/mcp` (the daemon binds 0.0.0.0 — remote clients use the host's own LAN address)
**Token:** read `services/ziwei-mcp/.token` on the server host (chmod 600) — send it as
`Authorization: Bearer <token>` or `?token=<token>` (either accepted). Missing/wrong → 401.
**Health:** `GET /health` (no auth) → `{"status":"ok","server":"ziwei-mcp","version":"0.3.2"}`
**Service:** `systemctl --user {start,restart,status} ziwei-mcp` (enabled at boot, Linger=yes)

### Remote client config (streamable HTTP — most MCP clients accept `url`)

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

mcporter against the HTTP transport:

```
mcporter call ziwei-mcp.ziwei_chart --url http://127.0.0.1:9878/mcp --header "Authorization: Bearer $TOKEN" --args '{"year":1986,"month":12,"day":8,"hour":23,"minute":45,"gender":"male","longitude":114.2}'
```

Raw curl smoke test (works from ANY host with LAN route to the server):

```bash
TOKEN=$(cat services/ziwei-mcp/.token)   # on the server host
curl -s http://127.0.0.1:9878/health
curl -s -X POST http://127.0.0.1:9878/mcp \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"1"}}}'
```

Expected: `serverInfo` `ziwei-mcp/0.3.2`, then `tools/list` returns all ten tools.

### HTTP protocol details

- POST `/mcp` with a single JSON-RPC message or a batch array; response is
  `application/json` (JSON response mode of Streamable HTTP). Notification-only
  posts get 202. This is the default path every client uses — unchanged.
- **SSE stream:** `GET /mcp` with `Accept: text/event-stream` (+ auth) opens a
  server-push stream. Response headers include `Mcp-Session-Id` (a per-stream
  UUID). The stream stays open indefinitely and emits an SSE comment ping every
  **20 s** (liveness only — our tools never push JSON-RPC messages). Close it
  with `DELETE /mcp` + `Mcp-Session-Id` header (200), or just disconnect. Up to
  16 concurrent streams. `GET /mcp` without `Accept: text/event-stream` → 405.
- A POST carrying `Mcp-Session-Id` behaves identically to a headerless POST:
  the JSON response returns on the POST connection (spec-permitted); nothing is
  routed onto the SSE stream.
- Unknown method → `-32601`; unknown tool → `-32602`; tool validation errors →
  `result.isError:true` (protocol survives); malformed body → `-32700`.
- 1 MiB request-size limit. Stateless — no per-session state, nothing stored;
  session ids exist only to address an open stream for DELETE.

```bash
# open the SSE stream (Ctrl-C to close; or DELETE /mcp with the session id)
curl -sN http://127.0.0.1:9878/mcp \
  -H "Authorization: Bearer $TOKEN" -H 'Accept: text/event-stream'
# → HTTP/1.1 200, Content-Type: text/event-stream, Mcp-Session-Id: <uuid>
#   : ziwei-mcp SSE stream open (keep-alive every 20s)
#   : ping 2026-11-01T07:20:00.000Z
```

## Phase 1: stdio (local processes)

```
<repo-root>/vendor/ziwei-doushu/node_modules/.bin/tsx \
  <repo-root>/services/ziwei-mcp/index.ts
```

- Transport: **stdio** — newline-delimited JSON-RPC 2.0 over stdin/stdout. No port, no URL, no auth (stdio trust model).
- Logs go to stderr only; stdout stays pure protocol.
- Requirements: Node.js ≥ 20 on the host running the process. No npm install needed — everything is stdlib + the vendored engine path.
- Protocol: responds to `initialize` (echoes client protocolVersion), `tools/list`, `tools/call`, `notifications/initialized`; unknown method → `-32601`; malformed line → `-32700`.

## Generic client config (Claude Desktop / Cursor / Cline / any mcpServers client)

```json
{
  "mcpServers": {
    "ziwei-mcp": {
      "command": "<repo-root>/vendor/ziwei-doushu/node_modules/.bin/tsx",
      "args": ["<repo-root>/services/ziwei-mcp/index.ts"],
      "cwd": "<repo-root>/services/ziwei-mcp"
    }
  }
}
```

For clients with a different config key layout (e.g. `servers`, `mcp.server`, per-OS paths), use the same command+args pair.

## mcporter (CLI, any host that can see these files)

```
mcporter call ziwei-mcp.ziwei_chart --args '{"year":1986,"month":12,"day":8,"hour":23,"minute":45,"gender":"male","longitude":114.2}'
mcporter call ziwei-mcp.ziwei_patterns --args '{"year":1986,"month":12,"day":8,"hour":23,"minute":45,"gender":"male","longitude":114.2}'
mcporter call ziwei-mcp.ziwei_sihua_layers --args '{"year":2026,"gender":"male","birth":{"year":1986,"month":12,"day":8,"hour":23,"minute":45,"longitude":114.2},"layers":["daxian","liunian","liuyue"],"lunarMonth":10}'
```

## Tools

Ten tools (2026-11-10 patterns batch; 2026-11-03 all-tools batch). All accept
solar birth data unless noted; all are stateless, deterministic, zero-LLM.
Example calls below use the gold birth (synthetic anchor 1986-12-08 23:45 male
lon 114.2).

### `ziwei_chart`
Full natal chart. Required: `year, month, day, hour, minute, gender` (`male|female`). Optional: `longitude` (enables true-solar-time correction; `hour` is clock hour 0–23, 23 = late-子 → chart day advances), `latitude` (accepted, inert), `leapMonth` (2026-11-10: 闰月 policy `split` (default) | `next-month` | `prev-month` | `origin-month`; invalid values rejected with a clear error). Returns `{meta, chart}` — palaces, stars with brightness, birth siHua, daXians, fourPillars, effectiveDate, trueSolarTime.

> **Integrator note (2026-11-04):** `chart.birthInfo` reflects the **engine-corrected
> effective input** (e.g. the late-子 gold birth shows `day:9, hour:0` from raw
> `day:8, hour:23`) — do NOT read it as the original request. Use **`meta.rawInput`**
> instead: it echoes the exact caller arguments (`{year,month,day,hour,minute,gender[,longitude][,latitude]}`) verbatim, never shifted.
>
> Note also that `birthInfo.hour` is the **时辰 BRANCH INDEX (0–11)**, not the clock
> hour: clock 12:00 → 6 (午), 12:10 → 6 (午), 23:10 → 0 (late-子, next day). Clock
> values live only in `meta.rawInput` (and `meta.effectiveDate`/`trueSolarTime`).
> Never index a branch table with `birthInfo.hour` expecting a 0–23 clock value.

### `ziwei_patterns` (new 2026-11-10)
Pattern (格局) detection + 命宮 summary over the internally-generated natal chart.
Same birth params as `ziwei_chart` (incl. `longitude` true-solar correction and the
optional `leapMonth` policy). Returns `{meta, mingGong, patterns, counts,
strictModeNote}`:

- `patterns[]` — `{name, level, description, palaces, strict, source?, conditions?}`.
  `strict:true` = judged by the 《紫微斗数全书》卷一 tables (定贵局 27 / 定富局 6 /
  定贫贱局 8) with the original-book item number in `source` and the 原书注文 as
  `description`; `strict:false` = one of the 41 general detectors, with layered
  `conditions.required/bonus/breaking` (四化 bonus lines evaluated via the engine's
  `palaceHasSiHua`/`sanFangHasSiHua`).
- `mingGong` — `{branch, mainStars, nature, keywords}`; empty 命宮 additionally
  gets `borrowedFrom:{palace, mainStars}` (空宫借星 from the opposite palace).
- `counts` — `{total, strict, loose}`.

Gold-birth example (fires 4 loose detectors, zero strict — 天同太阴 in 子 matches
none of the 49 table entries):
```json
{"year":1986,"month":12,"day":8,"hour":23,"minute":45,"gender":"male","longitude":114.2}
```
→ patterns: 机月同梁(excellent), 巨日同宫(good), 天同化禄入命(good), 化权入官(good).
Strict-table example: `{"year":1990,"month":5,"day":20,"hour":8,"minute":0,"gender":"female"}`
→ adds 坐贵向贵 (strict, 定贵局第9条) and reports `mingGong.borrowedFrom` (命宮 empty in 丑).

### `ziwei_sihua_layers`
Time-layer analysis. Required: `year` (target year) **or** `yearWindow` (ganzhi pair, see below), `gender`, `birth{year,month,day,hour,minute[,longitude]}`, `layers` (any of `daxian|liunian|liuyue|liuri|liushi`). For liuyue give `lunarMonth` (direct), `month` (solar, converted internally), or `flowDate` (resolved by day — see straddle note below). For liuri/liushi give `flowDate{year,month,day}` (+ `flowHour` for liushi). Returns per-layer stem + transforms keyed 禄/权/科/忌 with `{star, palace}`, plus daxian ageRanges/currentLayerIndex. **Caveat:** below-month (day/hour) planning is unsupported by birth-time precision — liuri/liushi are informational only.

**Month convention — LUNAR months (2026-11-04):** this engine's liuyue uses **LUNAR
months** — 五虎遁 applied to the converted *lunar* month, leap month carries its base
month's stem. Mainstream flying-star practice often uses **solar-term months** (清明
onwards = 辰月 regardless of the lunar date); the two conventions diverge structurally
near month boundaries (e.g. mid-2026-01: lunar convention **戊子** vs solar-term
convention **辛丑**). No `solarTerm` mode exists (design decision not made). If your
practice follows solar terms, expect divergence at month boundaries — use `flowDate`
to pin the exact day and audit `lunarMonth`/`isLeapMonth` in every payload.

**Fixed 2026-11-04 — liuyue lichun boundary:** the 五虎遁 year stem is derived from the lichun-exact ganzhi year of the flow date (was: the requested calendar year, wrong for solar dates before lichun ~Feb 4). Corrected examples: `year:2025, month:1` → stem **丁** (甲辰年 m12 丁丑; was 己 ✗); `year:2026, month:1` → **戊** (乙巳年 m11 戊子; was 庚 ✗); `year:2027, month:1` → **辛** (丙午年 m12 辛丑; was 癸 ✗). Post-lichun results are unchanged. Every liuyue/liunian payload echoes `yearStemUsed` + `ganzhiYear` for audit.

**Unified 2026-11-05 — liuyue month-only tie-break (mid-month rule):** a bare `month`
query resolves to **the lunar month containing the 15th** of the solar month — one
rule for ALL straddle types (the leap-specific 'later segment' special case from
2026-11-04 is removed). The primary decision fields on month-only payloads are
descriptive: **`monthSpan`** (the ordered lunar months the solar month spans, each
`{lunarMonth, isLeap}`, deduplicated) and **`resolvedAs`** (the exact resolution
naming the sampled date, e.g. `m1 (lunar month containing 2026-03-15)`).
`ambiguousMonth: true` is retained for backward compat and fires on ANY boundary
straddle — which in practice means essentially every month-only query, since a
lunar month ~29.5 d is shorter than every solar month (a constant boolean is not
a signal: a client that warns on it gets a 100% warning rate and will disable
warnings entirely — so treat it as a legacy compat flag and read
`monthSpan`/`resolvedAs`, or supply `flowDate`). `flowDate` still resolves **by
day** and its payloads are unchanged: `{year:2023,
flowDate:{year:2023, month:4, day:25}}` → 三月 → **丙**; `day:5` → 闰二月 → **乙**.
Reference table (month-only): 2023-04 → **乙** (2023-04-15 = 闰二月十五;
⚠ observable change from 丙 via the old later-segment rule), 2026-01 → **戊**,
2026-03 → **庚**. Why mid-month instead of 'later segment everywhere': for
January months the later segment (e.g. 2025-01-29/31) is already lunar m1 of the NEXT
ganzhi year while the lichun-derived year stem is still the CURRENT year — pairing m1
with the pre-lichun stem re-introduces the two-source bug class fixed twice
(2026-11-04 #1/#4); mid-month sampling can never land in that gap window. Selftest
check 12 (`ordinaryStraddle2026Mar`: 2026-03 → 庚 AND flagged) locks the ordinary-
boundary defense in; checks ≥ 12.

**2026-11-05 05:01 — descriptive span fields (additive):** month-only payloads gain
`monthSpan` + `resolvedAs` as the primary descriptive fields (see section above);
`ambiguousMonth` is kept unchanged purely for backward compat — effectively
always-true on month-only paths. `flowDate` payloads byte-identical (no new fields
on that path). Gold chart + default render SVG byte-identical.

**Feature A — `yearWindow` ganzhi mode:** pass `yearWindow:"丙午"` instead of `year` to take the year stem/branch directly from the 干支 pair — no lichun ambiguity at all. `"丙午"` ≡ `year:2026`; invalid pairs (unknown characters, or 60-cycle parity violations like `"甲丑"`) return `isError`. When only `yearWindow` is given, calendar lookups use the representative modern-cycle year (1984–2043) matching the pair. **Changed 2026-11-05:** supplying BOTH `year` and `yearWindow` is now `isError` (`provide either year or yearWindow, not both`) — previously they silently split sources (liunian from the pair, daxian ranges from `year`). Each path works standalone; if your client sends both, drop `year`.

**Fixed 2026-11-05 — direct `lunarMonth` path (two-source bug):** the reference date for the 五虎遁 year stem is now the TRUE SOLAR date of lunar (`year`, m, 15) via the vendored lunar tables — previously the lunar month NUMBER was used as a SOLAR month, so `lunarMonth:1` always resolved against solar Jan 15 (pre-lichun) and the stem was off by one ganzhi year. Corrected table (lunarMonth:1, four-path agreement with `flowDate`/`month` paths verified 2022–2028): 2022→**壬**, 2023→**甲**, 2024→**丙**, 2025→**戊**, 2026→**庚** (was 戊 ✗), 2027→**壬**, 2028→**甲**. m12 edge documented: mid-month lands in early next year BEFORE that year's lichun, so the stem still belongs to `year`'s ganzhi (2026 m12 → solar 2027-01-22 → 丙午 → 辛, unchanged). New optional `isLeapMonth:true` alongside `lunarMonth`: validated — leap-less year or wrong leap number → `isError` (previously silently ignored). Selftest check 13 (`lunarMonthDirect2026`: → 庚) locks this in; checks ≥ 13.

**Fixed 2026-11-05 — liushi `flowHour:23` day shift:** 23:xx now uses the NEXT day's stem/branch (same next-day rule the natal resolver applies to late-子 births) instead of the same day's stem. Verified: `flowDate 2026-11-05, flowHour 23` ≡ `flowDate 2026-11-06, flowHour 0` (甲申 layer); payload echoes `dayShiftFromLateZi:1` and the shifted `solarDate`. liushi remains informational only.
```json
{"yearWindow":"丙午","gender":"male","birth":{"year":1986,"month":12,"day":8,"hour":23,"minute":45},"layers":["liunian"]}
```

### `ziwei_from_city`
Chart by city name instead of longitude. Args like `ziwei_chart` plus `city` (Chinese or common English name: `"Hong Kong"`, `香港`, `广州`…). Resolved via vendored `cities.ts`; explicit `longitude` overrides when both given. Unknown city → isError with suggestion examples.
```json
{"year":1986,"month":12,"day":8,"hour":23,"minute":45,"gender":"male","city":"Hong Kong"}
```

### `ziwei_solar_lunar`
Bidirectional calendar conversion with four-pillars for the result. Give exactly one of `solar{y,m,d}` / `lunar{y,m,isLeap?,d}`; **both directions bounded 1900–2050 (2026-11-05)** — outside that range the lunar-javascript tables produce plausible-but-wrong dates, so out-of-range years now return `isError` instead of silently wrong output (the lunar direction was already bounded; the solar direction now matches). Invalid leap dates rejected (never silently shifted).
```json
{"lunar":{"year":1986,"month":11,"day":8}}   // → solar 1986-12-09
```

### `ziwei_selftest`
No required args. Runs the built-in gold-standard regression internally (the synthetic-anchor case above: effectiveDate 1986-12-09, fourPillars 丙寅/庚子/丁亥/庚子, 命宮 子·天同(旺), 土五局, 命主/身主 貪狼/天梁, true solar 23:29:34, plus liuyue lichun-boundary stems and — since 2026-11-10 — pattern anchors: the gold chart's detected-pattern list, a 四化-bonus negative control, and two strict 《全书》卷一 fixtures (1978-07-01 11:00 male → 七杀朝斗 + 杀破狼 bonus; 1990-05-20 08:00 female → 坐贵向贵)) and returns `{pass, checks:[{name,expected,actual,ok}]}` (17 checks). Deterministic, no external calls.
```json
{}
```

### `ziwei_compatibility`
合盤 two-person comparison built on vendored `heming-knowledge.ts` (倪海厦 + 《全书》). Give `a` and `b` birth objects. Returns structured per-dimension findings — 命宮/夫妻/福德 star sets, 天作之合 mirror test, 四化飞化互参 with 化忌-into-partner flags, 太阳/太阴 states, 命格速配 pair-table hits, 夫妻宫 knowledge quotes. **No invented score** — only the knowledge module's own criteria.

**Fixed 2026-11-05 — mirror test was inverted (observable change):** the cross-check compared each side's 夫妻 stars against its OWN 命宮 instead of the partner's, so `tianZuoZhiHe` was effectively always `false`. It now implements methodology §2 correctly: A's 夫妻 stars ⊂ B's 命宮 AND B's 夫妻 stars ⊂ A's 命宮. **`tianZuoZhiHe` can now be `true`** (e.g. `{a:1970-05-15 10:00 male, b:1988-11-15 10:00 female}` → true: 武曲⊂(武曲天府), 破军⊂(破军)); `oneWayMirror` is the corresponding partial cross-overlap; `aFuqiStarsInBMing`/`bFuqiStarsInAMing` report true cross-intersections. A self-pair (a=b) is trivially true only when one's own 夫妻 stars sit in one's own 命宮 — normal charts stay `false`.

**Fixed 2026-11-05 — 化忌入对方夫妻宫 flag was dead:** palace names in this engine carry no 宮 suffix except 命宮, so the old `'夫妻宫'` comparison never matched. The flag string is unchanged, the comparison is now `'夫妻'` — the flag appears whenever a side's birth-year 化忌 star sits in the partner's 夫妻 palace (verified pair: a=1960-01-05 00:00 male, b=1963-07-05 00:00 male → `A→B: 文曲化忌入对方夫妻宫`).

**Feature B (2026-11-04) — `daXianCheck` block:** both parties' CURRENT 大限 palace branch + stem (via `currentDaXianIndex`), plus pure-structural flags — `flags.sameDaxianPalaceBranch` (same branch only), `flags.sameDaxianStem` (same stem only), `flags.sameDaxianGanzhi` (both stem AND branch equal = same sexagenary 干支 pillar, 同干支/同頻共振 — added 2026-11-04 external-review follow-up), and `a.ji.intoOtherMingGong` / `b.ji.intoOtherMingGong` (whether each side's daxian-stem 化忌 flies into the other party's 命宮). No scoring, deterministic.

> **Compatibility note (2026-11-04):** `chart.currentDaXianIndex` can be **-1** when
> the queried year has not yet entered the first 大限 (e.g. toddlers — 起运未入).
> Guard before indexing (`if (idx >= 0)`); `daXianCheck` handles -1 internally but
> integrators reading `currentDaXianIndex` directly must not assume ≥ 0. Same guard
> applies to any `layers:["daxian"]`-style indexing on `ziwei_sihua_layers` payloads.
```json
{"a":{"year":1986,"month":12,"day":8,"hour":23,"minute":45,"gender":"male","longitude":114.2},
 "b":{"year":1994,"month":6,"day":15,"hour":8,"minute":0,"gender":"female"}}
```

### `ziwei_batch_stats`
Corpus statistics over DETERMINISTICALLY enumerated charts. **Fixed 2026-11-04:** the default census is now day × **all 12 hour-branches** (`hours:"all"`) instead of a locked-noon subspace; stride thinning runs over the day×hour slot space to stay under `maxCharts` (~5000). Pass `hours:[6]` (or legacy `hourBranch`) to reproduce the old noon-only behaviour. NO random sampling — reproducible; NOT population-representative (uniform dates, no birth-rate weighting). Default 1950–2000 run ≈ 25 s (measured 24.9 s / 4968 charts) — safely under the 120 s subprocess limit thanks to the stride cap; an uncapped full census would be ~2.5 min and is not the default.

**Fixed 2026-11-05 — non-blocking:** the batch child is spawned ASYNC (was a synchronous 120 s `execFileSync`). While a batch runs, `/health` and concurrent tool calls keep answering (<50 ms measured during the full default census). Output contract unchanged. If you relied on the old behaviour “server is busy while batch_stats runs”, note the server is now fully concurrent.
```json
{"question":"main-star-in-mingGong-distribution","gender":"male"}
// question ∈ main-star-in-mingGong-distribution | sihua-palace-distribution | wuxingJu-distribution
// hours: "all" (default) | [0..11 subset]; hours:[6] == legacy noon-only
```

**Counting note (2026-11-04):** distribution counts are **per-star occurrences,
not per-chart** — a chart whose 命宮 has two main stars (e.g. 太陽巨門) contributes
to BOTH counts, so `sum(counts)` can exceed `chartsComputed` (verified live: 5833
vs 4380 on 1985–86). Do NOT divide a count by `chartsComputed` to claim population
share without stating this. The result meta emits `sumOfCounts` next to
`chartsComputed` so integrators can audit the ratio.

### `ziwei_school_compare`
One birth run under each convention this engine honours (`lateZishi` next-day vs current-day; `leapMonth` split/next-month/prev-month/origin-month) → per-variant digests + `diffFromDefault` lists (which fields changed). Other school-config knobs are UI-layer only and do not change output.
```json
{"year":1986,"month":12,"day":8,"hour":23,"minute":45,"gender":"male","longitude":114.2}
```

### `ziwei_render`
Renders the chart as a pure-string 12-palace SVG grid (4×4, center meta block, main stars + brightness + color-coded 生年四化 marks) — same layout as our report SVGs. No image libraries. Returns `{svg, meta}`.

**Feature C (2026-11-04):** optional `layers:["liunian"]` and/or `["daxian"]` overlays that layer's flying stars onto the grid — dashed corner badge per hit palace (second colour `#7a4dbf`) + a legend line; `flowYear` selects the liunian year (default: current year). **Default (no `layers`) stays natal-only and byte-identical to previous output** (anchored in `tests/gold/render-default-1986.svg`).
```json
{"year":1986,"month":12,"day":8,"hour":23,"minute":45,"gender":"male","longitude":114.2}
{"year":1986,"month":12,"day":8,"hour":23,"minute":45,"gender":"male","layers":["liunian"],"flowYear":2026}
```

## Quick smoke test (raw protocol)

```
printf '%s\n' \
 '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"1.0"}}}' \
 '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
 '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
 | <repo-root>/vendor/ziwei-doushu/node_modules/.bin/tsx \
     <repo-root>/services/ziwei-mcp/index.ts
```

Expected: line 1 = initialize result (serverInfo `ziwei-mcp/0.3.2`), line 3 = both tools with schemas.

## Gold-standard assertion (use this to verify your client wired correctly — same on both transports)

Call `ziwei_chart` with `{"year":1986,"month":12,"day":8,"hour":23,"minute":45,"gender":"male","longitude":114.2}`:
effectiveDate **1986-12-09** · fourPillars **丙寅/庚子/丁亥/庚子** · 命宮 branch **子**, main star **天同(旺)** · **土五局** · 命主 貪狼 / 身主 天梁 · true solar **23:29:34**.

And `ziwei_sihua_layers` with `{"year":2026,"gender":"male","birth":{...same...},"layers":["liunian"]}`:
stem **丙** · 祿 天同→命宮 · 權 天機→官禄 · 科 文昌→夫妻 · 忌 廉貞→子女.

## Limitations / notes

- **stdio = local process only** (Phase 1); remote hosts use the HTTP transport above.
- **HTTP SSE** — `GET /mcp` with `Accept: text/event-stream` now provides the
  server-push stream (20 s keep-alive pings, session-id addressing via DELETE).
  The stream carries no JSON-RPC traffic because our tools are request/response
  only — it satisfies clients that require an open stream to connect.
- Token travels in cleartext HTTP — trust the LAN boundary only; do not expose port
  9878 beyond it (no TLS termination here by design).
- Birth data is passed per call and never stored server-side (stateless by design).
- Known engine conventions preserved: no China-DST auto-correction 1935–1991; leap-month liuyue uses base-month stem.
- Test suites: `tests/run-tests.sh` (stdio A–G, 9/9 PASS) · `tests/http-tests.sh` (38/38 PASS against the live daemon, incl. SSE).

## Changelog — 2026-11-05 07:45 (deep-review fixes — read if you integrate)

Six fixes from the 2026-11-05 deep review; gold chart + default render SVG
byte-identical throughout; selftest now 13 checks. Behaviour deltas that can
reach a client:

- **`ziwei_compatibility.tianZuoZhiHe` can now be `true`** (mirror test was
  inverted — see section above). `oneWayMirror` semantics unchanged in form,
  corrected to cross-side overlap.
- **`ziwei_sihua_layers` with `lunarMonth` returns corrected stems** (see
  table above; 2026 m1 戊 → 庚). Clients that hard-coded old values must
  re-baseline. New `isLeapMonth` arg validated (`isError` on invalid leap).
- **`jiFlags` 化忌入对方夫妻宫 flag now fires** where applicable.
- **`ziwei_batch_stats` no longer blocks the server** — concurrent requests
  and `/health` keep answering during the ~25 s census.
- **Unknown top-level args are echoed** as `meta.ignoredKeys` (+ note) instead
  of being silently dropped — schemas remain permissive by design.
- **`ziwei_sihua_layers` with BOTH `year` and `yearWindow` → `isError`**
  (previously silently split sources).
- **`ziwei_solar_lunar` solar direction bounded 1900–2050** (`isError` outside;
  previously plausible-but-wrong dates). Matches the lunar direction.
- **liushi `flowHour:23` uses the next day's stem/branch** (day-shift, payload
  echoes `dayShiftFromLateZi:1`). liushi remains informational only.
- **Docs/tests:** http suite now 38 assertions (README previously said "21"/
  "32", both stale); stdio suite extended A–G (9/9) with the deep-fix block.
- **Contract:** 9 tools unchanged; no vendor/engine changes.

## Changelog — 2026-11-05 05:01 (liuyue month-only descriptive span fields, reviewer round 3 follow-up)

- **Additive:** month-only `liuyue` payloads gain `monthSpan` (ordered lunar
  months the solar month spans, `{lunarMonth, isLeap}` entries, deduplicated) +
  `resolvedAs` (deterministic resolution string naming the sampled 15th, e.g.
  `m1 (lunar month containing 2026-03-15)`). `ambiguousMonth` retained unchanged
  for backward compat but demoted — after the unified mid-month rule it is
  effectively always-true on month-only paths (constant booleans get warnings
  disabled client-side), so `monthSpan`/`resolvedAs` are the decision fields and
  `note` says so. `flowDate` remains the precise path; flowDate payloads stay
  byte-identical (no new fields). Gold chart + default render SVG byte-identical;
  selftest stays 12 checks.
- **Contract:** 9 tools unchanged; no vendor/engine changes.

## Changelog — 2026-11-05 early AM (unified month-only tie-break, reviewer round 3)

- **Unified rule (FIXED):** month-only `liuyue` resolution now samples the 15th
  for EVERY straddle type; `ambiguousMonth` flags ordinary (non-leap) boundaries
  too — previously 12 straddles/year got zero warning while only rare leap
  straddles did, and the two paths tied-broke differently (leap→later segment,
  ordinary→mid-month). Observable change: **2023-04 month-only 丙 → 乙**
  (2023-04-15 = 闰二月十五 → 乙); 2026-01 戊 / 2025-01 丁 / 2026-03 庚 keep
  their stems and gain the flag. All `flowDate` results unchanged; gold chart
  + default render SVG byte-identical. January selftest checks #9/#10 verified
  unchanged. Tie-break rationale: see the `ziwei_sihua_layers` section above.
- **Selftest:** check 12 `ordinaryStraddle2026Mar` added (2026-03 → 庚 +
  ambiguousMonth) — ≥ 12 checks. Fail-first discipline observed.
- **Contract:** 9 tools unchanged; no vendor/engine changes.

## Changelog — 2026-11-04 late-evening (leap-month straddle fix)

- **BUG #4 (FIXED):** liuyue ignored the DAY when a solar month straddles a
  leap-month boundary (2023-04: 闰二月 until 4/19, 三月 after — every date
  returned 乙 ✗). `flowDate` now resolves the lunar month by day (2023-04-25
  → 丙, 2023-04-05 → 乙); bare `month` queries over straddling months return
  the later segment's stem + `ambiguousMonth:true` + `note`. Non-straddling
  behaviour unchanged (gold-anchored). Selftest ≥ 11 checks.
- **Docs:** lunar-month convention documented under `ziwei_sihua_layers` above
  (vs solar-term practice, divergence example mid-2026-01 戊子/辛丑);
  `birthInfo.hour` = branch-index clarification; `currentDaXianIndex` may be -1.
- **Contract:** 9 tools unchanged; gold chart + default render SVG byte-identical.

## Changelog — 2026-11-04 (external-client bugfix + feature batch)

- **BUG #1 (critical, FIXED):** `ziwei_sihua_layers` liuyue month stem was wrong
  across the lichun/lunar-year boundary (pre-lichun dates took the stem from the
  requested calendar year but the month number from the lunar conversion).
  Now lichun-exact throughout; `yearStemUsed`/`ganzhiYear` echoed. See
  `ziwei_sihua_layers` above for corrected reference values.
- **BUG #2 (FIXED):** `chart.birthInfo` echoes engine-corrected values by
  design; `meta.rawInput` added to `ziwei_chart` for the original caller args.
- **BUG #3 (FIXED):** `ziwei_batch_stats` default is now the all-12-hour
  day×hour census (`hours:"all"`); legacy single-hour via `hours:[6]`.
- **Features:** `yearWindow` ganzhi mode (A), `daXianCheck` in compatibility
  (B), render layer overlays (C) — see tool sections above.
- **Selftest:** checks 9–10 added (January lichun-boundary stems 戊/丁,
  deterministic); check 11 added late-evening (leap straddle 2023-04-25 → 丙).
  `ziwei_selftest` now returns ≥ 11 checks.
- **Contract:** 9 tools unchanged; gold chart + default render SVG byte-identical.
