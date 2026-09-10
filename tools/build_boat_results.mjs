/* 記録した予想（preds.jsonl）と成績（results.jsonl の K）を突き合わせ、
   日別・場別の的中率と回収率を出す → data/boat/results.json
   南関の build_results.mjs と同じ考え方：予想は締切が過ぎた時点で記録したものを使い、
   後から作り直さない。買い方は backtest_boat.mjs と同じ（1点100円）。
     ◎単勝 / ◎複勝 / ◎○2連単 / ◎○2連複 / 本命3艇BOX 3連複(1点) / 本命3艇BOX 3連単(6点) / 本命4艇BOX 3連複(4点)
     基準：1号艇の単勝・複勝
   K は開催中に途中まで公開されるので、日中は「ここまでのレース」で更新されていく。
     BT_REC_DAYS … 何日ぶんを載せるか（既定 30） */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, writeJSON, VNAME } from './lib/bt.mjs';

const DAYS = Number(process.env.BT_REC_DAYS || 30);
const PREDS = path.join(ROOT, 'data/boat/preds.jsonl');
if (!fs.existsSync(PREDS)) { console.error('preds.jsonl がまだ無い（締切が過ぎたレースを build_boat が記録する）'); process.exit(0); }

const preds = new Map();
for (const l of fs.readFileSync(PREDS, 'utf8').split('\n')) if (l) { try { const o = JSON.parse(l); preds.set(`${o.date}|${o.jcd}|${o.r}`, o); } catch { } }
const dates = [...new Set([...preds.values()].map(o => o.date))].sort().slice(-DAYS);
const want = new Set(dates);

/* 成績は対象日の行だけ読む（222MB を JSON.parse しない） */
const K = new Map();
for (const line of fs.readFileSync(path.join(ROOT, 'data/boat/results.jsonl'), 'utf8').split('\n')) {
  const m = line.match(/^\{"date":"(\d{8})","jcd":"(\d\d)"/);
  if (!m || !want.has(m[1])) continue;
  const o = JSON.parse(line);
  K.set(`${o.date}|${o.jcd}|${o.r}`, o);
}

const payOf = (k, kind, code) => { const h = (k.pay?.[kind] || []).find(x => x.c === code); return h ? h.y : 0; };
const sortKey = a => a.slice().sort((x, y) => x - y).join('-');
const BETS = ['◎単勝', '◎複勝', '◎○2連単', '◎○2連複', '3艇BOX3連複', '3艇BOX3連単', '4艇BOX3連複', '［基準］1号艇単勝', '［基準］1号艇複勝',
  /* 2連単・3連単の買い方（点数は名前のとおり。1点100円） */
  '2連単 ◎→○▲(2点)', '2連単 ◎○表裏(2点)', '2連単 ◎→○▲△(3点)',
  '3連単 ◎○▲(1点)', '3連単 ◎1着流し(6点)', '3連単 4艇BOX(24点)', '3連単 ◎○→▲△(4点)'];
/* モデルの3連単本線（tri1）は PL の性質上つねに ◎→○→▲ と同じ組なので、列としては持たない */
const mk = () => ({ races: 0, hit1: 0, in3: 0, bets: Object.fromEntries(BETS.map(b => [b, { n: 0, hit: 0, bet: 0, ret: 0 }])) });
const add = (S, name, bet, ret, hit) => { const o = S.bets[name]; o.n++; o.bet += bet; o.ret += ret; o.hit += hit ? 1 : 0; };

function settle(p, k) {
  const fin = [1, 2, 3].map(pos => k.entries.find(e => Number(e.pos) === pos)?.lane);
  if (fin.some(x => x == null)) return null;
  const [f1, f2, f3] = fin, t = p.top;
  const S = mk();
  S.races = 1; S.hit1 = t[0] === f1 ? 1 : 0; S.in3 = t.slice(0, 3).includes(f1) ? 1 : 0;
  add(S, '◎単勝', 100, t[0] === f1 ? payOf(k, 'win', String(t[0])) : 0, t[0] === f1);
  add(S, '◎複勝', 100, [f1, f2].includes(t[0]) ? payOf(k, 'place', String(t[0])) : 0, [f1, f2].includes(t[0]));
  add(S, '◎○2連単', 100, t[0] === f1 && t[1] === f2 ? payOf(k, 'ex2', `${t[0]}-${t[1]}`) : 0, t[0] === f1 && t[1] === f2);
  const q = sortKey([t[0], t[1]]), fq = sortKey([f1, f2]);
  add(S, '◎○2連複', 100, q === fq ? payOf(k, 'qn', q) : 0, q === fq);
  const b3 = sortKey(t.slice(0, 3)), f3k = sortKey([f1, f2, f3]);
  add(S, '3艇BOX3連複', 100, b3 === f3k ? payOf(k, 'tri', b3) : 0, b3 === f3k);
  add(S, '3艇BOX3連単', 600, b3 === f3k ? payOf(k, 'ex3', `${f1}-${f2}-${f3}`) : 0, b3 === f3k);
  const b4 = t.slice(0, 4), hit4 = [f1, f2, f3].every(x => b4.includes(x));
  add(S, '4艇BOX3連複', 400, hit4 ? payOf(k, 'tri', f3k) : 0, hit4);
  add(S, '［基準］1号艇単勝', 100, f1 === 1 ? payOf(k, 'win', '1') : 0, f1 === 1);
  add(S, '［基準］1号艇複勝', 100, [f1, f2].includes(1) ? payOf(k, 'place', '1') : 0, [f1, f2].includes(1));
  /* 2連単・3連単。的中したら その組の払戻、外れなら 0。点数ぶんの投資 */
  const ex2 = payOf(k, 'ex2', `${f1}-${f2}`), ex3 = payOf(k, 'ex3', `${f1}-${f2}-${f3}`);
  const hitEx2 = pairs => pairs.some(([a, b]) => a === f1 && b === f2);
  const hitEx3 = tris => tris.some(([a, b, c]) => a === f1 && b === f2 && c === f3);
  const [t1, t2, t3, t4] = t;
  let P = [[t1, t2], [t1, t3]]; add(S, '2連単 ◎→○▲(2点)', 200, hitEx2(P) ? ex2 : 0, hitEx2(P));
  P = [[t1, t2], [t2, t1]]; add(S, '2連単 ◎○表裏(2点)', 200, hitEx2(P) ? ex2 : 0, hitEx2(P));
  P = [[t1, t2], [t1, t3], [t1, t4]]; add(S, '2連単 ◎→○▲△(3点)', 300, hitEx2(P) ? ex2 : 0, hitEx2(P));
  let T = [[t1, t2, t3]]; add(S, '3連単 ◎○▲(1点)', 100, hitEx3(T) ? ex3 : 0, hitEx3(T));
  T = []; for (const a of [t2, t3, t4]) for (const b of [t2, t3, t4]) if (a !== b) T.push([t1, a, b]);
  add(S, '3連単 ◎1着流し(6点)', 600, hitEx3(T) ? ex3 : 0, hitEx3(T));
  T = []; for (const a of b4) for (const b of b4) for (const c of b4) if (a !== b && b !== c && a !== c) T.push([a, b, c]);
  add(S, '3連単 4艇BOX(24点)', 2400, hitEx3(T) ? ex3 : 0, hitEx3(T));
  T = [[t1, t2, t3], [t1, t2, t4], [t2, t1, t3], [t2, t1, t4]];
  add(S, '3連単 ◎○→▲△(4点)', 400, hitEx3(T) ? ex3 : 0, hitEx3(T));
  return S;
}
const merge = (A, B) => { A.races += B.races; A.hit1 += B.hit1; A.in3 += B.in3; for (const b of BETS) { const x = A.bets[b], y = B.bets[b]; x.n += y.n; x.hit += y.hit; x.bet += y.bet; x.ret += y.ret; } };
const fin = S => ({
  races: S.races, hit1: S.races ? +(S.hit1 / S.races).toFixed(3) : null, in3: S.races ? +(S.in3 / S.races).toFixed(3) : null,
  bets: Object.fromEntries(BETS.map(b => { const x = S.bets[b]; return [b, { n: x.n, hit: x.n ? +(x.hit / x.n).toFixed(3) : null, bet: x.bet, ret: x.ret, roi: x.bet ? +(x.ret / x.bet).toFixed(3) : null }]; })),
});

const out = { built: new Date().toISOString(), bets: BETS, days: [], total: null };
const TOTAL = mk();
let matched = 0, pending = 0;
for (const date of dates) {
  const byV = new Map();
  const DAY = mk();
  for (const p of preds.values()) {
    if (p.date !== date) continue;
    const k = K.get(`${p.date}|${p.jcd}|${p.r}`);
    if (!k) { pending++; continue; }
    const S = settle(p, k);
    if (!S) { pending++; continue; }
    matched++;
    let V = byV.get(p.jcd); if (!V) byV.set(p.jcd, V = { S: mk(), preds: 0, late: 0 });
    merge(V.S, S); merge(DAY, S); merge(TOTAL, S);
    V.preds++; if (p.late > 30) V.late++;
  }
  const venues = [...byV.keys()].sort().map(jcd => ({ jcd, name: VNAME[jcd], late: byV.get(jcd).late, ...fin(byV.get(jcd).S) }));
  out.days.push({ date, venues, ...fin(DAY) });
}
out.total = fin(TOTAL);
out.note = `予想は締切後に記録したもの（late＝締切30分以上あとに記録したレース数。モデルはオッズを使わないので中身は同じ）。成績は公式ダウンロードデータ（K）。`;
writeJSON('data/boat/results.json', out);
const T = out.total;
console.error(`${dates.length}日 ${matched}R を精算（未確定 ${pending}R）。◎的中 ${T.hit1 != null ? (T.hit1 * 100).toFixed(1) : '—'}%／◎単勝 回収 ${T.bets['◎単勝'].roi != null ? (T.bets['◎単勝'].roi * 100).toFixed(1) : '—'}%／3艇BOX3連複 ${T.bets['3艇BOX3連複'].roi != null ? (T.bets['3艇BOX3連複'].roi * 100).toFixed(1) : '—'}% -> data/boat/results.json`);
