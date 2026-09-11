/* Yahoo!スポーツ 競馬（sports.yahoo.co.jp/keiba）のパーサ。netkeiba が規制されたときの代替であり、
   馬ID・騎手ID・調教師IDは netkeiba と同じ体系（例 horse 2020105749、jockey 01150）なので混ぜて使える。
     月間日程   /keiba/schedule/monthly?year=YYYY&month=M   → 開催ID（yy 場2 回2 日2）
     レース一覧 /keiba/race/list/{開催ID}                    → 日付と race_id（10桁＝netkeiba の12桁から先頭の "20" を除いたもの）
     結果       /keiba/race/result/{race_id10}               → 着順・タイム・着差・通過順・上がり・騎手・斤量・人気・オッズ・調教師・馬体重、払戻、コーナー、ラップ
     出馬表     /keiba/race/denma/{race_id10}                → 枠・馬番・馬名・性齢毛色・騎手・斤量・調教師(所属)・父・母・母父・馬体重・人気オッズ（前走は無い）
   出馬表に前5走が無いぶんは、results.jsonl の馬IDから組み立てる（jra_fetch_cards.mjs）。 */
import { text, num, VENUES } from './jra.mjs';

export const YAHOO = 'https://sports.yahoo.co.jp';
export const toId12 = id10 => '20' + id10;
export const toId10 = id12 => id12.slice(2);
const cells = tr => [...tr.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/g)].map(m => m[1]);
const idOf = (h, kind) => (h.match(new RegExp(`/keiba/directory/${kind}/(\\w+)/`)) || [])[1] || null;
const dateOf = html => { const m = html.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/); return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : null; };

export function parseMonthly(html) {
  return [...new Set([...html.matchAll(/\/keiba\/race\/list\/(\d{8})/g)].map(m => m[1]))].sort();
}

export function parseList(html, kaisai) {
  /* 一覧の各レースは /keiba/race/index/{10桁} へのリンク。レース名は hr-tableSchedule__title */
  const names = {};
  for (const m of html.matchAll(/\/keiba\/race\/(?:index|denma|result)\/(\d{10})[^>]*>\s*<span class="hr-tableSchedule__title">([\s\S]*?)<\/span>/g)) names[m[1]] = text(m[2]);
  const ids = [...new Set([...html.matchAll(/\/keiba\/race\/(?:index|denma|result)\/(\d{10})/g)].map(m => m[1]))].filter(id => id.startsWith(kaisai)).sort();
  return { kaisai, date: dateOf(html), venue: VENUES[kaisai.slice(2, 4)] || null, races: ids.map(id => ({ raceId: toId12(id), r: Number(id.slice(8, 10)), name: names[id] || null })) };
}

/* レース見出し：「15:45発走 / 江の島ステークス / 芝・左 1800m / 天気：晴 / 馬場：良 / 3歳以上 / オープン（国際）（特指）…」 */
function parseHead(html) {
  const box = (html.match(/class="hr-predictRaceInfo"[\s\S]*?<\/section>/) || html.match(/hr-predictRaceInfo[\s\S]{0,4000}/) || [''])[0];
  const t = text(box);
  /* 「芝・右・外 1600m」「ダート・左 1800m」「障害・芝 3000m」など */
  const m = t.match(/(芝|ダート|障害)(?:・(右|左|直))?(?:・[^\s\d・]+)?\s*(\d{3,4})m/);
  const nameRaw = text((html.match(/class="hr-predictRaceInfo__title"[^>]*>([\s\S]*?)<\/(?:h1|p|div|span)>/) || [])[1] || '');
  return {
    name: nameRaw.replace(/\s*(GIII|GII|GI|G3|G2|G1|L|OP)\s*$/, '').trim(), grade: (nameRaw.match(/(GIII|GII|GI|G3|G2|G1|L|OP)\s*$/) || [])[1] || null,
    start: (t.match(/(\d{1,2}:\d{2})発走/) || [])[1] || null,
    surface: m ? ({ '芝': '芝', 'ダート': 'ダ', '障害': '障' })[m[1]] : null, turn: m ? m[2] || null : null, dist: m ? Number(m[3]) : null,
    inner: m ? ((t.match(/(芝|ダート)・(?:右|左|直)・(外|内)/) || [])[2] || null) : null,
    weather: (t.match(/天気：\s*(\S+?)(?:\s|馬場|$)/) || [])[1]?.replace(/^-$/, '') || null,
    baba: (t.match(/馬場：\s*(\S+?)(?:\s|$)/) || [])[1]?.replace(/^-$/, '') || null,
    cond: t.replace(/^.*?馬場：\S*\s*/, '').replace(/\|/g, ' ').replace(/\s+/g, ' ').replace(/\s*(本賞金|出馬表).*$/, '').trim().slice(0, 80),
  };
}

function parsePayout(html) {
  const KIND = { '単勝': 'win', '複勝': 'place', '枠連': 'waku', '馬連': 'umaren', 'ワイド': 'wide', '馬単': 'umatan', '3連複': 'sanpuku', '三連複': 'sanpuku', '3連単': 'santan', '三連単': 'santan' };
  const out = {};
  let kind = null;
  for (const tr of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const c = cells(tr[1]).map(text);
    if (!c.length) continue;
    let i = 0;
    if (KIND[c[0]]) { kind = KIND[c[0]]; i = 1; }
    if (!kind || c.length - i < 2) continue;
    const combo = c[i].replace(/\s+/g, ''), yen = num((c[i + 1].match(/([\d,]+)円/) || [])[1]);
    if (!/^[\d\-]+$/.test(combo) || yen == null) { if (KIND[c[0]] == null) kind = null; continue; }
    (out[kind] ||= []).push({ c: combo, y: yen, pop: num(c[i + 2]) });
    if (['win', 'waku', 'umaren', 'umatan', 'sanpuku', 'santan'].includes(kind)) kind = null;   // 1組だけの券種は行が終わったら閉じる
  }
  return out;
}

export function parseResult(html, raceId) {
  const head = parseHead(html);
  const table = (html.match(/class="hr-raceResults"[\s\S]*?<\/table>/) || [''])[0];
  const entries = [];
  for (const tr of table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const c = cells(tr[1]);
    if (c.length < 9 || !/directory\/horse/.test(c[3])) continue;
    const t = c.map(x => text(x.replace(/<p>/g, ' ｜ ')));
    const nm = t[3].split('｜').map(s => s.trim());
    const bw = (nm[1] || '').match(/(\d{3})\(([+\-]?\d+)\)/);
    const tm = t[4].split('｜').map(s => s.trim()), od = t[5].split('｜').map(s => s.trim()), jk = t[6].split('｜').map(s => s.trim()), pp = t[7].split('｜').map(s => s.trim());
    const posT = t[0].trim();
    entries.push({
      pos: /^\d+$/.test(posT) ? Number(posT) : posT, waku: num(t[1]), no: num(t[2]),
      name: nm[0], horseId: idOf(c[3], 'horse'), sexAge: ((nm[1] || '').match(/^[牡牝セ]\d+/) || [])[0] || null, blinker: /\/B/.test(nm[1] || ''),
      time: tm[0] && /\d/.test(tm[0]) ? tm[0] : null, margin: tm[1] && tm[1] !== '-' ? tm[1] : null,
      pass: od[0] && /\d/.test(od[0]) ? od[0].replace(/(^|-)0(\d)/g, '$1$2') : null, agari: num(od[1]),
      jockey: jk[0], jockeyId: idOf(c[6], 'jockey'), kin: num(jk[1]),
      pop: num(pp[0]), odds: num((pp[1] || '').replace(/[()]/g, '')),
      trainer: t[8], trainerId: idOf(c[8], 'trainer'),
      bw: bw ? Number(bw[1]) : null, bwDiff: bw ? Number(bw[2]) : null,
    });
  }
  const corners = {};
  for (const m of html.matchAll(/<t[dh][^>]*>\s*(\d)コーナー\s*<\/t[dh]>\s*<td[^>]*>([\s\S]*?)<\/td>/g)) corners[m[1]] = text(m[2]);
  /* ラップ：「24.7(11.8)」の括弧内が 200m ごとのラップ */
  const lapBox = (html.match(/ラップタイム[\s\S]*?<\/table>/) || [''])[0];
  const laps = [...lapBox.matchAll(/[\d:.]+\((\d+\.\d)\)/g)].map(m => Number(m[1]));
  const date = dateOf(html);
  const n = entries.filter(e => typeof e.pos === 'number').length;
  return { raceId, date, venue: VENUES[raceId.slice(4, 6)], kai: Number(raceId.slice(6, 8)), day: Number(raceId.slice(8, 10)), r: Number(raceId.slice(10, 12)), ...head, n: n || entries.length, entries, pay: parsePayout(html), corners, laps, pace: null, src: 'yahoo' };
}

/* 馬ページ /keiba/directory/horse/{id}/ ：性齢・生年月日・毛色・調教師・馬主・生産者・産地と、
   血統表（gen1st--sire＝父、gen1st--dam＝母、genSecond--dam の先頭＝母父） */
export function parseHorse(html, horseId) {
  const prof = (html.match(/class="hr-profile"[\s\S]*?<\/section>/) || html.match(/class="hr-profile"[\s\S]{0,6000}/) || [''])[0];
  const item = label => { const m = prof.match(new RegExp(`${label}[^<]*<\\/(?:dt|th|span|p)>\\s*<(?:dd|td|span|p)[^>]*>([\\s\\S]*?)<\\/(?:dd|td|span|p)>`)); return m ? text(m[1]) : null; };
  /* 血統表：gen1st は [父, 母]、genSecond は [父の父, 父の母, 母の父, 母の母] の順 */
  const gen = cls => [...html.matchAll(new RegExp(`<div class="hr-horsePedigree__${cls} hr-horsePedigree__${cls}--(?:sire|dam)"[^>]*>([\\s\\S]*?)<\\/div>`, 'g'))].map(m => text(m[1]) || null);
  const g1 = gen('gen1st'), g2 = gen('genSecond');
  const name = text((html.match(/<title>競馬 - (.*?) データベース/) || [])[1] || '');
  const sa = item('性齢');
  return {
    horseId, name: name || null,
    sex: sa ? (sa.match(/[牡牝セ]/) || [])[0] || null : null, birth: item('生年月日')?.replace(/年|月/g, '-').replace(/日/, '') || null, color: item('毛色'),
    trainer: item('調教師（所属）')?.replace(/\(.*\)/, '').trim() || null, owner: item('馬主'), breeder: item('生産者'), origin: item('産地'),
    sire: g1[0] || null, dam: g1[1] || null, damsire: g2[2] || null,
  };
}

export function parseDenma(html, raceId) {
  const head = parseHead(html);
  const entries = [];
  for (const tr of html.matchAll(/<tr class="hr-table__row"[^>]*>([\s\S]*?)<\/tr>/g)) {
    const c = cells(tr[1]);
    if (c.length < 7 || !/directory\/horse/.test(c[2])) continue;
    const t = c.map(x => text(x.replace(/<p>/g, ' ｜ ')));
    const nm = t[2].split('｜').map(s => s.trim()), jk = t[3].split('｜').map(s => s.trim()), tr2 = t[4].split('｜').map(s => s.trim());
    const ped = t[5].split('｜').map(s => s.trim());
    const pick = re => { for (const s of ped) { const m = s.match(re); if (m) return m[1].trim(); } return null; };
    const bw = (t[6] || '').match(/(\d{3})\(([+\-]?\d+)\)/);
    const od = (t[7] || '').match(/([\d.]+)\s*\(\s*(\d+)\s*\)/);
    entries.push({
      waku: num(t[0]), no: num(t[1]), name: nm[0], horseId: idOf(c[2], 'horse'),
      sexAge: ((nm[1] || '').match(/[牡牝セ]\d+/) || [])[0] || null, color: ((nm[1] || '').match(/\/(\S+)$/) || [])[1] || null,
      jockey: jk[0], jockeyId: idOf(c[3], 'jockey'), kin: num(jk[1]),
      trainer: tr2[0], trainerId: idOf(c[4], 'trainer'), stable: ((tr2[1] || '').match(/栗東|美浦|地方|海外/) || [])[0] || null,
      sire: pick(/^父：\s*(.+)$/), dam: pick(/^母：\s*(.+)$/), damsire: pick(/^[(（]母父：\s*(.+?)[)）]$/),
      bw: bw ? Number(bw[1]) : null, bwDiff: bw ? Number(bw[2]) : null,
      odds: od ? Number(od[1]) : null, pop: od ? Number(od[2]) : null,
    });
  }
  return { raceId, venue: VENUES[raceId.slice(4, 6)], kai: Number(raceId.slice(6, 8)), day: Number(raceId.slice(8, 10)), r: Number(raceId.slice(10, 12)), date: dateOf(html), ...head, n: entries.length, entries, src: 'yahoo' };
}
