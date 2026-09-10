/* 全24場の「ボートレース場データ」を取り込む。
   公式が集計したコース別入着率・決まり手・枠番別コース取得率・季節別を
   そのまま特徴量に使えるので、場ごとの水面の癖を自前推定しなくてよい。
     https://www.boatrace.jp/owpc/pc/data/stadium?jcd=NN
   出力: data/boat/stadium.json（コミット対象・約60KB） */
import { VENUES, get, text, num, writeJSON } from './lib/bt.mjs';

const TTL = Number(process.env.BT_STADIUM_TTL || 20);   // 3ヶ月集計なので月1で十分

/* <table> を二次元配列に */
function tables(html) {
  const out = [];
  for (const m of html.matchAll(/<table[\s\S]*?<\/table>/g)) {
    const rows = [];
    for (const r of m[0].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
      const cells = [...r[1].matchAll(/<(t[dh])[^>]*>([\s\S]*?)<\/\1>/g)].map(c => text(c[2]));
      if (cells.length) rows.push(cells);
    }
    out.push({ rows, at: m.index });
  }
  return out;
}
const grid = (rows, from, cols) => rows.slice(-6).map(r => r.slice(from, from + cols).map(num));

const out = {};
for (const v of VENUES) {
  const html = await get(`https://www.boatrace.jp/owpc/pc/data/stadium?jcd=${v.jcd}`, { ttlDays: TTL });
  const tb = tables(html);
  if (tb.length < 6) { console.error(`  ! ${v.name} テーブルが ${tb.length} 個しかない`); continue; }

  /* 0番目は「コース別入着率」と「コース別決まり手」が横に並んだ1枚 */
  const t0 = tb[0].rows;
  const rank = grid(t0, 1, 6);                       // 1〜6着の率
  const kimari = grid(t0, 7, 6);                     // 逃げ/捲り/差し/捲り差し/抜き/恵まれ
  const take = grid(tb[1].rows, 1, 6);               // 枠番別のコース取得率

  /* 季節別。見出し（春季/夏季/秋季/冬季）は表の 100〜200 文字手前に出るので、
     窓を固定せず「直前にある見出し」で対応づける */
  const labs = [...html.matchAll(/<span class="title7_mainLabel">(春季|夏季|秋季|冬季)<\/span>/g)].map(m => [m.index, m[1]]);
  const seasons = {};
  for (const t of tb.slice(2, 6)) {
    const lab = labs.filter(([i]) => i < t.at).pop();
    const per = (html.slice(t.at).match(/集計期間：([\d/]+)～([\d/]+)/) || []);
    if (lab) seasons[lab[1]] = { rank: grid(t.rows, 1, 6), from: per[1] || null, to: per[2] || null };
  }

  const memo = {};
  for (const k of ['所在地', 'モーター', '水質', '干満差', 'レコード']) {
    const m = html.match(new RegExp(k + '[\\s\\S]{0,400}?</dt>([\\s\\S]{0,400}?)</dd>'));
    if (m) memo[k] = text(m[1]);
  }
  const per = html.match(/集計期間：([\d/]+)～([\d/]+)/);

  out[v.jcd] = {
    ...v, rank, kimari, take, seasons,
    water: memo['水質'] || null, tide: memo['干満差'] || null,
    motorType: memo['モーター'] || null, record: memo['レコード'] || null,
    from: per ? per[1] : null, to: per ? per[2] : null,
  };
  console.error(`  ${v.jcd} ${v.name.padEnd(4)} 1コース1着 ${rank[0][0].toFixed(1)}% 逃げ ${kimari[0][0].toFixed(1)}% 水質 ${out[v.jcd].water} 干満差 ${out[v.jcd].tide}`);
}
writeJSON('data/boat/stadium.json', out);
