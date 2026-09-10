/* ボートレースの取得共通処理（Node 標準のみ・依存ゼロ）
   - 公式ダウンロード（od2 の LZH）: bsdtar で展開 → Shift_JIS デコード
   - 公式Web（boatrace.jp）: UTF-8。レート制限とローカルキャッシュ
   ※ 叩きすぎると「システムエラー」を返すようになる。並列取得はしない。 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const CACHE = path.join(ROOT, 'data', 'cache', 'boat');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
const SJIS = new TextDecoder('shift_jis');
const WAIT = Number(process.env.BT_WAIT || 900);
let last = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* 全24場。コードは公式の jcd と同じ */
export const VENUES = [
  { jcd: '01', name: '桐生', pref: '群馬', area: '関東' },
  { jcd: '02', name: '戸田', pref: '埼玉', area: '関東' },
  { jcd: '03', name: '江戸川', pref: '東京', area: '関東' },
  { jcd: '04', name: '平和島', pref: '東京', area: '関東' },
  { jcd: '05', name: '多摩川', pref: '東京', area: '関東' },
  { jcd: '06', name: '浜名湖', pref: '静岡', area: '東海' },
  { jcd: '07', name: '蒲郡', pref: '愛知', area: '東海' },
  { jcd: '08', name: '常滑', pref: '愛知', area: '東海' },
  { jcd: '09', name: '津', pref: '三重', area: '東海' },
  { jcd: '10', name: '三国', pref: '福井', area: '近畿' },
  { jcd: '11', name: 'びわこ', pref: '滋賀', area: '近畿' },
  { jcd: '12', name: '住之江', pref: '大阪', area: '近畿' },
  { jcd: '13', name: '尼崎', pref: '兵庫', area: '近畿' },
  { jcd: '14', name: '鳴門', pref: '徳島', area: '四国' },
  { jcd: '15', name: '丸亀', pref: '香川', area: '四国' },
  { jcd: '16', name: '児島', pref: '岡山', area: '中国' },
  { jcd: '17', name: '宮島', pref: '広島', area: '中国' },
  { jcd: '18', name: '徳山', pref: '山口', area: '中国' },
  { jcd: '19', name: '下関', pref: '山口', area: '中国' },
  { jcd: '20', name: '若松', pref: '福岡', area: '九州' },
  { jcd: '21', name: '芦屋', pref: '福岡', area: '九州' },
  { jcd: '22', name: '福岡', pref: '福岡', area: '九州' },
  { jcd: '23', name: '唐津', pref: '佐賀', area: '九州' },
  { jcd: '24', name: '大村', pref: '長崎', area: '九州' },
];
export const VNAME = Object.fromEntries(VENUES.map(v => [v.jcd, v.name]));

/* ---- 公式ダウンロードデータ（LZH） ----
   K=競走成績 B=番組表。1ファイルにその日開催した全場が入る。
   展開は macOS 標準の bsdtar。依存を足さないためこれを使う。 */
export async function getOd2(kind, ymd) {          // kind: 'K' | 'B', ymd: 'YYYYMMDD'
  const yy = ymd.slice(2, 8);                       // YYMMDD
  const dir = path.join(CACHE, 'od2');
  fs.mkdirSync(dir, { recursive: true });
  const txt = path.join(dir, kind + yy + '.txt');
  if (fs.existsSync(txt)) {
    const s = fs.readFileSync(txt, 'utf8');
    return s === '' ? null : s;                     // 空＝開催なしとして覚えてある
  }
  const url = `https://www1.mbrace.or.jp/od2/${kind}/${ymd.slice(0, 6)}/${kind.toLowerCase()}${yy}.lzh`;
  const gap = Date.now() - last;
  if (gap < WAIT) await sleep(WAIT - gap);
  last = Date.now();
  let buf = null;
  for (let a = 0; a < 3; a++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (res.status === 404) { fs.writeFileSync(txt, ''); return null; }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      buf = Buffer.from(await res.arrayBuffer());
      break;
    } catch (e) {
      if (a === 2) throw e;
      await sleep(1500 * (a + 1));
    }
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'od2-'));
  try {
    fs.writeFileSync(path.join(tmp, 'a.lzh'), buf);
    execFileSync('bsdtar', ['-xf', 'a.lzh'], { cwd: tmp, stdio: 'pipe' });
    const f = fs.readdirSync(tmp).find(x => /\.txt$/i.test(x));
    if (!f) throw new Error('展開できたが TXT が無い: ' + url);
    const s = SJIS.decode(fs.readFileSync(path.join(tmp, f)));
    fs.writeFileSync(txt, s);
    return s;
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

/* ---- 公式Web（UTF-8） ---- */
export async function get(url, { ttlDays = 30, tries = 3 } = {}) {
  fs.mkdirSync(CACHE, { recursive: true });
  const key = crypto.createHash('sha1').update(url).digest('hex').slice(0, 24);
  const f = path.join(CACHE, key + '.html');
  if (fs.existsSync(f)) {
    const age = (Date.now() - fs.statSync(f).mtimeMs) / 86400000;
    if (age < ttlDays) return fs.readFileSync(f, 'utf8');
  }
  const gap = Date.now() - last;
  if (gap < WAIT) await sleep(WAIT - gap);
  last = Date.now();
  let body = null;
  for (let a = 0; a < tries; a++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'ja', Referer: 'https://www.boatrace.jp/owpc/pc/race/index' } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      body = await res.text();
      /* 叩きすぎ・未開催は 200 で「システムエラー」ページ（約14KB）が返る */
      if (body.includes('システムエラー')) throw new Error('システムエラー（未開催か規制）');
      break;
    } catch (e) {
      if (a === tries - 1) throw e;
      await sleep(2500 * (a + 1));
    }
  }
  fs.writeFileSync(f, body);
  return body;
}

/* 開催前に取った空ページを長く抱えないための TTL（南関側と同じ考え方） */
export const freshTtl = (ymd, longDays = 365) => {
  const d = `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
  const age = (Date.now() - new Date(d + 'T00:00:00').getTime()) / 86400000;
  return age < 4 ? 0.02 : longDays;
};

export function text(h) {
  return h.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#?\w+;/g, ' ').replace(/\s+/g, ' ').trim();
}
export const num = s => { const v = String(s ?? '').replace(/[,%\s円]/g, ''); return v === '' || isNaN(v) ? 0 : Number(v); };
export const ymdOf = d => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
export function* dateRange(from, to) {           // 'YYYYMMDD'
  const d = new Date(`${from.slice(0, 4)}-${from.slice(4, 6)}-${from.slice(6, 8)}T00:00:00`);
  const e = new Date(`${to.slice(0, 4)}-${to.slice(4, 6)}-${to.slice(6, 8)}T00:00:00`);
  for (; d <= e; d.setDate(d.getDate() + 1)) yield ymdOf(d);
}

export function writeJSON(rel, obj) {
  const p = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 1));
  console.error(`  -> ${rel} (${(fs.statSync(p).size / 1024).toFixed(0)} KB)`);
}
export function readJSON(rel) { return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8')); }
