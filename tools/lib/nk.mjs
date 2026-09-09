/* nankankeiba.com からの取得共通処理（Node 標準のみ・依存ゼロ）
   - Shift_JIS デコード
   - ローカルキャッシュ（data/cache/。既に取ってあるページは再取得しない）
   - レート制限（既定 600ms 間隔）
   ※ 取得は解析目的の低頻度アクセスに限る。並列取得はしない。 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const CACHE = path.join(ROOT, 'data', 'cache');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
const DEC = new TextDecoder('shift_jis');
let last = 0;
const WAIT = Number(process.env.NK_WAIT || 600);

const sleep = ms => new Promise(r => setTimeout(r, ms));

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
      const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'ja' }, redirect: 'follow' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      body = DEC.decode(new Uint8Array(await res.arrayBuffer()));
      break;
    } catch (e) {
      if (a === tries - 1) throw e;
      await sleep(1500 * (a + 1));
    }
  }
  fs.writeFileSync(f, body);
  return body;
}

/* HTML のテーブルを二次元配列にする（このサイトは thead/tbody が素直） */
export function tables(html) {
  const out = [];
  for (const m of html.matchAll(/<table[^>]*>([\s\S]*?)<\/table>/g)) {
    const rows = [];
    for (const r of m[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
      const cells = [...r[1].matchAll(/<(t[dh])[^>]*>([\s\S]*?)<\/\1>/g)].map(c => text(c[2]));
      if (cells.length) rows.push(cells);
    }
    if (rows.length) out.push(rows);
  }
  return out;
}

export function text(h) {
  return h.replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#?\w+;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

export const num = s => { const v = String(s ?? '').replace(/[,%\s円]/g, ''); return v === '' || isNaN(v) ? 0 : Number(v); };

export function writeJSON(rel, obj) {
  const p = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 1));
  console.error(`  -> ${rel} (${(fs.statSync(p).size / 1024).toFixed(0)} KB)`);
}
export function readJSON(rel) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}
