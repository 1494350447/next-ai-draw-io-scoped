#!/usr/bin/env python3
"""生成 drawio 侧的定制资产（PreConfig.js）以及它在 compose 覆盖层里的挂载段。

为什么需要定制 drawio（结论全部来自实测，见 spikes/s1/RESULT.md）：
  1. 自托管 drawio 唯一的官方定制入口是 webapp 里的 js/PreConfig.js —— 它在应用脚本
     之前执行；?plugins=xxx.js 只认内置白名单，加载不了自己的插件。
  2. 镜像的 /docker-entrypoint.sh 每次容器启动都会**重写** PreConfig.js（CSP +
     DRAWIO_* + urlParams）。所以定制版必须用只读挂载顶掉它，否则重启即失效。
  3. 该 entrypoint 开头用 `touch PreConfig.js` 探测写权限，只读挂载会让探测失败，于是
     它打印一条 WARNING 后直接启动 Tomcat，跳过全部运行时改写（SSL 证书、子路径
     context、PostConfig.js 追加）。代价与等价的静态内容见 DEPLOY.md「drawio 定制」。

用法：
  python3 tools/gen_drawio_custom.py probe    # 需 docker：从镜像取原版/版本，刷新锁文件
  python3 tools/gen_drawio_custom.py build    # 由锁文件 + 内置模板生成 PreConfig.js
  python3 tools/gen_drawio_custom.py check    # 校验生成物、锁文件与 compose 段是否一致
  python3 tools/gen_drawio_custom.py section  # 打印 compose 的 drawio 段（gen-override.py 调用）

gen-override.py 会 import 本模块拿 compose 段，所以这里只保留一个事实来源。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent.parent
CUSTOM_DIR = ROOT / "drawio-custom"
PLUGIN_DIR = CUSTOM_DIR / "plugins"
LOCK_FILE = CUSTOM_DIR / "image.lock.json"
PRECONFIG = CUSTOM_DIR / "PreConfig.js"
PRECONFIG_IMAGE_ORIG = CUSTOM_DIR / "PreConfig.image-orig.js"
COMPOSE = ROOT / "docker-compose.yml"

DRAWIO_IMAGE = "jgraph/drawio@sha256:4bd19d4bc36b65cabf1ae9c5d234597e564416b6c67f7d4db296c2df758fcb52"
CONTAINER_WEBAPP = "/usr/local/tomcat/webapps/draw"
CONTAINER_PRECONFIG = f"{CONTAINER_WEBAPP}/js/PreConfig.js"

# 插件放在 plugins/ 的**子目录**：直接挂 plugins/ 会盖掉镜像里的 22 个官方插件。
PLUGIN_NAME = "ai-scope.js"
PLUGIN_REL_URL = f"plugins/custom/{PLUGIN_NAME}"
HOST_PLUGIN_DIR = "./drawio-custom/plugins"
CONTAINER_PLUGIN_DIR = f"{CONTAINER_WEBAPP}/plugins/custom"

HOST_PRECONFIG = "./drawio-custom/PreConfig.js"

# Phase 2 的"局部编辑服务"端点。默认留空表示同源：画布经 next-ai-draw-io 反代到
# /drawio，插件 fetch 的 /api/scoped-edit 与它同源，CSP 的 'self' 已足够。只有把
# 画布指向独立域名/端口（跨域）时，才需要在 .env 里显式给一个绝对地址。
# 两处要用到它，必须来自同一个值：
#   · PreConfig 注入 window.AI_SCOPE_ENDPOINT —— 插件据此知道往哪发指令；
#   · CSP 的 connect-src —— 跨域时 drawio 自带的那条 CSP 只放行 'self' 与几个第三方，
#     不加这一条的话浏览器会直接掐掉插件的 fetch，而且报错落在 iframe 里，很难查。
# 取值优先级：shell 环境变量 > 工作目录 .env > 默认（同源，空串）。
SCOPE_ENDPOINT_DEFAULT = ""
SCOPE_ENDPOINT_KEY = "AI_SCOPE_ENDPOINT"
ENV_FILE = ROOT / ".env"


def _env_file_value(key: str) -> str:
    """从工作目录的 .env 里取一个键（与 compose 读的是同一份文件，避免两处配置打架）。"""
    if not ENV_FILE.exists():
        return ""
    for line in ENV_FILE.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        if k.strip() == key:
            return v.strip().strip('"').strip("'")
    return ""


def scope_endpoint() -> str:
    """显式配置的端点；空串表示同源（插件回退到 window.location.origin）。"""
    value = os.environ.get(SCOPE_ENDPOINT_KEY)
    if value is None:
        value = _env_file_value(SCOPE_ENDPOINT_KEY)
    endpoint = value.strip().strip('"').strip("'").rstrip("/")
    if endpoint:
        parts = urlsplit(endpoint)
        if parts.scheme not in ("http", "https") or not parts.hostname or parts.username or parts.password or parts.query or parts.fragment or any(character.isspace() or character in "\"'<>\\" for character in endpoint):
            raise ValueError("AI_SCOPE_ENDPOINT 必须是 HTTP(S) 应用根地址，可包含子路径，不含凭据、查询或片段")
    return endpoint


def scope_origin(endpoint: str) -> str:
    """CSP 只认 origin（scheme://host:port），路径带进去是无效项；同源端点返回空串。"""
    if not endpoint:
        return ""
    parts = urlsplit(endpoint)
    return f"{parts.scheme}://{parts.netloc}" if parts.scheme and parts.netloc else endpoint

# 挂进 compose 的 drawio 段，check 用它做一致性比对，gen-override.py 用它拼文件。
DRAWIO_SECTION = f"""  drawio:
    image: {DRAWIO_IMAGE}
    restart: unless-stopped
    ports: !override []
    volumes:
      # drawio 官方留给自托管的定制入口，在应用脚本之前执行（见 tools/gen_drawio_custom.py）。
      # 只读挂载：容器 entrypoint 每次启动都会重写这个文件，不顶掉它的话重启即失效。
      - {HOST_PRECONFIG}:{CONTAINER_PRECONFIG}:ro
      # 插件必须挂 plugins/ 的子目录 —— 直挂 plugins/ 会盖掉镜像自带的官方插件。
      - {HOST_PLUGIN_DIR}:{CONTAINER_PLUGIN_DIR}:ro
"""

# entrypoint 默认写入的 CSP（DRAWIO_CSP_HEADER 的默认值）。keep-alive 原样保留。
CSP = (
    "default-src 'self'; script-src 'self' https://storage.googleapis.com https://apis.google.com "
    "https://docs.google.com https://code.jquery.com 'unsafe-inline'; connect-src 'self' "
    "https://*.dropboxapi.com https://api.trello.com https://api.github.com https://raw.githubusercontent.com "
    "https://*.googleapis.com https://*.googleusercontent.com https://graph.microsoft.com https://*.1drv.com "
    "https://*.sharepoint.com https://gitlab.com https://*.google.com https://fonts.gstatic.com "
    "https://fonts.googleapis.com; img-src * data:; media-src * data:; font-src * about:; "
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; frame-src 'self' https://*.google.com;"
)

PRECONFIG_TEMPLATE = """/* 生成物，不要手改 —— 由 tools/gen_drawio_custom.py 生成（改模板后重跑 build）。
 *
 * 这是 drawio 的运行时配置入口（webapp: js/PreConfig.js），在应用脚本之前执行。
 * 本文件以只读方式挂进容器，顶掉镜像 entrypoint 每次启动时重写的那一份，
 * 从而在重启/重建后仍然带着下面这段插件注入。
 *
 * 与 entrypoint 版本的差异：它把 DRAWIO_* 写成硬编码值，这里改成从本脚本自身的
 * <script src> 反推部署前缀，所以同一份文件在 "/" 与 "/draw/" 前缀下都成立，
 * 也不依赖 DRAWIO_BASE_URL 环境变量。
 */
(function () {{
  try {{
    var s = document.createElement('meta');
    // CSP 里只有单引号，所以这里用双引号包裹，避免再套一层转义。
    s.setAttribute('content', "{csp}");
    s.setAttribute('http-equiv', 'Content-Security-Policy');
    var t = document.getElementsByTagName('meta')[0];
    t.parentNode.insertBefore(s, t);
  }} catch (e) {{}} // ignore
}})();

// 部署前缀：PreConfig.js 由 mxscript 以相对路径 'js/PreConfig.js' 注入，
// 从 document.scripts 里找它自己的 URL，去掉尾部 js/PreConfig.js 即得前缀。
var __drawioBase = (function () {{
    try {{
        var list = document.scripts || [];
        for (var i = 0; i < list.length; i++) {{
            var m = /^(.*)\\/js\\/PreConfig\\.js(?:[?#]|$)/.exec(list[i].src || '');
            if (m) return m[1];
        }}
    }} catch (e) {{}} // ignore
    return location.origin;
}})();

window.DRAWIO_SERVER_URL = __drawioBase + '/';
window.DRAWIO_BASE_URL = __drawioBase;
window.DRAWIO_VIEWER_URL = '';
window.DRAWIO_LIGHTBOX_URL = '';
window.DRAW_MATH_URL = 'math4/es5';
window.EXPORT_URL = null;
window.DRAWIO_CONFIG = null;
urlParams['sync'] = 'manual'; //Disable Real-Time
urlParams['db'] = '0'; //dropbox
urlParams['gh'] = '0'; //github
urlParams['tr'] = '0'; //trello
urlParams['gapi'] = '0'; //Google Drive
urlParams['od'] = '0'; //OneDrive
urlParams['gl'] = '0'; //Gitlab

// ===== {marker} v{adapter_version} =====
// 作用域编辑适配层（选区读取 + 可调用动作 + 只改选中元素的写回）。
// 它只做适配，不含业务逻辑；宿主（next-ai-draw-io）通过 embed 的 postMessage
// 用 {{action:'invokeAction', actionName:'<名字>'}} 调用里面的动作。
// 注入时机早于 Draw 定义，插件自己会轮询等 Draw.loadPlugin（见 drawio-custom/plugins/{plugin}）。
// AI_SCOPE_ENDPOINT 是 next-ai-draw-io 的局部编辑 API 端点；留空表示同源
// （画布经主应用反代到 /drawio，CSP 的 'self' 已经放行，插件里的 fetch 不会被掐）。
// 只有把画布指向独立域名/端口时才需要在 .env 里显式写绝对地址。
window.AI_SCOPE_ENDPOINT = {scope_endpoint} || __drawioBase.replace(/\\/drawio$/, '');
window.ALLOW_CUSTOM_PLUGINS = true; // 走 ?plugins= 入口时的前置开关；本注入不依赖它，留作备用
(function () {{
    try {{
        var s = document.createElement('script');
        // 带内容指纹的 URL（?v=<插件 sha256 前 8 位>）：插件换内容 → URL 变 → 浏览器重新拉。
        // 起因（实测）：Tomcat 给静态文件只发 ETag/Last-Modified、**不发 Cache-Control**，
        // 浏览器按启发式缓存就把旧插件一直用下去 —— 我们删掉的功能在用户页面上"还在"。
        // 指纹由 render_preconfig() 从插件文件现算，所以改了插件要重跑 build（check 会提醒）。
        s.src = window.AI_SCOPE_PLUGIN_URL || (__drawioBase + '/{plugin_rel}?v={plugin_fp}');
        s.async = false;
        (document.head || document.getElementsByTagName('head')[0]).appendChild(s);
    }} catch (e) {{}} // ignore
}})();
"""

ADAPTER_VERSION = "1"
MARKER = "ai-scope-adapter"


def render_preconfig() -> str:
    endpoint = scope_endpoint()
    origin = scope_origin(endpoint)
    csp = CSP
    if origin:
        # 跨域端点才需要额外放行；同源时 CSP 里的 'self' 已经覆盖。
        csp = CSP.replace("connect-src 'self' ", f"connect-src 'self' {origin} ")
    return PRECONFIG_TEMPLATE.format(
        csp=csp,
        scope_endpoint=json.dumps(endpoint),
        marker=MARKER,
        adapter_version=ADAPTER_VERSION,
        plugin=PLUGIN_NAME,
        plugin_rel=PLUGIN_REL_URL,
        plugin_fp=plugin_fingerprint(),
    )


def plugin_fingerprint() -> str:
    """插件内容指纹（sha256 前 8 位）：只用来做缓存失效，不参与任何安全判断。"""
    plugin = PLUGIN_DIR / PLUGIN_NAME
    try:
        return sha256_text(plugin.read_text())[:8]
    except OSError:
        return "unknown"


def compose_section() -> str:
    """给 gen-override.py 用的 drawio 段（已带缩进与结尾空行）。"""
    return DRAWIO_SECTION


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def probe() -> int:
    """从 drawio 镜像取回原版 PreConfig.js、版本号并刷新锁文件。需要 docker。"""
    import subprocess

    script = (
        f'echo "##SHA##"; sha256sum {CONTAINER_PRECONFIG}; '
        f'echo "##VERSION##"; grep -o \'VERSION="[0-9.]*"\' '
        f'{CONTAINER_WEBAPP}/js/app.min.js | head -1; '
        f'echo "##CONTENT##"; cat {CONTAINER_PRECONFIG}'
    )
    out = subprocess.run(
        ["docker", "run", "--rm", "--entrypoint", "sh", DRAWIO_IMAGE, "-c", script],
        capture_output=True, text=True,
    )
    if out.returncode != 0:
        sys.exit(f"探测 {DRAWIO_IMAGE} 失败：{out.stderr.strip()}")
    text = out.stdout
    _, _, rest = text.partition("##SHA##")
    sha_part, _, rest = rest.partition("##VERSION##")
    ver_part, _, content = rest.partition("##CONTENT##")
    orig_sha = sha_part.split()[0].strip()
    version = ver_part.strip().split('"')[1] if '"' in ver_part else "unknown"

    PRECONFIG_IMAGE_ORIG.write_text(content.lstrip("\n"))
    lock = {
        "image": DRAWIO_IMAGE,
        "drawio_version": version,
        "image_preconfig_sha256": orig_sha,
        "note": "image_preconfig_sha256 是镜像里原版 js/PreConfig.js 的 sha256；"
                "容器启动时 entrypoint 会重写这个文件，所以运行时内容与它不同（见 PreConfig.js 头部注释）。",
        "generated_preconfig_sha256": sha256_text(render_preconfig()),
    }
    LOCK_FILE.write_text(json.dumps(lock, indent=2, ensure_ascii=False) + "\n")
    PRECONFIG.write_text(render_preconfig())
    print(f"已刷新 {LOCK_FILE.relative_to(ROOT)}：drawio {version} / 原版 sha256 {orig_sha[:12]}")
    print(f"已取回 {PRECONFIG_IMAGE_ORIG.relative_to(ROOT)}（镜像原版，仅供对照）")
    print(f"已生成 {PRECONFIG.relative_to(ROOT)}")
    return 0


def build() -> int:
    CUSTOM_DIR.mkdir(parents=True, exist_ok=True)
    text = render_preconfig()
    old = PRECONFIG.read_text() if PRECONFIG.exists() else None
    PRECONFIG.write_text(text)
    # 生成物变了，锁文件里那条"生成物指纹"跟着更新，否则它就开始说谎了。
    if LOCK_FILE.exists():
        lock = json.loads(LOCK_FILE.read_text())
        lock["generated_preconfig_sha256"] = sha256_text(text)
        lock["scope_endpoint"] = scope_endpoint()
        LOCK_FILE.write_text(json.dumps(lock, indent=2, ensure_ascii=False) + "\n")
    print(f"{'已更新' if old != text else '无变化'} {PRECONFIG.relative_to(ROOT)}")
    return 0


def load_lock() -> dict:
    if not LOCK_FILE.exists():
        sys.exit(f"缺少 {LOCK_FILE.relative_to(ROOT)}，先跑 python3 tools/gen_drawio_custom.py probe")
    return json.loads(LOCK_FILE.read_text())


def check() -> int:
    problems = []
    lock = load_lock()

    expected = render_preconfig()
    if not PRECONFIG.exists():
        problems.append(f"缺少 {PRECONFIG.relative_to(ROOT)}（跑 build）")
    else:
        actual = PRECONFIG.read_text()
        if actual != expected:
            fp = plugin_fingerprint()
            if f"?v={fp}" not in actual:
                problems.append(
                    f"{PRECONFIG.relative_to(ROOT)} 里的插件指纹不是当前的（插件改过？跑 build 重新生成）"
                    f" —— 不重跑的话浏览器可能继续用缓存里的旧插件（Tomcat 不发 Cache-Control）"
                )
            else:
                problems.append(f"{PRECONFIG.relative_to(ROOT)} 与模板不一致（手改过？跑 build 重新生成）")
        if MARKER not in actual or PLUGIN_REL_URL not in actual:
            problems.append(f"{PRECONFIG.relative_to(ROOT)} 里没有插件注入标记")

    plugin = PLUGIN_DIR / PLUGIN_NAME
    if not plugin.exists():
        problems.append(f"缺少插件 {plugin.relative_to(ROOT)}")
    else:
        src = plugin.read_text()
        if "Draw.loadPlugin" not in src:
            problems.append(f"{plugin.relative_to(ROOT)} 里没有 Draw.loadPlugin 注册")

    if lock.get("image_preconfig_sha256") is None:
        problems.append(f"{LOCK_FILE.relative_to(ROOT)} 缺 image_preconfig_sha256")

    if not COMPOSE.exists():
        problems.append("缺少 docker-compose.yml")
    else:
        compose_text = COMPOSE.read_text()
        for needle in (
            f"{HOST_PRECONFIG}:{CONTAINER_PRECONFIG}:ro",
            f"{HOST_PLUGIN_DIR}:{CONTAINER_PLUGIN_DIR}:ro",
        ):
            if needle not in compose_text:
                problems.append(
                    f"docker-compose.yml 的 drawio 段里没有挂载 {needle}"
                    "（跑 python3 tools/gen-override.py 重新生成）"
                )

    if problems:
        for p in problems:
            print(f"[!] {p}")
        return 2
    print(f"[*] drawio 定制资产一致：drawio {lock.get('drawio_version')}，"
          f"PreConfig.js + {PLUGIN_REL_URL} + compose 挂载齐备")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("cmd", choices=["probe", "build", "check", "section"], nargs="?", default="build")
    args = ap.parse_args()
    if args.cmd == "probe":
        return probe()
    if args.cmd == "build":
        return build()
    if args.cmd == "check":
        return check()
    sys.stdout.write(compose_section())
    return 0


if __name__ == "__main__":
    sys.exit(main())
