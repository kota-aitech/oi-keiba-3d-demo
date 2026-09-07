/* data/nankan/races.*.json を index.html の NKDB マーカーの間に埋め込む。
   1ファイル・依存ゼロを保つための最後の工程。実行後は node --check で構文確認すること。 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, readJSON } from './lib/nk.mjs';

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

function inject(file, marker, varName, data) {
  const p = path.join(ROOT, file);
  const html = fs.readFileSync(p, 'utf8');
  const B = `/* ${marker}:BEGIN`, E = `/* ${marker}:END */`;
  const i = html.indexOf(B), j = html.indexOf(E);
  if (i < 0 || j < 0) throw new Error(`${file} に ${marker} マーカーがありません`);
  const head = html.slice(i, html.indexOf('\n', i) + 1);
  const body = `const ${varName}=${JSON.stringify(data)};\n`;
  fs.writeFileSync(p, html.slice(0, i) + head + body + html.slice(j));
  console.error(`埋め込み ${(body.length / 1024).toFixed(0)} KB → ${file} (${(fs.statSync(p).size / 1024).toFixed(0)} KB)`);
}

inject('index.html', 'NKDB', 'NKDATA', out);
try { inject('data.html', 'NKBROWSE', 'NKB', readJSON('data/nankan/browse.json')); }
catch (e) { console.error('  (data.html はスキップ: ' + e.message + ')'); }
