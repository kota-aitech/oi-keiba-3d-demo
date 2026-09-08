#!/bin/sh
# 締切8分前のオッズ取得と、その反映を launchd に登録する。リポジトリ直下から実行すること。
#   com.nankan.oddswatch … 1分おきにオッズの取り時を見る
#   com.nankan.refresh   … 2分おきに、オッズが変わっていれば各ページへ反映する
set -e
REPO=$(cd "$(dirname "$0")/../.." && pwd)
NODE=$(command -v node)
mkdir -p "$HOME/Library/LaunchAgents"
for NAME in oddswatch refresh; do
  PLIST="$HOME/Library/LaunchAgents/com.nankan.$NAME.plist"
  sed -e "s|__REPO__|$REPO|g" -e "s|__NODE__|$NODE|g" "$REPO/tools/launchd/com.nankan.$NAME.plist" > "$PLIST"
  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load "$PLIST"
  echo "登録: $PLIST"
done
echo "  リポジトリ : $REPO"
echo "  node       : $NODE"
echo "  ログ       : $REPO/data/nankan/oddswatch.log ／ refresh.log"
echo "止めるとき : launchctl unload ~/Library/LaunchAgents/com.nankan.{oddswatch,refresh}.plist"
