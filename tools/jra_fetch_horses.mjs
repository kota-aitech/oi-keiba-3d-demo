/* 馬のプロフィール（血統・馬主・生産者）を Yahoo の馬ページから取る → data/jra/horses.jsonl（1頭1行、horseId で差し替え）
   対象は results.jsonl（JRA_H_FROM 以降に出走）と cards.jsonl に出てくる馬。取得済みは飛ばす。
     JRA_H_FROM … 出走の期間の下限（既定 2024-03-01＝学習の助走の始まり）
     JRA_WAIT   … 間隔（既定 3500ms。出馬表の取り直しと並行しても Yahoo を叩きすぎないように）
   約19,000頭・13時間。血統は変わらないので 3650日キャッシュ。 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, get, upsertJsonl, stats } from './lib/jra.mjs';
import { YAHOO, parseHorse } from './lib/yahoo.mjs';

const FROM = process.env.JRA_H_FROM || '2024-03-01';
const OUT = 'data/jra/horses.jsonl';
const have = new Set();
if (fs.existsSync(path.join(ROOT, OUT))) for (const l of fs.readFileSync(path.join(ROOT, OUT), 'utf8').split('\n')) { const m = l.match(/^\{"horseId":"(\d+)"/); if (m) have.add(m[1]); }
const want = new Map();                                   // horseId -> 出走数（多い順に取る）
for (const f of ['data/jra/cards.jsonl', 'data/jra/results.jsonl']) {
  const p = path.join(ROOT, f);
  if (!fs.existsSync(p)) continue;
  for (const l of fs.readFileSync(p, 'utf8').split('\n')) {
    if (!l) continue;
    const r = JSON.parse(l);
    if (f.includes('results') && r.date < FROM) continue;
    for (const e of r.entries) if (e.horseId) want.set(e.horseId, (want.get(e.horseId) || 0) + (f.includes('cards') ? 1000 : 1));
  }
}
const todo = [...want].filter(([id]) => !have.has(id)).sort((a, b) => b[1] - a[1]).map(([id]) => id);
console.error(`対象 ${want.size}頭のうち未取得 ${todo.length}頭（約 ${(todo.length * (Number(process.env.JRA_WAIT || 3500)) / 3600000).toFixed(1)} 時間）`);
let n = 0, bad = 0;
const buf = [];
const flush = () => { if (buf.length) { const total = upsertJsonl(OUT, buf.splice(0), o => o.horseId); console.error(`  … ${n}頭 取得（累計 ${total}頭）`); } };
for (const id of todo) {
  try {
    const h = parseHorse(await get(`${YAHOO}/keiba/directory/horse/${id}/`, { ttlDays: 3650, referer: YAHOO + '/keiba/' }), id);
    if (!h.sire && !h.owner) { bad++; continue; }
    buf.push(h); n++;
  } catch (e) { bad++; if (bad % 10 === 1) console.error(`  ! ${id} ${e.message}`); if (stats.blocked >= 6) { flush(); console.error('規制が解けないので中断'); process.exit(2); } }
  if (buf.length >= 200) flush();
}
flush();
console.error(`完了: ${n}頭 取得（失敗 ${bad}）-> ${OUT}`);
