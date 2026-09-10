/* 条件付きロジット（Plackett–Luce）で 1〜3着の並びを当てはめる。Node 標準のみ。
       U_i = β・x_i,   P(i が1着) = exp(U_i) / Σ_j exp(U_j)
   南関側と同じ2段構成。
     第1段 … オッズを使わない基礎モデル
     第2段 … log p_基礎 と log p_人気（オッズ）を合成。第1項の係数が
              「市場に何を足せているか」の答え。0 に近ければ自前情報に価値がない
   pre（番組表だけ）と ex（直前情報あり）の2レベルを同時に出す。
     BT_FIT_SPLIT … 学習と検証を切る日付（既定 20260601）
   出力: data/boat/model.json */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, readJSON, writeJSON } from './lib/bt.mjs';
import { FEATS, NF, raceFeatures } from './lib/bfeat.mjs';

const SPLIT = process.env.BT_FIT_SPLIT || '20260601';
const EPOCH = Number(process.env.BT_FIT_EPOCH || 60);
const L2 = Number(process.env.BT_FIT_L2 || 2e-4);
const LR = Number(process.env.BT_FIT_LR || 0.05);
const DB = readJSON(process.env.BT_FIT_DB || 'data/boat/index.json');
const ST = readJSON('data/boat/stadium.json');

/* ---- レースを組み立てる（K に B の番組表を突き合わせる）---- */
console.error('データを読む…');
const prog = new Map();
for (const line of fs.readFileSync(path.join(ROOT, 'data/boat/programs.jsonl'), 'utf8').split('\n')) {
  if (!line) continue;
  const o = JSON.parse(line);
  prog.set(`${o.date}|${o.jcd}|${o.r}`, o);
}
const races = [];
for (const line of fs.readFileSync(path.join(ROOT, 'data/boat/results.jsonl'), 'utf8').split('\n')) {
  if (!line) continue;
  const k = JSON.parse(line);
  const b = prog.get(`${k.date}|${k.jcd}|${k.r}`);
  if (!b) continue;
  const byLane = new Map(b.boats.map(x => [x.lane, x]));
  const boats = k.entries.map(e => ({ ...byLane.get(e.lane), ...e, lane: e.lane }));
  if (boats.length !== 6 || boats.some(x => x.toban == null || x.natWin == null)) continue;
  /* 着順。失格・欠場は「3着より下」として扱い、1〜3着の並びだけを尤度に使う */
  const order = [1, 2, 3].map(p => boats.findIndex(x => Number(x.pos) === p));
  if (order.some(i => i < 0)) continue;
  races.push({ ...k, boats, order });
}
console.error(`  ${races.length} レース（${races[0].date} 〜 ${races.at(-1).date}）`);

const tr = races.filter(r => r.date < SPLIT), te = races.filter(r => r.date >= SPLIT);
console.error(`  学習 ${tr.length}R（〜${SPLIT}）／検証 ${te.length}R`);

/* ---- Plackett–Luce ---- */
function pack(rs, level) {
  return rs.map(r => ({ X: raceFeatures(r, r.boats, DB, ST, { level }), order: r.order }));
}
function probs(X, beta) {
  const u = X.map(x => { let s = 0; for (let k = 0; k < NF; k++) s += beta[k] * x[k]; return s; });
  const m = Math.max(...u);
  const e = u.map(v => Math.exp(v - m));
  const s = e.reduce((a, b) => a + b, 0);
  return e.map(v => v / s);
}
/* 1〜3着の並びの対数尤度と勾配 */
function gradOne(X, order, beta, g) {
  const n = X.length;
  const u = X.map(x => { let s = 0; for (let k = 0; k < NF; k++) s += beta[k] * x[k]; return s; });
  const live = new Set(X.map((_, i) => i));
  let ll = 0;
  for (const win of order) {
    const idx = [...live];
    const m = Math.max(...idx.map(i => u[i]));
    const e = idx.map(i => Math.exp(u[i] - m));
    const s = e.reduce((a, b) => a + b, 0);
    ll += u[win] - m - Math.log(s);
    for (let k = 0; k < NF; k++) {
      let exp = 0;
      idx.forEach((i, j) => { exp += (e[j] / s) * X[i][k]; });
      g[k] += X[win][k] - exp;
    }
    live.delete(win);
  }
  void n;
  return ll;
}
function fit(data, label) {
  const beta = new Float64Array(NF);
  const m = new Float64Array(NF), v = new Float64Array(NF);
  const g = new Float64Array(NF);
  for (let ep = 1; ep <= EPOCH; ep++) {
    g.fill(0);
    let ll = 0;
    for (const d of data) ll += gradOne(d.X, d.order, beta, g);
    for (let k = 0; k < NF; k++) g[k] = g[k] / data.length - L2 * beta[k];
    for (let k = 0; k < NF; k++) {
      m[k] = 0.9 * m[k] + 0.1 * g[k];
      v[k] = 0.999 * v[k] + 0.001 * g[k] * g[k];
      const mh = m[k] / (1 - Math.pow(0.9, ep)), vh = v[k] / (1 - Math.pow(0.999, ep));
      beta[k] += LR * mh / (Math.sqrt(vh) + 1e-8);
    }
    if (ep % 20 === 0) console.error(`    ${label} ep${ep} 対数尤度/R ${(ll / data.length).toFixed(4)}`);
  }
  return beta;
}
function evaluate(data, beta) {
  let ll = 0, hit1 = 0, in3 = 0, n = 0;
  const cal = Array.from({ length: 10 }, () => ({ p: 0, y: 0, n: 0 }));
  for (const d of data) {
    const p = probs(d.X, beta);
    const w = d.order[0];
    ll -= Math.log(Math.max(1e-9, p[w]));
    const rank = p.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]).map(x => x[1]);
    if (rank[0] === w) hit1++;
    if (rank.slice(0, 3).includes(w)) in3++;
    n++;
    p.forEach((v, i) => { const b = cal[Math.min(9, Math.floor(v * 10))]; b.p += v; b.y += i === w ? 1 : 0; b.n++; });
  }
  return { logloss: ll / n, hit1: hit1 / n, in3: in3 / n, n, cal: cal.map(b => b.n ? { p: +(b.p / b.n).toFixed(3), y: +(b.y / b.n).toFixed(3), n: b.n } : null) };
}

const out = { meta: { built: new Date().toISOString().slice(0, 10), split: SPLIT, feats: FEATS, train: tr.length, test: te.length, from: races[0].date, to: races.at(-1).date } };
for (const level of ['pre', 'ex']) {
  console.error(`第1段（${level}）を当てはめる…`);
  const trd = pack(tr, level), ted = pack(te, level);
  const beta = fit(trd, level);
  const ev = evaluate(ted, beta);
  out[level] = { beta: [...beta].map(v => +v.toFixed(4)), test: ev };
  console.error(`  ${level}: logloss ${ev.logloss.toFixed(3)}／1着的中 ${(ev.hit1 * 100).toFixed(1)}%／上位3艇に勝ち艇 ${(ev.in3 * 100).toFixed(1)}%`);
  console.error('  係数（絶対値の大きい順）: ' + [...beta].map((v, i) => [FEATS[i], v]).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 12).map(([k, v]) => `${k} ${v.toFixed(3)}`).join(' / '));
}
/* 参考：進入コースだけ（＝枠なり前提の基準）でどこまで当たるか */
{
  const ted = pack(te, 'ex');
  const b = new Float64Array(NF); b[FEATS.indexOf('cz')] = 1;
  out.courseOnly = evaluate(ted, b);
  console.error(`  コースだけ: logloss ${out.courseOnly.logloss.toFixed(3)}／1着的中 ${(out.courseOnly.hit1 * 100).toFixed(1)}%／上位3艇 ${(out.courseOnly.in3 * 100).toFixed(1)}%`);
}
writeJSON('data/boat/model.json', out);
