/* JRA の買い目と組の確率。Plackett–Luce（温度つき）から 馬連・馬単・三連複・三連単・ワイド の確率を出す。
   頭数が多い（最大18頭）ので、3着までの並びは全列挙（18×17×16＝4,896通り）で足りる。
   build（表示）と backtest（検証）が必ずここを通る（式を二重に持たない）。 */
export function combosOf(U, tau = [1, 1], lanes) {
  const n = U.length, m = Math.max(...U);
  const e1 = U.map(u => Math.exp(tau[0] * (u - m))), S1 = e1.reduce((a, b) => a + b, 0);
  const e2 = U.map(u => Math.exp(tau[1] * (u - m))), S2 = e2.reduce((a, b) => a + b, 0);
  const p1 = e1.map(v => v / S1);
  const top2 = Array(n).fill(0), top3 = Array(n).fill(0);
  const umatan = new Map(), umaren = new Map(), santan = new Map(), sanpuku = new Map(), wide = new Map();
  const key2 = (a, b) => `${Math.min(lanes[a], lanes[b])}-${Math.max(lanes[a], lanes[b])}`;
  const add = (map, k, p) => map.set(k, (map.get(k) || 0) + p);
  for (let a = 0; a < n; a++) {
    const pa = p1[a];
    for (let b = 0; b < n; b++) {
      if (b === a) continue;
      const pb = pa * e2[b] / (S2 - e2[a]);
      top2[b] += pb;
      add(umatan, `${lanes[a]}-${lanes[b]}`, pb); add(umaren, key2(a, b), pb);
      for (let c = 0; c < n; c++) {
        if (c === a || c === b) continue;
        const p = pb * e2[c] / (S2 - e2[a] - e2[b]);
        top3[c] += p;
        add(santan, `${lanes[a]}-${lanes[b]}-${lanes[c]}`, p);
        add(sanpuku, [lanes[a], lanes[b], lanes[c]].sort((x, y) => x - y).join('-'), p);
        add(wide, key2(a, b), p); add(wide, key2(a, c), p); add(wide, key2(b, c), p);
      }
    }
  }
  const sorted = map => [...map].sort((x, y) => y[1] - x[1]);
  return { p1, top2: p1.map((v, i) => v + top2[i]), top3: p1.map((v, i) => v + top2[i] + top3[i]),
    umatan: sorted(umatan), umaren: sorted(umaren), santan: sorted(santan), sanpuku: sorted(sanpuku), wide: sorted(wide) };
}
