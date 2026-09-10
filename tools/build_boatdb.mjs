/* K（競走成績）と B（番組表）から、選手・モーター・場の指数を作る。
   単位は南関側と同じ「対数オッズ差」に統一する。0 が平均、+0.7 でおよそ勝率2倍。
   ボートは着順がコースにほぼ支配されるので、素の勝率を選手の実力として扱ってはいけない。
   ここでは「場×コースの基準勝率からの上振れ」を 1パラメータのリッジロジスティックで推定する。
       logit(p_i) = logit(p0(場, コース)) + θ      θ が実力
   標本の少ない選手は θ が 0（＝基準どおり）へ縮む。
   出力: data/boat/index.json（コミット対象） */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, VENUES, VNAME, writeJSON, readJSON } from './lib/bt.mjs';

const KFILE = path.join(ROOT, 'data', 'boat', 'results.jsonl');
const BFILE = path.join(ROOT, 'data', 'boat', 'programs.jsonl');
const FROM = process.env.BT_DB_FROM || '';                 // YYYYMMDD 以降だけ使う（先読み回避用）
const TO = process.env.BT_DB_TO || '';
const OUT = process.env.BT_DB_OUT || 'data/boat/index.json';
const SD = Number(process.env.BT_DB_SD || 0.55);           // θ の事前分布の広さ（対数オッズ）
const SD_SUB = Number(process.env.BT_DB_SD_SUB || 0.40);   // コース別・場別は本人の θ から動きにくくする

const KIMARI = ['逃げ', 'まくり', '差し', 'まくり差し', '抜き', '恵まれ'];
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const logit = p => Math.log(clamp(p, 1e-4, 1 - 1e-4) / (1 - clamp(p, 1e-4, 1 - 1e-4)));
const sig = z => 1 / (1 + Math.exp(-z));

/* リッジ付き1パラメータのロジスティック回帰。
   bins: [{z, n, w}]（z=基準の対数オッズ、n=走数、w=当たった数）prior: θ の中心 */
function fitTheta(bins, sd, prior = 0) {
  let t = prior;
  const iv = 1 / (sd * sd);
  for (let it = 0; it < 40; it++) {
    let g = -(t - prior) * iv, h = -iv;
    for (const b of bins) { const p = sig(b.z + t); g += b.w - b.n * p; h -= b.n * p * (1 - p); }
    const step = g / h;
    t -= step;
    if (Math.abs(step) < 1e-9) break;
  }
  return t;
}
const round = (v, d = 3) => v == null || !isFinite(v) ? null : Number(v.toFixed(d));

/* ---------- 読み込み ---------- */
function* jsonl(file) {
  if (!fs.existsSync(file)) throw new Error(`${file} がない。先に fetch_od2.mjs を回す`);
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    const o = JSON.parse(line);
    if (FROM && o.date < FROM) continue;
    if (TO && o.date > TO) continue;
    yield o;
  }
}

console.error('K を読む…');
const races = [...jsonl(KFILE)];
console.error(`  ${races.length} レース（${races[0]?.date} 〜 ${races.at(-1)?.date}）`);

/* ---------- 1. 場×コースの基準（p0） ---------- */
const base = new Map();                                  // 'jcd|course' -> {n,w,w2,w3,st,stn,kim:[]}
const key = (jcd, c) => jcd + '|' + c;
const allC = { n: 0, w: 0, w2: 0, w3: 0 };
for (const r of races) {
  for (const e of r.entries) {
    if (!e.course) continue;
    const k = key(r.jcd, e.course);
    let b = base.get(k);
    if (!b) base.set(k, b = { n: 0, w: 0, w2: 0, w3: 0, st: 0, stn: 0, kim: KIMARI.map(() => 0) });
    const p = Number(e.pos);
    b.n++; allC.n++;
    if (p === 1) { b.w++; allC.w++; b.kim[Math.max(0, KIMARI.indexOf(r.kimari))]++; }
    if (p >= 1 && p <= 2) { b.w2++; allC.w2++; }
    if (p >= 1 && p <= 3) { b.w3++; allC.w3++; }
    if (e.st != null && !e.f) { b.st += e.st; b.stn++; }
  }
}
const p0 = {}, p0z = {};
for (const [k, b] of base) {
  p0[k] = { win: round(b.w / b.n, 4), top2: round(b.w2 / b.n, 4), top3: round(b.w3 / b.n, 4), st: b.stn ? round(b.st / b.stn, 4) : null, n: b.n, kim: b.kim.map(x => round(x / Math.max(1, b.w), 4)) };
  p0z[k] = { win: logit(p0[k].win), top2: logit(p0[k].top2), top3: logit(p0[k].top3) };
}
console.error(`  場×コースの基準 ${base.size} 通り`);

/* ---------- 2. 選手 ---------- */
const R = new Map();                                     // toban -> {name, n, byCC:Map, byJ:Map, st, kim, ...}
function racer(toban, name) {
  let x = R.get(toban);
  if (!x) R.set(toban, x = {
    toban, name, n: 0, w: 0, w2: 0, w3: 0, f: 0, l: 0, s: 0,
    byCC: new Map(), byC: new Map(), byJ: new Map(),
    st: 0, stn: 0, stByC: new Map(), kim: KIMARI.map(() => 0), ex: 0, exn: 0, last: '',
    inGain: 0, inN: 0,
  });
  if (name) x.name = name;
  return x;
}
const bump = (m, k, f) => { let v = m.get(k); if (!v) m.set(k, v = { n: 0, w: 0, w2: 0, w3: 0, st: 0, stn: 0 }); f(v); };

for (const r of races) {
  for (const e of r.entries) {
    const x = racer(e.toban, e.name);
    x.last = r.date;
    const p = Number(e.pos);
    const ok = p >= 1 && p <= 6;
    if (e.f) x.f++;
    if (e.l) x.l++;
    if (!ok && !e.f && !e.l) x.s++;
    if (!e.course) continue;
    x.n++;
    const k = key(r.jcd, e.course);
    if (p === 1) { x.w++; x.kim[Math.max(0, KIMARI.indexOf(r.kimari))]++; }
    if (p <= 2 && ok) x.w2++;
    if (p <= 3 && ok) x.w3++;
    bump(x.byCC, k, v => { v.n++; if (p === 1) v.w++; if (p <= 2 && ok) v.w2++; if (p <= 3 && ok) v.w3++; });
    bump(x.byC, e.course, v => { v.n++; if (p === 1) v.w++; if (p <= 2 && ok) v.w2++; if (p <= 3 && ok) v.w3++; });
    bump(x.byJ, r.jcd, v => { v.n++; if (p === 1) v.w++; if (p <= 2 && ok) v.w2++; if (p <= 3 && ok) v.w3++; });
    if (e.st != null && !e.f) {
      x.st += e.st; x.stn++;
      bump(x.stByC, e.course, v => { v.n++; v.st += e.st; });
    }
    if (e.ex != null) { x.ex += e.ex; x.exn++; }
    x.inGain += e.lane - e.course; x.inN++;      // 枠より内を取ったか（＋＝前づけ）
  }
}
console.error(`  選手 ${R.size} 人`);

/* 級別・支部・年齢・体重は B（番組表）の最新行から拾う */
console.error('B を読む…');
const prof = new Map();
let bRaces = 0;
for (const r of jsonl(BFILE)) {
  bRaces++;
  for (const b of r.boats) {
    const q = prof.get(b.toban);
    if (!q || q.date < r.date) prof.set(b.toban, { date: r.date, name: b.name, age: b.age, branch: b.branch, weight: b.weight, grade: b.grade, natWin: b.natWin, nat2: b.nat2 });
  }
}
console.error(`  ${bRaces} レース、プロフィール ${prof.size} 人`);

const binsOf = (m, kind, f = k => k) => [...m].map(([k, v]) => ({ z: (p0z[f(k)] || { [kind]: logit(kind === 'win' ? 1 / 6 : kind === 'top2' ? 2 / 6 : 3 / 6) })[kind], n: v.n, w: v[kind === 'win' ? 'w' : kind === 'top2' ? 'w2' : 'w3'] }));

const racers = {};
const stAll = [...R.values()].reduce((a, x) => a + x.st, 0) / [...R.values()].reduce((a, x) => a + x.stn, 0);
for (const x of R.values()) {
  if (x.n < 20) continue;                                 // 20走未満は指数を出さない
  const idx = fitTheta(binsOf(x.byCC, 'win'), SD);
  const idx2 = fitTheta(binsOf(x.byCC, 'top2'), SD);
  const idx3 = fitTheta(binsOf(x.byCC, 'top3'), SD);
  /* コース別・場別は本人の idx を事前分布に置いて縮小する（南関の byTrack と同じ考え方） */
  const byC = {}, byJ = {};
  for (const [c, v] of x.byC) if (v.n >= 8) byC[c] = round(fitTheta(
    [...x.byCC].filter(([k]) => Number(k.split('|')[1]) === c).map(([k, w]) => ({ z: p0z[k].win, n: w.n, w: w.w })), SD_SUB, idx) - idx, 3);
  for (const [j, v] of x.byJ) if (v.n >= 12) byJ[j] = round(fitTheta(
    [...x.byCC].filter(([k]) => k.split('|')[0] === j).map(([k, w]) => ({ z: p0z[k].win, n: w.n, w: w.w })), SD_SUB, idx) - idx, 3);

  const stByC = {};
  for (const [c, v] of x.stByC) if (v.n >= 8) stByC[c] = round(v.st / v.n, 3);
  const p = prof.get(x.toban) || {};
  racers[x.toban] = {
    name: p.name || x.name, grade: p.grade || null, branch: p.branch || null,
    age: p.age ?? null, weight: p.weight ?? null,
    n: x.n, win: round(x.w / x.n, 4), top2: round(x.w2 / x.n, 4), top3: round(x.w3 / x.n, 4),
    idx: round(idx), idx2: round(idx2), idx3: round(idx3),
    byC, byJ,
    st: x.stn ? round(x.st / x.stn, 3) : null,
    stDev: x.stn ? round(x.st / x.stn - stAll, 3) : null,     // 平均より小さい＝速い
    stByC,
    fRate: round(x.f / Math.max(1, x.n), 4), lRate: round(x.l / Math.max(1, x.n), 4),
    sRate: round(x.s / Math.max(1, x.n), 4),
    kim: x.w ? x.kim.map(v => round(v / x.w, 3)) : null,       // 1着の決まり手の内訳＝攻撃型か
    ex: x.exn ? round(x.ex / x.exn, 3) : null,
    inGain: x.inN ? round(x.inGain / x.inN, 3) : null,
    last: x.last,
  };
}
console.error(`  指数を出した選手 ${Object.keys(racers).length} 人（20走以上）`);

/* ---------- 3. モーター（場×番号×年度） ---------- */
/* モーターは場ごとに年1回入れ替わる。番号だけでは別individualが混ざるので年度で割る。
   年度の境目は場によって違うため、番号ごとに「40日以上あいたら別individual」で切る。 */
const M = new Map();
const seen = new Map();                                   // 'jcd|no' -> {gen, last}
for (const r of races) {
  for (const e of r.entries) {
    if (!e.motor) continue;
    const kk = r.jcd + '|' + e.motor;
    const s = seen.get(kk);
    const t = new Date(`${r.date.slice(0, 4)}-${r.date.slice(4, 6)}-${r.date.slice(6, 8)}`).getTime();
    let gen = 1;
    if (s) { gen = (t - s.last) / 86400000 > 40 ? s.gen + 1 : s.gen; }
    seen.set(kk, { gen, last: t });
    const k2 = kk + '|' + gen;
    let v = M.get(k2);
    if (!v) M.set(k2, v = { jcd: r.jcd, no: e.motor, gen, n: 0, w: 0, w2: 0, w3: 0, from: r.date, to: r.date, bins: new Map() });
    const p = Number(e.pos), ok = p >= 1 && p <= 6;
    v.n++; v.to = r.date;
    if (p === 1) v.w++;
    if (p <= 2 && ok) v.w2++;
    if (p <= 3 && ok) v.w3++;
    if (e.course) { const bk = key(r.jcd, e.course); const b = v.bins.get(bk) || { n: 0, w: 0, w2: 0 }; b.n++; if (p === 1) b.w++; if (p <= 2 && ok) b.w2++; v.bins.set(bk, b); }
  }
}
const motors = {};
for (const v of M.values()) {
  if (v.n < 15) continue;
  const bins = [...v.bins].map(([k, b]) => ({ z: p0z[k].win, n: b.n, w: b.w }));
  const bins2 = [...v.bins].map(([k, b]) => ({ z: p0z[k].top2, n: b.n, w: b.w2 }));
  (motors[v.jcd] ||= {})[v.no + '#' + v.gen] = {
    n: v.n, from: v.from, to: v.to,
    win: round(v.w / v.n, 4), top2: round(v.w2 / v.n, 4),
    idx: round(fitTheta(bins, 0.35)), idx2: round(fitTheta(bins2, 0.35)),
  };
}
console.error(`  モーター ${Object.values(motors).reduce((a, o) => a + Object.keys(o).length, 0)} 基`);

/* ---------- 4. 場（K データ実測。公式の stadium.json と照合できる） ---------- */
const venues = {};
for (const v of VENUES) {
  const cs = [];
  for (let c = 1; c <= 6; c++) {
    const b = base.get(key(v.jcd, c));
    cs.push(b ? { n: b.n, win: round(b.w / b.n, 4), top2: round(b.w2 / b.n, 4), top3: round(b.w3 / b.n, 4), st: b.stn ? round(b.st / b.stn, 3) : null, kim: p0[key(v.jcd, c)].kim } : null);
  }
  const rs = races.filter(r => r.jcd === v.jcd);
  if (!rs.length) continue;
  const kim = KIMARI.map(k => rs.filter(r => r.kimari === k).length / rs.length);
  const dist = {}, wea = {};
  for (const r of rs) { dist[r.dist] = (dist[r.dist] || 0) + 1; wea[r.weather] = (wea[r.weather] || 0) + 1; }
  venues[v.jcd] = {
    ...v, races: rs.length, course: cs, kim: kim.map(x => round(x, 4)),
    dist, weather: wea,
    wind: round(rs.reduce((a, r) => a + (r.wind || 0), 0) / rs.length, 2),
    wave: round(rs.reduce((a, r) => a + (r.wave || 0), 0) / rs.length, 2),
    stableRate: round(rs.filter(r => r.stable).length / rs.length, 4),
  };
}

writeJSON(OUT, {
  meta: {
    built: new Date().toISOString().slice(0, 10),
    from: races[0]?.date, to: races.at(-1)?.date, races: races.length,
    sd: SD, sdSub: SD_SUB, kimari: KIMARI,
    note: '指数は「場×コースの基準勝率からの対数オッズ差」。0 が基準どおり、+0.7 でおよそ勝率2倍',
  },
  base: p0, venues, racer: racers, motor: motors,
});
