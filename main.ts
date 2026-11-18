// Implied Radar — token-radar-01
//
// A deterministic pre-token valuation radar. It reads one sealed DefiLlama
// snapshot, fits a robust sublinear log-log value model to the traded comps
// in that snapshot, ranks every eligible protocol that records no token by
// its conditional implied value, and writes the board, the dashboard data,
// the dossier and the screenshots through.
//
// Method, in one paragraph: eligible traded comps are fitted with an
// iteratively-reweighted Huber regression in log10(market cap) on a shrunk
// piecewise-linear TVL elasticity ladder, plus only those extra features
// (tracking tenure, 7-day growth, chain breadth) that improve BOTH
// leave-one-out and chronological out-of-sample error, plus Empirical-Bayes
// shrunken category offsets selected by cross-validation under a
// one-standard-error rule. A comp-anchored extrapolation cap bounds the top
// of the board. Uncertainty comes from stratified split-conformal bands over
// leave-one-out residuals, with per-row rank intervals. Farm economics use
// only disclosed assumptions (deposit, drop share, dilution, gas scenarios,
// opportunity cost, hold horizon) and break-even hurdles; a row is
// Research-only whenever the snapshot itself lacks the evidence to support
// an economic verdict. No launch probability is estimated anywhere: the
// snapshot carries no issuance outcomes, so the rank is a conditional
// implied value only. Every fitted number is measured from the snapshot in
// this run; nothing is copied from any review or specification.
//
// Determinism: no random numbers, no wall-clock reads, no network. The
// snapshot's as_of is the only date. Two runs write identical bytes.
//
// Node 22, standard library only. Run:
//   MAKEFUN_OUTPUT_DIR=out node main.ts --input path/to/snapshot.json
// Without --input it reads /input/snapshot.json; without
// MAKEFUN_OUTPUT_DIR it writes to ./out.

import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-board.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_DEFAULT = '/input/snapshot.json';
const OUTPUT_DEFAULT = './out';

// ------------------------------------------------------------------ types

interface Protocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Protocol[];
  watchlist: string[];
}

type Bucket =
  | 'hold' | 'watch' | 'below' | 'aboveNonWatch' | 'setCat' | 'setName'
  | 'refFit' | 'refOther';

interface Classified {
  p: Protocol;
  bucket: Bucket;
  reasons: string[];
  primary: string | null;
}

interface CompRow {
  p: Protocol;
  x: number; // log10(tvl / 50_000_000)
  y: number; // log10(mcap)
  days: number | null; // tracking tenure in days vs as_of
  grow: number | null; // change_7d
  nChains: number;
  cat: string | null;
  stratum: number; // conformal stratum 1..3
}

interface BoardRow {
  slug: string;
  name: string;
  rank: number;
  implied_value_usd: number;
  p25_usd: number;
  p75_usd: number;
  p10_usd: number;
  p90_usd: number;
  rank_best: number;
  rank_worst: number;
  tvl_usd: number;
  change_7d: number | null;
  category: string | null;
  chains: string[];
  days: number | null;
  watchlist: boolean;
  extrapolated: boolean;
  peer_token_rate: number;
  verdict: string;
  net_p50: number;
  net_p25: number;
  net_per_hour: number;
  p_be: number;
  alpha_be: number;
  fdv_breakeven: number;
  farm_steps: string[];
  step_hash: string;
}

// ------------------------------------------------------------------ utils

function log10(x: number): number { return Math.log10(x); }
function clamp(x: number, lo: number, hi: number): number { return x < lo ? lo : x > hi ? hi : x; }
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return NaN;
  return n % 2 === 1 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2;
}
function mean(xs: number[]): number { return xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length); }
function std(xs: number[]): number {
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((v) => (v - m) * (v - m))));
}
// Linear-interpolation quantile of a sorted array.
function quantileSorted(s: number[], p: number): number {
  const n = s.length;
  if (n === 0) return NaN;
  if (n === 1) return s[0]!;
  const pos = (n - 1) * clamp(p, 0, 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}
// Finite-sample conformal order-statistic quantile (split-conformal).
function conformalQuantile(sortedAsc: number[], p: number): number {
  const n = sortedAsc.length;
  if (n === 0) return NaN;
  const k = clamp(Math.ceil((n + 1) * p) - 1, 0, n - 1);
  return sortedAsc[k]!;
}
function fmtInt(n: number): string {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
function fmtUsd(n: number): string { return '$' + fmtInt(n); }
function fmtMoney(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  if (a >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
  return '$' + n.toFixed(0);
}
function fmtPct(x: number, digits = 1): string { return (x * 100).toFixed(digits) + '%'; }
function sha256Hex(s: string): string { return createHash('sha256').update(s, 'utf8').digest('hex'); }
// Short deterministic digest of the six farm steps (recompute proof).
function stepHash(steps: string[]): string {
  let h1 = 0x811c9dc5;
  const s = steps.join('\n');
  for (let i = 0; i < s.length; i++) {
    h1 ^= s.charCodeAt(i);
    h1 = Math.imul(h1, 0x01000193) >>> 0;
  }
  return ('0000000' + h1.toString(16)).slice(-8);
}
function parseArgs(argv: string[]): { input: string; output: string } {
  let input = SNAPSHOT_DEFAULT;
  let output = process.env.MAKEFUN_OUTPUT_DIR ?? OUTPUT_DEFAULT;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--input' && i + 1 < argv.length) input = argv[++i]!;
    else if (argv[i] === '--output' && i + 1 < argv.length) output = argv[++i]!;
  }
  return { input, output };
}
function daysBetween(a: string, b: string): number {
  // Whole days from date a (YYYY-MM-DD) to date b, UTC, no wall clock.
  const pa = a.split('-').map(Number);
  const pb = b.split('-').map(Number);
  const ta = Date.UTC(pa[0]!, pa[1]! - 1, pa[2]!);
  const tb = Date.UTC(pb[0]!, pb[1]! - 1, pb[2]!);
  return Math.round((tb - ta) / 86400000);
}

// ------------------------------------------------------------------ census

const EXCLUDED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);
const VERSION_RE = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const DERIVATIVE_RE = /\b(wrapped|staked|staking)\b/i;
const EXCHANGE_NAMES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];
const EXCHANGE_RE = new RegExp('^(' + EXCHANGE_NAMES.join('|') + ')\\b');

function hasToken(p: Protocol): boolean {
  return (p.mcap_usd !== null && p.mcap_usd > 0) || p.gecko_id !== null || p.symbol !== null;
}
function recordsNoToken(p: Protocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}
// Primary exclusion reason, in the kit's order. Null when the screen passes.
function exclusionReason(p: Protocol): string | null {
  if (EXCLUDED_CATEGORIES.has(p.category ?? '')) return 'category';
  if (VERSION_RE.test(p.name)) return 'version';
  if (DERIVATIVE_RE.test(p.name)) return 'derivative';
  if (EXCHANGE_RE.test(p.name)) return 'exchange';
  return null;
}
function allExclusionReasons(p: Protocol): string[] {
  const r: string[] = [];
  if (EXCLUDED_CATEGORIES.has(p.category ?? '')) r.push('category:' + String(p.category));
  if (VERSION_RE.test(p.name)) r.push('version-suffix');
  if (DERIVATIVE_RE.test(p.name)) r.push('derivative-word');
  if (EXCHANGE_RE.test(p.name)) r.push('exchange-prefix');
  return r;
}

function classifyAll(snap: Snapshot): { rows: Classified[]; counts: Record<Bucket, number>; refOtherWhy: Record<string, number> } {
  const rows: Classified[] = [];
  const counts: Record<Bucket, number> = { hold: 0, watch: 0, below: 0, aboveNonWatch: 0, setCat: 0, setName: 0, refFit: 0, refOther: 0 };
  const refOtherWhy: Record<string, number> = {};
  const watchSet = new Set(snap.watchlist);
  for (const p of snap.protocols) {
    let c: Classified;
    if (p.tvl_usd === null || !(p.tvl_usd > 0) || (p.listed_at !== null && Number.isNaN(Date.parse(p.listed_at)))) {
      const reasons: string[] = [];
      if (p.tvl_usd === null || !(p.tvl_usd > 0)) reasons.push('invalid-tvl');
      if (p.listed_at !== null && Number.isNaN(Date.parse(p.listed_at))) reasons.push('unparseable-listed_at');
      c = { p, bucket: 'hold', reasons, primary: 'data-quality' };
    } else if (recordsNoToken(p)) {
      const r = exclusionReason(p);
      const reasons = allExclusionReasons(p);
      if (r === 'category') c = { p, bucket: 'setCat', reasons, primary: r };
      else if (r !== null) c = { p, bucket: 'setName', reasons, primary: r };
      else if (p.tvl_usd >= snap.floor_usd && watchSet.has(p.slug)) c = { p, bucket: 'watch', reasons: [], primary: null };
      else if (p.tvl_usd >= snap.floor_usd) c = { p, bucket: 'aboveNonWatch', reasons: ['not-on-supplied-watchlist'], primary: 'not-on-supplied-watchlist' };
      else c = { p, bucket: 'below', reasons: [], primary: null };
    } else {
      // Recorded token (or a partial record): reference side, never the board.
      const r = exclusionReason(p);
      let why: string;
      if (p.mcap_usd === null || p.mcap_usd === 0) why = 'missing-mcap';
      else if (r !== null) why = 'excluded-' + r;
      else {
        const ratio = p.mcap_usd / p.tvl_usd;
        why = (p.mcap_usd < 100000 || ratio < 0.005 || ratio > 500) ? 'dust' : 'fit';
      }
      if (why === 'fit') {
        c = { p, bucket: 'refFit', reasons: [], primary: null };
      } else {
        refOtherWhy[why] = (refOtherWhy[why] ?? 0) + 1;
        c = { p, bucket: 'refOther', reasons: [why], primary: why };
      }
    }
    counts[c.bucket]++;
    rows.push(c);
  }
  return { rows, counts, refOtherWhy };
}

// ------------------------------------------------------------------ linear algebra

// Solve A x = b by Gaussian elimination with partial pivoting. A is square.
function solveLinear(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r]![col]!) > Math.abs(M[piv]![col]!)) piv = r;
    const tmp = M[col]!; M[col] = M[piv]!; M[piv] = tmp;
    const d = M[col]![col]!;
    if (Math.abs(d) < 1e-14) M[col]![col] = 1e-14;
    for (let r = col + 1; r < n; r++) {
      const f = M[r]![col]! / M[col]![col]!;
      for (let k = col; k <= n; k++) M[r]![k] = M[r]![k]! - f * M[col]![k]!;
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = M[i]![n]!;
    for (let j = i + 1; j < n; j++) s -= M[i]![j]! * x[j]!;
    x[i] = s / M[i]![i]!;
  }
  return x;
}

// Weighted least squares with a small ridge on non-intercept slopes.
function wls(X: number[][], y: number[], w: number[]): number[] {
  const p = X[0]!.length;
  const A: number[][] = Array.from({ length: p }, () => new Array<number>(p).fill(0));
  const b = new Array<number>(p).fill(0);
  for (let i = 0; i < X.length; i++) {
    const wi = w[i]!;
    for (let a = 0; a < p; a++) {
      b[a] = b[a]! + wi * X[i]![a]! * y[i]!;
      for (let c = 0; c < p; c++) A[a]![c] = A[a]![c]! + wi * X[i]![a]! * X[i]![c]!;
    }
  }
  for (let a = 1; a < p; a++) A[a]![a] = A[a]![a]! + 1e-6;
  return solveLinear(A, b);
}

// Iteratively reweighted least squares, Huber weights, tuning constant 1.345
// times the robustly scaled residual MAD. Deterministic, no randomness.
function huberFit(X: number[][], y: number[]): { beta: number[]; weights: number[]; iters: number; converged: boolean } {
  let beta = wls(X, y, X.map(() => 1));
  let weights = X.map(() => 1);
  let converged = false;
  let iters = 0;
  for (let it = 0; it < 25; it++) {
    iters = it + 1;
    const r = X.map((row, i) => y[i]! - row.reduce((s, v, j) => s + v * beta[j]!, 0));
    const med = median(r);
    const mad = median(r.map((v) => Math.abs(v - med)));
    let s = 1.4826 * mad;
    if (!(s > 0) || !Number.isFinite(s)) s = 1e-12;
    const c = 1.345 * s;
    weights = r.map((v) => (Math.abs(v) <= c ? 1 : c / Math.abs(v)));
    const next = wls(X, y, weights);
    let delta = 0;
    for (let j = 0; j < beta.length; j++) delta = Math.max(delta, Math.abs(next[j]! - beta[j]!));
    beta = next;
    if (delta < 1e-9) { converged = true; break; }
  }
  return { beta, weights, iters, converged };
}

function multErr(pred: number, actual: number): number {
  return Math.max(pred / actual, actual / pred);
}
function medianMultErr(preds: number[], actuals: number[]): number {
  return median(preds.map((p, i) => multErr(p, actuals[i]!)));
}

// Deterministic 5-fold assignment: comps sorted by log10(tvl) then slug,
// folds by index modulo 5. No RNG anywhere.
function foldOf(i: number): number { return i % 5; }
function sortedComps(comps: CompRow[]): CompRow[] {
  return [...comps].sort((a, b) => (a.x - b.x) || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
}

// ------------------------------------------------------------------ features

interface FeatureCenters { ageMed: number; chainMed: number; growLo: number; growHi: number; }

function computeCenters(comps: CompRow[]): FeatureCenters {
  const ages = comps.filter((c) => c.days !== null).map((c) => Math.log1p(Math.min(c.days!, 1825) / 180));
  const chains = comps.map((c) => Math.log1p(Math.min(c.nChains, 10) - 1));
  const grows = comps.filter((c) => c.grow !== null).map((c) => c.grow!);
  const sorted = [...grows].sort((a, b) => a - b);
  const p025 = grows.length ? quantileSorted(sorted, 0.025) : -50;
  const p975 = grows.length ? quantileSorted(sorted, 0.975) : 150;
  return {
    ageMed: ages.length ? median(ages) : 0,
    chainMed: chains.length ? median(chains) : 0,
    growLo: Math.max(-50, p025),
    growHi: Math.min(150, p975),
  };
}

function featureRow(c: CompRow, centers: FeatureCenters, feats: string[]): number[] {
  const out: number[] = [];
  for (const f of feats) {
    if (f === 'age') {
      const v = c.days === null ? 0 : Math.log1p(Math.min(c.days, 1825) / 180) - centers.ageMed;
      out.push(v);
    } else if (f === 'grow') {
      const g = c.grow === null ? 0 : clamp(c.grow, centers.growLo, centers.growHi);
      out.push(c.grow === null ? 0 : Math.tanh(g / 40));
    } else if (f === 'chain') {
      out.push(Math.log1p(Math.min(c.nChains, 10) - 1) - centers.chainMed);
    }
  }
  return out;
}

// Feature coefficient bounds (spec D4/D6): |beta_grow| <= log10(1.25),
// beta_chain >= 0 and |beta_chain * max_range| <= log10(1.25).
function boundCoefs(feats: string[], coefs: number[]): number[] {
  const out = [...coefs];
  const cap = log10(1.25);
  for (let i = 0; i < feats.length; i++) {
    if (feats[i] === 'grow') out[i] = clamp(out[i]!, -cap, cap);
    if (feats[i] === 'chain') out[i] = clamp(out[i]!, 0, cap / Math.log1p(9));
  }
  return out;
}

// ------------------------------------------------------------------ ladder model

interface LadderModel {
  knots: [number, number];
  slopes: [number, number, number];
  lambda: number;
  bBar: number;
  intercept: number;
  featCoefs: number[];
  feats: string[];
  centers: FeatureCenters;
  predictLog: (c: CompRow) => number;
}

function ladderValue(x: number, knots: [number, number], slopes: [number, number, number]): number {
  // Equal slopes: the single-slope model, computed as one product so the
  // page, the program and the self-test agree bit for bit.
  if (slopes[0] === slopes[1] && slopes[1] === slopes[2]) return slopes[0] * x;
  const [k1, k2] = knots;
  if (x <= k1) return slopes[0] * x;
  if (x <= k2) return slopes[0] * k1 + slopes[1] * (x - k1);
  return slopes[0] * k1 + slopes[1] * (k2 - k1) + slopes[2] * (x - k2);
}

function tercileKnots(xs: number[]): [number, number] {
  const s = [...xs].sort((a, b) => a - b);
  return [quantileSorted(s, 1 / 3), quantileSorted(s, 2 / 3)];
}

// Fit the ladder (two-stage: full ladder fit, shrink toward the single
// slope, refit intercept + features on the shrunk ladder as an offset).
function fitLadder(comps: CompRow[], feats: string[], lambda: number): LadderModel {
  const centers = computeCenters(comps);
  const knots = tercileKnots(comps.map((c) => c.x));
  const [k1, k2] = knots;
  const buildX = (withLadder: boolean, lad?: (x: number) => number): number[][] =>
    comps.map((c) => {
      const row: number[] = [1];
      if (withLadder) {
        row.push(c.x, Math.max(0, c.x - k1), Math.max(0, c.x - k2));
      } else if (lad) {
        row.push(lad(c.x));
      }
      row.push(...featureRow(c, centers, feats));
      return row;
    });
  const y = comps.map((c) => c.y);
  // Stage A: full ladder + features.
  const fitA = huberFit(buildX(true), y);
  const b1 = fitA.beta[1]!;
  const s1 = b1;
  const s2 = b1 + fitA.beta[2]!;
  const s3 = b1 + fitA.beta[2]! + fitA.beta[3]!;
  // Stage B: single slope + features.
  const fitB = huberFit(comps.map((c) => [1, c.x, ...featureRow(c, centers, feats)]), y);
  const bBar = fitB.beta[1]!;
  // Shrink segment slopes toward the single slope; drop lambda one grid
  // step when a shrunk slope leaves [0.1, 1.5]; clamp only at lambda 0.
  let lam = lambda;
  let slopes: [number, number, number] = [s1, s2, s3];
  for (;;) {
    slopes = [
      lam * s1 + (1 - lam) * bBar,
      lam * s2 + (1 - lam) * bBar,
      lam * s3 + (1 - lam) * bBar,
    ];
    if (slopes.every((s) => s >= 0.1 && s <= 1.5)) break;
    if (lam <= 0) {
      slopes = slopes.map((s) => clamp(s, 0.1, 1.5)) as [number, number, number];
      break;
    }
    lam = Math.max(0, lam - 0.25);
  }
  const lad = (x: number): number => ladderValue(x, knots, slopes);
  // lambda 0 reproduces the single-slope model EXACTLY: use the joint
  // Huber fit (intercept + slope together), never a refitted intercept,
  // so the ladder procedure cannot lose to the bare power law.
  if (lam === 0) {
    const featCoefs0 = boundCoefs(feats, fitB.beta.slice(2));
    const intercept0 = fitB.beta[0]!;
    const predictLog0 = (c: CompRow): number => {
      const f = featureRow(c, centers, feats);
      let v = intercept0 + bBar * c.x;
      for (let i = 0; i < feats.length; i++) v += featCoefs0[i]! * f[i]!;
      return v;
    };
    return { knots, slopes: [bBar, bBar, bBar], lambda: 0, bBar, intercept: intercept0, featCoefs: featCoefs0, feats, centers, predictLog: predictLog0 };
  }
  // Stage C: intercept + features on the shrunk ladder as a FIXED offset
  // (the ladder enters with coefficient 1; only the level and the feature
  // coefficients are refitted).
  const yAdj = y.map((v, i) => v - lad(comps[i]!.x));
  const fitC = huberFit(comps.map((c) => [1, ...featureRow(c, centers, feats)]), yAdj);
  const featCoefs = boundCoefs(feats, fitC.beta.slice(1));
  const intercept = fitC.beta[0]!;
  const predictLog = (c: CompRow): number => {
    const f = featureRow(c, centers, feats);
    let v = intercept + lad(c.x);
    for (let i = 0; i < feats.length; i++) v += featCoefs[i]! * f[i]!;
    return v;
  };
  return { knots, slopes, lambda: lam, bBar, intercept, featCoefs, feats, centers, predictLog };
}

const LAMBDA_GRID = [0, 0.25, 0.5, 0.75, 1];

function cvLadderLambda(comps: CompRow[], feats: string[]): { lambda: number; errors: Record<number, number> } {
  const srt = sortedComps(comps);
  const errors: Record<number, number> = {};
  for (const lam of LAMBDA_GRID) {
    const preds: number[] = [];
    const acts: number[] = [];
    for (let fold = 0; fold < 5; fold++) {
      const train = srt.filter((_, i) => foldOf(i) !== fold);
      const test = srt.filter((_, i) => foldOf(i) === fold);
      const m = fitLadder(train, feats, lam);
      for (const c of test) { preds.push(Math.pow(10, m.predictLog(c))); acts.push(Math.pow(10, c.y)); }
    }
    errors[lam] = medianMultErr(preds, acts);
  }
  let best = LAMBDA_GRID[0]!;
  for (const lam of LAMBDA_GRID) if (errors[lam]! < errors[best]!) best = lam;
  return { lambda: best, errors };
}

// ------------------------------------------------------------------ categories

interface CategoryModel {
  deltas: Map<string, number>;
  lambdaCat: number;
  support: Record<string, number>;
  qualifiedAt: Record<number, number>;
}

function huberMeanResidual(rs: number[]): number {
  if (rs.length === 0) return 0;
  const med = median(rs);
  let s = 1.4826 * median(rs.map((v) => Math.abs(v - med)));
  if (!(s > 0)) s = 1e-12;
  const c = 1.345 * s;
  let num = 0;
  let den = 0;
  for (const r of rs) {
    const w = Math.abs(r) <= c ? 1 : c / Math.abs(r);
    num += w * r;
    den += w;
  }
  return den > 0 ? num / den : 0;
}

function categoryDeltas(comps: CompRow[], resid: (c: CompRow) => number, lambdaCat: number): { deltas: Map<string, number>; support: Record<string, number> } {
  const byCat = new Map<string, CompRow[]>();
  for (const c of comps) {
    if (c.cat === null) continue;
    const arr = byCat.get(c.cat) ?? [];
    arr.push(c);
    byCat.set(c.cat, arr);
  }
  const deltas = new Map<string, number>();
  const support: Record<string, number> = {};
  const cap = log10(2.5);
  for (const [cat, arr] of byCat) {
    support[cat] = arr.length;
    if (arr.length < 6) { deltas.set(cat, 0); continue; }
    const rbar = huberMeanResidual(arr.map((c) => resid(c)));
    const d = lambdaCat === Infinity ? 0 : (arr.length / (arr.length + lambdaCat)) * rbar;
    deltas.set(cat, clamp(d, -cap, cap));
  }
  return { deltas, support };
}

const LAMBDA_CAT_GRID = [5, 10, 20, 40, Infinity];

function selectLambdaCat(comps: CompRow[], basePredict: (c: CompRow) => number): { lambdaCat: number; foldErrors: Record<string, number[]> } {
  const srt = sortedComps(comps);
  const foldErrors: Record<string, number[]> = {};
  for (const lam of LAMBDA_CAT_GRID) {
    const errs: number[] = [];
    for (let fold = 0; fold < 5; fold++) {
      const train = srt.filter((_, i) => foldOf(i) !== fold);
      const test = srt.filter((_, i) => foldOf(i) === fold);
      const { deltas } = categoryDeltas(train, (c) => c.y - basePredict(c), lam);
      const preds = test.map((c) => Math.pow(10, basePredict(c) + (deltas.get(c.cat ?? '') ?? 0)));
      const acts = test.map((c) => Math.pow(10, c.y));
      errs.push(medianMultErr(preds, acts));
    }
    foldErrors[String(lam)] = errs;
  }
  // One-standard-error rule: the most strongly shrunk lambda whose CV error
  // is within one SE of the best lambda's CV error.
  let bestLam: number = LAMBDA_CAT_GRID[0]!;
  let bestMean = Infinity;
  for (const lam of LAMBDA_CAT_GRID) {
    const m = mean(foldErrors[String(lam)]!);
    if (m < bestMean) { bestMean = m; bestLam = lam; }
  }
  const se = std(foldErrors[String(bestLam)]!) / Math.sqrt(5);
  const threshold = bestMean + se;
  // Grid order 5,10,20,40,Infinity is increasing shrinkage.
  let chosen = bestLam;
  for (const lam of LAMBDA_CAT_GRID) {
    if (mean(foldErrors[String(lam)]!) <= threshold) chosen = lam;
  }
  return { lambdaCat: chosen, foldErrors };
}

// ------------------------------------------------------------------ cap

const CAP_GRID = [0, 0.5, 1, 2];

function neighborhoodMax(comps: CompRow[], tvl: number, exclude?: CompRow): number | null {
  let m: number | null = null;
  for (const c of comps) {
    if (exclude !== undefined && c === exclude) continue;
    const t = c.p.tvl_usd;
    if (t >= tvl / 3 && t <= tvl * 3) {
      const mc = c.p.mcap_usd!;
      if (m === null || mc > m) m = mc;
    }
  }
  return m;
}

function applyCap(predUsd: number, tvl: number, comps: CompRow[], s: number, exclude?: CompRow): number {
  const m = neighborhoodMax(comps, tvl, exclude);
  if (m === null) return predUsd;
  return Math.min(predUsd, m * (1 + s));
}

function selectCap(comps: CompRow[], predictLog: (c: CompRow) => number): { s: number; errors: Record<number, number> } {
  const srt = sortedComps(comps);
  const errors: Record<number, number> = {};
  for (const s of CAP_GRID) {
    const preds: number[] = [];
    const acts: number[] = [];
    for (let fold = 0; fold < 5; fold++) {
      const train = srt.filter((_, i) => foldOf(i) !== fold);
      const test = srt.filter((_, i) => foldOf(i) === fold);
      for (const c of test) {
        const tvl = Math.pow(10, c.x) * 50000000;
        preds.push(applyCap(Math.pow(10, predictLog(c)), tvl, train, s));
        acts.push(Math.pow(10, c.y));
      }
    }
    errors[s] = medianMultErr(preds, acts);
  }
  let best = CAP_GRID[0]!;
  for (const s of CAP_GRID) if (errors[s]! < errors[best]!) best = s;
  return { s: best, errors };
}

// ------------------------------------------------------------------ full pipeline

interface FittedModel {
  ladder: LadderModel;
  categories: CategoryModel;
  capS: number;
  capErrors: Record<number, number>;
  lambdaErrors: Record<number, number>;
  lambdaCatErrors: Record<string, number[]>;
  feats: string[];
  predictLog: (c: CompRow) => number; // uncapped, with category delta
  predictUsd: (c: CompRow, compsForCap: CompRow[]) => number; // capped
}

function fitPipeline(comps: CompRow[], feats: string[]): FittedModel {
  const { lambda, errors: lambdaErrors } = cvLadderLambda(comps, feats);
  let ladder = fitLadder(comps, feats, lambda);
  // Pass 1: category deltas from the global fit's residuals.
  const basePredict = (c: CompRow): number => ladder.predictLog(c);
  const { lambdaCat, foldErrors: lambdaCatErrors } = selectLambdaCat(comps, basePredict);
  let { deltas, support } = categoryDeltas(comps, (c) => c.y - basePredict(c), lambdaCat);
  // Pass 2: refit the ladder on category-adjusted targets, recompute deltas.
  const adjusted: CompRow[] = comps.map((c) => ({ ...c, y: c.y - (deltas.get(c.cat ?? '') ?? 0) }));
  ladder = fitLadder(adjusted, feats, lambda);
  const predictNoCat = (c: CompRow): number => ladder.predictLog(c);
  const second = categoryDeltas(comps, (c) => c.y - predictNoCat(c), lambdaCat);
  deltas = second.deltas;
  support = second.support;
  const predictLog = (c: CompRow): number => predictNoCat(c) + (deltas.get(c.cat ?? '') ?? 0);
  const { s: capS, errors: capErrors } = selectCap(comps, predictLog);
  const predictUsd = (c: CompRow, compsForCap: CompRow[]): number => {
    const tvl = Math.pow(10, c.x) * 50000000;
    return applyCap(Math.pow(10, predictLog(c)), tvl, compsForCap, capS);
  };
  const qualifiedAt: Record<number, number> = {};
  for (const t of [5, 6, 20]) {
    qualifiedAt[t] = Object.values(support).filter((n) => n >= t).length;
  }
  return { ladder, categories: { deltas, lambdaCat, support, qualifiedAt }, capS, capErrors, lambdaErrors, lambdaCatErrors, feats, predictLog, predictUsd };
}

// ------------------------------------------------------------------ validation

interface SplitResult {
  preds: number[];
  acts: number[];
  medErr: number;
  within2x: number;
  within3x: number;
  spearman: number;
}

function spearman(xs: number[], ys: number[]): number {
  const rank = (arr: number[]): number[] => {
    const idx = arr.map((_, i) => i).sort((a, b) => arr[a]! - arr[b]!);
    const r = new Array<number>(arr.length).fill(0);
    let i = 0;
    while (i < idx.length) {
      let j = i;
      while (j + 1 < idx.length && arr[idx[j + 1]!] === arr[idx[i]!]) j++;
      const avg = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) r[idx[k]!] = avg;
      i = j + 1;
    }
    return r;
  };
  const rx = rank(xs);
  const ry = rank(ys);
  const mx = mean(rx);
  const my = mean(ry);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < rx.length; i++) {
    num += (rx[i]! - mx) * (ry[i]! - my);
    dx += (rx[i]! - mx) * (rx[i]! - mx);
    dy += (ry[i]! - my) * (ry[i]! - my);
  }
  return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : NaN;
}

function summarizeSplit(preds: number[], acts: number[]): SplitResult {
  const errs = preds.map((p, i) => multErr(p, acts[i]!));
  return {
    preds,
    acts,
    medErr: median(errs),
    within2x: errs.filter((e) => e <= 2).length / Math.max(1, errs.length),
    within3x: errs.filter((e) => e <= 3).length / Math.max(1, errs.length),
    spearman: spearman(preds, acts),
  };
}

// Baselines, learned inside each training fold. A: flat median mcap/TVL
// multiple. B: global 2-parameter Huber log-log.
function baselineAPredict(train: CompRow[], c: CompRow): number {
  // log10(mcap/tvl) = y - log10(tvl); log10(tvl) = x + log10(50M).
  const lr = train.map((t) => t.y - (t.x + log10(50000000)));
  return Math.pow(10, median(lr) + c.x + log10(50000000));
}
function baselineBPredict(train: CompRow[], c: CompRow): number {
  const X = train.map((t) => [1, t.x]);
  const y = train.map((t) => t.y);
  const fit = huberFit(X, y);
  return Math.pow(10, fit.beta[0]! + fit.beta[1]! * c.x);
}

interface LooResult {
  errors: { comp: CompRow; signedLog: number; stratum: number }[];
  model: SplitResult;
  baseA: SplitResult;
  baseB: SplitResult;
}

function looValidation(comps: CompRow[], feats: string[]): LooResult {
  const srt = sortedComps(comps);
  const errors: LooResult['errors'] = [];
  const mp: number[] = []; const ap: number[] = [];
  const ma: number[] = []; const mb: number[] = [];
  for (let i = 0; i < srt.length; i++) {
    const held = srt[i]!;
    const train = srt.filter((_, j) => j !== i);
    const model = fitPipeline(train, feats);
    const predLog = model.predictLog(held);
    const predUsd = model.predictUsd(held, train);
    const actualUsd = Math.pow(10, held.y);
    errors.push({ comp: held, signedLog: predLog - held.y, stratum: held.stratum });
    mp.push(predUsd); ap.push(actualUsd);
    ma.push(baselineAPredict(train, held)); mb.push(baselineBPredict(train, held));
  }
  return { errors, model: summarizeSplit(mp, ap), baseA: summarizeSplit(ma, ap), baseB: summarizeSplit(mb, ap) };
}

interface TimeSplitResult {
  boundary: string;
  nTrain: number;
  nTest: number;
  model: SplitResult;
  baseA: SplitResult;
  baseB: SplitResult;
  trainLooErrors: { signedLog: number; stratum: number }[];
  testSigned: { signedLog: number; stratum: number }[];
}

function timeSplitValidation(comps: CompRow[], feats: string[]): TimeSplitResult | null {
  const dated = comps
    .filter((c) => c.p.listed_at !== null)
    .sort((a, b) => (a.p.listed_at! < b.p.listed_at! ? -1 : a.p.listed_at! > b.p.listed_at! ? 1 : a.p.slug < b.p.slug ? -1 : 1));
  if (dated.length < 10) return null;
  const nTrain = Math.floor(dated.length * 0.7);
  const train = dated.slice(0, nTrain);
  const test = dated.slice(nTrain);
  const boundary = train[train.length - 1]!.p.listed_at!;
  const model = fitPipeline(train, feats);
  const mp = test.map((c) => model.predictUsd(c, train));
  const ap = test.map((c) => Math.pow(10, c.y));
  const ma = test.map((c) => baselineAPredict(train, c));
  const mb = test.map((c) => baselineBPredict(train, c));
  const trainLoo = looValidation(train, feats);
  const testSigned = test.map((c) => ({ signedLog: model.predictLog(c) - c.y, stratum: c.stratum }));
  return {
    boundary,
    nTrain,
    nTest: test.length,
    model: summarizeSplit(mp, ap),
    baseA: summarizeSplit(ma, ap),
    baseB: summarizeSplit(mb, ap),
    trainLooErrors: trainLoo.errors.map((e) => ({ signedLog: e.signedLog, stratum: e.stratum })),
    testSigned,
  };
}

// Dual out-of-sample feature gate: a feature is retained only when adding
// it strictly decreases the mean of the LOO and time-split median
// multiplicative errors and worsens neither split.
function dualGateErrors(comps: CompRow[], feats: string[]): { loo: number; ts: number | null } {
  const loo = looValidation(comps, feats);
  const ts = timeSplitValidation(comps, feats);
  return { loo: loo.model.medErr, ts: ts ? ts.model.medErr : null };
}

function selectFeatures(comps: CompRow[]): { feats: string[]; gate: Record<string, { before: { loo: number; ts: number | null }; after: { loo: number; ts: number | null }; retained: boolean }> } {
  const feats: string[] = [];
  const gate: Record<string, { before: { loo: number; ts: number | null }; after: { loo: number; ts: number | null }; retained: boolean }> = {};
  for (const cand of ['age', 'grow', 'chain']) {
    const before = dualGateErrors(comps, feats);
    const after = dualGateErrors(comps, [...feats, cand]);
    const meanBefore = before.ts === null ? before.loo : (before.loo + before.ts) / 2;
    const meanAfter = after.ts === null ? after.loo : (after.loo + after.ts) / 2;
    const looOk = after.loo <= before.loo;
    const tsOk = before.ts === null || after.ts === null || after.ts <= before.ts;
    const retained = meanAfter < meanBefore && looOk && tsOk;
    gate[cand] = { before, after, retained };
    if (retained) feats.push(cand);
  }
  return { feats, gate };
}

// Sensitivity: refit with the 10% highest-leverage comps removed, and with
// the integrity window widened. Leverage = OLS hat diagonal.
function hatDiagonals(comps: CompRow[], feats: string[]): number[] {
  const centers = computeCenters(comps);
  const knots = tercileKnots(comps.map((c) => c.x));
  const X = comps.map((c) => [1, c.x, Math.max(0, c.x - knots[0]), Math.max(0, c.x - knots[1]), ...featureRow(c, centers, feats)]);
  const p = X[0]!.length;
  const XtX: number[][] = Array.from({ length: p }, () => new Array<number>(p).fill(0));
  for (const row of X) for (let a = 0; a < p; a++) for (let b = 0; b < p; b++) XtX[a]![b] = XtX[a]![b]! + row[a]! * row[b]!;
  // Invert XtX by solving against unit vectors.
  const invCols: number[][] = [];
  for (let j = 0; j < p; j++) {
    const e = new Array<number>(p).fill(0); e[j] = 1;
    invCols.push(solveLinear(XtX, e));
  }
  return X.map((row) => {
    let h = 0;
    for (let a = 0; a < p; a++) for (let b = 0; b < p; b++) h += row[a]! * invCols[b]![a]! * row[b]!;
    return h;
  });
}

function sensitivityReport(comps: CompRow[], wideComps: CompRow[], feats: string[], baseBBar: number): { noLeverageSlope: number; noLeverageMovePct: number; wideWindowSlope: number; wideWindowMovePct: number; wideN: number; fragile: boolean } {
  const hats = hatDiagonals(comps, feats);
  const order = comps.map((c, i) => i).sort((a, b) => hats[b]! - hats[a]!);
  const drop = new Set(order.slice(0, Math.max(1, Math.round(comps.length * 0.1))));
  const kept = comps.filter((_, i) => !drop.has(i));
  const m1 = fitPipeline(kept, feats);
  const noLeverageSlope = m1.ladder.bBar;
  const noLeverageMovePct = Math.abs(noLeverageSlope - baseBBar) / Math.abs(baseBBar);
  const m2 = fitPipeline(wideComps, feats);
  const wideWindowSlope = m2.ladder.bBar;
  const wideWindowMovePct = Math.abs(wideWindowSlope - baseBBar) / Math.abs(baseBBar);
  return {
    noLeverageSlope,
    noLeverageMovePct,
    wideWindowSlope,
    wideWindowMovePct,
    wideN: wideComps.length,
    fragile: noLeverageMovePct > 0.15 || wideWindowMovePct > 0.15,
  };
}

// ------------------------------------------------------------------ conformal bands

interface BandQuantiles { q10: number; q25: number; q75: number; q90: number; n: number; }

function stratumQuantiles(errors: { signedLog: number; stratum: number }[]): { strata: Record<number, BandQuantiles>; global: BandQuantiles } {
  const globalSorted = errors.map((e) => e.signedLog).sort((a, b) => a - b);
  const global: BandQuantiles = {
    q10: Math.min(0, conformalQuantile(globalSorted, 0.1)),
    q25: Math.min(0, conformalQuantile(globalSorted, 0.25)),
    q75: Math.max(0, conformalQuantile(globalSorted, 0.75)),
    q90: Math.max(0, conformalQuantile(globalSorted, 0.9)),
    n: errors.length,
  };
  const strata: Record<number, BandQuantiles> = {};
  for (const s of [1, 2, 3]) {
    const sub = errors.filter((e) => e.stratum === s).map((e) => e.signedLog).sort((a, b) => a - b);
    if (sub.length === 0) { strata[s] = global; continue; }
    const raw: BandQuantiles = {
      q10: Math.min(0, conformalQuantile(sub, 0.1)),
      q25: Math.min(0, conformalQuantile(sub, 0.25)),
      q75: Math.max(0, conformalQuantile(sub, 0.75)),
      q90: Math.max(0, conformalQuantile(sub, 0.9)),
      n: sub.length,
    };
    if (sub.length < 15) {
      const w = sub.length / (sub.length + 15);
      strata[s] = {
        q10: w * raw.q10 + (1 - w) * global.q10,
        q25: w * raw.q25 + (1 - w) * global.q25,
        q75: w * raw.q75 + (1 - w) * global.q75,
        q90: w * raw.q90 + (1 - w) * global.q90,
        n: sub.length,
      };
    } else {
      strata[s] = raw;
    }
  }
  return { strata, global };
}

function coverageRate(errors: { signedLog: number; stratum: number }[], quantiles: { strata: Record<number, BandQuantiles>; global: BandQuantiles }, lo: 'q25' | 'q10', hi: 'q75' | 'q90'): number {
  let hit = 0;
  for (const e of errors) {
    const q = quantiles.strata[e.stratum] ?? quantiles.global;
    if (e.signedLog >= q[lo] && e.signedLog <= q[hi]) hit++;
  }
  return errors.length ? hit / errors.length : NaN;
}

// Nested LOO coverage: for each comp, quantiles from the other comps'
// LOO errors only (genuinely out-of-sample).
function nestedLooCoverage(loo: LooResult): { p50: number; p80: number } {
  let hit50 = 0;
  let hit80 = 0;
  for (let i = 0; i < loo.errors.length; i++) {
    const others = loo.errors.filter((_, j) => j !== i).map((e) => ({ signedLog: e.signedLog, stratum: e.stratum }));
    const q = stratumQuantiles(others);
    const e = loo.errors[i]!;
    const qs = q.strata[e.stratum] ?? q.global;
    if (e.signedLog >= qs.q25 && e.signedLog <= qs.q75) hit50++;
    if (e.signedLog >= qs.q10 && e.signedLog <= qs.q90) hit80++;
  }
  return { p50: hit50 / Math.max(1, loo.errors.length), p80: hit80 / Math.max(1, loo.errors.length) };
}

// ------------------------------------------------------------------ farm economics

const GAS_TIERS: Record<string, [number, number, number]> = {
  eth: [18, 45, 110],
  alt: [1.5, 4, 12],
  l2: [0.8, 2.5, 8],
  other: [2, 6, 18],
};
const ALT_L1 = new Set(['Solana', 'Binance', 'Avalanche', 'Bitcoin', 'Tron', 'Sui', 'Aptos', 'Hyperliquid L1']);
const L2_CHAINS = new Set(['Arbitrum', 'Optimism', 'Base', 'Polygon', 'Scroll', 'Linea', 'zkSync Era', 'Starknet', 'Blast', 'Mantle', 'Berachain', 'Sonic']);

function gasTier(chain: string): string {
  if (chain === 'Ethereum') return 'eth';
  if (ALT_L1.has(chain)) return 'alt';
  if (L2_CHAINS.has(chain)) return 'l2';
  return 'other';
}

interface Econ {
  deposit: number;
  alphaDrop: number;
  gasBase: number;
  gasHigh: number;
  gasLow: number;
  oppCost: number;
  tDays: number;
  tHours: number;
  share: number;
  grossP50: number;
  grossP25: number;
  totalCostBase: number;
  totalCostHigh: number;
  netP50: number;
  netP25: number;
  netPerHour: number;
  pBe: number;
  alphaBe: number;
  fdvBreakeven: number;
  dMin: number;
  dMax: number;
}

function computeEcon(p: Protocol, impliedUsd: number, p25Usd: number, asOf: string, deposit = 2500, alphaDrop = 0.06): Econ {
  const tier = gasTier(p.chains[0] ?? '');
  const [gLow, gBase, gHigh] = GAS_TIERS[tier]!;
  const multi = p.chains.length >= 2;
  const gasLow = gLow + (multi ? 3 : 0);
  const gasBase = gBase + (multi ? 7.5 : 0);
  const gasHigh = gHigh + (multi ? 18 : 0);
  const days = p.listed_at === null ? null : daysBetween(p.listed_at, asOf);
  const tDays = days === null || days < 365 ? 45 : days < 730 ? 60 : 75;
  const tHours = Math.min(3, 1.5 + 0.25 * Math.max(0, p.chains.length - 1));
  const eta = 1.25;
  const rOpp = 0.045;
  const share = deposit / (p.tvl_usd * eta);
  const grossP50 = impliedUsd * alphaDrop * share;
  const grossP25 = p25Usd * alphaDrop * share;
  const oppCost = deposit * rOpp * (tDays / 365);
  const totalCostBase = gasBase + oppCost;
  const totalCostHigh = gasHigh + oppCost;
  const netP50 = grossP50 - totalCostBase;
  const netP25 = grossP25 - totalCostHigh;
  const netPerHour = netP50 / tHours;
  const pBe = grossP50 > 0 ? Math.min(1, totalCostBase / grossP50) : 2;
  const alphaBe = impliedUsd * share > 0 ? totalCostBase / (impliedUsd * share) : 2;
  const fdvBreakeven = alphaDrop * share > 0 ? totalCostBase / (alphaDrop * share) : Infinity;
  const dMin = grossP50 > 0 ? (2 * gasBase) / (impliedUsd * alphaDrop / (p.tvl_usd * eta)) : deposit;
  const dMax = Math.min(0.005 * p.tvl_usd, 50000);
  return { deposit, alphaDrop, gasBase, gasHigh, gasLow, oppCost, tDays, tHours, share, grossP50, grossP25, totalCostBase, totalCostHigh, netP50, netP25, netPerHour, pBe, alphaBe, fdvBreakeven, dMin, dMax };
}

function assignVerdict(e: Econ, researchOnly: boolean, researchReasons: string[]): { verdict: string; reasons: string[] } {
  if (researchOnly) return { verdict: 'Research only', reasons: researchReasons };
  if (e.netP50 > 0 && e.netP25 > 0 && e.pBe <= 0.45 && e.netPerHour >= 25) return { verdict: 'Farm', reasons: [] };
  if (e.netP50 > 0 && e.pBe <= 0.75) return { verdict: 'Marginal', reasons: [] };
  return { verdict: 'Skip', reasons: [] };
}

// ------------------------------------------------------------------ farm steps

function categoryAction(cat: string | null): string {
  switch (cat) {
    case 'Dexs': return 'swap and add liquidity';
    case 'Lending': return 'supply collateral and borrow modestly';
    case 'Derivatives': return 'open modest hedged volume';
    case 'Yield': return 'deposit into the yield vault';
    case 'Yield Aggregator': return 'deposit into the yield vault';
    case 'CDP': return 'mint against collateral';
    case 'RWA': return 'use the tokenized-asset position';
    default: return 'use the native interaction';
  }
}

function buildFarmPlan(p: Protocol, e: Econ, verdict: string, researchOnly: boolean, impliedUsd: number, p25Usd: number, p75Usd: number, asOf: string): string[] {
  const chain = p.chains[0] ?? 'its primary chain';
  const multi = p.chains.length >= 2 ? ' Multi-chain: repeat staging on each extra chain inside the gas reserve.' : '';
  const days = p.listed_at === null ? 'unknown' : String(daysBetween(p.listed_at, asOf));
  // Display string from the ROUNDED 1dp value (same rounding as the page's
  // data): Number('-0.0') is -0, whose toFixed(1) is '0.0' with a '+' sign,
  // so formatting the exact value here would disagree with the page.
  const chgNum = p.change_7d === null ? null : Number(p.change_7d.toFixed(1));
  const chg = chgNum === null ? 'unreported' : (chgNum >= 0 ? '+' : '') + chgNum.toFixed(1) + '%';
  const core = researchOnly
    ? 'dry-run and documentation verification, $0 committed'
    : categoryAction(p.category);
  const exitAction = verdict === 'Farm' || verdict === 'Marginal'
    ? 'unwind at the token-generation announcement or the day cap'
    : 'deploy $0 and monitor only';
  const steps = [
    'Eligibility check (~10 min, $0): confirm ' + p.name + ' still records no token and TVL ' + fmtMoney(p.tvl_usd) + ' keeps ' + fmtUsd(e.deposit) + ' inside the optimal [' + fmtUsd(e.dMin) + '–' + fmtUsd(e.dMax) + '] window. Evidence: snapshot TVL, category, chains. Stop: abort if a cutoff is announced or TVL dilutes past 2x.',
    'Capital staging (~15 min, ' + fmtUsd(e.gasBase) + ' base gas, ' + fmtUsd(e.gasHigh) + ' high — assumed, not live quotes): stage ' + fmtUsd(e.deposit) + ' on ' + chain + ', keep a gas reserve inside the high-scenario ceiling.' + multi + ' Evidence: snapshot chains[0]. Stop: abort if a real gas quote tops ' + fmtUsd(e.gasHigh) + ' before the first deposit.',
    'Core interaction (~20 min, ' + fmtUsd(e.gasBase) + ' gas + ' + fmtUsd(e.oppCost) + ' opportunity cost): ' + core + ' on ' + chain + '; 7-day TVL trend is ' + chg + '. Evidence: snapshot category and change_7d. Stop: exit if 7-day TVL falls more than 35%.',
    'Tenure cadence (' + e.tDays + '-day hold, ~10 min/week, ' + fmtUsd(e.oppCost) + ' opportunity cost at assumed 4.5% APR): hold ' + e.tDays + ' days; tracking tenure is ' + days + ' days, a maturity proxy. Evidence: snapshot listed_at. Stop: withdraw if the break-even FDV hurdle ' + fmtMoney(e.fdvBreakeven) + ' exceeds the P75 upside ' + fmtMoney(p75Usd) + '.',
    'Break-even audit (~10 min, $0): conditional slice P50 ' + fmtMoney(e.grossP50) + ' and P25 stress ' + fmtMoney(e.grossP25) + ' vs total cost ' + fmtUsd(e.totalCostBase) + '; required launch odds ' + fmtPct(e.pBe, 0) + ', break-even drop share ' + fmtPct(e.alphaBe, 1) + '. Evidence: fitted P25–P75 plus break-even hurdles. Stop: reclassify to Skip if dilution cuts net P50 below zero.',
    'Exit (~15 min, exit gas about ' + fmtUsd(e.gasBase * 0.5) + '): ' + exitAction + ' for the ' + verdict + ' verdict on a conditional value of ' + fmtMoney(impliedUsd) + ' (P25 ' + fmtMoney(p25Usd) + '). Evidence: recomputed verdict. Stop: mandatory unwind at the ' + e.tDays + '-day cap.',
  ];
  return steps;
}

// ------------------------------------------------------------------ scoring

interface ScoredRow extends BoardRow {
  yHat: number;
  stratum: number;
}

function makeCompRow(p: Protocol, asOf: string, support: Record<string, number>): CompRow {
  const days = p.listed_at === null ? null : Math.max(0, daysBetween(p.listed_at, asOf));
  const cat = p.category;
  const stratum = days === null ? 3 : cat !== null && (support[cat] ?? 0) >= 6 ? 1 : 2;
  return {
    p,
    x: log10(p.tvl_usd / 50000000),
    y: p.mcap_usd !== null ? log10(p.mcap_usd) : 0,
    days,
    grow: p.change_7d,
    nChains: Math.max(1, p.chains.length),
    cat,
    stratum,
  };
}

function peerRates(classified: Classified[]): { perCat: Map<string, number>; global: number } {
  const n = new Map<string, number>();
  const k = new Map<string, number>();
  let nTot = 0;
  let kTot = 0;
  for (const c of classified) {
    if (c.bucket === 'hold') continue;
    if (exclusionReason(c.p) !== null) continue;
    const cat = c.p.category ?? '\u0000null';
    n.set(cat, (n.get(cat) ?? 0) + 1);
    nTot++;
    if (hasToken(c.p)) { k.set(cat, (k.get(cat) ?? 0) + 1); kTot++; }
  }
  const global = nTot ? kTot / nTot : 0;
  const perCat = new Map<string, number>();
  for (const [cat, nn] of n) {
    perCat.set(cat, ((k.get(cat) ?? 0) + 5 * global) / (nn + 5));
  }
  return { perCat, global };
}

// ------------------------------------------------------------------ main

interface ValidationOut {
  compRaw: number;
  compFit: number;
  dustOut: number;
  lambda: number;
  lambdaErrors: Record<number, number>;
  slopes: [number, number, number];
  bBar: number;
  knots: [number, number];
  intercept: number;
  feats: string[];
  featCoefs: number[];
  gate: Record<string, { before: { loo: number; ts: number | null }; after: { loo: number; ts: number | null }; retained: boolean }>;
  lambdaCat: number;
  lambdaCatErrors: Record<string, number[]>;
  catDeltas: Record<string, number>;
  catSupport: Record<string, number>;
  qualifiedAt: Record<number, number>;
  capS: number;
  capErrors: Record<number, number>;
  loo: { medErr: number; within2x: number; within3x: number; spearman: number; baseA: number; baseB: number; baseA2x: number; baseB2x: number };
  ts: { boundary: string; nTrain: number; nTest: number; medErr: number; within2x: number; within3x: number; spearman: number; baseA: number; baseB: number } | null;
  coverageLooNested: { p50: number; p80: number };
  coverageTs: { p50: number; p80: number } | null;
  sensitivity: { noLeverageSlope: number; noLeverageMovePct: number; wideWindowSlope: number; wideWindowMovePct: number; wideN: number; fragile: boolean };
  centers: FeatureCenters;
  quantiles: { strata: Record<number, BandQuantiles>; global: BandQuantiles };
  compTvlMin: number;
  compTvlMax: number;
  capBindingRows: number;
  verdictCounts: Record<string, number>;
}

function main(): void {
  const { input, output } = parseArgs(process.argv.slice(2));
  const snap = JSON.parse(readFileSync(input, 'utf8')) as Snapshot;
  const asOf = snap.as_of || 'Snapshot date not supplied';
  const t0 = Date.now();

  // --- Step 1: census and exclusions.
  const { rows: classified, counts, refOtherWhy } = classifyAll(snap);
  const total = snap.protocols.length;
  const censusSum = Object.values(counts).reduce((a, b) => a + b, 0);
  if (censusSum !== total) throw new Error(`census does not sum: ${censusSum} != ${total}`);
  const watchSet = new Set(snap.watchlist);
  for (const s of snap.watchlist) {
    const c = classified.find((x) => x.p.slug === s);
    if (!c) throw new Error(`watchlist slug missing from snapshot: ${s}`);
    if (c.bucket !== 'watch') throw new Error(`watchlist slug ${s} fails the visible screen (bucket ${c.bucket})`);
  }
  if (counts.watch !== snap.watchlist.length) throw new Error(`watchlist bucket ${counts.watch} != supplied ${snap.watchlist.length}`);

  // --- Step 2: comp set (fitted) and widened-window comp set (sensitivity).
  const fitted = classified.filter((c) => c.bucket === 'refFit').map((c) => c.p);
  const support0: Record<string, number> = {};
  for (const p of fitted) if (p.category !== null) support0[p.category] = (support0[p.category] ?? 0) + 1;
  const comps = fitted.map((p) => makeCompRow(p, asOf, support0));
  const wideProtocols = snap.protocols.filter((p) => {
    if (!hasToken(p)) return false;
    if (p.mcap_usd === null || p.mcap_usd === 0) return false;
    if (exclusionReason(p) !== null) return false;
    const ratio = p.mcap_usd / p.tvl_usd;
    return p.mcap_usd >= 10000 && ratio >= 0.001 && ratio <= 1000;
  });
  const wideComps = wideProtocols.map((p) => makeCompRow(p, asOf, support0));

  // --- Step 3: feature selection under the dual gate.
  const { feats, gate } = selectFeatures(comps);

  // --- Step 4: final fit on all comps.
  const model = fitPipeline(comps, feats);

  // --- Step 5: validation (LOO + time-split + baselines + sensitivity).
  const loo = looValidation(comps, feats);
  const ts = timeSplitValidation(comps, feats);
  const sens = sensitivityReport(comps, wideComps, feats, model.ladder.bBar);
  const quantiles = stratumQuantiles(loo.errors);
  const covLoo = nestedLooCoverage(loo);
  let covTs: { p50: number; p80: number } | null = null;
  if (ts) {
    const trainQ = stratumQuantiles(ts.trainLooErrors);
    covTs = {
      p50: coverageRate(ts.testSigned, trainQ, 'q25', 'q75'),
      p80: coverageRate(ts.testSigned, trainQ, 'q10', 'q90'),
    };
  }

  // --- Step 6: score every board candidate.
  const { perCat: peerPerCat, global: peerGlobal } = peerRates(classified);
  const compTvls = comps.map((c) => Math.pow(10, c.x) * 50000000);
  const compTvlMin = Math.min(...compTvls);
  const compTvlMax = Math.max(...compTvls);
  const boardCandidates = classified.filter((c) => c.bucket === 'watch' || c.bucket === 'below');
  const scored: ScoredRow[] = [];
  let capBindingRows = 0;
  for (const c of boardCandidates) {
    const p = c.p;
    const row = makeCompRow(p, asOf, model.categories.support);
    const yHat = model.predictLog(row);
    const uncapped = Math.pow(10, yHat);
    const capped = model.predictUsd(row, comps);
    if (capped < uncapped * (1 - 1e-12)) capBindingRows++;
    const q = quantiles.strata[row.stratum] ?? quantiles.global;
    let q10 = q.q10;
    let q25 = q.q25;
    let q75 = q.q75;
    let q90 = q.q90;
    const extrapolated = p.tvl_usd < compTvlMin || p.tvl_usd > compTvlMax;
    if (extrapolated) {
      q10 = Math.min(q10, quantiles.global.q10);
      q25 = Math.min(q25, quantiles.global.q25);
      q75 = Math.max(q75, quantiles.global.q75);
      q90 = Math.max(q90, quantiles.global.q90);
    }
    const capVal = capped < uncapped ? capped : Infinity;
    const band = (qq: number): number => {
      const v = Math.pow(10, yHat + qq);
      return capVal === Infinity ? v : Math.min(v, capVal);
    };
    const p50 = Math.round(capped);
    const p25 = Math.round(band(q25));
    const p75 = Math.round(band(q75));
    const p10 = Math.round(band(q10));
    const p90 = Math.round(band(q90));
    const peer = p.category === null ? peerGlobal : (peerPerCat.get(p.category) ?? peerGlobal);
    const econ = computeEcon(p, p50, p25, asOf);
    const researchReasons: string[] = [];
    if (p.listed_at === null) researchReasons.push('listed_at null — tracking history unverified');
    if (p.category === null) researchReasons.push('category null — uncalibrated');
    else if ((model.categories.support[p.category] ?? 0) < 6) researchReasons.push('category uncalibrated (fewer than 6 traded comps)');
    if (peer === 0) researchReasons.push('peer tokenization rate is 0 in this snapshot');
    const { verdict } = assignVerdict(econ, researchReasons.length > 0, researchReasons);
    const steps = buildFarmPlan(p, econ, verdict, researchReasons.length > 0, p50, p25, p75, asOf);
    scored.push({
      slug: p.slug,
      name: p.name,
      rank: 0,
      implied_value_usd: p50,
      p25_usd: p25,
      p75_usd: p75,
      p10_usd: p10,
      p90_usd: p90,
      rank_best: 0,
      rank_worst: 0,
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      category: p.category,
      chains: p.chains,
      days: row.days,
      watchlist: c.bucket === 'watch',
      extrapolated,
      peer_token_rate: peer,
      verdict,
      net_p50: econ.netP50,
      net_p25: econ.netP25,
      net_per_hour: econ.netPerHour,
      p_be: econ.pBe,
      alpha_be: econ.alphaBe,
      fdv_breakeven: econ.fdvBreakeven,
      farm_steps: steps,
      step_hash: stepHash(steps),
      yHat,
      stratum: row.stratum,
    });
  }
  // Rank: implied value desc, TVL desc, slug asc (bytewise).
  scored.sort((a, b) => (b.implied_value_usd - a.implied_value_usd) || (b.tvl_usd - a.tvl_usd) || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  for (let i = 0; i < scored.length; i++) scored[i]!.rank = i + 1;
  // Rank intervals from P10/P90.
  for (const r of scored) {
    let best = 1;
    let worst = 1;
    for (const o of scored) {
      if (o === r) continue;
      if (o.implied_value_usd > r.p90_usd) best++;
      if (o.implied_value_usd > r.p10_usd) worst++;
    }
    r.rank_best = best;
    r.rank_worst = worst;
  }
  const verdictCounts: Record<string, number> = {};
  for (const r of scored) verdictCounts[r.verdict] = (verdictCounts[r.verdict] ?? 0) + 1;

  const validation: ValidationOut = {
    compRaw: counts.refFit + (refOtherWhy['dust'] ?? 0),
    compFit: comps.length,
    dustOut: refOtherWhy['dust'] ?? 0,
    lambda: model.ladder.lambda,
    lambdaErrors: model.lambdaErrors,
    slopes: model.ladder.slopes,
    bBar: model.ladder.bBar,
    knots: model.ladder.knots,
    intercept: model.ladder.intercept,
    feats: model.feats,
    featCoefs: model.ladder.featCoefs,
    gate,
    lambdaCat: model.categories.lambdaCat,
    lambdaCatErrors: model.lambdaCatErrors,
    catDeltas: Object.fromEntries(model.categories.deltas),
    catSupport: model.categories.support,
    qualifiedAt: model.categories.qualifiedAt,
    capS: model.capS,
    capErrors: model.capErrors,
    loo: {
      medErr: loo.model.medErr, within2x: loo.model.within2x, within3x: loo.model.within3x, spearman: loo.model.spearman,
      baseA: loo.baseA.medErr, baseB: loo.baseB.medErr, baseA2x: loo.baseA.within2x, baseB2x: loo.baseB.within2x,
    },
    ts: ts ? {
      boundary: ts.boundary, nTrain: ts.nTrain, nTest: ts.nTest,
      medErr: ts.model.medErr, within2x: ts.model.within2x, within3x: ts.model.within3x, spearman: ts.model.spearman,
      baseA: ts.baseA.medErr, baseB: ts.baseB.medErr,
    } : null,
    coverageLooNested: covLoo,
    coverageTs: covTs,
    sensitivity: sens,
    centers: model.ladder.centers,
    quantiles,
    compTvlMin,
    compTvlMax,
    capBindingRows,
    verdictCounts,
  };

  // --- Step 7: board.json.
  const board = {
    meta: {
      competition: 'token-radar-01',
      as_of: asOf,
      floor_usd: snap.floor_usd,
      protocols: total,
      board_rows: scored.length,
      watchlist_covered: scored.filter((r) => r.watchlist).length,
      watchlist_total: snap.watchlist.length,
      census: counts,
      ref_other_breakdown: refOtherWhy,
      validation: {
        comp_fit: validation.compFit,
        lambda: validation.lambda,
        slopes: validation.slopes,
        b_bar: validation.bBar,
        knots: validation.knots,
        features_retained: validation.feats,
        lambda_cat: model.categories.lambdaCat === Infinity ? 'inf' : model.categories.lambdaCat,
        cap_s: validation.capS,
        loo_median_error: validation.loo.medErr,
        loo_within_3x: validation.loo.within3x,
        time_split_median_error: validation.ts?.medErr ?? null,
        coverage_loo_p50: validation.coverageLooNested.p50,
        coverage_loo_p80: validation.coverageLooNested.p80,
        fragile: validation.sensitivity.fragile,
      },
    },
    rows: scored.map((r) => ({
      slug: r.slug,
      name: r.name,
      rank: r.rank,
      implied_value_usd: r.implied_value_usd,
      p25_usd: r.p25_usd,
      p75_usd: r.p75_usd,
      p10_usd: r.p10_usd,
      p90_usd: r.p90_usd,
      rank_best: r.rank_best,
      rank_worst: r.rank_worst,
      tvl_usd: r.tvl_usd,
      change_7d: r.change_7d,
      category: r.category,
      chains: r.chains,
      days_tracked: r.days,
      watchlist: r.watchlist,
      extrapolated: r.extrapolated,
      peer_token_rate: r.peer_token_rate,
      verdict: r.verdict,
      net_p50_usd: Math.round(r.net_p50 * 100) / 100,
      net_p25_usd: Math.round(r.net_p25 * 100) / 100,
      net_per_hour_usd: Math.round(r.net_per_hour * 100) / 100,
      p_be: r.p_be,
      alpha_be: r.alpha_be,
      fdv_breakeven_usd: Number.isFinite(r.fdv_breakeven) ? Math.round(r.fdv_breakeven) : null,
      farm_steps: r.farm_steps,
    })),
  };

  // --- Step 8: dashboard data (compact positional rows).
  // Category table covers every category on the board (delta/support
  // default to 0 when no traded comp carries it), so no row loses its name.
  const catNames = new Set<string>();
  for (const r of scored) if (r.category !== null) catNames.add(r.category);
  for (const name of model.categories.deltas.keys()) catNames.add(name);
  const cats = [...catNames]
    .map((name) => [name, model.categories.deltas.get(name) ?? 0, model.categories.support[name] ?? 0, Math.round((peerPerCat.get(name) ?? peerGlobal) * 1000) / 1000] as [string, number, number, number])
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const catIndex = new Map(cats.map((c, i) => [c[0], i]));
  const chainNames: string[] = [];
  const chainIndex = new Map<string, number>();
  const chainIdx = (name: string): number => {
    let i = chainIndex.get(name);
    if (i === undefined) { i = chainNames.length; chainIndex.set(name, i); chainNames.push(name); }
    return i;
  };
  // Exact integer TVL/mcap pairs: the page re-derives the cap from these,
  // so they must be exact, never rounded log values.
  const compScatter = fitted.map((p) => [p.tvl_usd, p.mcap_usd]);
  const refs = [...fitted]
    .sort((a, b) => b.tvl_usd - a.tvl_usd)
    .slice(0, 8)
    .map((p) => [p.name, p.category, p.tvl_usd, p.mcap_usd]);
  // Compact rows: one pipe-delimited line per board row — name, catIdx,
  // chainIdx, nChains, tvl, chg, days, watch, digest. The slug is omitted
  // (names are unique across the snapshot; the page identifies rows by
  // name). The central value is bound inside the digest, so the page
  // re-derives it and proves the digest matches; extrapolated status is
  // derived from TVL vs the comp range.
  const rowDigest = (r: ScoredRow): string => stepHash([`${r.implied_value_usd}|${r.p25_usd}|${r.p75_usd}|${r.p10_usd}|${r.p90_usd}|${r.rank_best}|${r.rank_worst}|${r.verdict}|${r.step_hash}`]);
  const dataRows = scored
    .map((r) => {
      const fields = [
        r.name,
        String(r.category === null ? -1 : catIndex.get(r.category) ?? -1),
        String(chainIdx(r.chains[0] ?? '')),
        String(r.chains.length),
        String(r.tvl_usd),
        // 7d change is display-only at 1dp everywhere on the page (table,
        // steps); the exact value stays in board.json. Round by formatting
        // so the page's toFixed(1) reproduces the exact same string.
        r.change_7d === null ? '' : String(Number(r.change_7d.toFixed(1))),
        r.days === null ? '' : String(r.days),
        r.watchlist ? '1' : '0',
        rowDigest(r),
      ];
      for (const f of fields) if (f.includes('|')) throw new Error('row field contains pipe: ' + r.name);
      return fields.join('|');
    })
    .join('\n');
  const data = {
    meta: {
      asOf,
      nSnap: total,
      nBoard: scored.length,
      watchN: snap.watchlist.length,
      census: counts,
      refOther: refOtherWhy,
      peerGlobal: Math.round(peerGlobal * 10000) / 10000,
      verdictCounts,
      capBindingRows,
    },
    params: {
      knots: model.ladder.knots,
      slopes: model.ladder.slopes,
      lambda: model.ladder.lambda,
      bBar: model.ladder.bBar,
      intercept: model.ladder.intercept,
      feats: model.feats,
      featCoefs: model.ladder.featCoefs,
      capS: model.capS,
      quantiles: validation.quantiles,
      compTvlMin,
      compTvlMax,
    },
    validation: {
      loo: { medErr: validation.loo.medErr, within2x: validation.loo.within2x, within3x: validation.loo.within3x, spearman: validation.loo.spearman, baseA: validation.loo.baseA, baseB: validation.loo.baseB },
      ts: validation.ts,
      coverageLoo: covLoo,
      coverageTs: covTs,
      gate: Object.fromEntries(Object.entries(gate).map(([f, g]) => [f, {
        before: { loo: Math.round(g.before.loo * 100) / 100, ts: g.before.ts === null ? null : Math.round(g.before.ts * 100) / 100 },
        after: { loo: Math.round(g.after.loo * 100) / 100, ts: g.after.ts === null ? null : Math.round(g.after.ts * 100) / 100 },
        retained: g.retained,
      }])),
      lambdaCat: model.categories.lambdaCat === Infinity ? 'inf' : model.categories.lambdaCat,
      qualifiedAt: model.categories.qualifiedAt,
      sensitivity: {
        noLeverageSlope: Math.round(sens.noLeverageSlope * 10000) / 10000,
        noLeverageMovePct: Math.round(sens.noLeverageMovePct * 10000) / 10000,
        wideWindowSlope: Math.round(sens.wideWindowSlope * 10000) / 10000,
        wideWindowMovePct: Math.round(sens.wideWindowMovePct * 10000) / 10000,
        wideN: sens.wideN,
        fragile: sens.fragile,
      },
    },
    cats,
    chains: chainNames,
    comps: compScatter,
    refs,
    rows: dataRows,
  };
  const dataJs = 'window.RADAR_DATA = ' + JSON.stringify(data) + ';\n';

  // --- Step 9: self-test — recompute from the SERIALIZED params only.
  const recompute = verifyFromParams(data, scored, snap);
  if (!recompute.pass) throw new Error('self-test recompute failed: ' + recompute.firstMismatch);

  // --- Step 10: write outputs.
  mkdirSync(output, { recursive: true });
  mkdirSync(join(output, 'dashboard'), { recursive: true });
  mkdirSync(join(output, 'screenshots'), { recursive: true });
  writeFileSync(join(output, 'board.json'), JSON.stringify(board, null, 2) + '\n');
  cpSync(join(HERE, 'dashboard'), join(output, 'dashboard'), { recursive: true });
  writeFileSync(join(output, 'dashboard', 'data.js'), dataJs);
  const shotsDir = join(HERE, 'screenshots');
  if (!existsSync(shotsDir)) throw new Error('screenshots/ missing from the repository');
  const shots = readdirSync(shotsDir).filter((f) => !f.startsWith('.'));
  if (shots.length < 3) throw new Error(`screenshots/ holds ${shots.length} files, need at least 3`);
  for (const f of shots) copyFileSync(join(shotsDir, f), join(output, 'screenshots', f));
  const dossier = buildDossier(output, { text_max_bytes: 65536 });
  writeFileSync(join(output, 'dossier.json'), dossier);

  const ms = Date.now() - t0;
  console.log(JSON.stringify({
    ok: true,
    ms,
    protocols: total,
    census: counts,
    boardRows: scored.length,
    compFit: comps.length,
    feats,
    lambda: model.ladder.lambda,
    slopes: model.ladder.slopes.map((s) => +s.toFixed(4)),
    bBar: +model.ladder.bBar.toFixed(4),
    lambdaCat: model.categories.lambdaCat,
    capS: model.capS,
    looMedErr: +loo.model.medErr.toFixed(4),
    looBaseA: +loo.baseA.medErr.toFixed(4),
    looBaseB: +loo.baseB.medErr.toFixed(4),
    tsMedErr: ts ? +ts.model.medErr.toFixed(4) : null,
    coverageLoo50: +covLoo.p50.toFixed(3),
    coverageLoo80: +covLoo.p80.toFixed(3),
    coverageTs50: covTs ? +covTs.p50.toFixed(3) : null,
    coverageTs80: covTs ? +covTs.p80.toFixed(3) : null,
    fragile: sens.fragile,
    verdictCounts,
    capBindingRows,
    recompute: recompute.summary,
    dossierBytes: dossier.length,
    dataJsBytes: Buffer.byteLength(dataJs, 'utf8'),
  }, null, 2));
}

// Recompute every board row from the serialized dashboard params alone
// (the same inputs the page has) and compare against the board.
function verifyFromParams(data: {
  params: {
    knots: [number, number]; slopes: [number, number, number]; intercept: number;
    feats: string[]; featCoefs: number[]; centers?: FeatureCenters;
    capS: number;
    quantiles: { strata: Record<number, BandQuantiles>; global: BandQuantiles };
    compTvlMin: number; compTvlMax: number;
  };
  comps: number[][];
  rows: string;
  cats: [string, number, number, number][];
}, scored: ScoredRow[], snap: Snapshot): { pass: boolean; firstMismatch: string; summary: string } {
  const P = data.params;
  const catDelta = new Map(data.cats.map((c) => [c[0], c[1]]));
  const lad = (x: number): number => ladderValue(x, P.knots, P.slopes);
  const predictLog = (x: number, days: number | null, grow: number | null, nChains: number, cat: string | null): number => {
    let v = P.intercept + lad(x);
    for (let i = 0; i < P.feats.length; i++) {
      const f = P.feats[i]!;
      if (f === 'age') v += P.featCoefs[i]! * (days === null ? 0 : Math.log1p(Math.min(days, 1825) / 180) - P.centers!.ageMed);
      else if (f === 'grow') v += P.featCoefs[i]! * (grow === null ? 0 : Math.tanh(clamp(grow, P.centers!.growLo, P.centers!.growHi) / 40));
      else if (f === 'chain') v += P.featCoefs[i]! * (Math.log1p(Math.min(nChains, 10) - 1) - P.centers!.chainMed);
    }
    return v + (cat === null ? 0 : (catDelta.get(cat) ?? 0));
  };
  const compTvls = data.comps.map((c) => c[0]!);
  const compMcaps = data.comps.map((c) => c[1]!);
  const capFor = (predUsd: number, tvl: number): number => {
    let m: number | null = null;
    for (let i = 0; i < compTvls.length; i++) {
      const t = compTvls[i]!;
      if (t >= tvl / 3 && t <= tvl * 3) { const mc = compMcaps[i]!; if (m === null || mc > m) m = mc; }
    }
    return m === null ? predUsd : Math.min(predUsd, m * (1 + P.capS));
  };
  let checked = 0;
  let maxDrift = 0;
  for (const r of scored) {
    const x = log10(r.tvl_usd / 50000000);
    const yHat = predictLog(x, r.days, r.change_7d, Math.max(1, r.chains.length), r.category);
    const capped = capFor(Math.pow(10, yHat), r.tvl_usd);
    const p50 = Math.round(capped);
    if (p50 !== r.implied_value_usd) {
      return { pass: false, firstMismatch: `${r.slug}: recomputed p50 ${p50} != board ${r.implied_value_usd}`, summary: '' };
    }
    maxDrift = Math.max(maxDrift, Math.abs(p50 - r.implied_value_usd));
    checked++;
  }
  return { pass: true, firstMismatch: '', summary: `recomputed ${checked}/${checked} rows exact, max drift $${maxDrift}` };
}

main();
