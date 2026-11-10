#!/usr/bin/env tsx
/**
 * ziwei-mcp — MCP stdio server (Phase 1 entrypoint).
 *
 * Transport: newline-delimited JSON-RPC 2.0 over stdin/stdout.
 * Tool logic + dispatcher live in ./tools.ts (shared with http.ts) —
 * this file is ONLY stdin/stdout plumbing, so the Phase-1 behaviour is
 * preserved byte-for-byte while Phase 2 reuses the same implementation.
 *
 * Engine (READ-ONLY, pinned 906bd93 (engine @ upstream 21114e3 + true-solar
 * longitude fix)): ../../vendor/ziwei-doushu/lib/ziwei/
 *
 * Transport notes:
 *  - stdout is protocol-only (one JSON object per line). All logging -> stderr.
 *  - No npm installs: Node stdlib only (readline/process).
 */
import { createInterface } from 'readline';
import { dispatch, listTools, type RpcMessage } from './tools';

function log(...parts: unknown[]): void {
  process.stderr.write(`[ziwei-mcp] ${parts.join(' ')}\n`);
}

function send(msg: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function sendError(id: number | string | null, code: number, message: string, data?: unknown): void {
  send({ jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data !== undefined ? { data } : {}) } });
}

const rl = createInterface({ input: process.stdin, terminal: false });
// DEEP FIX 2026-11-05: dispatch is now async (batch_stats spawns its compute
// child instead of blocking). Responses are serialized through a promise
// chain so stdout keeps deterministic request order, and exit-on-close waits
// for in-flight requests (the old code could exit mid-batch).
let chain: Promise<void> = Promise.resolve();
let pending = 0;
let closing = false;
function maybeExit(): void {
  if (closing && pending === 0) process.exit(0);
}
function handle(msg: RpcMessage): void {
  pending += 1;
  chain = chain.then(async () => {
    try {
      for (const resp of await dispatch(msg)) send(resp);
    } catch (e: any) {
      // Never crash on a bad request — protocol survives.
      sendError(typeof msg?.id === 'number' || typeof msg?.id === 'string' ? msg.id : null, -32603, `internal error: ${e?.message ?? e}`);
    } finally {
      pending -= 1;
      maybeExit();
    }
  });
}
rl.on('line', (line: string) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg: RpcMessage | RpcMessage[];
  try {
    msg = JSON.parse(trimmed);
  } catch {
    sendError(null, -32700, 'parse error: invalid JSON');
    return;
  }
  // JSON-RPC batch: not commonly used by MCP clients; answer each element.
  if (Array.isArray(msg)) {
    for (const one of msg as RpcMessage[]) handle(one);
    return;
  }
  handle(msg);
});
rl.on('close', () => { closing = true; maybeExit(); });
log(`ready (stdio, ${listTools().length} tools)`);
