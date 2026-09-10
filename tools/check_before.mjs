/* 直前情報にしか無い項目（部品交換・ペラ交換・チルト・調整重量）に予測の価値があるかを
   before.jsonl の標本で測る。モデル（ex）の予測勝率を期待値に置き、区分ごとに
   「実際の勝率 − 予測勝率」を見る。差が標準誤差の2倍を超えれば ★。

   使い方: node --max-old-space-size=6000 tools/check_before.mjs
     BT_CB_DB    … 指数（既定 index.train.json。検証期間の先読みを避ける）
     BT_CB_MODEL … 係数（既定 model.json）
   K と B の全期間を読む（時点つきの指標を合わせるため）ので数分かかる。 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, readJSON } from './lib/bt.mjs';
import { FEATS, NF, raceFeatures } from './lib/bfeat.mjs';
import { loadRaces } from './lib/bload.mjs';

const DB = readJSON(process.env.BT_CB_DB || 'data/boat/index.train.json');
const ST = readJSON('data/boat/stadium.json');
const M = readJSON(process.env.BT_CB_MODEL || 'data/boat/model.json');
if (M.meta.feats.join() !== FEATS.join()) throw new Error('model.json の特徴量が bfeat.mjs と合わない。fit_boat.mjs を回し直す');
const beta = Float64Array.from(M.ex.beta);

const B = new Map();
for (const l of fs.readFileSync(path.join(ROOT, 'data/boat/before.jsonl'), 'utf8').split('\n')) {
  if (l) { const o = JSON.parse(l); B.set(`${o.date}|${o.jcd}|${o.r}`, o); }
}
console.log(`標本 ${B.size} レース`);
const from = [...B.values()].reduce((a, o) => (a < o.date ? a : o.date), '99999999');
const races = loadRaces({ from: from < '20240101' ? '' : '20231001', base: DB.base, keys: new Set(B.keys()) });
console.log(`K と突き合わせできた ${races.length} レース`);

const rows = [];
for (const r of races) {
  const X = raceFeatures(r, r.boats, DB, ST, { level: 'ex' });
  const u = X.map(x => { let s = 0; for (let i = 0; i < NF; i++) s += beta[i] * x[i]; return s; });
  const m = Math.max(...u), e = u.map(v => Math.exp(v - m)), s = e.reduce((a, b) => a + b, 0);
  const bi = B.get(`${r.date}|${r.jcd}|${r.r}`);
  const byLane = new Map(bi.boats.map(x => [x.lane, x]));
  r.boats.forEach((b, i) => {
    const z = byLane.get(b.lane);
    if (!z) return;
    rows.push({ p: e[i] / s, win: Number(b.pos) === 1 ? 1 : 0, top2: Number(b.pos) <= 2 ? 1 : 0,
      parts: z.parts.length, prop: z.prop ? 1 : 0, tilt: z.tilt, adjust: z.adjust, lane: b.lane, course: b.course });
  });
}
console.log(`艇数 ${rows.length}`);
const show = (title, groups) => {
  console.log('\n' + title);
  console.log('  区分              艇数   予測勝率   実際の勝率   差');
  for (const [lab, a] of groups) {
    if (a.length < 30) { console.log(`  ${lab.padEnd(16)} ${String(a.length).padStart(5)}  （標本不足）`); continue; }
    const ep = a.reduce((x, y) => x + y.p, 0) / a.length, ac = a.reduce((x, y) => x + y.win, 0) / a.length;
    const se = Math.sqrt(ep * (1 - ep) / a.length);
    const sig = Math.abs(ac - ep) > 2 * se ? ' ★' : '';
    console.log(`  ${lab.padEnd(16)} ${String(a.length).padStart(5)}  ${(100 * ep).toFixed(1).padStart(7)}%  ${(100 * ac).toFixed(1).padStart(9)}%  ${((ac - ep) * 100 >= 0 ? '+' : '') + ((ac - ep) * 100).toFixed(1)}pt${sig}`);
  }
};
show('部品交換の点数', [['なし', rows.filter(r => r.parts === 0)], ['1点', rows.filter(r => r.parts === 1)], ['2点以上', rows.filter(r => r.parts >= 2)]]);
show('プロペラ交換', [['なし', rows.filter(r => !r.prop)], ['新（交換）', rows.filter(r => r.prop)]]);
show('チルト', [['-0.5', rows.filter(r => r.tilt === -0.5)], ['0.0', rows.filter(r => r.tilt === 0)], ['0.5', rows.filter(r => r.tilt === 0.5)], ['1.0以上', rows.filter(r => r.tilt >= 1)]]);
show('調整重量', [['0.0', rows.filter(r => r.adjust === 0)], ['0.1〜0.9', rows.filter(r => r.adjust > 0 && r.adjust < 1)], ['1.0以上', rows.filter(r => r.adjust >= 1)]]);
show('（参考）進入コース', [1, 2, 3, 4, 5, 6].map(c => [`${c}コース`, rows.filter(r => r.course === c)]));
console.log('\n★ = 予測との差が標準誤差の2倍を超える');
