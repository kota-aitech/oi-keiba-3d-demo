/* 印ごとの単勝・複勝の回収率を出す。「◎を単勝で買い続けたらどうなるか」を見るため。
   複勝の払戻は結果ページ（payouts.jsonl の fuku）に3着までの各馬ぶんが入っている。
   出力: data/nankan/marksrec.json                                            */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, readJSON, writeJSON } from './lib/nk.mjs';
import { makeFeaturizer, buildLapIndex, buildShikenIndex, FEATURES } from './lib/feat.mjs';

const TRACKS = (process.env.NK_MR_TRACKS || '大井,川崎,船橋,浦和').split(',');
const FROM = process.env.NK_MR_FROM || '2026-06-01';
const TO = process.env.NK_MR_TO || new Date().toLocaleDateString('sv-SE');
const UNIT = 100;
const MARKS = ['◎', '○', '▲', '△1', '△2', '☆'];

const DB = readJSON(process.env.NK_MR_DB || 'data/nankan/index.train.json');
const MDL = readJSON('data/nankan/model.json');
const featurize = makeFeaturizer(DB);
const jl = f => fs.readFileSync(path.join(ROOT, 'data/nankan', f), 'utf8').split('\n').filter(Boolean)
  .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const cards = jl('cards.jsonl'), resArr = jl('results.jsonl');
const LAP = buildLapIndex(resArr, cards);
/* 能力・調教試験（新馬・転入初戦の手がかり）*/
try { LAP.shiken = buildShikenIndex(jl('shiken.jsonl')); } catch { LAP.shiken = null; }
const results = new Map(resArr.map(r => [r.raceId, r]));
const payouts = new Map(jl('payouts.jsonl').map(p => [p.raceId, p]));
const oddsMap = new Map(jl('odds.jsonl').map(o => [o.raceId, o]));
const softmax = us => { const mx = Math.max(...us); const e = us.map(u => Math.exp(u - mx)); const z = e.reduce((a, b) => a + b, 0); return e.map(x => x / z); };

const blank = () => ({ n: 0, win: 0, place: 0, tanCost: 0, tanRet: 0, fukuCost: 0, fukuRet: 0, popSum: 0, oddsSum: 0 });
const byMark = {}, byMarkPop = {};
for (const m of MARKS) byMark[m] = blank();
const byTrack = {};
let races = 0, noOdds = 0;

for (const c of cards) {
  if (!TRACKS.includes(c.track) || c.date < FROM || c.date > TO) continue;
  const res = results.get(c.raceId), pay = payouts.get(c.raceId), od = oddsMap.get(c.raceId);
  if (!res || !pay || res.order.length < 3) continue;
  const f = featurize(c, res.baba, null, LAP);
  if (!f) continue;
  const live = c.horses.filter(h => !h.scratch);
  const pl = softmax(f.rows.map(h => FEATURES.reduce((s, k, i) => s + MDL.beta[i] * ((h.x[k] - MDL.mean[k]) / MDL.sd[k]), 0)));
  let p = live.map(h => { const i = f.rows.findIndex(x => x.no === h.no); return i >= 0 ? pl[i] : null; });
  if (p.some(x => x == null)) continue;
  /* 印は本番と同じく「オッズがあれば合成」した確率で決める */
  let usedOdds = false;
  if (od && MDL.beta2) {
    const o = live.map(h => (od.tan[h.no] || {}).odds);
    if (o.every(x => x > 0)) {
      const inv = o.map(x => 1 / x), z = inv.reduce((a, b) => a + b, 0);
      const pm = inv.map(x => x / z);
      p = softmax(p.map((x, i) => MDL.beta2[0] * Math.log(Math.max(x, 1e-9)) + MDL.beta2[1] * Math.log(pm[i])));
      usedOdds = true;
    }
  }
  if (!usedOdds) { noOdds++; continue; }        // オッズなしは印の付き方が変わるので除く
  races++;
  const rank = p.map((x, i) => [x, i]).sort((a, b) => b[0] - a[0]).map(([, i]) => i);
  const tanPay = Object.fromEntries((pay.pay.tan || []).map(q => [q.c, q.yen]));
  const fukuPay = Object.fromEntries((pay.pay.fuku || []).map(q => [q.c, q.yen]));
  const T = byTrack[c.track] ||= Object.fromEntries(MARKS.map(m => [m, blank()]));

  rank.slice(0, MARKS.length).forEach((idx, q) => {
    const no = live[idx].no, m = MARKS[q];
    const pos = res.order.indexOf(no) + 1;
    const o = od && od.tan[no] ? od.tan[no] : null;
    for (const acc of [byMark[m], T[m]]) {
      acc.n++;
      acc.tanCost += UNIT; acc.fukuCost += UNIT;
      if (o) { acc.popSum += o.pop || 0; acc.oddsSum += o.odds || 0; }
      if (pos === 1) { acc.win++; acc.tanRet += tanPay[String(no)] || 0; }
      if (pos >= 1 && pos <= 3) { acc.place++; acc.fukuRet += fukuPay[String(no)] || 0; }
    }
  });
}
const fin = o => {
  for (const e of Object.values(o)) {
    e.winRate = e.n ? +(e.win / e.n).toFixed(4) : 0;
    e.placeRate = e.n ? +(e.place / e.n).toFixed(4) : 0;
    e.tanRoi = e.tanCost ? +(e.tanRet / e.tanCost).toFixed(4) : 0;
    e.fukuRoi = e.fukuCost ? +(e.fukuRet / e.fukuCost).toFixed(4) : 0;
    e.avgPop = e.n ? +(e.popSum / e.n).toFixed(1) : 0;
    e.avgOdds = e.n ? +(e.oddsSum / e.n).toFixed(1) : 0;
  }
  return o;
};
fin(byMark); for (const t of Object.values(byTrack)) fin(t);
writeJSON('data/nankan/marksrec.json', { builtAt: new Date().toISOString(), from: FROM, to: TO,
  unit: UNIT, races, skippedNoOdds: noOdds, marks: MARKS, all: byMark, byTrack });

console.error(`対象 ${races} レース（${FROM}〜${TO}／オッズなしで除外 ${noOdds}）`);
console.error('印   頭数  勝率   複勝率  単勝回収  複勝回収  平均人気');
for (const m of MARKS) {
  const e = byMark[m];
  console.error(`${m.padEnd(3)} ${String(e.n).padStart(5)} ${(e.winRate * 100).toFixed(1).padStart(5)}% ${(e.placeRate * 100).toFixed(1).padStart(6)}% ${(e.tanRoi * 100).toFixed(0).padStart(7)}% ${(e.fukuRoi * 100).toFixed(0).padStart(8)}% ${String(e.avgPop).padStart(7)}`);
}
