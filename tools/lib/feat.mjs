/* 条件付きロジット用の特徴量。1レース＝1グループ、1頭＝1行。
   レース前に分かる情報だけで作る（着順・払戻は使わない）。               */
import { makeDerivers } from './horse.mjs';

/* 南関の格を数値にする。数字が大きいほど上のクラス */
const Z = s => (s || '').normalize('NFKC').replace(/\s/g, '');
export function classOf(txt) {
  const t = Z(txt);
  if (/(JpnI|GI|SI|JpnⅠ|重賞)/.test(t)) return 12;
  if (/(JpnII|JpnIII|GII|GIII|SII|SIII)/.test(t)) return 11;
  if (/A1|A\(一\)|A1級/.test(t)) return 10;
  if (/A2/.test(t)) return 9;
  if (/A3/.test(t)) return 8;
  if (/B1/.test(t)) return 7;
  if (/B2/.test(t)) return 6;
  if (/B3/.test(t)) return 5;
  if (/C1/.test(t)) return 4;
  if (/C2/.test(t)) return 3;
  if (/C3/.test(t)) return 2;
  if (/(新馬|未格付|未勝利)/.test(t)) return 1;
  if (/2歳/.test(t)) return 2.5;
  if (/3歳/.test(t)) return 3.5;
  return 4;                                     // 分からないものは中位に置く
}

export const FEATURES = [
  'ability', 'close', 'stamina', 'wet', 'epos',
  'jIdx', 'tIdx', 'cIdx', 'bond', 'shobu', 'oIdx',
  'sIdx', 'sDist', 'bmsIdx',
  'gate', 'kgRel', 'bwLog', 'bwDiff', 'restLog', 'layoff',
  'classUp', 'distChg', 'lastPop', 'lastPos', 'nRuns',
  'wetX', 'age', 'mare',
  // 同型馬（展開）
  'frontPress', 'soloNige', 'sameStyle',
  // テン・上がりのラップ由来
  'agariRel', 'paceExp', 'fastFit',
  // 南関のポイント制度まわり（ヤリヤラズの手がかり）
  'ptLog', 'upFirst', 'downFirst', 'winStreak', 'afterWin',
  // 能力・調教試験（新馬・転入初戦は前5走が無いので、実際に走った唯一の記録になる）
  'skTime', 'skHas', 'skFail',
  // 騎手・調教師の「そのレース時点」の調子
  'jForm', 'jForm3', 'jRides', 'tForm',
  // 馬体重（自己比・仕上がり）
  'bwDev', 'bwSwing', 'bwRel',
];

/* results.jsonl と cards.jsonl から、前走レースのラップを引くための索引を作る */
/* 能力・調教試験。馬IDで引けるようにする。同じ馬が複数回受けていたら直近を使う。
   タイムは距離（ほぼ800m）ごとに標準化して、速い＝プラスになる向きに揃える。 */
/* 騎手・調教師の「そのレース時点」の直近成績。
   index.json の hot は build_db を回した時点の直近3ヶ月なので、
   過去のレースに当てると先読みになる。ここでは結果を日付順に流し込み、
   各レースについて「その日より前の騎乗だけ」から作る。                      */
export function buildFormIndex(cards, results) {
  const res = new Map(results.map(r => [r.raceId, r]));
  /* (日付, レース, 騎手/調教師, 着順) を時系列に並べる */
  const runs = [];
  for (const c of cards) {
    const r = res.get(c.raceId);
    if (!r || !r.order || !r.order.length) continue;
    for (const h of c.horses) {
      if (h.scratch || !h.jockeyId) continue;
      const pos = r.order.indexOf(h.no) + 1;
      if (!pos) continue;
      runs.push({ date: c.date, raceId: c.raceId, j: h.jockeyId, t: h.trainerId, pos, n: r.order.length });
    }
  }
  runs.sort((a, b) => a.raceId.localeCompare(b.raceId));

  const W = Number(process.env.NK_FORM_W || 60);      // 直近何回の騎乗を見るか
  const K = Number(process.env.NK_FORM_K || 40);      // 縮小の強さ
  const hist = { j: new Map(), t: new Map() };        // id -> {q:[勝敗], win, top3, days:[日付]}
  const snap = new Map();                             // raceId|kind|id -> {win, top3, rides30}
  const D = d => new Date(d + 'T00:00:00').getTime();

  for (const r of runs) {
    for (const [kind, id] of [['j', r.j], ['t', r.t]]) {
      if (!id) continue;
      const h = hist[kind].get(id) || { q: [], win: 0, top3: 0, days: [] };
      /* 先に「このレース時点」を記録してから、この結果を足す（先読み防止）*/
      const key = `${r.raceId}|${kind}|${id}`;
      if (!snap.has(key)) {
        const n = h.q.length;
        const rides30 = h.days.filter(d => D(r.date) - d <= 30 * 86400000).length;
        snap.set(key, n ? { n, win: h.win / n, top3: h.top3 / n, rides30 } : null);
      }
      h.q.push(r.pos);
      if (r.pos === 1) h.win++;
      if (r.pos <= 3) h.top3++;
      h.days.push(D(r.date));
      while (h.q.length > W) { const o = h.q.shift(); if (o === 1) h.win--; if (o <= 3) h.top3--; }
      while (h.days.length > 400) h.days.shift();
      hist[kind].set(id, h);
    }
  }
  /* 母集団の平均。縮小推定の事前分布に使う */
  const all = runs.length || 1;
  const p0 = runs.filter(r => r.pos === 1).length / all;
  const p3 = runs.filter(r => r.pos <= 3).length / all;
  const logit = p => Math.log(p / (1 - p));
  /* 最新の状態（＝これから行われるレース用）。結果がまだ無いので snap には入らない */
  const nowMs = Date.now();
  const latest = new Map();
  for (const kind of ['j', 't']) for (const [id, h] of hist[kind]) {
    const n = h.q.length;
    if (!n) continue;
    latest.set(`${kind}|${id}`, { n, win: h.win / n, top3: h.top3 / n,
      rides30: h.days.filter(d => nowMs - d <= 30 * 86400000).length });
  }
  return {
    K, p0, p3,
    /* そのレース時点の調子。長期平均からのズレを対数オッズで返す。
       未来のレース（結果がまだ無い）は最新の状態を使う */
    get(raceId, kind, id, baseIdx = 0) {
      const s = snap.get(`${raceId}|${kind}|${id}`) || latest.get(`${kind}|${id}`);
      if (!s || !s.n) return { form: 0, form3: 0, rides30: 0, n: 0 };
      const exp0 = 1 / (1 + Math.exp(-(logit(p0) + baseIdx)));
      const exp3 = 1 / (1 + Math.exp(-(logit(p3) + baseIdx)));
      return {
        n: s.n, rides30: s.rides30,
        form: logit((s.win * s.n + K * exp0) / (s.n + K)) - logit(exp0),
        form3: logit((s.top3 * s.n + K * exp3) / (s.n + K)) - logit(exp3),
      };
    },
  };
}

export function buildShikenIndex(rows) {
  const by = new Map();
  for (const r of rows) {
    if (!r.time) continue;
    const cur = by.get(r.horseId);
    if (!cur || r.date > cur.date) by.set(r.horseId, r);
  }
  const t = [...by.values()].map(r => r.time).sort((a, b) => a - b);
  const med = t[t.length >> 1] || 52.6;
  const sd = Math.sqrt(t.reduce((a, x) => a + (x - med) ** 2, 0) / (t.length || 1)) || 1.5;
  return { by, med, sd };
}

export function buildLapIndex(results, cards) {
  const lap = new Map();          // raceId -> {ten3, agari3}
  for (const r of results) if (r.ten3 && r.agari3) lap.set(r.raceId, { ten3: r.ten3, agari3: r.agari3 });
  const distOf = new Map();       // raceId -> 距離（テンの基準を距離別に取るため）
  const pt = new Map();           // raceId -> 1着の番組ポイント
  for (const c of cards) { distOf.set(c.raceId, c.dist); if (c.pt1) pt.set(c.raceId, c.pt1); }
  const acc = new Map();
  for (const [rid, v] of lap) {
    const d = distOf.get(rid);
    if (!d) continue;
    const a = acc.get(d) || [0, 0];
    a[0] += v.ten3; a[1]++; acc.set(d, a);
  }
  const tenBase = new Map([...acc].map(([d, a]) => [d, a[0] / a[1]]));
  return { lap, tenBase, pt };
}

const days = (a, b) => (new Date(a) - new Date(b)) / 86400000;

const W = [1, .85, .7, .55, .45];        // 前走ほど重い（lib/horse.mjs と同じ）
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export function makeFeaturizer(DB) {
  const { derive, human, pedigree } = makeDerivers(DB);

  /* card: cards.jsonl の1レース, baba: 当日の馬場, sim: 馬番→想定3角位置(任意),
     lapIdx: buildLapIndex() の戻り値（無ければラップ由来の特徴量は0になる）      */
  return function featurize(card, baba, sim, lapIdx) {
    const live = card.horses.filter(h => !h.scratch);
    if (live.length < 4) return null;
    const cls = classOf(card.cls);
    const kgAvg = live.reduce((a, h) => a + (h.kg || 55), 0) / live.length;
    const isWet = baba && baba !== '良' ? 1 : 0;
    /* 同型馬：まず全頭の脚質を出してから、各馬に「自分以外」を数える */
    const styles = live.map(h => derive(h, card.dist).style);
    const cntStyle = {};
    styles.forEach(s2 => cntStyle[s2] = (cntStyle[s2] || 0) + 1);
    const sk = lapIdx && lapIdx.shiken;
    const fm = lapIdx && lapIdx.form;
    /* 馬体重は「その馬の普段の体重」と「同レースの平均」の両方と比べる */
    const bws = live.map(h => h.bw).filter(x => x > 0);
    const bwAvg = bws.length ? bws.reduce((a, b) => a + b, 0) / bws.length : 460;
    const rows = live.map((h, hi) => {
      const d = derive(h, card.dist), hu = human(h, card.track), pd = pedigree(h, card.dist);
      const hu0 = hu;
      const p0 = h.past && h.past[0];
      const others = Math.max(1, live.length - 1);
      const nNigeOther = (cntStyle['逃げ'] || 0) - (styles[hi] === '逃げ' ? 1 : 0);
      const nSenOther = (cntStyle['先行'] || 0) - (styles[hi] === '先行' ? 1 : 0);
      const sameOther = (cntStyle[styles[hi]] || 0) - 1;

      /* テン・上がりのラップ。前走欄の /result/ リンクからレースのラップを引く */
      let aSum = 0, aW = 0, tSum = 0, tW = 0, fastRel = [0, 0], slowRel = [0, 0];
      (h.past || []).forEach((p, i) => {
        const w = W[i] ?? 0.4;
        const L = lapIdx && p.rid ? lapIdx.lap.get(p.rid) : null;
        if (L && p.last3f) { aSum += (p.last3f - L.agari3) * w; aW += w; }
        if (L) {
          const base = lapIdx.tenBase.get(p.dist);
          if (base) {
            const dv = L.ten3 - base;                    // 負＝速い流れ
            tSum += dv * w; tW += w;
            const rel = p.field > 1 ? 1 - (p.pos - 1) / (p.field - 1) : 0.5;
            if (dv <= -0.3) { fastRel[0] += rel; fastRel[1]++; }
            else if (dv >= 0.3) { slowRel[0] += rel; slowRel[1]++; }
          }
        }
      });

      /* 南関のポイント制度。番組ポイントはクラスの実質的な物差しになる */
      const pPt = (h.past || []).find(p => p.rid && lapIdx && lapIdx.pt && lapIdx.pt.get(p.rid));
      const prevPt = pPt && lapIdx.pt ? lapIdx.pt.get(pPt.rid) : null;
      const prevCls = p0 ? classOf(p0.race) : cls;
      let streak = 0;
      for (const p of (h.past || [])) { if (p.pos === 1) streak++; else break; }
      const age = Number((h.sexAge || '').replace(/\D/g, '')) || 4;
      const rest = p0 ? Math.max(1, days(card.date, p0.date)) : 200;
      const x = {
        ability: d.ability, close: d.close, stamina: d.stamina, wet: d.wet, epos: d.epos ?? 0.5,
        jIdx: hu.jIdx, tIdx: hu.tIdx, cIdx: hu.cIdx, bond: hu.bond, shobu: hu.shobu, oIdx: hu.oIdx,
        sIdx: pd.sIdx, sDist: pd.sDist, bmsIdx: pd.bmsIdx,
        gate: ((h.gate || 4) - 4.5) / 3.5,
        kgRel: (h.kg || kgAvg) - kgAvg,
        bwLog: h.bw ? Math.log(h.bw / 460) : 0,
        bwDiff: (h.bwDiff || 0) / 10,
        restLog: Math.log(rest) - 3.4,
        layoff: rest >= 60 ? 1 : 0,
        classUp: p0 ? cls - classOf(p0.race) : 0,
        distChg: p0 ? (card.dist - p0.dist) / 400 : 0,
        lastPop: p0 && p0.field ? Math.log((p0.pop || p0.field) / p0.field) : 0,
        lastPos: p0 && p0.field > 1 ? 1 - (p0.pos - 1) / (p0.field - 1) : 0.5,
        nRuns: Math.min((h.past || []).length, 5) / 5,
        wetX: (d.wet - 0.5) * isWet,
        age: (age - 5) / 2,
        mare: /牝/.test(h.sexAge || '') ? 1 : 0,
        frontPress: (styles[hi] === '逃げ' ? 1 : styles[hi] === '先行' ? 0.6 : 0) * (nNigeOther + 0.6 * nSenOther) / others,
        soloNige: styles[hi] === '逃げ' && nNigeOther === 0 ? 1 : 0,
        sameStyle: sameOther / others,
        agariRel: aW ? aSum / aW : 0,
        paceExp: tW ? (tSum / tW) / 2 : 0,
        fastFit: (fastRel[1] && slowRel[1]) ? (fastRel[0] / fastRel[1] - slowRel[0] / slowRel[1]) : 0,
        ptLog: (card.pt1 && prevPt) ? Math.log(card.pt1 / prevPt) : 0,
        upFirst: (p0 && p0.pos === 1 && cls > prevCls) ? 1 : 0,
        downFirst: cls < prevCls ? 1 : 0,
        winStreak: Math.min(streak, 3) / 3,
        afterWin: (p0 && p0.pos === 1 && cls === prevCls) ? 1 : 0,
        /* 前5走が少ない馬ほど効かせる。実績がある馬には試験タイムは要らない */
        skTime: (() => {
          if (!sk) return 0;
          const r = sk.by.get(h.horseId);
          if (!r) return 0;
          const w = Math.max(0, 1 - (h.past || []).length / 3);
          return ((sk.med - r.time) / sk.sd) * w;      // 速いほどプラス
        })(),
        skHas: sk && sk.by.has(h.horseId) ? 1 : 0,
        /* 騎手・調教師の調子。過去の騎乗だけから作っているので先読みは無い。
           生の直近成績は長期指数（jIdx）と相関0.81でほぼ同じ情報になってしまうので、
           **その騎手自身の平常値を事前分布に置いて縮小**し「本来より上か下か」だけを見る。
           （単純に jIdx を引くと縮小のかかり方の差が残り、逆相関の見せかけが出る）*/
        jForm: fm ? fm.get(card.raceId, 'j', h.jockeyId, hu0.jIdx).form : 0,
        jForm3: fm ? fm.get(card.raceId, 'j', h.jockeyId, hu0.jIdx).form3 : 0,
        /* 直近30日の騎乗数。多い＝乗り鞍が集まっている（＝評価されている）*/
        jRides: fm ? Math.min(fm.get(card.raceId, 'j', h.jockeyId).rides30, 80) / 40 - 1 : 0,
        tForm: fm ? fm.get(card.raceId, 't', h.trainerId, hu0.tIdx).form : 0,
        /* 馬体重：自分の普段との差（仕上がり）／増減の大きさ／同レース内での相対 */
        bwDev: (() => {
          const ws = (h.past || []).map(p => p.kg).filter(x => x > 0);
          if (!h.bw || !ws.length) return 0;
          const m = ws.reduce((a, b) => a + b, 0) / ws.length;
          return clamp((h.bw - m) / 12, -2.5, 2.5);
        })(),
        /* 増減の絶対値。大幅な増減はどちらもマイナスに働きやすい */
        bwSwing: h.bwDiff == null ? 0 : Math.min(Math.abs(h.bwDiff), 30) / 10,
        bwRel: h.bw ? clamp((h.bw - bwAvg) / 25, -2.5, 2.5) : 0,
        skFail: (() => {
          const r = sk && sk.by.get(h.horseId);
          return r && /不合格|失格|中止/.test(r.pass) ? 1 : 0;
        })(),
      };
      return { no: h.no, gate: h.gate, name: h.name, x, d, hu, pd };
    });
    return { raceId: card.raceId, date: card.date, track: card.track, R: card.R, dist: card.dist,
      n: live.length, cls, baba: baba || '', rows };
  };
}
