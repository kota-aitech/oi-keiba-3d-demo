/* JRA の条件付きロジット用の特徴量。1レース＝1グループ、1頭＝1行。レース前に分かる情報だけで作る。
   南関の lib/feat.mjs の項目を踏襲し、JRA で取れないもの（馬主・調教・ポイント制度・能力試験）は外し、
   JRA で取れるもの（芝ダ・コースの枠バイアス・全レースの上がり平均・ラップ）を足している。

   学習用のレースは results.jsonl から作る（`raceFromResult`）。着順や払戻は使わず、
   馬ごとの「その日より前の走り」を results から引いて前5走にする（`buildHistory`）。
   予測用のレースは cards.jsonl から作る（`raceFromCard`）。どちらも同じ形にしてから featurize する。 */

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const days = (a, b) => (new Date(a) - new Date(b)) / 86400000;
const W = [1, .85, .7, .55, .45];                    // 前走ほど重い（南関と同じ）

/* JRA のクラス。数字が大きいほど上 */
export function classOf(txt) {
  const t = (txt || '').normalize('NFKC').replace(/\s/g, '');
  if (/(GI|G1)(?!I)/.test(t) && !/GII/.test(t)) return 8;
  if (/GII(?!I)|G2/.test(t)) return 7;
  if (/GIII|G3/.test(t)) return 6;
  if (/オープン|OP|\bL\b|リステッド/.test(t)) return 5;
  if (/3勝|1600万/.test(t)) return 4;
  if (/2勝|1000万/.test(t)) return 3;
  if (/1勝|500万/.test(t)) return 2;
  if (/新馬|未勝利/.test(t)) return 1;
  return 3;
}
const gradeNum = g => ({ 'GI': 8, 'G1': 8, 'GII': 7, 'G2': 7, 'GIII': 6, 'G3': 6, 'L': 5, 'OP': 5 })[g] || null;
export const clsOfRace = r => gradeNum(r.grade) || classOf(`${r.name || ''} ${r.cond || ''}`);
const timeSec = t => { if (!t) return null; const m = String(t).match(/(?:(\d+):)?(\d+\.\d)/); return m ? (Number(m[1] || 0) * 60 + Number(m[2])) : null; };
const posNum = p => (typeof p === 'number' ? p : null);

export const FEATURES = [
  'ability', 'clsAbility', 'close', 'agariRel', 'paceExp', 'fastFit', 'stamina', 'surfFit', 'wet', 'epos',
  'jIdx', 'jVenue', 'jSurf', 'tIdx', 'tSurf', 'cIdx', 'bond', 'jForm',
  'gate', 'kgRel', 'bwLog', 'bwDiff', 'bwDev', 'bwSwing', 'bwRel',
  'restLog', 'layoff', 'classUp', 'downFirst', 'distChg', 'surfChg', 'lastPop', 'lastOdds', 'lastPos', 'lastMargin', 'nRuns',
  'wetX', 'age', 'mare', 'winStreak', 'afterWin', 'venueFit',
  'frontPress', 'soloNige', 'sameStyle',
];
export const NF = FEATURES.length;

/* ---- レースの索引：過去走のレースの上がり平均・テン3F・勝ち時計（agariRel / paceExp 用）---- */
export function buildRaceIndex(results) {
  const idx = new Map();
  const tenAcc = new Map();                          // 場|芝ダ|距離 -> [sum, n]
  for (const r of results) {
    const ag = r.entries.map(e => e.agari).filter(v => v > 0);
    const ten3 = r.laps && r.laps.length >= 3 ? r.laps[0] + r.laps[1] + r.laps[2] : null;
    const win = r.entries.find(e => e.pos === 1);
    idx.set(r.raceId, { avgAgari: ag.length ? ag.reduce((a, b) => a + b, 0) / ag.length : null, ten3, winTime: win ? timeSec(win.time) : null, n: r.n, cls: clsOfRace(r) });
    if (ten3) { const k = `${r.venue}|${r.surface}|${r.dist}`; const a = tenAcc.get(k) || [0, 0]; a[0] += ten3; a[1]++; tenAcc.set(k, a); }
  }
  const tenBase = new Map([...tenAcc].map(([k, a]) => [k, a[0] / a[1]]));
  return { idx, tenBase };
}

/* ---- 人的要因の「そのレース時点」の指数 ----
   index.json（期間まとめ）を学習に使うと、学習期間では自分の結果を含んだ指数を見ることになり
   （検証 2026-06〜 で コンビ指数・場別の突出が 0 に落ちた＝先読み）、モデルが小標本の指数を過信する。
   ここでは結果を日付順に流し、各レースについて「その日より前の結果だけ」で
   騎手／調教師／コンビ／騎手の場別・芝ダ別／調教師の芝ダ別／騎手の直近調子 を縮小ロジットで作る。
   予測（出馬表）には最終状態（latest）を使う。 */
const logit = p => Math.log(p / (1 - p)), sig = l => 1 / (1 + Math.exp(-l));
const shrunk = (w, n, prior, k) => logit((w + k * prior) / (n + k)) - logit(prior);
export function buildAsOf(results) {
  const J = new Map(), T = new Map(), C = new Map(), SR = new Map(), JR = new Map();
  let runs = 0, wins = 0;
  const snap = new Map();                                   // raceId|horseId -> hf
  const get = (m, k) => { let v = m.get(k); if (!v) m.set(k, v = { n: 0, w: 0, byV: new Map(), byS: new Map(), q: [], qw: 0 }); return v; };
  const sub = (m, k) => { let v = m.get(k); if (!v) m.set(k, v = { n: 0, w: 0 }); return v; };
  const P0 = () => (wins + 0.073 * 200) / (runs + 200);   // 序盤は事前の 7.3% に寄せる
  const hf = (e, venue, surface) => {
    const p0 = P0(), L0 = logit(p0);
    const j = J.get(e.jockeyId), t = T.get(e.trainerId), c = C.get(e.jockeyId + '|' + e.trainerId);
    const jIdx = j ? shrunk(j.w, j.n, p0, 60) : 0, tIdx = t ? shrunk(t.w, t.n, p0, 60) : 0;
    const own = sig(L0 + jIdx), ownT = sig(L0 + tIdx);
    const jv = j?.byV.get(venue), js = j?.byS.get(surface), ts = t?.byS.get(surface);
    const cExp = sig(L0 + 0.9 * jIdx + 0.55 * tIdx);
    return {
      jIdx, tIdx,
      jVenue: jv ? shrunk(jv.w, jv.n, own, 30) : 0, jSurf: js ? shrunk(js.w, js.n, own, 30) : 0, tSurf: ts ? shrunk(ts.w, ts.n, ownT, 30) : 0,
      cIdx: c ? shrunk(c.w, c.n, cExp, 45) : 0, bond: c && SR.get(e.trainerId) ? c.n / SR.get(e.trainerId) : 0,
      jForm: j && j.q.length >= 10 ? shrunk(j.qw, j.q.length, own, 40) : 0,     // 直近60騎乗の、本人の平常値からのズレ
      jN: j ? j.n : 0, tN: t ? t.n : 0, cN: c ? c.n : 0,
    };
  };
  for (const r of results) {
    for (const e of r.entries) { if (e.horseId) snap.set(`${r.raceId}|${e.horseId}`, hf(e, r.venue, r.surface)); }
    for (const e of r.entries) {
      if (typeof e.pos !== 'number') continue;
      const win = e.pos === 1 ? 1 : 0;
      runs++; wins += win;
      if (e.jockeyId) { const j = get(J, e.jockeyId); j.n++; j.w += win; const v = sub(j.byV, r.venue); v.n++; v.w += win; const s = sub(j.byS, r.surface); s.n++; s.w += win; j.q.push(win); j.qw += win; if (j.q.length > 60) j.qw -= j.q.shift(); JR.set(e.jockeyId, (JR.get(e.jockeyId) || 0) + 1); }
      if (e.trainerId) { const t = get(T, e.trainerId); t.n++; t.w += win; const s = sub(t.byS, r.surface); s.n++; s.w += win; SR.set(e.trainerId, (SR.get(e.trainerId) || 0) + 1); }
      if (e.jockeyId && e.trainerId) { const c = sub(C, e.jockeyId + '|' + e.trainerId); c.n++; c.w += win; }
    }
  }
  return {
    of(raceId, e, venue, surface) { return snap.get(`${raceId}|${e.horseId}`) || hf(e, venue, surface); },   // 無ければ最終状態（出馬表）
    latest(e, venue, surface) { return hf(e, venue, surface); },
    P0: P0(),
  };
}

/* ---- 馬ごとの履歴（新しい順）。past の1件は南関の前走欄と同じ意味の項目にそろえる ---- */
export function buildHistory(results) {
  const H = new Map();
  for (const r of results) {
    const cls = clsOfRace(r);
    for (const e of r.entries) {
      if (!e.horseId || posNum(e.pos) == null) continue;
      (H.get(e.horseId) || H.set(e.horseId, []).get(e.horseId)).push({
        date: r.date, raceId: r.raceId, venue: r.venue, surface: r.surface, dist: r.dist, baba: r.baba, cls, n: r.n,
        pos: e.pos, pop: e.pop, odds: e.odds, kin: e.kin, bw: e.bw, bwDiff: e.bwDiff, agari: e.agari, pass: e.pass, time: timeSec(e.time), margin: e.margin,
        jockeyId: e.jockeyId,
      });
    }
  }
  for (const a of H.values()) a.sort((x, y) => y.date.localeCompare(x.date));
  return H;
}
export const pastOf = (H, horseId, before, k = 5) => (H.get(horseId) || []).filter(p => p.date < before).slice(0, k);

/* ---- 学習用：結果 → レース（着順は order としてだけ残す）---- */
export function raceFromResult(r, H) {
  const horses = r.entries.filter(e => posNum(e.pos) != null && e.horseId).map(e => ({
    no: e.no, waku: e.waku, horseId: e.horseId, name: e.name, sexAge: e.sexAge, kin: e.kin, jockeyId: e.jockeyId, trainerId: e.trainerId,
    bw: e.bw, bwDiff: e.bwDiff, odds: e.odds, pop: e.pop, past: pastOf(H, e.horseId, r.date),
    _pos: e.pos,
  }));
  return { raceId: r.raceId, date: r.date, venue: r.venue, surface: r.surface, dist: r.dist, turn: r.turn, weather: r.weather, baba: r.baba, cls: clsOfRace(r), name: r.name, horses,
    order: [1, 2, 3].map(p => horses.findIndex(h => h._pos === p)) };
}
/* ---- 予測用：出馬表 → レース ---- */
export function raceFromCard(c, H) {
  const horses = c.entries.filter(e => e.horseId && !e.scratch).map(e => ({
    no: e.no, waku: e.waku, horseId: e.horseId, name: e.name, sexAge: e.sexAge, kin: e.kin, jockeyId: e.jockeyId, trainerId: e.trainerId,
    bw: e.bw, bwDiff: e.bwDiff, odds: e.odds, pop: e.pop, sire: e.sire, damsire: e.damsire,
    past: (e.past && e.past.length ? e.past.map(p => ({ ...p, time: typeof p.time === 'string' ? timeSec(p.time) : p.time, cls: p.cls ?? classOf(p.name) })) : pastOf(H, e.horseId, c.date)),
  }));
  return { raceId: c.raceId, date: c.date, venue: c.venue, surface: c.surface, dist: c.dist, turn: c.turn, weather: c.weather, baba: c.baba, cls: clsOfRace(c), name: c.name, horses };
}

/* ---- 1頭の推定値（南関 lib/horse.mjs の derive に相当）---- */
function derive(h, race, RI) {
  const past = h.past || [];
  let abS = 0, abW = 0, clS = 0, agS = 0, agW = 0, epS = 0, epW = 0;
  let same = [0, 0], other = [0, 0], surfSame = [0, 0], surfOther = [0, 0], wet = [0, 0], venue = [0, 0];
  let tS = 0, tW = 0, fastRel = [0, 0], slowRel = [0, 0];
  past.forEach((p, i) => {
    const w = W[i] ?? 0.4;
    const rel = p.n > 1 ? 1 - (p.pos - 1) / (p.n - 1) : 0.5;
    abS += rel * w; abW += w;
    clS += (rel - 0.5 + 0.12 * ((p.cls ?? race.cls) - race.cls)) * w;      // 上のクラスでの好走は重く
    const L = RI && RI.idx.get(p.raceId);
    if (L && p.agari && L.avgAgari) { agS += (p.agari - L.avgAgari) * w; agW += w; }
    if (p.pass) { const c1 = Number(String(p.pass).split('-')[0]); if (c1 && p.n) { epS += (c1 / (p.n + 1)) * w; epW += w; } }
    if (Math.abs((p.dist || race.dist) - race.dist) <= 200) { same[0] += rel; same[1]++; } else { other[0] += rel; other[1]++; }
    if (p.surface === race.surface) { surfSame[0] += rel; surfSame[1]++; } else if (p.surface) { surfOther[0] += rel; surfOther[1]++; }
    if (p.baba && p.baba !== '良') { wet[0] += rel; wet[1]++; }
    if (p.venue === race.venue) { venue[0] += rel; venue[1]++; }
    if (L && L.ten3) {
      const base = RI.tenBase.get(`${p.venue}|${p.surface}|${p.dist}`);
      if (base) { const dv = L.ten3 - base; tS += dv * w; tW += w; if (dv <= -0.3) { fastRel[0] += rel; fastRel[1]++; } else if (dv >= 0.3) { slowRel[0] += rel; slowRel[1]++; } }
    }
  });
  const ability = abW ? abS / abW : 0.45;
  const epos = epW ? epS / epW : 0.5;
  const style = epos <= 0.2 ? '逃げ' : epos <= 0.42 ? '先行' : epos <= 0.7 ? '差し' : '追込';
  return {
    ability, clsAbility: abW ? clS / abW : 0,
    close: agW ? -(agS / agW) : 0,                     // 速いほどプラス
    agariRel: agW ? agS / agW : 0, paceExp: tW ? (tS / tW) / 2 : 0,
    fastFit: (fastRel[1] && slowRel[1]) ? fastRel[0] / fastRel[1] - slowRel[0] / slowRel[1] : 0,
    stamina: same[1] ? same[0] / same[1] - (other[1] ? other[0] / other[1] : ability) : 0,
    surfFit: surfSame[1] ? surfSame[0] / surfSame[1] - (surfOther[1] ? surfOther[0] / surfOther[1] : ability) : 0,
    wet: wet[1] ? wet[0] / wet[1] - ability : 0,
    venueFit: venue[1] ? venue[0] / venue[1] - ability : 0,
    epos, style,
  };
}

export function makeFeaturizer(DB, RI, ASOF) {
  if (!ASOF) throw new Error('makeFeaturizer には buildAsOf(results) の戻り値が要る（人的要因はレース時点の指数で作る）');
  return function featurize(race) {
    const live = race.horses;
    if (live.length < 5) return null;
    const kgAvg = live.reduce((a, h) => a + (h.kin || 55), 0) / live.length;
    const isWet = race.baba && race.baba !== '良' ? 1 : 0;
    const bws = live.map(h => h.bw).filter(x => x > 0);
    const bwAvg = bws.length ? bws.reduce((a, b) => a + b, 0) / bws.length : 470;
    const ds = live.map(h => derive(h, race, RI));
    const cnt = {}; ds.forEach(d => cnt[d.style] = (cnt[d.style] || 0) + 1);
    const rows = live.map((h, hi) => {
      const d = ds[hi];
      const hf = ASOF.of(race.raceId, h, race.venue, race.surface);
      const p0 = h.past && h.past[0];
      const others = Math.max(1, live.length - 1);
      const nNigeOther = (cnt['逃げ'] || 0) - (d.style === '逃げ' ? 1 : 0), nSenOther = (cnt['先行'] || 0) - (d.style === '先行' ? 1 : 0);
      const rest = p0 ? Math.max(1, days(race.date, p0.date)) : 200;
      const age = Number((h.sexAge || '').replace(/\D/g, '')) || 4;
      let streak = 0; for (const p of (h.past || [])) { if (p.pos === 1) streak++; else break; }
      const prevCls = p0 ? (p0.cls ?? race.cls) : race.cls;
      const x = {
        ability: d.ability, clsAbility: d.clsAbility, close: d.close, agariRel: d.agariRel, paceExp: d.paceExp, fastFit: d.fastFit,
        stamina: d.stamina, surfFit: d.surfFit, wet: d.wet, epos: d.epos,
        jIdx: hf.jIdx, jVenue: hf.jVenue, jSurf: hf.jSurf, tIdx: hf.tIdx, tSurf: hf.tSurf, cIdx: hf.cIdx, bond: hf.bond, jForm: hf.jForm,
        gate: ((h.waku || 4.5) - 4.5) / 3.5,
        kgRel: (h.kin || kgAvg) - kgAvg,
        bwLog: h.bw ? Math.log(h.bw / 470) : 0, bwDiff: (h.bwDiff || 0) / 10,
        bwDev: (() => { const ws = (h.past || []).map(p => p.bw).filter(x => x > 0); if (!h.bw || !ws.length) return 0; return clamp((h.bw - ws.reduce((a, b) => a + b, 0) / ws.length) / 12, -2.5, 2.5); })(),
        bwSwing: h.bwDiff == null ? 0 : Math.min(Math.abs(h.bwDiff), 30) / 10, bwRel: h.bw ? clamp((h.bw - bwAvg) / 25, -2.5, 2.5) : 0,
        restLog: Math.log(rest) - 3.4, layoff: rest >= 90 ? 1 : 0,
        classUp: p0 ? race.cls - prevCls : 0, downFirst: p0 && race.cls < prevCls ? 1 : 0,
        distChg: p0 && p0.dist ? (race.dist - p0.dist) / 400 : 0, surfChg: p0 && p0.surface && p0.surface !== race.surface ? 1 : 0,
        lastPop: p0 && p0.n && p0.pop ? Math.log(p0.pop / p0.n) : 0, lastOdds: p0 && p0.odds ? clamp(Math.log(p0.odds / 10), -2.5, 2.5) : 0,
        lastPos: p0 && p0.n > 1 ? 1 - (p0.pos - 1) / (p0.n - 1) : 0.5,
        lastMargin: p0 && p0.pos > 1 && p0.time && RI?.idx.get(p0.raceId)?.winTime ? clamp((p0.time - RI.idx.get(p0.raceId).winTime), 0, 3) / 3 : 0,
        nRuns: Math.min((h.past || []).length, 5) / 5,
        wetX: d.wet * isWet, age: (age - 4) / 2, mare: /牝/.test(h.sexAge || '') ? 1 : 0,
        winStreak: Math.min(streak, 3) / 3, afterWin: p0 && p0.pos === 1 && race.cls === prevCls ? 1 : 0,
        venueFit: d.venueFit,
        frontPress: (d.style === '逃げ' ? 1 : d.style === '先行' ? 0.6 : 0) * (nNigeOther + 0.6 * nSenOther) / others,
        soloNige: d.style === '逃げ' && nNigeOther === 0 ? 1 : 0,
        sameStyle: ((cnt[d.style] || 0) - 1) / others,
      };
      const v = new Float64Array(NF);
      FEATURES.forEach((k, i) => { v[i] = Number.isFinite(x[k]) ? x[k] : 0; });
      return { no: h.no, waku: h.waku, name: h.name, horseId: h.horseId, x: v, d, hf, odds: h.odds, pop: h.pop, jIdx: x.jIdx, tIdx: x.tIdx, cIdx: x.cIdx };
    });
    return { raceId: race.raceId, date: race.date, venue: race.venue, surface: race.surface, dist: race.dist, cls: race.cls, baba: race.baba, n: live.length, rows, order: race.order };
  };
}
