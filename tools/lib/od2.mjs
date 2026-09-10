/* 公式ダウンロードデータ（K=競走成績 / B=番組表）のパーサ。
   固定長だが「Shift_JIS のバイト位置」で桁が決まる。デコード後の JS 文字列を
   そのまま slice すると漢字1文字=1のためズレるので、必ず bslice() を使う。
   1ファイルにその日開催した全場が `24KBGN 〜 24KEND` の形で並ぶ。 */

const bw = c => { const o = c.codePointAt(0); return (o < 0x80 || (o >= 0xFF61 && o <= 0xFF9F)) ? 1 : 2; };
/* Shift_JIS のバイト位置で切り出す（全角にまたがったら空白扱い） */
export function bslice(s, a, b) {
  let p = 0, out = '';
  for (const c of s) {
    const w = bw(c), e = p + w;
    if (p >= a && e <= b) out += c;
    else if (e > a && p < b) out += ' '.repeat(w);   // 境界にまたがる全角
    p = e;
    if (p >= b) break;
  }
  return out;
}
const cut = (s, a, b) => bslice(s, a, b).trim();
const Z2H = s => s.replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
  .replace(/[Ａ-Ｚａ-ｚ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
  .replace(/：/g, ':').replace(/[　\s]+/g, ' ').trim();
const nm = s => { const v = String(s).trim(); return v === '' || isNaN(v) ? null : Number(v); };
const sq = s => s.replace(/[　\s]+/g, '');           // 選手名の中の全角空白を潰す

/* レースタイム 1.52.5（1分52秒5）を秒に。不完走は「.  .」なので null */
function timeOf(raw) {
  const m = raw.replace(/\s/g, '').match(/^(\d)\.(\d\d)\.(\d)$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) + Number(m[3]) / 10 : null;
}

/* 場ごとのブロックに割る。kind: 'K' | 'B' */
export function splitVenues(txt, kind) {
  const out = [];
  const re = new RegExp(`^(\\d\\d)${kind}BGN$`, 'm');
  const lines = txt.split(/\r?\n/);
  let jcd = null, buf = null;
  for (const l of lines) {
    const b = l.match(new RegExp(`^(\\d\\d)${kind}BGN\\s*$`));
    if (b) { jcd = b[1]; buf = []; continue; }
    if (/^\d\dK?B?END\s*$/.test(l) || new RegExp(`^\\d\\d${kind}END\\s*$`).test(l)) {
      if (jcd && buf) out.push({ jcd, lines: buf });
      jcd = null; buf = null; continue;
    }
    if (buf) buf.push(l);
  }
  void re;
  return out;
}

/* ============ K: 競走成績 ============ */
/* 着順欄は 01〜06 のほか F(フライング) L(出遅れ) S0/S1/S2(失格) K0/K1(欠場)。
   F は1文字なので艇番までの空白が3つになる。\s{1,2} だと F 艇の行を丸ごと落とす。 */
const KLINE = /^\s{2}(\S{1,2})\s+([1-6])\s+(\d{4})/;
/* ST は 0.27／F0.01（フライング）／L0.15（出遅れ）／K .（欠場）の4通り */
function stOf(raw) {
  const s = raw.trim();
  const m = s.match(/^([FL])?(\d\.\d\d)$/);
  if (!m) return { st: null, f: /^F/.test(s) || null, l: /^L/.test(s) || null };
  return { st: (m[1] === 'F' ? -1 : 1) * Number(m[2]), f: m[1] === 'F' || null, l: m[1] === 'L' || null };
}

export function parseK(txt, ymd) {
  const days = [];
  for (const { jcd, lines } of splitVenues(txt, 'K')) {
    const races = [];
    let cur = null, kimari = '';
    for (const raw of lines) {
      const l = raw.replace(/\s+$/, '');
      const h = l.match(/^\s*(\d{1,2})R\s+(.*?)\s{2,}([HR])(\d{3,4})m\s*(.*)$/);
      if (h) {
        const tail = h[5];
        const w = tail.match(/^(\S+)?\s*風\s*(\S+)?\s*(-?\d+)m\s*波\s*(-?\d+)cm/);
        cur = {
          r: Number(h[1]), cls: sq(h[2]), lap: h[3], dist: Number(h[4]),
          weather: w ? sq(w[1] || '') : '', windDir: w ? sq(w[2] || '') : '',
          wind: w ? Number(w[3]) : null, wave: w ? Number(w[4]) : null,
          stable: /安定板/.test(tail) || null,
          kimari: '', entries: [], pay: {},
        };
        races.push(cur);
        continue;
      }
      if (/ﾚｰｽﾀｲﾑ/.test(l)) { kimari = sq(l.slice(l.indexOf('ﾚｰｽﾀｲﾑ') + 6)); if (cur) cur.kimari = kimari; continue; }
      const m = l.match(KLINE);
      if (m && cur) {
        cur.entries.push({
          pos: cut(l, 2, 4), lane: Number(cut(l, 6, 7)), toban: cut(l, 8, 12),
          name: sq(cut(l, 13, 29)),
          motor: nm(cut(l, 29, 33)), boat: nm(cut(l, 33, 37)),
          ex: nm(cut(l, 37, 43)),            // 展示タイム
          course: nm(cut(l, 43, 47)),        // 進入コース
          ...stOf(cut(l, 47, 55)),           // st（Fは負値）/ f / l
          time: timeOf(cut(l, 55, 66)),      // 1.52.5 → 112.5 秒。不完走は null
        });
        continue;
      }
      if (!cur) continue;
      const p = l.match(/^\s{4,}(単勝|複勝|２連単|２連複|拡連複|３連単|３連複)?\s+([\d\-]+)\s+(\d+)(?:\s+人気\s+(\d+))?/);
      if (p) {
        const kind = p[1] ? { 単勝: 'win', 複勝: 'place', '２連単': 'ex2', '２連複': 'qn', 拡連複: 'wide', '３連単': 'ex3', '３連複': 'tri' }[p[1]] : null;
        const k = kind || (cur._lastPay || null);
        if (k) {
          cur._lastPay = k;
          (cur.pay[k] ||= []).push({ c: p[2], y: Number(p[3]), pop: p[4] ? Number(p[4]) : null });
        }
        /* 複勝は1行に2口ぶん並ぶ */
        const p2 = l.match(/(\d+)\s+(\d+)\s*$/);
        if (k === 'place' && p2 && p2[1] !== p[2]) cur.pay.place.push({ c: p2[1], y: Number(p2[2]), pop: null });
      }
    }
    for (const r of races) delete r._lastPay;
    if (races.length) days.push({ date: ymd, jcd, races: races.filter(r => r.entries.length) });
  }
  return days;
}

/* ============ B: 番組表 ============ */
const BLINE = /^([1-6]) (\d{4})/;

export function parseB(txt, ymd) {
  const days = [];
  for (const { jcd, lines } of splitVenues(txt, 'B')) {
    const races = [];
    let cur = null, title = '', day = '';
    for (const raw of lines) {
      const l = raw.replace(/\s+$/, '');
      if (!title) { const t = l.match(/^ボートレース\S+\s+.*?\s{2,}(\S.*?)\s{2,}(第.*日)/); if (t) { title = sq(t[1]); day = sq(t[2]); } }
      const h = Z2H(l).match(/^(\d{1,2})R\s+(.*?)\s+H(\d{3,4})m\s*(?:電話投票締切予定\s*(\d{1,2}:\d{2}))?/);
      if (h && /Ｒ|R/.test(l)) {
        cur = { r: Number(h[1]), cls: sq(h[2]), dist: Number(h[3]), close: h[4] || null, boats: [] };
        races.push(cur);
        continue;
      }
      const m = l.match(BLINE);
      if (m && cur) {
        const len = [...l].reduce((a, c) => a + bw(c), 0);
        cur.boats.push({
          lane: Number(m[1]), toban: m[2], name: sq(cut(l, 6, 14)),
          age: nm(cut(l, 14, 16)), branch: sq(cut(l, 16, 20)),
          weight: nm(cut(l, 20, 22)), grade: cut(l, 22, 24),
          natWin: nm(cut(l, 24, 29)), nat2: nm(cut(l, 29, 35)),
          locWin: nm(cut(l, 35, 40)), loc2: nm(cut(l, 40, 46)),
          motor: nm(cut(l, 46, 49)), motor2: nm(cut(l, 49, 55)),
          boat: nm(cut(l, 55, 58)), boat2: nm(cut(l, 58, 64)),
          setu: cut(l, 64, len - 2),          // 今節成績（日ごと1文字）
          hayami: nm(cut(l, len - 2, len)),
        });
      }
    }
    if (races.length) days.push({ date: ymd, jcd, title, day, races: races.filter(r => r.boats.length) });
  }
  return days;
}
