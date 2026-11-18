// Implied Radar — dashboard. No network. The page re-derives the fit from
// raw embedded fields and proves board.json == page model ($0 drift).
// D1: no launch probability — conditional implied value only. D2: no
// name-based rule in the model. D3: gas, deposit, drop share, hold days and
// the 4.5% opportunity cost are DISCLOSED ASSUMPTIONS, labeled at every use.
// D4: growth is a bounded tanh feature, zero unless dual-gated. D5:
// listed_at is tracking tenure, a maturity proxy. D6: chain breadth is a
// bounded log-count, nonnegative, dual-gated. D7: category offsets are
// Empirical-Bayes, only with >= 6 traded comps. Full selection (LOO refits,
// CV) runs in the entry program; the page re-derives from embedded selected
// parameters and states that honestly.
(function () {
'use strict';
var D = window.RADAR_DATA, P = D.params, META = D.meta, VAL = D.validation;
// Rows arrive as one pipe-delimited line each (name first; slugs omitted —
// names are unique in the snapshot). Parse into the 10-field row the rest
// of the page uses, with an empty slug slot at index 0.
D.rows = D.rows.split('\n').map(function (s) { var f = s.split('|'); return ['', f[0], +f[1], +f[2], +f[3], +f[4], f[5] === '' ? null : +f[5], f[6] === '' ? null : +f[6], +f[7], f[8]]; });
var VERDICTS = ['Farm', 'Marginal', 'Research only', 'Skip'];
var VCLASS = ['v-Farm', 'v-Marginal', 'v-Research', 'v-Skip'];
function fmtInt(n) { return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
function fmtUsd(n) { return '$' + fmtInt(n); }
function fmtMoney(n) { var a = Math.abs(n); if (a >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B'; if (a >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M'; if (a >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K'; return '$' + n.toFixed(0); }
function fmtPct(x, d) { return (x * 100).toFixed(d === undefined ? 1 : d) + '%'; }
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function $(id) { return document.getElementById(id); }
function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }
// Row: [slug,name,catIdx,chainIdx,nChains,tvl,chg,days,watch,digest]
// (central value, bands, rank interval, verdict and steps are re-derived
// and proven against the digest; extrapolated is derived from TVL vs the
// comp range)
function catName(r) { return r[2] < 0 ? null : D.cats[r[2]][0]; }
function catSupport(r) { return r[2] < 0 ? 0 : D.cats[r[2]][2]; }
function peerRate(r) { return r[2] < 0 ? META.peerGlobal : D.cats[r[2]][3]; }
function chainName(r) { return D.chains[r[3]] || ''; }
function isExtrap(r) { return r[5] < P.compTvlMin || r[5] > P.compTvlMax; }
function stratum(r) { if (r[7] === null) return 3; return catSupport(r) >= 6 ? 1 : 2; }
function ladderValue(x, knots, slopes) {
  if (slopes[0] === slopes[1] && slopes[1] === slopes[2]) return slopes[0] * x;
  if (x <= knots[0]) return slopes[0] * x;
  if (x <= knots[1]) return slopes[0] * knots[0] + slopes[1] * (x - knots[0]);
  return slopes[0] * knots[0] + slopes[1] * (knots[1] - knots[0]) + slopes[2] * (x - knots[1]);
}
function predictLog(r) {
  var x = Math.log10(r[5] / 50000000);
  var v = P.intercept + ladderValue(x, P.knots, P.slopes);
  for (var i = 0; i < P.feats.length; i++) {
    var f = P.feats[i];
    if (f === 'age') v += P.featCoefs[i] * (r[7] === null ? 0 : Math.log1p(Math.min(r[7], 1825) / 180) - P.centers.ageMed);
    else if (f === 'grow') v += P.featCoefs[i] * (r[6] === null ? 0 : Math.tanh(clamp(r[6], P.centers.growLo, P.centers.growHi) / 40));
    else if (f === 'chain') v += P.featCoefs[i] * (Math.log1p(Math.min(r[4], 10) - 1) - P.centers.chainMed);
  }
  return v + (r[2] < 0 ? 0 : D.cats[r[2]][1]);
}
function capFor(predUsd, t) {
  var m = null;
  for (var i = 0; i < D.comps.length; i++) { var ct = D.comps[i][0]; if (ct >= t / 3 && ct <= t * 3) { var mc = D.comps[i][1]; if (m === null || mc > m) m = mc; } }
  return m === null ? predUsd : Math.min(predUsd, m * (1 + P.capS));
}
function bandValues(r) {
  var yHat = predictLog(r), uncapped = Math.pow(10, yHat), capped = capFor(uncapped, r[5]);
  var q = P.quantiles.strata[stratum(r)] || P.quantiles.global, g = P.quantiles.global;
  var q10 = q.q10, q25 = q.q25, q75 = q.q75, q90 = q.q90;
  if (isExtrap(r)) { q10 = Math.min(q10, g.q10); q25 = Math.min(q25, g.q25); q75 = Math.max(q75, g.q75); q90 = Math.max(q90, g.q90); }
  var capVal = capped < uncapped ? capped : Infinity;
  function band(qq) { var v = Math.pow(10, yHat + qq); return Math.round(capVal === Infinity ? v : Math.min(v, capVal)); }
  return { p50: Math.round(capped), p25: band(q25), p75: band(q75), p10: band(q10), p90: band(q90) };
}
var GAS = { eth: [18, 45, 110], alt: [1.5, 4, 12], l2: [0.8, 2.5, 8], other: [2, 6, 18] };
var ALT_L1 = 'Solana|Binance|Avalanche|Bitcoin|Tron|Sui|Aptos|Hyperliquid L1';
var L2 = 'Arbitrum|Optimism|Base|Polygon|Scroll|Linea|zkSync Era|Starknet|Blast|Mantle|Berachain|Sonic';
function gasTier(c) { if (c === 'Ethereum') return 'eth'; if (('|' + ALT_L1 + '|').indexOf('|' + c + '|') >= 0) return 'alt'; if (('|' + L2 + '|').indexOf('|' + c + '|') >= 0) return 'l2'; return 'other'; }
function computeFarmEconomics(r, deposit, alphaDrop, gasScenario) {
  var g = GAS[gasTier(chainName(r))], multi = r[4] >= 2;
  var gasBase = g[1] + (multi ? 7.5 : 0), gasHigh = g[2] + (multi ? 18 : 0), gasLow = g[0] + (multi ? 3 : 0);
  var d = r[7], tDays = d === null || d < 365 ? 45 : d < 730 ? 60 : 75;
  var tHours = Math.min(3, 1.5 + 0.25 * Math.max(0, r[4] - 1));
  var eta = 1.25, rOpp = 0.045, share = deposit / (r[5] * eta);
  var b = bandValues(r);
  var grossP50 = b.p50 * alphaDrop * share, grossP25 = b.p25 * alphaDrop * share;
  var oppCost = deposit * rOpp * (tDays / 365);
  var gas = gasScenario === 'low' ? gasLow : gasScenario === 'high' ? gasHigh : gasBase;
  var totalCostBase = gas + oppCost, totalCostHigh = gasHigh + oppCost;
  var netP50 = grossP50 - totalCostBase, netP25 = grossP25 - totalCostHigh;
  return { deposit: deposit, alphaDrop: alphaDrop, gasLow: gasLow, gasBase: gasBase, gasHigh: gasHigh, oppCost: oppCost, tDays: tDays, tHours: tHours, share: share, grossP50: grossP50, grossP25: grossP25, totalCostBase: totalCostBase, totalCostHigh: totalCostHigh, netP50: netP50, netP25: netP25, netPerHour: netP50 / tHours, pBe: grossP50 > 0 ? Math.min(1, totalCostBase / grossP50) : 2, alphaBe: b.p50 * share > 0 ? totalCostBase / (b.p50 * share) : 2, fdvBreakeven: alphaDrop * share > 0 ? totalCostBase / (alphaDrop * share) : Infinity, dMin: grossP50 > 0 ? (2 * gasBase) / (b.p50 * alphaDrop / (r[5] * eta)) : deposit, dMax: Math.min(0.005 * r[5], 50000), p75: b.p75, p25: b.p25 };
}
function researchReasons(r) {
  var out = [];
  if (r[7] === null) out.push('listed_at null — tracking history unverified');
  if (r[2] < 0) out.push('category null — uncalibrated');
  else if (catSupport(r) < 6) out.push('category uncalibrated (fewer than 6 traded comps)');
  if (peerRate(r) === 0) out.push('peer tokenization rate is 0 in this snapshot');
  return out;
}
function assignVerdict(r, e) {
  if (researchReasons(r).length > 0) return 'Research only';
  if (e.netP50 > 0 && e.netP25 > 0 && e.pBe <= 0.45 && e.netPerHour >= 25) return 'Farm';
  if (e.netP50 > 0 && e.pBe <= 0.75) return 'Marginal';
  return 'Skip';
}
function categoryAction(cat) {
  switch (cat) {
    case 'Dexs': return 'swap and add liquidity';
    case 'Lending': return 'supply collateral and borrow modestly';
    case 'Derivatives': return 'open modest hedged volume';
    case 'Yield': case 'Yield Aggregator': return 'deposit into the yield vault';
    case 'CDP': return 'mint against collateral';
    case 'RWA': return 'use the tokenized-asset position';
    default: return 'use the native interaction';
  }
}
function buildFarmPlan(r, e, verdict, researchOnly) {
  var chain = chainName(r) || 'its primary chain';
  var multi = r[4] >= 2 ? ' Multi-chain: repeat staging on each extra chain inside the gas reserve.' : '';
  var dys = r[7] === null ? 'unknown' : String(r[7]);
  var cg = r[6] === null ? 'unreported' : (r[6] >= 0 ? '+' : '') + r[6].toFixed(1) + '%';
  var core = researchOnly ? 'dry-run and documentation verification, $0 committed' : categoryAction(catName(r));
  var exitAction = verdict === 'Farm' || verdict === 'Marginal' ? 'unwind at the token-generation announcement or the day cap' : 'deploy $0 and monitor only';
  var b = bandValues(r);
  return [
    'Eligibility check (~10 min, $0): confirm ' + r[1] + ' still records no token and TVL ' + fmtMoney(r[5]) + ' keeps ' + fmtUsd(e.deposit) + ' inside the optimal [' + fmtUsd(e.dMin) + '–' + fmtUsd(e.dMax) + '] window. Evidence: snapshot TVL, category, chains. Stop: abort if a cutoff is announced or TVL dilutes past 2x.',
    'Capital staging (~15 min, ' + fmtUsd(e.gasBase) + ' base gas, ' + fmtUsd(e.gasHigh) + ' high — assumed, not live quotes): stage ' + fmtUsd(e.deposit) + ' on ' + chain + ', keep a gas reserve inside the high-scenario ceiling.' + multi + ' Evidence: snapshot chains[0]. Stop: abort if a real gas quote tops ' + fmtUsd(e.gasHigh) + ' before the first deposit.',
    'Core interaction (~20 min, ' + fmtUsd(e.gasBase) + ' gas + ' + fmtUsd(e.oppCost) + ' opportunity cost): ' + core + ' on ' + chain + '; 7-day TVL trend is ' + cg + '. Evidence: snapshot category and change_7d. Stop: exit if 7-day TVL falls more than 35%.',
    'Tenure cadence (' + e.tDays + '-day hold, ~10 min/week, ' + fmtUsd(e.oppCost) + ' opportunity cost at assumed 4.5% APR): hold ' + e.tDays + ' days; tracking tenure is ' + dys + ' days, a maturity proxy. Evidence: snapshot listed_at. Stop: withdraw if the break-even FDV hurdle ' + fmtMoney(e.fdvBreakeven) + ' exceeds the P75 upside ' + fmtMoney(e.p75) + '.',
    'Break-even audit (~10 min, $0): conditional slice P50 ' + fmtMoney(e.grossP50) + ' and P25 stress ' + fmtMoney(e.grossP25) + ' vs total cost ' + fmtUsd(e.totalCostBase) + '; required launch odds ' + fmtPct(e.pBe, 0) + ', break-even drop share ' + fmtPct(e.alphaBe, 1) + '. Evidence: fitted P25–P75 plus break-even hurdles. Stop: reclassify to Skip if dilution cuts net P50 below zero.',
    'Exit (~15 min, exit gas about ' + fmtUsd(e.gasBase * 0.5) + '): ' + exitAction + ' for the ' + verdict + ' verdict on a conditional value of ' + fmtMoney(b.p50) + ' (P25 ' + fmtMoney(b.p25) + '). Evidence: recomputed verdict. Stop: mandatory unwind at the ' + e.tDays + '-day cap.'
  ];
}
function stepHash(steps) {
  var h = 0x811c9dc5, s = steps.join('\n');
  for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return ('0000000' + h.toString(16)).slice(-8);
}
var PROOF = { pass: false, checked: 0, ms: 0, firstMismatch: '', log: [] };
var CENTRALS = [];
function verifyRecomputeProof() {
  var t0 = performance.now(), rows = D.rows, n = rows.length;
  var centrals = [], rec = [];
  for (var i = 0; i < n; i++) {
    var r = rows[i], b = bandValues(r), e = computeFarmEconomics(r, 2500, 0.06, 'base');
    var v = assignVerdict(r, e), steps = buildFarmPlan(r, e, v, researchReasons(r).length > 0);
    rec.push({ b: b, v: v, hash: stepHash(steps) });
    centrals.push(b.p50);
  }
  CENTRALS = centrals;
  var pass = true, first = '', checked = 0;
  for (var j = 0; j < n; j++) {
    var rj = rows[j], rc = rec[j], rb = 1, rw = 1;
    for (var k = 0; k < n; k++) { if (k === j) continue; if (centrals[k] > rc.b.p90) rb++; if (centrals[k] > rc.b.p10) rw++; }
    var digest = stepHash([rc.b.p50 + '|' + rc.b.p25 + '|' + rc.b.p75 + '|' + rc.b.p10 + '|' + rc.b.p90 + '|' + rb + '|' + rw + '|' + rc.v + '|' + rc.hash]);
    if (digest !== rj[9]) { pass = false; first = rj[1] + ': recomputed digest ' + digest + ' vs stored ' + rj[9]; break; }
    checked++;
  }
  var c = META.census, sum = c.hold + c.watch + c.below + c.aboveNonWatch + c.setCat + c.setName + c.refFit + c.refOther;
  if (sum !== META.nSnap) { pass = false; first = 'census sums to ' + sum + ', snapshot holds ' + META.nSnap; }
  if (c.watch !== META.watchN) { pass = false; first = 'watchlist bucket ' + c.watch + ' != supplied ' + META.watchN; }
  var ms = performance.now() - t0;
  PROOF = { pass: pass, checked: checked, ms: ms, firstMismatch: first,
    log: ['fit re-derived from embedded parameters', 'values re-derived for ' + n + ' rows; ' + checked + ' digests exact (digest binds central value, bands, rank interval, verdict, steps)', 'rank intervals re-derived from P10/P90', 'verdicts + 6 farm steps re-derived, hash-checked', 'census sums to ' + sum + ' = snapshot; watchlist ' + c.watch + '/' + META.watchN, 'recompute time ' + ms.toFixed(1) + ' ms'] };
  return PROOF;
}
// ---- rendering (compact builders; every visual element carries evidence)
var state = { q: '', cat: '', chain: '', scope: 'all', verdict: '', deposit: 2500, alpha: 0.06, gas: 'base', sort: 'rank', compare: [], selected: -1, tab: 'radar' };
function full(i) {
  var r = D.rows[i], b = bandValues(r), e = computeFarmEconomics(r, state.deposit, state.alpha, state.gas);
  return { r: r, b: b, e: e, v: assignVerdict(r, e) };
}
function tbl(heads, rows) { return '<table><thead><tr>' + heads.map(function (h) { return '<th>' + h + '</th>'; }).join('') + '</tr></thead><tbody>' + rows.join('') + '</tbody></table>'; }
function kv(pairs) { return '<div class="kv">' + pairs.map(function (p) { return '<div><b>' + p[0] + '</b>' + p[1] + '</div>'; }).join('') + '</div>'; }
function sel(id, label, opts, cur) { return '<label>' + label + ' <select id="' + id + '">' + opts.map(function (o) { return '<option value="' + o[0] + '"' + (String(o[0]) === String(cur) ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select></label>'; }
function vBadge(v) { return '<span class="badge ' + VCLASS[VERDICTS.indexOf(v)] + '">' + v + '</span>'; }
function rankInterval(r) {
  var b = bandValues(r), rb = 1, rw = 1;
  for (var k = 0; k < CENTRALS.length; k++) { if (CENTRALS[k] > b.p90) rb++; if (CENTRALS[k] > b.p10) rw++; }
  return { b: b, rb: rb, rw: rw };
}
function riBar(rb, rw, rank) {
  var n = D.rows.length;
  return '<span class="ribar"><i style="left:' + ((rb - 1) / n * 100).toFixed(1) + '%;width:' + Math.max(2, (rw - rb + 1) / n * 100).toFixed(1) + '%"></i><span class="dot" style="left:' + ((rank - 0.5) / n * 100).toFixed(1) + '%"></span></span> [' + rb + '–' + rw + ']';
}
function renderHeader() {
  var vc = META.verdictCounts;
  $('kpis').innerHTML =
    '<div class="kpi"><span>Snapshot</span><b>' + esc(META.asOf) + ' · ' + META.census.watch + '/' + META.watchN + ' watchlist</b></div>' +
    '<div class="kpi"><span>Board</span><b>' + META.nBoard + ' pre-token ranked · ' + META.nSnap + ' accounted</b></div>' +
    '<div class="kpi"><span>LOO error vs flat</span><b>' + VAL.loo.medErr.toFixed(2) + '× vs ' + VAL.loo.baseA.toFixed(2) + '×</b></div>' +
    '<div class="kpi"><span>Time-split error vs flat</span><b>' + (VAL.ts ? VAL.ts.medErr.toFixed(2) + '× vs ' + VAL.ts.baseA.toFixed(2) + '×' : 'not estimable') + '</b></div>' +
    '<div class="kpi"><span>Verdicts ($2,500 / 6%)</span><b>' + (vc.Farm || 0) + ' Farm · ' + (vc.Marginal || 0) + ' Marginal · ' + (vc['Research only'] || 0) + ' Research · ' + (vc.Skip || 0) + ' Skip</b></div>';
  var pv = $('proofValue'), ps = $('proofSub');
  if (PROOF.pass) { pv.textContent = 'VERIFIED (' + PROOF.checked + '/' + D.rows.length + ' digests exact, drift $0)'; pv.classList.remove('bad'); ps.textContent = 'recompute ' + PROOF.ms.toFixed(1) + ' ms · click for the check log'; }
  else { pv.textContent = 'MISMATCH — ' + (PROOF.firstMismatch || 'proof failed'); pv.classList.add('bad'); ps.textContent = 'the page disagrees with the board; no agreement is claimed'; }
  $('drill').innerHTML = '<b>Recompute drill-down.</b><br>' + PROOF.log.map(esc).join('<br>') + (PROOF.firstMismatch ? '<br><span class="err">First mismatch: ' + esc(PROOF.firstMismatch) + '</span>' : '');
  var c = META.census;
  var parts = [['Watchlist', c.watch, '#f5b544'], ['Below-floor', c.below, '#2dd4bf'], ['Above-floor', c.aboveNonWatch, '#818cf8'], ['Set aside (cat)', c.setCat, '#f87171'], ['Set aside (name)', c.setName, '#fb923c'], ['Fitted comps', c.refFit, '#a78bfa'], ['Other refs', c.refOther, '#475569'], ['Hold', c.hold, '#334155']];
  $('censusStrip').innerHTML = '<span><b>' + META.nSnap + ' protocols accounted</b> — buckets sum to the snapshot:</span><div class="census-bar">' + parts.map(function (p) { return '<div style="width:' + (p[1] / META.nSnap * 100).toFixed(2) + '%;background:' + p[2] + '" title="' + esc(p[0]) + ': ' + p[1] + '"></div>'; }).join('') + '</div>';
}
function renderControls() {
  $('controls').innerHTML =
    '<input id="fQ" type="search" placeholder="Search name…" value="' + esc(state.q) + '" aria-label="Search">' +
    sel('fCat', '', [['', 'All categories']].concat(D.cats.map(function (c) { return [c[0], c[0]]; })), state.cat) +
    sel('fChain', '', [['', 'All chains']].concat(D.chains.map(function (c) { return [c, c]; })), state.chain) +
    '<span class="seg" role="group" aria-label="Scope"><button data-scope="all" class="' + (state.scope === 'all' ? 'on' : '') + '">All eligible</button><button data-scope="watch" class="' + (state.scope === 'watch' ? 'on' : '') + '">Watchlist 40</button><button data-scope="below" class="' + (state.scope === 'below' ? 'on' : '') + '">Below $50M</button></span>' +
    sel('fVerdict', '', [['', 'All verdicts']].concat(VERDICTS.map(function (v) { return [v, v]; })), state.verdict) +
    sel('fDeposit', 'Deposit', [[500, '$500'], [2500, '$2,500'], [10000, '$10,000'], [25000, '$25,000']], state.deposit) +
    sel('fAlpha', 'Drop share', [[0.03, '3%'], [0.06, '6%'], [0.1, '10%']], state.alpha) +
    sel('fGas', 'Gas', [['low', 'Low'], ['base', 'Base'], ['high', 'High']], state.gas) +
    sel('fSort', 'Sort', [['rank', 'Rank'], ['tvl', 'TVL'], ['chg', '7d change'], ['nethr', 'Net $/hr'], ['pbe', 'Break-even'], ['ratio', 'P50 / TVL']], state.sort);
  $('fQ').addEventListener('input', function (e) { state.q = e.target.value; renderTable(); });
  $('fCat').addEventListener('change', function (e) { state.cat = e.target.value; renderTable(); });
  $('fChain').addEventListener('change', function (e) { state.chain = e.target.value; renderTable(); });
  $('fVerdict').addEventListener('change', function (e) { state.verdict = e.target.value; renderTable(); });
  $('fDeposit').addEventListener('change', function (e) { state.deposit = +e.target.value; renderTable(); });
  $('fAlpha').addEventListener('change', function (e) { state.alpha = +e.target.value; renderTable(); });
  $('fGas').addEventListener('change', function (e) { state.gas = e.target.value; renderTable(); });
  $('fSort').addEventListener('change', function (e) { state.sort = e.target.value; renderTable(); });
  var seg = document.querySelectorAll('[data-scope]');
  for (var i = 0; i < seg.length; i++) seg[i].addEventListener('click', function (e) { state.scope = e.target.getAttribute('data-scope'); renderControls(); renderTable(); });
}
function renderTable() {
  var list = [];
  for (var i = 0; i < D.rows.length; i++) {
    var r = D.rows[i], f = full(i);
    if (state.q && r[1].toLowerCase().indexOf(state.q.toLowerCase()) < 0) continue;
    if (state.cat && catName(r) !== state.cat) continue;
    if (state.chain && chainName(r) !== state.chain) continue;
    if (state.scope === 'watch' && !r[8]) continue;
    if (state.scope === 'below' && r[8]) continue;
    if (state.verdict && f.v !== state.verdict) continue;
    list.push({ i: i, r: r, f: f });
  }
  var key = state.sort;
  list.sort(function (a, b) {
    if (key === 'tvl') return b.r[5] - a.r[5];
    if (key === 'chg') return (b.r[6] === null ? -Infinity : b.r[6]) - (a.r[6] === null ? -Infinity : a.r[6]);
    if (key === 'nethr') return b.f.e.netPerHour - a.f.e.netPerHour;
    if (key === 'pbe') return a.f.e.pBe - b.f.e.pBe;
    if (key === 'ratio') return (b.f.b.p50 / b.r[5]) - (a.f.b.p50 / a.r[5]);
    return a.i - b.i;
  });
  var html = '';
  for (var k = 0; k < list.length; k++) {
    var item = list[k], rr = item.r, ff = item.f, ri = rankInterval(rr);
    var cg = rr[6] === null ? '<span class="small">n/a</span>' : (rr[6] >= 0 ? '+' : '') + rr[6].toFixed(1) + '%';
    html += '<tr data-i="' + item.i + '" class="' + (state.selected === item.i ? 'sel' : '') + '">' +
      '<td><input type="checkbox" data-cmp="' + item.i + '"' + (state.compare.indexOf(item.i) >= 0 ? ' checked' : '') + ' aria-label="Compare"></td>' +
      '<td class="rank num">' + (item.i + 1) + '</td><td>' + riBar(ri.rb, ri.rw, item.i + 1) + '</td>' +
      '<td><b>' + esc(rr[1]) + '</b><br><span class="small">' + esc(catName(rr) || 'No category') + ' · ' + esc(chainName(rr)) + (rr[4] > 1 ? ' +' + (rr[4] - 1) : '') + '</span><br>' +
      (rr[8] ? '<span class="badge b-watch">WATCHLIST</span> ' : '<span class="badge b-below">BELOW $50M</span>') + (isExtrap(rr) ? ' <span class="badge b-cat">EXTRAPOLATED</span>' : '') + '</td>' +
      '<td class="r num">' + fmtMoney(rr[5]) + '</td><td class="r num">' + cg + '</td><td class="r num">' + (rr[7] === null ? '<span class="warn">Unknown</span>' : rr[7] + 'd') + '</td>' +
      '<td class="r num"><b>' + fmtMoney(ff.b.p50) + '</b></td><td class="r num">' + fmtMoney(ff.b.p25) + ' – ' + fmtMoney(ff.b.p75) + '</td>' +
      '<td class="r num">' + fmtPct(ff.e.pBe, 0) + '</td><td class="r num">' + (ff.e.netPerHour >= 0 ? '' : '−') + fmtUsd(Math.abs(ff.e.netPerHour)) + '/hr</td>' +
      '<td>' + vBadge(ff.v) + (ri.rb <= 10 ? '<br><span class="small">could reach top 10</span>' : '') + '</td></tr>';
  }
  $('radarBody').innerHTML = html;
  $('tableNote').textContent = list.length + ' of ' + D.rows.length + ' rows. Canonical rank stays its own column under every sort; the board never re-ranks. Conditional implied values if a token were issued — not launch forecasts.';
  var boxes = document.querySelectorAll('[data-cmp]');
  for (var i2 = 0; i2 < boxes.length; i2++) boxes[i2].addEventListener('click', function (ev) {
    ev.stopPropagation();
    var idx = +ev.target.getAttribute('data-cmp'), pos = state.compare.indexOf(idx);
    if (pos >= 0) state.compare.splice(pos, 1); else { state.compare.push(idx); if (state.compare.length > 2) state.compare.shift(); }
    renderCompare(); renderTable();
  });
  var rows = document.querySelectorAll('#radarBody tr');
  for (var j = 0; j < rows.length; j++) rows[j].addEventListener('click', function (ev) { if (ev.target.tagName !== 'INPUT') openDrawer(+ev.currentTarget.getAttribute('data-i')); });
  renderCompare();
}
function cmpCells(i) {
  var f = full(i), r = f.r, ri = rankInterval(r);
  return '<td><b>' + esc(r[1]) + '</b><br><span class="small">' + esc(catName(r) || 'No category') + '</span></td>' +
    '<td class="r num">' + fmtMoney(f.b.p50) + '</td><td class="r num">' + fmtMoney(f.b.p25) + ' – ' + fmtMoney(f.b.p75) + '</td>' +
    '<td class="r num">[' + ri.rb + '–' + ri.rw + ']</td><td class="r num">' + fmtPct(f.e.pBe, 0) + '</td>' +
    '<td class="r num">' + fmtUsd(f.e.netPerHour) + '/hr</td><td>' + vBadge(f.v) + '</td>' +
    '<td class="r num">' + fmtMoney(r[5]) + '</td><td class="r num">' + (r[6] === null ? 'n/a' : r[6].toFixed(1) + '%') + '</td>';
}
function renderCompare() {
  var bar = $('compareBar');
  if (state.compare.length < 2) { bar.hidden = true; bar.innerHTML = ''; return; }
  bar.hidden = false;
  bar.innerHTML = '<h3>Head-to-head</h3>' +
    tbl(['Protocol', 'P50', 'P25–P75', 'Rank interval', 'Break-even odds', 'Net $/hr', 'Verdict', 'TVL', '7d'],
      ['<tr>' + cmpCells(state.compare[0]) + '</tr>', '<tr>' + cmpCells(state.compare[1]) + '</tr>']);
}
function openDrawer(i) {
  state.selected = i;
  var f = full(i), r = f.r, e = f.e, v = f.v, b = f.b;
  var rr = researchReasons(r);
  var steps = buildFarmPlan(r, e, v, rr.length > 0);
  var ri = rankInterval(r);
  var ladder = P.slopes.map(function (s, k) { return 's' + (k + 1) + ': ' + s.toFixed(3); }).join(' · ');
  var catD = r[2] < 0 ? 0 : D.cats[r[2]][1];
  var anchors = D.refs.slice().sort(function (a, b2) { return Math.abs(Math.log10(a[2]) - Math.log10(r[5])) - Math.abs(Math.log10(b2[2]) - Math.log10(r[5])); }).slice(0, 3);
  var terms = [];
  if (P.feats.indexOf('age') >= 0) terms.push('tenure ' + (P.featCoefs[P.feats.indexOf('age')] * (r[7] === null ? 0 : Math.log1p(Math.min(r[7], 1825) / 180) - P.centers.ageMed)).toFixed(3) + ' log10');
  if (P.feats.indexOf('grow') >= 0) terms.push('growth ' + (P.featCoefs[P.feats.indexOf('grow')] * (r[6] === null ? 0 : Math.tanh(clamp(r[6], P.centers.growLo, P.centers.growHi) / 40))).toFixed(3) + ' log10');
  if (P.feats.indexOf('chain') >= 0) terms.push('chains ' + (P.featCoefs[P.feats.indexOf('chain')] * (Math.log1p(Math.min(r[4], 10) - 1) - P.centers.chainMed)).toFixed(3) + ' log10');
  var adjusted = state.deposit !== 2500 || state.alpha !== 0.06 || state.gas !== 'base';
  $('drawer').hidden = false;
  $('drawer').innerHTML =
    '<button class="x" id="drawerX">Close ✕</button>' +
    '<div class="kicker">DETAIL · RANK ' + (i + 1) + ' OF ' + D.rows.length + '</div><h2>' + esc(r[1]) + '</h2>' +
    '<p>' + (r[8] ? '<span class="badge b-watch">WATCHLIST</span> ' : '<span class="badge b-below">BELOW $50M</span>') + ' ' + vBadge(v) + ' ' + (ri.rb <= 10 ? '<span class="badge b-watch">COULD REACH TOP 10</span>' : '') + '</p>' +
    kv([['P50', fmtMoney(b.p50)], ['P25–P75', fmtMoney(b.p25) + ' – ' + fmtMoney(b.p75)], ['P10–P90', fmtMoney(b.p10) + ' – ' + fmtMoney(b.p90)], ['Rank interval', '[' + ri.rb + '–' + ri.rw + '] ' + riBar(ri.rb, ri.rw, i + 1)], ['TVL', fmtMoney(r[5])], ['Tracking tenure', r[7] === null ? 'Unknown (imputed)' : r[7] + ' days, a maturity proxy'], ['Category', esc(catName(r) || 'None') + ' · peer tokenization ' + fmtPct(peerRate(r), 0)]]) +
    (isExtrap(r) ? '<p class="warn">EXTRAPOLATED: TVL sits outside the traded-comp range; the band is widened to at least the widest empirical out-of-fold allowance.</p>' : '') +
    '<h3>Model decomposition (log10)</h3><p>Intercept ' + P.intercept.toFixed(3) + ' · ladder (' + ladder + ', λ=' + P.lambda + ') · category effect ' + (catD >= 0 ? '+' : '') + catD.toFixed(3) + ' (support ' + catSupport(r) + ' comps' + (catSupport(r) < 6 ? ', uncalibrated' : '') + ') · ' + (terms.join(' · ') || 'no retained feature terms — every non-TVL feature failed the dual gate (zero central weight)') + '.</p>' +
    '<h3>Closest traded anchors (reference only)</h3><p>' + anchors.map(function (a) { return esc(a[0]) + ' — TVL ' + fmtMoney(a[2]) + ', observed mcap ' + fmtMoney(a[3]); }).join('<br>') + '</p>' +
    '<h3>Net capital economics — ' + fmtUsd(state.deposit) + ' deposit, ' + fmtPct(state.alpha, 0) + ' drop share, ' + state.gas + ' gas (assumed)' + (adjusted ? ' — USER-ADJUSTED SCENARIO; canonical is $2,500 / 6% / base gas' : '') + '</h3>' +
    kv([['Gross slice P50', fmtMoney(e.grossP50)], ['Total cost (base)', fmtUsd(e.totalCostBase)], ['Net P50', fmtUsd(e.netP50)], ['Net P25 stress', fmtUsd(e.netP25)], ['Net $/hour', fmtUsd(e.netPerHour) + '/hr'], ['Break-even odds', fmtPct(e.pBe, 0) + ' (a hurdle, not a forecast)'], ['Break-even drop', fmtPct(e.alphaBe, 1)], ['Break-even FDV', Number.isFinite(e.fdvBreakeven) ? fmtMoney(e.fdvBreakeven) : '—']]) +
    (rr.length ? '<p class="warn">Research only — the snapshot lacks: ' + esc(rr.join('; ')) + '. No economic verdict is supportable; steps below verify documentation only.</p>' : '') +
    '<h3>The 6-step farm plan</h3><ol class="steps">' + steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol>' +
    '<p class="small">Gas is an assumed scenario, not a live quote. The snapshot carries no campaign, reward, fee or principal-risk facts. A high implied value is not a launch forecast, a guaranteed value, or safety evidence.</p>';
  $('drawerX').addEventListener('click', function () { $('drawer').hidden = true; state.selected = -1; renderTable(); });
  renderTable();
}

// ---- scatter, validation tab, census tab, init
function renderScatter() {
  var W = 880, H = 340, PL = 56, PR = 16, PT = 14, PB = 40;
  var xs = D.comps.map(function (c) { return Math.log10(c[0] / 50000000); });
  var ys = D.comps.map(function (c) { return Math.log10(c[1]); });
  var x0 = Math.min.apply(null, xs) - 0.15, x1 = Math.max.apply(null, xs) + 0.15;
  var y0 = Math.min.apply(null, ys) - 0.3, y1 = Math.max.apply(null, ys) + 0.3;
  function X(v) { return PL + (v - x0) / (x1 - x0) * (W - PL - PR); }
  function Y(v) { return PT + (1 - (v - y0) / (y1 - y0)) * (H - PT - PB); }
  var g = P.quantiles.global, curve = '', b80 = '', b50 = '', b80r = '', b50r = '';
  for (var i = 0; i <= 60; i++) {
    var x = x0 + (x1 - x0) * i / 60, y = P.intercept + ladderValue(x, P.knots, P.slopes);
    curve += (i ? 'L' : 'M') + X(x).toFixed(1) + ',' + Y(y).toFixed(1);
    b80 += (i ? 'L' : 'M') + X(x).toFixed(1) + ',' + Y(y + g.q90).toFixed(1);
    b50 += (i ? 'L' : 'M') + X(x).toFixed(1) + ',' + Y(y + g.q75).toFixed(1);
    b80r = 'L' + X(x).toFixed(1) + ',' + Y(y + g.q10).toFixed(1) + b80r;
    b50r = 'L' + X(x).toFixed(1) + ',' + Y(y + g.q25).toFixed(1) + b50r;
  }
  var dots = '';
  for (var k = 0; k < D.comps.length; k++) dots += '<circle cx="' + X(xs[k]).toFixed(1) + '" cy="' + Y(ys[k]).toFixed(1) + '" r="3" fill="#a78bfa" opacity="0.75"/>';
  var sel = '';
  if (state.selected >= 0) {
    var r = D.rows[state.selected], sx = Math.log10(r[5] / 50000000), sy = Math.log10(bandValues(r).p50);
    sel = '<circle cx="' + X(sx).toFixed(1) + '" cy="' + Y(sy).toFixed(1) + '" r="6" fill="none" stroke="#2dd4bf" stroke-width="2"/><text x="' + (X(sx) + 9).toFixed(1) + '" y="' + (Y(sy) - 8).toFixed(1) + '" fill="#2dd4bf" font-size="11">' + esc(r[1]) + '</text>';
  }
  var ticks = '';
  for (var t = Math.ceil(x0); t <= Math.floor(x1); t++) ticks += '<line class="grid" x1="' + X(t) + '" y1="' + PT + '" x2="' + X(t) + '" y2="' + (H - PB) + '"/><text class="axis" x="' + X(t) + '" y="' + (H - PB + 16) + '" text-anchor="middle">$' + (t === 0 ? '50M' : (Math.pow(10, t) * 50).toFixed(0) + 'M') + '</text>';
  $('scatterPanel').innerHTML = '<h2>02 · The fit — log10(market cap) vs log10(TVL), ' + D.comps.length + ' traded comps</h2>' +
    '<div class="scatter-wrap"><svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" role="img" aria-label="Scatter of traded comps with fitted curve and bands">' + ticks +
    '<path d="' + b80 + b80r + 'Z" fill="#2dd4bf" opacity="0.08"/><path d="' + b50 + b50r + 'Z" fill="#2dd4bf" opacity="0.12"/>' +
    '<path d="' + curve + '" fill="none" stroke="#2dd4bf" stroke-width="2"/>' + dots + sel + '</svg></div>' +
    '<p class="small">Teal curve: shrunk ladder (λ=' + P.lambda + ', slopes ' + P.slopes.map(function (s) { return s.toFixed(2); }).join(' / ') + '). Shaded: P25–P75 (darker), P10–P90 (lighter) split-conformal bands from LOO residuals. Violet dots: traded comps. ' +
    (state.selected >= 0 ? 'Teal ring: the selected board row, ' + esc(D.rows[state.selected][1]) + ' — table, scatter and drawer are one instrument.' : 'Select a row to see its place on the curve.') + '</p>';
}
function renderModelTab() {
  renderScatter();
  var L = VAL.loo, T = VAL.ts;
  function vrow(label, m, a, b) { return '<tr><td>' + label + '</td><td class="r num">' + m.toFixed(2) + '×</td><td class="r num">' + a.toFixed(2) + '×</td><td class="r num">' + b.toFixed(2) + '×</td></tr>'; }
  $('validationPanel').innerHTML = '<h2>Out-of-sample validation</h2>' +
    tbl(['Split', 'Final model', 'Flat multiple (A)', 'Global log-log (B)'],
      [vrow('Leave-one-out (n=' + D.comps.length + ')', L.medErr, L.baseA, L.baseB),
       T ? vrow('Chronological time-split (' + T.nTrain + ' train / ' + T.nTest + ' test, boundary ' + T.boundary + ')', T.medErr, T.baseA, T.baseB) : '<tr><td colspan="4">Time-split not estimable: fewer than 10 dated comps.</td></tr>']) +
    '<p>Median multiplicative error; LOO within-2× ' + fmtPct(L.within2x, 0) + ', within-3× ' + fmtPct(L.within3x, 0) + '; Spearman ' + L.spearman.toFixed(2) + '.' +
    (L.medErr > L.baseB ? ' <b>The final model loses to baseline B on LOO by ' + ((L.medErr / L.baseB - 1) * 100).toFixed(1) + '% — stated plainly.</b>' : ' The final model matches or beats both learned baselines on LOO.') +
    ' Coverage (nested OOS): P25–P75 ' + fmtPct(VAL.coverageLoo.p50, 0) + ' (nominal 50%), P10–P90 ' + fmtPct(VAL.coverageLoo.p80, 0) + ' (nominal 80%).' +
    (VAL.coverageTs ? ' Time-split: P25–P75 ' + fmtPct(VAL.coverageTs.p50, 0) + ', P10–P90 ' + fmtPct(VAL.coverageTs.p80, 0) + ' — LOO bands undercover on the newest protocols.' : '') +
    ' Calibration tests on recorded traded comps only: no launch likelihood, future outcomes, causation or issuance timing established.</p>';
  var gh = ['age', 'grow', 'chain'].map(function (f) {
    var g = VAL.gate[f];
    return '<tr><td>' + f + '</td><td class="r num">' + g.before.loo.toFixed(2) + '× → ' + g.after.loo.toFixed(2) + '×</td><td class="r num">' + (g.before.ts === null ? 'n/e' : g.before.ts.toFixed(2) + '×') + ' → ' + (g.after.ts === null ? 'n/e' : g.after.ts.toFixed(2) + '×') + '</td><td>' + (g.retained ? '<b>RETAINED</b>' : 'zeroed — central weight 0') + '</td></tr>';
  });
  $('gatePanel').innerHTML = '<h2>Feature gate ledger</h2>' +
    tbl(['Feature', 'LOO before → after', 'Time-split before → after', 'Decision'], gh) +
    '<p class="small">Retained only if it strictly lowers the mean of both splits’ median errors and worsens neither.</p>';
  $('categoryPanel').innerHTML = '<h2>Category shrinkage — λ=' + (VAL.lambdaCat === 'inf' ? '∞ (all offsets zero)' : VAL.lambdaCat) + '</h2>' +
    tbl(['Category', 'Comps', 'Offset (log10)', 'Peer token rate'],
      D.cats.filter(function (c) { return c[2] > 0; }).map(function (c) {
        return '<tr><td>' + esc(c[0]) + '</td><td class="r num">' + c[2] + '</td><td class="r num">' + (c[1] >= 0 ? '+' : '') + c[1].toFixed(3) + '</td><td class="r num">' + fmtPct(c[3], 0) + '</td></tr>';
      })) +
    '<p class="small">Offsets need ≥6 traded comps; qualifying at support 5 / 6 / 20: ' + VAL.qualifiedAt[5] + ' / ' + VAL.qualifiedAt[6] + ' / ' + VAL.qualifiedAt[20] + '. Peer rate is a historical share — NOT a launch prediction.</p>';
  $('elasticPanel').innerHTML = '<h2>Elasticity ladder</h2><p>Knots at ' + P.knots.map(function (k) { return fmtMoney(Math.pow(10, k) * 50000000); }).join(' · ') + ' (TVL). Single slope ' + P.bBar.toFixed(3) + ' · shrunk slopes ' + P.slopes.map(function (s) { return s.toFixed(3); }).join(' / ') + ' · λ=' + P.lambda + ' (5-fold CV). Cap s=' + P.capS + ' (5-fold CV); binds on ' + META.capBindingRows + ' board rows' + (META.capBindingRows === 0 ? ' — inert, stated as such' : '') + '.</p>';
  var S = VAL.sensitivity;
  $('sensitivityPanel').innerHTML = '<h2>Sensitivity</h2><p>Slope without the 10% highest-leverage comps: ' + S.noLeverageSlope.toFixed(3) + ' (' + fmtPct(S.noLeverageMovePct, 1) + ' move). With a wider integrity window (mcap ≥ $10K, ratio 0.001–1000, n=' + S.wideN + '): ' + S.wideWindowSlope.toFixed(3) + ' (' + fmtPct(S.wideWindowMovePct, 1) + ' move). ' +
    (S.fragile ? '<span class="warn">Fragile: a slope moves &gt;15% under one check.</span>' : '<b>Not fragile</b> by the 15% rule.') + '</p>';
  $('refPanel').innerHTML = '<h2>REFERENCE ONLY — RECORDED TOKENS</h2>' +
    '<p class="small">Observed snapshot market caps, distinct from any model estimate. A CoinGecko identifier proves no liquidity, tradability or safety. Top 8 by TVL.</p>' +
    tbl(['Protocol', 'TVL', 'Observed mcap', 'mcap / TVL'],
      D.refs.map(function (a) { return '<tr><td><b>' + esc(a[0]) + '</b><br><span class="small">' + esc(a[1] || 'No category') + '</span></td><td class="r num">' + fmtMoney(a[2]) + '</td><td class="r num">' + fmtMoney(a[3]) + '</td><td class="r num">' + (a[3] / a[2]).toFixed(2) + '×</td></tr>'; }));
}
function renderCensusTab() {
  var c = META.census;
  var rows = [
    ['Data-quality hold', c.hold, 'Bad numerics/dates — disclosed, never imputed.'],
    ['Pre-token radar — watchlist floor', c.watch, 'TVL ≥ $50M, records no token, on the supplied watchlist.'],
    ['Pre-token radar — below-floor ranked', c.below, 'Eligible pre-token below the floor.'],
    ['Above-floor, not on the supplied watchlist', c.aboveNonWatch, 'Pass the visible screen but absent from the list; the full rule (parent protocol) excluded them. Not ranked.'],
    ['Set aside — pre-token, excluded by category', c.setCat, 'Bridge / Canonical Bridge / Liquid Staking / Liquid Restaking / Restaked BTC / CEX.'],
    ['Set aside — pre-token, excluded by name', c.setName, 'Version suffix, derivative word, or exchange prefix.'],
    ['Reference pool — live traded comps in the fit', c.refFit, 'The fitted comps.'],
    ['Reference pool — live traded, excluded / filtered / missing mcap', c.refOther, 'Missing mcap ' + (META.refOther['missing-mcap'] || 0) + ' · excluded by category ' + (META.refOther['excluded-category'] || 0) + ' · version ' + (META.refOther['excluded-version'] || 0) + ' · derivative ' + (META.refOther['excluded-derivative'] || 0) + ' · dust window ' + (META.refOther['dust'] || 0) + '.']
  ];
  var bar = rows.map(function (r) { return '<div style="width:' + Math.max(0.4, r[1] / META.nSnap * 100).toFixed(2) + '%;background:#2dd4bf" title="' + esc(r[0]) + ': ' + r[1] + '"></div>'; }).join('');
  $('censusPanel').innerHTML = '<h2>The census</h2><div class="census-bar" style="height:26px">' + bar + '</div>' +
    tbl(['Bucket', 'Count', 'What it is'],
      rows.map(function (r) { return '<tr><td>' + esc(r[0]) + '</td><td class="r num"><b>' + r[1] + '</b></td><td>' + esc(r[2]) + '</td></tr>'; })
        .concat(['<tr><td><b>Total</b></td><td class="r num"><b>' + META.nSnap + '</b></td><td>Buckets sum to the snapshot count. Zero-count buckets are shown, not hidden.</td></tr>']));
  $('assumpPanel').innerHTML = '<h2>Assumption registry (D3)</h2>' +
    '<p>Deposit $2,500 (presets 500 / 2,500 / 10,000 / 25,000) · drop 6% of FDV (3 / 6 / 10%) · dilution 1.25× · opportunity cost 4.5% APR · hold 45 / 60 / 75 days by tenure · effort 1.5h + 0.25h per extra chain, cap 3h · verdicts stress-tested at P25. Assumed at every use.</p>' +
    '<p><b>D1</b> No launch probability: no issuance outcomes exist in the snapshot. <b>D2</b> No name-based demotion: only the fitted ladder, cap, shrunken category effects and farm dilution. <b>D4</b> Growth: tanh-bounded, capped at ±log10(1.25), zero unless dual-gated. <b>D5</b> listed_at is tracking tenure, a maturity proxy. <b>D6</b> Chain breadth: bounded log-count, nonnegative, dual-gated. <b>D7</b> Category offsets: Empirical-Bayes, ≥6 comps, λ by 5-fold CV, one-SE rule.</p>';
  $('gasPanel').innerHTML = '<h2>Gas assumption table (D3)</h2>' +
    tbl(['Chain tier', 'Low', 'Base', 'High'],
      [['Ethereum', '$18', '$45', '$110'], ['Alt-L1', '$1.50', '$4.00', '$12.00'], ['Rollups / L2s', '$0.80', '$2.50', '$8.00'], ['Other', '$2.00', '$6.00', '$18.00'], ['Multi-chain (≥2 chains)', '+$3.00', '+$7.50', '+$18.00']]
        .map(function (r) { return '<tr><td>' + r[0] + '</td><td class="r num">' + r[1] + '</td><td class="r num">' + r[2] + '</td><td class="r num">' + r[3] + '</td></tr>'; })) +
    '<p class="small">Assumed scenarios; no live gas data in the snapshot.</p>';
  $('methodPanel').innerHTML = '<h2>Methodology</h2>' +
    '<p>board.json ranks pre-token protocols (mcap_usd, gecko_id, symbol all null — “records no token”) by conditional implied value if a token were issued, from ten snapshot fields only. Huber regression in log10(market cap) on a shrunk piecewise-linear TVL ladder, plus only features that improve BOTH leave-one-out and chronological out-of-sample error, plus Empirical-Bayes category offsets and stratified split-conformal intervals. Gas, deposit, drop share, hold days and 4.5% opportunity cost are DISCLOSED ASSUMPTIONS. listed_at is tracking tenure, not founding age. No launch probability is estimated.</p>' +
    '<p><b>Limits.</b> A deterministic ranking from one sealed snapshot, not investment advice. The model learns cross-sectional links between TVL, recorded market cap and retained features; no causation, no issuance prediction. The snapshot shows no liquidity, supply, mint/freeze authority, distribution, campaign terms, rewards, future prices or fees. A high implied value is not a launch forecast, a guaranteed value, or safety evidence. Research-only means evidence is absent from these inputs. Fee and opportunity-cost scenarios are assumptions, not current facts.</p>' +
    '<p class="small">Functions: buildCensus · classifyProtocol · selectTradedComps · fitLadderModel · selectFeaturesDualOOS · computeConformalBands · scoreProtocol · verifyRecomputeProof · computeFarmEconomics · assignVerdict · buildFarmPlan · renderRadarTable · renderDetailDrawer · renderValidationTab · renderCensusTab.</p>';
}
function showTab(name) {
  state.tab = name;
  var tabs = document.querySelectorAll('.tab');
  for (var i = 0; i < tabs.length; i++) tabs[i].classList.toggle('active', tabs[i].getAttribute('data-tab') === name);
  $('tab-radar').hidden = name !== 'radar';
  $('tab-model').hidden = name !== 'model';
  $('tab-census').hidden = name !== 'census';
  if (name === 'model') renderModelTab();
  if (name === 'census') renderCensusTab();
}
var tabs = document.querySelectorAll('.tab');
for (var ti = 0; ti < tabs.length; ti++) tabs[ti].addEventListener('click', function (e) { showTab(e.target.getAttribute('data-tab')); });
$('proofBadge').addEventListener('click', function () { var d = $('drill'); d.hidden = !d.hidden; });
verifyRecomputeProof();
renderHeader();
renderControls();
renderTable();
renderModelTab();
renderCensusTab();
})();
