#!/usr/bin/env python3
import getpass
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def main():
    destination = ROOT / ".env"
    if destination.exists():
        print("[*] .env 已存在，保留原配置")
        return
    if not sys.stdin.isatty():
        sys.exit("请先运行 ./deploy.sh init 并填写 .env")
    print("首次配置使用 DeepSeek；其它提供方请用 ./deploy.sh init 后编辑 .env。")
    model = input("模型 ID [deepseek-flash]: ").strip() or "deepseek-flash"
    key = getpass.getpass("DeepSeek API key（输入不回显）: ").strip()
    if not key:
        sys.exit("API key 不能为空；未创建 .env")
    if any(character in model + key for character in ("'", "\n", "\r", "\x00")):
        sys.exit("配置包含不支持的字符；请用 ./deploy.sh init 后手动编辑 .env")
    template = (ROOT / ".env.example").read_text()
    for name, value in (("AI_PROVIDER", "deepseek"), ("AI_MODEL", model), ("DEEPSEEK_API_KEY", key)):
        template = re.sub(rf"^{name}=.*$", lambda match: f"{name}='{value}'", template, flags=re.M)
    descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w") as output:
        output.write(template)
    print("[*] 已创建权限为 600 的 .env；凭据不会上传到 GitHub")


if __name__ == "__main__":
    try:
        main()
    except (EOFError, KeyboardInterrupt):
        sys.exit("\n已取消配置")
