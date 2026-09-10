/* 過去の直前情報を「標本」として集める。
   3年ぶん全部を取るには16万リクエスト（40時間以上）かかるので、まずは無作為標本で
   「部品交換や調整重量に予測の価値があるか」を測ってから、本取りするか決める。
     BT_BH_N     … 取るレース数（既定 1200）
     BT_BH_FROM  … いつ以降から標本を取るか（既定 20240101）
     BT_BH_SEED  … 標本の乱数の種（既定 1）
   出力: data/boat/before.jsonl（1レース1行・追記。同じレースは取り直さない） */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, get, VNAME } from './lib/bt.mjs';
import { parseBefore } from './lib/web.mjs';

const N = Number(process.env.BT_BH_N || 1200);
const FROM = process.env.BT_BH_FROM || '20240101';
let seed = Number(process.env.BT_BH_SEED || 1);
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

const OUT = path.join(ROOT, 'data', 'boat', 'before.jsonl');
const done = new Set();
if (fs.existsSync(OUT)) for (const l of fs.readFileSync(OUT, 'utf8').split('\n')) if (l) { const o = JSON.parse(l); done.add(`${o.date}|${o.jcd}|${o.r}`); }
console.error(`すでに ${done.size} レースぶんある`);

/* 対象は K にあるレース（＝実際に成立したレース）から選ぶ */
const keys = [];
for (const l of fs.readFileSync(path.join(ROOT, 'data/boat/results.jsonl'), 'utf8').split('\n')) {
  if (!l) continue;
  const o = JSON.parse(l);
  if (o.date < FROM) continue;
  keys.push(`${o.date}|${o.jcd}|${o.r}`);
}
/* 無作為に間引く（日付・場・レース番号に偏らないように） */
const pick = [];
for (const k of keys) if (!done.has(k) && rnd() < (N * 3) / keys.length) pick.push(k);
pick.sort(() => rnd() - 0.5);
const target = pick.slice(0, N);
console.error(`候補 ${keys.length}R から ${target.length}R を取る（1件あたり約1秒）`);

let ok = 0, ng = 0, withParts = 0;
for (const [i, k] of target.entries()) {
  const [date, jcd, r] = k.split('|');
  try {
    const b = parseBefore(await get(`https://www.boatrace.jp/owpc/pc/race/beforeinfo?rno=${r}&jcd=${jcd}&hd=${date}`, { ttlDays: 3650 }));
    if (!b.published) { ng++; continue; }
    fs.appendFileSync(OUT, JSON.stringify({ date, jcd, r: Number(r), ...b }) + '\n');
    ok++;
    if (b.boats.some(x => x.parts.length || x.prop)) withParts++;
  } catch (e) { ng++; if (ng % 20 === 0) console.error(`  ! ${VNAME[jcd]} ${date} ${r}R ${e.message}`); }
  if ((i + 1) % 100 === 0) console.error(`  ${i + 1}/${target.length}  取得 ${ok}／失敗 ${ng}／部品交換あり ${withParts}`);
}
console.error(`完了: ${ok}R 取得（失敗 ${ng}）。部品交換またはペラ交換のあったレース ${withParts}R`);
