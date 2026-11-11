/**
 * ziwei-mcp — shared tool implementations + transport-agnostic dispatcher.
 *
 * This module is imported by BOTH entrypoints:
 *   - index.ts  (Phase 1, MCP stdio, newline-delimited JSON-RPC)
 *   - http.ts   (Phase 2, MCP Streamable HTTP daemon)
 *
 * Engine (READ-ONLY, pinned 906bd93 (engine @ upstream 21114e3 + true-solar
 * longitude fix)): ../../vendor/ziwei-doushu/lib/ziwei/
 * True-solar-time correction replicates scripts/ziwei-chart.ts exactly:
 * the vendored generateChart ignores birthInfo.longitude, so the correction
 * (longitude + equation of time -> 时辰 branch + day offset) is applied here
 * before calling the engine.
 *
 * Stateless: birth data supplied per call, nothing stored. Zero LLM.
 * stdlib + vendored engine only — no npm installs.
 */
import { generateChart } from '../../vendor/ziwei-doushu/lib/ziwei/algorithm';
import type { BirthInfo, ZiweiChart, SiHua } from '../../vendor/ziwei-doushu/lib/ziwei/types';
import { detectPatterns, getMingGongSummary } from '../../vendor/ziwei-doushu/lib/ziwei/patterns';
import {
  calculateTrueSolarTime,
  resolveZiweiDayOffset,
  formatTrueSolarClock,
} from '../../vendor/ziwei-doushu/lib/ziwei/true-solar-time';
import type { TrueSolarTimeResult } from '../../vendor/ziwei-doushu/lib/ziwei/true-solar-time';
import {
  getDaXianSiHua,
  getLiuNianSiHua,
  getLiuYueSiHua,
  getLiuYueStemIndex,
  getYearStemIndex,
  getYearBranchIndex,
} from '../../vendor/ziwei-doushu/lib/ziwei/sihua';
import { getDaXianIndexForYear, CHILDHOOD_DAXIAN_INDEX, isChildhoodYear } from '../../vendor/ziwei-doushu/lib/ziwei/yunxian-context';
import { STEMS, BRANCHES } from '../../vendor/ziwei-doushu/lib/ziwei/constants';
import { Solar, Lunar } from '../../vendor/ziwei-doushu/node_modules/lunar-javascript';
import { PROVINCES } from '../../vendor/ziwei-doushu/lib/ziwei/cities';
import {
  lunarToSolar,
  isValidLunarDate,
  leapMonthOfLunarYear,
  LUNAR_YEAR_MIN,
  LUNAR_YEAR_MAX,
} from '../../vendor/ziwei-doushu/lib/ziwei/lunar-solar';
import {
  getLiuRiSiHua,
  getLiuShiSiHua,
  getSiHuaByStem,
} from '../../vendor/ziwei-doushu/lib/ziwei/sihua';
import {
  STAR_IN_FUQI_GU,
  SIHUA_IN_FUQI_GU,
  MARRIAGE_STARS_BRIEF,
  HEMING_SCORE_CRITERIA,
} from '../../vendor/ziwei-doushu/lib/ziwei/heming-knowledge';
import type { LunarMonthPolicy } from '../../vendor/ziwei-doushu/lib/ziwei/algorithm';
import { spawn } from 'node:child_process';
import { freemem } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname as dirnameOf, join as joinPath } from 'node:path';

export const SERVER_NAME = 'ziwei-mcp';
// Stdio reports 0.1.0 (the Phase-1 test suite asserts it); the HTTP daemon
// overrides to 0.2.0 via dispatch()'s serverVersion option.
export const SERVER_VERSION = '0.3.1';
export const DEFAULT_PROTOCOL = '2025-06-18';

// ────────────────────────────────────────────────────────────────────────────
// Shared helpers
// ────────────────────────────────────────────────────────────────────────────

export class ToolError extends Error {}

function assertInt(v: unknown, name: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    throw new ToolError(`${name} must be an integer in [${min}, ${max}]; received ${JSON.stringify(v)}`);
  }
  return v;
}

function assertGender(v: unknown, name = 'gender'): 'male' | 'female' {
  if (v !== 'male' && v !== 'female') {
    throw new ToolError(`${name} must be "male" or "female"; received ${JSON.stringify(v)}`);
  }
  return v;
}

function assertDateExists(year: number, month: number, day: number): void {
  // Date.UTC rolls 2/30 over silently, which would defeat the engine's
  // nonexistent-date rejection downstream. Validate the RAW date here.
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    throw new ToolError(`solar date does not exist: ${year}-${month}-${day} — confirm with the user, never shift silently`);
  }
}

interface ResolvedBirth {
  birth: BirthInfo;           // what we hand to generateChart (post day-shift)
  effectiveDate: string;      // YYYY-MM-DD used for the engine
  trueSolarTime: object | null;
  dayShiftFromLateZi: number;
  hourBranch: number;
  longitude: number | null;
}

/**
 * Replicates scripts/ziwei-chart.ts clock->branch/day-shift logic:
 *  - with longitude: true solar time (longitude + equation of time) decides
 *    the 时辰 branch and the day offset ('next-day' late-zi rule);
 *  - without longitude: raw clock; h===23 -> branch 0 + next day, else
 *    branch = floor((h+1)/2).
 */
function resolveBirth(args: {
  year: number; month: number; day: number; hour: number; minute: number;
  gender: 'male' | 'female'; longitude?: number;
  lateZishi?: 'next-day' | 'current-day';
}): ResolvedBirth {
  const { year, month, day, gender } = args;
  const lateZishiRule: 'next-day' | 'current-day' = args.lateZishi ?? 'next-day';
  const h = assertInt(args.hour, 'hour (clock)', 0, 23);
  const m = assertInt(args.minute, 'minute', 0, 59);
  assertDateExists(year, month, day);

  let longitude: number | undefined;
  if (args.longitude !== undefined) {
    if (typeof args.longitude !== 'number' || !Number.isFinite(longitude = args.longitude) || longitude < -180 || longitude > 180) {
      throw new ToolError(`longitude must be a finite number in [-180, 180]; received ${JSON.stringify(args.longitude)}`);
    }
  }

  let branch: number;
  let dayShift = 0;
  let solar: TrueSolarTimeResult | null = null;

  if (longitude !== undefined) {
    solar = calculateTrueSolarTime({ year, month, day, clockHour: h, clockMinute: m, longitude });
    if (!solar.dateValid) throw new ToolError(`date is not valid for true-solar-time calculation: ${year}-${month}-${day}`);
    branch = solar.branch;
    dayShift = resolveZiweiDayOffset(solar, lateZishiRule);
  } else {
    if (h === 23) { branch = 0; dayShift = lateZishiRule === 'next-day' ? 1 : 0; } // late-zi
    else branch = Math.floor((h + 1) / 2);
  }

  const d = new Date(Date.UTC(year, month - 1, day));
  d.setUTCDate(d.getUTCDate() + dayShift);

  const birth: BirthInfo = {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: branch,
    gender,
  };
  if (longitude !== undefined) birth.longitude = longitude;

  return {
    birth,
    effectiveDate: `${birth.year}-${String(birth.month).padStart(2, '0')}-${String(birth.day).padStart(2, '0')}`,
    trueSolarTime: solar ? {
      clock: formatTrueSolarClock(solar, true),
      branch: solar.branch,
      longitudeCorrectionMinutes: +solar.longitudeCorrectionMinutes.toFixed(1),
      equationOfTimeMinutes: +solar.equationOfTimeMinutes.toFixed(1),
      totalCorrectionMinutes: +solar.totalCorrectionMinutes.toFixed(1),
    } : null,
    dayShiftFromLateZi: dayShift,
    hourBranch: branch,
    longitude: longitude ?? null,
  };
}

const LEAP_MONTH_POLICIES: readonly string[] = ['split', 'next-month', 'prev-month', 'origin-month'];

/**
 * leapMonth (闰月) policy validation — mirrors the engine's own enum check
 * (algorithm.ts throws RangeError on invalid policy, upstream #71) so callers
 * get a clean ToolError naming the accepted values before any chart work.
 */
function assertLeapMonth(v: unknown): LunarMonthPolicy | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || !LEAP_MONTH_POLICIES.includes(v)) {
    throw new ToolError(
      `leapMonth must be one of "split" | "next-month" | "prev-month" | "origin-month"; received ${JSON.stringify(v)}`,
    );
  }
  return v as LunarMonthPolicy;
}

function buildChart(rb: ResolvedBirth, opts?: { leapMonth?: LunarMonthPolicy }): ZiweiChart {
  try {
    return generateChart(rb.birth, opts);
  } catch (e: any) {
    throw new ToolError(e?.message ?? String(e));
  }
}

/** star name -> palace name (first palace containing the star). */
function starPalaceMap(chart: ZiweiChart): Record<string, string> {
  const map: Record<string, string> = {};
  for (const p of chart.palaces) {
    for (const s of p.stars) {
      if (!(s.name in map)) map[s.name] = p.name;
    }
  }
  return map;
}

const SIHUA_KEYS: SiHua[] = ['禄', '权', '科', '忌'];

/**
 * Lichun-exact ganzhi year of a solar date, using the engine's own tables
 * (getEightChar().getYear() switches at the exact lichun instant, evaluated
 * at local noon — same hour-midpoint convention as algorithm.ts). This is
 * the ONLY correct source for the 五虎遁 year stem of a flow date: the
 * calendar year (getYearStemIndex) disagrees for dates BEFORE lichun,
 * because those belong to the previous ganzhi year's month sequence.
 */
function ganzhiYearOfSolarDate(y: number, m: number, d: number): {
  stemIndex: number; stemName: string; ganzhi: string;
} {
  const lu: any = (Solar.fromYmdHms(y, m, d, 12, 0, 0) as any).getLunar();
  const gz: string = lu.getEightChar().getYear();
  const stemIndex = STEMS.indexOf(gz[0]);
  if (stemIndex < 0) throw new ToolError(`could not resolve lichun ganzhi year for ${y}-${m}-${d}`);
  return { stemIndex, stemName: STEMS[stemIndex], ganzhi: gz };
}

/**
 * Representative Gregorian year for a bare ganzhi pair (used only for calendar
 * lookups like solar->lunar month conversion when no year is given): the
 * modern-cycle year in 1984..2043 matching the pair (1984 = 甲子).
 */
function ganzhiRepresentativeYear(stemIndex: number, branchIndex: number): number {
  for (let y = 1984; y <= 2043; y++) {
    if (getYearStemIndex(y) === stemIndex && getYearBranchIndex(y) === branchIndex) return y;
  }
  return 1984;
}

/** 流月 stem (五虎遁) for the lunar month containing a solar date, using the
 * lichun-exact ganzhi year of that SAME date — both sources from one date. */
function liuyueStemForSolarDate(y: number, m: number, day = 15): string {
  const { stemIndex } = ganzhiYearOfSolarDate(y, m, day);
  const rawMonth: number = (Solar.fromYmd(y, m, day) as any).getLunar().getMonth();
  return STEMS[getLiuYueStemIndex(stemIndex, Math.abs(rawMonth))];
}

/**
 * DEEP FIX 2026-11-05 (reviewer finding 2.2): resolve the SOLAR reference
 * date for a direct lunarMonth query. The old code fed the lunar month NUMBER
 * into Solar.fromYmd(refYear, lunarMonth, 15) — a lunar number used as a SOLAR
 * month, so lunarMonth:1 always resolved against solar Jan 15 (pre-lichun) and
 * the 五虎遁 year stem came from the wrong ganzhi year.
 *
 * RESOLUTION RULE (documented contract): the reference is the mid-month (15th,
 * same sampling convention as the month-only path) of lunar month N of lunar
 * year `calYear`, converted to its TRUE SOLAR date through the vendored
 * lunar-solar.ts tables (1900-2050). The lichun-exact ganzhi year of that
 * solar date then supplies the 五虎遁 year stem — one source, one date.
 *
 * ANCHOR NOTE: for m1-m11 the mid-month solar date falls inside calendar year
 * `calYear` itself. m12 is the documented edge: its mid-month lands in early
 * calYear+1 but BEFORE that year's lichun, so the stem still belongs to
 * calYear's ganzhi year (e.g. 2026 丙午 m12 → solar 2027-01-22 → still 丙午 →
 * stem 辛) — exactly what the previous suite asserted. Leap months only exist
 * in their own lunar year; isLeapMonth is validated against that year's leap.
 */
function resolveLunarMonthReference(
  calYear: number, lunarMonth: number, isLeap: boolean,
): { refYear: number; refMonth: number; refDay: number; lunarYear: number } {
  if (!isValidLunarDate(calYear, lunarMonth, 15, isLeap)) {
    const leap = leapMonthOfLunarYear(calYear);
    throw new ToolError(
      `cannot resolve lunar month ${isLeap ? '闰' : ''}${lunarMonth} of year ${calYear}: ` +
      `not a valid lunar date in the ${LUNAR_YEAR_MIN}-${LUNAR_YEAR_MAX} table range` +
      (isLeap ? ` (year ${calYear} leap month is ${leap || 'none'})` : '') +
      `; supported calendar years ${LUNAR_YEAR_MIN}-${LUNAR_YEAR_MAX}`,
    );
  }
  const ref = lunarToSolar(calYear, lunarMonth, 15, isLeap);
  if (!ref) {
    throw new ToolError(`lunar-to-solar resolution failed for ${calYear}-${lunarMonth}-15 (table range ${LUNAR_YEAR_MIN}-${LUNAR_YEAR_MAX})`);
  }
  return { refYear: ref.year, refMonth: ref.month, refDay: ref.day, lunarYear: calYear };
}

/**
 * Resolve the lunar month (incl. leap flag) backing a liuyue query.
 *
 * UNIFIED RULE (2026-11-05, reviewer round 3): month-only resolution ALWAYS
 * samples the 15th of the solar month — 'month-only resolves to the lunar
 * month containing the 15th' (mid-month rule). This applies to ALL straddle
 * types; the old leap-specific 'later segment' special case is removed so
 * both paths use one consistent tie-break.
 *
 * - With a flow date: resolve BY DAY (2026-11-04 leap-straddle fix) — the
 *   exact day decides whether the date sits in the leap month or the month
 *   that follows it. Unchanged.
 * - Month-only: if the solar month's FIRST day and LAST day map to different
 *   lunar months — leap or ordinary — flag `ambiguousMonth` + `note` (recommend
 *   flowDate) instead of returning an unflagged silent choice. Since a lunar
 *   month (~29.5 d) is shorter than every solar month, essentially every
 *   solar month crosses a boundary; the flag is honest, not exceptional.
 *   WHY mid-month and not 'later segment everywhere' (the reviewer's
 *   alternative): for January months the later segment (e.g. 2025-01-29/31)
 *   is already lunar m1 of the NEXT ganzhi year while the lichun-derived year
 *   stem is still the CURRENT year — pairing m1 with the pre-lichun stem
 *   re-introduces exactly the two-source bug class fixed twice (2026-11-04
 *   #1/#4). Mid-month sampling can never land in that gap window, and keeps
 *   both existing selftest January checks (#9 2025-01→丁, #10 2026-01→戊)
 *   passing unchanged. Observable consequence: 2023-04 month-only flips
 *   丙→乙 (2023-04-15 = 闰二月十五 → leap m2 base stem 乙).
 */
function resolveLiuyueMonth(
  year: number, solarMonth: number,
  fd: { year: number; month: number; day: number } | null,
): {
  lunarMonth: number; isLeapMonth: boolean; ambiguousMonth?: true; note?: string;
  monthSpan?: { lunarMonth: number; isLeap: boolean }[]; resolvedAs?: string;
} {
  if (fd) {
    const rawMonth: number = (Solar.fromYmd(fd.year, fd.month, fd.day) as any).getLunar().getMonth();
    return { lunarMonth: Math.abs(rawMonth), isLeapMonth: rawMonth < 0 };
  }
  const daysInMonth = new Date(Date.UTC(year, solarMonth, 0)).getUTCDate();
  const rawFirst: number = (Solar.fromYmd(year, solarMonth, 1) as any).getLunar().getMonth();
  const rawLast: number = (Solar.fromYmd(year, solarMonth, daysInMonth) as any).getLunar().getMonth();
  const rawMid: number = (Solar.fromYmd(year, solarMonth, 15) as any).getLunar().getMonth();
  const lunarLabel = (raw: number) => (raw < 0 ? '闰' + Math.abs(raw) : String(Math.abs(raw))) + '月';
  // DESCRIPTIVE SPAN FIELDS (2026-11-05 reviewer round 3 follow-up): a boolean
  // ambiguity flag is not a signal — lunar months (~29.5 d) are shorter than
  // every solar month, so ambiguousMonth is true on essentially every
  // month-only query and clients get a useless 100% warning rate. The
  // DECISION fields are now descriptive: monthSpan (the lunar months this
  // solar month covers, in order, deduplicated) + resolvedAs (the exact
  // resolution, naming the sampled date). ambiguousMonth stays for compat.
  const seen = new Set<number>();
  const monthSpan: { lunarMonth: number; isLeap: boolean }[] = [];
  for (const raw of [rawFirst, rawMid, rawLast]) {
    if (!seen.has(raw)) { seen.add(raw); monthSpan.push({ lunarMonth: Math.abs(raw), isLeap: raw < 0 }); }
  }
  const resolvedAs = (rawMid < 0 ? 'leap m' + Math.abs(rawMid) : 'm' + Math.abs(rawMid)) +
    ` (lunar month containing ${year}-${String(solarMonth).padStart(2, '0')}-15)`;
  if (rawFirst !== rawLast) {
    // Boundary straddle — leap OR ordinary, one unified rule: resolve to the
    // lunar month containing the 15th, flag it, recommend flowDate.
    const mm = String(solarMonth).padStart(2, '0');
    return {
      lunarMonth: Math.abs(rawMid),
      isLeapMonth: rawMid < 0,
      ambiguousMonth: true,
      monthSpan,
      resolvedAs,
      note: `solar ${year}-${mm} straddles a lunar month boundary: its first day ` +
        `falls in ${lunarLabel(rawFirst)} but its last day in ${lunarLabel(rawLast)}. ` +
        `Month-only resolution uses the MID-MONTH rule (the lunar month containing the ` +
        `15th), here ${lunarLabel(rawMid)}; the stem of that month is returned. ` +
        `See monthSpan/resolvedAs for the deterministic facts. ` +
        `ambiguousMonth is true for essentially all month-only queries (lunar months are ` +
        `shorter than solar months); use monthSpan/resolvedAs or supply flowDate.`,
    };
  }
  return { lunarMonth: Math.abs(rawMid), isLeapMonth: rawMid < 0, monthSpan, resolvedAs };
}

/** Validate a 干支 pair like '丙午': both chars known + valid 60-cycle parity. */
function parseGanzhiPair(raw: unknown): { stemIndex: number; branchIndex: number; ganzhi: string } {
  const s = String(raw ?? '').trim();
  if (s.length !== 2) throw new ToolError(`yearWindow must be a 2-character ganzhi pair like "丙午"; received ${JSON.stringify(raw)}`);
  const stemIndex = STEMS.indexOf(s[0]);
  const branchIndex = BRANCHES.indexOf(s[1]);
  if (stemIndex < 0) throw new ToolError(`unknown 天干 "${s[0]}" in yearWindow ${JSON.stringify(raw)} (甲乙丙丁戊己庚辛壬癸)`);
  if (branchIndex < 0) throw new ToolError(`unknown 地支 "${s[1]}" in yearWindow ${JSON.stringify(raw)} (子丑寅卯辰巳午未申酉戌亥)`);
  if ((stemIndex - branchIndex) % 2 !== 0) {
    throw new ToolError(`${s} is not a valid 60-cycle ganzhi pair (stem/branch parity mismatch — never occurs in a real year)`);
  }
  return { stemIndex, branchIndex, ganzhi: `${STEMS[stemIndex]}${BRANCHES[branchIndex]}` };
}

function decorateTransforms(
  transforms: Record<SiHua, string>,
  palaceOf: Record<string, string>,
): Record<string, { star: string; palace: string | null }> {
  const out: Record<string, { star: string; palace: string | null }> = {};
  for (const k of SIHUA_KEYS) {
    const star = transforms[k] ?? '';
    out[k] = { star, palace: star ? (palaceOf[star] ?? null) : null };
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// Tools
// ────────────────────────────────────────────────────────────────────────────

function toolZiweiChart(args: any): unknown {
  if (args === null || typeof args !== 'object') throw new ToolError('arguments must be an object');
  const year = assertInt(args.year, 'year', 1, 9999);
  const month = assertInt(args.month, 'month', 1, 12);
  const day = assertInt(args.day, 'day', 1, 31);
  const minute = args.minute === undefined ? 0 : assertInt(args.minute, 'minute', 0, 59);
  const gender = assertGender(args.gender);
  const hour = assertInt(args.hour, 'hour (clock)', 0, 23);
  if (args.longitude !== undefined && typeof args.longitude !== 'number') {
    throw new ToolError(`longitude must be a number; received ${JSON.stringify(args.longitude)}`);
  }
  if (args.latitude !== undefined && typeof args.latitude !== 'number') {
    throw new ToolError(`latitude must be a number; received ${JSON.stringify(args.latitude)}`);
  }
  const leapMonth = assertLeapMonth(args.leapMonth);

  const rb = resolveBirth({ year, month, day, hour, minute, gender, longitude: args.longitude });
  // latitude: accepted for schema completeness; the engine's correction is
  // longitude + equation of time only (see true-solar-time.ts), so it is inert.
  const chart = buildChart(rb, leapMonth ? { leapMonth } : undefined);

  return {
    meta: {
      input: { year, month, day, clockHour: hour, clockMinute: minute, gender },
      // 2026-11-04: raw caller arguments verbatim. chart.birthInfo reflects the
      // ENGINE-CORRECTED effective input (late-zi day shift, branch index); use
      // rawInput when echoing the original request values.
      rawInput: {
        year, month, day, hour, minute, gender,
        ...(args.longitude !== undefined ? { longitude: args.longitude } : {}),
        ...(args.latitude !== undefined ? { latitude: args.latitude } : {}),
        ...(args.leapMonth !== undefined ? { leapMonth } : {}),
      },
      effectiveDate: rb.effectiveDate,
      hourBranch: `${rb.hourBranch}(${BRANCHES[rb.hourBranch]})`,
      dayShiftFromLateZi: rb.dayShiftFromLateZi,
      longitude: rb.longitude,
      trueSolarTime: rb.trueSolarTime,
      fourPillars: chart.lunarInfo.fourPillars ?? null,
      fourPillarsLunar: chart.lunarInfo.fourPillarsLunar ?? null,
      ...(leapMonth !== undefined ? { leapMonth } : {}),
    },
    chart,
  };
}

// ── ziwei_patterns ──────────────────────────────────────────────────────────

/**
 * Strict 《全书》 entries are tagged by their detectQuanshuStrict source
 * string (《紫微斗数全书·卷一·<table>》第N条). The 41 general detectors in
 * patterns.ts carry other source strings (or none) — 卷一 is the discriminator.
 */
const STRICT_SOURCE_MARK = '·卷一·';

function toolZiweiPatterns(args: any): unknown {
  if (args === null || typeof args !== 'object') throw new ToolError('arguments must be an object');
  const year = assertInt(args.year, 'year', 1, 9999);
  const month = assertInt(args.month, 'month', 1, 12);
  const day = assertInt(args.day, 'day', 1, 31);
  const minute = args.minute === undefined ? 0 : assertInt(args.minute, 'minute', 0, 59);
  const gender = assertGender(args.gender);
  const hour = assertInt(args.hour, 'hour (clock)', 0, 23);
  if (args.longitude !== undefined && typeof args.longitude !== 'number') {
    throw new ToolError(`longitude must be a number; received ${JSON.stringify(args.longitude)}`);
  }
  if (args.latitude !== undefined && typeof args.latitude !== 'number') {
    throw new ToolError(`latitude must be a number; received ${JSON.stringify(args.latitude)}`);
  }
  const leapMonth = assertLeapMonth(args.leapMonth);

  const rb = resolveBirth({ year, month, day, hour, minute, gender, longitude: args.longitude });
  const chart = buildChart(rb, leapMonth ? { leapMonth } : undefined);

  const detected = detectPatterns(chart);
  const patterns = detected.map(p => ({
    name: p.name,
    level: p.level,
    description: p.description,
    palaces: p.palaces,
    // strict:true → judged by the 《全书》卷一 tables (定贵/定富/定贫贱),
    // description carries the 原书注文 + item number; false → general detector.
    strict: (p.source ?? '').includes(STRICT_SOURCE_MARK),
    ...(p.source !== undefined ? { source: p.source } : {}),
    ...(p.conditions !== undefined ? { conditions: p.conditions } : {}),
  }));

  const mingPalace = chart.palaces.find(p => p.branch === chart.mingGongBranch)!;
  const mainStars = mingPalace.stars.filter(s => s.type === 'major').map(s => s.name);
  const summary = getMingGongSummary(chart);
  const mingGong: Record<string, unknown> = {
    branch: BRANCHES[mingPalace.branch],
    mainStars,
    nature: summary.nature,
    keywords: summary.keywords,
  };
  if (mainStars.length === 0) {
    // 空宫借对宫主星 — report what the 命宫 borrows from the opposite palace.
    const opposite = chart.palaces.find(p => p.branch === (chart.mingGongBranch + 6) % 12);
    if (opposite) {
      mingGong.borrowedFrom = {
        palace: opposite.name,
        mainStars: opposite.stars.filter(s => s.type === 'major').map(s => s.name),
      };
    }
  }

  return {
    meta: {
      input: { year, month, day, clockHour: hour, clockMinute: minute, gender },
      rawInput: {
        year, month, day, hour, minute, gender,
        ...(args.longitude !== undefined ? { longitude: args.longitude } : {}),
        ...(args.latitude !== undefined ? { latitude: args.latitude } : {}),
        ...(args.leapMonth !== undefined ? { leapMonth } : {}),
      },
      effectiveDate: rb.effectiveDate,
      hourBranch: `${rb.hourBranch}(${BRANCHES[rb.hourBranch]})`,
      dayShiftFromLateZi: rb.dayShiftFromLateZi,
      longitude: rb.longitude,
      trueSolarTime: rb.trueSolarTime,
      leapMonth: leapMonth ?? 'split (engine default)',
    },
    mingGong,
    patterns,
    counts: {
      total: patterns.length,
      strict: patterns.filter(p => p.strict).length,
      loose: patterns.filter(p => !p.strict).length,
    },
    strictModeNote:
      'patterns[].strict=true marks entries judged by the four 《紫微斗数全书》卷一 tables '
      + '(定贵局/定富局/定贫贱局) with original-book item numbers in description/source; '
      + 'strict=false entries come from the general detectors in the engine (looser criteria).',
  };
}

function toolZiweiSihuaLayers(args: any): unknown {
  if (args === null || typeof args !== 'object') throw new ToolError('arguments must be an object');
  // 2026-11-04: optional yearWindow ('干支' pair, e.g. '丙午') replaces the
  // Gregorian year for liunian/liuyue/liuri/liushi — the year stem comes
  // straight from the pair, eliminating the lichun-boundary trap entirely.
  const gw = args.yearWindow !== undefined ? parseGanzhiPair(args.yearWindow) : null;
  const year = args.year !== undefined ? assertInt(args.year, 'year', 1, 9999) : null;
  if (year === null && !gw) throw new ToolError('either year (Gregorian integer) or yearWindow (ganzhi pair like "丙午") is required');
  // DEEP FIX 2026-11-05 (5b): passing BOTH split the sources — liunian came
  // from the pair while daxian ranges used `year`, silently mixing two
  // calendars. Reject explicitly; each path still works standalone.
  if (year !== null && gw) {
    throw new ToolError('provide either year or yearWindow, not both — year drives calendar lookups (daxian ranges), yearWindow pins the ganzhi stem/branch directly; combining them mixes two sources');
  }
  // Representative Gregorian year for calendar lookups (daxian ranges,
  // solar->lunar month conversion) when only yearWindow is given.
  const repYear = year !== null ? year : ganzhiRepresentativeYear(gw!.stemIndex, gw!.branchIndex);
  const gender = assertGender(args.gender);

  const birth = args.birth;
  if (birth === null || typeof birth !== 'object') throw new ToolError('birth must be an object {year,month,day,hour,minute,longitude?}');
  const bYear = assertInt(birth.year, 'birth.year', 1, 9999);
  const bMonth = assertInt(birth.month, 'birth.month', 1, 12);
  const bDay = assertInt(birth.day, 'birth.day', 1, 31);
  const bHour = assertInt(birth.hour, 'birth.hour (clock)', 0, 23);
  const bMinute = birth.minute === undefined ? 0 : assertInt(birth.minute, 'birth.minute', 0, 59);
  if (birth.longitude !== undefined && typeof birth.longitude !== 'number') {
    throw new ToolError(`birth.longitude must be a number; received ${JSON.stringify(birth.longitude)}`);
  }

  const layersReq = args.layers;
  if (!Array.isArray(layersReq) || layersReq.length === 0) {
    throw new ToolError('layers must be a non-empty array of "daxian" | "liunian" | "liuyue" | "liuri" | "liushi"');
  }
  for (const l of layersReq) {
    if (!['daxian', 'liunian', 'liuyue', 'liuri', 'liushi'].includes(l)) {
      throw new ToolError(`unknown layer "${l}"; allowed: daxian | liunian | liuyue | liuri | liushi`);
    }
  }
  if (layersReq.includes('liuyue') && args.month === undefined && args.lunarMonth === undefined
      && args.flowDate === undefined) {
    throw new ToolError('liuyue layer needs "month" (solar month, converted internally), "lunarMonth" (direct lunar month 1-12), or "flowDate" (solar date, resolved by day)');
  }
  if ((layersReq.includes('liuri') || layersReq.includes('liushi')) && args.flowDate === undefined) {
    throw new ToolError('liuri/liushi layers need flowDate {year,month,day} (solar date of the flow day)');
  }
  if (layersReq.includes('liushi') && args.flowHour === undefined) {
    throw new ToolError('liushi layer needs flowHour (clock hour 0-23 of the queried moment)');
  }
  let fd: { year: number; month: number; day: number } | null = null;
  if (args.flowDate !== undefined) {
    if (args.flowDate === null || typeof args.flowDate !== 'object') throw new ToolError('flowDate must be {year,month,day}');
    fd = {
      year: assertInt(args.flowDate.year, 'flowDate.year', 1, 9999),
      month: assertInt(args.flowDate.month, 'flowDate.month', 1, 12),
      day: assertInt(args.flowDate.day, 'flowDate.day', 1, 31),
    };
    assertDateExists(fd.year, fd.month, fd.day);
  }

  const rb = resolveBirth({
    year: bYear, month: bMonth, day: bDay, hour: bHour, minute: bMinute,
    gender, longitude: birth.longitude,
  });
  const chart = buildChart(rb);
  const palaceOf = starPalaceMap(chart);

  const out: Record<string, unknown> = {};

  if (layersReq.includes('daxian')) {
    let dxIndex = getDaXianIndexForYear(chart, repYear);
    let childhood = false;
    if (dxIndex < 0 && isChildhoodYear(chart, repYear)) { dxIndex = CHILDHOOD_DAXIAN_INDEX; childhood = true; }
    if (dxIndex < 0) throw new ToolError(`year ${repYear} falls outside all da xian ranges for this birth`);
    const r = getDaXianSiHua(chart, dxIndex, repYear);
    if (!r) throw new ToolError(`could not resolve da xian palace for index ${dxIndex}`);
    out.daxian = {
      stem: r.stemName,
      transforms: decorateTransforms(r.transforms, palaceOf),
      currentLayerIndex: childhood ? CHILDHOOD_DAXIAN_INDEX : dxIndex,
      childhood: childhood || undefined,
      ageRange: childhood ? null : [chart.daXians[dxIndex].startAge, chart.daXians[dxIndex].endAge],
      palace: childhood ? null : chart.daXians[dxIndex].palaceName,
      ageRanges: chart.daXians.map((dx, i) => ({ idx: i, ageRange: [dx.startAge, dx.endAge], palace: dx.palaceName })),
      xuSui: repYear - chart.lunarInfo.lunarYear + 1,
    };
  }

  if (layersReq.includes('liunian')) {
    const stemIndex = gw ? gw.stemIndex : getYearStemIndex(repYear);
    const branchIndex = gw ? gw.branchIndex : getYearBranchIndex(repYear);
    out.liunian = {
      stem: STEMS[stemIndex],
      yearStemUsed: STEMS[stemIndex],
      ganzhiYear: `${STEMS[stemIndex]}${BRANCHES[branchIndex]}`,
      transforms: decorateTransforms(getSiHuaByStem(stemIndex), palaceOf),
    };
  }

  if (layersReq.includes('liuyue')) {
    let lunarMonth: number;
    let isLeapMonth = false;
    let solarMonth: number | null = null;
    let yearStemIndex: number;
    let ganzhiYear: string;
    let ambiguousMonth: true | undefined;
    let note: string | undefined;
    let monthSpan: { lunarMonth: number; isLeap: boolean }[] | undefined;
    let resolvedAs: string | undefined;
    // UNIFIED RULE (2026-11-05): flowDate resolves the liuyue lunar month BY
    // DAY (2026-11-04 fix, unchanged); a bare `month` query resolves to the
    // lunar month containing the 15th of the solar month, and ANY boundary
    // straddle — leap or ordinary — is flagged ambiguousMonth + note. Direct
    // lunarMonth access still takes precedence.
    const fdLY = args.lunarMonth !== undefined ? null : fd;
    if (gw) {
      // FEATURE A: ganzhi mode — stem straight from the pair, no lichun lookup.
      yearStemIndex = gw.stemIndex;
      ganzhiYear = gw.ganzhi;
      if (args.lunarMonth !== undefined) {
        lunarMonth = assertInt(args.lunarMonth, 'lunarMonth', 1, 12);
        if (args.isLeapMonth !== undefined && typeof args.isLeapMonth !== 'boolean') {
          throw new ToolError(`isLeapMonth must be a boolean; received ${JSON.stringify(args.isLeapMonth)}`);
        }
        isLeapMonth = args.isLeapMonth === true;
        if (isLeapMonth) {
          const leap = leapMonthOfLunarYear(repYear);
          if (leap === 0) throw new ToolError(`lunar year ${repYear} has no leap month — isLeapMonth:true is invalid here (drop it or pick the correct year)`);
          if (leap !== lunarMonth) throw new ToolError(`lunar year ${repYear} leap month is ${leap}, not ${lunarMonth} — isLeapMonth:true with month ${lunarMonth} is invalid`);
        }
      } else if (fdLY) {
        // flowDate-only: resolve the lunar month by day (no solarMonth echo).
        const resolved = resolveLiuyueMonth(0, 0, fdLY);
        lunarMonth = resolved.lunarMonth;
        isLeapMonth = resolved.isLeapMonth;
      } else {
        solarMonth = assertInt(args.month, 'month (for liuyue)', 1, 12);
        const resolved = resolveLiuyueMonth(repYear, solarMonth, fdLY);
        lunarMonth = resolved.lunarMonth;
        isLeapMonth = resolved.isLeapMonth;
        ambiguousMonth = resolved.ambiguousMonth;
        note = resolved.note;
        monthSpan = resolved.monthSpan;
        resolvedAs = resolved.resolvedAs;
      }
    } else {
      // BUG #1 FIX (2026-11-04): the 五虎遁 year stem must come from the
      // lichun-exact ganzhi year OF THE FLOW DATE — never from the requested
      // calendar year while the month number comes from the lunar calendar
      // (two different sources; wrong for solar dates before lichun ~Feb 4).
      // Reference date: the flow date itself when given, else mid-month
      // (day 15) of the relevant solar month; for direct lunarMonth access
      // the reference is (year, lunarMonth, 15).
      let refYear: number;
      let refMonth: number;
      let refDay: number;
      if (args.lunarMonth !== undefined) {
        // Direct lunar-month access (caller already resolved the lunar calendar).
        // DEEP FIX 2026-11-05: the lichun-exact year stem must come from the
        // SOLAR date of this lunar month's mid-point (15th), resolved through
        // the vendored lunar tables — NOT from feeding the lunar month number
        // in as a solar month (the old two-source bug: lunarMonth:1 always
        // resolved against solar Jan 15 = pre-lichun, wrong ganzhi year).
        lunarMonth = assertInt(args.lunarMonth, 'lunarMonth', 1, 12);
        const isLeapReq = args.isLeapMonth === true;
        if (args.isLeapMonth !== undefined && typeof args.isLeapMonth !== 'boolean') {
          throw new ToolError(`isLeapMonth must be a boolean; received ${JSON.stringify(args.isLeapMonth)}`);
        }
        if (isLeapReq) {
          const leap = leapMonthOfLunarYear(repYear);
          if (leap === 0) {
            throw new ToolError(`lunar year ${repYear} has no leap month — isLeapMonth:true is invalid here (drop it or pick the correct year)`);
          }
          if (leap !== lunarMonth) {
            throw new ToolError(`lunar year ${repYear} leap month is ${leap}, not ${lunarMonth} — isLeapMonth:true with month ${lunarMonth} is invalid`);
          }
        }
        isLeapMonth = isLeapReq;
        const ref = resolveLunarMonthReference(repYear, lunarMonth, isLeapMonth);
        refYear = ref.refYear;
        refMonth = ref.refMonth;
        refDay = ref.refDay;
      } else if (fd) {
        // flowDate present (with or without month): the exact DAY decides the
        // lunar month — leap-month straddles resolve correctly. `month`, when
        // also given, is echoed as solarMonth but never overrides flowDate.
        if (args.month !== undefined) solarMonth = assertInt(args.month, 'month (for liuyue)', 1, 12);
        const resolved = resolveLiuyueMonth(fd.year, fd.month, fd);
        lunarMonth = resolved.lunarMonth;
        isLeapMonth = resolved.isLeapMonth;
        ambiguousMonth = resolved.ambiguousMonth;
        note = resolved.note;
        refYear = fd.year;
        refMonth = fd.month;
        refDay = fd.day;
      } else {
        // Convert the SOLAR month to the lunar month — mid-month (15th) rule;
        // boundary straddles of any kind are flagged for the caller.
        solarMonth = assertInt(args.month, 'month (for liuyue)', 1, 12);
        const resolved = resolveLiuyueMonth(repYear, solarMonth, null);
        lunarMonth = resolved.lunarMonth;
        isLeapMonth = resolved.isLeapMonth;
        ambiguousMonth = resolved.ambiguousMonth;
        note = resolved.note;
        monthSpan = resolved.monthSpan;
        resolvedAs = resolved.resolvedAs;
        refYear = repYear;
        refMonth = solarMonth;
        refDay = 15;
      }
      const gzy = ganzhiYearOfSolarDate(refYear, refMonth, refDay);
      yearStemIndex = gzy.stemIndex;
      ganzhiYear = gzy.ganzhi;
    }
    const r = getLiuYueSiHua(yearStemIndex, lunarMonth, { isLeapMonth });
    out.liuyue = {
      stem: r.stemName,
      yearStemUsed: STEMS[yearStemIndex],
      ganzhiYear,
      month: r.month,
      solarMonth,
      lunarMonth,
      isLeapMonth,
      ...(ambiguousMonth ? { ambiguousMonth } : {}),
      ...(monthSpan ? { monthSpan } : {}),
      ...(resolvedAs ? { resolvedAs } : {}),
      ...(note ? { note } : {}),
      transforms: decorateTransforms(r.transforms, palaceOf),
    };
  }

  if (layersReq.includes('liuri')) {
    if (!fd) throw new ToolError('internal: flowDate missing for liuri');
    out.liuri = {
      ...flowDayLayer(fd.year, fd.month, fd.day, palaceOf),
      precisionCaveat: LIURI_CAVEAT,
    };
  }

  if (layersReq.includes('liushi')) {
    if (!fd) throw new ToolError('internal: flowDate missing for liushi');
    out.liushi = {
      ...flowHourLayer(fd.year, fd.month, fd.day, args.flowHour, palaceOf),
      precisionCaveat: LIURI_CAVEAT,
    };
  }

  return {
    meta: {
      birth: { year: bYear, month: bMonth, day: bDay, hour: bHour, minute: bMinute, gender },
      effectiveDate: rb.effectiveDate,
      trueSolarTime: rb.trueSolarTime,
      mingGongBranch: BRANCHES[chart.mingGongBranch],
      wuxingJu: chart.wuxingJuName,
      layers: layersReq,
      requestedYear: repYear,
      yearWindow: gw ? gw.ganzhi : undefined,
    },
    layers: out,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// New tools (2026-11-03 batch): city / calendar / selftest / compatibility /
// batch stats / flow day-hour / school compare / SVG render
// ────────────────────────────────────────────────────────────────────────────

const LIURI_CAVEAT =
  '流日/流時四化 is informational only: below-month planning is unsupported by ' +
  'birth-time precision — the true-solar correction that sets the natal 时辰 has ' +
  'uncertainty of minutes, and day/hour-level triggers amplify that. Use for ' +
  'year/month-level timing; treat day/hour hits as hints, not decisions.';

// ── ziwei_from_city ─────────────────────────────────────────────────────────
// Common English/romanized names → the Chinese city entry in cities.ts.
// Keep this small: Chinese names resolve directly against PROVINCES.
const CITY_ALIASES: Record<string, string> = {
  'hong kong': '香港', 'hongkong': '香港', 'hk': '香港', 'xianggang': '香港',
  'kowloon': '九龙', 'new territories': '新界',
  'macau': '澳门', 'macao': '澳门', 'aomen': '澳门',
  'taiwan': '台北', 'tai pei': '台北', 'taipei': '台北',
  'taichung': '台中', 'kaohsiung': '高雄',
  'beijing': '北京', 'peking': '北京',
  'shanghai': '上海', 'tianjin': '天津', 'tientsin': '天津',
  'chongqing': '重庆', 'guangzhou': '广州', 'canton': '广州',
  'shenzhen': '深圳', 'chengdu': '成都', 'wuhan': '武汉',
  'xian': '西安', "xi'an": '西安', 'hangzhou': '杭州', 'nanjing': '南京',
  'changsha': '长沙', 'zhengzhou': '郑州', 'qingdao': '青岛',
  'dalian': '大连', 'xiamen': '厦门', 'amoy': '厦门', 'fuzhou': '福州',
  'kunming': '昆明', 'urumqi': '乌鲁木齐', 'lhasa': '拉萨',
};

interface CityMatch { name: string; province: string; longitude: number }

function allCities(): CityMatch[] {
  const out: CityMatch[] = [];
  for (const prov of PROVINCES) for (const c of prov.cities) {
    out.push({ name: c.name, province: prov.name, longitude: c.longitude });
  }
  return out;
}

/** Case-insensitive city lookup over cities.ts, English aliases + Chinese names. */
function resolveCity(raw: string): CityMatch | null {
  const norm = String(raw).trim().toLowerCase().replace(/\s+/g, ' ');
  if (!norm) return null;
  const cities = allCities();
  // 1. explicit romanized alias
  const alias = CITY_ALIASES[norm];
  if (alias) {
    const hit = cities.find(c => c.name === alias);
    if (hit) return hit;
  }
  // 2. exact Chinese name (case-insensitive is moot for CJK; trim 市 suffix)
  const noShi = norm.replace(/市$/, '');
  const exact = cities.find(c => c.name.toLowerCase() === norm || c.name.toLowerCase() === noShi);
  if (exact) return exact;
  // 3. substring containment ("广州市", "深圳南山"…): unique prefix match only
  const contains = cities.filter(c => norm.startsWith(c.name.toLowerCase()) || c.name.toLowerCase().startsWith(norm));
  if (contains.length === 1) return contains[0];
  return null;
}

function toolZiweiFromCity(args: any): unknown {
  if (args === null || typeof args !== 'object') throw new ToolError('arguments must be an object');
  const year = assertInt(args.year, 'year', 1, 9999);
  const month = assertInt(args.month, 'month', 1, 12);
  const day = assertInt(args.day, 'day', 1, 31);
  const minute = args.minute === undefined ? 0 : assertInt(args.minute, 'minute', 0, 59);
  const gender = assertGender(args.gender);
  const hour = assertInt(args.hour, 'hour (clock)', 0, 23);
  if (args.longitude !== undefined && typeof args.longitude !== 'number') {
    throw new ToolError(`longitude must be a number; received ${JSON.stringify(args.longitude)}`);
  }

  let resolved: CityMatch | null = null;
  let matchedVia: string | null = null;
  if (args.city !== undefined) {
    if (typeof args.city !== 'string' || !args.city.trim()) throw new ToolError('city must be a non-empty string');
    resolved = resolveCity(args.city);
    matchedVia = 'cities.ts';
    if (!resolved) {
      const suggestions = allCities().slice(0, 12).map(c => `${c.province.replace(/[省市自治区特别行政区]*$/, '')}·${c.name}`);
      throw new ToolError(
        `unknown city ${JSON.stringify(args.city)}: no match in cities.ts (case-insensitive, Chinese or common English names). ` +
        `Examples: ${suggestions.join(', ')} … — or pass an explicit longitude instead`,
      );
    }
  }
  // Explicit longitude wins when both are given (documented override).
  const longitude: number | undefined = args.longitude !== undefined ? args.longitude : resolved?.longitude;
  if (longitude === undefined) throw new ToolError('either city or longitude is required');

  const rb = resolveBirth({ year, month, day, hour, minute, gender, longitude });
  const chart = buildChart(rb);
  return {
    meta: {
      input: { year, month, day, clockHour: hour, clockMinute: minute, gender, city: args.city ?? null },
      cityResolved: resolved ? { name: resolved.name, province: resolved.province, longitude: resolved.longitude, matchedVia } : { name: null, longitude, matchedVia: 'explicit-longitude' },
      effectiveDate: rb.effectiveDate,
      hourBranch: `${rb.hourBranch}(${BRANCHES[rb.hourBranch]})`,
      dayShiftFromLateZi: rb.dayShiftFromLateZi,
      longitude: rb.longitude,
      trueSolarTime: rb.trueSolarTime,
      fourPillars: chart.lunarInfo.fourPillars ?? null,
      fourPillarsLunar: chart.lunarInfo.fourPillarsLunar ?? null,
    },
    chart,
  };
}

// ── ziwei_solar_lunar ───────────────────────────────────────────────────────

function fourPillarsForSolarDate(y: number, m: number, d: number): { fourPillars: string[]; dayStemBranch: string } {
  // No birth hour is supplied, so the 时柱 is computed at 12:00 (noon is never
  // near the 子时 day boundary; the day/month pillars are hour-independent).
  const lu: any = (Solar.fromYmdHms(y, m, d, 12, 0, 0) as any).getLunar();
  const ec: any = lu.getEightChar();
  return {
    fourPillars: [ec.getYear(), ec.getMonth(), ec.getDay(), ec.getTime()],
    dayStemBranch: `${lu.getDayGan()}${lu.getDayZhi()}`,
  };
}

function toolZiweiSolarLunar(args: any): unknown {
  if (args === null || typeof args !== 'object') throw new ToolError('arguments must be an object');
  const hasSolar = args.solar !== undefined;
  const hasLunar = args.lunar !== undefined;
  if (hasSolar === hasLunar) throw new ToolError('exactly one of solar / lunar must be given');

  if (hasSolar) {
    const s = args.solar;
    if (s === null || typeof s !== 'object') throw new ToolError('solar must be {year,month,day}');
    // DEEP FIX 2026-11-05 (5c): lunar-javascript's tables are only reliable
    // 1900-2050; outside that the conversion returns plausible-but-wrong dates
    // silently. Bound the solar direction exactly like the lunar direction.
    const y = assertInt(s.year, 'solar.year', LUNAR_YEAR_MIN, LUNAR_YEAR_MAX);
    const m = assertInt(s.month, 'solar.month', 1, 12);
    const d = assertInt(s.day, 'solar.day', 1, 31);
    assertDateExists(y, m, d);
    const lu: any = (Solar.fromYmd(y, m, d) as any).getLunar();
    const rawMonth: number = lu.getMonth(); // negative = leap month
    const { fourPillars, dayStemBranch } = fourPillarsForSolarDate(y, m, d);
    return {
      direction: 'solar-to-lunar',
      solar: { year: y, month: m, day: d },
      lunar: { year: lu.getYear(), month: Math.abs(rawMonth), isLeap: rawMonth < 0, day: lu.getDay() },
      dayGanzhi: { day: dayStemBranch },
      fourPillars, // [年柱, 月柱, 日柱, 时柱@12:00]
      note: '时柱 computed at 12:00 — supply a birth hour to ziwei_chart for the real 时柱',
    };
  }

  const l = args.lunar;
  if (l === null || typeof l !== 'object') throw new ToolError('lunar must be {year,month,isLeap?,day}');
  const y = assertInt(l.year, 'lunar.year', LUNAR_YEAR_MIN, LUNAR_YEAR_MAX);
  const m = assertInt(l.month, 'lunar.month', 1, 12);
  const d = assertInt(l.day, 'lunar.day', 1, 30);
  const isLeap = l.isLeap === true;
  if (!isValidLunarDate(y, m, d, isLeap)) {
    const leap = leapMonthOfLunarYear(y);
    throw new ToolError(
      `lunar date ${y}-${isLeap ? '闰' : ''}${m}-${d} does not exist` +
      (isLeap && leap === 0 ? ` (no leap month in lunar year ${y})` : '') +
      (leap > 0 && isLeap && leap !== m ? ` (year ${y} leap month is ${leap}, not ${m})` : ''),
    );
  }
  const sol = lunarToSolar(y, m, d, isLeap);
  if (!sol) throw new ToolError('lunar-to-solar conversion failed unexpectedly');
  const { fourPillars, dayStemBranch } = fourPillarsForSolarDate(sol.year, sol.month, sol.day);
  return {
    direction: 'lunar-to-solar',
    lunar: { year: y, month: m, isLeap, day: d },
    solar: sol,
    dayGanzhi: { day: dayStemBranch },
    fourPillars,
    note: '时柱 computed at 12:00 — supply a birth hour to ziwei_chart for the real 时柱',
  };
}

// ── ziwei_selftest ──────────────────────────────────────────────────────────

function toolZiweiSelftest(_args: any): unknown {
  // Gold-standard case, deterministic, no external calls. The anchor birth is
  // SYNTHETIC (2026-11-05 public-release sanitisation): it preserves the
  // structural coverage of the original anchor — clock hour 23 keeps the
  // late-子 day-rollover path, lon 114.2 keeps the Hong-Kong-ish true-solar
  // correction, and 命宮 stays in 子 — while being a non-person date.
  const rb = resolveBirth({ year: 1986, month: 12, day: 8, hour: 23, minute: 45, gender: 'male', longitude: 114.2 });
  const chart = buildChart(rb);
  const mg = chart.palaces.find(p => p.isMingGong)!;
  const mingStar = mg.stars.find(s => s.type === 'major');
  const checks: { name: string; expected: unknown; actual: unknown; ok: boolean }[] = [
    { name: 'effectiveDate', expected: '1986-12-09', actual: rb.effectiveDate, ok: rb.effectiveDate === '1986-12-09' },
    { name: 'fourPillars', expected: '丙寅/庚子/丁亥/庚子', actual: (chart.lunarInfo.fourPillars ?? []).join('/'), ok: (chart.lunarInfo.fourPillars ?? []).join('/') === '丙寅/庚子/丁亥/庚子' },
    { name: 'mingGongBranch', expected: '子', actual: BRANCHES[mg.branch], ok: BRANCHES[mg.branch] === '子' },
    { name: 'mingGongMainStar', expected: '天同(旺)', actual: mingStar ? `${mingStar.name}(${mingStar.brightnessRaw})` : null, ok: !!mingStar && mingStar.name === '天同' && mingStar.brightnessRaw === '旺' },
    { name: 'wuxingJu', expected: '土五局', actual: chart.wuxingJuName, ok: chart.wuxingJuName === '土五局' },
    { name: 'mingZhu', expected: '贪狼', actual: chart.mingZhu ?? null, ok: chart.mingZhu === '贪狼' },
    { name: 'shenZhu', expected: '天梁', actual: chart.shenZhu ?? null, ok: chart.shenZhu === '天梁' },
    { name: 'trueSolarClock', expected: '23:29:34', actual: rb.trueSolarTime ? (rb.trueSolarTime as any).clock : null, ok: !!(rb.trueSolarTime && (rb.trueSolarTime as any).clock === '23:29:34') },
    // Checks 9–10 (2026-11-04): lichun-boundary January month stems — computed
    // deterministically from the engine's own lunar tables (same helper the
    // layers tool uses), asserting stability of the fixed behaviour:
    // 2026-01 belongs to 乙巳年 lunar m11 → 五虎遁 乙庚起戊寅 → 戊子;
    // 2025-01 belongs to 甲辰年 lunar m12 → 甲己起丙寅 → m12 = 丁丑.
    { name: 'liuyueStem2026Jan', expected: '戊', actual: liuyueStemForSolarDate(2026, 1), ok: liuyueStemForSolarDate(2026, 1) === '戊' },
    { name: 'liuyueStem2025Jan', expected: '丁', actual: liuyueStemForSolarDate(2025, 1), ok: liuyueStemForSolarDate(2025, 1) === '丁' },
    // Check 11 (2026-11-04 leap-month straddle fix): 2023 has 闰二月; solar
    // 2023-04-25 is 三月初六 (NOT 闰二月) — 癸卯年 五虎遁 m3 = 丙辰. The old
    // mid-month sampling returned 乙 (闰二月 base-month stem) for all of April.
    { name: 'liuyueStem2023Apr25', expected: '丙', actual: liuyueStemForSolarDate(2023, 4, 25), ok: liuyueStemForSolarDate(2023, 4, 25) === '丙' },
    // Check 12 (2026-11-05 unified mid-month rule): ordinary (non-leap) month-
    // boundary straddles must ALSO flag ambiguousMonth — 2026-03 spans lunar m1
    // (正月) → m2 (二月), resolves to m1 by the 15th → stem 庚 + flag. This is
    // the reviewer-requested lock-in for the ordinary-straddle defense.
    {
      name: 'ordinaryStraddle2026Mar', expected: '庚+ambiguousMonth',
      actual: `${liuyueStemForSolarDate(2026, 3)}${resolveLiuyueMonth(2026, 3, null).ambiguousMonth ? '+ambiguousMonth' : ''}`,
      ok: liuyueStemForSolarDate(2026, 3) === '庚' && resolveLiuyueMonth(2026, 3, null).ambiguousMonth === true,
    },
    // Check 13 (2026-11-05 deep fix): direct lunarMonth:1 for 2026 must resolve
    // through the lunar tables to solar 2026-03-03 (丙午 year) → stem 庚.
    // The old two-source bug returned 戊 (乙巳 year — solar Jan 15).
    // 命宫 context alongside patterns. Reuses the same resolveBirth/buildChart
    // helpers as ziwei_chart — same true-solar correction, same chart.
    {
      name: 'lunarMonthDirect2026', expected: '庚',
      actual: (() => {
        const r = toolZiweiSihuaLayers({ year: 2026, gender: 'male', birth: { year: 1986, month: 12, day: 8, hour: 12, minute: 0 }, layers: ['liuyue'], lunarMonth: 1 }) as any;
        return r.layers.liuyue.stem;
      })(),
      ok: (() => {
        const r = toolZiweiSihuaLayers({ year: 2026, gender: 'male', birth: { year: 1986, month: 12, day: 8, hour: 12, minute: 0 }, layers: ['liuyue'], lunarMonth: 1 }) as any;
        return r.layers.liuyue.stem === '庚';
      })(),
    },
    // Checks 14–17 (2026-11-10 pattern-anchor batch, engine 906bd93): detectPatterns
    // gold anchors. Expected names captured from the CURRENT engine before the
    // checks were written — not guessed. The gold chart fires ZERO strict
    // 《全书》卷一 entries (its 命宮 is 天同太阴 in 子; none of the 49 strict
    // table entries match it), so strict-table coverage is anchored on two
    // auxiliary fixtures below instead of the gold birth.
    {
      name: 'patternsGoldGoldChart',
      expected: '化权入官,天同化禄入命,巨日同宫,机月同梁',
      actual: detectPatterns(chart).map(p => p.name).sort().join(','),
      ok: detectPatterns(chart).map(p => p.name).sort().join(',') === '化权入官,天同化禄入命,巨日同宫,机月同梁',
    },
    // 四化 bonus fix (palaceHasSiHua/sanFangHasSiHua): the gold chart has
    // 天同化禄 sitting IN 命宫 itself — 府相朝垣's bonus line '命宫见禄' fires
    // via palaceHasSiHua. The 4 required stars (府/相/昌/…) need not all be
    // present, so instead we lock the general detector that DID fire via the
    // sanFang path: 机月同梁's bonus '再会化科' requires sanFangHasSiHua(科) —
    // 文昌化科 sits in 夫妻 (branch 10), which is NOT in the gold 三方四正
    // (命子/财申/官辰/迁午), so that bonus must NOT fire. Both directions of
    // the fix are covered by the fixture below (杀破狼 bonus fires via
    // sanFangHasSiHua) + this negative control.
    {
      name: 'siHuaBonusNegativeControlGold',
      expected: '机月同梁 without 再会化科 bonus (化科 in 夫妻, outside 三方四正)',
      actual: (() => {
        const p = detectPatterns(chart).find(x => x.name === '机月同梁');
        return p ? JSON.stringify(p.conditions?.bonus ?? []) : 'pattern missing';
      })(),
      ok: (() => {
        const p = detectPatterns(chart).find(x => x.name === '机月同梁');
        return !!p && !(p.conditions?.bonus ?? []).includes('再会化科');
      })(),
    },
    // Strict-table fixture A (1978-07-01 11:00 male, no longitude — branch 5
    // 巳): 命宮 七杀 in 子 fires 七杀朝斗 via the strict 定贵局 table (第11条)
    // AND 杀破狼 whose bonus '三方有化禄或化权' fires via sanFangHasSiHua —
    // the positive side of the 四化 bonus fix.
    {
      name: 'patternsStrictFixtureA',
      expected: '七杀朝斗[strict《全书》定贵局第11条]+杀破狼化禄化权bonus',
      actual: (() => {
        const fa = buildChart(resolveBirth({ year: 1978, month: 7, day: 1, hour: 11, minute: 0, gender: 'male' }));
        const pats = detectPatterns(fa);
        const strict = pats.find(p => p.name === '七杀朝斗' && (p.source ?? '').includes('·卷一·'));
        const sk = pats.find(p => p.name === '杀破狼');
        const bonusOk = !!(sk?.conditions?.bonus ?? []).some(b => b.includes('三方有化禄或化权'));
        return strict ? `七杀朝斗 strict ✓, 杀破狼 bonus ${bonusOk ? '✓' : '✗'}` : `七杀朝斗 strict ✗ (pats: ${pats.map(p => p.name).join(',')})`;
      })(),
      ok: (() => {
        const fa = buildChart(resolveBirth({ year: 1978, month: 7, day: 1, hour: 11, minute: 0, gender: 'male' }));
        const pats = detectPatterns(fa);
        const strict = pats.find(p => p.name === '七杀朝斗' && (p.source ?? '').includes('·卷一·'));
        const sk = pats.find(p => p.name === '杀破狼');
        const bonusOk = !!(sk?.conditions?.bonus ?? []).some(b => b.includes('三方有化禄或化权'));
        return !!strict && bonusOk;
      })(),
    },
    // Strict-table fixture B (1990-05-20 08:00 female, no longitude — branch 3
    // 卯): 命宮 空宫 in 丑 fires 坐贵向贵 via strict 定贵局 第9条 (魁钺坐命).
    {
      name: 'patternsStrictFixtureB',
      expected: '坐贵向贵[strict《全书》定贵局第9条]',
      actual: (() => {
        const fb = buildChart(resolveBirth({ year: 1990, month: 5, day: 20, hour: 8, minute: 0, gender: 'female' }));
        const strict = detectPatterns(fb).find(p => p.name === '坐贵向贵' && (p.source ?? '').includes('·卷一·'));
        return strict ? `坐贵向贵 strict ✓ (${strict.source})` : '坐贵向贵 strict ✗';
      })(),
      ok: (() => {
        const fb = buildChart(resolveBirth({ year: 1990, month: 5, day: 20, hour: 8, minute: 0, gender: 'female' }));
        return !!detectPatterns(fb).find(p => p.name === '坐贵向贵' && (p.source ?? '').includes('·卷一·'));
      })(),
    },
  ];
  return { pass: checks.every(c => c.ok), checks };
}

// ── ziwei_compatibility ─────────────────────────────────────────────────────

/** Section-9 pair table from heming-knowledge HEMING_METHODOLOGY (verbatim). */
const PAIR_TABLE: { stars: [string, string]; rating: string; note: string }[] = [
  { stars: ['紫微', '天府'], rating: '★★★★★', note: '帝星遇财库，相互成就，最稳定' },
  { stars: ['天相', '*'], rating: '★★★★', note: '印星佐才，天相适应性强' },
  { stars: ['天梁', '天同'], rating: '★★★★', note: '老成与温和互补，白头偕老型' },
  { stars: ['太阳', '太阴'], rating: '★★★★', note: '日月并明，经典互补，阴阳调和' },
  { stars: ['七杀', '七杀'], rating: '★★', note: '两虎相争，火花大，矛盾多' },
  { stars: ['破军', '破军'], rating: '★★', note: '双破，彼此破坏，婚姻不稳' },
  { stars: ['廉贞', '七杀'], rating: '★', note: '三凶组合，生离死别风险高' },
  { stars: ['廉贞', '破军'], rating: '★', note: '三凶组合，生离死别风险高' },
  { stars: ['武曲', '天同'], rating: '★★★', note: '刚柔互济，武曲收敛遇天同温和，能互补' },
];

function toolZiweiCompatibility(args: any): unknown {
  if (args === null || typeof args !== 'object') throw new ToolError('arguments must be an object');
  for (const key of ['a', 'b'] as const) {
    const p = args[key];
    if (p === null || typeof p !== 'object') throw new ToolError(`${key} must be an object {year,month,day,hour,minute,gender,longitude?}`);
    assertInt(p.year, `${key}.year`, 1, 9999);
    assertInt(p.month, `${key}.month`, 1, 12);
    assertInt(p.day, `${key}.day`, 1, 31);
    assertInt(p.hour, `${key}.hour (clock)`, 0, 23);
    assertGender(p.gender, `${key}.gender`);
    if (p.minute !== undefined) assertInt(p.minute, `${key}.minute`, 0, 59);
    if (p.longitude !== undefined && typeof p.longitude !== 'number') throw new ToolError(`${key}.longitude must be a number`);
  }
  const side = (p: any) => {
    const rb = resolveBirth({
      year: p.year, month: p.month, day: p.day, hour: p.hour,
      minute: p.minute ?? 0, gender: p.gender, longitude: p.longitude,
    });
    const chart = buildChart(rb);
    return { rb, chart, palaceOf: starPalaceMap(chart) };
  };
  const A = side(args.a), B = side(args.b);

  const majors = (chart: ZiweiChart, palaceName: string) =>
    (chart.palaces.find(p => p.name === palaceName)?.stars ?? []).filter(s => s.type === 'major').map(s => s.name);
  const desc = (sideObj: ReturnType<typeof side>, label: string) => {
    const { chart } = sideObj;
    const mg = chart.palaces.find(p => p.isMingGong)!;
    const fuqi = chart.palaces.find(p => p.name === '夫妻')!;
    const fude = chart.palaces.find(p => p.name === '福德')!;
    return {
      label,
      effectiveDate: sideObj.rb.effectiveDate,
      fourPillars: (chart.lunarInfo.fourPillars ?? []).join('/'),
      mingGong: { branch: BRANCHES[mg.branch], stars: majors(chart, mg.name) },
      fuQiGong: { branch: BRANCHES[fuqi.branch], stars: majors(chart, fuqi.name) },
      fuDeGong: { branch: BRANCHES[fude.branch], stars: majors(chart, fude.name) },
      yearStem: STEMS[chart.lunarInfo.yearStem],
    };
  };

  const aDesc = desc(A, 'a'), bDesc = desc(B, 'b');
  const aMing = new Set(aDesc.mingGong.stars), bMing = new Set(bDesc.mingGong.stars);

  // 天作之合 test (methodology §2): A夫妻星 ⊂ B命宫星 AND B夫妻星 ⊂ A命宫星.
  // DEEP FIX 2026-11-05: the cross-check was inverted — it tested each side's
  // 夫妻 stars against its OWN 命宮 (self-containment, so tianZuoZhiHe could
  // never express the actual methodology). Now: every A-夫妻 star must be in
  // B's 命宮 set AND every B-夫妻 star in A's 命宮 set. aFuqiStarsInBMing /
  // bFuqiStarsInAMing echo the true cross-intersections (also fixed: they
  // were self-filtered before).
  const aFuqiInBMing = aDesc.fuQiGong.stars.filter(s => bMing.has(s));
  const bFuqiInAMing = bDesc.fuQiGong.stars.filter(s => aMing.has(s));
  const mutualMirror = bDesc.fuQiGong.stars.length > 0 && bDesc.fuQiGong.stars.every(s => aMing.has(s))
    && aDesc.fuQiGong.stars.length > 0 && aDesc.fuQiGong.stars.every(s => bMing.has(s));
  const oneWayMirror = !mutualMirror && (bDesc.fuQiGong.stars.some(s => aMing.has(s)) || aDesc.fuQiGong.stars.some(s => bMing.has(s)));

  // 四化飞化互参: A's birth-stem transforms → palaces in B's chart (and reverse).
  const fly = (from: ReturnType<typeof side>, to: ReturnType<typeof side>) => {
    const stemIndex = from.chart.lunarInfo.yearStem;
    const th = getSiHuaByStem(stemIndex);
    const out: Record<string, { star: string; palaceInOther: string | null }> = {};
    for (const k of SIHUA_KEYS) {
      const star = th[k];
      out[k] = { star, palaceInOther: star ? (to.palaceOf[star] ?? null) : null };
    }
    return { stem: STEMS[stemIndex], transforms: out };
  };
  const flyAtoB = fly(A, B), flyBtoA = fly(B, A);
  const jiFlags: string[] = [];
  for (const [dir, f] of [['A→B', flyAtoB], ['B→A', flyBtoA]] as const) {
    const jiPalace = f.transforms['忌'].palaceInOther;
    if (jiPalace === '命宫') jiFlags.push(`${dir}: ${f.transforms['忌'].star}化忌入对方命宫（自身给对方带来压力）`);
    // DEEP FIX 2026-11-05: engine palace names carry NO 宮 suffix except 命宮
    // (夫妻/福德/田宅/官禄/仆役/迁移/疾厄/财帛/子女/兄弟/父母) — the old
    // '夫妻宫' comparison never matched, making this flag dead. Now '夫妻'.
    if (jiPalace === '夫妻') jiFlags.push(`${dir}: ${f.transforms['忌'].star}化忌入对方夫妻宫（带给对方婚姻伤害）`);
  }

  // 太阳/太阴 state (methodology §3).
  const sunMoon = (sideObj: ReturnType<typeof side>) => {
    const find = (name: string) => {
      for (const p of sideObj.chart.palaces) {
        const s = p.stars.find(st => st.name === name);
        if (s) return { star: name, palace: p.name, brightness: s.brightnessRaw ?? null, siHua: s.siHua ?? null };
      }
      return { star: name, palace: null, brightness: null, siHua: null };
    };
    return { 太阳: find('太阳'), 太阴: find('太阴') };
  };

  // 命格速配 (methodology §9 table, verbatim pairs).
  const pairFindings: { rating: string; note: string; pair: string[] }[] = [];
  for (const m of aMing) for (const n of bMing) {
    const hit = PAIR_TABLE.find(pt => (pt.stars[0] === m && (pt.stars[1] === '*' || pt.stars[1] === n)) || (pt.stars[1] === m && (pt.stars[0] === '*' || pt.stars[0] === n)) || (pt.stars[0] === n && pt.stars[1] === m) || (pt.stars[1] === n && pt.stars[0] === m));
    if (hit) pairFindings.push({ rating: hit.rating, note: hit.note, pair: [m, n] });
  }

  // 夫妻宫 knowledge (STAR_IN_FUQI_GU) + 生年四化落自己夫妻宫 (SIHUA_IN_FUQI_GU).
  const knowledge = (sideObj: ReturnType<typeof side>, label: string) => {
    const chart = sideObj.chart;
    const fuqi = chart.palaces.find(p => p.name === '夫妻')!;
    const out: { side: string; star: string; summary: string; good: string; bad: string }[] = [];
    for (const s of fuqi.stars.filter(st => st.type === 'major')) {
      const k = (STAR_IN_FUQI_GU as any)[s.name];
      if (k) out.push({ side: label, star: s.name, summary: k.summary, good: k.good, bad: k.bad });
    }
    const sihuaInFuqi = fuqi.stars.filter(st => st.siHua).map(st => ({ star: st.name, siHua: st.siHua, text: (SIHUA_IN_FUQI_GU as any)['化' + st.siHua] ?? null }));
    return { starKnowledge: out, sihuaInOwnFuqi: sihuaInFuqi };
  };

  // 婚姻星 presence (MARRIAGE_STARS_BRIEF) in 命宫/夫妻宫 of each side.
  const marriageStars = (sideObj: ReturnType<typeof side>, label: string) => {
    const hits: { star: string; palace: string; meaning: string }[] = [];
    for (const p of sideObj.chart.palaces) {
      if (p.name !== '命宫' && p.name !== '夫妻') continue;
      for (const s of p.stars) {
        const m = (MARRIAGE_STARS_BRIEF as any)[s.name];
        if (m) hits.push({ star: s.name, palace: p.name, meaning: m });
      }
    }
    return { side: label, hits };
  };

  // FEATURE B (2026-11-04): current 大限 overlap check — pure structural
  // flags, no scoring. Each side's current daxian palace branch/stem (via
  // chart.currentDaXianIndex), plus whether that daxian stem's 化忌 flies into
  // the OTHER party's 命宮 (sihua.ts + both charts).
  const currentDaxian = (sideObj: ReturnType<typeof side>) => {
    const chart = sideObj.chart;
    const idx = chart.currentDaXianIndex;
    const dx = idx >= 0 && idx < chart.daXians.length ? chart.daXians[idx] : null;
    if (!dx) return { index: idx, available: false, ageRange: null, palaceName: null, palaceBranch: null, stem: null, stemIndex: null, transforms: null };
    const palace = chart.palaces.find(p => p.branch === dx.palaceBranch)!;
    return {
      index: idx,
      available: true,
      ageRange: [dx.startAge, dx.endAge],
      palaceName: dx.palaceName,
      palaceBranch: BRANCHES[dx.palaceBranch],
      stem: STEMS[palace.stem],
      stemIndex: palace.stem,
      transforms: decorateTransforms(getSiHuaByStem(palace.stem), sideObj.palaceOf),
    };
  };
  const jiIntoOtherMingGong = (self: ReturnType<typeof currentDaxian>, other: ReturnType<typeof side>) => {
    if (!self.available || self.stemIndex === null) return { star: null, palaceInOther: null, intoOtherMingGong: false };
    const th = getSiHuaByStem(self.stemIndex);
    const star = th['忌'] || null;
    const palace = star ? (other.palaceOf[star] ?? null) : null;
    return { star, palaceInOther: palace, intoOtherMingGong: palace === '命宫' };
  };
  const aDx = currentDaxian(A), bDx = currentDaxian(B);
  const sameBranchFlag = aDx.available && bDx.available && aDx.palaceBranch === bDx.palaceBranch;
  const sameStemFlag = aDx.available && bDx.available && aDx.stem === bDx.stem;
  const daXianCheck = {
    note: '2026-11-04 feature: current 大限 overlap flags — structural facts only, no score.',
    a: { ...aDx, ji: jiIntoOtherMingGong(aDx, B) },
    b: { ...bDx, ji: jiIntoOtherMingGong(bDx, A) },
    // Flags (2026-11-04 external-review batch follow-up):
    //   sameDaxianPalaceBranch — both current daxian palaces share the same BRANCH only.
    //   sameDaxianStem         — both current daxian palaces share the same STEM only.
    //   sameDaxianGanzhi       — BOTH stem AND branch equal, i.e. the two parties sit on
    //     the same sexagenary 干支 pillar (同干支 / 同頻共振 per external reviewer
    //     2026-11-04) — true exactly when the two flags above are both true.
    flags: {
      sameDaxianPalaceBranch: sameBranchFlag,
      sameDaxianStem: sameStemFlag,
      sameDaxianGanzhi: sameBranchFlag && sameStemFlag,
    },
  };

  return {
    meta: { a: args.a, b: args.b, method: 'heming-knowledge.ts (倪海厦 + 《全书》) — structured findings only, no invented score' },
    sides: { a: aDesc, b: bDesc },
    daXianCheck,
    findings: {
      mirrorTest: {
        tianZuoZhiHe: mutualMirror,
        oneWayMirror,
        detail: mutualMirror
          ? '双方夫妻宫主星皆落在对方命宫（天作之合级，方法论§2最高级匹配）'
          : oneWayMirror
            ? '一方夫妻宫主星对应对方命宫（次级良配）'
            : '无夫妻宫↔命宫镜像对应',
        aFuqiStarsInBMing: aFuqiInBMing, bFuqiStarsInAMing: bFuqiInAMing,
      },
      flyingSihua: { aToB: flyAtoB, bToA: flyBtoA, jiFlags },
      sunMoonState: { a: sunMoon(A), b: sunMoon(B) },
      mingGeQuickPairs: pairFindings,
      fuqiKnowledge: { a: knowledge(A, 'a'), b: knowledge(B, 'b') },
      marriageStars: { a: marriageStars(A, 'a'), b: marriageStars(B, 'b') },
    },
    scoreCriteriaReference: HEMING_SCORE_CRITERIA,
  };
}

// ── ziwei_batch_stats ───────────────────────────────────────────────────────

const BATCH_EPOCH_UTC = Date.UTC(1950, 0, 1);
const BATCH_STATS_QUESTIONS = [
  'main-star-in-mingGong-distribution',
  'sihua-palace-distribution',
  'wuxingJu-distribution',
] as const;

/** Parse the `hours` param: 'all' (default, 12 branches) or int array 0..11. */
function parseHoursParam(v: unknown): number[] {
  if (v === undefined || v === 'all') return [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  if (!Array.isArray(v) || v.length === 0) {
    throw new ToolError('hours must be "all" or a non-empty array of hour-branch integers 0-11');
  }
  const set = new Set<number>();
  for (const h of v) set.add(assertInt(h, 'hours[] (branch)', 0, 11));
  return Array.from(set).sort((a, b) => a - b);
}

async function toolZiweiBatchStats(args: any): Promise<unknown> {
  if (args === null || typeof args !== 'object') throw new ToolError('arguments must be an object');
  const question = args.question;
  if (!BATCH_STATS_QUESTIONS.includes(question)) {
    throw new ToolError(`question must be one of ${BATCH_STATS_QUESTIONS.join(' | ')}`);
  }
  const y1 = args.yearFrom === undefined ? 1950 : assertInt(args.yearFrom, 'yearFrom', 1901, 2050);
  const y2 = args.yearTo === undefined ? 2000 : assertInt(args.yearTo, 'yearTo', 1901, 2050);
  if (y2 < y1) throw new ToolError('yearTo must be >= yearFrom');
  const gender = assertGender(args.gender);
  // BUG #3 FIX (2026-11-04): census over day×hour space by default ('all' =
  // 12 hour branches per day) instead of a locked-noon subspace. Legacy
  // hourBranch still honoured when `hours` is absent.
  const hours: number[] = args.hours !== undefined
    ? parseHoursParam(args.hours)
    : (args.hourBranch !== undefined ? [assertInt(args.hourBranch, 'hourBranch', 0, 11)] : parseHoursParam('all'));
  const maxCharts = args.maxCharts === undefined ? 5000 : assertInt(args.maxCharts, 'maxCharts', 100, 20000);

  const startOffset = Math.round((Date.UTC(y1, 0, 1) - BATCH_EPOCH_UTC) / 86400000);
  const dayCount = Math.round((Date.UTC(y2, 11, 31) - Date.UTC(y1, 0, 1)) / 86400000) + 1;
  const slots = dayCount * hours.length; // deterministic stride now over day×hour space
  const stride = Math.max(1, Math.ceil(slots / maxCharts));

  const HERE = dirnameOf(fileURLToPath(import.meta.url));
  // Windows fix: spawn node + tsx CLI entry instead of the POSIX-only
  // .bin/tsx shim (spawn of the extensionless shim → ENOENT on win32).
  const tsx = joinPath(HERE, '../../vendor/ziwei-doushu/node_modules/tsx/dist/cli.mjs');
  const worker = joinPath(HERE, 'batch-stats-worker.mts');
  // OOM observability (2026-11-11): record free memory before spawn so an
  // oom-kill (exit 137 / SIGKILL) can name the real cause instead of looking
  // like a 120 s timeout. The worker itself clamps its thread count to free
  // memory (see batch-stats-worker.mts).
  const freeAtSpawn = freemem();
  // DEEP FIX 2026-11-05: async spawn instead of execFileSync — the old
  // synchronous 120 s call blocked the whole event loop, so /health and every
  // concurrent request queued behind the batch. Same contract otherwise:
  // 120 s kill, stdout collected, worker threads stay inside the child.
  const agg: any = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tsx, worker, JSON.stringify({
      y1, y2, gender, hours, startDayOffset: startOffset, dayCount, stride,
    })], { stdio: ['ignore', 'pipe', 'pipe'] });
    let raw = '';
    let err = '';
    let killed = false;
    const timer = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, 120000);
    child.stdout.on('data', (c: Buffer) => { raw += c; });
    child.stderr.on('data', (c: Buffer) => { err += c; });
    child.on('error', (e) => { clearTimeout(timer); reject(new ToolError(`batch-stats worker failed: ${e?.message ?? e}`)); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (killed) return reject(new ToolError('batch-stats worker timed out after 120 s (killed)'));
      // OOM kill surfaces as exit 137 (shell convention) or SIGKILL (direct).
      if (code === 137 || (code === null && signal === 'SIGKILL')) {
        return reject(new ToolError(`batch-stats worker killed by SIGKILL (likely OOM — free memory at spawn ~${Math.round(freeAtSpawn / (1024 * 1024))} MB; worker count was clamped, see CHANGES.md v0.3.1)`));
      }
      if (code !== 0) return reject(new ToolError(`batch-stats worker failed (exit ${code})${signal ? ` (signal ${signal})` : ''}${err ? ': ' + err.slice(0, 300) : ''}`));
      try { resolve(JSON.parse(raw)); } catch { reject(new ToolError('batch-stats worker returned unparseable output')); }
    });
  });
  if (!agg.ok) throw new ToolError('batch-stats worker reported failure');

  const distribution = question === 'main-star-in-mingGong-distribution'
    ? agg.mingStar
    : question === 'wuxingJu-distribution' ? agg.ju : agg.sihuaPalace;

  // Sum of every emitted count. Counts are PER-STAR OCCURRENCES: a chart whose
  // 命宮 holds two main stars (e.g. 太陽巨門) contributes to BOTH counts, so this
  // sum can exceed chartsComputed. Exposed next to chartsComputed so integrators
  // can audit the ratio instead of dividing a count by chartsComputed blindly.
  const sumOfCounts = (d: any): number =>
    typeof d === 'number' ? d : Object.values(d).reduce((a: number, v: any) => a + sumOfCounts(v), 0);

  return {
    question,
    samplingRule:
      `deterministic day×hour enumeration of every (day, hour-branch) slot in ${y1}-01-01..${y2}-12-31 ` +
      `(hours: ${hours.length === 12 ? 'all 12 branches' : `[${hours.join(',')}]`}, gender ${gender}), ` +
      `stride ${stride} (every ${stride}th slot) to stay under the ${maxCharts}-chart cap. ` +
      'NOT random sampling — reproducible; NOT population-representative (uniform dates, no birth-rate weighting).',
    hoursUsed: hours,
    chartsComputed: agg.computedCharts,
    sumOfCounts: sumOfCounts(distribution),
    elapsedMs: agg.ms,
    workers: agg.workers,
    distribution,
  };
}

// ── ziwei_flow helpers (liuri / liushi layers) ──────────────────────────────

function flowDayLayer(year: number, month: number, day: number, palaceOf: Record<string, string>) {
  const lu: any = (Solar.fromYmd(year, month, day) as any).getLunar();
  const rawMonth: number = lu.getMonth();
  const isLeap = rawMonth < 0;
  const r = getLiuRiSiHua(lu.getYear(), Math.abs(rawMonth), lu.getDay(), isLeap);
  if (!r) throw new ToolError(`could not resolve 流日 stem for ${year}-${month}-${day}`);
  return {
    stem: r.stemName,
    solarDate: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    lunarDate: `${lu.getYear()}-${Math.abs(rawMonth)}-${lu.getDay()}${isLeap ? '(闰)' : ''}`,
    transforms: decorateTransforms(r.transforms, palaceOf),
  };
}

function flowHourLayer(year: number, month: number, day: number, flowHour: number, palaceOf: Record<string, string>) {
  const h = assertInt(flowHour, 'flowHour (clock)', 0, 23);
  const branch = h === 23 ? 0 : Math.floor((h + 1) / 2);
  // DEEP FIX 2026-11-05 (5d): for h===23 (late 子时) the natal resolver
  // advances the DAY (next-day rule) — the flow-hour layer must use the SAME
  // next day's stem/branch, otherwise the hour stem is computed one day off.
  let dYear = year, dMonth = month, dDay = day;
  if (h === 23) {
    const shifted = new Date(Date.UTC(year, month - 1, day));
    shifted.setUTCDate(shifted.getUTCDate() + 1);
    dYear = shifted.getUTCFullYear(); dMonth = shifted.getUTCMonth() + 1; dDay = shifted.getUTCDate();
  }
  const lu: any = (Solar.fromYmd(dYear, dMonth, dDay) as any).getLunar();
  const dayStemIndex = STEMS.indexOf(lu.getDayGan());
  if (dayStemIndex < 0) throw new ToolError('could not resolve day stem');
  const r = getLiuShiSiHua(dayStemIndex, branch);
  return {
    stem: r.stemName,
    solarDate: `${dYear}-${String(dMonth).padStart(2, '0')}-${String(dDay).padStart(2, '0')}`,
    flowHour: h,
    hourBranch: `${branch}(${BRANCHES[branch]})`,
    dayStemBranch: `${lu.getDayGan()}${lu.getDayZhi()}`,
    ...(h === 23 ? { dayShiftFromLateZi: 1 } : {}),
    transforms: decorateTransforms(r.transforms, palaceOf),
  };
}

// ── ziwei_school_compare ────────────────────────────────────────────────────

function chartDigest(chart: ZiweiChart) {
  return {
    effectiveDate: `${chart.birthInfo.year}-${String(chart.birthInfo.month).padStart(2, '0')}-${String(chart.birthInfo.day).padStart(2, '0')}`,
    fourPillars: (chart.lunarInfo.fourPillars ?? []).join('/'),
    mingGongBranch: BRANCHES[chart.mingGongBranch],
    wuxingJu: chart.wuxingJuName,
    ziweiPos: BRANCHES[chart.ziweiPos],
    palaces: chart.palaces.map(p => ({
      name: p.name,
      branch: BRANCHES[p.branch],
      majors: p.stars.filter(s => s.type === 'major').map(s => s.name).sort(),
    })),
  };
}

function toolZiweiSchoolCompare(args: any): unknown {
  if (args === null || typeof args !== 'object') throw new ToolError('arguments must be an object');
  const year = assertInt(args.year, 'year', 1, 9999);
  const month = assertInt(args.month, 'month', 1, 12);
  const day = assertInt(args.day, 'day', 1, 31);
  const minute = args.minute === undefined ? 0 : assertInt(args.minute, 'minute', 0, 59);
  const gender = assertGender(args.gender);
  const hour = assertInt(args.hour, 'hour (clock)', 0, 23);
  if (args.longitude !== undefined && typeof args.longitude !== 'number') {
    throw new ToolError(`longitude must be a number; received ${JSON.stringify(args.longitude)}`);
  }

  // Only switches generateChart actually honours are compared (lateZishi ×
  // leapMonth). The other school-config knobs (brightness table, gengYearSihua,
  // …) are UI-layer options that do not change this engine's output.
  const variants: { id: string; lateZishi: 'next-day' | 'current-day'; leapMonth?: LunarMonthPolicy }[] = [
    { id: 'lateZishi=next-day (default)', lateZishi: 'next-day' },
    { id: 'lateZishi=current-day (倪师派)', lateZishi: 'current-day' },
    { id: 'leapMonth=split (default)', lateZishi: 'next-day', leapMonth: 'split' },
    { id: 'leapMonth=next-month (倪师派)', lateZishi: 'next-day', leapMonth: 'next-month' },
    { id: 'leapMonth=prev-month', lateZishi: 'next-day', leapMonth: 'prev-month' },
    { id: 'leapMonth=origin-month', lateZishi: 'next-day', leapMonth: 'origin-month' },
  ];

  const results: Record<string, unknown> = {};
  const baselineRb = resolveBirth({ year, month, day, hour, minute, gender, longitude: args.longitude, lateZishi: 'next-day' });
  const baseline = chartDigest(buildChart(baselineRb, { leapMonth: 'split' }));
  for (const v of variants) {
    const rb = resolveBirth({ year, month, day, hour, minute, gender, longitude: args.longitude, lateZishi: v.lateZishi });
    const digest = chartDigest(buildChart(rb, v.leapMonth ? { leapMonth: v.leapMonth } : undefined));
    const diffs: string[] = [];
    if (digest.effectiveDate !== baseline.effectiveDate) diffs.push(`effectiveDate ${baseline.effectiveDate} → ${digest.effectiveDate}`);
    if (digest.fourPillars !== baseline.fourPillars) diffs.push(`fourPillars ${baseline.fourPillars} → ${digest.fourPillars}`);
    if (digest.mingGongBranch !== baseline.mingGongBranch) diffs.push(`命宮 ${baseline.mingGongBranch} → ${digest.mingGongBranch}`);
    if (digest.wuxingJu !== baseline.wuxingJu) diffs.push(`五行局 ${baseline.wuxingJu} → ${digest.wuxingJu}`);
    if (digest.ziweiPos !== baseline.ziweiPos) diffs.push(`紫微 ${baseline.ziweiPos} → ${digest.ziweiPos}`);
    for (let i = 0; i < digest.palaces.length; i++) {
      const a = baseline.palaces[i], b = digest.palaces[i];
      if (a.branch !== b.branch) diffs.push(`宫${a.name}地支 ${a.branch}→${b.branch}`);
      else if (JSON.stringify(a.majors) !== JSON.stringify(b.majors)) diffs.push(`宫${b.name}主星 [${a.majors}] → [${b.majors}]`);
    }
    results[v.id] = { digest, diffFromDefault: diffs };
  }
  return {
    meta: { input: { year, month, day, clockHour: hour, clockMinute: minute, gender }, comparedVariants: variants.map(v => v.id), baseline: 'lateZishi=next-day + leapMonth=split (engine defaults)' },
    note: 'Only lateZishi and leapMonth change this engine\u2019s output; other school-config knobs are UI-layer only.',
    variants: results,
  };
}

// ── ziwei_render ────────────────────────────────────────────────────────────

const RENDER_COLORS = { 禄: '#1a9850', 权: '#3066be', 科: '#7b3296', 忌: '#d7301f' };

function xmlEscape(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]!));
}

function toolZiweiRender(args: any): unknown {
  if (args === null || typeof args !== 'object') throw new ToolError('arguments must be an object');
  const year = assertInt(args.year, 'year', 1, 9999);
  const month = assertInt(args.month, 'month', 1, 12);
  const day = assertInt(args.day, 'day', 1, 31);
  const minute = args.minute === undefined ? 0 : assertInt(args.minute, 'minute', 0, 59);
  const gender = assertGender(args.gender);
  const hour = assertInt(args.hour, 'hour (clock)', 0, 23);
  if (args.longitude !== undefined && typeof args.longitude !== 'number') {
    throw new ToolError(`longitude must be a number; received ${JSON.stringify(args.longitude)}`);
  }
  const rb = resolveBirth({ year, month, day, hour, minute, gender, longitude: args.longitude });
  const chart = buildChart(rb);

  // FEATURE C (2026-11-04): optional layer overlay ['liunian'] and/or ['daxian'].
  // Default (no layers) stays natal-only — byte-identical SVG for existing callers.
  const overlayLayers: string[] = args.layers === undefined ? [] : args.layers;
  if (!Array.isArray(overlayLayers) || overlayLayers.some(l => l !== 'liunian' && l !== 'daxian')) {
    throw new ToolError('layers must be an array of "liunian" | "daxian" (or omitted for natal-only)');
  }
  const flowYear = args.flowYear === undefined ? new Date().getFullYear() : assertInt(args.flowYear, 'flowYear', 1, 9999);
  const overlayColor = '#7a4dbf'; // second colour for flying-star overlays
  interface Overlay { label: string; stemIndex: number; byPalace: Record<string, { star: string; hua: string }[]> }
  const overlays: Overlay[] = [];
  if (overlayLayers.includes('liunian')) {
    const stemIndex = getYearStemIndex(flowYear);
    const th = getSiHuaByStem(stemIndex);
    const byPalace: Record<string, { star: string; hua: string }[]> = {};
    for (const k of SIHUA_KEYS) {
      const pal = starPalaceMap(chart)[th[k]];
      if (pal) (byPalace[pal] ??= []).push({ star: th[k], hua: k });
    }
    overlays.push({ label: `流年 ${flowYear} ${STEMS[stemIndex]}`, stemIndex, byPalace });
  }
  if (overlayLayers.includes('daxian')) {
    const idx = chart.currentDaXianIndex;
    const dxPal = idx >= 0 && idx < chart.daXians.length
      ? chart.palaces.find(p => p.branch === chart.daXians[idx].palaceBranch) : undefined;
    if (dxPal) {
      const th = getSiHuaByStem(dxPal.stem);
      const byPalace: Record<string, { star: string; hua: string }[]> = {};
      for (const k of SIHUA_KEYS) {
        const pal = starPalaceMap(chart)[th[k]];
        if (pal) (byPalace[pal] ??= []).push({ star: th[k], hua: k });
      }
      overlays.push({ label: `大限 ${BRANCHES[dxPal.branch]}${STEMS[dxPal.stem]}`, stemIndex: dxPal.stem, byPalace });
    }
  }

  // Grid layout: 600×600, 4×4 cells of 150 px, center meta block at (150,150) 300×300.
  // Branch → (col,row): 巳(0,0)午(1,0)未(2,0)申(3,0) / 辰(0,1) 酉(3,1) / 卯(0,2) 戌(3,2) / 寅(0,3)丑(1,3)子(2,3)亥(3,3).
  const cellPos: Record<number, [number, number]> = {
    5: [0, 0], 6: [1, 0], 7: [2, 0], 8: [3, 0],
    4: [0, 1], 9: [3, 1], 3: [0, 2], 10: [3, 2],
    2: [0, 3], 1: [1, 3], 0: [2, 3], 11: [3, 3],
  };
  const CELL = 150;
  const parts: string[] = [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 600" width="600" height="600" font-family="Noto Serif TC, Songti TC, serif">',
    '  <rect width="600" height="600" fill="#fffdf8"/>',
    '  <g stroke="#9a8f7d" stroke-width="1" fill="none"><rect x="0" y="0" width="600" height="600"/>',
    '    <line x1="150" y1="0" x2="150" y2="600"/><line x1="300" y1="0" x2="300" y2="600"/><line x1="450" y1="0" x2="450" y2="600"/>',
    '    <line x1="0" y1="150" x2="600" y2="150"/><line x1="0" y1="300" x2="600" y2="300"/><line x1="0" y1="450" x2="600" y2="450"/>',
    '  </g>',
  ];

  // center meta
  const fp = (chart.lunarInfo.fourPillars ?? []).join(' ');
  const lunarStr = `${chart.lunarInfo.lunarYear}-${Math.abs(chart.lunarInfo.lunarMonth)}-${chart.lunarInfo.lunarDay}${chart.lunarInfo.isLeapMonth ? '(闰)' : ''}`;
  const sihuaSummary = SIHUA_KEYS.map(k => {
    const star = (chart.palaces.flatMap(p => p.stars).find(s => s.siHua === k)?.name) ?? '?';
    const pal = star !== '?' ? (starPalaceMap(chart)[star] ?? '?') : '?';
    return `<tspan fill="${RENDER_COLORS[k]}">${k}→${xmlEscape(pal)}</tspan>`;
  }).join(' ');
  parts.push('  <g>');
  parts.push('    <rect x="150" y="150" width="300" height="300" fill="#faf7ef"/>');
  parts.push('    <text x="300" y="185" text-anchor="middle" font-size="15" font-weight="bold" fill="#1a1714">命盤基本資料</text>');
  parts.push(`    <text x="300" y="215" text-anchor="middle" font-size="12" fill="#3d3935">${gender === 'male' ? '男' : '女'} · ${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}</text>`);
  parts.push(`    <text x="300" y="240" text-anchor="middle" font-size="12" fill="#3d3935">四柱：${xmlEscape(fp)}</text>`);
  parts.push(`    <text x="300" y="262" text-anchor="middle" font-size="12" fill="#3d3935">農曆 ${xmlEscape(lunarStr)} ${BRANCHES[rb.hourBranch]}時</text>`);
  parts.push(`    <text x="300" y="286" text-anchor="middle" font-size="12" fill="#3d3935">五行局：${xmlEscape(chart.wuxingJuName)}</text>`);
  parts.push(`    <text x="300" y="310" text-anchor="middle" font-size="12" fill="#3d3935">命主 ${xmlEscape(chart.mingZhu ?? '?')} · 身主 ${xmlEscape(chart.shenZhu ?? '?')}</text>`);
  parts.push(`    <text x="300" y="334" text-anchor="middle" font-size="12" fill="#3d3935">紫微在${BRANCHES[chart.ziweiPos]}</text>`);
  parts.push(`    <text x="300" y="368" text-anchor="middle" font-size="11" fill="#8a8279">生年四化 ${sihuaSummary}</text>`);
  parts.push('  </g>');

  for (const p of chart.palaces) {
    const [cx, cy] = cellPos[p.branch];
    const x = cx * CELL, y = cy * CELL;
    const isMing = p.isMingGong;
    parts.push(`  <g transform="translate(${x},${y})">`);
    parts.push(isMing
      ? '    <rect width="150" height="150" fill="#fdf6e3" stroke="#c9a96e" stroke-width="3"/>'
      : '    <rect width="150" height="150" fill="#ffffff"/>');
    parts.push(`    <text x="8" y="20" font-size="14" font-weight="bold"${isMing ? ' fill="#b8864a"' : ''}>${xmlEscape(p.name)}${isMing ? ' ★' : ''}</text>`);
    parts.push(`    <text x="142" y="20" text-anchor="end" font-size="11" fill="#8a8279">${BRANCHES[p.branch]}${STEMS[p.stem]}</text>`);
    let ty = 45;
    const majors = p.stars.filter(s => s.type === 'major');
    if (majors.length === 0) {
      parts.push(`    <text x="8" y="${ty}" font-size="12">空宮${p.borrowedStars?.length ? '（借' + xmlEscape(p.borrowedStars.join('、')) + '）' : ''}</text>`);
      ty += 18;
    } else {
      for (const s of majors.slice(0, 4)) {
        const mark = s.siHua ? ` <tspan fill="${RENDER_COLORS[s.siHua]}">${s.siHua}</tspan>` : '';
        parts.push(`    <text x="8" y="${ty}" font-size="12">${xmlEscape(s.name)}（${s.brightnessRaw ?? ''}）${mark}</text>`);
        ty += 18;
      }
    }
    const others = p.stars.filter(s => s.type !== 'major' && s.type !== 'sha').slice(0, 3);
    for (const s of others) {
      const mark = s.siHua ? ` <tspan fill="${RENDER_COLORS[s.siHua]}">${s.siHua}</tspan>` : '';
      parts.push(`    <text x="8" y="${ty}" font-size="11" fill="#5a554f">${xmlEscape(s.name)}${mark}</text>`);
      ty += 16;
    }
    if (isMing && p.branch === chart.shenGongBranch) parts.push(`    <text x="8" y="${ty}" font-size="11" fill="#8a8279">命身同宮</text>`);
    // FEATURE C: dashed corner badge listing the overlay layer's flying stars
    // landing in this palace (only when overlays are requested).
    for (let oi = 0; oi < overlays.length; oi++) {
      const hits = overlays[oi].byPalace[p.name];
      if (hits && hits.length) {
        const bx = 150 - 8, by = 150 - 10 * (oi + 1);
        const txt = hits.map(h => `${h.hua}→${h.star}`).join(' ');
        parts.push(`    <g stroke="${overlayColor}" stroke-width="1" stroke-dasharray="3 2" fill="none"><rect x="${bx - 88}" y="${by - 11}" width="92" height="14"/></g>`);
        parts.push(`    <text x="${bx}" y="${by}" text-anchor="end" font-size="10" fill="${overlayColor}">${xmlEscape(txt)}</text>`);
      }
    }
    parts.push('  </g>');
  }
  if (overlays.length) {
    const legend = overlays.map(o => `${o.label}: ${SIHUA_KEYS.map(k => `${k}→${getSiHuaByStem(o.stemIndex)[k] ?? '?'}`).join(' ')}`).join(' ；  ');
    parts.push(`  <text x="300" y="595" text-anchor="middle" font-size="11" fill="${overlayColor}">${xmlEscape(legend)}</text>`);
  }
  parts.push('</svg>');
  return { svg: parts.join('\n'), meta: { effectiveDate: rb.effectiveDate, layout: '4x4 grid, center meta — copied from report SVG', overlays: overlays.map(o => o.label) } };
}

// ────────────────────────────────────────────────────────────────────────────
// Tool registry + schemas
// ────────────────────────────────────────────────────────────────────────────

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: unknown;
  /** May be sync or async (batch_stats spawns its compute child async). */
  handler: (args: any) => unknown | Promise<unknown>;
}

export const TOOLS: ToolDef[] = [
  {
    name: 'ziwei_chart',
    description:
      'Compute a deterministic Ziwei Doushu (紫微斗数) natal chart from solar birth data. ' +
      'Stateless: nothing is stored. hour is the local CLOCK hour 0-23; if longitude is given, ' +
      'true solar time (longitude + equation of time) corrects the 时辰 and day boundary first. ' +
      'Returns the full chart JSON (palaces, stars, siHua, daXians, fourPillars).',
    inputSchema: {
      type: 'object',
      properties: {
        year: { type: 'integer', description: 'Solar (Gregorian) birth year' },
        month: { type: 'integer', minimum: 1, maximum: 12 },
        day: { type: 'integer', minimum: 1, maximum: 31 },
        hour: { type: 'integer', minimum: 0, maximum: 23, description: 'Local clock hour (23 = late-zi, chart day advances)' },
        minute: { type: 'integer', minimum: 0, maximum: 59, default: 0 },
        gender: { type: 'string', enum: ['male', 'female'] },
        longitude: { type: 'number', description: 'Birthplace longitude (degrees East); enables true-solar-time correction' },
        latitude: { type: 'number', description: 'Accepted but inert (engine correction uses longitude + equation of time only)' },
        leapMonth: { type: 'string', enum: ['split', 'next-month', 'prev-month', 'origin-month'], default: 'split', description: '闰月 (leap month) assignment policy: split = 月中分界 (default, mainstream convention); next-month = 归下月 (倪师派); prev-month = 归上月; origin-month = 归本历年月' },
      },
      required: ['year', 'month', 'day', 'hour', 'minute', 'gender'],
      additionalProperties: false,
    },
    handler: toolZiweiChart,
  },
  {
    name: 'ziwei_patterns',
    description:
      'Detect 格局 (structural patterns) in a natal chart deterministically, with 命宮 context. '
      + 'Same birth params as ziwei_chart (incl. optional leapMonth policy). Runs the engine\'s '
      + 'pattern detectors: 41 general detectors PLUS the strict 《紫微斗数全书》卷一 tables '
      + '(定贵局 27 / 定富局 6 / 定贫贱局 8, each hit carries the original-book item number and '
      + '注文 as description/source). patterns[].strict distinguishes the two families. '
      + 'mingGong carries 命宮 main stars + nature + borrowed-from-opposite info for empty palaces. '
      + 'Stateless; deterministic; no LLM.',
    inputSchema: {
      type: 'object',
      properties: {
        year: { type: 'integer', description: 'Solar (Gregorian) birth year' },
        month: { type: 'integer', minimum: 1, maximum: 12 },
        day: { type: 'integer', minimum: 1, maximum: 31 },
        hour: { type: 'integer', minimum: 0, maximum: 23, description: 'Local clock hour (23 = late-zi, chart day advances)' },
        minute: { type: 'integer', minimum: 0, maximum: 59, default: 0 },
        gender: { type: 'string', enum: ['male', 'female'] },
        longitude: { type: 'number', description: 'Birthplace longitude (degrees East); enables true-solar-time correction' },
        latitude: { type: 'number', description: 'Accepted but inert (engine correction uses longitude + equation of time only)' },
        leapMonth: { type: 'string', enum: ['split', 'next-month', 'prev-month', 'origin-month'], default: 'split', description: '闰月 (leap month) assignment policy (see ziwei_chart)' },
      },
      required: ['year', 'month', 'day', 'hour', 'minute', 'gender'],
      additionalProperties: false,
    },
    handler: toolZiweiPatterns,
  },
  {
    name: 'ziwei_sihua_layers',
    description:
      'Compute 四化 (siHua) transform layers over a natal chart: daxian (大限, palace stem), '
      + 'liunian (流年, year stem), liuyue (流月, 五虎遁 month stem), liuri (流日, day stem) '
      + 'and/or liushi (流时, 五鼠遁 hour stem). Each transform star is mapped to the palace it '
      + 'lands in. Keys are Chinese: 禄/权/科/忌. Stateless. CAVEAT: below-month (day/hour) '
      + 'planning is unsupported by birth-time precision — liuri/liushi are informational only. '
      + 'FIX 2026-11-04: the liuyue 五虎遁 year stem now comes from the lichun-exact ganzhi year '
      + 'of the flow date (was: requested calendar year — wrong for pre-lichun dates); payloads '
      + 'echo yearStemUsed + ganzhiYear for audit. Optional yearWindow (ganzhi pair like "丙午") '
      + 'replaces `year` and eliminates the lichun trap entirely. '
      + 'FIX 2026-11-04 (2): flowDate also resolves the liuyue lunar month BY DAY — needed when a '
      + 'solar month straddles a leap-month boundary (e.g. 2023-04 = 闰二月 until 4/19, 三月 after). '
      + 'Month-only queries over such straddles return the LATER segment\u2019s stem with '
      + 'ambiguousMonth:true + note; give flowDate to pin the exact day. Liuyue months are LUNAR '
      + 'months (五虎遁 on lunarMonth; leap month uses base-month stem) — solar-term-convention '
      + 'users will diverge at month boundaries. '
      + 'NEW 2026-11-05: month-only liuyue payloads carry descriptive monthSpan (the ordered lunar '
      + 'months the solar month spans) + resolvedAs (the exact resolution, naming the sampled 15th); '
      + 'ambiguousMonth remains for backward compat but is effectively always-true on month-only '
      + 'paths — prefer monthSpan/resolvedAs, or supply flowDate for full precision.',
    inputSchema: {
      type: 'object',
      properties: {
        year: { type: 'integer', description: 'Gregorian year of the layer window (omit when yearWindow is given)' },
        yearWindow: { type: 'string', description: 'Optional ganzhi year pair (e.g. "丙午") instead of year — stem/branch taken directly from the pair, no lichun ambiguity' },
        gender: { type: 'string', enum: ['male', 'female'] },
        birth: {
          type: 'object',
          properties: {
            year: { type: 'integer' }, month: { type: 'integer' }, day: { type: 'integer' },
            hour: { type: 'integer', description: 'clock hour 0-23' }, minute: { type: 'integer' },
            longitude: { type: 'number' },
          },
          required: ['year', 'month', 'day', 'hour', 'minute'],
          additionalProperties: false,
        },
        layers: { type: 'array', items: { type: 'string', enum: ['daxian', 'liunian', 'liuyue', 'liuri', 'liushi'] }, minItems: 1 },
        month: { type: 'integer', minimum: 1, maximum: 12, description: 'Solar month for liuyue (converted internally to the lunar month)' },
        lunarMonth: { type: 'integer', minimum: 1, maximum: 12, description: 'Direct lunar month for liuyue (alternative to month). The lichun-exact year stem is resolved from the SOLAR date of this lunar month\'s 15th, anchored to the lunar month whose mid-point falls within `year` (1900-2050 tables).' },
        isLeapMonth: { type: 'boolean', default: false, description: 'True only when lunarMonth names the leap month of `year` (e.g. lunarMonth:2 + isLeapMonth:true for 2023 闰二月). isError when the year has no such leap month.' },
        flowDate: { type: 'object', properties: { year: { type: 'integer' }, month: { type: 'integer' }, day: { type: 'integer' } }, required: ['year', 'month', 'day'], additionalProperties: false, description: 'Solar date of the queried moment (required for liuri/liushi; optional for liuyue — resolves the lunar month by day, pinning leap-month straddles)' },
        flowHour: { type: 'integer', minimum: 0, maximum: 23, description: 'Clock hour of the queried moment (required for liushi)' },
      },
      required: ['gender', 'birth', 'layers'],
      additionalProperties: false,
    },
    handler: toolZiweiSihuaLayers,
  },
  {
    name: 'ziwei_from_city',
    description:
      'Natal chart from birth data with a city name instead of longitude. The city is '
      + 'resolved against the vendored cities.ts table (case-insensitive; Chinese names or '
      + 'common English/romanized names, e.g. "Hong Kong" / "香港" / "广州"). An explicit '
      + 'longitude overrides the city lookup when both are given. Unknown city -> isError '
      + 'with suggestion examples. Internally identical to ziwei_chart with the resolved '
      + 'longitude (true-solar correction included).',
    inputSchema: {
      type: 'object',
      properties: {
        year: { type: 'integer' }, month: { type: 'integer', minimum: 1, maximum: 12 },
        day: { type: 'integer', minimum: 1, maximum: 31 },
        hour: { type: 'integer', minimum: 0, maximum: 23 }, minute: { type: 'integer', minimum: 0, maximum: 59, default: 0 },
        gender: { type: 'string', enum: ['male', 'female'] },
        city: { type: 'string', description: 'Birth city (Chinese or common English name); resolved to longitude via cities.ts' },
        longitude: { type: 'number', description: 'Overrides city lookup when given' },
      },
      required: ['year', 'month', 'day', 'hour', 'minute', 'gender'],
      additionalProperties: false,
    },
    handler: toolZiweiFromCity,
  },
  {
    name: 'ziwei_solar_lunar',
    description:
      'Bidirectional solar<->lunar calendar conversion with four-pillars (八字) for the '
      + 'resulting date. Give exactly one of {solar:{year,month,day}} or '
      + '{lunar:{year,month,isLeap?,day}}. Leap months flagged, never silently shifted. '
      + 'BOTH directions bounded to 1900-2050 (2026-11-05): the lunar-javascript '
      + 'tables are unreliable outside that range, so out-of-range years now '
      + 'return isError instead of plausible-but-wrong dates. Uses lunar-solar.ts '
      + '/ lunar-javascript (same conventions as the chart engine).',
    inputSchema: {
      type: 'object',
      properties: {
        solar: { type: 'object', properties: { year: { type: 'integer', minimum: 1900, maximum: 2050 }, month: { type: 'integer' }, day: { type: 'integer' } }, required: ['year', 'month', 'day'], additionalProperties: false },
        lunar: { type: 'object', properties: { year: { type: 'integer', minimum: 1900, maximum: 2050 }, month: { type: 'integer' }, isLeap: { type: 'boolean', default: false }, day: { type: 'integer' } }, required: ['year', 'month', 'day'], additionalProperties: false },
      },
      additionalProperties: false,
    },
    handler: toolZiweiSolarLunar,
  },
  {
    name: 'ziwei_selftest',
    description:
      'Run the built-in gold-standard regression self-test (synthetic anchor birth 1986-12-08 23:45 male lon 114.2): '
      + 'effectiveDate, fourPillars, 命宮 branch + 天同(旺), 土五局, 命主/身主, true-solar clock '
      + '23:29:34, liuyue lichun-boundary stems, plus pattern-detection anchors (gold-chart '
      + 'detected-pattern list, a 四化-bonus negative control, and two strict 《全书》卷一 table '
      + 'fixtures). Deterministic, no arguments, no external calls. Returns '
      + '{pass, checks:[{name,expected,actual,ok}]}.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: toolZiweiSelftest,
  },
  {
    name: 'ziwei_compatibility',
    description:
      '合盤 two-person comparison using the vendored heming-knowledge.ts (倪海厦 + 《紫微斗数全书》). '
      + 'Give two births a/b {year,month,day,hour,minute,gender,longitude?}. Returns per-dimension '
      + 'findings: 命宮/夫妻/福德 star sets for both sides, 天作之合 mirror test, 四化飞化互参 '
      + '(incl. 化忌-into-partner flags), 太阳/太阴 states, 命格速配 pair-table hits, 夫妻宫 knowledge '
      + 'quotes. NO invented score — only the knowledge module\u2019s own criteria are cited.',
    inputSchema: {
      type: 'object',
      properties: {
        a: {
          type: 'object',
          properties: {
            year: { type: 'integer' }, month: { type: 'integer' }, day: { type: 'integer' },
            hour: { type: 'integer', description: 'clock hour 0-23' }, minute: { type: 'integer' },
            gender: { type: 'string', enum: ['male', 'female'] }, longitude: { type: 'number' },
          },
          required: ['year', 'month', 'day', 'hour', 'gender'],
          additionalProperties: false,
        },
        b: {
          type: 'object',
          properties: {
            year: { type: 'integer' }, month: { type: 'integer' }, day: { type: 'integer' },
            hour: { type: 'integer', description: 'clock hour 0-23' }, minute: { type: 'integer' },
            gender: { type: 'string', enum: ['male', 'female'] }, longitude: { type: 'number' },
          },
          required: ['year', 'month', 'day', 'hour', 'gender'],
          additionalProperties: false,
        },
      },
      required: ['a', 'b'],
      additionalProperties: false,
    },
    handler: toolZiweiCompatibility,
  },
  {
    name: 'ziwei_batch_stats',
    description:
      'Corpus-level deterministic statistics over enumerated charts. question: '
      + 'main-star-in-mingGong-distribution | sihua-palace-distribution | wuxingJu-distribution. '
      + 'Sampling rule: DETERMINISTIC day×hour enumeration of every (day, hour-branch) slot in '
      + 'yearFrom..yearTo (default 1950-2000, ALL 12 hour branches per day — hours:"all" default; '
      + 'or pass an explicit branch array / legacy hourBranch), thinned by an integer stride over '
      + 'the day×hour slot space to stay under maxCharts (~5000 default). NO random sampling — '
      + 'fully reproducible. NOT population-representative: uniform dates, no birth-rate weighting '
      + '— treat counts as a calendar-space census, not a demographic sample. Default cap keeps '
      + 'runtime <60 s (full 1950-2000 × 12 hours would be ~2.5 min uncapped — exceeds the 120 s '
      + 'subprocess limit, so the stride cap is part of the contract).',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', enum: ['main-star-in-mingGong-distribution', 'sihua-palace-distribution', 'wuxingJu-distribution'] },
        yearFrom: { type: 'integer', minimum: 1901, maximum: 2050, default: 1950 },
        yearTo: { type: 'integer', minimum: 1901, maximum: 2050, default: 2000 },
        gender: { type: 'string', enum: ['male', 'female'] },
        hours: {
          description: 'Hour-branch census: "all" (default — all 12 branches 0..11 per day) or an array of branches, e.g. [6] for the legacy noon-only behaviour.',
          oneOf: [{ type: 'string', enum: ['all'] }, { type: 'array', items: { type: 'integer', minimum: 0, maximum: 11 }, minItems: 1 }],
        },
        hourBranch: { type: 'integer', minimum: 0, maximum: 11, description: 'LEGACY: single fixed branch (equivalent to hours:[n]). Ignored when `hours` is given.' },
        maxCharts: { type: 'integer', minimum: 100, maximum: 20000, default: 5000 },
      },
      required: ['question', 'gender'],
      additionalProperties: false,
    },
    handler: toolZiweiBatchStats,
  },
  {
    name: 'ziwei_school_compare',
    description:
      'Run one birth under each convention available to this engine (lateZishi next-day vs '
      + 'current-day; leapMonth split/next-month/prev-month/origin-month) and return per-variant '
      + 'chart digests + diff summaries (which fields changed: effectiveDate, fourPillars, 命宮, '
      + 'palace stars...). Note: other school-config knobs (brightness table etc.) do not change '
      + 'this engine\u2019s output and are not compared.',
    inputSchema: {
      type: 'object',
      properties: {
        year: { type: 'integer' }, month: { type: 'integer', minimum: 1, maximum: 12 },
        day: { type: 'integer', minimum: 1, maximum: 31 },
        hour: { type: 'integer', minimum: 0, maximum: 23 }, minute: { type: 'integer', minimum: 0, maximum: 59, default: 0 },
        gender: { type: 'string', enum: ['male', 'female'] },
        longitude: { type: 'number' },
      },
      required: ['year', 'month', 'day', 'hour', 'minute', 'gender'],
      additionalProperties: false,
    },
    handler: toolZiweiSchoolCompare,
  },
  {
    name: 'ziwei_render',
    description:
      'Render a natal chart as a pure-string 12-palace SVG grid (4x4 with center meta block, '
      + 'palaces labeled with main stars + brightness + color-coded 生年四化 marks), matching the '
      + 'layout of our report SVGs. No image libraries, no rasterization — returns {svg, meta}. '
      + 'Optional layers:["liunian"] and/or ["daxian"] overlay that layer\u2019s flying stars '
      + '(dashed corner badge + legend line, second colour); default stays natal-only.',
    inputSchema: {
      type: 'object',
      properties: {
        year: { type: 'integer' }, month: { type: 'integer', minimum: 1, maximum: 12 },
        day: { type: 'integer', minimum: 1, maximum: 31 },
        hour: { type: 'integer', minimum: 0, maximum: 23 }, minute: { type: 'integer', minimum: 0, maximum: 59, default: 0 },
        gender: { type: 'string', enum: ['male', 'female'] },
        longitude: { type: 'number' },
        layers: { type: 'array', items: { type: 'string', enum: ['liunian', 'daxian'] }, description: 'Optional flow-layer overlays onto the natal grid (default: none = natal-only)' },
        flowYear: { type: 'integer', minimum: 1, maximum: 9999, description: 'Gregorian year for the liunian overlay (default: current year)' },
      },
      required: ['year', 'month', 'day', 'hour', 'minute', 'gender'],
      additionalProperties: false,
    },
    handler: toolZiweiRender,
  },
];

/** Projection for tools/list (no handler leakage). */
export function listTools(): Array<{ name: string; description: string; inputSchema: unknown }> {
  return TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
}

// ────────────────────────────────────────────────────────────────────────────
// Transport-agnostic JSON-RPC 2.0 dispatcher
// ────────────────────────────────────────────────────────────────────────────

export interface RpcMessage { jsonrpc?: string; id?: number | string | null; method?: string; params?: any }

/**
 * Handle ONE JSON-RPC message, return the response messages to emit
 * (empty array for notifications — same semantics as the Phase-1 `handle`).
 * Never throws on protocol-level problems; tool errors come back as
 * result.isError payloads so the transport survives.
 */
export async function dispatch(
  req: RpcMessage,
  opts: { serverVersion?: string } = {},
): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  const emit = (msg: Record<string, unknown>) => out.push(msg);
  const sendResult = (id: number | string, result: unknown) => emit({ jsonrpc: '2.0', id, result });
  const sendError = (id: number | string | null, code: number, message: string, data?: unknown) =>
    emit({ jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data !== undefined ? { data } : {}) } });

  const id = typeof req.id === 'number' || typeof req.id === 'string' ? req.id : null;
  const isRequest = id !== null;
  const method = req.method;

  if (method === 'initialize') {
    const requested = typeof req.params?.protocolVersion === 'string' ? req.params.protocolVersion : DEFAULT_PROTOCOL;
    sendResult(id ?? 0, {
      protocolVersion: requested,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: opts.serverVersion ?? SERVER_VERSION },
    });
    return out;
  }

  if (method === 'notifications/initialized' || method === 'initialized' || method === 'notifications/cancelled') {
    return out; // notifications: no response
  }

  if (method === 'ping') {
    if (isRequest) sendResult(id as number | string, {});
    return out;
  }

  if (method === 'tools/list') {
    sendResult(id as number | string, { tools: listTools() });
    return out;
  }

  if (method === 'tools/call') {
    const name = req.params?.name;
    const tool = TOOLS.find(t => t.name === name);
    if (!tool) {
      sendError(id, -32602, `unknown tool: ${JSON.stringify(name)}`);
      return out;
    }
    // DEEP FIX 2026-11-05 (5a): additionalProperties:false is DECLARED but not
    // enforced by design — hard-rejecting would break existing clients that
    // echo extra keys. Middle ground: unknown top-level args are still
    // ignored, but echoed as meta.ignoredKeys so silent-typo ambiguity dies.
    const callArgs = req.params?.arguments;
    const props = (tool.inputSchema as any)?.properties as Record<string, unknown> | undefined;
    let ignoredKeys: string[] | undefined;
    if (callArgs !== null && typeof callArgs === 'object' && !Array.isArray(callArgs) && props) {
      const extra = Object.keys(callArgs).filter(k => !(k in props)).sort();
      if (extra.length > 0) ignoredKeys = extra;
    }
    try {
      const result = await tool.handler(callArgs);
      if (ignoredKeys && result && typeof result === 'object' && !Array.isArray(result)) {
        const r = result as Record<string, unknown>;
        if (r.meta && typeof r.meta === 'object' && r.meta !== null) {
          (r.meta as Record<string, unknown>).ignoredKeys = ignoredKeys;
          (r.meta as Record<string, unknown>).ignoredKeysNote = 'unknown arguments ignored (schema declares additionalProperties:false; kept permissive for client compatibility)';
        }
      }
      sendResult(id as number | string, {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      });
    } catch (e: any) {
      const message = e instanceof ToolError ? e.message : `internal error: ${e?.stack ?? e}`;
      process.stderr.write(`[ziwei-mcp] tools/call ${name} failed: ${e?.message ?? e}\n`);
      sendResult(id as number | string, {
        content: [{ type: 'text', text: message }],
        isError: true,
      });
    }
    return out;
  }

  if (method === 'prompts/list' || method === 'resources/list' || method === 'resources/templates/list') {
    if (isRequest) sendResult(id as number | string, method.endsWith('list') ? (method === 'prompts/list' ? { prompts: [] } : method === 'resources/list' ? { resources: [] } : { resourceTemplates: [] }) : {});
    return out;
  }

  if (isRequest) {
    sendError(id, -32601, `method not found: ${String(method)}`);
  } else {
    process.stderr.write(`[ziwei-mcp] ignoring unknown notification: ${String(method)}\n`);
  }
  return out;
}
