/* JRA の出馬表（cards.jsonl）にモデルを当てて、jra.html に埋め込むデータを作る → data/jra/races.json
   南関の build_races + build_marks、ボートの build_boat に相当。
   - 予測は lib/jfeat.mjs の特徴量 × model.json（第1段＋温度）。出馬表にオッズがあれば第2段（人気との合成）
   - 組の確率は lib/jbets.mjs（馬連・馬単・三連複・三連単・ワイド）
   - 前5走は cards.jsonl の past（results から組んだもの）をそのまま馬柱に出す
     JRA_TODAY … 基準日（既定 今日）。これ以降の開催日だけ載せる */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, readJSON, writeJSON } from './lib/jra.mjs';
import { FEATURES, NF, buildRaceIndex, buildHistory, buildAsOf, loadPed, raceFromCard, makeFeaturizer } from './lib/jfeat.mjs';
import { utilities } from './lib/bpl.mjs';
import { combosOf } from './lib/jbets.mjs';

const TODAY = process.env.JRA_TODAY || new Date().toLocaleDateString('sv-SE');
const DB = readJSON('data/jra/index.json');
const M = readJSON('data/jra/model.json');
let BT = null; try { BT = readJSON('data/jra/backtest.json'); } catch { }
const beta = Float64Array.from(M.base.beta), tau = M.base.tau, mix = M.mix;
if (M.meta.feats.join() !== FEATURES.join()) throw new Error('model.json の特徴量が lib/jfeat.mjs と合わない。jra_fit.mjs を回し直す');
const round = (v, k = 3) => v == null || !Number.isFinite(v) ? null : Number(v.toFixed(k));

const results = [];
for (const l of fs.readFileSync(path.join(ROOT, 'data/jra/results.jsonl'), 'utf8').split('\n')) if (l) { const r = JSON.parse(l); if (r.surface !== '障') results.push(r); }
const PED = loadPed(fs.existsSync(path.join(ROOT, 'data/jra/horses.jsonl')) ? fs.readFileSync(path.join(ROOT, 'data/jra/horses.jsonl'), 'utf8') : '');
const RI = buildRaceIndex(results), H = buildHistory(results), ASOF = buildAsOf(results, PED);
console.error(`  血統・馬主 ${PED.size} 頭`);
const featurize = makeFeaturizer(DB, RI, ASOF);

const cards = [];
for (const l of fs.readFileSync(path.join(ROOT, 'data/jra/cards.jsonl'), 'utf8').split('\n')) if (l) { const c = JSON.parse(l); if (c.date >= TODAY && c.surface !== '障') cards.push(c); }
cards.sort((a, b) => a.date.localeCompare(b.date) || a.raceId.localeCompare(b.raceId));

/* 係数×特徴量を読める単位に束ねる */
const GROUP = {
  ability: '近走', clsAbility: '近走', lastPos: '近走', lastMargin: '近走', winStreak: '近走', afterWin: '近走', nRuns: '近走', lastPop: '人気', lastOdds: '人気',
  close: '脚', agariRel: '脚', paceExp: '脚', fastFit: '脚', epos: '脚', frontPress: '展開', soloNige: '展開', sameStyle: '展開',
  stamina: '適性', surfFit: '適性', wet: '適性', wetX: '適性', venueFit: '適性', distChg: '適性', surfChg: '適性', classUp: '適性', downFirst: '適性',
  jIdx: '人', jVenue: '人', jSurf: '人', tIdx: '人', tSurf: '人', cIdx: '人', bond: '人', jForm: '人',
  sIdx: '血統', bmsIdx: '血統', sSurf: '血統', oIdx: '馬主',
  gateEdge: '枠', gate: '枠', kgRel: '斤量', bwLog: '馬体', bwDiff: '馬体', bwDev: '馬体', bwSwing: '馬体', bwRel: '馬体',
  restLog: '間隔', layoff: '間隔', age: 'その他', mare: 'その他',
};
const GROUPS = ['近走', '脚', '適性', '人', '血統', '馬主', '展開', '枠', '斤量', '馬体', '間隔', '人気', 'その他'];
const contrib = x => { const g = Object.fromEntries(GROUPS.map(k => [k, 0])); for (let i = 0; i < NF; i++) g[GROUP[FEATURES[i]] || 'その他'] += beta[i] * x[i]; return GROUPS.map(k => round(g[k], 2)); };

const days = new Map();
let nR = 0, nMix = 0;
for (const c of cards) {
  const race = raceFromCard(c, H);
  const f = featurize(race);
  if (!f) continue;
  const U = utilities(f.rows.map(x => x.x), beta);
  const hasOdds = f.rows.every(x => x.odds > 0);
  let Um = U, level = 'base';
  if (hasOdds && mix) { const inv = f.rows.map(x => 1 / x.odds), s = inv.reduce((a, b) => a + b, 0); Um = U.map((u, i) => (mix.a * tau[0] * u + mix.b * Math.log(inv[i] / s)) / tau[0]); level = 'mix'; nMix++; }
  /* 枠順確定前（木〜金）は馬番が無い。その間は組の確率と BOX は出さず、順位と確率だけ載せる */
  const gates = f.rows.every(x => x.no > 0);
  const lanes = f.rows.map((x, i) => gates ? x.no : i + 1);
  const C = combosOf(Um, tau, lanes);
  if (!gates) for (const k of ['umatan', 'umaren', 'santan', 'sanpuku', 'wide']) C[k] = [];
  const order = C.p1.map((p, i) => [p, i]).sort((a, b) => b[0] - a[0]).map(x => x[1]);
  const marks = {}; ['◎', '○', '▲', '△', '△', '☆'].forEach((m, i) => { if (order[i] != null) marks[order[i]] = m; });
  const horses = f.rows.map((x, i) => {
    const e = c.entries.find(en => en.no === x.no) || {};
    const d = x.d;
    const past = (race.horses[i].past || []).slice(0, 5).map(p => ({ date: p.date, venue: p.venue, pos: p.pos, name: p.name, cls: p.cls, surface: p.surface, dist: p.dist, time: p.time, baba: p.baba, n: p.n, no: p.no, pop: p.pop, jockey: p.jockey, kin: p.kin, pass: p.pass, agari: p.agari, bw: p.bw, bwDiff: p.bwDiff, winner: p.winner, margin: p.margin }));
    const p0 = past[0];
    const note = [];
    note.push(p0 ? `前走 ${p0.venue}${p0.surface || ''}${p0.dist || ''} ${p0.pop ? p0.pop + '人気' : ''}${p0.pos}着／近${past.length}走 ${past.map(p => p.pos).join('-')}` : 'JRA の前走なし（新馬・転入）');
    note.push(`脚質 ${d.style}（序盤の位置 ${(d.epos * 100).toFixed(0)}%）${d.agariRel ? `・上がり ${d.agariRel > 0 ? '+' : ''}${d.agariRel.toFixed(1)}秒（レース平均比）` : ''}`);
    const j = DB.jockey?.[e.jockeyId], t = DB.trainer?.[e.trainerId], cb = DB.combo?.[`${e.jockeyId}|${e.trainerId}`];
    note.push(`${e.jockey || ''}${j ? `（指数 ${j.idx >= 0 ? '+' : ''}${j.idx}${j.byVenue?.[c.venue] != null ? `・${c.venue} ${j.byVenue[c.venue] >= 0 ? '+' : ''}${j.byVenue[c.venue]}` : ''}）` : '（指数なし）'}×${e.trainer || ''}${t ? `（${t.idx >= 0 ? '+' : ''}${t.idx}）` : ''}${cb ? `／コンビ${cb.n}走${cb.bond >= 0.3 ? '・主戦' : cb.bond >= 0.12 ? '・準主戦' : ''}` : ''}`);
    const hf = x.hf || {};
    if (hf.sire || hf.owner) note.push(`血統 ${hf.sire || e.sire || '—'}${hf.sN ? `（産駒 ${hf.sN}走・指数 ${hf.sIdx >= 0 ? '+' : ''}${hf.sIdx.toFixed(2)}${hf.sSurf ? `・${c.surface} ${hf.sSurf >= 0 ? '+' : ''}${hf.sSurf.toFixed(2)}` : ''}）` : ''}／母父 ${hf.damsire || e.damsire || '—'}${hf.bN ? `（${hf.bmsIdx >= 0 ? '+' : ''}${hf.bmsIdx.toFixed(2)}）` : ''}${hf.owner ? `／馬主 ${hf.owner}${hf.oN ? `（${hf.oN}走・${hf.oIdx >= 0 ? '+' : ''}${hf.oIdx.toFixed(2)}）` : ''}` : ''}`);
    return {
      owner: hf.owner || null,
      no: x.no, waku: x.waku, name: x.name, horseId: x.horseId, sexAge: e.sexAge, color: e.color, kin: e.kin, jockey: e.jockey, jockeyId: e.jockeyId, trainer: e.trainer, trainerId: e.trainerId, stable: e.stable,
      sire: e.sire, dam: e.dam, damsire: e.damsire, bw: e.bw, bwDiff: e.bwDiff, odds: e.odds, pop: e.pop,
      mark: marks[i] || '', p1: round(C.p1[i], 4), top2: round(C.top2[i], 3), top3: round(C.top3[i], 3), U: round(Um[i], 2), style: d.style,
      c: contrib(x.x), jIdx: round(x.jIdx, 2), tIdx: round(x.tIdx, 2), cIdx: round(x.cIdx, 2), note, past,
    };
  });
  const box = k => gates ? order.slice(0, k).map(i => lanes[i]).sort((a, b) => a - b) : [];
  const top = i => horses[order[i]];
  const nn = h => gates ? `${h.no} ${h.name}` : h.name;
  const pts = [];
  if (!gates) pts.push('枠順確定前（金曜夕方に確定）。馬番・枠・組の確率は確定後に出す。');
  pts.push(`本命 ${nn(top(0))}（1着 ${(C.p1[order[0]] * 100).toFixed(1)}%）、対抗 ${nn(top(1))}（${(C.p1[order[1]] * 100).toFixed(1)}%）、単穴 ${nn(top(2))}。`);
  const K = DB.course?.[`${c.venue}|${c.surface}|${c.dist}`];
  if (K) pts.push(`${c.venue}${c.surface}${c.dist}m：3着内のうち前方にいた馬 ${(K.front3 * 100).toFixed(0)}%（出走の ${(K.frontShare * 100).toFixed(0)}%）。枠の得失 ${K.waku.map((v, i) => v != null ? `${i + 1}枠${v.toFixed(2)}` : '').filter(Boolean).join(' ')}（1.00が損得なし）。`);
  const nige = horses.filter(h => h.style === '逃げ');
  pts.push(nige.length ? `逃げ候補 ${nige.map(h => h.no + ' ' + h.name).join('、')}${nige.length >= 2 ? '（競り合えばペースが上がり差しが届く）' : '（単騎なら楽に運べる）'}。` : '明確な逃げ馬が不在。先行馬有利の流れになりやすい。');
  if (gates) pts.push(`馬連の本線 ${C.umaren[0][0]}（${(C.umaren[0][1] * 100).toFixed(1)}%）、三連複 ${C.sanpuku[0][0]}（${(C.sanpuku[0][1] * 100).toFixed(1)}%）。`);
  const race1 = {
    raceId: c.raceId, r: c.r, name: c.name, grade: c.grade || null, start: c.start, surface: c.surface, dist: c.dist, turn: c.turn, inner: c.inner || null, cond: c.cond, cls: race.cls, weather: c.weather, baba: c.baba, n: horses.length, level, gates,
    horses, box3: box(3), box4: box(4), box5: box(5),
    umaren: C.umaren.slice(0, 6).map(([k, p]) => ({ k, p: round(p, 4) })), umatan: C.umatan.slice(0, 5).map(([k, p]) => ({ k, p: round(p, 4) })),
    sanpuku: C.sanpuku.slice(0, 6).map(([k, p]) => ({ k, p: round(p, 4) })), santan: C.santan.slice(0, 8).map(([k, p]) => ({ k, p: round(p, 4) })), wide: C.wide.slice(0, 5).map(([k, p]) => ({ k, p: round(p, 4) })),
    conf: round(1 - (-C.p1.reduce((a, p) => a + (p > 0 ? p * Math.log(p) : 0), 0)) / Math.log(C.p1.length), 3),
    points: pts,
  };
  const D = days.get(c.date) || days.set(c.date, new Map()).get(c.date);
  (D.get(c.venue) || D.set(c.venue, []).get(c.venue)).push(race1);
  nR++;
}
const out = {
  meta: {
    built: new Date().toISOString(), today: TODAY, groups: GROUPS,
    model: { built: M.meta.built, split: M.meta.split, train: M.meta.train, test: M.meta.test, base: M.base.test, mix: M.mix?.test || null, mixCoef: mix ? { a: mix.a, b: mix.b } : null, popOnly: M.popOnly },
    index: { from: DB.meta.from, to: DB.meta.to, races: DB.meta.races, runs: DB.meta.runs },
    backtest: BT ? { level: BT.meta.level, from: BT.meta.from, to: BT.meta.to, races: BT.meta.races, table: BT.table, note: BT.meta.note } : null,
  },
  days: [...days].map(([date, V]) => ({ date, venues: [...V].map(([venue, races]) => ({ venue, races: races.sort((a, b) => a.r - b.r) })) })),
};
writeJSON('data/jra/races.json', out);
/* TOP（top.html）用のたたんだ版 */
const top = {
  builtAt: out.meta.built, today: TODAY, model: out.meta.model, backtest: out.meta.backtest,
  days: out.days.map(d => ({ date: d.date, venues: d.venues.map(v => ({ venue: v.venue, races: v.races.map(r => {
    const t = r.horses.slice().sort((a, b) => b.p1 - a.p1).slice(0, 3);
    return { r: r.r, name: r.name, grade: r.grade, start: r.start, surface: r.surface, dist: r.dist, n: r.n, cls: r.cls, level: r.level, conf: r.conf, gates: r.gates,
      top: t.map(h => ({ no: h.no, waku: h.waku, name: h.name, p: r.horses.length ? round(h.p1, 3) : null, odds: h.odds, jockey: (h.jockey || '').replace(/\s/g, '') })),
      box3: r.box3, umaren: r.umaren[0], sanpuku: r.sanpuku[0] };
  }) })) })),
};
writeJSON('data/jra/top.json', top);
console.error(`${TODAY} 以降 ${nR}R（第2段＝オッズあり ${nMix}R）-> data/jra/races.json (${(fs.statSync(path.join(ROOT, 'data/jra/races.json')).size / 1024).toFixed(0)} KB)`);
for (const d of out.days) for (const v of d.venues) console.error(`  ${d.date} ${v.venue} ${v.races.length}R`);
