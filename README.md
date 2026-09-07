# oi-keiba-3d-demo

南関東競馬（大井・川崎）予想シミュレーション 3Dデモ。`index.html` のみで動作する静的サイト（依存ゼロ）。Render の Static Site で公開。

- `index.html` … 予想シミュレーション＋3D。`?track=oi` / `?track=kawasaki`
- `race.html` … 出馬表と各馬のデータ（3Dなし・軽い）
- `data.html` … データブラウザ（騎手・調教師・厩舎×騎手・馬主・種牡馬・母の父・場/距離の傾向）
- `boat.html` … ボートレース版
- `data/nankan/` … 騎手・調教師・コンビ・馬主の指数データベースと、生成した番組・出走馬
- `tools/` … nankankeiba.com からの取り込みと、index.html へのデータ埋め込み

データの更新手順・指数の定義・守るべき要件は [CLAUDE.md](CLAUDE.md) を参照。
