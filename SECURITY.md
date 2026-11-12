# Security Policy

## Supported versions

This service is not published to npm and has no long-lived release branches.
The `main` branch is the single supported line; security fixes land there via
PR and deploy with the running instance.

## Reporting a vulnerability (private disclosure)

Please **do not open a public issue** for anything that could be exploited
before it is fixed. Report security problems privately:

* Open a GitHub issue titled `security: <short summary>` with **no details**
  and send the details to the maintainer by any private channel you can find
  (or wait to be asked), **or**
* Email the maintainer (address on the GitHub profile) with the subject
  `ziwei-mcp security`.

We aim to acknowledge within 7 days and to ship a fix (or a documented
mitigation) before disclosing publicly.

## What we consider security-relevant

* **Input validation.** Every tool argument is validated before the engine
  sees it (integer ranges, enum policies, date existence). A malformed
  argument must produce a clean `isError`/JSON-RPC error — never an
  unhandled exception, never uncontrolled resource consumption.
* **HTTP transport.** The daemon is token-authenticated (constant-time
  compare, header or `?token=`). Missing/wrong tokens → 401, no chart data
  leaked. Body size is capped (1 MiB). The daemon binds plain HTTP and is
  expected to sit behind a trusted network or a TLS-terminating proxy —
  do not expose it to the public internet without one.
* **Batch jobs.** `ziwei_batch_stats` spawns worker threads; the worker
  count is clamped to free memory so a single call cannot OOM-kill the host.

## What is *not* a vulnerability

* Chart accuracy or 格局 judgment differences — this is a deterministic
  computation, not a security surface.
* DoS from a client that simply sends unlimited valid traffic on a trusted
  network (rate limiting is a deployment concern; stdio is single-client by
  construction).

## Secrets and logging

The HTTP bearer token lives only in `services/ziwei-mcp/.token` (gitignored,
chmod 600). **No secrets appear in logs**: stdout is pure JSON on the stdio
transport, and daemon logs carry request metadata only — never tokens, and
never more of a caller's birth data than the caller themselves supplied.
Never commit `.token`, API keys, or tokens copied into issue reports.
