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
const sandbox = { document, console, Math, JSON, Date, Intl, URLSearchParams, navigator: {}, alert: noop, setTimeout: noop,
  location: { search: '?track=' + track } };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(js + '\nglobalThis.__X={D,render,setRace:(d,i)=>{day=d;ridx=i;},setOpenAll:v=>{openAll=v;},NKR};', sandbox);
const X = sandbox.__X;

let bad = 0, races = 0, horses = 0, withPast = 0, scratched = 0;
for (const [dk, list] of Object.entries(X.D.days)) {
  for (let i = 0; i < list.length; i++) {
    X.setRace(dk, i);
    X.setOpenAll(true);                    // 前5走まで開いた状態で描画する
    store.get('wrap').innerHTML = '';
    X.render();
    const h = store.get('wrap').innerHTML;
    const r = list[i];
    const hs = X.D.entries[`${dk}|${r.r}`] || [];
    const live = hs.filter(x => !x.scratch);
    races++; horses += live.length;
    scratched += hs.length - live.length;
    withPast += live.filter(x => x.past && x.past.length).length;
    if (h.length < 500) { console.log(`  ! ${dk} ${r.r}R の描画が空`); bad++; continue; }
    if (live.length !== r.n) { console.log(`  ! ${dk} ${r.r}R 頭数 ${r.n} ≠ 出走馬 ${live.length}`); bad++; }
    for (const x of live) {
      if (!x.jockey || !x.trainer) { console.log(`  ! ${dk} ${r.r}R ${x.name} 騎手/調教師が空`); bad++; }
      if (x.hIdx == null || x.ability == null) { console.log(`  ! ${dk} ${r.r}R ${x.name} 指数が欠落`); bad++; }
    }
  }
}
console.log(`${track}: ${races} レース / 出走 ${horses} 頭（うち前5走あり ${withPast}）/ 取消 ${scratched} 頭、問題 ${bad} 件`);
const sample = Object.values(X.D.entries)[0][0];
console.log(`例: ${sample.no} ${sample.name} ${sample.sexAge} ${sample.kg}kg ${sample.jockey}(${sample.jockeyBase}) × ${sample.trainer} / ${sample.owner} / 父 ${sample.sire}`);
process.exit(bad ? 1 : 0);
