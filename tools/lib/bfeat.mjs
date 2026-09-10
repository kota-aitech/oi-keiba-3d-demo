/* 条件付きロジット（Plackett–Luce）用の特徴量。レース前に分かる情報だけを使う。
   単位はすべて「対数オッズ差」に寄せる（南関側と同じ約束）。

   ボートは着順が進入コースにほぼ支配される。素の勝率を実力として扱うと
   1号艇の選手が全員名人に見えるので、必ず「場×コースの基準からの上振れ」で持つ。

   レベルは2つ。
     pre … 番組表と天候だけ（発走の数時間前に出せる）。進入は枠なり前提で
           場の「枠番別コース取得率」で重みづけする
     ex  … 直前情報が出たあと。進入コースが確定し、展示タイムが使える
   どちらも3年ぶんの K ファイルで学習できる（K に 展示・進入が入っているため）。 */

const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const logit = p => { const q = clamp(p, 1e-3, 1 - 1e-3); return Math.log(q / (1 - q)); };
const GRADES = ['A1', 'A2', 'B1', 'B2'];

export const FEATS = [
  'cz',          // 進入コースの基準（場×コース）の対数オッズ
  'czTop2',      // 同・2連対の基準
  'rIdx',        // 選手の実力（コース補正済み）
  'rIdxC',       // そのコースでの上振れ
  'rIdxJ',       // 当地での上振れ
  'stFast',      // 平均STの速さ（+ が速い）
  'stFastC',     // そのコースでの平均STの速さ
  'natWin', 'nat2', 'locWin', 'loc2',
  'gA1', 'gA2', 'gB1',
  'age', 'weight',
  'setuAvg', 'setuN',
  'motor2', 'motorIdx', 'boat2',
  'fRate', 'makuri', 'inGain',
  'windC', 'waveC', 'windAbs', 'waveAbs',
  'exDev', 'exRank',           // ex レベルのみ（pre では 0）
];
export const NF = FEATS.length;

/* 今節成績の文字列（'1526' など）→ 平均着順と走数。F/K/S は6着相当に寄せる */
function setuOf(s) {
  const v = [...String(s || '')].map(c => /[1-6]/.test(c) ? Number(c) : 6.5).filter(x => x);
  return v.length ? { avg: v.reduce((a, b) => a + b, 0) / v.length, n: v.length } : { avg: 3.5, n: 0 };
}

/* 進入コースの確率ベクトル。
   ex: 実際の進入が分かっているので one-hot。
   pre: 場の「枠番別コース取得率」（stadium.json の take、％）を使う */
function courseProb(lane, course, take) {
  const p = [0, 0, 0, 0, 0, 0];
  if (course) { p[course - 1] = 1; return p; }
  const row = take?.[lane - 1];
  if (!row) { p[lane - 1] = 1; return p; }
  const s = row.reduce((a, b) => a + b, 0) || 1;
  for (let c = 0; c < 6; c++) p[c] = row[c] / s;
  return p;
}

/* DB（index.json）と場データ（stadium.json）を渡して、1レースぶんの行列を作る。
   race: { jcd, date, dist, wind, wave, weather, entries|boats }
   boats[i]: { lane, toban, course?, ex?, grade, age, weight, natWin, nat2, locWin, loc2,
               motor, motor2, boat, boat2, setu } */
export function raceFeatures(race, boats, DB, ST, { level = 'pre' } = {}) {
  const jcd = race.jcd;
  const base = DB.base || {};
  const take = ST?.[jcd]?.take;
  const bz = (c, kind) => {
    const b = base[jcd + '|' + c];
    return b ? logit(b[kind]) : logit(kind === 'win' ? 1 / 6 : 2 / 6);
  };
  const exs = boats.map(b => (level === 'ex' ? b.ex : null)).filter(v => v != null);
  const exMean = exs.length ? exs.reduce((a, b) => a + b, 0) / exs.length : null;
  const exSorted = [...exs].sort((a, b) => a - b);
  const wind = race.wind ?? 0, wave = race.wave ?? 0;

  return boats.map(b => {
    const r = DB.racer?.[b.toban] || null;
    const cp = courseProb(b.lane, level === 'ex' ? b.course : null, take);
    const cMid = cp.reduce((a, p, i) => a + p * (i + 1), 0);      // 期待進入コース
    const x = new Float64Array(NF);
    const set = (k, v) => { x[FEATS.indexOf(k)] = Number.isFinite(v) ? v : 0; };

    set('cz', cp.reduce((a, p, i) => a + p * bz(i + 1, 'win'), 0) - logit(1 / 6));
    set('czTop2', cp.reduce((a, p, i) => a + p * bz(i + 1, 'top2'), 0) - logit(2 / 6));

    set('rIdx', r?.idx ?? 0);
    set('rIdxC', r ? cp.reduce((a, p, i) => a + p * (r.byC?.[i + 1] ?? 0), 0) : 0);
    set('rIdxJ', r?.byJ?.[jcd] ?? 0);
    set('stFast', r?.stDev != null ? -r.stDev * 10 : 0);          // 0.01秒＝0.1 の目盛りに
    set('stFastC', r ? cp.reduce((a, p, i) => a + p * (r.stByC?.[i + 1] != null && r.st != null ? -(r.stByC[i + 1] - r.st) * 10 : 0), 0) : 0);

    set('natWin', (b.natWin ?? 5.5) - 5.5);
    set('nat2', ((b.nat2 ?? 35) - 35) / 10);
    set('locWin', b.locWin ? b.locWin - 5.5 : 0);
    set('loc2', b.loc2 ? (b.loc2 - 35) / 10 : 0);
    set('gA1', b.grade === 'A1' ? 1 : 0);
    set('gA2', b.grade === 'A2' ? 1 : 0);
    set('gB1', b.grade === 'B1' ? 1 : 0);
    set('age', ((b.age ?? 38) - 38) / 10);
    set('weight', ((b.weight ?? 52) - 52) / 5);

    const su = setuOf(b.setu);
    set('setuAvg', (3.5 - su.avg) / 2);
    set('setuN', clamp(su.n, 0, 6) / 6);

    set('motor2', ((b.motor2 ?? 35) - 35) / 10);
    set('motorIdx', DB.motor?.[jcd]?.[b.motor + '#' + (b.motorGen || 1)]?.idx ?? 0);
    set('boat2', ((b.boat2 ?? 35) - 35) / 10);

    set('fRate', -(r?.fRate ?? 0) * 20);
    set('makuri', r?.kim ? (r.kim[1] + r.kim[3]) - 0.35 : 0);
    /* 前づけ癖。枠より内を取る選手は pre の段階で進入が読みにくい */
    set('inGain', level === 'ex' ? 0 : (r?.inGain ?? 0));

    /* 風・波はコースによって効き方が変わる。中心（3.5コース）からのズレに掛ける */
    set('windC', wind * (cMid - 3.5) / 10);
    set('waveC', wave * (cMid - 3.5) / 100);
    set('windAbs', wind / 10);
    set('waveAbs', wave / 100);

    if (level === 'ex' && b.ex != null && exMean != null) {
      set('exDev', (exMean - b.ex) * 20);                          // 速いほど +
      set('exRank', (3.5 - (exSorted.indexOf(b.ex) + 1)) / 2);
    }
    return x;
  });
}
