/* 出馬表ページ（race.html）と予想ページ（index.html）に載せる予想印を作る。

   印と勝率は**条件付きロジット**（fit_model.mjs の係数）で出す。
   3Dシミュレータは順位予測に向かないことが検証で分かったので、
   予測はロジット、シミュレータは「この馬場条件だとどう走るか」を見る道具、と役割を分けている。
   3角・4角の平均位置とペースはシミュレータの出力をそのまま使う（そこは物理のほうが素直）。

   ※ embed_db.mjs のあとに実行すること（index.html の傾向データを読むため）。
   出力: entries.<track>.json を更新し、race.html と index.html に埋め直す       */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, readJSON, writeJSON } from './lib/nk.mjs';
import { inject } from './lib/embed.mjs';
import { loadModel, condOf } from './lib/model.mjs';
import { makeFeaturizer, buildLapIndex, FEATURES } from './lib/feat.mjs';

const TRACKS = (process.env.NK_RACE_TRACKS || '大井:oi,川崎:kawasaki').split(',').map(s => s.split(':')[1]);
const JA = { oi: '大井', kawasaki: '川崎', funabashi: '船橋', urawa: '浦和' };
const N = Number(process.env.NK_MARK_TRIALS || 600);
const MARKS = ['◎', '○', '▲', '△', '△', '☆'];
const r3 = x => Math.round(x * 1000) / 1000;

const MODELFILE = fs.existsSync(path.join(ROOT, 'data/nankan/model.live.json'))
  ? 'data/nankan/model.live.json' : 'data/nankan/model.json';
const MDL = fs.existsSync(path.join(ROOT, MODELFILE)) ? readJSON(MODELFILE) : null;
const DB = readJSON(process.env.NK_MARK_DB || 'data/nankan/index.json');
const featurize = makeFeaturizer(DB);
/* 取得ジョブが追記中でも壊れないよう、読めない行は捨てる */
const jl = f => fs.readFileSync(path.join(ROOT, 'data/nankan', f), 'utf8').split('\n')
  .filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const cards = new Map(jl('cards.jsonl').map(c => [c.raceId, c]));
/* オッズがあれば第2段（人気との合成）まで使う。
   締切前スナップショット（watch_odds.mjs）を最優先、無ければ最終オッズ。 */
const oddsMap = new Map();
for (const o of jl('odds.jsonl')) oddsMap.set(o.raceId, { src: '最終', tan: o.tan });
for (const o of jl('odds_live.jsonl')) if (o.tag !== 'final') oddsMap.set(o.raceId, { src: `締切前(発走${o.minsToPost}分前)`, tan: o.tan });
const LAP = buildLapIndex(jl('results.jsonl'), [...cards.values()]);
if (!MDL) console.error('!! model.json がない。印はシミュレータの勝率で出す');

const softmax = us => { const mx = Math.max(...us); const e = us.map(u => Math.exp(u - mx)); const z = e.reduce((a, b) => a + b, 0); return e.map(x => x / z); };
function logitP(f) {
  const { mean, sd, beta } = MDL;
  return softmax(f.rows.map(h => FEATURES.reduce((s, k, i) => s + beta[i] * ((h.x[k] - mean[k]) / sd[k]), 0)));
}
/* 3着以内に入る確率（Harville）。三連系の期待値を見るときの土台にもなる */
function top3Of(p) {
  const n = p.length, out = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    let s = p[i];
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const r1 = 1 - p[j];
      if (r1 <= 0) continue;
      s += p[j] * p[i] / r1;
      for (let k = 0; k < n; k++) {
        if (k === i || k === j) continue;
        const r2 = 1 - p[j] - p[k];
        if (r2 <= 0) continue;
        s += p[j] * (p[k] / r1) * (p[i] / r2);
      }
    }
    out[i] = Math.min(1, s);
  }
  return out;
}

const ent = { meta: null };
for (const key of TRACKS) {
  const M = loadModel(key);
  const d = readJSON(`data/nankan/entries.${key}.json`);
  let done = 0, noModel = 0;
  for (const [dk, list] of Object.entries(d.days)) {
    for (const r of list) {
      const rk = `${dk}|${r.r}`;
      const all = d.entries[rk] || [];
      const live = all.filter(h => !h.scratch);
      if (live.length < 2) continue;

      /* シミュレータ：3角・4角の平均位置とペース（馬場条件つき） */
      const cond = condOf(M, r.dist);
      const mc = M.monteCarlo({ dist: r.dist, horses: live.map(h => ({ ...h })) }, cond, N);

      /* 予測：ロジット */
      let p = null;
      const card = cards.get(r.raceId);
      if (MDL && card) {
        const f = featurize(card, cond.baba, null, LAP);
        if (f) {
          const pl = logitP(f);
          p = live.map(h => { const i = f.rows.findIndex(x => x.no === h.no); return i >= 0 ? pl[i] : null; });
          if (p.some(x => x == null)) p = null;
        }
      }
      if (!p) { p = mc.win.slice(); noModel++; }

      /* 単勝オッズがあれば第2段で合成する（検証では人気と互角まで来る） */
      let blended = null;
      const od = oddsMap.get(r.raceId);
      if (MDL && MDL.beta2 && od) {
        const o = live.map(h => (od.tan[h.no] || {}).odds);
        if (o.every(x => x > 0)) {
          const inv = o.map(x => 1 / x), z = inv.reduce((a, b) => a + b, 0);
          const pp = inv.map(x => x / z);
          const u = p.map((x, i) => MDL.beta2[0] * Math.log(Math.max(x, 1e-9)) + MDL.beta2[1] * Math.log(pp[i]));
          const mx = Math.max(...u), ex = u.map(x => Math.exp(x - mx)), sz = ex.reduce((a, b) => a + b, 0);
          blended = ex.map(x => x / sz);
          live.forEach((h, i) => { h.pubOdds = o[i]; h.pFund = r3(p[i]); });
          r.oddsSrc = od.src;
          p = blended;
        }
      }
      const t3 = top3Of(p);

      const order = p.map((w, i) => [w, t3[i], i]).sort((a, b) => b[0] - a[0] || b[1] - a[1]);
      const mark = {};
      order.forEach(([, , i], q) => { if (q < MARKS.length) mark[i] = MARKS[q]; });
      live.forEach((h, i) => {
        h.win = r3(p[i]); h.top3 = r3(t3[i]);
        h.simWin = r3(mc.win[i]);
        h.c3 = r3(mc.c3[i]); h.c4 = r3(mc.c4[i]);
        h.mark = mark[i] || '';
        h.rank = order.findIndex(([, , j]) => j === i) + 1;
      });
      r.pace = mc.pace.label;
      r.cond = cond;
      r.winTime = r3(mc.winTime);
      done++;
    }
  }
  const blendN = Object.values(d.days).flat().filter(r => r.oddsSrc).length;
  d.meta = { ...d.meta, marks: { trials: N, model: MDL ? MODELFILE : null, blended: blendN,
    note: MDL ? `印と勝率は条件付きロジット${blendN ? `（${blendN}レースは単勝オッズと合成）` : '（オッズなし）'}。3角/4角の位置とペースはシミュレータ` : 'モデル未生成のためシミュレータの勝率' } };
  writeJSON(`data/nankan/entries.${key}.json`, d);
  ent[key] = { track: d.track, days: d.days, entries: d.entries };
  ent.meta = d.meta;
  console.error(`${JA[key] || key}: ${done} レースに印（ロジット${done - noModel} / シミュレータ${noModel} / うちオッズ合成 ${blendN}）`);
}
inject('race.html', 'NKRACE', 'NKR', ent);

/* index.html にも「本紙予想」の確率を渡す（races.*.json 側にも同じ値を入れる） */
const light = {};
for (const key of TRACKS) {
  const rp = `data/nankan/races.${key}.json`;
  if (!fs.existsSync(path.join(ROOT, rp))) continue;
  const R = readJSON(rp);
  for (const [rk, hs] of Object.entries(R.real)) {
    const src = (ent[key].entries[rk] || []);
    for (const h of hs) {
      const s = src.find(x => x.no === h.no);
      if (s) { h.pWin = s.win; h.pTop3 = s.top3; h.mark = s.mark; }
    }
  }
  writeJSON(rp, R);
  light[key] = { days: R.days, real: R.real };
}
console.error('races.*.json にも本紙予想を書き戻した（index.html は embed_db で反映）');
