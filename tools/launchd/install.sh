#!/bin/sh
# 締切前のオッズ取得と、その反映を launchd に登録する。リポジトリ直下から実行すること。
#   com.nankan.oddswatch … 1分おきに南関のオッズの取り時を見る
#   com.nankan.refresh   … 2分おきに、オッズが変わっていれば各ページへ反映する
#   com.boat.live        … 1分おきにボートの直前情報と締切前オッズを拾う
#   com.boat.refresh     … 3分おきに、変化があればボートの予測を作り直して boat.html に反映・push
# 引数に Label を並べると、そのぶんだけ登録し直す（例: sh tools/launchd/install.sh com.boat.live）
set -e
REPO=$(cd "$(dirname "$0")/../.." && pwd)
NODE=$(command -v node)
mkdir -p "$HOME/Library/LaunchAgents"
LABELS=${*:-"com.nankan.oddswatch com.nankan.refresh com.boat.live com.boat.refresh"}
for LABEL in $LABELS; do
  PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
  sed -e "s|__REPO__|$REPO|g" -e "s|__NODE__|$NODE|g" "$REPO/tools/launchd/$LABEL.plist" > "$PLIST"
  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load "$PLIST"
  echo "登録: $PLIST"
done
echo "  リポジトリ : $REPO"
echo "  node       : $NODE"
echo "  ログ       : $REPO/data/nankan/oddswatch.log ／ refresh.log ／ $REPO/data/boat/live.log"
echo "止めるとき : launchctl unload ~/Library/LaunchAgents/<Label>.plist"
