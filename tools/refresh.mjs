/* オッズが更新されたら、印・期待値・おすすめ買い目・TOPを作り直して各ページに埋め直す。
   watch_odds.mjs がオッズを取り、こちらが「見える形」に反映する係。
   launchd から数分おきに呼ぶ想定（NK_ODDS_ONCE と同じ考え方で、常駐しない）。

   オッズに変化が無ければ何もしない（毎回1MB書き換えるのは無駄なので）。 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT } from './lib/nk.mjs';

const STAMP = path.join(ROOT, 'data', 'nankan', '.refresh-stamp');
const watch = ['odds_pre.json', 'odds_live.jsonl'].map(f => path.join(ROOT, 'data/nankan', f));
const sig = watch.map(f => { try { const s = fs.statSync(f); return `${f}:${s.mtimeMs}:${s.size}`; } catch { return f + ':-'; } }).join('|');
let prev = '';
try { prev = fs.readFileSync(STAMP, 'utf8'); } catch {}
if (sig === prev && !process.env.NK_REFRESH_FORCE) { process.exit(0); }

const run = (script, env) => {
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'tools', script)],
      { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, ...env } });
    return true;
  } catch (e) {
    console.error(`! ${script} 失敗: ${String(e.stderr || e.message).split('\n').slice(-3).join(' ')}`);
    return false;
  }
};
const t0 = Date.now();
// 位置取りは馬場条件が変わらなければ同じなので、オッズ更新時は使い回す
if (!run('build_marks.mjs', { NK_MARK_FAST: '1' })) process.exit(1);
if (!run('build_top.mjs')) process.exit(1);     // TOP の要約
if (!run('embed_db.mjs')) process.exit(1);      // 各ページに埋め込み
fs.writeFileSync(STAMP, sig);
console.error(`${new Date().toLocaleTimeString('ja-JP')} 反映完了（${((Date.now() - t0) / 1000).toFixed(0)}秒）`);
