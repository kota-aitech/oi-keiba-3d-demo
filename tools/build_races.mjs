/* cards.jsonl + index.json → index.html に埋め込む番組・出走馬データ
   data/nankan/races.<track>.json  { days:{...}, real:{...} }
   脚質/能力/上がり/距離/道悪 は CLAUDE.md の判定ルールを実装したもの。
   さらに 騎手・調教師・馬主・コンビ指数・勝負掛け指数 を各馬に付ける。      */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, readJSON, writeJSON } from './lib/nk.mjs';

const DB = readJSON('data/nankan/index.json');
const NDAYS = Number(process.env.NK_RACE_DAYS || 2);
const WANT = (process.env.NK_RACE_TRACKS || '大井:oi,川崎:kawasaki').split(',').map(s => s.split(':'));
const r2 = x => Math.round(x * 100) / 100;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const W = [1, .85, .7, .55, .45];                      // 前走ほど重い

/* 略称（前走欄は「御神訓」など）→ 騎手レコード。部分列一致 */
const JLIST = Object.values(DB.jockey).sort((a, b) => b.n - a.n);
const JEXACT = new Map(JLIST.map(x => [x.name, x]));
function jockeyByName(nm) {
  if (!nm) return null;
  if (JEXACT.has(nm)) return JEXACT.get(nm);
  for (const x of JLIST) { let i = 0; for (const ch of x.name) if (ch === nm[i]) i++; if (i === nm.length) return x; }
  return null;
}

const wavg = (arr, f) => {
  let s = 0, w = 0;
  arr.forEach((x, i) => { const v = f(x); if (v == null) return; s += v * W[i]; w += W[i]; });
  return w ? s / w : null;
};
const rel = p => p.field > 1 ? 1 - (p.pos - 1) / (p.field - 1) : 0.5;

/* 脚質判定：前5走の1角（＝序盤）通過順を頭数+1で割った比率の加重平均。
   閾値は cards.jsonl 全体（約12,800 頭走）の分布を見て、
   逃げ12% / 先行33% / 差し41% / 追込14% になる位置に置いてある。
   逃げは「常に1〜2番手」という定義を優先して絶対順位でも拾う。            */
function styleOf(past) {
  const rs = past.filter(p => p.corners.length && p.field > 1);
  if (!rs.length) return { style: '先行', pos: null, ratio: null };
  const early = rs.map(p => p.corners[0]);
  let sA = 0, sR = 0, w = 0;
  rs.forEach((p, i) => { const k = W[i] ?? 0.4; sA += early[i] * k; sR += early[i] / (p.field + 1) * k; w += k; });
  const abs = sA / w, ratio = sR / w;
  const style = (abs <= 2.0 || ratio <= 0.22) ? '逃げ' : ratio <= 0.45 ? '先行' : ratio <= 0.72 ? '差し' : '追込';
  return { style, pos: r2(abs), ratio: r2(ratio) };
}

function derive(h, dist) {
  const past = h.past.slice(0, 5);
  const st = styleOf(past);
  const rw = wavg(past, rel);
  const ability = past.length ? clamp(0.19 + 0.58 * Math.pow(clamp(rw, 0, 1), 1.25), .15, .92) : .45;
  const f3 = wavg(past, p => p.last3f);
  const rank3 = wavg(past, p => (p.last3fRank && p.field ? 1 - (p.last3fRank - 1) / Math.max(1, p.field - 1) : null));
  let close = f3 ? clamp(0.70 - (f3 - 36.5) * 0.10, .25, .85) : .5;
  if (rank3 != null) close = clamp(close * 0.75 + (0.25 + 0.55 * rank3) * 0.25, .2, .9);
  const near = past.filter(p => Math.abs(p.dist - dist) <= 200);
  const maxD = past.length ? Math.max(...past.map(p => p.dist)) : dist;
  const stamina = near.length ? clamp(0.20 + 0.60 * wavg(near, rel), .2, .9)
    : clamp((dist > maxD ? .40 : .50) + 0.15 * (rw ?? .5), .25, .7);
  const wetR = past.filter(p => p.baba !== '良');
  const wet = wetR.length ? clamp(0.20 + 0.60 * wavg(wetR, rel), .2, .9) : .5;
  return { style: st.style, st, epos: st.ratio, ability: r2(ability), close: r2(close), stamina: r2(stamina), wet: r2(wet), f3: f3 ? r2(f3) : null };
}

/* 種牡馬名は出馬表が半角、リーディングが全角のことがあるので正規化して突き合わせる */
const norm = x => (x || '').normalize('NFKC').replace(/\s+/g, '').toUpperCase();

/* 血統の寄与。実績（前5走）が少ない馬ほど重く、5走そろっていれば 0 にする。
   父の全体指数＋今回距離での偏り＋母の父 を足して、信頼度で減衰させる。 */
function pedigree(h, dist) {
  const S = DB.sire[norm(h.sire)], B = DB.bms[norm(h.damSire)];
  const sD = S && S.byDist && S.byDist[dist] ? S.byDist[dist].idx : 0;
  const conf = Math.max(0, 1 - h.past.length / 4);
  const raw = (S ? S.idx : 0) + 0.45 * sD + 0.35 * (B ? B.idx : 0);
  return { sire: h.sire, damSire: h.damSire,
    sIdx: S ? r2(S.idx) : 0, sN: S ? S.n : 0, sDist: r2(sD), sDistN: S && S.byDist && S.byDist[dist] ? S.byDist[dist].n : 0,
    bmsIdx: B ? r2(B.idx) : 0, bmsN: B ? B.n : 0,
    bIdx: r2(raw * conf), bConf: r2(conf) };
}

function human(h, track) {
  const J = DB.jockey['kis' + h.jockeyId], T = DB.trainer['cho' + h.trainerId];
  const C = DB.combo[`kis${h.jockeyId}|cho${h.trainerId}`];
  const O = DB.owner[h.owner];
  const prevJ = h.past.length ? jockeyByName(h.past[0].jockey) : null;
  const jIdx = J ? J.idx : 0, tIdx = T ? T.idx : 0;
  const cIdx = C ? C.cIdx : 0, bond = C ? C.bond : 0;
  const jUp = prevJ ? r2(jIdx - prevJ.idx) : 0;
  const spot = (bond < 0.08 && jIdx > 0.30) ? 1 : 0;
  const away = (h.trainerBase && h.trainerBase !== track ? 0.5 : 0) + (h.jockeyBase && h.jockeyBase !== track ? 0.5 : 0);
  const oAgg = O ? O.oAgg : 0, oIdx = O ? O.oIdx3 : 0;
  const shobu = clamp(0.55 * jUp + 0.35 * spot * jIdx + 0.30 * oAgg + 0.12 * away, -1, 1.5);
  const hIdx = DB.fit.wJ * jIdx + DB.fit.wT * tIdx + cIdx + 0.20 * oIdx + 0.30 * shobu;
  return {
    jockey: h.jockey, jockeyBase: h.jockeyBase, trainer: h.trainer, trainerBase: h.trainerBase, owner: h.owner,
    jIdx: r2(jIdx), tIdx: r2(tIdx), cIdx: r2(cIdx), bond: r2(bond),
    cN: C ? C.n : 0, cW: C ? C.w : 0, cRate: C ? r2(C.winRate) : 0,
    oIdx: r2(oIdx), oAgg: r2(oAgg), oN: O ? O.n : 0,
    prevJockey: prevJ ? prevJ.name : (h.past[0]?.jockey || ''), jUp, spot, away: r2(away),
    shobu: r2(shobu), hIdx: r2(hIdx),
  };
}

function memoOf(h, d, hu, pd) {
  const line = h.past.map(p => `${p.pos}着`).join('-') || '前走データなし';
  const bits = [`前5走 ${line}`];
  if (d.st.pos != null) bits.push(`3角平均${d.st.pos}番手`);
  if (d.f3) bits.push(`上がり3F ${d.f3}s`);
  const wetR = h.past.filter(p => p.baba !== '良');
  if (wetR.length) bits.push(`道悪${wetR.length}戦[${wetR.filter(p => p.pos <= 3).length}回3着内]`);
  bits.push(`${hu.jockey}(${hu.jockeyBase})×${hu.trainer}厩舎／馬主 ${hu.owner || '不明'}`);
  if (hu.cN >= 20) bits.push(`このコンビ${hu.cN}走${hu.cW}勝(${(hu.cRate * 100).toFixed(0)}%)`);
  if (hu.jUp >= 0.35) bits.push(`前走${hu.prevJockey}から騎手強化`);
  if (hu.spot) bits.push('上位騎手をスポット起用');
  if (pd && pd.sire) bits.push(`父 ${pd.sire}${pd.sN >= 200 ? `（南関3年 ${pd.sN}走 指数 ${pd.sIdx >= 0 ? '+' : ''}${pd.sIdx}${pd.sDistN >= 50 ? `／${d.distLabel || ''}この距離 ${pd.sDist >= 0 ? '+' : ''}${pd.sDist}` : ''}）` : ''}`);
  return bits.join('／');
}

/* ---- cards.jsonl を読み、場ごとに最新 N 開催日を組み立てる ---- */
const lines = fs.readFileSync(path.join(ROOT, 'data/nankan/cards.jsonl'), 'utf8').split('\n').filter(Boolean);
const cards = lines.map(l => JSON.parse(l));
const meta = { builtAt: new Date().toISOString(), leading: DB.window, pop: DB.pop, fit: DB.fit };

for (const [jaName, key] of WANT) {
  const mine = cards.filter(c => c.track === jaName && c.horses.length >= 4);
  const all = [...new Set(mine.map(c => c.date))].sort();
  // 今日を含む開催（なければ直近）から NDAYS 日ぶんを切り出す
  const today = process.env.NK_TODAY || new Date().toISOString().slice(0, 10);
  let i = all.reduce((acc, d, k) => (d <= today ? k : acc), -1);
  if (i < 0) i = 0;
  let dates = all.slice(i, i + NDAYS);
  if (dates.length < NDAYS) dates = all.slice(Math.max(0, all.length - NDAYS));
  const days = {}, real = {}, full = {};
  for (const date of dates) {
    const rs = mine.filter(c => c.date === date).sort((a, b) => a.R - b.R);
    const d = new Date(date + 'T00:00:00');
    const dk = `${d.getMonth() + 1}/${d.getDate()}(${'日月火水木金土'[d.getDay()]}) 第${Number(rs[0].raceId.slice(12, 14))}日`;
    days[dk] = rs.map(c => ({ r: c.R, time: c.time, dist: c.dist, n: c.horses.filter(h => !h.scratch).length, cls: c.cls,
      date: c.date, raceId: c.raceId, night: !!c.night }));
    for (const c of rs) {
      const hs = c.horses.filter(h => !h.scratch).map(h => {
        const d2 = derive(h, c.dist), hu = human(h, jaName), pd = pedigree(h, c.dist);
        return { no: h.no, name: h.name, gate: h.gate, style: d2.style, epos: d2.epos, ability: d2.ability,
          close: d2.close, stamina: d2.stamina, wet: d2.wet, ...hu, ...pd, memo: memoOf(h, d2, hu, pd),
          // ここから先は出馬表ページ（race.html）だけで使う
          _full: { horseId: h.horseId, sexAge: h.sexAge, kg: h.kg, dam: h.dam, farm: h.farm, f3: d2.f3,
            epR: d2.st.ratio, past: h.past },
        };
      });
      full[`${dk}|${c.R}`] = hs.map(h => ({ ...h, ...h._full, _full: undefined }));
      real[`${dk}|${c.R}`] = hs.map(({ _full, ...rest }) => rest);
    }
    // 取消馬も出馬表には出す（頭数には数えない）
    for (const c of rs) {
      const sc = c.horses.filter(h => h.scratch);
      if (sc.length) full[`${dk}|${c.R}`].push(...sc.map(h => ({ no: h.no, name: h.name, gate: h.gate, scratch: true,
        jockey: h.jockey, jockeyBase: h.jockeyBase, trainer: h.trainer, trainerBase: h.trainerBase,
        owner: h.owner, farm: h.farm, sire: h.sire, dam: h.dam, damSire: h.damSire,
        sexAge: h.sexAge, kg: h.kg, horseId: h.horseId, past: h.past })));
    }
  }
  writeJSON(`data/nankan/races.${key}.json`, { track: jaName, meta, days, real });
  writeJSON(`data/nankan/entries.${key}.json`, { track: jaName, meta, days, entries: full });
  console.error(`${jaName}: ${dates.join(', ')} → ${Object.keys(real).length} レース`);
}
