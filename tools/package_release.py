#!/usr/bin/env python3
import hashlib
import json
import os
import shutil
import subprocess
import tarfile
import tempfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CUSTOM_SOURCE = [
    "app/api/scoped-edit/route.ts",
    "lib/edit-diagram-tool.ts",
    "lib/model-request.ts",
    "lib/scoped-edit.ts",
    "lib/scoped-rules.ts",
    "tests/unit/scoped-edit-route.test.ts",
    "tests/unit/scoped-edit.test.ts",
    "tests/unit/scoped-rules.test.ts",
]
DEPLOY_FILES = [
    "README.md", "DEPLOY.md", "deploy-report.md", "deploy.sh", "setup.sh", "install-env.sh",
    "docker-compose.yml", ".env.example", ".gitignore",
    "docs/ARCHITECTURE.md", "docs/USAGE.md",
    "tools/gen-override.py", "tools/gen_drawio_custom.py",
    "tools/deploy_check.py", "tools/package_release.py", "tools/setup_config.py",
    "tests/test_setup.py",
    "drawio-custom/PreConfig.js", "drawio-custom/PreConfig.image-orig.js",
    "drawio-custom/image.lock.json", "drawio-custom/plugins/ai-scope.js",
]


def source_files():
    checkout = ROOT / "upstream"
    if (checkout / ".git").exists():
        revision = subprocess.check_output(
            ["git", "-C", str(checkout), "rev-parse", "HEAD"], text=True
        ).strip()
        tracked = subprocess.check_output(
            ["git", "-C", str(checkout), "ls-files", "-z"], text=True
        ).rstrip("\0").split("\0")
        unknown = set(subprocess.check_output(
            ["git", "-C", str(checkout), "ls-files", "--others", "--exclude-standard", "-z"], text=True
        ).rstrip("\0").split("\0")) - set(CUSTOM_SOURCE) - {""}
        if unknown:
            raise RuntimeError("存在未列入交付清单的源码，请先审核: " + ", ".join(sorted(unknown)))
        return revision, sorted(set(tracked) | set(CUSTOM_SOURCE))
    manifest = json.loads((ROOT / "release-manifest.json").read_text())
    return manifest["upstream_commit"], [
        name.removeprefix("upstream/") for name in manifest["files"] if name.startswith("upstream/")
    ]


def main():
    revision, sources = source_files()
    paths = DEPLOY_FILES + ["upstream/" + name for name in sources]
    forbidden = {".git", "node_modules", ".next", "data", "logs", "__pycache__"}
    secrets = []
    if (ROOT / ".env").exists():
        for line in (ROOT / ".env").read_text().splitlines():
            key, separator, value = line.partition("=")
            if separator and any(token in key.upper() for token in ("KEY", "PASSWORD", "TOKEN", "ACCESS_CODE")):
                value = value.strip().strip('"').strip("'")
                if len(value) >= 8:
                    secrets.append(value.encode())
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    destination = ROOT / "releases"
    destination.mkdir(exist_ok=True)
    archive = destination / f"next-ai-draw-io-scoped-{stamp}.tar.gz"
    with tempfile.TemporaryDirectory(prefix="drawio-release-") as staging:
        bundle = Path(staging) / "next-ai-draw-io"
        for relative in paths:
            path = Path(relative)
            if path.is_absolute() or ".." in path.parts or forbidden.intersection(path.parts):
                raise RuntimeError("交付路径不允许: " + relative)
            if path.name.startswith(".env") and path.name != ".env.example":
                raise RuntimeError("禁止打包运行配置: " + relative)
            source = ROOT / path
            if source.is_symlink() or not source.is_file():
                raise RuntimeError("交付文件缺失或为符号链接: " + relative)
            content = source.read_bytes()
            if any(secret in content for secret in secrets):
                raise RuntimeError("交付文件包含本地凭据，已停止: " + relative)
            target = bundle / path
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
        environment = dict(os.environ, AI_SCOPE_ENDPOINT="http://localhost:3000", PYTHONDONTWRITEBYTECODE="1")
        subprocess.run(["python3", str(bundle / "tools/gen_drawio_custom.py"), "build"], check=True, env=environment, stdout=subprocess.DEVNULL)
        manifest = {
            "created_at": stamp,
            "upstream_url": "https://github.com/DayuanJiang/next-ai-draw-io",
            "upstream_commit": revision,
            "variant": "scoped-edit",
            "files": {
                name: hashlib.sha256((bundle / name).read_bytes()).hexdigest()
                for name in sorted(paths)
            },
        }
        (bundle / "release-manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")
        with tarfile.open(archive, "w:gz") as output:
            output.add(bundle, arcname="next-ai-draw-io")
    checksum = hashlib.sha256(archive.read_bytes()).hexdigest()
    archive.with_suffix(archive.suffix + ".sha256").write_text(f"{checksum}  {archive.name}\n")
    print(f"部署包: {archive}\n校验文件: {archive}.sha256")
    print(f"共 {len(paths)} 个文件；不含 .env、数据、日志、依赖、Git 历史和实验目录。")


if __name__ == "__main__":
    main()
