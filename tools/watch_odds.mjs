/* 締切前のオッズを自動で拾う常駐スクリプト。

   南関（SPAT4）の発売締切は発走のおよそ1分前なので、
   「締切の8分前」＝発走の約9分前を既定の取得タイミングにしている（NK_ODDS_LEAD で変更可）。
   同じレースについて、締切前スナップショットと、レース後の最終オッズの両方を残す。
   最終と比べてどれだけ動いたかが後から測れるようにするため。

   さらに、あるレースの締切8分前に来たタイミングで「まだ発走していない全レース」の
   暫定オッズもまとめて取り直す。後半のレースの値がレースごとに更新されるので、
   いつ画面を見ても新しいオッズで AI のおすすめが出る。
   （何も取らない時間が続いたときの保険として NK_ODDS_REFRESH 分での更新も入れてある）

   翌日以降のレースも対象にする。南関は重賞などで前日発売があり、そこで値が入る。

   ファイルの持ち方
     odds_live.jsonl … 締切前(T-n)と最終(final)。追記のみ。あとで検証に使う
     odds_pre.json   … 暫定。1レース1件だけ上書き保存（毎分追記すると際限なく増えるため）

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
const PRE = path.join(ROOT, 'data', 'nankan', 'odds_pre.json');
const DATE = process.env.NK_ODDS_DATE || new Date().toLocaleDateString('sv-SE');  // ローカル日付
const AHEAD = Number(process.env.NK_ODDS_AHEAD || 3);          // 何日先まで見るか
const REFRESH = Number(process.env.NK_ODDS_REFRESH || 12);     // 暫定を何分で取り直すか
const MAXPRE = Number(process.env.NK_ODDS_MAXPRE || 14);       // 1周回で暫定を取る上限
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

/* 対象レース。今日から AHEAD 日先まで。前日発売のオッズも拾いたいため */
const addDays = (d, n) => { const t = new Date(d + 'T00:00:00'); t.setDate(t.getDate() + n); return t.toLocaleDateString('sv-SE'); };
const DATES = Array.from({ length: AHEAD + 1 }, (_, i) => addDays(DATE, i));
async function todaysRaces() {
  const fromCards = jl('cards.jsonl').filter(c => DATES.includes(c.date) && c.time)
    .map(c => ({ raceId: c.raceId, date: c.date, track: c.track, R: c.R, time: c.time }));
  if (fromCards.length) return fromCards;
  log(`cards.jsonl に ${DATES[0]} 以降が無いので番組表から取ります`);
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
      out.push({ raceId: rid, date: DATE, track: '', R: Number(rid.slice(14, 16)), time: t ? t[1] : null });
    }
  }
  return out.filter(r => r.time);
}

const at = (r, offsetMin) => {
  const [h, m] = r.time.split(':').map(Number);
  const d = new Date((r.date || DATE) + 'T00:00:00');
  d.setHours(h, m + offsetMin, 0, 0);
  return d;
};

/* launchd は1分おきに起動する。1回の処理が1分を超えるとプロセスが重なり、
   サイトを叩きすぎて通信エラーの連鎖になる（実際に9/8夜これで T-8 を取り逃した）。
   ロックを置いて多重起動を防ぐ。 */
const LOCK = path.join(ROOT, 'data', 'nankan', '.oddswatch.lock');
if (ONCE) {
  try {
    const st = fs.statSync(LOCK);
    const age = (Date.now() - st.mtimeMs) / 60000;
    if (age < 5) { process.exit(0); }             // 実行中。黙って終わる
    fs.unlinkSync(LOCK);                          // 5分以上前のは死んだプロセスの残骸
  } catch {}
  fs.writeFileSync(LOCK, String(process.pid));
  const release = () => { try { fs.unlinkSync(LOCK); } catch {} };
  process.on('exit', release);
  process.on('SIGTERM', () => { release(); process.exit(0); });
}

let FIRSTPASS = true;
const races = await todaysRaces();
if (!races.length) { log(`${DATE} は開催がありません`); process.exit(0); }
fs.mkdirSync(path.dirname(OUT), { recursive: true });
const done = new Set(jl('odds_live.jsonl').map(o => o.raceId + '|' + o.tag));
const today = races.filter(r => (r.date || DATE) === DATE);
log(`${DATES[0]}〜 ${races.length}レース（本日 ${today.length}）／締切${LEAD}分前（＝発走${LEAD + CLOSE_BEFORE_POST}分前）に取得`);
for (const r of today) log(`  ${r.R}R 発走 ${r.time} → 取得 ${at(r, -(LEAD + CLOSE_BEFORE_POST)).toLocaleTimeString('ja-JP')}`);

/* 暫定オッズ。1レース1件だけ持つ */
let pre = {};
try { pre = JSON.parse(fs.readFileSync(PRE, 'utf8')); } catch {}
const savePre = () => fs.writeFileSync(PRE, JSON.stringify(pre));
/* 発売前・取得失敗を覚えておき、毎周回叩かないようにする（翌日以降のレースが大半）*/
const NOTYET = path.join(ROOT, 'data', 'nankan', '.oddswatch.notyet.json');
let notYet = {};
try { notYet = JSON.parse(fs.readFileSync(NOTYET, 'utf8')); } catch {}
const SKIP_MIN = Number(process.env.NK_ODDS_SKIP || 20);

async function snap(r, tag) {
  const key = r.raceId + '|' + tag;
  const isPre = tag === 'pre';
  if (!isPre && done.has(key)) return false;
  let o;
  try {
    /* 暫定は取れなくても次の周回で取り直せばよいので粘らない。
       ここで3回リトライすると1レース5秒かかり、締切前の取得まで遅れる。 */
    o = parseOdds(await get(`${BASE}/oddsJS/${r.raceId}.do?_=${Date.now()}`, { ttlDays: 0, tries: isPre ? 1 : 3 }));
  } catch (e) {
    if (!isPre) log(`  ! ${r.R}R ${tag} ${e.message}`);
    notYet[r.raceId] = Date.now();                // しばらく置く
    return false;
  }
  if (!o.live) { notYet[r.raceId] = Date.now(); return false; }   // 発売前。翌日以降は普通ここ
  const rec = { raceId: r.raceId, date: r.date || DATE, track: r.track, R: r.R, tag,
    post: r.time, capturedAt: new Date().toISOString(),
    minsToPost: Math.round((at(r, 0) - Date.now()) / 60000),
    updated: o.updated, tan: o.tan, fuku: o.fuku };
  if (isPre) { pre[r.raceId] = rec; delete notYet[r.raceId]; return true; }
  fs.appendFileSync(OUT, JSON.stringify(rec) + '\n');
  done.add(key);
  const top = Object.entries(o.tan).filter(([, v]) => v.pop === 1)[0];
  log(`  ✓ ${r.R}R ${tag} 取得（${o.updated}／1番人気 ${top ? top[0] + '番 ' + top[1].odds + '倍' : '—'}）`);
  return true;
}

async function pass() {
  const now = Date.now();
  let tookSnap = false;
  for (const r of races) {
    if ((r.date || DATE) !== DATE) continue;       // 締切前・最終は当日ぶんだけ
    const post = at(r, 0);
    if (now >= at(r, -(LEAD + CLOSE_BEFORE_POST)) && now < post.getTime() + 60000) {
      if (await snap(r, `T-${LEAD}`)) tookSnap = true;
    }
    if (now >= post.getTime() + FINAL_AFTER * 60000) await snap(r, 'final');
  }

  /* あるレースの締切8分前を取ったら、まだ発走していない全レースの暫定を取り直す。
     ＝レースが1つ進むごとに後半のオッズが更新される。
     取るものが無い時間帯でも、暫定が REFRESH 分より古ければ取り直して鮮度を保つ。 */
  const stale = r => {
    const p = pre[r.raceId];
    if (!p) return true;
    return (now - new Date(p.capturedAt).getTime()) / 60000 >= REFRESH;
  };
  const targets = races
    .filter(r => now < at(r, 0).getTime() && !done.has(r.raceId + `|T-${LEAD}`))
    /* 発売前だと分かっているものは SKIP_MIN 分あけてから試す */
    .filter(r => !notYet[r.raceId] || (now - notYet[r.raceId]) / 60000 >= SKIP_MIN)
    /* 発走が近い順。1周回で取り切れなくても大事なものから埋まる */
    .sort((a, b) => at(a, 0) - at(b, 0));
  const todo = (tookSnap || FIRSTPASS ? targets : targets.filter(stale)).slice(0, MAXPRE);
  FIRSTPASS = false;
  let n = 0;
  for (const r of todo) if (await snap(r, 'pre')) n++;
  if (n) { savePre(); log(`  ・暫定オッズを ${n} レース更新${tookSnap ? '（締切前の取得に合わせて）' : ''}`); }
  fs.writeFileSync(NOTYET, JSON.stringify(notYet));

  return races.filter(r => (r.date || DATE) === DATE).every(r => done.has(r.raceId + '|final'));
}

if (ONCE) { await pass(); process.exit(0); }
const todayRaces = races.filter(r => (r.date || DATE) === DATE);
const endAt = at(todayRaces[todayRaces.length - 1] || races[races.length - 1], FINAL_AFTER + 20).getTime();
while (Date.now() < endAt) {
  if (await pass()) break;
  await new Promise(r => setTimeout(r, TICK));
}
log('見張り終了');
