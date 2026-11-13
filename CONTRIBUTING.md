# Contributing to ziwei-mcp

Thanks for your interest! This document explains how to propose changes and
the two rules that make this repo different from a typical TypeScript service.

## The one-sentence version

Fork → branch off `main` → commit → PR. Direct pushes to `main` are blocked
by a branch-protection ruleset, so every change arrives as a pull request.

## Workflow

1. **Fork** the repository and clone your fork.
2. **Branch** off `main` with a descriptive name (`feat/…`, `fix/…`, `docs/…`).
3. **Commit** with clear, imperative-subject messages. Keep unrelated changes
   out of the same PR.
4. **Run the tests** (see below) and make sure everything — especially the
   gold regression — passes locally before opening the PR.
5. **Open a PR** against `main`. CI runs both suites on every push/PR; the
   branch must be green to merge.

## The vendored engine rule (non-negotiable)

All chart math comes from the vendored engine, `Renhuai123/ziwei-doushu`,
checked out as `vendor/ziwei-doushu` **at the pinned commit** (currently
`906bd93`; see README Install and `.github/workflows/ci.yml`). Two rules
follow from that:

* **The pin is part of the contract.** The pinned commit is not a branch tip
  (it carries a fork-side fix between upstream commits), so CI checks it out
  by SHA. If you change the pin, update the SHA in `ci.yml` **and** the pin
  notes in `README.md` / `CONNECTING.md` in the same PR, and re-record the
  gold fixtures only if the change is intentional.
* **Engine dependencies are frozen.** The engine's own dependencies
  (`iztro`, `lunar-javascript`) must never be touched by PRs to this repo —
  not bumped, not patched, not swapped. They are part of the vendored
  engine's behavior surface; a dependency change silently changes every
  chart. If a dependency really must move, it belongs in the engine repo
  first, then a new pin here.

The service code itself (`tools.ts`, `index.ts`, `http.ts`, `tests/`) is
plain TypeScript run with `tsx` — no build step, no published npm package,
stdlib + vendored imports only.

## Running the tests

From the workspace root (the repo is expected to live at
`services/ziwei-mcp` next to `vendor/ziwei-doushu`; see README Install):

```bash
bash services/ziwei-mcp/tests/run-tests.sh    # stdio suites A–K
```

Sections A–K cover protocol, robustness, every one of the ten tools,
bug-fix/feature regressions, memory resilience, patterns coverage,
school-compare coverage, and leapMonth policy coverage. The gold regression
(sections B and F) is the most important gate: the reference chart for the
anchor birth (1986-12-08 23:45 male, lon 114.2) must stay **byte-identical**
to `tests/gold/chart-1986.json`, and the default render to
`tests/gold/render-default-1986.svg`. If gold moves, you changed the engine
or the pin — not just the plumbing.

If you changed HTTP transport code, also run the HTTP suite against a
throwaway daemon:

```bash
ZIWEI_MCP_PORT=9879 ZIWEI_MCP_HOST=127.0.0.1 \
  vendor/ziwei-doushu/node_modules/.bin/tsx services/ziwei-mcp/http.ts &
BASE=http://127.0.0.1:9879 bash services/ziwei-mcp/tests/http-tests.sh
```

## Adding or changing a tool

* Register it in `tools.ts` with a JSON schema (`additionalProperties: false`)
  and full validation via the existing `assert*` helpers — every input error
  must surface as a tool-level `isError` with a helpful message, never a
  stack trace.
* Add it to the `EXPECTED` list in section A of `tests/run-tests.sh` and give
  it real coverage in the suite (a happy path plus the interesting edges).
* Document it in all three READMEs and `CONNECTING.md`, and add a CHANGES.md
  entry.

## Code style

Match the surrounding code. Comments explain *why* (especially calendar
edge cases — leap months and lichun boundaries have burned us); the code
explains *what*. Stdout stays pure JSON on the stdio transport — diagnostics
go to stderr.
