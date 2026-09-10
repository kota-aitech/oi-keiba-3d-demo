/* JRA の結果・払戻を日付範囲で取り込む → data/jra/results.jsonl（1レース1行、raceId で差し替え）
     JRA_FROM / JRA_TO … YYYYMMDD（既定 直近30日）
   開催日は月のカレンダーから拾い、日ごとのレース一覧 → 各レースの結果ページ。
   1リクエスト 1.2秒間隔。3年ぶん（約1万レース）で4時間弱。キャッシュがあれば速い。 */
import { get, RACE, freshTtl, ymdOf, dateRange, upsertJsonl } from './lib/jra.mjs';
import { parseCalendar, parseRaceList, parseResult } from './lib/jrapage.mjs';

const d0 = new Date(); d0.setDate(d0.getDate() - 30);
const FROM = process.env.JRA_FROM || ymdOf(d0);
const TO = process.env.JRA_TO || ymdOf(new Date());

/* 開催日：月ごとのカレンダー */
const days = new Set();
const months = new Set([...dateRange(FROM, TO)].map(d => d.slice(0, 6)));
for (const ym of months) {
  const html = await get(`${RACE}/top/calendar.html?year=${+ym.slice(0, 4)}&month=${+ym.slice(4, 6)}`, { ttlDays: ym >= ymdOf(new Date()).slice(0, 6) ? 1 : 3650 });
  for (const d of parseCalendar(html)) if (d >= FROM && d <= TO) days.add(d);
}
console.error(`${FROM}〜${TO} 開催日 ${days.size}日`);

let n = 0, bad = 0;
const buf = [];
const flush = () => { if (buf.length) { const total = upsertJsonl('data/jra/results.jsonl', buf.splice(0)); console.error(`  … ${n}R 取得（累計 ${total}R）`); } };
for (const d of [...days].sort()) {
  let list;
  try { list = parseRaceList(await get(`${RACE}/top/race_list_sub.html?kaisai_date=${d}`, { ttlDays: freshTtl(d) })); }
  catch (e) { console.error(`  ! ${d} 一覧 ${e.message}`); continue; }
  for (const r of list) {
    try {
      const html = await get(`${RACE}/race/result.html?race_id=${r.raceId}`, { ttlDays: freshTtl(d) });
      const res = parseResult(html, r.raceId);
      if (!res.entries.length) { bad++; continue; }               // まだ結果が出ていない
      buf.push({ ...res, date: res.date || `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` });
      n++;
    } catch (e) { bad++; if (bad % 10 === 1) console.error(`  ! ${r.raceId} ${e.message}`); }
  }
  if (buf.length >= 120) flush();
}
flush();
console.error(`完了: ${n}R 取得（結果なし・失敗 ${bad}）`);
