/* 買い方ごとの的中率・回収率を検証する。
   K ファイルに全券種の払戻金が入っているので、実際の配当でそのまま計算できる
   （南関のように単勝オッズから推定する必要がない）。
     BT_BT_FROM / BT_BT_TO … 検証期間（既定は model.json の検証期間）
     BT_BT_LEVEL … pre | ex（既定 ex）
   1点100円。出力: data/boat/backtest.json */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, readJSON, writeJSON, VNAME } from './lib/bt.mjs';
import { FEATS, NF, raceFeatures } from './lib/bfeat.mjs';

const DB = readJSON(process.env.BT_BT_DB || 'data/boat/index.train.json');
const ST = readJSON('data/boat/stadium.json');
const M = readJSON('data/boat/model.json');
const LEVEL = process.env.BT_BT_LEVEL || 'ex';
const FROM = process.env.BT_BT_FROM || M.meta.split;
const TO = process.env.BT_BT_TO || '99999999';
const beta = Float64Array.from(M[LEVEL].beta);

const prog = new Map();
for (const l of fs.readFileSync(path.join(ROOT, 'data/boat/programs.jsonl'), 'utf8').split('\n')) {
  if (l) { const o = JSON.parse(l); prog.set(`${o.date}|${o.jcd}|${o.r}`, o); }
}
const races = [];
for (const l of fs.readFileSync(path.join(ROOT, 'data/boat/results.jsonl'), 'utf8').split('\n')) {
  if (!l) continue;
  const k = JSON.parse(l);
  if (k.date < FROM || k.date > TO) continue;
  const b = prog.get(`${k.date}|${k.jcd}|${k.r}`);
  if (!b) continue;
  const byLane = new Map(b.boats.map(x => [x.lane, x]));
  const boats = k.entries.map(e => ({ ...byLane.get(e.lane), ...e, lane: e.lane }));
  if (boats.length !== 6 || boats.some(x => x.natWin == null)) continue;
  const fin = [1, 2, 3].map(p => boats.find(x => Number(x.pos) === p));
  if (fin.some(x => !x)) continue;
  races.push({ ...k, boats, fin: fin.map(x => x.lane) });
}
console.error(`検証 ${races.length} レース（${LEVEL}、${races[0]?.date} 〜 ${races.at(-1)?.date}）`);

const softmax = X => {
  const u = X.map(x => { let s = 0; for (let k = 0; k < NF; k++) s += beta[k] * x[k]; return s; });
  const m = Math.max(...u), e = u.map(v => Math.exp(v - m)), s = e.reduce((a, b) => a + b, 0);
  return e.map(v => v / s);
};
/* 1着確率から Plackett–Luce で組の確率を出す */
function triProb(p, a, b, c) {  // 期待値の検証用（当日オッズが貯まったら使う）
  const i = a - 1, j = b - 1, k = c - 1;
  const s1 = 1, s2 = s1 - p[i], s3 = s2 - p[j];
  return s3 > 1e-9 ? p[i] * (p[j] / s2) * (p[k] / s3) : 0;
}
const payOf = (r, kind, code) => { const a = r.pay?.[kind]; const h = a?.find(x => x.c === code); return h ? h.y : 0; };

const P = {};                                   // 買い方 -> {bet, ret, hit, n}
const add = (name, bet, ret, hit) => { const o = P[name] ||= { bet: 0, ret: 0, hit: 0, races: 0 }; o.bet += bet; o.ret += ret; o.hit += hit; o.races++; };
const byDay = {}, byVenue = {};

for (const r of races) {
  const X = raceFeatures(r, r.boats, DB, ST, { level: LEVEL });
  const p = softmax(X);
  const rank = p.map((v, i) => [v, r.boats[i].lane]).sort((a, b) => b[0] - a[0]).map(x => x[1]);
  const pl = Object.fromEntries(r.boats.map((b, i) => [b.lane, p[i]]));
  const [f1, f2, f3] = r.fin;

  /* ★ベンチマーク。ボートは1号艇の1着率が54%あるので、
     「1号艇を毎回買う」に勝てていなければモデルに賭ける価値はない。 */
  add('［基準］1号艇の単勝', 100, f1 === 1 ? payOf(r, 'win', '1') : 0, f1 === 1 ? 1 : 0);
  add('［基準］1号艇の複勝', 100, [f1, f2].includes(1) ? payOf(r, 'place', '1') : 0, [f1, f2].includes(1) ? 1 : 0);
  add('［基準］1-2-3の3連単', 100, (f1 === 1 && f2 === 2 && f3 === 3) ? payOf(r, 'ex3', '1-2-3') : 0, (f1 === 1 && f2 === 2 && f3 === 3) ? 1 : 0);
  add('［基準］123の3連複', 100, [f1, f2, f3].every(x => x <= 3) ? payOf(r, 'tri', '1-2-3') : 0, [f1, f2, f3].every(x => x <= 3) ? 1 : 0);
  add('［基準］1-2-3-4BOX 3連複', 400, [f1, f2, f3].every(x => x <= 4) ? payOf(r, 'tri', [f1, f2, f3].sort((a, b) => a - b).join('-')) : 0, [f1, f2, f3].every(x => x <= 4) ? 1 : 0);

  /* 単勝・複勝（本命） */
  add('◎単勝', 100, rank[0] === f1 ? payOf(r, 'win', String(rank[0])) : 0, rank[0] === f1 ? 1 : 0);
  add('◎複勝', 100, [f1, f2].includes(rank[0]) ? payOf(r, 'place', String(rank[0])) : 0, [f1, f2].includes(rank[0]) ? 1 : 0);

  /* 2連単・2連複 */
  add('◎○の2連単1点', 100, (rank[0] === f1 && rank[1] === f2) ? payOf(r, 'ex2', `${rank[0]}-${rank[1]}`) : 0, (rank[0] === f1 && rank[1] === f2) ? 1 : 0);
  const qn = [rank[0], rank[1]].sort((a, b) => a - b).join('-');
  const qnHit = [f1, f2].sort((a, b) => a - b).join('-') === qn;
  add('◎○の2連複1点', 100, qnHit ? payOf(r, 'qn', qn) : 0, qnHit ? 1 : 0);

  /* 3連単・3連複の BOX */
  for (const k of [3, 4]) {
    const top = rank.slice(0, k);
    const inBox = [f1, f2, f3].every(x => top.includes(x));
    const triCode = [f1, f2, f3].sort((a, b) => a - b).join('-');
    add(`本命${k}艇BOX 3連複`, 100 * (k === 3 ? 1 : 4), inBox ? payOf(r, 'tri', triCode) : 0, inBox ? 1 : 0);
    const ex3n = k === 3 ? 6 : 24;
    add(`本命${k}艇BOX 3連単`, 100 * ex3n, inBox ? payOf(r, 'ex3', `${f1}-${f2}-${f3}`) : 0, inBox ? 1 : 0);
  }
  /* 1着固定の3連単フォーメーション（◎→上位3→上位4）＝6点 */
  {
    const a = rank[0], bs = rank.slice(1, 4), cs = rank.slice(1, 5);
    let n = 0, ret = 0, hit = 0;
    for (const b of bs) for (const c of cs) {
      if (b === c) continue;
      n++;
      if (a === f1 && b === f2 && c === f3) { ret += payOf(r, 'ex3', `${f1}-${f2}-${f3}`); hit = 1; }
    }
    add('◎1着固定 3連単', 100 * n, ret, hit);
  }
  /* 期待値ベースの買い方はここでは測れない。K ファイルには「当たった組の配当」しか
     載っていないので、外れた組のオッズが分からない。当日の odds3t を貯めてから検証する。 */

  const d = (byDay[r.date] ||= { n: 0, hit: 0, bet: 0, ret: 0 });
  const top4 = rank.slice(0, 4), ok = [f1, f2, f3].every(x => top4.includes(x));
  d.n++; d.hit += ok ? 1 : 0; d.bet += 400; d.ret += ok ? payOf(r, 'tri', [f1, f2, f3].sort((a, b) => a - b).join('-')) : 0;
  const v = (byVenue[r.jcd] ||= { name: VNAME[r.jcd], n: 0, hit1: 0, in3: 0, bet: 0, ret: 0 });
  v.n++; v.hit1 += rank[0] === f1 ? 1 : 0; v.in3 += [f1, f2, f3].includes(rank[0]) ? 1 : 0;
  v.bet += 400; v.ret += ok ? payOf(r, 'tri', [f1, f2, f3].sort((a, b) => a - b).join('-')) : 0;
}

const pct = (a, b) => b ? +(100 * a / b).toFixed(1) : null;
console.error('');
console.error('買い方                        レース  的中率  回収率');
const table = {};
for (const [k, o] of Object.entries(P)) {
  table[k] = { races: o.races, hit: pct(o.hit, o.races), roi: pct(o.ret, o.bet), bet: o.bet, ret: o.ret };
  console.error(`  ${k.padEnd(24)} ${String(o.races).padStart(6)} ${String(table[k].hit).padStart(6)}% ${String(table[k].roi).padStart(6)}%`);
}
console.error('');
console.error('場別（本命4艇BOX 3連複）');
for (const [j, v] of Object.entries(byVenue).sort((a, b) => a[0].localeCompare(b[0]))) {
  console.error(`  ${j} ${v.name.padEnd(4)} ${String(v.n).padStart(5)}R  1着的中 ${pct(v.hit1, v.n)}%  上位3艇 ${pct(v.in3, v.n)}%  回収 ${pct(v.ret, v.bet)}%`);
}
writeJSON('data/boat/backtest.json', {
  meta: { level: LEVEL, from: races[0]?.date, to: races.at(-1)?.date, races: races.length },
  table,
  byVenue: Object.fromEntries(Object.entries(byVenue).map(([j, v]) => [j, { ...v, hit1: pct(v.hit1, v.n), in3: pct(v.in3, v.n), roi: pct(v.ret, v.bet) }])),
  byDay: Object.fromEntries(Object.entries(byDay).map(([d, v]) => [d, { ...v, hit: pct(v.hit, v.n), roi: pct(v.ret, v.bet) }])),
});
