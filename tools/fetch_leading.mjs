/* 南関東リーディング（騎手 / 調教師 / 騎手×調教師）を年別に取得して
   data/nankan/leading.raw.json に落とす。
   URL: /leading_{kis|cho|kis_cho}/{場2}{距離4}{馬場2}{年4}{並び2}{種別1}.do?PAGE=n
   出典: nankankeiba.com リーディング情報（南関東4場の出走レースが対象）        */
import { get, text, num, writeJSON } from './lib/nk.mjs';

const BASE = 'https://www.nankankeiba.com';
const TRACKS = { '18': '浦和', '19': '船橋', '20': '大井', '21': '川崎' };
// 過去3年（暦年）＋今年＋直近1年/3ヶ月。0003=直近1年, 0004=直近3ヶ月
const PERIODS = process.env.NK_PERIODS ? process.env.NK_PERIODS.split(',') : ['2023', '2024', '2025', '2026', '0003', '0004'];
const KINDS = {
  kis:     { path: 'leading_kis',     t: '1' },
  cho:     { path: 'leading_cho',     t: '2' },
  kis_cho: { path: 'leading_kis_cho', t: '5' },
  sire:    { path: 'leading_sire',    t: '3' },   // 種牡馬
  bms:     { path: 'leading_bms',     t: '4' },   // 母の父
};
// 種牡馬の距離別は南関東（00）まとめで取る。距離ごとに場を分けると標本が薄くなるため
const SIRE_DIST = (process.env.NK_SIRE_DIST || '1200,1400,1500,1600,1800,2000').split(',').filter(Boolean);

/* 順位テーブルを取り出す。セル内の /kis_info/ /cho_info/ から ID も拾う */
function leadingRows(html) {
  for (const m of html.matchAll(/<table[^>]*>([\s\S]*?)<\/table>/g)) {
    const trs = [...m[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(r => r[1]);
    if (!trs.length) continue;
    const head = [...trs[0].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map(c => text(c[1]));
    if (head[0] !== '順位') continue;
    const rows = [];
    for (const tr of trs.slice(1)) {
      const cells = [...tr.matchAll(/<(t[dh])[^>]*>([\s\S]*?)<\/\1>/g)].map(c => c[2]);
      if (cells.length < head.length) continue;
      const ids = [];
      for (const c of cells) { const h = /\/(kis|cho)_info\/(\d+)\.do/.exec(c); if (h) ids.push(h[1] + h[2]); }
      rows.push({ v: cells.map(text), ids });
    }
    if (rows.length) return { head, rows };
  }
  return null;
}

async function fetchKind(kind, jo, period, kyori = '0000') {
  const { path: p, t } = KINDS[kind];
  const base = `${BASE}/${p}/${jo}${kyori}` + '00' + period + '01' + t + '.do';
  const out = [];
  let page = 1, total = null;
  while (page <= 60) {
    const html = await get(base + (page > 1 ? `?PAGE=${page}` : ''), { ttlDays: period === '0004' || period === '0003' || period === '2026' ? 3 : 180 });
    if (total === null) { const m = /該当件数\s*<strong>([\d,]+)<\/strong>/.exec(html) || /該当件数[^\d]*([\d,]+)/.exec(html); total = m ? num(m[1]) : 0; }
    const tb = leadingRows(html);
    if (!tb || !tb.rows.length) break;
    for (const r of tb.rows) out.push(r);
    if (out.length >= total) break;
    page++;
  }
  return { total, rows: out };
}

const parse = (kind, r) => {
  const v = r.v;
  if (kind === 'kis_cho') return { jockey: v[1], jockeyBase: v[2], trainer: v[3], trainerBase: v[4], runs: num(v[5]), w: num(v[6]), p2: num(v[7]), p3: num(v[8]), out: num(v[9]), prize: num(v[12]), ids: r.ids };
  if (kind === 'kis')     return { jockey: v[1], jockeyBase: v[2], runs: num(v[3]), w: num(v[4]), p2: num(v[5]), p3: num(v[6]), out: num(v[7]), prize: num(v[10]), ids: r.ids };
  if (kind === 'cho')     return { trainer: v[1], trainerBase: v[2], runs: num(v[3]), w: num(v[4]), p2: num(v[5]), p3: num(v[6]), out: num(v[7]), prize: num(v[10]), ids: r.ids };
  // 種牡馬・母の父は 順位/名前/出走回数/出走頭数/勝馬頭数/勝利数/勝率/勝馬率/収得賞金
  return { sire: v[1], runs: num(v[2]), horses: num(v[3]), wHorses: num(v[4]), w: num(v[5]), prize: num(v[8]) };
};

const db = { fetchedAt: new Date().toISOString(), source: 'nankankeiba.com リーディング情報', periods: PERIODS, tracks: TRACKS, data: {} };
for (const period of PERIODS) {
  for (const [jo, name] of Object.entries(TRACKS)) {
    for (const kind of Object.keys(KINDS)) {
      const { total, rows } = await fetchKind(kind, jo, period);
      db.data[`${period}|${jo}|${kind}`] = rows.map(r => parse(kind, r));
      console.error(`${period} ${name} ${kind}: ${rows.length}/${total}`);
    }
  }
}
/* 種牡馬の距離別（南関東まとめ・暦年のみ） */
for (const period of PERIODS.filter(p => /^\d{4}$/.test(p))) {
  for (const d of SIRE_DIST) {
    const kyori = String(d).padStart(4, '0');
    const { total, rows } = await fetchKind('sire', '00', period, kyori);
    db.data[`${period}|00|sire${kyori}`] = rows.map(r => parse('sire', r));
    console.error(`${period} 南関 sire ${d}m: ${rows.length}/${total}`);
  }
}
db.sireDist = SIRE_DIST;
writeJSON('data/nankan/leading.raw.json', db);
