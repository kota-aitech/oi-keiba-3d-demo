/* 締切前のオッズを自動で拾う常駐スクリプト。

   南関（SPAT4）の発売締切は発走のおよそ1分前なので、
   「締切の8分前」＝発走の約9分前を既定の取得タイミングにしている（NK_ODDS_LEAD で変更可）。
   同じレースについて、締切前スナップショットと、レース後の最終オッズの両方を残す。
   最終と比べてどれだけ動いたかが後から測れるようにするため。

   さらに、あるレースの締切8分前に来たときは「そのレース以降の全レース」の暫定オッズも拾う。
   後半のレースも早い段階から値が入るので、いつ画面を見ても AI のおすすめが出る。
   暫定は tag に pre を付けて締切前スナップショット（T-n）とは別に持ち、
   同じレースについて何度でも上書きする（最新の暫定だけ残す）。

   使い方
     node tools/watch_odds.mjs              その日のレースを見張り続ける（開催終了で自動終了）
     NK_ODDS_ONCE=1 node tools/watch_odds.mjs   いま取り時のものだけ拾って終了（cron 向き）
     NK_ODDS_LEAD=8 …                       締切の何分前で拾うか（既定8。発走からは+1分で計算）
     NK_ODDS_DATE=2026-09-08 …              日付を指定（既定は今日）

   出力: data/nankan/odds_live.jsonl（1レース1タグ1行の追記）                */
import fs from 'node:fs';
import path from 'node:path';
import { get, ROOT } from './lib/nk.mjs';
import { parseOdds } from './lib/odds.mjs';

const BASE = 'https://www.nankankeiba.com';
const OUT = path.join(ROOT, 'data', 'nankan', 'odds_live.jsonl');
const DATE = process.env.NK_ODDS_DATE || new Date().toLocaleDateString('sv-SE');  // ローカル日付
const LEAD = Number(process.env.NK_ODDS_LEAD || 8);        // 締切の何分前
const CLOSE_BEFORE_POST = Number(process.env.NK_ODDS_CLOSE || 1);  // 締切は発走の何分前か
const ONCE = !!process.env.NK_ODDS_ONCE;
const TICK = Number(process.env.NK_ODDS_TICK || 20) * 1000;
const FINAL_AFTER = Number(process.env.NK_ODDS_FINAL || 25);  // 発走から何分後に最終を取るか

const jl = f => {
  const p = path.join(ROOT, 'data/nankan', f);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
};
const log = (...a) => console.error(new Date().toLocaleTimeString('ja-JP'), ...a);

/* 対象レース。cards.jsonl に無ければ番組表から拾って発走時刻だけ取りに行く */
async function todaysRaces() {
  const fromCards = jl('cards.jsonl').filter(c => c.date === DATE && c.time)
    .map(c => ({ raceId: c.raceId, track: c.track, R: c.R, time: c.time }));
  if (fromCards.length) return fromCards;
  log(`cards.jsonl に ${DATE} が無いので番組表から取ります`);
  const ymd = DATE.replace(/-/g, '');
  const q = ymd.slice(0, 4) + String(Math.floor((Number(ymd.slice(4, 6)) - 1) / 3) * 3 + 1).padStart(2, '0');
  const cal = await get(`${BASE}/calendar/${q}.do`, { ttlDays: 0.02 });
  const days = [...new Set([...cal.matchAll(/\/program\/(\d{14})\.do/g)].map(m => m[1]))].filter(d => d.startsWith(ymd));
  const out = [];
  for (const day of days) {
    const pg = await get(`${BASE}/program/${day}.do`, { ttlDays: 0.02 });
    for (const rid of [...new Set([...pg.matchAll(/\/syousai\/(\d{16})\.do/g)].map(m => m[1]))].sort()) {
      const html = await get(`${BASE}/uma_shosai/${rid}.do`, { ttlDays: 0.5 });
      const t = /発走時刻[\s\S]{0,80}?(\d{1,2}:\d{2})/.exec(html.replace(/<[^>]+>/g, ' '));
      out.push({ raceId: rid, track: '', R: Number(rid.slice(14, 16)), time: t ? t[1] : null });
    }
  }
  return out.filter(r => r.time);
}

const at = (hhmm, offsetMin) => {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date(DATE + 'T00:00:00');
  d.setHours(h, m + offsetMin, 0, 0);
  return d;
};

let FIRSTPASS = true;
const races = await todaysRaces();
if (!races.length) { log(`${DATE} は開催がありません`); process.exit(0); }
fs.mkdirSync(path.dirname(OUT), { recursive: true });
const done = new Set(jl('odds_live.jsonl').map(o => o.raceId + '|' + o.tag));
log(`${DATE} ${races.length}レース／締切${LEAD}分前（＝発走${LEAD + CLOSE_BEFORE_POST}分前）に取得`);
for (const r of races) log(`  ${r.R}R 発走 ${r.time} → 取得 ${at(r.time, -(LEAD + CLOSE_BEFORE_POST)).toLocaleTimeString('ja-JP')}`);

async function snap(r, tag, overwrite) {
  const key = r.raceId + '|' + tag;
  if (!overwrite && done.has(key)) return false;
  let o;
  try { o = parseOdds(await get(`${BASE}/oddsJS/${r.raceId}.do?_=${Date.now()}`, { ttlDays: 0 })); }
  catch (e) { log(`  ! ${r.R}R ${tag} ${e.message}`); return false; }
  if (!o.live) { log(`  - ${r.R}R ${tag} まだオッズなし`); return false; }
  const rec = { raceId: r.raceId, date: DATE, track: r.track, R: r.R, tag,
    post: r.time, capturedAt: new Date().toISOString(),
    minsToPost: Math.round((at(r.time, 0) - Date.now()) / 60000),
    updated: o.updated, tan: o.tan, fuku: o.fuku };
  fs.appendFileSync(OUT, JSON.stringify(rec) + '\n');
  done.add(key);
  if (!overwrite) {
    const top = Object.entries(o.tan).filter(([, v]) => v.pop === 1)[0];
    log(`  ✓ ${r.R}R ${tag} 取得（${o.updated}／1番人気 ${top ? top[0] + '番 ' + top[1].odds + '倍' : '—'}）`);
  }
  return true;
}

async function pass() {
  const now = Date.now();
  let tookSnap = false;
  for (const r of races) {
    const post = at(r.time, 0);
    if (now >= at(r.time, -(LEAD + CLOSE_BEFORE_POST)) && now < post.getTime() + 60000) {
      if (await snap(r, `T-${LEAD}`)) tookSnap = true;
    }
    if (now >= post.getTime() + FINAL_AFTER * 60000) await snap(r, 'final');
  }
  /* 締切前を1本取ったタイミングで、まだ発走していないレースの暫定オッズもまとめて拾う。
     これで後半のレースにも早くから値が入り、いつ見てもおすすめが出る。 */
  if (tookSnap || FIRSTPASS) {
    FIRSTPASS = false;
    let n = 0;
    for (const r of races) {
      if (now >= at(r.time, 0).getTime()) continue;                 // 発走済みは飛ばす
      if (done.has(r.raceId + `|T-${LEAD}`)) continue;              // 締切前を取ってあるなら不要
      if (await snap(r, 'pre', true)) n++;
    }
    if (n) log(`  ・以降 ${n} レースの暫定オッズも取得`);
  }
  return races.every(r => done.has(r.raceId + '|final'));
}

if (ONCE) { await pass(); process.exit(0); }
const endAt = at(races[races.length - 1].time, FINAL_AFTER + 20).getTime();
while (Date.now() < endAt) {
  if (await pass()) break;
  await new Promise(r => setTimeout(r, TICK));
}
log('見張り終了');
