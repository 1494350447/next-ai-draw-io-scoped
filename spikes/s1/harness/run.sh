#!/bin/sh
# 用法: ./run.sh spike-a.mjs [docker run 额外参数...]
# 需要 /work 挂载到 spikes/s1（见下方 -v），node_modules 由 ensure-deps.sh 准备。
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
SPIKE_DIR="$(dirname "$DIR")"
IMG=s1-spike-browser

if ! docker image inspect "$IMG" >/dev/null 2>&1; then
    echo ">> 构建 $IMG (首次会下 ~150MB，走清华源)"
    docker build -t "$IMG" -f "$DIR/Dockerfile.browser" "$DIR"
fi

# 首次运行需要装 playwright（写进挂载目录，之后复用）
if [ ! -d "$DIR/node_modules/playwright" ]; then
    echo ">> 安装 playwright 到 $DIR/node_modules"
    docker run --rm --network host -v "$SPIKE_DIR:/work" -w /work/harness --entrypoint sh "$IMG" \
        -c 'npm i playwright --no-audit --no-fund --loglevel=error'
fi

echo ">> node $*"
exec docker run --rm --network host -e CHROME_PATH=/usr/lib/chromium/chromium \
    -v "$SPIKE_DIR:/work" -w /work/harness --entrypoint node "$IMG" "$@"
