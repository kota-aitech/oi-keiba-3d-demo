/* 能力・調教試験の結果を取り込む。新馬・転入初戦・長期休養明けの馬は前5走が無く、
   血統しか手がかりが無い。この試験タイムが「実際に走った唯一の記録」になる。

   一覧 /shiken_menu/shiken.do は直近10回ぶんしかリンクが無いが、
   /shiken_list/{YYYYMMDD}{場2}.do は日付を組み立てれば直接開ける。開催日から総当たりする。
   ※ 表は rowspan で母父が2行目に来る壊れた組み方なので <tr> ではなく行の塊で読む。

   使い方: NK_SK_FROM=2026-04-01 node tools/fetch_shiken.mjs
   出力: data/nankan/shiken.jsonl（1頭1行）                                    */
import fs from 'node:fs';
import path from 'node:path';
import { get, text, num, ROOT } from './lib/nk.mjs';

const BASE = 'https://www.nankankeiba.com';
const OUT = path.join(ROOT, 'data', 'nankan', 'shiken.jsonl');
const JO = { '18': '浦和', '19': '船橋', '20': '大井', '21': '川崎' };
const FROM = process.env.NK_SK_FROM || '2026-01-01';
const TO = process.env.NK_SK_TO || new Date().toLocaleDateString('sv-SE');

/* 1頭ぶんの塊を読む。rowspan の主行に馬IDから合否まで入っている */
export function parseShiken(html, date, track) {
  const out = [];
  for (const m of html.matchAll(/<td rowspan="2"[^>]*>\s*<a href="\/uma_info\/(\d+)\.do"[^>]*>([^<]+)<\/a>\s*<\/td>([\s\S]{0,1400}?)<\/tr>/g)) {
    const [, horseId, name, rest] = m;
    const kis = /\/kis_info\/(\d+)\.do"[^>]*>([^<]+)</.exec(rest);
    const cho = /\/cho_info\/(\d+)\.do"[^>]*>([^<]+)</.exec(rest);
    /* rowspan の td を順に拾う: 父 / 母 / 騎手 / 調教師 / 性齢 / 体重 / 内容 / タイム / 合否 */
    const tds = [...rest.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(x => text(x[1]));
    const time = tds.map(v => /^\d{2,3}\.\d$/.test(v) ? Number(v) : null).filter(v => v != null).pop();
    const pass = tds.find(v => /合格|不合格|失格|中止/.test(v)) || '';
    const kind = tds.find(v => /^(能力|調教)$/.test(v)) || '';
    const sexAge = tds.find(v => /^[牡牝セ]\d+$/.test(v.replace(/\s/g, ''))) || '';
    const bw = tds.map(v => (/^\d{3}$/.test(v.trim()) ? Number(v) : null)).filter(v => v != null)[0] || null;
    if (!time) continue;
    out.push({ date, track, horseId, name: text(name),
      sire: tds[0] || '', jockey: kis ? text(kis[2]) : '', jockeyId: kis ? kis[1] : '',
      trainer: cho ? text(cho[2]) : '', trainerId: cho ? cho[1] : '',
      sexAge: sexAge.replace(/\s/g, ''), bw, kind, time, pass });
  }
  return out;
}

/* 開催日は cards.jsonl から。試験はその場の開催日に行われる */
const days = new Set();
for (const line of fs.readFileSync(path.join(ROOT, 'data/nankan/cards.jsonl'), 'utf8').split('\n')) {
  if (!line) continue;
  let c; try { c = JSON.parse(line); } catch { continue; }
  if (c.date < FROM || c.date > TO) continue;
  days.add(c.date.replace(/-/g, '') + c.raceId.slice(8, 10));
}
/* 一覧に出ているぶんも足す（開催のない日に行うこともあるため） */
try {
  const menu = await get(`${BASE}/shiken_menu/shiken.do`, { ttlDays: 0.5 });
  for (const m of menu.matchAll(/\/shiken_list\/(\d+)\.do/g)) days.add(m[1]);
} catch {}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
const seen = new Set();
if (fs.existsSync(OUT)) for (const l of fs.readFileSync(OUT, 'utf8').split('\n')) {
  if (!l) continue; try { const r = JSON.parse(l); seen.add(r.date + '|' + r.horseId); } catch {}
}
let added = 0, pages = 0;
for (const id of [...days].sort()) {
  const date = `${id.slice(0, 4)}-${id.slice(4, 6)}-${id.slice(6, 8)}`;
  if (date < FROM || date > TO) continue;
  let html;
  const age = (Date.now() - new Date(date + 'T00:00:00')) / 86400000;
  try { html = await get(`${BASE}/shiken_list/${id}.do`, { ttlDays: age < 4 ? 0.05 : 365, tries: 1 }); }
  catch { continue; }
  const rows = parseShiken(html, date, JO[id.slice(8, 10)] || '');
  if (!rows.length) continue;
  pages++;
  for (const r of rows) {
    const k = r.date + '|' + r.horseId;
    if (seen.has(k)) continue;
    fs.appendFileSync(OUT, JSON.stringify(r) + '\n');
    seen.add(k); added++;
  }
  console.error(`${date} ${JO[id.slice(8, 10)]} ${rows.length}頭`);
}
console.error(`完了: ${pages}日ぶん、${added}頭を追加（合計 ${seen.size}）`);
