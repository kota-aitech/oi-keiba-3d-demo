/* ブラウザなしで race.html（出馬表ページ）を実行し、全開催日・全レースを描画する。
   使い方: node tools/race_check.mjs [oi|kawasaki]                          */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './lib/nk.mjs';

const track = process.argv[2] || 'oi';
const html = fs.readFileSync(path.join(ROOT, 'race.html'), 'utf8');
const js = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>'));
const ids = [...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]);
const noop = () => {};
const store = new Map();
const mk = id => ({ id, innerHTML: '', textContent: '', value: '', style: {}, dataset: {}, className: '',
  classList: { add: noop, remove: noop, toggle: noop, contains: () => false }, appendChild: noop, addEventListener: noop });
ids.forEach(i => store.set(i, mk(i)));
const document = {
  getElementById: id => store.get(id) || null,
  createElement: () => mk('anon'), querySelector: () => mk('q'), querySelectorAll: () => [],
  addEventListener: noop, body: mk('body'),
};
const store2 = new Map();
const localStorage = { getItem: k => (store2.has(k) ? store2.get(k) : null), setItem: (k, v) => store2.set(k, String(v)), removeItem: k => store2.delete(k) };
const sandbox = { document, console, Math, JSON, Date, Intl, URLSearchParams, navigator: {}, alert: noop, setTimeout: noop,
  localStorage, location: { search: '?track=' + track } };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(js + '\nglobalThis.__X={D,render,NKR,setRace:(d,i)=>{day=d;ridx=i;},setLayout:v=>{layout=v;}};', sandbox);
const X = sandbox.__X;

let bad = 0, races = 0, horses = 0, withPast = 0, scratched = 0, graded = 0;
const r0 = (list, i) => list[i].r;
for (const [dk, list] of Object.entries(X.D.days)) {
  for (let i = 0; i < list.length; i++) {
    X.setRace(dk, i);
    /* 横型・縦型の両方を描いて確認する */
    let h = '';
    for (const lay of ['yoko', 'tate']) {
      X.setLayout(lay);
      store.get('board').innerHTML = '';
      X.render();
      const cur = store.get('board').innerHTML;
      if (cur.length < 500) { console.log(`  ! ${dk} ${r0(list, i)}R の${lay}描画が空`); bad++; }
      if (lay === 'tate' && !/class="pil /.test(cur) && !/class="pil"/.test(cur)) { console.log(`  ! ${dk} 縦型の柱が描けていない`); bad++; }
      h = lay === 'yoko' ? cur : h;
    }
    const r = list[i];
    const hs = X.D.entries[`${dk}|${r.r}`] || [];
    const live = hs.filter(x => !x.scratch);
    races++; horses += live.length;
    scratched += hs.length - live.length;
    withPast += live.filter(x => x.past && x.past.length).length;
    if (h.length < 500) { console.log(`  ! ${dk} ${r.r}R の描画が空`); bad++; continue; }
    if (list[i].grade) graded++;
    const marks = live.filter(x => x.mark).length;
    if (marks < Math.min(5, live.length)) { console.log(`  ! ${dk} ${r.r}R 印が ${marks} 個しかない`); bad++; }
    if (!/class="uma/.test(h) || !/class="run"/.test(h)) { console.log(`  ! ${dk} ${r.r}R 馬柱/前走の描画が欠けている`); bad++; }
    if (live.length !== r.n) { console.log(`  ! ${dk} ${r.r}R 頭数 ${r.n} ≠ 出走馬 ${live.length}`); bad++; }
    for (const x of live) {
      if (!x.jockey || !x.trainer) { console.log(`  ! ${dk} ${r.r}R ${x.name} 騎手/調教師が空`); bad++; }
      if (x.hIdx == null || x.ability == null) { console.log(`  ! ${dk} ${r.r}R ${x.name} 指数が欠落`); bad++; }
      if (x.win == null || x.top3 == null) { console.log(`  ! ${dk} ${r.r}R ${x.name} 勝率が欠落（build_marks 未実行）`); bad++; }
    }
  }
}
console.log(`${track}: ${races} レース / 出走 ${horses} 頭（うち前5走あり ${withPast}）/ 取消 ${scratched} 頭 / 段位あり ${graded} レース、問題 ${bad} 件`);
const rk = Object.keys(X.D.entries)[9];
const top = X.D.entries[rk].filter(h => h.mark).sort((a, b) => b.win - a.win);
console.log(`例 ${rk}: ` + top.map(h => `${h.mark}${h.no} ${h.name}(${(h.win * 100).toFixed(1)}%)`).join(' '));
process.exit(bad ? 1 : 0);
