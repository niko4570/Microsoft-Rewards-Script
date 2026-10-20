#!/usr/bin/env python3
"""Preview known user caches; delete only with --apply. No third-party dependencies."""

import argparse
import os
from pathlib import Path
import shutil
import subprocess
import sys


def size_bytes(path):
    total = 0
    for directory, _, files in os.walk(path, followlinks=False):
        for name in files:
            entry = Path(directory) / name
            try:
                if not entry.is_symlink():
                    total += entry.stat().st_size
            except FileNotFoundError:
                pass
    return total


def main():
    parser = argparse.ArgumentParser(description="清理 WSL 常见工具缓存；默认只预览。")
    parser.add_argument("--apply", action="store_true", help="实际删除缓存")
    parser.add_argument("--apt", action="store_true", help="同时清理 APT 下载缓存（执行时需要 sudo）")
    args = parser.parse_args()
    if os.geteuid() == 0:
        parser.error("请以普通用户运行；APT 清理会单独调用 sudo。")
    home = Path.home().resolve()
    cache = Path(os.environ.get("XDG_CACHE_HOME") or home / ".cache")
    candidates = [cache / name for name in ("pip", "uv", "yarn", "pnpm", "go-build", "ruff")]
    candidates += [home / ".npm" / "_cacache"]
    if args.apt:
        candidates.append(Path("/var/cache/apt/archives"))
    failed = False
    total = 0
    print("执行模式" if args.apply else "预览模式：未删除任何文件（添加 --apply 执行）")
    for path in candidates:
        apt = path == Path("/var/cache/apt/archives")
        try:
            if not path.exists():
                continue
            if path.is_symlink() or (not apt and not path.resolve().is_relative_to(home)):
                print(f"跳过链接或用户目录外路径：{path}")
                continue
            size = size_bytes(path)
            total += size
            print(f"{size / 1024 ** 2:10.1f} MiB  {path}")
            if args.apply:
                if apt:
                    subprocess.run(["sudo", "apt-get", "clean"], check=True)
                else:
                    # Keep the cache root and its permissions; unlink symlinks rather than following them.
                    for entry in path.iterdir():
                        if entry.is_symlink() or not entry.is_dir():
                            entry.unlink(missing_ok=True)
                        else:
                            shutil.rmtree(entry)
        except (OSError, subprocess.CalledProcessError) as error:
            failed = True
            print(f"清理或检查失败：{path}: {error}", file=sys.stderr)
    print(f"扫描到的缓存文件大小合计：{total / 1024 ** 3:.2f} GiB")
    if args.apply:
        print("缓存清理结束。删除文件不会自动缩小 Windows 上的 ext4.vhdx。")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
