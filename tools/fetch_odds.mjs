/* 単勝・複勝オッズを取り込む。/oddsJS/{raceId}.do が1KB弱の JS を返すので、
   HTML のオッズページ（100KB）ではなくこちらを使う。
     odds_tan  = { 馬番: [単勝オッズ, 発売中か, ?, 人気順], ... }
     odds_fuku = { 馬番: ["下限-上限", ...], ... }
   終わったレースは最終オッズが入る。発売前は 0.0 が並ぶ（update_time で判別）。
   使い方: NK_BT_TRACKS=大井,川崎 NK_BT_FROM=2025-09-01 node tools/fetch_odds.mjs
   出力: data/nankan/odds.jsonl                                              */
import fs from 'node:fs';
import path from 'node:path';
import { get, ROOT } from './lib/nk.mjs';
import { parseOdds } from './lib/odds.mjs';

/* 開催前に取得した空ページを1年キャッシュしてしまうと、後から結果・払戻・オッズが
   永久に取れなくなる。直近の日付は短い TTL にして取り直せるようにする。 */
const freshTtl = (date, longDays = 365) => {
  const age = (Date.now() - new Date(date + 'T00:00:00').getTime()) / 86400000;
  return age < 4 ? 0.02 : longDays;
};

const BASE = 'https://www.nankankeiba.com';
const OUT = path.join(ROOT, 'data', 'nankan', 'odds.jsonl');
const TRACKS = (process.env.NK_BT_TRACKS || '大井,川崎,船橋,浦和').split(',');
const FROM = process.env.NK_BT_FROM || '2000-01-01';
const TO = process.env.NK_BT_TO || new Date().toISOString().slice(0, 10);

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

let added = 0, day = '', skipped = 0;
for (const r of races.sort((a, b) => a.raceId.localeCompare(b.raceId))) {
  if (done.has(r.raceId)) continue;
  let o;
  try { o = parseOdds(await get(`${BASE}/oddsJS/${r.raceId}.do?`, { ttlDays: freshTtl(r.date) })); }
  catch (e) { console.error(`  ! ${r.raceId} ${e.message}`); continue; }
  if (!o.live) { skipped++; continue; }             // 発売前・非公開
  fs.appendFileSync(OUT, JSON.stringify({ ...r, ...o }) + '\n');
  done.add(r.raceId); added++;
  if (day !== r.date) { day = r.date; console.error(`${r.date} ${r.track} …（累計 ${added}）`); }
}
console.error(`完了: ${added} レース追加（オッズなし ${skipped}）、合計 ${done.size}`);
