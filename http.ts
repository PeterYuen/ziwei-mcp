#!/usr/bin/env tsx
/**
 * ziwei-mcp — MCP Streamable HTTP daemon (Phase 2 entrypoint).
 *
 * Lets REMOTE systems (not on this host) connect over the LAN via URL:
 *   POST /mcp   JSON-RPC 2.0 (single or batch), bearer-token protected
 *   GET  /health  liveness probe, NO auth (no chart data served)
 *
 * Transport mode: MCP Streamable HTTP with BOTH modes:
 *  - JSON response mode: every POST /mcp gets `application/json` (200 with the
 *    response array/object, or 202 for notification-only posts) — unchanged.
 *  - SSE stream mode: GET /mcp with `Accept: text/event-stream` opens a
 *    server-push stream carrying a session id (Mcp-Session-Id response header),
 *    kept alive by comment pings every KEEPALIVE_MS; DELETE /mcp with that
 *    header closes it. Tools are request/response-only, so the stream carries
 *    no JSON-RPC messages today — it exists for push-capable MCP clients.
 *
 * Security (network-exposed by design — remote testing is the point):
 *  - binds 0.0.0.0 (LAN-reachable); ALL /mcp requests require a bearer token
 *    (`Authorization: Bearer <t>` or `?token=<t>`), compared in constant time;
 *  - token lives in services/ziwei-mcp/.token (chmod 600) — never logged,
 *    never echoed in any response body.
 *
 * Tool logic + dispatcher shared verbatim with index.ts via ./tools.ts.
 * Stateless, zero LLM, stdlib only (node:http/node:crypto/node:fs).
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual, createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { dispatch, SERVER_NAME, type RpcMessage } from './tools';

const HTTP_VERSION = '0.3.1';
const HOST = process.env.ZIWEI_MCP_HOST || '0.0.0.0';
const PORT = Number(process.env.ZIWEI_MCP_PORT || process.env.PORT || 9878);
const MAX_BODY_BYTES = 1 * 1024 * 1024; // 1 MiB — charts are ~50 KB; guard against junk floods
const KEEPALIVE_MS = Number(process.env.ZIWEI_MCP_SSE_KEEPALIVE_MS || 20000); // spec guidance: 15–30 s
const MAX_STREAMS = Number(process.env.ZIWEI_MCP_SSE_MAX_STREAMS || 16);      // leak guard

const HERE = dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = process.env.ZIWEI_MCP_TOKEN_FILE || join(HERE, '.token');

function log(...parts: unknown[]): void {
  process.stderr.write(`[ziwei-mcp-http] ${parts.join(' ')}\n`);
}

// ── token ───────────────────────────────────────────────────────────────────
function loadToken(): Buffer {
  try {
    const raw = readFileSync(TOKEN_FILE, 'utf8').trim();
    if (!raw) throw new Error('empty');
    return Buffer.from(raw, 'utf8');
  } catch (e: any) {
    log(`FATAL: cannot read token file ${TOKEN_FILE} (${e?.message ?? e}); refusing to start unauthenticated`);
    process.exit(1);
  }
}
const TOKEN = loadToken();

function constantTimeEqual(a: Buffer, b: Buffer): boolean {
  // timingSafeEqual needs equal-length buffers; hashing both sides avoids
  // leaking the token length while keeping the comparison constant-time.
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

function extractToken(req: IncomingMessage, url: URL): string | null {
  const h = req.headers['authorization'];
  if (typeof h === 'string' && /^Bearer\s+/i.test(h)) return h.replace(/^Bearer\s+/i, '');
  const q = url.searchParams.get('token');
  if (typeof q === 'string' && q.length > 0) return q;
  return null;
}

function authorized(req: IncomingMessage, url: URL): boolean {
  const supplied = extractToken(req, url);
  if (supplied === null) return false;
  return constantTimeEqual(Buffer.from(supplied, 'utf8'), TOKEN);
}

// ── response helpers ────────────────────────────────────────────────────────
function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function errorJson(res: ServerResponse, status: number, code: number, message: string): void {
  json(res, status, { jsonrpc: '2.0', id: null, error: { code, message } });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ── CORS / OPTIONS ──────────────────────────────────────────────────────────
// No wildcard CORS needed (native MCP clients send same-origin or no Origin
// preflight); respond to OPTIONS with what a browser client would expect.
function corsHeaders(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version');
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
  res.setHeader('Access-Control-Max-Age', '86400');
}

// ── SSE streams (Streamable HTTP GET /mcp) ─────────────────────────────────
// Session model: one session id (random UUID) per open stream, tracked in a
// Map. The daemon stays otherwise stateless — ids exist only to let DELETE
// address a specific stream; POST responses are ALWAYS returned on the POST
// connection as JSON (spec-permitted), never routed onto the SSE stream.
interface SseStream {
  id: string;
  res: ServerResponse;
  closed: boolean;
}
const streams = new Map<string, SseStream>();
let keepAliveTimer: NodeJS.Timeout | null = null;

function sseWrite(s: SseStream, text: string): void {
  if (s.closed) return;
  try {
    s.res.write(text);
  } catch {
    closeStream(s, 'write failed');
  }
}

function closeStream(s: SseStream, why?: string): void {
  if (s.closed) return;
  s.closed = true;
  streams.delete(s.id);
  try { s.res.end(); } catch { /* already gone */ }
  if (streams.size === 0 && keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
  if (why) log(`SSE stream ${s.id} closed (${why})`);
}

function ensureKeepAlive(): void {
  if (keepAliveTimer) return;
  keepAliveTimer = setInterval(() => {
    // SSE comment frames — invisible to parsers, prove liveness to proxies.
    const frame = `: ping ${new Date().toISOString()}\n\n`;
    for (const s of Array.from(streams.values())) sseWrite(s, frame);
  }, KEEPALIVE_MS);
  keepAliveTimer.unref(); // never keep the process alive for pings alone
}

// ── request handling ────────────────────────────────────────────────────────
async function handlePostMcp(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  if (!authorized(req, url)) {
    log(`401 from ${req.socket.remoteAddress} (missing/wrong token)`);
    json(res, 401, { error: 'unauthorized', message: 'valid bearer token required (Authorization: Bearer <token> or ?token=)' });
    return;
  }

  let raw: string;
  try {
    raw = await readBody(req);
  } catch (e: any) {
    errorJson(res, 413, -32600, `request body rejected: ${e?.message ?? e}`);
    return;
  }

  let parsed: RpcMessage | RpcMessage[];
  try {
    parsed = JSON.parse(raw);
  } catch {
    errorJson(res, 400, -32700, 'parse error: invalid JSON');
    return;
  }

  const msgs = Array.isArray(parsed) ? parsed : [parsed];
  const responses: Record<string, unknown>[] = [];
  for (const m of msgs) {
    try {
      // DEEP FIX 2026-11-05: dispatch is async now (batch_stats spawns its
      // compute child instead of blocking the event loop for up to 120 s).
      responses.push(...await dispatch(m, { serverVersion: HTTP_VERSION }));
    } catch (e: any) {
      responses.push({ jsonrpc: '2.0', id: (m && typeof m.id === 'number' || m && typeof m.id === 'string') ? m.id : null, error: { code: -32603, message: `internal error: ${e?.message ?? e}` } });
    }
  }

  if (responses.length === 0) {
    res.writeHead(202, { 'Cache-Control': 'no-store' }); // notification-only
    res.end();
    return;
  }
  const body = responses.length === 1 ? responses[0] : responses;
  json(res, 200, body);
}

// GET /mcp — SSE stream mode. Requires auth + Accept: text/event-stream.
async function handleGetMcp(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  if (!authorized(req, url)) {
    log(`401 GET /mcp from ${req.socket.remoteAddress} (missing/wrong token)`);
    json(res, 401, { error: 'unauthorized', message: 'valid bearer token required (Authorization: Bearer <token> or ?token=)' });
    return;
  }
  const accept = typeof req.headers['accept'] === 'string' ? req.headers['accept'] : '';
  if (!/text\/event-stream/i.test(accept)) {
    // Spec: GET without the SSE Accept is not a valid stream request.
    res.setHeader('Allow', 'GET, POST, DELETE');
    json(res, 405, { error: 'send Accept: text/event-stream to open the SSE stream, or POST JSON-RPC to /mcp' });
    return;
  }
  if (streams.size >= MAX_STREAMS) {
    json(res, 503, { error: 'too many open SSE streams', limit: MAX_STREAMS });
    return;
  }
  const id = randomUUID();
  const stream: SseStream = { id, res, closed: false };
  streams.set(id, stream);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // disable proxy buffering (nginx)
    'Mcp-Session-Id': id,
  });
  res.flushHeaders();
  req.socket?.setKeepAlive(true, 30000);
  // Hello comment so clients/proxies see the stream is live immediately.
  sseWrite(stream, `: ziwei-mcp SSE stream open (keep-alive every ${Math.round(KEEPALIVE_MS / 1000)}s)\n\n`);
  req.on('close', () => closeStream(stream, 'client disconnect'));
  res.on('error', () => closeStream(stream, 'response error'));
  ensureKeepAlive();
  log(`SSE stream ${id} open from ${req.socket.remoteAddress} (${streams.size} active)`);
  // Intentionally NO res.end() — the stream stays open until the client
  // disconnects, DELETE arrives, or the daemon exits.
}

// DELETE /mcp with Mcp-Session-Id — close that stream cleanly.
function handleDeleteMcp(req: IncomingMessage, res: ServerResponse, url: URL): void {
  if (!authorized(req, url)) {
    log(`401 DELETE /mcp from ${req.socket.remoteAddress} (missing/wrong token)`);
    json(res, 401, { error: 'unauthorized', message: 'valid bearer token required' });
    return;
  }
  const sid = req.headers['mcp-session-id'];
  const s = typeof sid === 'string' ? streams.get(sid) : undefined;
  if (!s) {
    json(res, 404, { error: 'not found', hint: 'unknown or absent Mcp-Session-Id; nothing to close' });
    return;
  }
  closeStream(s, 'DELETE');
  json(res, 200, { closed: true });
}

const server = createServer(async (req, res) => {
  corsHeaders(res);
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname;

  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    // Session-id note (Streamable HTTP): POST bodies are dispatched exactly the
    // same whether or not an Mcp-Session-Id header is present — responses are
    // always returned on the POST connection as application/json (spec-permitted
    // JSON response mode). Ids are validated ONLY on DELETE, where they address
    // a stream. This keeps the headerless curl path byte-identical to Phase 2a.
    if (req.method === 'POST' && req.headers['mcp-session-id']) {
      const known = streams.has(String(req.headers['mcp-session-id']));
      log(`POST with Mcp-Session-Id (${known ? 'known' : 'unknown — accepted, response returned on POST connection'}); JSON mode unchanged`);
    }
    if (path === '/health' && req.method === 'GET') {
      json(res, 200, { status: 'ok', server: SERVER_NAME, version: HTTP_VERSION });
      return;
    }
    if (path === '/mcp') {
      if (req.method === 'POST') { await handlePostMcp(req, res, url); return; }
      if (req.method === 'GET') { await handleGetMcp(req, res, url); return; }
      if (req.method === 'DELETE') { handleDeleteMcp(req, res, url); return; }
      res.setHeader('Allow', 'GET, POST, DELETE');
      res.writeHead(405);
      res.end();
      return;
    }
    if (!authorized(req, url)) {
      json(res, 401, { error: 'unauthorized', message: 'valid bearer token required' });
      return;
    }
    json(res, 404, { error: 'not found', hint: 'endpoints: POST /mcp, GET /health' });
  } catch (e: any) {
    // Last-resort guard: one bad request must never take down the daemon.
    log(`handler error: ${e?.stack ?? e}`);
    if (!res.headersSent) json(res, 500, { error: 'internal error' });
    else res.end();
  }
});

function listenWithFallback(start: number, remaining = 10): void {
  let port = start;
  const onError = (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE' && remaining > 1) {
      remaining -= 1;
      port += 1;
      log(`port ${port - 1} busy, trying ${port}`);
      server.removeListener('error', onError);
      server.on('error', onError);
      server.listen(port, HOST);
    } else {
      log(`FATAL: ${err?.message ?? err}`);
      process.exit(1);
    }
  };
  server.on('error', onError);
  server.listen(port, HOST, () => {
    const addr = server.address();
    const bound = typeof addr === 'object' && addr ? addr.port : port;
    log(`listening on http://${HOST}:${bound}/mcp (token file: ${TOKEN_FILE})`);
  });
}
listenWithFallback(PORT);

// Graceful shutdown: close open SSE streams first (they would otherwise hold
// server.close() hostage until the OS kills us), then drain the server.
function shutdown(): void {
  for (const s of Array.from(streams.values())) closeStream(s, 'server shutdown');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref(); // safety net
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
