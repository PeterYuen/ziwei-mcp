/** ziwei-mcp — per-worker slice of ziwei_batch_stats (see batch-stats-worker.mts). */
import { parentPort, workerData } from 'node:worker_threads';
// Windows/cross-platform fix: register the tsx ESM hooks inside THIS worker
// thread before loading the engine. Static engine imports would be resolved
// before any hook registration (and --import in Worker execArgv does not
// reliably propagate tsx on win32), so register explicitly + dynamic import.
import { register } from '../../vendor/ziwei-doushu/node_modules/tsx/dist/esm/api/index.mjs';
register();
// CJS/ESM interop: when tsx compiles the engine as CJS (the engine package
// has no "type":"module"), named exports live on the namespace's default.
const algMod: any = await import('../../vendor/ziwei-doushu/lib/ziwei/algorithm');
const sihuaMod: any = await import('../../vendor/ziwei-doushu/lib/ziwei/sihua');
const { generateChart } = algMod.default ?? algMod;
const { getSiHuaByStem } = sihuaMod.default ?? sihuaMod;

const EPOCH = Date.UTC(1950, 0, 1);
const { items, gender } = workerData as { items: [number, number][]; gender: 'male' | 'female' };
const mingStar: Record<string, number> = {};
const ju: Record<string, number> = {};
const sihuaPalace: Record<string, Record<string, number>> = { 禄: {}, 权: {}, 科: {}, 忌: {} };
let n = 0;
for (const [off, hourBranch] of items) {
  const d = new Date(EPOCH + off * 86400000);
  let chart: any;
  try {
    chart = generateChart({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: hourBranch, gender } as any);
  } catch { continue; }
  n++;
  const ming = chart.palaces.find((p: any) => p.isMingGong);
  const majors: string[] = ming ? ming.stars.filter((s: any) => s.type === 'major').map((s: any) => s.name) : [];
  if (majors.length === 0) mingStar['(空宮)'] = (mingStar['(空宮)'] ?? 0) + 1;
  else for (const s of majors) mingStar[s] = (mingStar[s] ?? 0) + 1;
  ju[chart.wuxingJuName] = (ju[chart.wuxingJuName] ?? 0) + 1;
  const palaceOf: Record<string, string> = {};
  for (const p of chart.palaces) for (const s of p.stars) if (!(s.name in palaceOf)) palaceOf[s.name] = p.name;
  const th = getSiHuaByStem(chart.lunarInfo.yearStem ?? 0);
  for (const k of ['禄', '权', '科', '忌'] as const) {
    const star = th[k];
    const pal = star ? (palaceOf[star] ?? '(未見該星)') : '(無化' + k + ')';
    (sihuaPalace[k] as any)[pal] = ((sihuaPalace[k] as any)[pal] ?? 0) + 1;
  }
}
parentPort!.postMessage({ n, mingStar, ju, sihuaPalace });
