/* 公式ダウンロードデータ（K=競走成績 / B=番組表）を日付範囲で取り込む。
   1ファイルにその日開催した全場が入るので、1日あたり2リクエストで全24場ぶん揃う。
     BT_FROM / BT_TO … YYYYMMDD（既定は直近90日）
     BT_KIND         … K,B（既定 両方）
   出力は 1レース1行の JSONL（生データ扱い。.gitignore 済み。キャッシュから作り直せる） */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, getOd2, dateRange, ymdOf, VNAME } from './lib/bt.mjs';
import { parseK, parseB } from './lib/od2.mjs';

const d0 = new Date(); d0.setDate(d0.getDate() - 90);
const FROM = process.env.BT_FROM || ymdOf(d0);
const TO = process.env.BT_TO || ymdOf(new Date());
const KINDS = (process.env.BT_KIND || 'K,B').split(',').map(s => s.trim()).filter(Boolean);

const OUT = path.join(ROOT, 'data', 'boat');
fs.mkdirSync(OUT, { recursive: true });

/* 同じ日を取り直しても二重にならないよう、日付キーで差し替える */
function loadKeys(file) {
  const seen = new Set();
  if (!fs.existsSync(file)) return { seen, keep: [] };
  const keep = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    try { seen.add(JSON.parse(line).date); keep.push(line); } catch { }
  }
  return { seen, keep };
}

for (const kind of KINDS) {
  const file = path.join(OUT, kind === 'K' ? 'results.jsonl' : 'programs.jsonl');
  const { keep } = loadKeys(file);
  const rows = new Map();                       // date -> [行]
  for (const line of keep) { const d = JSON.parse(line).date; (rows.get(d) || rows.set(d, []).get(d)).push(line); }

  let days = 0, races = 0, none = 0;
  for (const ymd of dateRange(FROM, TO)) {
    let txt;
    try { txt = await getOd2(kind, ymd); }
    catch (e) { console.error(`  ! ${kind} ${ymd} ${e.message}`); continue; }
    if (!txt) { none++; continue; }
    const parsed = kind === 'K' ? parseK(txt, ymd) : parseB(txt, ymd);
    const out = [];
    for (const d of parsed) for (const r of d.races) {
      out.push(JSON.stringify(kind === 'K'
        ? { date: ymd, jcd: d.jcd, venue: VNAME[d.jcd], ...r }
        : { date: ymd, jcd: d.jcd, venue: VNAME[d.jcd], title: d.title, day: d.day, ...r }));
    }
    rows.set(ymd, out);
    days++; races += out.length;
    if (days % 30 === 0) console.error(`  ${kind} ${ymd} … ${days}日 ${races}R`);
  }
  const all = [...rows.keys()].sort().flatMap(d => rows.get(d));
  fs.writeFileSync(file, all.join('\n') + (all.length ? '\n' : ''));
  console.error(`${kind}: ${days}日 ${races}R 取得（開催なし ${none}日）-> data/boat/${path.basename(file)} (${(fs.statSync(file).size / 1048576).toFixed(1)} MB, 累計 ${all.length}R)`);
}
