#!/usr/bin/env python3
"""Configure an optional Discord Bot using hidden server-terminal input."""

import argparse
import getpass
import json
import os
from pathlib import Path
import re
import stat
import sys

from contributions import load_config, strict_pairs
from update_library import atomic_write


def configure(path, bot_token):
    path = Path(path)
    previous = path.lstat()
    if not stat.S_ISREG(previous.st_mode):
        raise ValueError("Existing configuration must be a regular file, not a symlink.")
    if not isinstance(bot_token, str) or not re.fullmatch(r"[A-Za-z0-9._-]{30,256}", bot_token):
        raise ValueError("Bot token has an invalid format.")
    with path.open("rb") as source:
        raw = source.read(16385)
    if len(raw) > 16384:
        raise ValueError("Configuration is too large.")
    config = json.loads(raw.decode("utf-8"), object_pairs_hook=strict_pairs)
    if not isinstance(config, dict):
        raise ValueError("Invalid existing configuration.")
    config["botToken"] = bot_token
    temporary = path.with_name(".bot-check-" + os.urandom(8).hex() + ".json")
    try:
        with temporary.open("xb") as output:
            os.chmod(temporary, 0o600)
            output.write(json.dumps(config, ensure_ascii=False, indent=2).encode("utf-8"))
        library = Path(config.get("databasePath", "/var/lib/answer-qr/contributions.sqlite3")).parent / "library.json"
        load_config(temporary, library)
        atomic_write(path, temporary.read_bytes(), previous, mode=0o640)
    finally:
        temporary.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=Path("/etc/answer-qr/contributions.json"))
    args = parser.parse_args()
    if os.name != "posix" or os.geteuid() != 0:
        print("请在 VPS 的 root 终端运行此配置工具。", file=sys.stderr)
        return 1
    try:
        token = getpass.getpass("Discord Bot token（隐藏输入，不修改其他配置）: ").strip()
        configure(args.config, token)
    except (OSError, ValueError, EOFError, KeyboardInterrupt):
        print("配置未完成，请检查输入格式、身份组配置和权限；token 不会打印。", file=sys.stderr)
        return 1
    print("Bot 配置已保存，已有 OAuth、名单和复查时长已保留。请执行：systemctl restart answer-qr")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
