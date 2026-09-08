/* 過去の開催で、予想上位 k 頭の BOX を買い続けたらどうだったかを日別に集計する。
   使う予想は index.html のモデルそのもの（lib/model.mjs 経由）。別式は作らない。
   券種は 馬連(普通馬複)・馬単・三連複・三連単・枠単 の5つ。1点100円。
   比較用に「人気上位 k 頭 BOX」も同じ条件で計算する。

   使い方: NK_BT_TRACKS=大井 NK_BT_FROM=2026-08-31 NK_BT_TO=2026-09-04 node tools/backtest.mjs
   出力: data/nankan/backtest.json                                            */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, readJSON, writeJSON } from './lib/nk.mjs';
import { makeDerivers } from './lib/horse.mjs';
import { loadModel, condOf } from './lib/model.mjs';

const TRACKS = (process.env.NK_BT_TRACKS || '大井').split(',');
const KEY = { '大井': 'oi', '川崎': 'kawasaki', '船橋': 'funabashi', '浦和': 'urawa' };
const FROM = process.env.NK_BT_FROM || '2000-01-01';
const TO = process.env.NK_BT_TO || new Date().toISOString().slice(0, 10);
const TRIALS = Number(process.env.NK_BT_TRIALS || 800);
const SIZES = (process.env.NK_BT_SIZES || '3,4,5,6').split(',').map(Number);
const UNIT = 100;

const DB = readJSON('data/nankan/index.json');
const { derive, human, pedigree } = makeDerivers(DB);
const jl = f => fs.readFileSync(path.join(ROOT, 'data/nankan', f), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const cards = jl('cards.jsonl'), results = new Map(jl('results.jsonl').map(r => [r.raceId, r]));
const payouts = new Map(jl('payouts.jsonl').map(p => [p.raceId, p]));

/* ---- 買い目づくり（BOX） ---------------------------------------------- */
const pairs = a => { const o = []; for (let i = 0; i < a.length; i++) for (let j = i + 1; j < a.length; j++) o.push([a[i], a[j]]); return o; };
const ordPairs = a => { const o = []; for (const x of a) for (const y of a) if (x !== y) o.push([x, y]); return o; };
const triples = a => { const o = []; for (let i = 0; i < a.length; i++) for (let j = i + 1; j < a.length; j++) for (let k = j + 1; k < a.length; k++) o.push([a[i], a[j], a[k]]); return o; };
const ordTriples = a => { const o = []; for (const x of a) for (const y of a) for (const z of a) if (x !== y && y !== z && x !== z) o.push([x, y, z]); return o; };
const key = a => a.join('-');
const sortKey = a => a.slice().sort((x, y) => x - y).join('-');

/* 枠単は選んだ馬の枠の順列。同じ枠に2頭以上いるときだけゾロ目も買う */
function wakutanSet(sel, gateOf) {
  const gs = sel.map(gateOf);
  const cnt = {};
  gs.forEach(g => cnt[g] = (cnt[g] || 0) + 1);
  const uniq = [...new Set(gs)];
  const s = new Set();
  for (const a of uniq) for (const b of uniq) { if (a !== b) s.add(`${a}-${b}`); else if (cnt[a] >= 2) s.add(`${a}-${a}`); }
  return s;
}

function betsFor(sel, gateOf) {
  return {
    umaren: new Set(pairs(sel).map(sortKey)),
    umatan: new Set(ordPairs(sel).map(key)),
    sanpuku: sel.length >= 3 ? new Set(triples(sel).map(sortKey)) : new Set(),
    santan: sel.length >= 3 ? new Set(ordTriples(sel).map(key)) : new Set(),
    wakutan: wakutanSet(sel, gateOf),
  };
}
/* 配当の組番を買い目の表記に合わせる（連系は昇順、単系はそのまま） */
const norm = { umaren: sortKey, umatan: key, sanpuku: sortKey, santan: key, wakutan: key };
const TYPES = [['umaren', '馬連'], ['umatan', '馬単'], ['sanpuku', '三連複'], ['santan', '三連単'], ['wakutan', '枠単']];

const blank = () => ({ races: 0, points: 0, cost: 0, hits: 0, ret: 0 });
const bump = (acc, t, k, pts, hit, ret) => {
  const e = (acc[t] ||= {})[k] ||= blank();
  e.races++; e.points += pts; e.cost += pts * UNIT; if (hit) { e.hits++; e.ret += ret; }
};
const finish = acc => {
  for (const t of Object.keys(acc)) for (const k of Object.keys(acc[t])) {
    const e = acc[t][k];
    e.hitRate = e.races ? +(e.hits / e.races).toFixed(4) : 0;
    e.roi = e.cost ? +(e.ret / e.cost).toFixed(4) : 0;
    e.avgPoints = e.races ? +(e.points / e.races).toFixed(1) : 0;
  }
  return acc;
};

const out = { builtAt: new Date().toISOString(), from: FROM, to: TO, trials: TRIALS, unit: UNIT, sizes: SIZES, tracks: {} };

for (const track of TRACKS) {
  const M = loadModel(KEY[track] || 'oi');
  const mine = cards.filter(c => c.track === track && c.date >= FROM && c.date <= TO && payouts.has(c.raceId));
  const byDay = {};
  const model = {}, pop = {}, detail = [];
  for (const c of mine.sort((a, b) => a.raceId.localeCompare(b.raceId))) {
    const pay = payouts.get(c.raceId), res = results.get(c.raceId);
    if (!pay || !pay.order || pay.order.length < 3) continue;
    const live = c.horses.filter(h => !h.scratch);
    if (live.length < 4) continue;
    const gateOf = no => (live.find(h => h.no === no) || {}).gate || (res && res.gates[no]) || 0;

    /* 予想（本番と同じ導出＋同じモデル） */
    const horses = live.map(h => {
      const d = derive(h, c.dist), hu = human(h, track), pd = pedigree(h, c.dist);
      return { no: h.no, gate: h.gate, ...d, ...hu, ...pd };
    });
    const cond = condOf(M, c.dist, res && res.baba, res && res.weather);
    const mc = M.monteCarlo({ dist: c.dist, horses }, cond, TRIALS);
    const rank = mc.win.map((w, i) => [w, i]).sort((a, b) => b[0] - a[0]).map(([, i]) => horses[i].no);
    /* 比較用：単勝人気の上位 */
    const popRank = res ? live.map(h => h.no).filter(no => res.pops[no]).sort((a, b) => res.pops[a] - res.pops[b]) : [];

    const dayAcc = (byDay[c.date] ||= { date: c.date, races: 0, model: {}, pop: {} });
    dayAcc.races++;
    const hitsOf = (sel) => {
      const bets = betsFor(sel, gateOf);
      const r = {};
      for (const [t] of TYPES) {
        const set = bets[t];
        let ret = 0, hit = false;
        for (const p of (pay.pay[t] || [])) {
          const kk = norm[t](p.c.split('-').map(Number));
          if (set.has(kk)) { hit = true; ret += p.yen; }
        }
        r[t] = { points: set.size, hit, ret };
      }
      return r;
    };
    for (const k of SIZES) {
      if (live.length < k) continue;
      const mr = hitsOf(rank.slice(0, k));
      for (const [t] of TYPES) { bump(model, t, k, mr[t].points, mr[t].hit, mr[t].ret); bump(dayAcc.model, t, k, mr[t].points, mr[t].hit, mr[t].ret); }
      if (popRank.length >= k) {
        const pr = hitsOf(popRank.slice(0, k));
        for (const [t] of TYPES) { bump(pop, t, k, pr[t].points, pr[t].hit, pr[t].ret); bump(dayAcc.pop, t, k, pr[t].points, pr[t].hit, pr[t].ret); }
      }
    }
    detail.push({ date: c.date, R: c.R, dist: c.dist, n: live.length, baba: res ? res.baba : '',
      pick: rank.slice(0, 6), popPick: popRank.slice(0, 6), order: pay.order,
      santan: pay.pay.santan[0] ? pay.pay.santan[0].yen : null });
  }
  for (const d of Object.values(byDay)) { finish(d.model); finish(d.pop); }
  out.tracks[track] = { track, days: Object.values(byDay).sort((a, b) => a.date.localeCompare(b.date)),
    total: finish(model), popTotal: finish(pop), races: detail.length, detail };
  console.error(`\n=== ${track}  ${FROM}〜${TO}  ${detail.length}レース（試行 ${TRIALS}回・1点${UNIT}円）`);
  console.error('券種      BOX  平均点数    投資      払戻   的中率   回収率   （人気BOXの回収率）');
  for (const [t, ja] of TYPES) for (const k of SIZES) {
    const e = model[t] && model[t][k]; if (!e) continue;
    const p = pop[t] && pop[t][k];
    console.error(`${ja.padEnd(6)} ${String(k).padStart(3)}頭 ${String(e.avgPoints).padStart(7)}点 ${String(e.cost).padStart(8)}円 ${String(e.ret).padStart(9)}円 ${(e.hitRate * 100).toFixed(1).padStart(6)}% ${(e.roi * 100).toFixed(1).padStart(7)}%   ${p ? (p.roi * 100).toFixed(1).padStart(6) + '%' : '   —'}`);
  }
}
writeJSON('data/nankan/backtest.json', out);
