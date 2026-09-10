/* Plackett–Luce の確率計算と、着順の段階ごとの温度（スケール）の較正。
   fit_boat / backtest_boat / build_boat / check_before が必ずここを通る（式を二重に持たない）。

   なぜ温度が要るか：
   1〜3着の並びを同時に当てはめると、1号艇のように「勝つか沈むか」の艇は2・3着の尤度で
   強さが引き下げられ、1着確率が一貫して低く出る（検証で 1コース 予測45%／実際54.5%、
   本命側は低く・穴側は高く）。そこで β は共通のまま、
     1着     … P(i) ∝ exp(τ1・U_i)
     2・3着  … P(j | 残り) ∝ exp(τ2・U_j)
   の τ1・τ2 を学習データの尤度で別々に決める。1次元の凹関数なので黄金分割で足りる。 */

export function utilities(X, beta) {
  const NF = beta.length;
  return X.map(x => { let s = 0; for (let k = 0; k < NF; k++) s += beta[k] * x[k]; return s; });
}

/* 1着の確率（温度 t） */
export function plWin(U, t = 1) {
  const m = Math.max(...U);
  const e = U.map(u => Math.exp(t * (u - m)));
  const s = e.reduce((a, b) => a + b, 0);
  return e.map(v => v / s);
}

/* 6艇120通りを厳密に足し上げる。tau=[τ1, τ2] */
export function plackettLuce(U, tau = [1, 1]) {
  const n = U.length, m = Math.max(...U);
  const e1 = U.map(u => Math.exp(tau[0] * (u - m))), S1 = e1.reduce((a, b) => a + b, 0);
  const e2 = U.map(u => Math.exp(tau[1] * (u - m))), S2 = e2.reduce((a, b) => a + b, 0);
  const p1 = e1.map(v => v / S1), p2 = Array(n).fill(0), p3 = Array(n).fill(0), tri = [];
  for (let a = 0; a < n; a++) {
    const pa = p1[a];
    for (let b = 0; b < n; b++) {
      if (b === a) continue;
      const pb = e2[b] / (S2 - e2[a]);
      p2[b] += pa * pb;
      for (let c = 0; c < n; c++) {
        if (c === a || c === b) continue;
        const p = pa * pb * e2[c] / (S2 - e2[a] - e2[b]);
        p3[c] += p;
        tri.push([a, b, c, p]);
      }
    }
  }
  tri.sort((x, y) => y[3] - x[3]);
  return { p1, top2: p1.map((v, i) => v + p2[i]), top3: p1.map((v, i) => v + p2[i] + p3[i]), tri };
}

/* 温度の当てはめ。data: [{U, order}] */
function golden(f, lo, hi, iters = 40) {
  const g = (Math.sqrt(5) - 1) / 2;
  let a = lo, b = hi, c = b - g * (b - a), d = a + g * (b - a), fc = f(c), fd = f(d);
  for (let i = 0; i < iters; i++) {
    if (fc > fd) { b = d; d = c; fd = fc; c = b - g * (b - a); fc = f(c); }
    else { a = c; c = d; fc = fd; d = a + g * (b - a); fd = f(d); }
  }
  return (a + b) / 2;
}
export function fitTau(data) {
  const ll1 = t => { let s = 0; for (const { U, order } of data) { const p = plWin(U, t); s += Math.log(Math.max(1e-12, p[order[0]])); } return s; };
  const ll2 = t => {
    let s = 0;
    for (const { U, order } of data) {
      const live = new Set(U.map((_, i) => i)); live.delete(order[0]);
      for (const w of order.slice(1)) {
        const idx = [...live], m = Math.max(...idx.map(i => U[i]));
        const e = idx.map(i => Math.exp(t * (U[i] - m))), z = e.reduce((a, b) => a + b, 0);
        s += t * (U[w] - m) - Math.log(z);
        live.delete(w);
      }
    }
    return s;
  };
  const t1 = golden(ll1, 0.5, 3), t2 = golden(ll2, 0.3, 3);
  return [+t1.toFixed(3), +t2.toFixed(3)];
}
