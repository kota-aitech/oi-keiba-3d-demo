/* data/nankan/races.*.json を index.html の NKDB マーカーの間に埋め込む。
   1ファイル・依存ゼロを保つための最後の工程。実行後は node --check で構文確認すること。 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, readJSON } from './lib/nk.mjs';
import { inject } from './lib/embed.mjs';

const TRACKS = (process.env.NK_RACE_TRACKS || '大井:oi,川崎:kawasaki').split(',').map(s => s.split(':')[1]);
const out = {};
for (const k of TRACKS) {
  const d = readJSON(`data/nankan/races.${k}.json`);
  out[k] = { days: d.days, real: d.real };
  try { const t = readJSON(`data/nankan/trend.${k}.json`); out[k].trend = { trendRef: t.trendRef, fallback: t.fallback, calib: t.calib, meet: t.meet }; }
  catch { console.error(`  (trend.${k}.json なし。傾向は既定値になる)`); }
  out.meta = d.meta;
}
const idx = readJSON('data/nankan/index.json');
out.meta = {
  ...out.meta,
  pop: idx.pop, fit: idx.fit, window: idx.window,
  counts: { jockey: Object.keys(idx.jockey).length, trainer: Object.keys(idx.trainer).length, combo: Object.keys(idx.combo).length, owner: Object.keys(idx.owner).length },
};

inject('index.html', 'NKDB', 'NKDATA', out);

/* 出馬表ページ（race.html）: 前5走まで入った詳しい方 */
try {
  const ent = { meta: out.meta };
  for (const k of TRACKS) {
    const d = readJSON(`data/nankan/entries.${k}.json`);
    ent[k] = { track: d.track, days: d.days, entries: d.entries };
  }
  inject('race.html', 'NKRACE', 'NKR', ent);
} catch (e) { console.error('  (race.html はスキップ: ' + e.message + ')'); }

try { inject('data.html', 'NKBROWSE', 'NKB', readJSON('data/nankan/browse.json')); }
catch (e) { console.error('  (data.html はスキップ: ' + e.message + ')'); }
try { inject('data.html', 'NKBT', 'NKBT', readJSON('data/nankan/backtest.json')); }
catch (e) { console.error('  (バックテストはスキップ: ' + e.message + ')'); }
