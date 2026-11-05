/**
 * ziwei-mcp — ziwei_batch_stats compute driver (subprocess).
 *
 * Spawned by tools.ts via execFileSync(vendor node + tsx loader, [this file, JSON args]).
 * Parallelises the deterministic day×hour enumeration across worker_threads
 * (node:worker_threads, stdlib only). No randomness, no LLM, no state.
 * Aggregation happens here; per-slice chart math lives in batch-stats-job.mts.
 *
 * args JSON: { y1, y2, gender, hours, startDayOffset, dayCount, stride }
 *   Enumerates dayCount days × hours.length hour-branches as a flattened
 *   slot space, stepping by `stride`; one chart per slot. Prints one JSON
 *   object to stdout.
 */
import { Worker } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';

const args = JSON.parse(process.argv[2] ?? '{}');
const { y1, y2, gender, hours, startDayOffset, dayCount, stride } = args;

const nw = Math.max(1, Math.min(args.workers ?? 12, availableParallelism ? availableParallelism() : 8));
const t0 = Date.now();
const slots = dayCount * hours.length;
const chunks: number[][][] = Array.from({ length: nw }, () => []);
let k = 0;
for (let s = 0; s < slots; s += stride) {
  chunks[k++ % nw].push([startDayOffset + Math.floor(s / hours.length), hours[s % hours.length]]);
}

const jobFile = fileURLToPath(new URL('./batch-stats-job.mts', import.meta.url));
const results = await Promise.all(chunks.map(chunk => new Promise<any>((resolve, reject) => {
  const w = new Worker(jobFile, { workerData: { items: chunk, gender } });
  w.on('message', resolve);
  w.on('error', reject);
  w.on('exit', code => { if (code !== 0) reject(new Error(`worker exit ${code}`)); });
})));

const total = results.reduce((a: number, r: any) => a + r.n, 0);
const mingStar: Record<string, number> = {};
const ju: Record<string, number> = {};
const sihuaPalace: Record<string, Record<string, number>> = { 禄: {}, 权: {}, 科: {}, 忌: {} };
const merge = (dst: Record<string, number>, src: Record<string, number>) => {
  for (const [k2, v] of Object.entries(src)) dst[k2] = (dst[k2] ?? 0) + (v as number);
};
for (const r of results) {
  for (const key of ['禄', '权', '科', '忌'] as const) merge(sihuaPalace[key], r.sihuaPalace[key]);
  merge(mingStar, r.mingStar);
  merge(ju, r.ju);
}

process.stdout.write(JSON.stringify({
  ok: true,
  computedCharts: total,
  requestedRange: [y1, y2],
  ms: Date.now() - t0,
  workers: nw,
  mingStar, ju, sihuaPalace,
}));
