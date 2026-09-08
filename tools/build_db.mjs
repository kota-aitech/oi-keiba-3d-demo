/* leading.raw.json（＋あれば cards.jsonl）から人的要因の指数を作り
   data/nankan/index.json に落とす。

   指数はすべて「母集団平均に対する対数オッズ差」。0 = 平均、+0.7 ≒ 勝率2倍。
   標本が少ないコンビは母集団（または騎手×調教師の独立予測）に縮小推定する。
     jIdx 騎手指数          … 勝率の縮小ロジット（k=60騎乗）
     tIdx 調教師指数        … 同上（k=60出走）
     cIdx コンビ指数        … 騎手・調教師から独立に期待される勝率からの上振れ（k=45出走）
     bond 結び付き          … その厩舎の全出走に占めるこのコンビの割合（主戦度）
     oIdx 馬主指数 / oAgg   … 馬主の成績と「上位騎手を確保する度合い」
*/
import { readJSON, writeJSON } from './lib/nk.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './lib/nk.mjs';

const raw = readJSON('data/nankan/leading.raw.json');
// 検証用に「その時点までの情報だけ」の指数を作りたいときは NK_DB_YEARS で年を絞る
const YEARS = (process.env.NK_DB_YEARS || '2023,2024,2025,2026').split(',');
const OUTFILE = process.env.NK_DB_OUT || 'data/nankan/index.json';
// 馬主の集計に使う出馬表の上限日。検証で先読みを避けたいときに切る
const CARD_TO = process.env.NK_DB_CARD_TO || '9999-12-31';
const R1 = '0003', R3M = '0004';
const TRACKS = { '18': '浦和', '19': '船橋', '20': '大井', '21': '川崎' };

const logit = p => Math.log(p / (1 - p));
const add = (a, b) => { a.runs += b.runs; a.w += b.w; a.p2 += b.p2; a.p3 += b.p3; a.prize += b.prize; return a; };
const zero = () => ({ runs: 0, w: 0, p2: 0, p3: 0, prize: 0 });
const r3 = x => Math.round(x * 1000) / 1000;

/* ---- 1. 生カウントを 期間×場×主体 に畳む ---- */
function collect(kind, periods) {
  const all = new Map();                    // key -> {meta, tot, byTrack}
  for (const p of periods) for (const jo of Object.keys(TRACKS)) {
    for (const r of raw.data[`${p}|${jo}|${kind}`] || []) {
      const key = kind === 'kis' ? r.ids[0] : kind === 'cho' ? r.ids[0] : r.ids.join('|');
      if (!key || key === '|') continue;
      let e = all.get(key);
      if (!e) all.set(key, e = { key, meta: r, tot: zero(), byTrack: {} });
      add(e.tot, r);
      add(e.byTrack[jo] ||= zero(), r);
    }
  }
  return all;
}

const kis3 = collect('kis', YEARS), kis1 = collect('kis', [R1]), kisQ = collect('kis', [R3M]);
const cho3 = collect('cho', YEARS), cho1 = collect('cho', [R1]);
const cmb3 = collect('kis_cho', YEARS), cmb1 = collect('kis_cho', [R1]);

/* ---- 2. 母集団の基準勝率（＝ 1/平均頭数）---- */
const pop = zero();
for (const e of kis3.values()) add(pop, e.tot);
const P0 = pop.w / pop.runs;                     // 勝率の母平均
const P3 = (pop.w + pop.p2 + pop.p3) / pop.runs; // 3着内率の母平均
const L0 = logit(P0), L3 = logit(P3);

const shrunk = (w, n, prior, k) => logit((w + k * prior) / (n + k)) - logit(prior);

/* ---- 3. 騎手・調教師 ---- */
function actors(m3, m1, kind, k = 60) {
  const out = {};
  for (const [key, e] of m3) {
    const cur = m1.get(key);
    const nm = kind === 'kis' ? e.meta.jockey : e.meta.trainer;
    const base = kind === 'kis' ? e.meta.jockeyBase : e.meta.trainerBase;
    const i3 = shrunk(e.tot.w, e.tot.runs, P0, k);
    const i3t = shrunk(e.tot.w + e.tot.p2 + e.tot.p3, e.tot.runs, P3, k);
    const r1 = cur ? shrunk(cur.tot.w, cur.tot.runs, P0, k) : i3;
    const byTrack = {};
    for (const [jo, t] of Object.entries(e.byTrack)) {
      // 場別は本人の全体指数を事前分布にして縮小（少ない場でブレないように）
      byTrack[TRACKS[jo]] = r3(logit((t.w + 30 * (1 / (1 + Math.exp(-(L0 + i3))))) / (t.runs + 30)) - L0);
    }
    out[key] = {
      id: key, name: nm, base,
      n: e.tot.runs, w: e.tot.w, p3: e.tot.w + e.tot.p2 + e.tot.p3,
      winRate: r3(e.tot.w / e.tot.runs), top3Rate: r3((e.tot.w + e.tot.p2 + e.tot.p3) / e.tot.runs),
      idx: r3(0.7 * i3 + 0.3 * r1), idx3: r3(i3t), form: r3(r1 - i3),
      n1: cur ? cur.tot.runs : 0, byTrack,
    };
  }
  return out;
}
const JOCKEY = actors(kis3, kis1, 'kis');
const TRAINER = actors(cho3, cho1, 'cho');

/* 直近3ヶ月の調子（騎乗数が少ないと 0 に寄る） */
for (const [key, e] of kisQ) if (JOCKEY[key]) {
  JOCKEY[key].hot = r3(shrunk(e.tot.w, e.tot.runs, P0, 40));
  JOCKEY[key].nQ = e.tot.runs;
}

/* ---- 4. コンビ（騎手×調教師の交互作用）---- */
const trainerRuns = {}, jockeyRuns = {};
for (const e of cmb3.values()) {
  const [j, t] = e.key.split('|');
  trainerRuns[t] = (trainerRuns[t] || 0) + e.tot.runs;
  jockeyRuns[j] = (jockeyRuns[j] || 0) + e.tot.runs;
}
/* 騎手指数と調教師指数から勝率をどれだけ説明できるかを実データで当てる。
   両者は相関する（強い厩舎に上位騎手が乗る）ので単純な和では過大評価になるため、
   二項尤度を最大化する係数 wJ / wT をグリッドで推定し、その残差をコンビ指数とする。 */
const pairs = [];
for (const [key, e] of cmb3) {
  const [j, t] = key.split('|');
  if (JOCKEY[j] && TRAINER[t]) pairs.push([JOCKEY[j].idx, TRAINER[t].idx, e.tot.runs, e.tot.w]);
}
function ll(wJ, wT, c) {
  let s = 0;
  for (const [ji, ti, n, w] of pairs) {
    const p = 1 / (1 + Math.exp(-(L0 + c + wJ * ji + wT * ti)));
    s += w * Math.log(p) + (n - w) * Math.log(1 - p);
  }
  return s;
}
let best = { wJ: 1, wT: 1, c: 0, v: -Infinity };
for (let wJ = 0.30; wJ <= 1.25; wJ += 0.05)
  for (let wT = 0.20; wT <= 1.25; wT += 0.05)
    for (let c = -0.30; c <= 0.30; c += 0.05) {
      const v = ll(wJ, wT, c);
      if (v > best.v) best = { wJ, wT, c, v };
    }
const FIT = { wJ: r3(best.wJ), wT: r3(best.wT), c: r3(best.c) };
console.error(`当てはめ: 勝率ロジット = ${r3(L0)} ${FIT.c >= 0 ? '+' : ''}${FIT.c} + ${FIT.wJ}×騎手指数 + ${FIT.wT}×調教師指数`);

const KC = 45;   // コンビの縮小の強さ（＝この出走数ぶんの「期待どおり」を足してから評価する）
const COMBO = {};
for (const [key, e] of cmb3) {
  const [j, t] = key.split('|');
  const J = JOCKEY[j], T = TRAINER[t];
  if (!J || !T) continue;
  const lExp = L0 + FIT.c + FIT.wJ * J.idx + FIT.wT * T.idx;   // 独立に期待される勝率のロジット
  const pExp = 1 / (1 + Math.exp(-lExp));
  const cIdx = logit((e.tot.w + KC * pExp) / (e.tot.runs + KC)) - lExp;
  const cur = cmb1.get(key);
  const cIdx1 = cur ? logit((cur.tot.w + KC * pExp) / (cur.tot.runs + KC)) - lExp : cIdx;
  const byTrack = {};
  for (const [jo, v] of Object.entries(e.byTrack)) byTrack[TRACKS[jo]] = [v.runs, v.w];
  const cI = r3(0.7 * cIdx + 0.3 * cIdx1);
  COMBO[key] = {
    j, t, jockey: e.meta.jockey, trainer: e.meta.trainer,
    n: e.tot.runs, w: e.tot.w, p3: e.tot.w + e.tot.p2 + e.tot.p3,
    winRate: r3(e.tot.w / e.tot.runs), top3Rate: r3((e.tot.w + e.tot.p2 + e.tot.p3) / e.tot.runs),
    cIdx: cI,
    pairIdx: r3(FIT.wJ * J.idx + FIT.wT * T.idx + cI),  // このコンビで走らせたときの総合（母平均比の対数オッズ）
    bond: r3(e.tot.runs / (trainerRuns[t] || 1)),        // 厩舎から見た主戦度
    bondJ: r3(e.tot.runs / (jockeyRuns[j] || 1)),        // 騎手から見た主戦度
    n1: cur ? cur.tot.runs : 0, byTrack,
  };
}

/* ---- 4b. 種牡馬・母の父 ----------------------------------------------
   リーディングの種牡馬表には2着3着が無いので、指数は勝率だけで作る（k=80出走）。
   距離別は南関東まとめ（jo=00）で取ってあるので、そこから距離適性も出す。      */
export const norm = x => (x || '').normalize('NFKC').replace(/\s+/g, '').toUpperCase();

function collectSire(kind, periods, joList = Object.keys(TRACKS), suffix = '') {
  const all = new Map();
  for (const p of periods) for (const jo of joList) {
    for (const r of raw.data[`${p}|${jo}|${kind}${suffix}`] || []) {
      const key = norm(r.sire);
      if (!key) continue;
      let e = all.get(key);
      if (!e) all.set(key, e = { key, name: r.sire, tot: { runs: 0, w: 0, horses: 0, wHorses: 0, prize: 0 }, byTrack: {} });
      const t = e.tot;
      t.runs += r.runs; t.w += r.w; t.horses += r.horses; t.wHorses += r.wHorses; t.prize += r.prize;
      const b = e.byTrack[jo] ||= { runs: 0, w: 0 };
      b.runs += r.runs; b.w += r.w;
    }
  }
  return all;
}

function pedigree(kind) {
  const K = 80;
  const y = collectSire(kind, YEARS), r1 = collectSire(kind, [R1]);
  const dist = {};
  if (kind === 'sire') for (const d of (raw.sireDist || [])) {
    dist[d] = collectSire('sire', YEARS, ['00'], String(d).padStart(4, '0'));
  }
  const out = {};
  for (const [key, e] of y) {
    const cur = r1.get(key);
    const i3 = shrunk(e.tot.w, e.tot.runs, P0, K);
    const rr = cur ? shrunk(cur.tot.w, cur.tot.runs, P0, K) : i3;
    const byTrack = {}, byDist = {};
    for (const [jo, t] of Object.entries(e.byTrack))
      byTrack[TRACKS[jo]] = { n: t.runs, w: t.w, idx: r3(logit((t.w + 40 * (1 / (1 + Math.exp(-(L0 + i3))))) / (t.runs + 40)) - L0) };
    for (const [d, m] of Object.entries(dist)) {
      const t = m.get(key);
      if (!t || t.tot.runs < 20) continue;
      // 距離別は本人の全体指数を事前分布に置いて縮小する（距離ごとの偏りだけを見る）
      byDist[d] = { n: t.tot.runs, w: t.tot.w, idx: r3(logit((t.tot.w + 40 * (1 / (1 + Math.exp(-(L0 + i3))))) / (t.tot.runs + 40)) - L0 - i3) };
    }
    out[key] = {
      key, name: e.name, n: e.tot.runs, w: e.tot.w, horses: e.tot.horses, wHorses: e.tot.wHorses, prize: e.tot.prize,
      winRate: r3(e.tot.w / e.tot.runs), wHorseRate: e.tot.horses ? r3(e.tot.wHorses / e.tot.horses) : 0,
      idx: r3(0.75 * i3 + 0.25 * rr), form: r3(rr - i3), n1: cur ? cur.tot.runs : 0,
      byTrack, byDist,
    };
  }
  return out;
}
const SIRE = pedigree('sire'), BMS = pedigree('bms');

/* ---- 5. 馬主（cards.jsonl があれば）---- */
const OWNER = {};
const HORSE = {};
const cardsPath = path.join(ROOT, 'data', 'nankan', 'cards.jsonl');
let cardStats = null;
if (fs.existsSync(cardsPath)) {
  const runsSeen = new Set();
  const oAgg = {};                                  // 馬主 -> 起用騎手の指数合計
  const nameToJockey = buildNameIndex(JOCKEY);
  let cards = 0;
  for (const line of fs.readFileSync(cardsPath, 'utf8').split('\n')) {
    if (!line) continue;
    let c; try { c = JSON.parse(line); } catch { continue; }
    if (c.date > CARD_TO) continue;
    cards++;
    for (const h of c.horses) {
      if (!h.owner) continue;
      HORSE[h.horseId] = { name: h.name, owner: h.owner, trainer: h.trainerId };
      const o = OWNER[h.owner] ||= { name: h.owner, horses: new Set(), n: 0, w: 0, p3: 0, jSum: 0, jN: 0, entries: 0 };
      o.horses.add(h.horseId);
      o.entries++;
      const J = nameToJockey(h.jockey) || (JOCKEY[h.jockeyId] ? h.jockeyId : null);
      if (J && JOCKEY[J]) { o.jSum += JOCKEY[J].idx; o.jN++; }
      for (const p of h.past) {
        const k = h.horseId + '|' + p.date;
        if (runsSeen.has(k)) continue;
        runsSeen.add(k);
        o.n++; if (p.pos === 1) o.w++; if (p.pos <= 3) o.p3++;
      }
    }
  }
  let jAvg = 0, jCnt = 0;
  for (const o of Object.values(OWNER)) { if (o.jN) { jAvg += o.jSum; jCnt += o.jN; } }
  jAvg /= (jCnt || 1);
  for (const [k, o] of Object.entries(OWNER)) {
    OWNER[k] = {
      name: o.name, horses: o.horses.size, n: o.n, w: o.w, p3: o.p3, entries: o.entries,
      winRate: o.n ? r3(o.w / o.n) : 0, top3Rate: o.n ? r3(o.p3 / o.n) : 0,
      oIdx: r3(shrunk(o.w, o.n, P0, 40)),
      oIdx3: r3(shrunk(o.p3, o.n, P3, 40)),
      // 勝負傾向: 起用騎手の平均指数が全体平均よりどれだけ上か
      oAgg: o.jN ? r3(o.jSum / o.jN - jAvg) : 0,
    };
  }
  cardStats = { cards, horses: Object.keys(HORSE).length, owners: Object.keys(OWNER).length, runs: runsSeen.size };
}

/* 略称（前走欄は「御神訓」のように3文字）→ 騎手ID。部分列一致でひく */
function buildNameIndex(J) {
  const list = Object.values(J).sort((a, b) => b.n - a.n);
  const exact = new Map(list.map(x => [x.name, x.id]));
  return abbr => {
    if (!abbr) return null;
    if (exact.has(abbr)) return exact.get(abbr);
    for (const x of list) {
      let i = 0;
      for (const ch of x.name) if (ch === abbr[i]) i++;
      if (i === abbr.length) return x.id;
    }
    return null;
  };
}

const db = {
  builtAt: new Date().toISOString(),
  source: 'nankankeiba.com リーディング情報（騎手 / 調教師 / 騎手×調教師）+ 出馬表',
  window: { leading: YEARS.join('+') + '（暦年）', recent: '直近1年', quarter: '直近3ヶ月', cards: cardStats },
  pop: { runs: pop.runs, wins: pop.w, P0: r3(P0), P3: r3(P3), L0: r3(L0) },
  fit: FIT,
  jockey: JOCKEY, trainer: TRAINER, combo: COMBO, owner: OWNER, sire: SIRE, bms: BMS,
  sireDist: raw.sireDist || [],
};
writeJSON(OUTFILE, db);

const top = (o, f, n = 10) => Object.values(o).filter(x => x.n >= 200).sort((a, b) => b[f] - a[f]).slice(0, n);
console.error(`母集団 ${pop.runs} 走 / 勝率 ${(P0 * 100).toFixed(1)}% / 3着内率 ${(P3 * 100).toFixed(1)}%`);
console.error('騎手 top:', top(JOCKEY, 'idx').map(x => `${x.name} ${x.idx}`).join(', '));
console.error('調教師 top:', top(TRAINER, 'idx').map(x => `${x.name} ${x.idx}`).join(', '));
const fmtC = x => `${x.jockey}×${x.trainer} 総合${x.pairIdx} 上振れ${x.cIdx} 主戦度${(x.bond * 100).toFixed(0)}% (${x.n}走${x.w}勝 ${(x.winRate * 100).toFixed(0)}%)`;
console.error('コンビ 総合top:', Object.values(COMBO).filter(x => x.n >= 100).sort((a, b) => b.pairIdx - a.pairIdx).slice(0, 8).map(fmtC).join('\n  '));
console.error('コンビ 上振れtop:', Object.values(COMBO).filter(x => x.n >= 150).sort((a, b) => b.cIdx - a.cIdx).slice(0, 8).map(fmtC).join('\n  '));
const topS = (o, min) => Object.values(o).filter(x => x.n >= min).sort((a, b) => b.idx - a.idx).slice(0, 8)
  .map(x => `${x.name} ${x.idx}(${x.n}走${x.w}勝 ${(x.winRate * 100).toFixed(0)}%)`).join(', ');
console.error('種牡馬 top:', topS(SIRE, 300));
console.error('母の父 top:', topS(BMS, 300));
if (cardStats) console.error('出馬表:', JSON.stringify(cardStats));
