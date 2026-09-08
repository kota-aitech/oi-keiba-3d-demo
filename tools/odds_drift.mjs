/* 締切前に拾ったオッズ（T-n）と最終オッズがどれだけ違うかを測る。
   「8分前の数字で判断して間に合うのか」を、印の入れ替わりで見るための道具。
   使い方: node tools/odds_drift.mjs
   入力: data/nankan/odds_live.jsonl（watch_odds.mjs が貯める）              */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './lib/nk.mjs';

const p = path.join(ROOT, 'data/nankan/odds_live.jsonl');
if (!fs.existsSync(p)) { console.error('odds_live.jsonl がまだありません。watch_odds.mjs を動かしてください。'); process.exit(0); }
const rows = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean)
  .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

const byRace = new Map();
for (const r of rows) {
  const e = byRace.get(r.raceId) || {};
  e[r.tag === 'final' ? 'final' : 'pre'] = r;
  e.meta = { date: r.date, R: r.R, track: r.track, post: r.post };
  byRace.set(r.raceId, e);
}
const pairs = [...byRace.values()].filter(e => e.pre && e.final);
if (!pairs.length) {
  const n = [...byRace.values()].filter(e => e.pre).length;
  console.error(`締切前だけ ${n} レース、最終と揃った組はまだ0。レース後にもう一度。`);
  process.exit(0);
}

const norm = tan => {                       // 単勝オッズ → 正規化した市場確率
  const e = Object.entries(tan).filter(([, v]) => v.odds > 0);
  const inv = e.map(([k, v]) => [k, 1 / v.odds]);
  const z = inv.reduce((a, [, v]) => a + v, 0);
  return Object.fromEntries(inv.map(([k, v]) => [k, v / z]));
};
const topN = (o, n) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);

let n = 0, fav = 0, t3same = 0, sumAbs = 0, sumRel = 0, cnt = 0, lead = 0;
for (const e of pairs) {
  const a = norm(e.pre.tan), b = norm(e.final.tan);
  const ks = Object.keys(a).filter(k => b[k] != null);
  if (ks.length < 4) continue;
  n++;
  lead += e.pre.minsToPost;
  if (topN(a, 1)[0] === topN(b, 1)[0]) fav++;
  const A3 = topN(a, 3), B3 = topN(b, 3);
  if (A3.every(x => B3.includes(x))) t3same++;
  for (const k of ks) { sumAbs += Math.abs(a[k] - b[k]); sumRel += Math.abs(a[k] - b[k]) / Math.max(b[k], 1e-4); cnt++; }
}
const pc = x => (x * 100).toFixed(1) + '%';
console.log(`締切前と最終が揃ったレース: ${n}（取得は平均 発走${(lead / n).toFixed(1)}分前）`);
console.log(`  1番人気が入れ替わらなかった : ${pc(fav / n)}`);
console.log(`  上位3頭の顔ぶれが同じ       : ${pc(t3same / n)}`);
console.log(`  市場確率のズレ（絶対値の平均）: ${(sumAbs / cnt * 100).toFixed(2)}pt`);
console.log(`  同（最終に対する相対）       : ${pc(sumRel / cnt)}`);
console.log(`\n上位3頭の顔ぶれが変わらないなら、締切前の数字で買い目を決めても実質差はない。`);
console.log(`ズレが大きいようなら NK_ODDS_LEAD を短くする（例 5分前）ことを検討する。`);
