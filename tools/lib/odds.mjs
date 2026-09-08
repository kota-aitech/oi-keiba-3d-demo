/* /oddsJS/{raceId}.do が返す JS から単勝・複勝オッズを取り出す。
   odds_tan = { 馬番: [単勝オッズ, 発売中か, ?, 人気順], ... }
   発売前は "0.0" が並ぶので live で判別する。                                */
export function parseOdds(js) {
  const grab = name => {
    const m = new RegExp(`var ${name}\\s*=\\s*\\{([\\s\\S]*?)\\};`).exec(js);
    if (!m) return {};
    const o = {};
    for (const r of m[1].matchAll(/"(\d+)"\s*:\s*\[\s*"([^"]*)"\s*,\s*(true|false)\s*,\s*(-?\d+)\s*,\s*(-?\d+)/g))
      o[r[1]] = { v: r[2], sale: r[3] === 'true', pop: Number(r[5]) };
    return o;
  };
  const tan = grab('odds_tan'), fuku = grab('odds_fuku');
  const t = /var update_time\s*=\s*"([^"]*)"/.exec(js);
  const live = Object.values(tan).some(x => Number(x.v) > 0);
  return {
    updated: t ? t[1] : '',
    live,
    tan: Object.fromEntries(Object.entries(tan).map(([k, v]) => [k, { odds: Number(v.v) || null, pop: v.pop || null }])),
    fuku: Object.fromEntries(Object.entries(fuku).map(([k, v]) => {
      const [lo, hi] = v.v.split('-').map(Number);
      return [k, { lo: lo || null, hi: hi || null, pop: v.pop || null }];
    })),
  };
}
