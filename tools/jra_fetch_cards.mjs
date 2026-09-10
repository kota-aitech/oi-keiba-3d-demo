/* JRA の出馬表（馬柱・前5走つき）を取り込む → data/jra/cards.jsonl（1レース1行、raceId で差し替え）
     JRA_FROM / JRA_TO … YYYYMMDD（既定 今日〜3日後。土日の開催ぶん）
   枠順は木曜〜金曜に確定するので、それより前は枠・馬番が空のことがある（取り直せば埋まる）。 */
import { get, RACE, freshTtl, ymdOf, dateRange, upsertJsonl } from './lib/jra.mjs';
import { parseCalendar, parseRaceList, parseShutubaPast } from './lib/jrapage.mjs';

const d0 = new Date(), d1 = new Date(); d1.setDate(d1.getDate() + 3);
const FROM = process.env.JRA_FROM || ymdOf(d0);
const TO = process.env.JRA_TO || ymdOf(d1);

const days = new Set();
for (const ym of new Set([...dateRange(FROM, TO)].map(d => d.slice(0, 6)))) {
  const html = await get(`${RACE}/top/calendar.html?year=${+ym.slice(0, 4)}&month=${+ym.slice(4, 6)}`, { ttlDays: 1 });
  for (const d of parseCalendar(html)) if (d >= FROM && d <= TO) days.add(d);
}
console.error(`${FROM}〜${TO} 開催日 ${days.size}日`);
let n = 0;
const buf = [];
for (const d of [...days].sort()) {
  const list = parseRaceList(await get(`${RACE}/top/race_list_sub.html?kaisai_date=${d}`, { ttlDays: 0.02 }));
  for (const r of list) {
    try {
      const html = await get(`${RACE}/race/shutuba_past.html?race_id=${r.raceId}`, { ttlDays: 0.02 });
      const card = parseShutubaPast(html, r.raceId);
      if (!card.entries.length) continue;
      buf.push({ ...card, date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` });
      n++;
    } catch (e) { console.error(`  ! ${r.raceId} ${e.message}`); }
  }
  console.error(`  ${d} ${list.length}R`);
}
const total = upsertJsonl('data/jra/cards.jsonl', buf);
console.error(`完了: ${n}R 取得 -> data/jra/cards.jsonl（累計 ${total}R）`);
