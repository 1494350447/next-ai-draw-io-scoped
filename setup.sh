#!/usr/bin/env bash
set -euo pipefail
export PYTHONDONTWRITEBYTECODE=1

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECK_ONLY=0
INSTALL_DEPS=0
WITH_AI=0

die() { echo "错误: $*" >&2; exit 1; }
info() { echo "[*] $*"; }

usage() {
  cat <<'HELP'
一键检查环境、配置并部署 Next AI Draw.io 局部修改版
用法: ./setup.sh [--check | --install-deps] [--with-ai]
  无参数          检查环境，首次引导填写模型配置，构建启动并验证
  --check         只检查环境及已有配置，不创建文件、不启动服务
  --install-deps  为 Ubuntu 24.04 安装缺少的软件，随后部署
  --with-ai       部署后额外验证聊天和局部编辑模型（消耗模型额度）
  --help          显示帮助

安装系统依赖需要 root 或 sudo；已有软件不会自动升级或替换。
默认不改系统软件、Docker 用户组或已有 .env，不删除数据。
无交互终端时请预先创建并填写 .env。
HELP
}

for argument in "$@"; do
  case "$argument" in
    --check) CHECK_ONLY=1 ;;
    --install-deps) INSTALL_DEPS=1 ;;
    --with-ai) WITH_AI=1 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "未知参数: $argument" ;;
  esac
done
if (( CHECK_ONLY && (INSTALL_DEPS || WITH_AI) )); then
  die "--check 不能与 --install-deps 或 --with-ai 一起使用"
fi

install_dependencies() {
  [[ -r /etc/os-release ]] || die "无法识别系统；请按 DEPLOY.md 手动安装依赖"
  . /etc/os-release
  [[ "${ID:-}" == "ubuntu" && "${VERSION_ID:-}" == "24.04" ]] \
    || die "--install-deps 仅支持 Ubuntu 24.04；其它 Linux 请先按 DEPLOY.md 安装依赖"
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

if (( INSTALL_DEPS )); then install_dependencies; fi
info "1/4 检查环境、版本和端口"
if ! bash "${ROOT_DIR}/deploy.sh" environment; then
  echo "Ubuntu 24.04 缺少软件可运行 ./setup.sh --install-deps。" >&2
  echo "Docker 权限不足时，请让管理员授予访问权限后重新登录；脚本不修改用户组。" >&2
  exit 1
fi

if (( CHECK_ONLY )); then
  bash "${ROOT_DIR}/deploy.sh" doctor
  exit 0
fi

info "2/4 检查模型配置"
if [[ ! -e "${ROOT_DIR}/.env" ]]; then
  if [[ -t 0 ]]; then
    python3 "${ROOT_DIR}/tools/setup_config.py"
  else
    bash "${ROOT_DIR}/deploy.sh" init
    die "已创建 .env 模板；请填写模型配置后重新运行，非交互模式不会等待输入"
  fi
fi
info "3/4 构建、启动并校验应用、插件和局部编辑规则"
bash "${ROOT_DIR}/deploy.sh" deploy
info "4/4 验证部署结果"
if (( WITH_AI )); then bash "${ROOT_DIR}/deploy.sh" smoke; fi
bash "${ROOT_DIR}/deploy.sh" status
info "完成。更新代码后可再次运行 ./setup.sh；停止服务用 ./deploy.sh down。"
