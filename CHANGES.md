# Changelog — ziwei-mcp

All notable changes to this service are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); dates and
versions newest first. Version numbers apply to both transports (stdio and
Streamable HTTP) unless noted.

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
