/* 南関4場の出馬表を期間指定で取得し data/nankan/cards.jsonl に1レース1行で追記する。
   ここから 馬主 / 騎手 / 調教師 / 前5走（着順・人気・上がり3F・コーナー通過順）が取れる。
   使い方: NK_FROM=202509 NK_TO=202609 node tools/fetch_cards.mjs
   カレンダー → 開催日 → 番組表 → 各レースの出馬表、の順に1リクエストずつ辿る。 */
import fs from 'node:fs';
import path from 'node:path';
import { get, ROOT } from './lib/nk.mjs';
import { parseCard } from './lib/card.mjs';

const BASE = 'https://www.nankankeiba.com';
const OUT = path.join(ROOT, 'data', 'nankan', 'cards.jsonl');
const today = new Date();
const ym = d => d.getFullYear() * 100 + d.getMonth() + 1;
const TO = Number(process.env.NK_TO || ym(today));
const FROM = Number(process.env.NK_FROM || (ym(today) - 100));

function months(from, to) {
  const out = [];
  let y = Math.floor(from / 100), m = from % 100;
  while (y * 100 + m <= to) { out.push(`${y}${String(m).padStart(2, '0')}`); m++; if (m > 12) { m = 1; y++; } }
  return out;
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
const done = new Set();
if (fs.existsSync(OUT)) for (const l of fs.readFileSync(OUT, 'utf8').split('\n')) { if (l) try { done.add(JSON.parse(l).raceId); } catch {} }
console.error(`既存 ${done.size} レース`);

let added = 0, days = 0;
/* カレンダーは四半期単位（202601 / 202604 / 202607 / 202610）で1ページ */
const quarter = mo => mo.slice(0, 4) + String(Math.floor((Number(mo.slice(4)) - 1) / 3) * 3 + 1).padStart(2, '0');
const seen = new Set();
for (const mo of months(FROM, TO)) {
  const q = quarter(mo);
  if (seen.has(q)) continue;
  seen.add(q);
  const cal = await get(`${BASE}/calendar/${q}.do`, { ttlDays: q === quarter(String(TO)) ? 1 : 365 });
  const progs = [...new Set([...cal.matchAll(/\/program\/(\d{14})\.do/g)].map(m => m[1]))]
    .filter(d => { const x = Number(d.slice(0, 6)); return x >= FROM && x <= TO; });
  for (const day of progs.sort()) {
    days++;
    const fresh = Number(day.slice(0, 6)) >= ym(today) ? 1 : 365;
    const pg = await get(`${BASE}/program/${day}.do`, { ttlDays: fresh });
    const races = [...new Set([...pg.matchAll(/\/syousai\/(\d{16})\.do/g)].map(m => m[1]))].sort();
    for (const rid of races) {
      if (done.has(rid)) continue;
      let card;
      try { card = parseCard(await get(`${BASE}/uma_shosai/${rid}.do`, { ttlDays: fresh }), rid); }
      catch (e) { console.error(`  ! ${rid} ${e.message}`); continue; }
      if (!card.horses.length) { console.error(`  ! ${rid} 出走馬なし`); continue; }
      fs.appendFileSync(OUT, JSON.stringify(card) + '\n');
      done.add(rid); added++;
    }
    console.error(`${day} ${races.length}R  (累計 ${added} レース / ${days} 日)`);
  }
}
console.error(`完了: ${added} レース追加、合計 ${done.size}`);
