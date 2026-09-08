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
  'wetX', 'age', 'mare', 'simC3',
];

const days = (a, b) => (new Date(a) - new Date(b)) / 86400000;

export function makeFeaturizer(DB) {
  const { derive, human, pedigree } = makeDerivers(DB);

  /* card: cards.jsonl の1レース, baba: 当日の馬場, sim: 馬番→想定3角位置(任意) */
  return function featurize(card, baba, sim) {
    const live = card.horses.filter(h => !h.scratch);
    if (live.length < 4) return null;
    const cls = classOf(card.cls);
    const kgAvg = live.reduce((a, h) => a + (h.kg || 55), 0) / live.length;
    const isWet = baba && baba !== '良' ? 1 : 0;
    const rows = live.map(h => {
      const d = derive(h, card.dist), hu = human(h, card.track), pd = pedigree(h, card.dist);
      const p0 = h.past && h.past[0];
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
        simC3: sim && sim[h.no] != null ? (sim[h.no] / (live.length + 1) - 0.5) : 0,
      };
      return { no: h.no, gate: h.gate, name: h.name, x, d, hu, pd };
    });
    return { raceId: card.raceId, date: card.date, track: card.track, R: card.R, dist: card.dist,
      n: live.length, cls, baba: baba || '', rows };
  };
}
