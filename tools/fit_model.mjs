/* 条件付きロジット（Plackett–Luce）を実データに当てはめる。依存ゼロ・Node標準のみ。

     U_i = β・x_i                     … 馬ごとの強さ（単位は対数オッズ）
     P(i が1着) = exp(U_i) / Σ_j exp(U_j)
     1〜3着の並びまで使う（Plackett–Luce）ので、勝ち馬だけより情報量が多い。

   第1段  オッズを使わない基礎モデル            → p_fund
   第2段  log p_fund と log p_public を合成      → p_final
          第2段の係数が「人気に何を足せているか」の答えになる。

   使い方: node tools/fit_model.mjs
   出力: data/nankan/model.json                                              */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, readJSON, writeJSON } from './lib/nk.mjs';
import { makeFeaturizer, buildLapIndex, FEATURES } from './lib/feat.mjs';

const DBFILE = process.env.NK_FIT_DB || 'data/nankan/index.json';
const SPLIT = process.env.NK_FIT_SPLIT || '2026-06-01';   // これ以降を検証に回す
const L2 = Number(process.env.NK_FIT_L2 || 2.0);
const ITER = Number(process.env.NK_FIT_ITER || 4000);

const jl = f => fs.readFileSync(path.join(ROOT, 'data/nankan', f), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const DB = readJSON(DBFILE);
const featurize = makeFeaturizer(DB);
const resArr = jl('results.jsonl');
const cardArr = jl('cards.jsonl');
const LAP = buildLapIndex(resArr, cardArr);
const results = new Map(resArr.map(r => [r.raceId, r]));
const oddsMap = new Map((fs.existsSync(path.join(ROOT, 'data/nankan/odds.jsonl')) ? jl('odds.jsonl') : []).map(o => [o.raceId, o]));

/* ---- 1. 学習データを組む ---- */
const races = [];
for (const card of cardArr) {
  const res = results.get(card.raceId);
  if (!res || res.order.length < 3) continue;
  const f = featurize(card, res.baba, null, LAP);
  if (!f) continue;
  const nos = new Set(f.rows.map(r => r.no));
  const order = res.order.filter(no => nos.has(no));
  if (order.length < 3) continue;
  f.order = order;
  const od = oddsMap.get(card.raceId);
  if (od) f.rows.forEach(r => { const t = od.tan[r.no]; r.odds = t && t.odds > 0 ? t.odds : null; r.pop = t ? t.pop : null; });
  races.push(f);
}
races.sort((a, b) => a.raceId.localeCompare(b.raceId));
const train = races.filter(r => r.date < SPLIT), test = races.filter(r => r.date >= SPLIT);
console.error(`学習 ${train.length} レース（${train[0]?.date}〜） / 検証 ${test.length} レース（${test[0]?.date}〜）`);
console.error(`オッズあり ${races.filter(r => r.rows.some(x => x.odds)).length} レース`);
if (train.length < Number(process.env.NK_FIT_MIN || 200)) { console.error('学習データが足りない。fetch_results.mjs を先に流すこと。'); process.exit(1); }

/* ---- 2. 標準化 ---- */
const mean = {}, sd = {};
for (const k of FEATURES) {
  const v = [];
  for (const r of train) for (const h of r.rows) v.push(h.x[k]);
  const m = v.reduce((a, b) => a + b, 0) / v.length;
  const s = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length) || 1;
  mean[k] = m; sd[k] = s;
}
const vec = h => FEATURES.map(k => (h.x[k] - mean[k]) / sd[k]);
for (const r of races) r.rows.forEach(h => h.v = vec(h));

/* ---- 3. Plackett–Luce の対数尤度と勾配 ---- */
const D = FEATURES.length;
function llGrad(rs, beta, l2) {
  let ll = 0;
  const g = new Float64Array(D);
  for (const r of rs) {
    const u = r.rows.map(h => { let s = 0; for (let k = 0; k < D; k++) s += beta[k] * h.v[k]; return s; });
    const idx = new Map(r.rows.map((h, i) => [h.no, i]));
    const alive = r.rows.map((_, i) => i);
    for (let step = 0; step < 3; step++) {
      const win = idx.get(r.order[step]);
      if (win == null) break;
      let mx = -Infinity;
      for (const i of alive) if (u[i] > mx) mx = u[i];
      let z = 0;
      const w = [];
      for (const i of alive) { const e = Math.exp(u[i] - mx); w.push(e); z += e; }
      ll += (u[win] - mx) - Math.log(z);
      // exp は1頭につき1回だけ。特徴量ごとに計算し直すと29倍遅くなる
      for (let a2 = 0; a2 < alive.length; a2++) {
        const p = w[a2] / z, vv = r.rows[alive[a2]].v;
        for (let k = 0; k < D; k++) g[k] -= p * vv[k];
      }
      for (let k = 0; k < D; k++) g[k] += r.rows[win].v[k];
      alive.splice(alive.indexOf(win), 1);
      if (alive.length < 2) break;
    }
  }
  for (let k = 0; k < D; k++) { ll -= l2 * beta[k] * beta[k] / 2; g[k] -= l2 * beta[k]; }
  return { ll, g };
}

/* Adam で最大化 */
function fit(rs, l2, iters) {
  const beta = new Float64Array(D);
  const m = new Float64Array(D), v = new Float64Array(D);
  const a = 0.05, b1 = 0.9, b2 = 0.999, eps = 1e-8;
  let last = -Infinity;
  for (let t = 1; t <= iters; t++) {
    const { ll, g } = llGrad(rs, beta, l2);
    for (let k = 0; k < D; k++) {
      m[k] = b1 * m[k] + (1 - b1) * g[k];
      v[k] = b2 * v[k] + (1 - b2) * g[k] * g[k];
      beta[k] += a * (m[k] / (1 - b1 ** t)) / (Math.sqrt(v[k] / (1 - b2 ** t)) + eps);
    }
    if (t % 500 === 0) { console.error(`  iter ${t}  logL ${ll.toFixed(1)}`); if (ll - last < 1e-4) break; last = ll; }
  }
  return beta;
}
console.error('第1段（オッズなし）を当てはめ中…');
const beta = fit(train, L2, ITER);

/* ---- 4. 確率を出すユーティリティ ---- */
const softmax = us => { const mx = Math.max(...us); const e = us.map(u => Math.exp(u - mx)); const z = e.reduce((a, b) => a + b, 0); return e.map(x => x / z); };
const pFund = r => softmax(r.rows.map(h => { let s = 0; for (let k = 0; k < D; k++) s += beta[k] * h.v[k]; return s; }));
/* 市場の確率＝単勝オッズの逆数を正規化（控除率を割り戻す） */
function pPublic(r) {
  if (!r.rows.every(h => h.odds)) return null;
  const inv = r.rows.map(h => 1 / h.odds);
  const z = inv.reduce((a, b) => a + b, 0);
  return inv.map(x => x / z);
}

/* ---- 5. 第2段：基礎モデルと人気の合成 ----
   第2段を「第1段の学習に使ったレース」で当てはめると、第1段の過学習ぶんまで
   価値があるように見えてしまう。学習期間を時系列で3分割し、
   各ブロックを残り2ブロックで学習したモデルで予測した out-of-fold の確率を使う。  */
const softmaxU = (rows, b) => softmaxArr(rows.map(h => { let s = 0; for (let k = 0; k < b.length; k++) s += b[k] * h.v[k]; return s; }));
function softmaxArr(us) { const mx = Math.max(...us); const e = us.map(u => Math.exp(u - mx)); const z = e.reduce((a, b) => a + b, 0); return e.map(x => x / z); }

function fitStage2(rows) {
  const D2 = 2;
  const b = new Float64Array(D2).fill(0.5);
  const m = new Float64Array(D2), v = new Float64Array(D2);
  for (let t = 1; t <= 3000; t++) {
    const g = new Float64Array(D2);
    for (const r of rows) {
      const u = r.rows.map(h => b[0] * h.v[0] + b[1] * h.v[1]);
      const idx = new Map(r.rows.map((h, i) => [h.no, i]));
      const alive = r.rows.map((_, i) => i);
      for (let step = 0; step < 3; step++) {
        const win = idx.get(r.order[step]); if (win == null) break;
        const mx = Math.max(...alive.map(i => u[i]));
        let z = 0; const w = [];
        for (const i of alive) { const e = Math.exp(u[i] - mx); w.push(e); z += e; }
        for (let a2 = 0; a2 < alive.length; a2++) {
          const p = w[a2] / z, vv = r.rows[alive[a2]].v;
          for (let k = 0; k < D2; k++) g[k] -= p * vv[k];
        }
        for (let k = 0; k < D2; k++) g[k] += r.rows[win].v[k];
        alive.splice(alive.indexOf(win), 1);
        if (alive.length < 2) break;
      }
    }
    for (let k = 0; k < D2; k++) {
      m[k] = 0.9 * m[k] + 0.1 * g[k]; v[k] = 0.999 * v[k] + 0.001 * g[k] * g[k];
      b[k] += 0.01 * (m[k] / (1 - 0.9 ** t)) / (Math.sqrt(v[k] / (1 - 0.999 ** t)) + 1e-8);
    }
  }
  return Array.from(b);
}

let beta2 = null;
{
  const K = 3, n = train.length, oof = [];
  console.error(`第2段（人気との合成）を out-of-fold で当てはめ中… ${K}分割`);
  for (let f = 0; f < K; f++) {
    const lo = Math.floor(n * f / K), hi = Math.floor(n * (f + 1) / K);
    const tr = [...train.slice(0, lo), ...train.slice(hi)], va = train.slice(lo, hi);
    const bf = fit(tr, L2, Math.min(ITER, 1200));
    for (const r of va) {
      const pp = pPublic(r);
      if (!pp) continue;
      const pf = softmaxU(r.rows, bf);
      oof.push({ ...r, rows: r.rows.map((h, i) => ({ ...h, v: [Math.log(pf[i]), Math.log(pp[i])] })) });
    }
    console.error(`  fold ${f + 1}/${K}: 学習 ${tr.length} → 検証 ${va.length}`);
  }
  if (oof.length >= 200) {
    beta2 = fitStage2(oof);
    console.error(`  係数: 基礎モデル ${beta2[0].toFixed(3)} ／ 人気 ${beta2[1].toFixed(3)}（out-of-fold ${oof.length} レース）`);
  }
}

/* ---- 6. 評価 ---- */
function evaluate(rs, probFn, label) {
  let ll = 0, n = 0, top1 = 0, in3 = 0, cover = 0;
  for (const r of rs) {
    const p = probFn(r);
    if (!p) continue;
    n++;
    const wi = r.rows.findIndex(h => h.no === r.order[0]);
    ll += Math.log(Math.max(p[wi], 1e-9));
    const rank = p.map((x, i) => [x, i]).sort((a, b) => b[0] - a[0]).map(([, i]) => i);
    if (rank[0] === wi) top1++;
    if (rank.slice(0, 3).includes(wi)) in3++;
    const t3 = r.order.slice(0, 3).map(no => r.rows.findIndex(h => h.no === no));
    if (t3.every(i => rank.slice(0, 3).includes(i))) cover++;
  }
  if (!n) { console.error(`${label.padEnd(22)} 対象レースなし`); return { label, races: 0 }; }
  const o = { label, races: n, logloss: +(-ll / n).toFixed(4), top1: +(top1 / n).toFixed(4),
    winnerInTop3: +(in3 / n).toFixed(4), top3Exact: +(cover / n).toFixed(4) };
  console.error(`${label.padEnd(22)} n=${String(n).padStart(4)}  logloss ${o.logloss.toFixed(3)}  1着的中 ${(o.top1 * 100).toFixed(1)}%  上位3頭に勝ち馬 ${(o.winnerInTop3 * 100).toFixed(1)}%  3頭独占 ${(o.top3Exact * 100).toFixed(1)}%`);
  return o;
}
const pFinal = r => {
  const pf = pFund(r), pp = pPublic(r);
  if (!beta2 || !pp) return null;
  return softmax(pf.map((x, i) => beta2[0] * Math.log(x) + beta2[1] * Math.log(pp[i])));
};
console.error('\n=== 検証データ（' + SPLIT + ' 以降）');
const metrics = {
  train: evaluate(train, pFund, '第1段 学習データ'),
  fund: evaluate(test, pFund, '第1段 オッズなし'),
  pub: evaluate(test.filter(pPublic), pPublic, '単勝人気だけ'),
  final: evaluate(test.filter(pPublic), pFinal, '第2段 合成'),
};

/* ---- 7. 係数を人が読める形で ---- */
const coefs = FEATURES.map((k, i) => ({ f: k, beta: +beta[i].toFixed(4), perSD: +beta[i].toFixed(4) }))
  .sort((a, b) => Math.abs(b.beta) - Math.abs(a.beta));
console.error('\n=== 効いている特徴量（標準化1つぶんの対数オッズ）');
coefs.slice(0, 14).forEach(c => console.error(`  ${c.f.padEnd(10)} ${c.beta >= 0 ? '+' : ''}${c.beta}`));

writeJSON('data/nankan/model.json', {
  builtAt: new Date().toISOString(), db: DBFILE, split: SPLIT, l2: L2,
  features: FEATURES, mean, sd, beta: Array.from(beta), beta2, metrics, coefs,
  trainRaces: train.length, testRaces: test.length,
});
