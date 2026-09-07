/* 生成した JSON を HTML のマーカー間に流し込む。
   /* NAME:BEGIN ... *​/  const VAR={...};  /* NAME:END *​/  の形を保つ。      */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './nk.mjs';

export function inject(file, marker, varName, data) {
  const p = path.join(ROOT, file);
  const html = fs.readFileSync(p, 'utf8');
  const B = `/* ${marker}:BEGIN`, E = `/* ${marker}:END */`;
  const i = html.indexOf(B), j = html.indexOf(E);
  if (i < 0 || j < 0) throw new Error(`${file} に ${marker} マーカーがありません`);
  const head = html.slice(i, html.indexOf('\n', i) + 1);
  const body = `const ${varName}=${JSON.stringify(data)};\n`;
  fs.writeFileSync(p, html.slice(0, i) + head + body + html.slice(j));
  console.error(`埋め込み ${(body.length / 1024).toFixed(0)} KB → ${file} (${(fs.statSync(p).size / 1024).toFixed(0)} KB)`);
}
