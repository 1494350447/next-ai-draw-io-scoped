#!/usr/bin/env bash
set -euo pipefail
export PYTHONDONTWRITEBYTECODE=1

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECK_ONLY=0

die() { echo "错误: $*" >&2; exit 1; }
info() { echo "[*] $*"; }

usage() {
  cat <<'HELP'
安装 Next AI Draw.io 项目（系统环境请先用 install-env.sh 准备）
用法: ./setup.sh [--check]
  无参数          检查环境，首次引导填写模型配置，构建启动并验证
  --check         只检查环境及已有配置，不创建文件、不启动服务
  --help          显示帮助

本脚本不安装系统依赖，不改 Docker 用户组或已有 .env，不删除数据。
无交互终端时请预先创建并填写 .env。
HELP
}

for argument in "$@"; do
  case "$argument" in
    --check) CHECK_ONLY=1 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "未知参数: $argument" ;;
  esac
done
info "1/4 检查环境、版本和端口"
if ! bash "${ROOT_DIR}/deploy.sh" environment; then
  echo "Ubuntu 24.04 缺少软件可运行 ./install-env.sh。" >&2
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
info "3/4 构建、启动并检查应用和插件是否就绪"
bash "${ROOT_DIR}/deploy.sh" deploy
info "4/4 验证部署结果"
bash "${ROOT_DIR}/deploy.sh" status
info "完成。更新代码后可再次运行 ./setup.sh；停止服务用 ./deploy.sh down。"
