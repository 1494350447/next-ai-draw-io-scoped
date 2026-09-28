#!/usr/bin/env bash
set -euo pipefail
export PYTHONDONTWRITEBYTECODE=1

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${ROOT_DIR}/upstream"
PROJECT_NAME="next-ai-draw-io"
ENV_FILE="${ROOT_DIR}/.env"
LOG_DIR="${ROOT_DIR}/logs"
APP_PORT=3000
DRAWIO_PORT=8080
HEALTH_URL="http://127.0.0.1:${APP_PORT}/api/config"
WAIT_TIMEOUT="${WAIT_TIMEOUT:-240}"
COMPOSE=(docker compose --project-directory "$ROOT_DIR" --env-file "$ENV_FILE"
  -f "${REPO_DIR}/docker-compose.yml" -f "${ROOT_DIR}/docker-compose.yml"
  --project-name "$PROJECT_NAME")

die() { echo "错误: $*" >&2; exit 1; }
info() { echo "[*] $*"; }
warn() { echo "[!] $*" >&2; }

usage() {
  cat <<'HELP'
Next AI Draw.io + AI 局部修改插件
用法: ./deploy.sh [命令]
  deploy              构建、启动、等待就绪、校验插件和局部编辑（默认）
  init                创建 .env 模板，不覆盖已有配置
  doctor              只读体检，不构建、不启动、不创建配置
  environment         仅检查系统工具、版本、Docker 权限、端口与磁盘
  install             构建应用、准备固定版本 draw.io、检查运行产物
  up                  启动已有镜像，等待两个服务就绪
  down / reset        停止容器和网络，保留 data/
  status              查看两个服务的状态及访问地址
  logs [服务]         跟随最近 200 行日志
  smoke               实际调用聊天及局部编辑模型（消耗模型额度）
  verify [--skip-ai]  就绪、插件、局部编辑、幂等、停止再启动验证
  plugin-check        重启、重建 draw.io 后验证插件挂载
  package             打包定制源码与部署文件，不包含密钥和数据
  reset --purge       输入确认后删除 data/
  help                显示帮助
首次使用: ./deploy.sh init，然后填写 .env，再 ./deploy.sh
HELP
}

prerequisites() {
  local command
  [[ "$(uname -s)" == "Linux" ]] || die "当前脚本支持 Linux；Windows 请在 WSL2 中运行"
  for command in docker python3 curl ss sha256sum; do
    command -v "$command" >/dev/null 2>&1 || die "缺少 $command（见 DEPLOY.md）"
  done
  docker compose version >/dev/null 2>&1 || die "需要 Docker Compose >= 2.24.4"
  docker info >/dev/null 2>&1 || die "Docker 未运行或当前用户无访问权限"
  python3 - "$(docker compose version --short)" "$(docker version --format '{{.Server.Version}}')" <<'PY'
import re
import sys

if sys.version_info < (3, 9):
    sys.exit("错误: 需要 Python >= 3.9")
for name, version, minimum in (
    ("Compose", sys.argv[1], (2, 24, 4)),
    ("Docker Engine", sys.argv[2], (24, 0, 0)),
):
    match = re.match(r"v?(\d+)\.(\d+)\.(\d+)", version)
    if not match or tuple(map(int, match.groups())) < minimum:
        sys.exit(f"错误: {name} 版本过低或无法识别: {version}，最低 {'.'.join(map(str, minimum))}")
PY
  [[ "$WAIT_TIMEOUT" =~ ^[1-9][0-9]*$ ]] || die "WAIT_TIMEOUT 必须为正整数秒数"
  [[ -z "${DEPLOY_REPO_DIR:-}" || "$DEPLOY_REPO_DIR" == "$REPO_DIR" ]] \
    || die "请将随包定制源码放在 upstream/；当前覆盖层不支持外部 DEPLOY_REPO_DIR"
}

do_environment() {
  prerequisites
  ensure_repo
  ports_free
  info "Linux / Python $(python3 --version | cut -d' ' -f2) / Docker $(docker version --format '{{.Server.Version}}') / Compose $(docker compose version --short)"
  info "宿主端口 3000、8080 无冲突"
  local available
  available="$(df -Pk "$ROOT_DIR" | awk 'NR==2 {print $4}')"
  info "项目所在文件系统剩余空间：$((available / 1024)) MiB"
  if (( available < 6 * 1024 * 1024 )); then
    warn "可用空间不足建议的 6 GiB；首次镜像构建可能失败"
  fi
  info "环境检查通过；Docker 镜像和模型网络将在实际部署/冒烟时验证"
}

ensure_repo() {
  local path
  for path in Dockerfile docker-compose.yml app/api/scoped-edit/route.ts lib/scoped-edit.ts lib/scoped-rules.ts lib/model-request.ts lib/edit-diagram-tool.ts; do
    [[ -f "${REPO_DIR}/$path" ]] || die "缺少 upstream/$path。请解压完整部署包，官方原版仓库不包含局部修改功能。"
  done
}

init_env() {
  if [[ ! -f "$ENV_FILE" ]]; then
    (umask 077; cp "${ROOT_DIR}/.env.example" "$ENV_FILE")
    info "已创建 .env，请填写模型 ID 与 API key 后重新运行。"
  else
    info ".env 已存在，未覆盖。"
  fi
}

validate_config() {
  [[ -f "$ENV_FILE" ]] || die "缺少 .env，请先 ./deploy.sh init 并填写配置"
  "${COMPOSE[@]}" config --format json | python3 "${ROOT_DIR}/tools/deploy_check.py" config
}

check_assets() {
  python3 "${ROOT_DIR}/tools/gen-override.py" --check
  python3 "${ROOT_DIR}/tools/gen_drawio_custom.py" check
}

prepare_assets() {
  python3 "${ROOT_DIR}/tools/gen_drawio_custom.py" build
  check_assets
}

http_code() {
  curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$1" 2>/dev/null || true
}

compose_ready() {
  local service cid state
  for service in drawio next-ai-draw-io; do
    cid="$("${COMPOSE[@]}" ps -a -q "$service")"
    [[ -n "$cid" ]] || return 1
    state="$(docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$cid")"
    [[ "$state" == "running none" || "$state" == "running healthy" ]] || return 1
  done
}

wait_ready() {
  local deadline=$((SECONDS + WAIT_TIMEOUT))
  while (( SECONDS < deadline )); do
    if compose_ready && [[ "$(http_code "$HEALTH_URL")" == "200" ]] \
      && [[ "$(http_code "http://127.0.0.1:${DRAWIO_PORT}/js/PreConfig.js")" == "200" ]]; then
      info "应用 /api/config 和 draw.io PreConfig.js 均已就绪"
      return 0
    fi
    sleep 2
  done
  "${COMPOSE[@]}" ps -a >&2
  die "等待就绪超时，用 ./deploy.sh logs 查看日志"
}

ports_free() {
  local port mine
  mine="$(docker ps --filter "label=com.docker.compose.project=${PROJECT_NAME}" --format '{{.Ports}}')"
  for port in "$APP_PORT" "$DRAWIO_PORT"; do
    if ss -ltn "sport = :$port" | grep -q LISTEN; then
      grep -q ":${port}->" <<<"$mine" || die "端口 $port 已被其它服务占用"
    fi
  done
}

app_image() {
  "${COMPOSE[@]}" config --images | grep -v '^jgraph/drawio' | head -1
}

ensure_image() {
  local image
  image="$(app_image)"
  docker image inspect "$image" >/dev/null 2>&1 || die "应用镜像不存在，请先 ./deploy.sh install"
  docker run --rm --entrypoint sh "$image" -c \
    'test -f /app/server.js && test -d /app/.next/static && test -f /app/.next/server/app/api/scoped-edit/route.js' \
    || die "镜像缺少运行产物或局部编辑接口，请重新构建"
}

drawio_custom_live() {
  local cid base="http://127.0.0.1:${DRAWIO_PORT}" file expected actual
  cid="$("${COMPOSE[@]}" ps -q drawio)"
  [[ -n "$cid" ]] || die "draw.io 未运行"
  for file in js/PreConfig.js plugins/custom/ai-scope.js; do
    if [[ "$file" == js/* ]]; then
      expected="$(sha256sum "${ROOT_DIR}/drawio-custom/PreConfig.js" | cut -d' ' -f1)"
    else
      expected="$(sha256sum "${ROOT_DIR}/drawio-custom/plugins/ai-scope.js" | cut -d' ' -f1)"
    fi
    actual="$(curl -fsS --max-time 10 "${base}/$file" | sha256sum | cut -d' ' -f1)"
    [[ "$actual" == "$expected" ]] || die "$file 的在线内容与本地不一致"
  done
  [[ "$(http_code "${base}/plugins/animation.js")" == "200" ]] || die "官方插件不可访问"
  info "插件、PreConfig 在线内容一致，官方插件可访问"
}

scoped_smoke() {
  "${COMPOSE[@]}" config --format json | python3 "${ROOT_DIR}/tools/deploy_check.py" "${1:-scoped}"
}

print_access() {
  info "应用：http://127.0.0.1:${APP_PORT}/"
  info "画布：http://127.0.0.1:${DRAWIO_PORT}/"
  info "局部编辑：主应用 /api/scoped-edit（无需 8787 服务）"
}

do_doctor() {
  prerequisites
  ensure_repo
  validate_config
  check_assets
  ports_free
  info "Docker $(docker version --format '{{.Server.Version}}') / Compose $(docker compose version --short)"
  info "源码：随包定制版本（详情见 README.md 和 release-manifest.json）"
  info "可用磁盘：$(df -h "$ROOT_DIR" | awk 'NR==2 {print $4}')"
  if [[ -d "${ROOT_DIR}/data" ]]; then
    info "data/ 权限：$(stat -c '%u:%g %a' "${ROOT_DIR}/data")；应用运行 UID 为 1001"
  fi
  info "只读体检通过"
}

do_install() {
  prerequisites
  ensure_repo
  [[ -f "$ENV_FILE" ]] || init_env
  validate_config
  prepare_assets
  mkdir -p "$LOG_DIR"
  local drawio_image
  drawio_image="$("${COMPOSE[@]}" config --format json | python3 -c 'import json,sys; print(json.load(sys.stdin)["services"]["drawio"]["image"])')"
  if ! docker image inspect "$drawio_image" >/dev/null 2>&1; then
    "${COMPOSE[@]}" pull drawio 2>&1 | tee "${LOG_DIR}/pull.log"
  fi
  info "构建包含局部编辑 API 的应用镜像（首次构建需要数分钟）"
  "${COMPOSE[@]}" build next-ai-draw-io 2>&1 | tee "${LOG_DIR}/build.log"
  ensure_image
  info "安装通过：standalone、静态资源、scoped-edit 路由齐备"
}

do_up() {
  prerequisites
  ensure_repo
  validate_config
  prepare_assets
  ports_free
  ensure_image
  if [[ ! -d "${ROOT_DIR}/data" ]]; then
    docker run --rm --user 0 --entrypoint sh -v "${ROOT_DIR}/data:/data" "$(app_image)" -c 'chown 1001:1001 /data'
  fi
  "${COMPOSE[@]}" up -d --remove-orphans
  wait_ready
  drawio_custom_live
}

do_down() {
  "${COMPOSE[@]}" down
  info "容器和网络已移除，data/ 保留"
}

do_status() {
  "${COMPOSE[@]}" ps -a
  compose_ready || die "部分服务未运行或不健康"
  [[ "$(http_code "$HEALTH_URL")" == "200" ]] || die "应用接口未就绪"
  [[ "$(http_code "http://127.0.0.1:${DRAWIO_PORT}/js/PreConfig.js")" == "200" ]] || die "画布未就绪"
  print_access
}

do_verify() {
  local skip_ai="${1:-}" before_ids port
  [[ -z "$skip_ai" || "$skip_ai" == "--skip-ai" ]] || die "verify 只接受 --skip-ai"
  do_doctor
  do_up
  before_ids="$("${COMPOSE[@]}" ps -q | sort)"
  do_up
  [[ "$before_ids" == "$("${COMPOSE[@]}" ps -q | sort)" ]] || die "重复 up 改变了容器 ID"
  scoped_smoke
  [[ "$skip_ai" == "--skip-ai" ]] || scoped_smoke ai
  do_down
  [[ -z "$("${COMPOSE[@]}" ps -a -q)" ]] || die "停止后仍有项目容器残留"
  for port in "$APP_PORT" "$DRAWIO_PORT"; do
    if ss -ltn "sport = :$port" | grep -q LISTEN; then die "停止后端口 $port 仍被占用"; fi
  done
  do_up
  scoped_smoke
  info "验证通过：就绪、插件、局部修改、幂等、清理及重新启动"
  print_access
}

case "${1:-deploy}" in
  help|-h|--help) usage ;;
  init) init_env ;;
  doctor) do_doctor ;;
  environment) do_environment ;;
  deploy)
    do_install
    do_up
    scoped_smoke
    print_access
    ;;
  install) do_install ;;
  up) do_up; print_access ;;
  down) do_down ;;
  status) do_status ;;
  logs) shift; "${COMPOSE[@]}" logs --tail=200 -f "$@" ;;
  smoke) validate_config; scoped_smoke; scoped_smoke ai ;;
  verify) do_verify "${2:-}" ;;
  plugin-check)
    check_assets
    wait_ready
    drawio_custom_live
    "${COMPOSE[@]}" restart drawio
    wait_ready
    drawio_custom_live
    "${COMPOSE[@]}" up -d --force-recreate drawio
    wait_ready
    drawio_custom_live
    ;;
  package) python3 "${ROOT_DIR}/tools/package_release.py" ;;
  reset)
    if [[ "${2:-}" == "--purge" ]]; then
      [[ -t 0 ]] || die "删除 data/ 必须在交互终端输入确认；自动化请用 reset 保留数据"
      read -r -p "将永久删除 data/，输入 DELETE 确认: " confirmation
      [[ "$confirmation" == "DELETE" ]] || die "已取消"
      do_down
      rm -rf -- "${ROOT_DIR}/data"
    elif [[ -z "${2:-}" ]]; then
      do_down
    else
      die "reset 只接受 --purge"
    fi
    ;;
  *) usage >&2; die "未知命令: $1" ;;
esac
