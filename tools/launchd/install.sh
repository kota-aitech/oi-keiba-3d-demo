#!/bin/sh
# 締切8分前のオッズ取得を launchd に登録する。リポジトリ直下から実行すること。
set -e
REPO=$(cd "$(dirname "$0")/../.." && pwd)
NODE=$(command -v node)
PLIST="$HOME/Library/LaunchAgents/com.nankan.oddswatch.plist"
mkdir -p "$HOME/Library/LaunchAgents"
sed -e "s|__REPO__|$REPO|g" -e "s|__NODE__|$NODE|g" "$REPO/tools/launchd/com.nankan.oddswatch.plist" > "$PLIST"
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "登録しました: $PLIST"
echo "  リポジトリ : $REPO"
echo "  node       : $NODE"
echo "  ログ       : $REPO/data/nankan/oddswatch.log"
echo "止めるとき : launchctl unload $PLIST"
