#!/usr/bin/env python3
"""从上游 Dockerfile 生成 docker-compose.yml（覆盖层）。

上游 Dockerfile 里没有 npm registry 的入口，BuildKit 也不会把未声明的
build-arg 注入成环境变量（实测确认），所以只能由本文件把镜像源写进
Dockerfile 本身，再以 dockerfile_inline 的方式传给 compose。
上游文件本身不做任何修改。

注入的每一行都包在 [deploy-override] 标记里，deploy.sh doctor 会用同样的
标记把这段剥掉再和上游 Dockerfile 比对，上游一改就能发现漂移。

drawio 侧的定制挂载（PreConfig.js + 插件目录）由 tools/gen_drawio_custom.py 生成，
这里只负责把它的 drawio 段拼进本文件 —— 两个生成器共享同一个事实来源。
离线也能跑：gen_drawio_custom 只在 probe 子命令里才需要 docker。
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
import gen_drawio_custom  # noqa: E402  （同目录的兄弟生成器）
UPSTREAM = ROOT / "upstream"
DOCKERFILE = UPSTREAM / "Dockerfile"
OVERRIDE = ROOT / "docker-compose.yml"

OLD = """# Install dependencies
ARG ELECTRON_SKIP_BINARY_DOWNLOAD=1
RUN npm install
"""

NEW = """# Install dependencies
ARG ELECTRON_SKIP_BINARY_DOWNLOAD=1
# [deploy-override] begin: 国内 npm 镜像源 + 跳过只给测试用的二进制下载
# 上游未提供 registry 入口，且 BuildKit 不会把未声明的 build-arg 注入成环境变量，
# 所以只能写进 Dockerfile。PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD 只影响仓库自身的 e2e 测试，
# 与应用运行无关（next build 不跑测试）。
ARG NPM_REGISTRY=https://registry.npmmirror.com
ARG PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm config set registry "$NPM_REGISTRY" && npm config get registry
# [deploy-override] end
RUN npm install
"""

HEADER = """# 上游 compose 的覆盖层。不复制、不改写上游文件，靠 -f 叠加。
#
# 叠加顺序有实际影响，必须上游在前、本文件在后：
#   docker compose -f <workdir>/upstream/docker-compose.yml -f <workdir>/docker-compose.yml up -d
# compose 合并同名标量时后一份文件胜出，本文件靠这一点才能改掉 build.context；
# 相对路径统一按 --project-directory（部署工作目录）解析，所以上游的
# env_file: .env 与 volumes: ./data 也一并落在工作目录里。
#
# 本文件由 tools/gen-override.py 生成，不要手改；改生成脚本后重跑一次。
"""

TEMPLATE = """name: ${{COMPOSE_PROJECT_NAME:-next-ai-draw-io}}
services:
{drawio}
  next-ai-draw-io:
    restart: unless-stopped
    ports: !override
      - target: 3000
        published: "${{APP_PORT:-3000}}"
        host_ip: "${{APP_BIND_ADDRESS:-0.0.0.0}}"
    env_file: !override
      - path: .env
        required: false
    build:
      # 上游是 context: .，这里显式指到 checkout，避免依赖叠加顺序解析相对路径。
      context: ./upstream
      dockerfile_inline: |
{inline}
      # 上游 args 是列表，这里用映射整体覆盖。
      args: !override
        # 默认留空：画布经本应用反代到 /drawio（见 upstream/next.config.ts），
        # 浏览器只访问本应用端口。仅当指向独立域名/端口时才设置 DRAWIO_PUBLIC_URL。
        NEXT_PUBLIC_DRAWIO_BASE_URL: ${{DRAWIO_PUBLIC_URL:-}}
        NEXT_PUBLIC_BASE_PATH: ${{NEXT_PUBLIC_BASE_PATH:-}}
        # 自建实例：不显示赞助/自托管引导文案
        NEXT_PUBLIC_SELFHOSTED: "true"
        NPM_REGISTRY: ${{NPM_REGISTRY:-https://registry.npmmirror.com}}
        ELECTRON_SKIP_BINARY_DOWNLOAD: "1"
        PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1"
"""


def render() -> str:
    text = DOCKERFILE.read_text()
    if OLD not in text:
        sys.exit(
            "上游 Dockerfile 的 deps 阶段已经变了，gen-override.py 的注入点失效。\n"
            "请对照 upstream/Dockerfile 更新 OLD/NEW 模板后重跑。"
        )
    patched = text.replace(OLD, NEW, 1)
    patched = patched.replace(
        "RUN npm run build",
        "# [deploy-override] begin: use the stable webpack production build\n"
        "RUN npm run build -- --webpack\n"
        "# [deploy-override] end\n",
        1,
    )
    # compose 会对整个 YAML 做变量插值，连 dockerfile_inline 的文本也不会放过。
    # Dockerfile 里的 ${NEXT_PUBLIC_*} 必须转义成 $$，否则会被替换成空串，
    # ENV 覆盖掉 build args，构建出来的前端会连不上任何 drawio。
    escaped = patched.replace("$", "$$")
    inline = "".join(f"        {line}\n" if line.strip() else "\n" for line in escaped.splitlines())
    return HEADER + TEMPLATE.format(
        drawio=gen_drawio_custom.compose_section(), inline=inline.rstrip("\n")
    )


if __name__ == "__main__":
    text = render()
    if "--check" in sys.argv[1:]:
        # doctor 用：确认文件没有被手改过（上游 Dockerfile 的语义比对在 deploy.sh 里）。
        current = OVERRIDE.read_text() if OVERRIDE.exists() else ""
        if current != text:
            print(f"{OVERRIDE} 与生成结果不一致，重跑 python3 tools/gen-override.py")
            sys.exit(2)
        print(f"{OVERRIDE} 与生成结果一致")
        sys.exit(0)
    OVERRIDE.write_text(text)
    print(f"已生成 {OVERRIDE}")
