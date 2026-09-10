/* K（成績）と B（番組表）を突き合わせて1レースぶんにまとめる。
   fit_boat / backtest_boat / build_boatdb が同じ組み立てを使うためにここに置く。

   ここでしか作れないものが2つある。どちらも「日付順に1度なめる」必要があるため。
     motorGen … モーターは場ごとに年1回入れ替わる。番号だけでは別個体が混ざるので
                「40日以上あいたら別世代」で切る（build_boatdb と同じ規則）
     mUp      … モーター2連率の直近の伸び。B の motor2 はその日時点の累計なので、
                同じモーターの少し前の値との差が「今節での上がり下がり」になる */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './bt.mjs';

const GAP_DAYS = 40;
const dayNo = d => Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8)) / 86400000;

/* モーターの世代を日付順に振る。results / programs のどちらでも使う */
export function makeGen() {
  const seen = new Map();                       // 'jcd|no' -> {gen, last}
  return (jcd, no, date) => {
    if (!no) return 1;
    const k = jcd + '|' + no, t = dayNo(date), s = seen.get(k);
    const gen = s ? (t - s.last > GAP_DAYS ? s.gen + 1 : s.gen) : 1;
    seen.set(k, { gen, last: t });
    return gen;
  };
}

/* モーター2連率の直近の伸び。lookback 日以内でいちばん古い記録との差を返す */
function makeTrend(lookback = 12) {
  const hist = new Map();                       // 'jcd|no|gen' -> [[day, v], ...] 直近だけ
  return (jcd, no, gen, date, v) => {
    if (no == null || v == null) return null;
    const k = `${jcd}|${no}|${gen}`, t = dayNo(date);
    let a = hist.get(k);
    if (!a) hist.set(k, a = []);
    while (a.length && t - a[0][0] > lookback) a.shift();
    const up = a.length ? v - a[0][1] : null;
    a.push([t, v]);
    if (a.length > 24) a.shift();
    return up;
  };
}

function* jsonl(rel, from, to) {
  const f = path.join(ROOT, rel);
  if (!fs.existsSync(f)) throw new Error(`${rel} がない。先に fetch_od2.mjs を回す`);
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    if (!line) continue;
    const o = JSON.parse(line);
    if (from && o.date < from) continue;
    if (to && o.date > to) continue;
    yield o;
  }
}

/* B（番組表）を読み、モーターの世代と2連率の伸びを付けて返す */
export function loadPrograms({ from = '', to = '' } = {}) {
  const gen = makeGen(), trend = makeTrend();
  const map = new Map();
  for (const o of jsonl('data/boat/programs.jsonl', from, to)) {
    for (const b of o.boats) {
      b.motorGen = gen(o.jcd, b.motor, o.date);
      b.mUp = trend(o.jcd, b.motor, b.motorGen, o.date, b.motor2);
    }
    map.set(`${o.date}|${o.jcd}|${o.r}`, o);
  }
  return map;
}

/* ---- 「そのレースより前」だけから作る、時点つきの指標 ----
   index.json の指数は3年通算なので、絶好調・絶不調や「今節の機力」を捉えられない。
   ここは results.jsonl を日付順に1度なめながら、各レースについて
   「その日より前の情報だけ」で作る。作り方を間違えると先読みになるので、
   必ず「今のレースを足す前に読む」順序を守ること。
     form    … 直近90日の、コース基準からの上振れ（縮小あり）
     setuST  … 今節のここまでの平均ST
     setuEx  … 今節のここまでの展示タイムのレース内偏差（＋が速い）
     mForm   … そのモーターの直近45日の上振れ */
const FORM_DAYS = 90, MOTOR_DAYS = 45, SETU_GAP = 3;
const FORM_K = 25, MFORM_K = 20;
function makeRolling(base) {
  const bz = (jcd, c) => base?.[jcd + '|' + c]?.win ?? [0, .55, .13, .13, .11, .06, .03][c] ?? 1 / 6;
  const R = new Map(), MO = new Map(), SE = new Map();
  const trim = (a, t, days) => { while (a.length && t - a[0][0] > days) a.shift(); };
  const resid = (a, k) => {
    if (!a.length) return { v: 0, n: 0 };
    let w = 0, e = 0;
    for (const [, win, p] of a) { w += win; e += p; }
    return { v: (w - e) / (a.length + k), n: a.length };
  };
  return {
    read(r, e) {
      const t = dayNo(r.date), p = bz(r.jcd, e.course || e.lane);
      const ra = R.get(e.toban) || [], mo = MO.get(`${r.jcd}|${e.motor}|${e.motorGen}`) || [];
      trim(ra, t, FORM_DAYS); trim(mo, t, MOTOR_DAYS);
      const se = SE.get(`${e.toban}|${r.jcd}`);
      const live = se && t - se.lastDay <= SETU_GAP ? se : null;
      const f = resid(ra, FORM_K), m = resid(mo, MFORM_K);
      return {
        form: f.v, formN: f.n, mForm: m.v, mFormN: m.n,
        setuST: live && live.stN ? live.stSum / live.stN : null,
        setuEx: live && live.exN ? live.exSum / live.exN : null,
        setuRuns: live ? live.n : 0,
        _p: p,
      };
    },
    /* レースが終わったあとに足す。read より必ずあとに呼ぶ */
    push(r, e, p, exDev) {
      const t = dayNo(r.date), win = Number(e.pos) === 1 ? 1 : 0;
      let ra = R.get(e.toban); if (!ra) R.set(e.toban, ra = []); ra.push([t, win, p]);
      const mk = `${r.jcd}|${e.motor}|${e.motorGen}`;
      let mo = MO.get(mk); if (!mo) MO.set(mk, mo = []); mo.push([t, win, p]);
      const sk = `${e.toban}|${r.jcd}`;
      let se = SE.get(sk);
      if (!se || t - se.lastDay > SETU_GAP) SE.set(sk, se = { n: 0, stSum: 0, stN: 0, exSum: 0, exN: 0, lastDay: t });
      se.n++; se.lastDay = t;
      if (e.st != null && !e.f) { se.stSum += e.st; se.stN++; }
      if (exDev != null) { se.exSum += exDev; se.exN++; }
    },
  };
}

/* K と B を突き合わせる。6艇そろって1〜3着が確定しているレースだけ返す。
   base（index.json の base）を渡すと、時点つきの指標も一緒に作る。 */
export function loadRaces({ from = '', to = '', prog = null, base = null } = {}) {
  const P = prog || loadPrograms({ from, to });
  const roll = makeRolling(base);
  const out = [];
  for (const k of jsonl('data/boat/results.jsonl', from, to)) {
    const b = P.get(`${k.date}|${k.jcd}|${k.r}`);
    if (!b) continue;
    const byLane = new Map(b.boats.map(x => [x.lane, x]));
    const boats = k.entries.map(e => ({ ...byLane.get(e.lane), ...e, lane: e.lane }));
    if (boats.length !== 6 || boats.some(x => x.toban == null || x.natWin == null)) continue;
    const fin = [1, 2, 3].map(p => boats.findIndex(x => Number(x.pos) === p));
    /* 時点つきの指標は「このレースを足す前」に読む */
    const exs = boats.map(b => b.ex).filter(v => v != null);
    const exMean = exs.length ? exs.reduce((a, b) => a + b, 0) / exs.length : null;
    for (const b of boats) Object.assign(b, roll.read(k, b));
    const keep = fin.every(i => i >= 0);
    for (const b of boats) roll.push(k, b, b._p, exMean != null && b.ex != null ? exMean - b.ex : null);
    for (const b of boats) delete b._p;
    if (!keep) continue;
    out.push({ ...k, boats, order: fin, fin: fin.map(i => boats[i].lane) });
  }
  return out;
}
