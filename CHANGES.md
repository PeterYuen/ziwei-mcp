# Changelog — ziwei-mcp

All notable changes to this service are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); dates and
versions newest first. Version numbers apply to both transports (stdio and
Streamable HTTP) unless noted.

## 2026-11-12 — unreleased (CI + full test coverage + repo hygiene)

### Context — PR #7 closed without merge
`feat/hardening-v0.4.0` (PR #7: per-token rate limiting, batch concurrency
cap, HTTPS-via-tailscale docs, version bump to 0.4.0) was verified green in
CI but is **closed without merging** — the v0.4.0 hardening is deferred, so
this branch stays on **version 0.3.1** and takes only two pieces from it:
the CI workflow (as it ran green in run 43050795148) and the `server-only`
stub fix (commit `1bbe77f`). No rate limiter, no concurrency cap, no version
bump, no HTTPS docs.

### Added
- **CI** — `.github/workflows/ci.yml`: on every push/PR, checks out this
  repo at `services/ziwei-mcp`, checks out the vendored engine pinned to
  `906bd93` (fetched by SHA — the pin is not a branch tip), installs engine
  deps, recreates the `server-only` no-op stub, then runs the stdio suite
  (`run-tests.sh`) and the HTTP suite (`http-tests.sh`) against a throwaway
  daemon on port 9879.
- **Full test coverage for all 10 tools** — three new sections in
  `run-tests.sh` close the last thin spots (see coverage table below):
  - **I — ziwei_patterns**: gold-birth general detectors (zero strict 卷一
    entries — documented anchor), both strict 《全书》定贵局 table fixtures
    (第11条 七杀朝斗, 第9条 坐贵向贵) with source/description format, 空宫
    借星 (`borrowedFrom` 迁移 太阳太阴), validation (missing args, bad
    leapMonth enum), leapMonth policy honored through the patterns path.
  - **J — ziwei_school_compare**: full 6-variant roster, zero-diff
    baselines, discriminating cases — late-zi birth separates lateZishi
    variants (incl. effectiveDate diff), 2023 leap-year birth separates
    prev-month/origin-month (命宮 + 五行局 shift, 木三局), non-leap birth
    collapses all leapMonth variants to zero, digest shape, validation.
  - **K — leapMonth parameter coverage across calendar-aware tools**:
    the full split/next-month/prev-month/origin-month/default policy table
    on the 2023-04-10 anchor (三月 天机天梁 水二局 vs 二月 天府 木三局),
    enum rejection, `ziwei_from_city` echoing `leapMonth` in `ignoredKeys`
    (schema has no leapMonth — chart must stay split-default), and
    `ziwei_solar_lunar` leap-flag round-trips both directions
    (闰二月十五 ↔ 2023-04-05, 闰二月初一 → 2023-03-22, non-leap 二月十五
    → 2023-03-06).
- **Repo hygiene files** — `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1),
  `CONTRIBUTING.md` (fork→branch→PR workflow; vendored-engine rule: pin
  906bd93 is part of the contract, iztro/lunar-javascript deps never
  touched; how to run tests + gold regression), `SECURITY.md` (private
  disclosure, stdlib-only / no npm publish, input-validation focus, no
  secrets in logs), and GitHub issue templates
  (`.github/ISSUE_TEMPLATE/{bug_report,feature_request}.yml`) — both
  templates force exact chart inputs: date, time, calendar type, leapMonth
  flag, expected vs actual.

### Fixed
- `tests/http-tests.sh` now honors `BASE` from the environment (default
  `http://127.0.0.1:9878` unchanged) so CI can point it at the throwaway
  daemon instead of the live service.

### Tool coverage table (post-PR; stdio sections A–K + HTTP suite)

| Tool | Real coverage | Sections |
|---|---|---|
| ziwei_chart | gold byte-identity, true-solar, no-longitude inertness, robustness, rawInput/ignoredKeys, leapMonth policy table | A, B, D, F, G, K |
| ziwei_patterns | detectors, strict 定贵局 fixtures, 空宫借星, validation, leapMonth | **I** (new), A |
| ziwei_sihua_layers | liunian/liuyue/liuri/liushi/daxian, lichun + straddle rules, yearWindow, four-path agreement table, bounds | C, E, F, G, K |
| ziwei_batch_stats | census correctness, hours:all, memory clamp, OOM surfacing | E, F, H |
| ziwei_compatibility | structure, mirror cross-check, jiFlags 夫妻, daXianCheck | E, F, G |
| ziwei_from_city | EN/zh city resolution, unknown-city suggestions, override, leapMonth ignoredKeys | E, K |
| ziwei_render | gold SVG byte-identity, 12 labels, liunian overlay | E, F |
| ziwei_school_compare | 6 variants × late-zi/leap-year/non-leap discrimination, digest shape | **J** (new), E |
| ziwei_selftest | built-in ≥13 gold anchors, deterministic | E, F, G |
| ziwei_solar_lunar | round-trips, leap flags both directions, 1900–2050 bounds | E, G, **K** (new) |

### Test results

`run-tests.sh` (A–K): 13/13 PASS locally 2026-11-12 — gold `ziwei_chart`
byte-identical to `tests/gold/chart-1986.json`, default render byte-identical
to `tests/gold/render-default-1986.svg` (sections B/F gates). HTTP suite
against a throwaway daemon: 38/38 PASS, 0 FAIL. Version strings unchanged
(0.3.1 in `tools/list` / `/health`).

## 2026-11-11 — v0.3.1

### Fixed
- **batch-stats worker count clamped to free memory** — `ziwei_batch_stats`
  spawned up to 12 parallel workers, each loading the engine + lunar tables.
  On memory-tight hosts (~1.4 GB free) the kernel oom-killer took the child
  down (exit 137) and the tool masked it as `timed out after 120 s (killed)`.
  `batch-stats-worker.mts` now computes a memory cap from `freemem()`
  (~512 MB per worker) and clamps the worker count to
  min(workers, availableParallelism, memCap), logging one stderr line when
  clamped (stdout stays pure JSON).
- **OOM surfaced as an explicit error** — the `ziwei_batch_stats` handler in
  `tools.ts` records free memory at spawn and reports exit 137 / SIGKILL as
  `batch-stats worker killed by SIGKILL (likely OOM — free memory at spawn
  ~N MB; …)` instead of a timeout; other non-zero exits now append the signal
  name when present.
- **Version bump** 0.3.0 → **0.3.1** (both transports; `tools/list` and
  `GET /health` unchanged otherwise).

### Test results

Suite `tests/run-tests.sh` (A–H) run 2026-11-11 on the production box
(`free -m` at run time: available ≈ 1388 MB — i.e. under the memory pressure
that used to trigger the OOM):

| Section | Result |
|---|---|
| A protocol | PASS |
| B reference chart (gold) | PASS |
| C layers | PASS |
| D robustness | PASS |
| E new tools | PASS |
| F bugfix+feature regression | PASS |
| G deep-fix regression | PASS |
| H batch-stats memory resilience | PASS |

H specifics: `ziwei_batch_stats` (wuxingJu-distribution, male, 1950,
hours=all) computed 4380 charts with `workers=2` (free-memory clamp active,
512 MB/worker divisor unchanged), sum(distribution)==chartsComputed, no
isError. Standalone probe of the same call: 4380 charts, workers=2, ≈55 s,
clean. Gold `ziwei_chart` output byte-identical to pre-change (section B).

## 2026-11-10 — v0.3.0

### Added
- **`ziwei_patterns` tool** — dedicated 格局 detection + 命宮 summary over the
  internally-generated natal chart, exposing the engine's `detectPatterns` /
  `getMingGongSummary`. `patterns[].strict` distinguishes the strict
  《紫微斗数全书》卷一 tables (定贵局 27 / 定富局 6 / 定贫贱局 8; original-book
  item numbers in `source`, 原书注文 as `description`) from the 41 general
  detectors (layered `required`/`bonus`/`breaking` conditions). `mingGong`
  carries main stars, nature, keywords, and `borrowedFrom` for empty palaces
  (空宫借星). `ziwei_chart`'s output shape is unchanged — existing consumers
  see no shape change (gold-chart output verified byte-identical).
- **`leapMonth` parameter** on `ziwei_chart` and `ziwei_patterns`: optional
  闰月 policy `split` (default) | `next-month` | `prev-month` | `origin-month`,
  threaded to the engine; omitted, the engine default keeps output byte-exact
  to previous releases.
- **Selftest pattern anchors** (checks 14–17, total 17): gold-chart detected-
  pattern list, a 四化-bonus negative control, and two strict 卷一 table
  fixtures (1978-07-01 11:00 male → 七杀朝斗 定贵局第11条 + 杀破狼 化禄/化权
  bonus; 1990-05-20 08:00 female → 坐贵向贵 定贵局第9条). The gold anchor
  itself fires zero strict entries.

### Changed
- Version unified: stdio `0.1.0` + HTTP `0.2.0` → **`0.3.0`** (both transports
  now carry the same version string; `tools/list` returns 10 tools).
- Engine pin `495b79e` → **`906bd93`** (engine @ upstream `21114e3` + our
  true-solar longitude fix), which adds the strict 卷一 tables and the fixed
  四化 bonus logic (`palaceHasSiHua` / `sanFangHasSiHua`). No vendor changes
  in this release — the pin update records the engine state being consumed.
- `ziwei_selftest` check count 13 → 17.

### Fixed
- Invalid `leapMonth` values surface as a clean `ToolError` naming the
  accepted values (the engine throws `RangeError` — upstream #71 — this
  wrapper no longer lets it escape as an internal error).

## 2026-11-05 — v0.2.0

### Added
- **Open-source release** (public repository): 9 tools — `ziwei_chart`,
  `ziwei_sihua_layers`, `ziwei_from_city`, `ziwei_solar_lunar`,
  `ziwei_selftest`, `ziwei_compatibility`, `ziwei_batch_stats`,
  `ziwei_school_compare`, `ziwei_render` — over both transports
  (newline-delimited JSON-RPC stdio; Streamable HTTP daemon with JSON POST +
  SSE stream mode, bearer-token auth).
- Deterministic regression suite: `ziwei_selftest` (13 checks), in-repo gold
  anchors built on a **synthetic** anchor birth, stdio suites A–G and HTTP
  assertions.
- Traditional-Chinese README (2026-11-05) and Simplified-Chinese README with
  cross-links (locale file naming corrected the same day).
- Engine dependency vendored separately per the README Install section; not
  redistributed with this repository.

### Fixed
- `ziwei_batch_stats` worker spawn: use `node` + the tsx CLI entry instead of
  the POSIX-only `.bin/tsx` shim (win32 `ENOENT`); tsx ESM hooks registered
  inside the worker with dynamic-import CJS interop.

### Changed
- PII sanitisation: the gold/anchor births shipped in the repository are
  synthetic, non-person dates; no internal hostnames or paths in the public
  surface.

## 2026-11-01 — v0.1.0 (private)

### Added
- Initial service: Phase 1 stdio transport (newline-delimited JSON-RPC 2.0,
  stdlib only) and Phase 2 Streamable HTTP daemon, delivered 2026-11-01 per
  this repository's own README phase notes. Private until the 2026-11-05
  open-source release above.
