#!/usr/bin/env bash
set -euo pipefail

die() { echo "错误: $*" >&2; exit 1; }
info() { echo "[*] $*"; }

usage() {
  cat <<'HELP'
仅安装和检查系统环境，不读取模型配置、不构建或启动项目
用法: ./install-env.sh [--check]
  无参数    为 Ubuntu 24.04 安装缺失依赖，检查版本和 Docker 访问权限
  --check   只读检查依赖，支持已安装环境的 Linux 系统
  --help    显示帮助
安装需要 root 或 sudo；只安装缺失项，不主动升级已有 Docker/Compose。
不会修改 Docker 用户组。安装后权限不足时，请由管理员授权并重新登录。
环境就绪后，另行运行 ./setup.sh 安装项目。
HELP
}

install_dependencies() {
  [[ -r /etc/os-release ]] || die "无法识别系统；请按 DEPLOY.md 手动安装依赖"
  . /etc/os-release
  [[ "${ID:-}" == "ubuntu" && "${VERSION_ID:-}" == "24.04" ]] \
    || die "自动安装仅支持 Ubuntu 24.04；其它 Linux 请先按 DEPLOY.md 安装依赖"
  local packages=() command package
  local elevated=()
  local install_docker=0
  for command in python3 curl ss sha256sum; do
    if ! command -v "$command" >/dev/null 2>&1; then
      case "$command" in
        python3) package=python3 ;;
        curl) package=curl ;;
        ss) package=iproute2 ;;
        sha256sum) package=coreutils ;;
      esac
      packages+=("$package")
    fi
  done
  if ! command -v docker >/dev/null 2>&1; then
    packages+=(docker.io docker-compose-v2)
    install_docker=1
  elif ! docker compose version >/dev/null 2>&1; then
    packages+=(docker-compose-v2)
  fi
  if (( ${#packages[@]} == 0 )); then
    info "所需软件已安装，跳过 apt 安装"
    return
  fi
  command -v apt-get >/dev/null 2>&1 || die "找不到 apt-get"
  if (( EUID != 0 )); then
    command -v sudo >/dev/null 2>&1 || die "安装依赖需要 root 或 sudo"
    elevated=(sudo)
  fi
  info "将使用系统已有 APT 源安装：${packages[*]}（不替换软件源，不移除已有包）"
  "${elevated[@]}" apt-get update
  "${elevated[@]}" apt-get install --no-remove --no-install-recommends -y "${packages[@]}"
  if (( install_docker )); then
    command -v systemctl >/dev/null 2>&1 || die "Docker 已安装，请启动 Docker daemon 后重新运行"
    "${elevated[@]}" systemctl enable --now docker
  fi
}

check_environment() {
  [[ "$(uname -s)" == "Linux" ]] || die "当前环境脚本支持 Linux；Windows 请在 WSL2 中运行"
  local command
  for command in docker python3 curl ss sha256sum; do
    command -v "$command" >/dev/null 2>&1 || die "缺少 $command；Ubuntu 24.04 可运行 ./install-env.sh 安装"
  done
  docker compose version >/dev/null 2>&1 || die "需要 Docker Compose >= 2.24.4"
  docker info >/dev/null 2>&1 || die "Docker 未运行或当前用户无访问权限；请让管理员启动服务并授予访问权限后重新登录"
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
print(f"[*] Python {sys.version.split()[0]} / Docker {sys.argv[2]} / Compose {sys.argv[1]}")
PY
  info "系统依赖和 Docker 访问检查通过"
}

[[ $# -le 1 ]] || die "仅接受一个可选参数 --check 或 --help"
case "${1:-install}" in
  install) install_dependencies; check_environment ;;
  --check) check_environment ;;
  -h|--help) usage ;;
  *) usage >&2; die "未知参数: $1" ;;
esac
