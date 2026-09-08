/* 出馬表 /uma_shosai/{raceId}.do のパーサ
   基本タブ … 枠/馬番/馬ID/馬名/性齢/負担/騎手/調教師/馬主/生産牧場
   詳細タブ … 前5走（着順・場・日付・馬場・距離・クラス・頭数・人気・騎手・上がり3F・コーナー通過順）
   ※このサイトの出馬表は </tr> が欠けた壊れた HTML を返すので、行は <tr で分割して読む */
import { text, num } from './nk.mjs';

const JO = { '18': '浦和', '19': '船橋', '20': '大井', '21': '川崎' };

const cells = tr => [...tr.matchAll(/<td[^>]*>([\s\S]*?)(?=<\/td>|<td[^>]*>|<tr|<\/tbody)/g)].map(m => m[1]);
const seg = (html, tab) => {
  const key = `data-tab2-content="${tab}"`;
  const i = html.indexOf(key);
  if (i < 0) return '';
  const j = html.indexOf('data-tab2-content="', i + key.length);
  const k = html.indexOf('</main>', i);
  const end = Math.min(j < 0 ? Infinity : j, k < 0 ? Infinity : k);
  return html.slice(i, end === Infinity ? html.length : end);
};
const rowsOf = s => {
  const b = s.indexOf('<tbody');
  if (b < 0) return [];
  return s.slice(b).split(/<tr[^>]*>/).slice(1);
};

export function parseCard(html, raceId) {
  const date = `${raceId.slice(0, 4)}-${raceId.slice(4, 6)}-${raceId.slice(6, 8)}`;
  const track = JO[raceId.slice(8, 10)] || raceId.slice(8, 10);
  const R = Number(raceId.slice(14, 16));
  const p0 = html.indexOf('発走時刻');
  const hdr = text(html.slice(Math.max(0, p0 - 2000), p0 + 2500));
  const dist = num((/([\d,]{3,6})\s*m/.exec(hdr) || [0, 0])[1]);
  const n = num((/（(\d+)頭）/.exec(hdr) || [0, 0])[1]);
  const cls = ((/発走時刻\s*[\d:]+\s*(.+?)\s*詳細/.exec(hdr) || [0, ''])[1] || '').trim();
  const time = ((/発走時刻\s*(\d{1,2}:\d{2})/.exec(hdr) || [0, ''])[1] || '');
  // 番組ポイント（1着ぶん）。南関の格付ポイント制度でクラスの上下を決める
  const pt1 = num((/番組ポイント[\s\S]{0,40}?1着\s*([\d,]+)\s*P/.exec(hdr) || [0, 0])[1]);
  const prize1 = num((/1着\s*([\d,]+)円/.exec(hdr) || [0, 0])[1]);
  const night = /ナイター|薄暮/.test(hdr);

  /* 枠番は rowspan で省かれる行があるため、/uma_info/ を含むセルを起点に相対位置で読む */
  const horses = [];
  let gate = 0, seq = 0;
  for (const tr of rowsOf(seg(html, 'tab1'))) {
    const c = cells(tr);
    const ui = c.findIndex(x => /\/uma_info\/\d+\.do/.test(x));
    if (ui < 1) continue;
    const uma = /\/uma_info\/(\d+)\.do"[^>]*>([\s\S]*?)<\/a>/.exec(c[ui]);
    if (!uma) continue;
    if (ui >= 2 && /^\d+$/.test(text(c[ui - 2]))) gate = num(c[ui - 2]);
    const noTxt = text(c[ui - 1]);
    const no = /^\d+$/.test(noTxt) ? Number(noTxt) : ++seq;
    seq = no;
    const rest = c.slice(ui).join(' ');
    /* 騎手・調教師は所定のセル内だけを見る。行全体から拾うと </a> の対応がずれて
       次のセルの文字列まで名前に混ざる（<br> の有無に個体差があるため）。 */
    const pick = (cell, kind) => {
      const m = new RegExp(`/${kind}_info/(\\d+)\\.do"[^>]*>([\\s\\S]*?)</a>([\\s\\S]*)`).exec(cell || '');
      if (!m) return null;
      const b2 = /\(([^)]*)\)/.exec(m[3]);
      return [null, m[1], m[2], b2 ? b2[1].trim() : ''];
    };
    const kis = pick(c[ui + 5], 'kis') || pick(rest, 'kis');
    const cho = pick(c[ui + 7], 'cho') || pick(rest, 'cho');
    const ped = (c[ui + 6] || '').split(/<br\s*\/?>/).map(text).filter(Boolean);   // 父 / 母
    const own = /<p title="([^"]*)"[\s\S]{0,300}?<p title="([^"]*)"/.exec(c[ui + 8] || '');
    horses.push({
      gate, no,
      horseId: uma[1], name: text(uma[2]),
      sexAge: (text(c[ui + 1]) || '').split(/\s+/)[0],
      kg: num(text(c[ui + 4]).replace(/[^\d.]/g, '')),
      // 馬体重（発表前は空）。増減は ＋/− の全角があるので正規化する
      bw: num((/(\d{3})/.exec(text(c[ui + 3])) || [])[1]),
      bwDiff: (() => { const m = /([＋+\-−▲])\s*(\d+)/.exec(text(c[ui + 3])); return m ? (/[＋+]/.test(m[1]) ? 1 : -1) * Number(m[2]) : null; })(),
      jockeyId: kis ? kis[1] : '', jockey: text(kis ? kis[2] : ''), jockeyBase: kis ? kis[3].trim() : '',
      trainerId: cho ? cho[1] : '', trainer: text(cho ? cho[2] : ''), trainerBase: cho ? cho[3].trim() : '',
      owner: own ? own[1].trim() : '', farm: own ? own[2].trim() : '',
      sire: ped[0] || '', dam: ped[1] || '', damSire: '',
      scratch: /取消|除外/.test(noTxt),
      past: [],
    });
  }

  /* 詳細タブ：着順で始まるセルを前走→5走前として拾う */
  const byId = new Map(horses.map(h => [h.horseId, h]));
  for (const tr of rowsOf(seg(html, 'tab2'))) {
    const c = cells(tr);
    const ui = c.findIndex(x => /\/uma_info\/\d+\.do/.test(x));
    if (ui < 0) continue;
    const id = /\/uma_info\/(\d+)\.do/.exec(c[ui])[1];
    const h = byId.get(id);
    if (!h || h.past.length) continue;
    if (!h.damSire) { const m = /（([^）]{2,40})）/.exec(text(c[ui] || '')); if (m) h.damSire = m[1].trim(); }
    for (const cell of c) {
      if (h.past.length >= 5) break;
      const pp = parsePast(cell);
      if (pp) h.past.push(pp);
    }
  }

  return { raceId, date, track, R, dist, n, cls, time, night, pt1, prize1, horses };
}

const TRACK_RE = /(浦和|船橋|大井|川崎|大井|門別|盛岡|水沢|金沢|笠松|名古屋|園田|姫路|高知|佐賀|中山|東京|阪神|京都|中京|新潟|福島|小倉|札幌|函館)/;

export function parsePast(cellHtml) {
  const t = text(cellHtml.replace(/<\/?(br|p|div|span)[^>]*>/g, '|'));
  const parts = cellHtml.replace(/<script[\s\S]*?<\/script>/g, '').split(/<\/?(?:br|p|div|span|a|i|em|strong)[^>]*>/).map(x => text(x)).filter(Boolean);
  const s = parts.join('|');
  const m = /^(\d+)\|?着\|(\S+?)(\d{2})\.(\d{1,2})\.(\d{1,2})\|(良|稍|重|不)([^|]*?)(\d{3,4})\s*\|([^|]*)\|(\d+)頭\s*(\d+)番\s*(\d+)人気\s*\|([^|]*)\|/.exec(s + '|');
  if (!m) {
    const alt = /(\d+)\|着\|(\S+?)(\d{2})\.(\d{1,2})\.(\d{1,2})/.exec(s);
    if (!alt) return null;
  }
  if (!m) return null;
  const tail = s.slice(m[0].length - 1).split('|').filter(Boolean);
  const last3 = /3F\s*([\d.]+)\s*\((\d+)\)/.exec(s);
  const rid = /\/result\/(\d{16})\.do/.exec(cellHtml);
  const wt = /(\d{3})kg/.exec(s);
  const corners = tail.filter(x => /^\d{1,2}$/.test(x)).map(Number).slice(-4);
  const jk = (m[13] || '').replace(/^[▲△☆★◇◎]\s*/, '').replace(/\s*[\d.]+\s*$/, '').trim();
  return {
    pos: Number(m[1]), track: m[2], date: `20${m[3]}-${String(m[4]).padStart(2, '0')}-${String(m[5]).padStart(2, '0')}`,
    baba: { '良': '良', '稍': '稍重', '重': '重', '不': '不良' }[m[6]], dist: Number(m[8]), race: m[9].trim(),
    field: Number(m[10]), no: Number(m[11]), pop: Number(m[12]), jockey: jk,
    last3f: last3 ? Number(last3[1]) : null, last3fRank: last3 ? Number(last3[2]) : null,
    kg: wt ? Number(wt[1]) : null,
    rid: rid ? rid[1] : null,
    corners,
  };
}
