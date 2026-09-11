/* JRA の結果・払戻を日付範囲で取り込む → data/jra/results.jsonl（1レース1行、raceId で差し替え）
     JRA_FROM / JRA_TO … YYYYMMDD（既定 直近30日）
     JRA_SRC          … yahoo（既定）| netkeiba
     JRA_REFETCH=1    … 取得済みのレースも取り直す（既定は results.jsonl にあるレースは飛ばす）
   netkeiba は約4,000ページで規制（HTTP 400）に入ったので、既定は Yahoo!スポーツ。ID 体系が同じなので混ぜてよい。
   月間日程 → 開催ごとのレース一覧 → 各レースの結果。1リクエスト 2.5〜3秒。 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, get, RACE, freshTtl, ymdOf, dateRange, upsertJsonl, stats } from './lib/jra.mjs';
import { parseCalendar, parseRaceList, parseResult } from './lib/jrapage.mjs';
import { YAHOO, parseMonthly, parseList, parseResult as parseYResult, toId10 } from './lib/yahoo.mjs';

const d0 = new Date(); d0.setDate(d0.getDate() - 30);
const FROM = process.env.JRA_FROM || ymdOf(d0);
const TO = process.env.JRA_TO || ymdOf(new Date());
const SRC = process.env.JRA_SRC || 'yahoo';
const have = new Set();
if (!process.env.JRA_REFETCH) {
  const f = path.join(ROOT, 'data/jra/results.jsonl');
  if (fs.existsSync(f)) for (const l of fs.readFileSync(f, 'utf8').split('\n')) { const m = l.match(/^\{"raceId":"(\d{12})"/); if (m) have.add(m[1]); }
}
console.error(`${FROM}〜${TO}（${SRC}）取得済み ${have.size}R は飛ばす`);

let n = 0, bad = 0;
const buf = [];
const flush = () => { if (buf.length) { const total = upsertJsonl('data/jra/results.jsonl', buf.splice(0)); console.error(`  … ${n}R 取得（累計 ${total}R）`); } };
const blocked = () => { if (stats.blocked >= 6) { flush(); console.error('規制が解けないので中断。時間をおいて同じコマンドで再開する（取れたぶんはキャッシュから読む）'); process.exit(2); } };

/* 取るべきレース [{date, raceId, url, parse}] を集める */
const jobs = [];
const months = [...new Set([...dateRange(FROM, TO)].map(d => d.slice(0, 6)))];
const thisMonth = ymdOf(new Date()).slice(0, 6);
if (SRC === 'yahoo') {
  for (const ym of months) {
    let ks;
    try { ks = parseMonthly(await get(`${YAHOO}/keiba/schedule/monthly?year=${+ym.slice(0, 4)}&month=${+ym.slice(4, 6)}`, { ttlDays: ym >= thisMonth ? 1 : 3650, referer: YAHOO + '/keiba/' })); }
    catch (e) { console.error(`  ! 月間 ${ym} ${e.message}`); blocked(); continue; }
    for (const k of ks) {
      let list;
      try { list = parseList(await get(`${YAHOO}/keiba/race/list/${k}`, { ttlDays: 3650, referer: YAHOO + '/keiba/' }), k); }
      catch (e) { console.error(`  ! 一覧 ${k} ${e.message}`); blocked(); continue; }
      if (!list.date) continue;
      const ymd = list.date.replace(/-/g, '');
      if (ymd < FROM || ymd > TO) continue;
      /* 一覧ページの TTL：開催日が直近なら結果が出そろうまで取り直す */
      if (freshTtl(ymd) < 1) { try { list = parseList(await get(`${YAHOO}/keiba/race/list/${k}`, { ttlDays: freshTtl(ymd), referer: YAHOO + '/keiba/' }), k); } catch { } }
      for (const r of list.races) jobs.push({ date: list.date, raceId: r.raceId, url: `${YAHOO}/keiba/race/result/${toId10(r.raceId)}`, ttl: freshTtl(ymd), parse: h => parseYResult(h, r.raceId), referer: `${YAHOO}/keiba/race/list/${k}` });
    }
  }
} else {
  const days = new Set();
  for (const ym of months) {
    const html = await get(`${RACE}/top/calendar.html?year=${+ym.slice(0, 4)}&month=${+ym.slice(4, 6)}`, { ttlDays: ym >= thisMonth ? 1 : 3650 });
    for (const d of parseCalendar(html)) if (d >= FROM && d <= TO) days.add(d);
  }
  for (const d of [...days].sort()) {
    let list;
    try { list = parseRaceList(await get(`${RACE}/top/race_list_sub.html?kaisai_date=${d}`, { ttlDays: freshTtl(d) })); }
    catch (e) { console.error(`  ! ${d} 一覧 ${e.message}`); blocked(); continue; }
    for (const r of list) jobs.push({ date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`, raceId: r.raceId, url: `${RACE}/race/result.html?race_id=${r.raceId}`, ttl: freshTtl(d), parse: h => parseResult(h, r.raceId) });
  }
}
const todo = jobs.filter(j => !have.has(j.raceId));
console.error(`対象 ${jobs.length}R のうち未取得 ${todo.length}R`);

for (const j of todo) {
  try {
    const res = j.parse(await get(j.url, { ttlDays: j.ttl, referer: j.referer }));
    if (!res.entries.length) { bad++; continue; }               // まだ結果が出ていない
    buf.push({ ...res, date: res.date || j.date });
    n++;
  } catch (e) { bad++; if (bad % 10 === 1) console.error(`  ! ${j.raceId} ${e.message}`); blocked(); }
  if (buf.length >= 100) flush();
}
flush();
console.error(`完了: ${n}R 取得（結果なし・失敗 ${bad}）`);
