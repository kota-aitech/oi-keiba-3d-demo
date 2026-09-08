/* 出馬表ページ（race.html）に載せる予想印を作る。
   印を別の式で作ると 3Dシミュレーション側と食い違うので、index.html の
   セクション0〜5（＝モデル本体）をそのまま VM で読み込んで monteCarlo を回す。
   結果（勝率・3着内率・3角/4角の平均位置・印）を entries.<track>.json に書き戻し、
   race.html に埋め直す。
   ※ embed_db.mjs のあとに実行すること（index.html の傾向データを使うため）。 */
import { ROOT, readJSON, writeJSON } from './lib/nk.mjs';
import { inject } from './lib/embed.mjs';
import { loadModel, condOf } from './lib/model.mjs';

const TRACKS = (process.env.NK_RACE_TRACKS || '大井:oi,川崎:kawasaki').split(',').map(s => s.split(':')[1]);
const N = Number(process.env.NK_MARK_TRIALS || 600);
const MARKS = ['◎', '○', '▲', '△', '△', '☆'];
const r3 = x => Math.round(x * 1000) / 1000;

const ent = { meta: null };
for (const key of TRACKS) {
  const M = loadModel(key);
  const d = readJSON(`data/nankan/entries.${key}.json`);
  let done = 0;
  for (const [dk, list] of Object.entries(d.days)) {
    for (const r of list) {
      const rk = `${dk}|${r.r}`;
      const all = d.entries[rk] || [];
      const live = all.filter(h => !h.scratch);
      if (live.length < 2) continue;
      const cond = condOf(M, r.dist);
      const mc = M.monteCarlo({ dist: r.dist, horses: live.map(h => ({ ...h })) }, cond, N);
      const order = mc.win.map((w, i) => [w, mc.top3[i], i]).sort((a, b) => b[0] - a[0] || b[1] - a[1]);
      const mark = {};
      order.forEach(([, , i], p) => { if (p < MARKS.length) mark[i] = MARKS[p]; });
      live.forEach((h, i) => {
        h.win = r3(mc.win[i]); h.top3 = r3(mc.top3[i]);
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
  d.meta = { ...d.meta, marks: { trials: N, note: 'index.html のモデルを馬場・天候の既定値と自動バイアスで回した結果' } };
  writeJSON(`data/nankan/entries.${key}.json`, d);
  ent[key] = { track: d.track, days: d.days, entries: d.entries };
  ent.meta = d.meta;
  console.error(`${d.track}: ${done} レースに印をつけた（試行 ${N}回・${JSON.stringify(condOf(M, 1400))}）`);
}
inject('race.html', 'NKRACE', 'NKR', ent);
