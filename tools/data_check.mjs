/* ブラウザなしで data.html を実行し、全タブが描画できるかを見る。
   使い方: node tools/data_check.mjs                                        */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './lib/nk.mjs';

const html = fs.readFileSync(path.join(ROOT, 'data.html'), 'utf8');
const js = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>'));
const ids = [...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]);
const noop = () => {};
const store = new Map();
const mk = id => ({ id, innerHTML: '', textContent: '', value: id === 'minN' ? '50' : '', style: {}, dataset: {},
  classList: { add: noop, remove: noop, toggle: noop, contains: () => false }, appendChild: noop, addEventListener: noop });
ids.forEach(i => store.set(i, mk(i)));
const document = {
  getElementById: id => store.get(id) || null,
  createElement: () => mk('anon'),
  querySelector: sel => store.get('bar') || mk(sel),
  querySelectorAll: () => [],
  addEventListener: noop, body: mk('body'),
};
const sandbox = { document, console, Math, JSON, Date, Intl, navigator: {}, alert: noop, setTimeout: noop };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(js + '\nglobalThis.__X={TABS,ORDER,render,view,tsv,NKB,setTab:k=>{cur=k;}};', sandbox);
const X = sandbox.__X;

let bad = 0;
for (const k of X.ORDER) {
  X.setTab(k);
  store.get('wrap').innerHTML = '';
  X.render();
  const h = store.get('wrap').innerHTML;
  const rows = (h.match(/<tr>/g) || []).length;
  if (h.length < 200) { console.log(`  ! ${k} の描画が空`); bad++; continue; }
  console.log(`${k.padEnd(8)} ${String(rows).padStart(5)} 行  ${String(store.get('count').textContent || '').padEnd(30)} ${h.length.toLocaleString()} 文字`);
}
/* TSV 書き出しも1タブ試す */
X.setTab('combo'); X.render();
const t = X.tsv().split('\n');
console.log(`TSV: ${t.length} 行 / 先頭: ${t[0]}`);
console.log(`     ${t[1]}`);
console.log(`データ件数: 騎手 ${X.NKB.jockey.length} / 調教師 ${X.NKB.trainer.length} / コンビ ${X.NKB.combo.length} / 馬主 ${X.NKB.owner.length} / 種牡馬 ${X.NKB.sire.length} / 母の父 ${X.NKB.bms.length}`);
process.exit(bad ? 1 : 0);
