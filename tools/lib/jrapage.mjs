/* netkeiba のレースページのパーサ。
     parseCalendar   … 開催日一覧（月ページ）→ ['YYYYMMDD', …]
     parseRaceList   … その日のレース一覧 → [{ raceId, r, venue, name }]
     parseResult     … 結果・払戻 → 1レースぶん（着順・タイム・上がり・通過順・馬体重・払戻・コーナー）
     parseShutubaPast… 馬柱（前5走つき）→ 1レースぶん（出走馬と前5走）
   HTML は UTF-8。壊れてはいないが入れ子が深いので、<tr> と <td> を素直に切って読む。 */
import { text, num, VENUES } from './jra.mjs';

const cells = tr => [...tr.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/g)].map(m => m[1]);
const rows = (html, cls) => [...html.matchAll(new RegExp(`<tr[^>]*class="[^"]*${cls}[^"]*"[^>]*>([\\s\\S]*?)<\\/tr>`, 'g'))].map(m => m[1]);
const idOf = (h, kind) => (h.match(new RegExp(`/${kind}/(?:result/recent/)?(\\w+)`)) || [])[1] || null;

export function parseCalendar(html) {
  return [...new Set([...html.matchAll(/kaisai_date=(\d{8})/g)].map(m => m[1]))].sort();
}

export function parseRaceList(html) {
  const out = new Map();
  for (const m of html.matchAll(/race_id=(\d{12})/g)) {
    const id = m[1];
    if (!out.has(id)) out.set(id, { raceId: id, date: null, venue: VENUES[id.slice(4, 6)] || id.slice(4, 6), r: Number(id.slice(10, 12)) });
  }
  return [...out.values()].sort((a, b) => a.raceId.localeCompare(b.raceId));
}

/* レース見出し（RaceData01/02）。例 "15:20発走 / 芝2600m (右 C) / 天候:晴 / 馬場:良" と "2回 札幌 6日目 サラ系３歳以上 オープン … 14頭" */
function parseHead(html) {
  const d1 = text((html.match(/class="RaceData01"[^>]*>([\s\S]*?)<\/div>/) || [])[1] || '');
  const d2 = text((html.match(/class="RaceData02"[^>]*>([\s\S]*?)<\/div>/) || [])[1] || '');
  const name = text((html.match(/class="RaceName"[^>]*>([\s\S]*?)<\/(?:h1|div)>/) || [])[1] || '');
  const grade = (html.match(/Icon_GradeType\s+Icon_GradeType(\d+)/) || [])[1] || null;
  const m = d1.match(/(芝|ダ|障)\s*(\d{3,4})m/);
  return {
    name: name.replace(/\s+/g, ' ').trim(), gradeIcon: grade ? Number(grade) : null,
    start: (d1.match(/(\d{1,2}:\d{2})発走/) || [])[1] || null,
    surface: m ? m[1] : null, dist: m ? Number(m[2]) : null,
    turn: (d1.match(/\((右|左|直)/) || [])[1] || null,
    weather: (d1.match(/天候:(\S+?)(?:\s|\/|$)/) || [])[1] || null,
    baba: (d1.match(/馬場:(\S+?)(?:\s|\/|$)/) || [])[1] || null,
    cond: d2, n: num((d2.match(/(\d+)頭/) || [])[1]),
  };
}

/* 払戻表。行＝券種。組番はセル内の数字、払戻は「円」、人気は「人気」 */
function parsePayout(html) {
  const out = {};
  const KIND = { '単勝': 'win', '複勝': 'place', '枠連': 'waku', '馬連': 'umaren', 'ワイド': 'wide', '馬単': 'umatan', '3連複': 'sanpuku', '三連複': 'sanpuku', '3連単': 'santan', '三連単': 'santan' };
  const tables = [...html.matchAll(/<table[^>]*class="[^"]*Payout_Detail_Table[^"]*"[^>]*>([\s\S]*?)<\/table>/g)];
  for (const t of tables) {
    for (const tr of t[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
      const c = cells(tr[1]);
      if (c.length < 3) continue;
      const kind = KIND[text(c[0])];
      if (!kind) continue;
      /* 組番：<ul><li> 単位で1組。単勝・複勝は1頭、それ以外は <li> ごとに 1頭ずつで <ul> が1組 */
      const groups = [...c[1].matchAll(/<ul[^>]*>([\s\S]*?)<\/ul>/g)].map(g => [...g[1].matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map(x => num(text(x[1]))).filter(v => v != null));
      let combos = groups.filter(g => g.length);
      if (!combos.length) combos = [text(c[1]).split(/\s+/).map(num).filter(v => v != null)];
      const yen = [...text(c[2]).matchAll(/([\d,]+)円/g)].map(m => num(m[1]));
      const pop = c[3] ? [...text(c[3]).matchAll(/([\d,]+)人気/g)].map(m => num(m[1])) : [];
      /* 単勝・複勝は1頭ずつが1組（複勝は2〜3頭が1つの <ul> にまとまっていることがある） */
      if (kind === 'win' || kind === 'place') combos = combos.flat().map(v => [v]);
      out[kind] = combos.map((g, i) => ({ c: g.join('-'), y: yen[i] ?? yen[0] ?? null, pop: pop[i] ?? null }));
    }
  }
  return out;
}

export function parseResult(html, raceId) {
  const head = parseHead(html);
  const wrap = (html.match(/class="ResultTableWrap"[\s\S]*?<\/table>/) || [''])[0];
  const entries = [];
  for (const tr of wrap.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const c = cells(tr[1]);
    if (c.length < 12) continue;
    const t = c.map(text);
    if (!/^\d+$/.test(t[2])) continue;                         // 見出し行
    const bw = t[14].match(/(\d+)\((.*?)\)/);
    entries.push({
      pos: /^\d+$/.test(t[0]) ? Number(t[0]) : t[0],           // 取消・中止・失格は文字のまま
      waku: num(t[1]), no: num(t[2]), name: t[3], horseId: idOf(c[3], 'horse'),
      sexAge: t[4], kin: num(t[5]), jockey: t[6], jockeyId: idOf(c[6], 'jockey'),
      time: t[7] || null, margin: t[8] || null, pop: num(t[9]), odds: num(t[10]), agari: num(t[11]),
      pass: t[12] || null, stable: (t[13].match(/栗東|美浦|地方|海外/) || [])[0] || null, trainer: t[13].replace(/栗東|美浦|地方|海外/, '').trim(), trainerId: idOf(c[13], 'trainer'),
      bw: bw ? Number(bw[1]) : null, bwDiff: bw ? num(bw[2]) : null,
    });
  }
  /* コーナー通過順位（テキストのまま残す。位置は entries.pass にある） */
  const corners = {};
  for (const m of html.matchAll(/<tr[^>]*>\s*<th[^>]*>([\s\S]*?)<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<\/tr>/g)) {
    const k = text(m[1]).match(/^(\d)\s*コーナー$/);
    if (k) corners[k[1]] = text(m[2]);
  }
  /* ラップ（公開されていれば） */
  /* ラップ：Race_HaronTime の2行目（1行目は累計、2行目が 200m ごと）。ペースは S/M/H */
  const lapM = html.match(/Race_HaronTime[^>]*>[\s\S]*?<\/table>/);
  const lapRows = lapM ? [...lapM[0].matchAll(/<tr class="HaronTime">([\s\S]*?)<\/tr>/g)].map(m => [...m[1].matchAll(/<td[^>]*>([^<]*)<\/td>/g)].map(x => x[1].trim())) : [];
  const laps = lapRows[1] ? lapRows[1].map(Number).filter(v => !isNaN(v)) : [];
  const pace = (html.match(/class="RapPace_Title">[\s\S]*?<span>(\w)<\/span>/) || [])[1] || null;
  const date = `${raceId.slice(0, 4)}-` + ((html.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/) || []).slice(2).map(v => String(v).padStart(2, '0')).join('-') || '');
  return { raceId, date: date.length === 10 ? date : null, venue: VENUES[raceId.slice(4, 6)], kai: Number(raceId.slice(6, 8)), day: Number(raceId.slice(8, 10)), r: Number(raceId.slice(10, 12)), ...head, entries, pay: parsePayout(html), corners, laps, pace };
}

/* 馬柱（前5走つき）。1頭＝<tr class="HorseList">。前走は <td class="Past"> が5つ */
export function parseShutubaPast(html, raceId) {
  const head = parseHead(html);
  const entries = [];
  for (const tr of rows(html, 'HorseList')) {
    const raw = (cls) => (tr.match(new RegExp(`class="${cls}[^"]*"[^>]*>([\\s\\S]*?)<\\/div>`)) || [])[1] || '';
    const g = (cls) => text(raw(cls));
    const wakuCells = [...tr.matchAll(/<td class="Waku[^"]*"[^>]*>([\s\S]*?)<\/td>/g)].map(m => text(m[1]));
    const jockeyTd = (tr.match(/<td class="Jockey"[^>]*>([\s\S]*?)<\/td>/) || [])[1] || '';
    const h6 = g('Horse06');
    const past = [];
    for (const pm of tr.matchAll(/<td class="Past"[^>]*>([\s\S]*?)<\/td>/g)) {
      const p = pm[1];
      if (!/Data01/.test(p)) { past.push(null); continue; }
      const d = k => text((p.match(new RegExp(`class="${k}"[^>]*>([\\s\\S]*?)<\\/div>`)) || [])[1] || '');
      const d1 = d('Data01'), d5 = d('Data05'), d3 = d('Data03'), d6 = d('Data06'), d7 = d('Data07');
      const dm = d1.match(/(\d{4})\.(\d{2})\.(\d{2})\s*(\S+?)\s*(\d+)?$/);
      const sm = d5.match(/(芝|ダ|障)\s*(\d{3,4})\s*([\d:.]+)?\s*(良|稍|重|不)?/);
      const m3 = d3.match(/(\d+)頭\s*(\d+)番\s*(\d+)人\s*(\S+)\s*([\d.]+)/);
      const m6 = d6.match(/([\d\-]+)?\s*\(([\d.]+)\)\s*(\d+)\(([+\-]?\d+)\)/);
      const m7 = d7.match(/^(.*?)\((.+?)\)$/);
      past.push({
        date: dm ? `${dm[1]}-${dm[2]}-${dm[3]}` : null, venue: dm ? dm[4] : null, pos: dm && dm[5] ? Number(dm[5]) : num(d1.match(/(\d+)$/)?.[1]),
        raceId: (p.match(/db\.netkeiba\.com\/race\/(\d{12})/) || [])[1] || null,
        name: text((p.match(/class="Data02"[^>]*>([\s\S]*?)<\/div>/) || [])[1] || '').replace(/\s*(OP|G1|G2|G3|L|1勝|2勝|3勝|新馬|未勝利)\s*$/, '').trim(),
        grade: (p.match(/Icon_GradeType(\d+)/) || [])[1] ? Number((p.match(/Icon_GradeType(\d+)/) || [])[1]) : null,
        surface: sm ? sm[1] : null, dist: sm ? Number(sm[2]) : null, time: sm ? sm[3] || null : null, baba: sm ? sm[4] || null : null,
        n: m3 ? Number(m3[1]) : null, no: m3 ? Number(m3[2]) : null, pop: m3 ? Number(m3[3]) : null, jockey: m3 ? m3[4] : null, kin: m3 ? Number(m3[5]) : null,
        pass: m6 ? m6[1] || null : null, agari: m6 ? Number(m6[2]) : null, bw: m6 ? Number(m6[3]) : null, bwDiff: m6 ? Number(m6[4]) : null,
        winner: m7 ? m7[1].trim() : d7 || null, margin: m7 ? m7[2] : null,
      });
    }
    const horseId = idOf(raw('Horse02'), 'horse');
    if (!horseId) continue;                                     // 枠順確定前に並ぶ除外対象馬（リンクが無い）は載せない
    entries.push({
      waku: num(wakuCells[0]) || null, no: num(wakuCells[1]) || null,
      name: g('Horse02'), horseId, sire: g('Horse01'), dam: g('Horse03'), damsire: g('Horse04').replace(/[()]/g, ''),
      stable: (g('Horse05').match(/栗東|美浦|地方|海外/) || [])[0] || null, trainer: g('Horse05').replace(/(栗東|美浦|地方|海外)・?/, '').trim(), trainerId: idOf(raw('Horse05'), 'trainer'),
      style: (h6.match(/逃|先|差|追/) || [])[0] || null, rest: (h6.match(/(中\d+週|連闘|\d+ヶ月半?|初出走)/) || [])[1] || null,
      sexAge: (text(jockeyTd).match(/[牡牝セ]\d+/) || [])[0] || null, color: (text(jockeyTd).match(/[牡牝セ]\d+(\S+?)\s/) || [])[1] || null,
      jockey: text((jockeyTd.match(/<a[^>]*>([\s\S]*?)<\/a>/) || [])[1] || ''), jockeyId: idOf(jockeyTd, 'jockey'),
      kin: num((text(jockeyTd).match(/(\d{2}\.\d)/) || [])[1]),
      past,
    });
  }
  return { raceId, venue: VENUES[raceId.slice(4, 6)], kai: Number(raceId.slice(6, 8)), day: Number(raceId.slice(8, 10)), r: Number(raceId.slice(10, 12)), ...head, entries };
}
