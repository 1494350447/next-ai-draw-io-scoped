#!/bin/sh
# 用法: ./run-host.sh <harness 里的脚本> [参数...]
# 宿主页要放在 drawio 自己的 origin 上（iframe 同源，消息才能互通），所以先 docker cp 进容器，
# 跑完删掉 —— 与 S1/S2 的做法一致，不留残留资产。
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
SPIKE_DIR="$(dirname "$DIR")"
D="${DRAWIO_CONTAINER:-next-ai-draw-io-drawio-1}"
DEST=/usr/local/tomcat/webapps/draw

for page in spike.html spike-b.html spike-e.html; do
    docker cp "$SPIKE_DIR/$page" "$D:$DEST/$page"
done
trap 'docker exec "$D" sh -c "cd /usr/local/tomcat/webapps/draw && rm -f spike.html spike-b.html spike-e.html"' EXIT

"$DIR/run.sh" "$@"
