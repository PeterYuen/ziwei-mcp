# ziwei-mcp — Ziwei Doushu MCP server (Phase 1 stdio + Phase 2 HTTP)

> 🌐 **English** | [繁體中文](README.zh-TW.md) | [简体中文](README.zh-CN.md)

Deterministic [紫微斗数](https://en.wikipedia.org/wiki/Ziwei_doushu) chart + 四化-layer
server over **two MCP transports**: stdio (Phase 1, local clients) and Streamable HTTP
(Phase 2, `http.ts`, LAN/remote clients, bearer-token). Stateless (birth data supplied
per call, nothing stored), zero LLM inside the server — pure engine math.

## Layout & boundaries

- `tools.ts` — shared tool implementations + transport-agnostic JSON-RPC dispatcher,
  imported VERBATIM by both entrypoints (single source of truth; no forked logic).
- `index.ts` — Phase 1 entrypoint: newline-delimited JSON-RPC 2.0 over stdin/stdout
  (stdlib only, **no npm installs**); thin plumbing over `tools.ts`.
- Engine (read-only, pinned `495b79e`): `../../vendor/ziwei-doushu/lib/ziwei/`
  (`algorithm.generateChart`, `sihua.*`, `true-solar-time.*`). Never modified.
- The true-solar-time correction is applied in `tools.ts`: the vendored
  `generateChart` ignores `birthInfo.longitude`, so the correction
  (longitude + equation of time → 时辰 branch + day offset, `next-day` late-子 rule)
  is applied **before** calling the engine.
- `http.ts` — Phase 2 entrypoint: `node:http` daemon implementing MCP **Streamable
  HTTP** in pure-JSON response mode (see HTTP section below). Binds `0.0.0.0:9878`,
  requires a bearer token on every `/mcp` request.
- `batch-stats-worker.mts` + `batch-stats-job.mts` — subprocess helpers for
  `ziwei_batch_stats` (parallel day enumeration via `node:worker_threads`, stdlib
  only; spawned by `tools.ts` with the vendored tsx binary — same engine, same
  pin, no npm installs).
- `.token` — the HTTP bearer token (random 256-bit hex, **chmod 600**). Never logged,
  never printed; reference by path only.
- This service deliberately lives **OUTSIDE** the git fork (`vendor/ziwei-doushu`),
  which stays engine-only for clean upstream syncs. Attribution: upstream
  [github.com/Renhuai123/ziwei-doushu](https://github.com/Renhuai123/ziwei-doushu)
  (MIT). The fork's true-solar fix is mirrored here, not upstreamed into vendor.

## Install

Requirements:

- **Node.js ≥ 20** (stdlib only — no npm installs for this service).
- **Engine dependency:** a vendored copy of the Ziwei Doushu engine, pinned to
  commit `495b79e` of [github.com/Renhuai123/ziwei-doushu](https://github.com/Renhuai123/ziwei-doushu)
  (MIT; dataset CC BY 4.0 — see `NOTICE`). The engine is **not** redistributed
  with this repository; place your own checkout at
  `<repo-root>/vendor/ziwei-doushu/` (directory read-only), with its own
  `node_modules` installed. The `tsx` binary used to run this service comes
  from that vendored `node_modules`:

```bash
git clone https://github.com/Renhuai123/ziwei-doushu vendor/ziwei-doushu
( cd vendor/ziwei-doushu && git checkout 495b79e && npm install )
```

This service then imports `vendor/ziwei-doushu/lib/ziwei/*` (algorithm, sihua,
true-solar-time, yunxian-context, constants, cities, lunar-solar,
heming-knowledge) plus `lunar-javascript` from the vendored `node_modules`.
Everything else is Node stdlib.

## Running standalone

```bash
vendor/ziwei-doushu/node_modules/.bin/tsx services/ziwei-mcp/index.ts
```

Then type JSON-RPC lines on stdin (one per line). stdout is protocol-only;
logs go to stderr.

```
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"cli","version":"0"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"ziwei_chart","arguments":{"year":1986,"month":12,"day":8,"hour":23,"minute":45,"gender":"male","longitude":114.2}}}
```

Unknown method → JSON-RPC `-32601`; tool-level validation errors return
`result.isError:true` (protocol survives); malformed lines → `-32700`.

## HTTP daemon (Phase 2) — remote access

```bash
systemctl --user start ziwei-mcp     # boot-resilient unit (Linger=yes, enabled)
journalctl --user -u ziwei-mcp -f    # logs (token never included)
bash services/ziwei-mcp/tests/http-tests.sh   # 38 assertions against the live daemon
```

- **URL:** `http://<host>:9878/mcp` (LAN hosts: substitute your own address; the daemon binds 0.0.0.0).
  Port 9878 verified free at deploy time; if taken at startup the daemon auto-increments
  (next free ≥ 9878) and logs the actual port.
- **Auth:** `Authorization: Bearer $(cat services/ziwei-mcp/.token)` or `?token=<t>`
  query param (either accepted, constant-time compare). Missing/wrong → **401**.
- **`GET /health`** — no auth, no chart data: `{"status":"ok","server":"ziwei-mcp","version":"0.2.0"}`.
- **Transport modes (Streamable HTTP spec):**
  - **JSON response mode** (default): POST a single JSON-RPC message or a batch
    array, get `application/json` back (202 for notification-only posts).
  - **SSE stream mode**: `GET /mcp` with `Accept: text/event-stream` (+ auth)
    opens a server-push stream — `Content-Type: text/event-stream`, no-cache,
    keep-alive. The response header `Mcp-Session-Id` carries a per-stream UUID.
    The stream is kept healthy by SSE **comment pings every 20 s** (override:
    `ZIWEI_MCP_SSE_KEEPALIVE_MS`); up to 16 concurrent streams
    (`ZIWEI_MCP_SSE_MAX_STREAMS`, excess → 503). `DELETE /mcp` with that header
    closes the stream (200); unknown/absent id → 404. Client disconnects are
    detected and cleaned up automatically.
  - `GET /mcp` **without** `Accept: text/event-stream` → **405** (`Allow:
    GET, POST, DELETE`) — the stream is only opened on explicit SSE negotiation.
  - POST bodies are dispatched identically whether or not an `Mcp-Session-Id`
    header is present: **responses always return on the POST connection as
    JSON** (spec-permitted), never routed onto the SSE stream. This keeps the
    headerless curl path byte-identical to the previous version. Our tools are
    request/response-only, so no server-initiated JSON-RPC messages are ever
    pushed onto the stream today — it exists for push-capable MCP clients that
    require an open stream to connect.
- **Concurrency model:** Node single-threaded event loop; chart math is synchronous CPU
  (~10–50 ms), so requests serialize naturally — no shared state, safe under any
  concurrency. 1 MiB body limit.

Example remote client config (most MCP clients accept a `url` field for streamable
HTTP instead of `command`; replace `<host>` and read the token from `.token`):

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

## Tools (9 — all-tools batch 2026-11-03)

| tool | one-liner |
|---|---|
| `ziwei_chart` | full natal chart JSON from solar birth data (true-solar correction when `longitude` given) |
| `ziwei_sihua_layers` | 四化 layers daxian/liunian/liuyue + liuri/liushi (day/hour: informational only) |
| `ziwei_from_city` | chart by city name (Chinese or common English), resolved via vendored `cities.ts`; explicit `longitude` overrides |
| `ziwei_solar_lunar` | bidirectional solar⇄lunar conversion + four-pillars for the result (1900–2050) |
| `ziwei_selftest` | built-in gold-standard regression self-test → `{pass, checks[]}`, deterministic |
| `ziwei_compatibility` | 合盤 two-person comparison on vendored `heming-knowledge.ts` — structured findings, no invented score |
| `ziwei_batch_stats` | corpus distributions over DETERMINISTIC day×hour enumeration (`hours:"all"` default since 2026-11-04; no random sampling; not population-representative). Counts are **per-star occurrences**, not per-chart — sum can exceed `chartsComputed`; see note below |
| `ziwei_school_compare` | same birth under each convention the engine honours (lateZishi × leapMonth) + diff summary |
| `ziwei_render` | 12-palace grid as pure-string SVG (4×4 + center meta, siHua color-coded) |

Example calls (all via `tools/call` params.arguments):

```jsonc
// ziwei_from_city — "Hong Kong" ≡ longitude 114.2
{"year":1986,"month":12,"day":8,"hour":23,"minute":45,"gender":"male","city":"Hong Kong"}
// ziwei_solar_lunar — exactly one side
{"lunar":{"year":1986,"month":11,"day":8}}
// ziwei_selftest — no args
{}
// ziwei_compatibility — two births
{"a":{"year":1986,"month":12,"day":8,"hour":23,"minute":45,"gender":"male","longitude":114.2},
 "b":{"year":1994,"month":6,"day":15,"hour":8,"minute":0,"gender":"female"}}
// ziwei_batch_stats — deterministic day×hour census (default hours:"all")
{"question":"wuxingJu-distribution","gender":"male","yearFrom":1950,"yearTo":2000,"maxCharts":5000}
// ziwei_batch_stats — legacy single-hour run (reproduces pre-2026-11-04 behaviour)
{"question":"wuxingJu-distribution","gender":"male","yearFrom":1950,"yearTo":1950,"hours":[6]}
// ziwei_sihua_layers — day/hour layers need flowDate (+flowHour for liushi)
{"year":2026,"gender":"male","birth":{"year":1986,"month":12,"day":8,"hour":23,"minute":45,"longitude":114.2},
 "layers":["liuri","liushi"],"flowDate":{"year":2026,"month":11,"day":3},"flowHour":10}
// ziwei_school_compare / ziwei_render — birth data like ziwei_chart
{"year":1986,"month":12,"day":8,"hour":23,"minute":45,"gender":"male","longitude":114.2}
```

### `ziwei_chart`

Full natal chart JSON (palaces, stars, brightness, siHua marks, daXians, fourPillars).

| field | type | notes |
|---|---|---|
| `year` `month` `day` | int | solar (Gregorian) date; nonexistent dates rejected |
| `hour` | int 0-23 | local **clock** hour (`23` → late-子: chart day advances) |
| `minute` | int 0-59 | |
| `gender` | `"male"`\|`"female"` | |
| `longitude` | number? | degrees East; enables true-solar-time correction |
| `latitude` | number? | accepted, inert (correction uses longitude + EoT only) |

Result: `{ meta: {effectiveDate, hourBranch, trueSolarTime, fourPillars, rawInput, ...}, chart: <full ZiweiChart> }`.
Without `longitude` the correction is inert (same chart; `meta.trueSolarTime:null`).

> **`birthInfo` vs `meta.rawInput` (2026-11-04):** `chart.birthInfo` reflects the
> **engine-corrected effective input** (e.g. late-子 birth at 23:00 shows
> `day+1`, `hour:0`). To echo the caller's **original** values, read
> `meta.rawInput` (`{year,month,day,hour,minute,gender[,longitude][,latitude]}`) —
> exact arguments as received, never shifted. Same note applies to noon cases
> where the engine normalises the hour representation.

### `ziwei_sihua_layers`

四化 layers over the internally-generated natal chart. Keys are Chinese: `禄/权/科/忌`;
each transform maps to `{star, palace}` via `chart.palaces[].stars[].name`.

| field | type | notes |
|---|---|---|
| `year` | int | Gregorian year of the layer window (omit when `yearWindow` is given) |
| `yearWindow` | string? | 2026-11-04: ganzhi pair (e.g. `"丙午"`) instead of `year` — stem/branch taken directly from the pair, eliminating the lichun-boundary trap for liunian/liuyue/liuri/liushi |
| `gender` | `"male"`\|`"female"` | |
| `birth` | object | `{year,month,day,hour,minute,longitude?}` — same semantics as `ziwei_chart` |
| `layers` | array | any of `"daxian"`, `"liunian"`, `"liuyue"`, `"liuri"`, `"liushi"` |
| `month` | int 1-12? | **solar** month, required for `liuyue` unless `lunarMonth`/`flowDate` given (converted to lunar month internally at mid-month) |
| `lunarMonth` | int 1-12? | direct lunar month for `liuyue` (alternative to `month`) |
| `flowDate` | `{year,month,day}`? | 2026-11-04: also resolves `liuyue` **by day** when given — pins leap-month straddles (required for `liuri`/`liushi` anyway) |

Layer semantics (per `references/time-layers.md`):

- `daxian` — stem = the **大限宮 stem**, not the birth stem
  (`getDaXianSiHua`); includes `ageRanges`, `currentLayerIndex`, `ageRange`, `xuSui`
  (虛歲 = year − lunarYear + 1). Childhood years resolve via `CHILDHOOD_DAXIAN_INDEX`.
- `liunian` — stem = year stem (`(year-4)%10`).
- `liuyue` — 五虎遁 month stem (`getLiuYueSiHua`); leap months carry their base
  month's stem. **FIXED 2026-11-04:** the year stem is now the lichun-exact
  ganzhi year of the flow date (engine `getEightChar().getYear()`), not the
  requested calendar year — the old two-source mix was wrong for solar dates
  before lichun (~Feb 4): e.g. 2026-01 belongs to 乙巳年 lunar m11 → 戊子
  (was 庚 ✗); 2025-01 → 甲辰年 m12 → 丁丑 (was 己 ✗); 2027-01 → 丙午年 m12 →
  辛丑 (was 癸 ✗). Post-lichun behaviour is unchanged (2026-03 = 丙午 m1 = 庚寅,
  verified). Payloads echo `yearStemUsed` + `ganzhiYear` for client audit.
  **FIXED 2026-11-04 (2, leap-month straddle); UNIFIED 2026-11-05:** with
  `flowDate` the lunar month resolves BY DAY — 2023-04-25 is 三月初六 → stem 丙,
  while 2023-04-05 is 闰二月十五 → stem 乙 (癸卯年 五虎遁). Month-only (bare
  `month`) now follows ONE unified rule for every straddle type: **resolve to
  the lunar month containing the 15th of the solar month** (mid-month rule).
  The old leap-specific 'later segment' special case is removed. Give `flowDate`
  to pin the exact day. The DECISION fields on month-only payloads are the
  descriptive `monthSpan` (the ordered lunar months the solar month spans, each
  `{lunarMonth, isLeap}`, deduplicated) and `resolvedAs` (the exact resolution,
  naming the sampled date, e.g. `m1 (lunar month containing 2026-03-15)`).
  `ambiguousMonth: true` is retained for backward compat but is effectively
  always-true on month-only paths (lunar months ~29.5 d are shorter than every
  solar month, so first-day/last-day always differ — a constant boolean carries
  no signal); `note` points at `monthSpan`/`resolvedAs`. Reference values
  (month-only): 2023-04 → **乙** (2023-04-15 = 闰二月十五; was 丙 via
  later-segment — the ONLY stem change), 2026-01 → **戊**, 2026-03 → **庚**.
  January selftest checks (#9/#10) unchanged.

#### Month convention (LUNAR months — read this if you follow solar-term practice)

**This engine's `liuyue` uses LUNAR months**: 五虎遁 is applied to the
*converted lunar month* of the queried date, and a leap month carries its
base month's stem. Mainstream flying-star practice often uses **solar-term
months** instead (清明 onwards = 辰月 regardless of the lunar date). The two
conventions diverge structurally near month boundaries — e.g. mid-2026-01:
lunar convention gives **戊子**, solar-term convention gives **辛丑**. No
`solarTerm` mode exists (design decision not made). If your practice follows
solar terms, expect divergence at month boundaries; use `flowDate` to pin the
exact day and audit `lunarMonth`/`isLeapMonth` in every liuyue payload.
- `liuri`/`liushi` — day/hour stems; NOT affected by the bug (they use the
  lunar-calendar year / day stem internally, not the two-source mix).
- `yearWindow` (FEATURE A) — `"丙午"` ≡ `year:2026`; invalid pairs (unknown char
  or 60-cycle parity mismatch like `"甲丑"`) → `isError`. Echoes
  `yearStemUsed`/`ganzhiYear` on every layer. When only `yearWindow` is given,
  calendar lookups (daxian ranges, solar→lunar month) use the representative
  modern-cycle year 1984–2043 matching the pair.

## Tests

```bash
bash services/ziwei-mcp/tests/run-tests.sh     # stdio A-G, 9/9 (E = all-tools batch, F = bugfix/feature regression incl. 2026-11-05 unified straddle rule, G = 2026-11-05 deep-fix suite: mirror cross-check, jiFlags, lunarMonth four-path table, bounds, day-shift, ignoredKeys)
bash services/ziwei-mcp/tests/http-tests.sh    # HTTP: auth, protocol, batch, gold, SSE, all tools + 2026-11-04/05 assertions (38)
```

Gold anchors (all in-repo, self-contained): `tests/gold/chart-1986.json` (ziwei_chart
byte-identity; chart object must never change) and `tests/gold/render-default-1986.svg`
(default render byte-identity).

Reference (gold-standard) birth — a SYNTHETIC anchor date, deliberately not any real
person's: `1986-12-08 23:45 male lon 114.2` → effective `1986-12-09`, pillars
丙寅/庚子/丁亥/庚子, 命宮 子·天同(旺)（太陰同宮）, 土五局, 命主 貪狼,
身主 天梁, 生年四化: 天同祿→命宮, 天機權→官禄, 文昌科→夫妻, 廉貞忌→子女.

## Changelog — 2026-11-05 07:45 (deep-review fixes: mirror test, lunarMonth path, jiFlags, async batch_stats, arg hygiene)

Six fixes from the 2026-11-05 deep review. Gold chart + default render SVG
byte-identical throughout; selftest now **13 checks** (new `lunarMonthDirect2026`).

1. **`ziwei_compatibility` mirror test was inverted (CRITICAL).** The cross-check
   tested each side's 夫妻 stars against its OWN 命宮 instead of the partner's —
   `tianZuoZhiHe` could never express methodology §2. Now: A's 夫妻 stars ⊂ B's
   命宮 AND B's 夫妻 stars ⊂ A's 命宮. **Observable delta:** `tianZuoZhiHe` can now
   be `true` (previously effectively always false); `aFuqiStarsInBMing` /
   `bFuqiStarsInAMing` now report true cross-intersections (previously
   self-filtered). Golden positive: `{a:1970-05-15 10:00 male, b:1988-11-15
   10:00 female}` → 武曲⊂(武曲天府) + 破军⊂(破军) → `true`. Self-pair (a=b) is
   trivially true only when one's own 夫妻 stars sit in one's own 命宮 — normal
   charts (e.g. the gold birth) stay `false`; the detail string names the rule.
2. **`ziwei_sihua_layers` direct `lunarMonth` path two-source bug (CRITICAL).**
   The lunar month NUMBER was fed in as a SOLAR month, so `lunarMonth:1` always
   resolved against solar Jan 15 = pre-lichun → year stem off by one ganzhi year
   (2026 m1 returned 戊/乙巳 instead of 庚/丙午). Now resolved through the vendored
   lunar tables: reference = solar date of lunar (`year`, m, 15). Four-path
   agreement holds for m1 across 2022–2028 (壬 甲 丙 戊 庚 壬 甲). m12 edge:
   mid-month lands early next year pre-lichun → stem still belongs to `year`'s
   ganzhi (2026 m12 → solar 2027-01-22 → 丙午 → 辛, unchanged). New
   `isLeapMonth:true` validation: leap-less year or wrong leap month → `isError`
   (previously silently ignored). Schema documents `isLeapMonth` explicitly.
3. **`jiFlags` 夫妻 comparison was dead (MAJOR).** Engine palace names carry no
   宮 suffix except 命宮; `jiPalace === '夫妻宫'` never matched. Fixed to
   `'夫妻'` — the 化忌入对方夫妻宫 flag is now live (verified pair:
   A 1960-01-05 00:00 male → 文曲化忌 lands in B 1963-07-05 00:00 male's 夫妻).
4. **`ziwei_batch_stats` blocked the event loop (MAJOR).** Synchronous
   `execFileSync` (up to 120 s) replaced with async `spawn`; `dispatch()` is now
   async and both entrypoints await it. **Observable delta:** `/health` answers
   <50 ms while a full-range batch runs (measured 13–23 ms × 3 during the
   default 1950–2000 census). Same output contract otherwise.
5. **Unknown arguments are echoed, not silently dropped.** Schemas declare
   `additionalProperties:false` but enforcement stays permissive for client
   compatibility (hard-reject would break existing callers). When unknown
   top-level args arrive, `meta.ignoredKeys` + `meta.ignoredKeysNote` appear in
   the response meta listing exactly what was ignored.
6. **Minor cluster:** `year` + `yearWindow` together → `isError` (previously
   silently split sources); `ziwei_solar_lunar` solar direction bounded to
   1900–2050 (out-of-range returned plausible-but-wrong dates; now `isError`,
   matching the lunar direction); liushi `flowHour:23` now applies the same
   next-day shift as the natal resolver (was using the same day's stem —
   verified: 2026-11-05 23:xx == 2026-11-06 00:00 layer, 甲申); README/http-tests
   assertion counts corrected to 38 (was "21"/"32", both stale).

## Changelog — 2026-11-05 05:01 (liuyue month-only descriptive span fields, reviewer round 3 follow-up)

**Additive only:** month-only `liuyue` payloads gain two descriptive fields:

- **`monthSpan`** — array of the lunar months the solar month spans, in order,
  each `{lunarMonth, isLeap}`, deduplicated (non-straddling months →
  single-element array). Example: `{2026, month:3}` → `[{lunarMonth:1,isLeap:false},{lunarMonth:2,isLeap:false}]`.
- **`resolvedAs`** — deterministic resolution string naming the sampled date,
  e.g. `m1 (lunar month containing 2026-03-15)`.

**Why not the boolean:** after the unified mid-month rule, `ambiguousMonth:true`
fires on essentially EVERY month-only query (lunar months ~29.5 d are shorter
than every solar month, so first-day/last-day always differ). A constant boolean
is not a signal — any client writing `if (ambiguousMonth) warn()` gets a 100%
warning rate and will disable warnings entirely, killing the signal for genuinely
ambiguous cases too. So `ambiguousMonth` is demoted to a backward-compat flag
(unchanged value/semantics) and `monthSpan`/`resolvedAs` become the decision
fields; `note` now says so explicitly. `flowDate` remains the precise path —
flowDate payloads are byte-identical (no new fields on that path). Gold chart +
default render SVG byte-identical; selftest stays 12 checks.

## Changelog — 2026-11-05 (unified month-only tie-break, reviewer round 3)

**`liuyue` month-only resolution is now one rule for all straddle types:**

- **Mid-month rule:** a bare `month` query resolves to the lunar month
  containing the **15th** of the solar month. The leap-specific
  'later segment' special case is REMOVED — both paths (leap/ordinary) now
  tie-break identically.
- **`ambiguousMonth` flags ANY boundary straddle:** the flag + `note`
  (recommend `flowDate`) fires when the solar month's first and last day map
  to different lunar months, leap or not. Since a lunar month (~29.5 d) is
  shorter than every solar month, essentially every month-only query is now
  honestly flagged instead of silently picking the earlier segment while only
  rare leap straddles warned (the round-2 asymmetry).
- **Why not 'later segment everywhere'** (the reviewer's alternative): for
  January months the later segment (e.g. 2025-01-29/31) is already lunar m1 of
  the NEXT ganzhi year while the lichun-derived year stem is still the CURRENT
  year — pairing m1 with the pre-lichun stem re-introduces the exact
  two-source bug class fixed twice (2026-11-04 #1/#4). Mid-month sampling can
  never land in that gap window. Verified consequence: later-segment would
  flip 2026-01 戊→己 and 2025-01 into gap-window garbage; mid-month keeps both
  January selftest checks (#9 丁, #10 戊) passing unchanged.
- **Observable changes:** 2023-04 month-only **丙 → 乙** (2023-04-15 =
  闰二月十五 → leap m2 base stem 乙) — the ONLY stem change. New flags,
  stems unchanged: 2026-01 → 戊+flag, 2025-01 → 丁+flag, 2026-03 → 庚+flag.
  All `flowDate` results unchanged (by-day path untouched: 2023-04-25 → 丙,
  2023-04-05 → 乙). Gold chart + default render SVG byte-identical.
- **Selftest:** check 12 `ordinaryStraddle2026Mar` locks the ordinary-boundary
  defense (month-only 2026-03 → stem 庚 AND `ambiguousMonth` true). Checks ≥ 12.
  Fail-first: tests written before the fix, confirmed failing against the old
  code (2026-03 unflagged, 2026-01 unflagged, 2023-04 → 丙), then passing.
- **Contract:** 9 tools unchanged; no vendor/engine changes.

## Changelog — 2026-11-04 (bugfix + feature batch, found by external client testing)

**Bug fixes** (each landed fail-first: regression test confirmed failing against
the old code, then fixed, then confirmed passing — see `tests/run-tests.sh`
section F):

1. **liuyue month stem across the lichun/lunar-year boundary (CRITICAL).** The
   五虎遁 year stem came from the *requested calendar year* while the month
   number came from the *lunar* conversion — two sources, wrong for pre-lichun
   dates. Now both derive from one flow date via the engine's own lichun-exact
   tables. Fixed values: 2025-01 → 丁 (was 己), 2026-01 → 戊 (was 庚),
   2027-01 → 辛 (was 癸). `yearStemUsed` + `ganzhiYear` echoed in the payload.
   `liuri`/`liushi` checked — they do **not** share the bug (different stem
   source) and were left untouched.
1b. **liuyue leap-month straddle (late-evening fix, same day).** A solar month
   straddling a leap-month boundary (2023-04: 闰二月 until 4/19, 三月 after)
   resolved by mid-month sampling — every April date returned the leap segment
   (乙 ✗; 2023-04-25 = 三月初六 should be 丙). Now `flowDate` resolves the
   lunar month by day; bare `month` queries over straddling months return the
   later segment's stem plus `ambiguousMonth: true` + `note`. Selftest check 11
   (`liuyueStem2023Apr25` → 丙) locks it in; checks count ≥ 11. The
   **Month convention** note above documents the underlying lunar-month choice.
   *(Superseded 2026-11-05: the later-segment tie-break was replaced by the
   unified mid-month rule — see the 2026-11-05 changelog above.)*
2. **`birthInfo` echoes corrected values, not raw input.** `chart.birthInfo`
   intentionally unchanged (byte-identity contract); `meta.rawInput` added to
   every `ziwei_chart` result echoing the exact caller arguments. Integrators:
   read `meta.rawInput`, not `birthInfo`, for original values.
3. **`ziwei_batch_stats` fixed-hour bias.** Default is now `hours:"all"` —
   census over day × 12 hour-branches (stride thinning over the slot space).
   `hours:[6]` (or legacy `hourBranch`) reproduces the old noon-only behaviour.
   The `maxCharts` cap (default 5000) keeps the default 1950–2000 run ≈ 25 s
   (measured 24.9 s, 4968 charts) — well under the 120 s subprocess limit; an
   uncapped full census would be ~2.5 min and is deliberately not the default.

**`ziwei_batch_stats` counting note (2026-11-04):** distribution counts are
**per-star occurrences, not per-chart** — a chart whose 命宮 holds two main stars
(e.g. 太陽巨門) contributes to BOTH counts, so `sum(counts)` can exceed
`chartsComputed` (verified live: 5833 vs 4380 on 1985–86). Do NOT divide a count
by `chartsComputed` to claim a population share without stating this. The result
meta now also emits `sumOfCounts` next to `chartsComputed` for auditing.

**Features:** A) `yearWindow` ganzhi mode on `ziwei_sihua_layers` (see above);
B) `daXianCheck` block in `ziwei_compatibility` — both parties' current daxian
palace branch/stem + flags (same-branch, same-stem, same-ganzhi 同干支 = both,
each side's daxian-stem 忌 flying into the other's 命宮); pure structural, no
scoring; C) `ziwei_render`
`layers:["liunian"|"daxian"]` overlay (dashed corner badges + legend line, second
colour `#7a4dbf`; `flowYear` selects the liunian year; default natal-only SVG is
byte-identical to the previous output — anchored in `tests/gold/`).

**Selftest:** `ziwei_selftest` grew checks 9–10 — January lichun-boundary month
stems (2026-01 → 戊, 2025-01 → 丁) computed deterministically from the engine's
own tables; check 11 (2026-11-04 late evening) adds the leap-straddle case
(2023-04-25 → 丙). Checks count ≥ 11.

**Contract:** tool count unchanged (9); gold-chart output byte-identical;
`ziwei_chart` gained only additive `meta.rawInput`. No vendor/engine changes.

## Phase 2 notes (delivered 2026-11-01)

Tool logic moved to `tools.ts` with `dispatch()` as the transport-agnostic handler;
both transports are thin shells around it. If state ever enters the design (saved
charts), it must be opt-in per call — the stateless contract is what makes the
server auditable.

### Phase 2b — SSE stream mode (2026-11-01)

`GET /mcp` now speaks SSE (see Transport modes above). Session model: one random
UUID per open stream, held only in an in-memory Map so `DELETE` can address it —
nothing else is stored, the daemon stays stateless across requests. Spec
compromises, deliberate:
- POST responses stay on the POST connection (JSON mode) even when a session id
  is attached — no dual-path response routing, zero regression risk for existing
  clients.
- No `initialize`-issued session lifecycle (no per-session state, expiry, or
  isolation) — ids live only as long as their stream.
- The stream carries comments (keep-alive) but no JSON-RPC frames, because no
  tool has anything to push.

## License

MIT — see [LICENSE](LICENSE). Copyright (c) 2026 PeterYuen.

Third-party attribution: this service **wraps but does not redistribute** the
Ziwei Doushu engine from [github.com/Renhuai123/ziwei-doushu](https://github.com/Renhuai123/ziwei-doushu)
(engine source MIT, dataset CC BY 4.0). No engine source or dataset content is
copied into this repository — users must vendor their own pinned copy
(`495b79e`) per the Install section. See [NOTICE](NOTICE).
