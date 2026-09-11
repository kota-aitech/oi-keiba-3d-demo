/* JRA の人的要因・コースのデータベースを結果（data/jra/results.jsonl）から作る → data/jra/index.json
   南関の build_db.mjs と同じ考え方：
     指数 = 母平均に対する勝率の縮小ロジット（0 が平均、+0.7 でおよそ勝率2倍）
     騎手・調教師は相関するので、コンビ指数は wJ×騎手 + wT×調教師 で期待される勝率からの上振れ（残差）
   加えてコース（場×芝ダ×距離）の傾向：脚質別の3着内シェア、枠の得失、上がり3Fの平均、ペース分布。
     JRA_DB_FROM / JRA_DB_TO … 母集団の期間（YYYY-MM-DD。検証の先読みを避けるときは TO を検証開始の前日に）
     JRA_DB_OUT … 出力先（既定 data/jra/index.json） */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, writeJSON } from './lib/jra.mjs';

const FROM = process.env.JRA_DB_FROM || '2000-01-01', TO = process.env.JRA_DB_TO || '2999-12-31';
const OUT = process.env.JRA_DB_OUT || 'data/jra/index.json';
const r3 = v => Math.round(v * 1000) / 1000;
const logit = p => Math.log(p / (1 - p));

/* ---- 読み込み ---- */
const races = [];
for (const l of fs.readFileSync(path.join(ROOT, 'data/jra/results.jsonl'), 'utf8').split('\n')) {
  if (!l) continue;
  const r = JSON.parse(l);
  if (r.date < FROM || r.date > TO) continue;
  if (r.surface === '障') continue;                            // 障害は別物。平地だけ
  races.push(r);
}
races.sort((a, b) => a.date.localeCompare(b.date) || a.raceId.localeCompare(b.raceId));
let runs = 0, wins = 0, p3 = 0;
for (const r of races) for (const e of r.entries) { if (typeof e.pos !== 'number') continue; runs++; if (e.pos === 1) wins++; if (e.pos <= 3) p3++; }
const P0 = wins / runs, P3 = p3 / runs, L0 = logit(P0), L3 = logit(P3);
console.error(`${races.length} レース（${races[0]?.date} 〜 ${races.at(-1)?.date}）${runs.toLocaleString()} 走。平均勝率 ${(P0 * 100).toFixed(1)}%／3着内率 ${(P3 * 100).toFixed(1)}%`);

/* ---- 集計 ---- */
const zero = () => ({ n: 0, w: 0, p3: 0 });
const bump = (m, k, e, extra) => { if (!k) return; let v = m.get(k); if (!v) m.set(k, v = { ...zero(), ...extra }); v.n++; if (e.pos === 1) v.w++; if (e.pos <= 3) v.p3++; return v; };
const J = new Map(), T = new Map(), C = new Map(), H = new Map();
const JV = new Map(), JS = new Map(), TS = new Map();            // 騎手×場、騎手×芝ダ、調教師×芝ダ
const yearOf = d => d.slice(0, 4);
const recent = new Date(); recent.setFullYear(recent.getFullYear() - 1);
const RECENT = recent.toISOString().slice(0, 10);
for (const r of races) {
  for (const e of r.entries) {
    if (typeof e.pos !== 'number') continue;
    const j = bump(J, e.jockeyId, e, { name: e.jockey.replace(/^[☆★▲△◇]/, '') });
    if (j && r.date >= RECENT) { j.n1 = (j.n1 || 0) + 1; if (e.pos === 1) j.w1 = (j.w1 || 0) + 1; }
    const t = bump(T, e.trainerId, e, { name: e.trainer, stable: e.stable });
    if (t && r.date >= RECENT) { t.n1 = (t.n1 || 0) + 1; if (e.pos === 1) t.w1 = (t.w1 || 0) + 1; }
    if (e.jockeyId && e.trainerId) bump(C, e.jockeyId + '|' + e.trainerId, e, {});
    bump(JV, e.jockeyId + '|' + r.venue, e, {});
    bump(JS, e.jockeyId + '|' + r.surface, e, {});
    bump(TS, e.trainerId + '|' + r.surface, e, {});
    const h = bump(H, e.horseId, e, { name: e.name });
    if (h) h.last = r.date;
  }
}

/* 縮小ロジット。prior は母平均 or 上位の指数 */
const shrunk = (w, n, prior, k) => logit((w + k * prior) / (n + k)) - logit(prior);
const pOf = l => 1 / (1 + Math.exp(-l));
function actor(m, k = 60, sub = []) {
  const out = {};
  for (const [id, x] of m) {
    if (x.n < 20) continue;
    const i3y = shrunk(x.w, x.n, P0, k);
    const i1y = x.n1 ? shrunk(x.w1 || 0, x.n1, pOf(L0 + i3y), 30) + i3y : i3y;
    const idx = r3(0.7 * i3y + 0.3 * i1y);
    const o = { name: x.name, n: x.n, w: x.w, win: r3(x.w / x.n), top3: r3(x.p3 / x.n), idx, idx3: r3(shrunk(x.p3, x.n, P3, k)), form: r3(i1y - i3y) };
    if (x.stable) o.stable = x.stable;
    for (const [key, map, label] of sub) {
      const by = {};
      for (const [kk, v] of map) {
        if (!kk.startsWith(id + '|') || v.n < 10) continue;
        by[kk.split('|')[1]] = r3(shrunk(v.w, v.n, pOf(L0 + idx), 30) + idx);
      }
      if (Object.keys(by).length) o[key] = by;
      void label;
    }
    out[id] = o;
  }
  return out;
}
const jockey = actor(J, 60, [['byVenue', JV], ['bySurface', JS]]);
const trainer = actor(T, 60, [['bySurface', TS]]);
console.error(`  騎手 ${Object.keys(jockey).length}人／調教師 ${Object.keys(trainer).length}人（20走以上）`);

/* ---- wJ / wT の当てはめ（コンビの二項尤度をグリッドで最大化）---- */
const combos = [...C].map(([k, v]) => { const [j, t] = k.split('|'); return { k, j, t, n: v.n, w: v.w, ji: jockey[j]?.idx ?? 0, ti: trainer[t]?.idx ?? 0 }; });
function ll(wJ, wT, c) {
  let s = 0;
  for (const x of combos) { const p = pOf(L0 + c + wJ * x.ji + wT * x.ti); s += x.w * Math.log(p) + (x.n - x.w) * Math.log(1 - p); }
  return s;
}
let best = { wJ: 1, wT: 1, c: 0, v: -Infinity };
for (let wJ = 0.3; wJ <= 1.25; wJ += 0.05) for (let wT = 0.2; wT <= 1.25; wT += 0.05) for (let c = -0.15; c <= 0.15; c += 0.05) {
  const v = ll(wJ, wT, c); if (v > best.v) best = { wJ, wT, c, v };
}
const FIT = { wJ: r3(best.wJ), wT: r3(best.wT), c: r3(best.c) };
console.error(`  当てはめ: 勝率ロジット = ${r3(L0)} ${FIT.c >= 0 ? '+' : ''}${FIT.c} + ${FIT.wJ}×騎手 + ${FIT.wT}×調教師`);
const combo = {};
const stableRuns = new Map(); for (const x of combos) stableRuns.set(x.t, (stableRuns.get(x.t) || 0) + x.n);
const jockeyRuns = new Map(); for (const x of combos) jockeyRuns.set(x.j, (jockeyRuns.get(x.j) || 0) + x.n);
for (const x of combos) {
  if (x.n < 10) continue;
  const lExp = L0 + FIT.c + FIT.wJ * x.ji + FIT.wT * x.ti, pExp = pOf(lExp);
  const cIdx = r3(logit((x.w + 45 * pExp) / (x.n + 45)) - lExp);
  combo[x.k] = { n: x.n, w: x.w, cIdx, pairIdx: r3(FIT.wJ * x.ji + FIT.wT * x.ti + cIdx), bond: r3(x.n / (stableRuns.get(x.t) || 1)), bondJ: r3(x.n / (jockeyRuns.get(x.j) || 1)) };
}
console.error(`  コンビ ${Object.keys(combo).length}組（10走以上）`);

/* ---- コースの傾向（場×芝ダ×距離）---- */
/* 3角の位置は通過順の最初の数字（コーナー数はコースで違うので「最初のコーナー」で見る）。
   前方＝頭数の半分より前。枠は 1〜8 の得失（3着内シェア ÷ 出走シェア）。 */
const K = new Map();
for (const r of races) {
  const key = `${r.venue}|${r.surface}|${r.dist}`;
  let v = K.get(key); if (!v) K.set(key, v = { venue: r.venue, surface: r.surface, dist: r.dist, races: 0, n: 0, p3: 0, front: 0, frontP3: 0, waku: Array(9).fill(0), wakuP3: Array(9).fill(0), agari: 0, agariN: 0, pace: { S: 0, M: 0, H: 0 }, winTime: 0, winTimeN: 0 });
  v.races++;
  if (r.pace && v.pace[r.pace] != null) v.pace[r.pace]++;
  const n = r.entries.filter(e => typeof e.pos === 'number').length;
  for (const e of r.entries) {
    if (typeof e.pos !== 'number') continue;
    v.n++; const in3 = e.pos <= 3; if (in3) v.p3++;
    const c1 = e.pass ? Number(e.pass.split('-')[0]) : null;
    if (c1 != null && c1 <= n / 2) { v.front++; if (in3) v.frontP3++; }
    if (e.waku >= 1 && e.waku <= 8) { v.waku[e.waku]++; if (in3) v.wakuP3[e.waku]++; }
    if (e.agari) { v.agari += e.agari; v.agariN++; }
    if (e.pos === 1 && e.time) { const [m, s] = e.time.split(':').map(Number); v.winTime += m * 60 + s; v.winTimeN++; }
  }
}
const course = {};
for (const [key, v] of K) {
  if (v.races < 5) continue;
  const p3 = v.p3 / v.n;
  course[key] = {
    venue: v.venue, surface: v.surface, dist: v.dist, races: v.races,
    front3: r3(v.frontP3 / Math.max(1, v.p3)),                 // 3着内のうち前方にいた割合
    frontShare: r3(v.front / v.n),                             // 前方にいた出走シェア（基準）
    waku: v.waku.slice(1).map((n, i) => n ? r3((v.wakuP3[i + 1] / v.p3) / (n / v.n)) : null),   // 1.0 が損得なし
    agari: v.agariN ? r3(v.agari / v.agariN) : null,
    winTime: v.winTimeN ? r3(v.winTime / v.winTimeN) : null,
    pace: v.pace, p3: r3(p3),
  };
}
console.error(`  コース ${Object.keys(course).length}通り（5レース以上）`);

/* ---- 馬（参照用。前走の無い転入馬などの突き合わせと、ページの「この馬の通算」に使う）---- */
const horse = {};
for (const [id, x] of H) horse[id] = { name: x.name, n: x.n, w: x.w, p3: x.p3, last: x.last };

writeJSON(OUT, {
  meta: { built: new Date().toISOString().slice(0, 10), from: races[0]?.date, to: races.at(-1)?.date, races: races.length, runs, P0: r3(P0), P3: r3(P3), L0: r3(L0), L3: r3(L3), fit: FIT,
    note: '指数は「JRA 平地の平均勝率に対する対数オッズ差」。0 が平均、+0.7 でおよそ勝率2倍。20走未満の主体は載せない' },
  jockey, trainer, combo, course, horse,
});
const top = (o, n = 8) => Object.values(o).filter(x => x.n >= 200).sort((a, b) => b.idx - a.idx).slice(0, n).map(x => `${x.name} ${x.idx}`).join(' / ');
console.error(`  騎手上位: ${top(jockey)}`);
console.error(`  調教師上位: ${top(trainer)}`);
console.error(`-> ${OUT} (${(fs.statSync(path.join(ROOT, OUT)).size / 1024).toFixed(0)} KB)`);
