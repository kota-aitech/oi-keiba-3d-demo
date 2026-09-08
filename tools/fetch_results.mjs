/* 競走成績（/result/{raceId}.do）を取り込む。天候・馬場と全着順が取れる。
   バックテストで「その日の実際の馬場」を条件に使うために必要。
   使い方: NK_BT_TRACKS=大井 NK_BT_FROM=2026-08-31 NK_BT_TO=2026-09-04 node tools/fetch_results.mjs
   出力: data/nankan/results.jsonl                                            */
import fs from 'node:fs';
import path from 'node:path';
import { get, tables, text, num, ROOT } from './lib/nk.mjs';

const BASE = 'https://www.nankankeiba.com';
const OUT = path.join(ROOT, 'data', 'nankan', 'results.jsonl');
const TRACKS = (process.env.NK_BT_TRACKS || '大井,川崎,船橋,浦和').split(',');
const FROM = process.env.NK_BT_FROM || '2000-01-01';
const TO = process.env.NK_BT_TO || new Date().toISOString().slice(0, 10);

function parseResult(html) {
  const flat = text(html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, '|'))
    .replace(/\s+/g, ' ').replace(/(\|\s*)+/g, '|');
  const w = /天候[:：]\s*([^<\s|]{1,4})/.exec(html.replace(/<[^>]+>/g, ' '));
  const b = /馬場[:：]\s*(?:ダート|芝)?\s*([^<\s|]{1,4})/.exec(html.replace(/<[^>]+>/g, ' '));
  /* ハロンタイム（レースラップ）。上がり3F・4F も同じ並びに出る */
  let lap = null, agari3 = null, agari4 = null;
  const lm = /ハロンタイム\|([\d.]+)\|([\d.]+)\|([\d.\-]+)/.exec(flat);
  if (lm) { agari3 = Number(lm[1]); agari4 = Number(lm[2]); lap = lm[3].split('-').map(Number).filter(x => x > 0); }
  const rows = [];
  for (const tb of tables(html)) {
    if (!(tb[0] && tb[0][0] === '着' && tb[0][1] === '枠' && tb[0][2] === '馬番')) continue;
    for (const r of tb.slice(1)) {
      if (r.length < 10) continue;
      const pos = /^\d+$/.test(r[0]) ? Number(r[0]) : null;
      rows.push({ pos, gate: num(r[1]), no: num(r[2]), name: r[3],
        bw: num((/(\d{3})/.exec(r[6]) || [])[1]),
        jockey: r[8], time: r[10], last3f: Number(r[12]) || null, pop: num(r[14]) });
    }
    break;
  }
  return {
    weather: w ? w[1] : '', baba: b ? b[1] : '',
    lap, agari3, agari4,
    ten3: lap && lap.length >= 3 ? +(lap[0] + lap[1] + lap[2]).toFixed(1) : null,
    order: rows.filter(r => r.pos).sort((a, c) => a.pos - c.pos).map(r => r.no),
    gates: Object.fromEntries(rows.map(r => [r.no, r.gate])),
    pops: Object.fromEntries(rows.map(r => [r.no, r.pop])),
    last3f: Object.fromEntries(rows.filter(r => r.last3f).map(r => [r.no, r.last3f])),
    n: rows.length,
  };
}

const races = [];
for (const line of fs.readFileSync(path.join(ROOT, 'data/nankan/cards.jsonl'), 'utf8').split('\n')) {
  if (!line) continue;
  const c = JSON.parse(line);
  if (!TRACKS.includes(c.track) || c.date < FROM || c.date > TO) continue;
  races.push({ raceId: c.raceId, date: c.date, track: c.track, R: c.R });
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
const done = new Set();
if (fs.existsSync(OUT)) for (const l of fs.readFileSync(OUT, 'utf8').split('\n')) if (l) try { done.add(JSON.parse(l).raceId); } catch {}

let added = 0, day = '';
for (const r of races.sort((a, b) => a.raceId.localeCompare(b.raceId))) {
  if (done.has(r.raceId)) continue;
  let res;
  try { res = parseResult(await get(`${BASE}/result/${r.raceId}.do`, { ttlDays: 365 })); }
  catch (e) { console.error(`  ! ${r.raceId} ${e.message}`); continue; }
  if (!res.order.length) { console.error(`  - ${r.raceId} 着順なし（未開催？）`); continue; }
  fs.appendFileSync(OUT, JSON.stringify({ ...r, ...res }) + '\n');
  done.add(r.raceId); added++;
  if (day !== r.date) { day = r.date; console.error(`${r.date} ${r.track} …`); }
}
console.error(`完了: ${added} レース追加、合計 ${done.size}`);
