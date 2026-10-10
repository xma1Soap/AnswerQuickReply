#!/usr/bin/env python3
"""Root-terminal OAuth configuration; the client secret is never a CLI argument."""

import argparse
import getpass
import json
import os
from pathlib import Path
import re
import sys

from contributions import load_config
from update_library import atomic_write


def configure(path, client_id, client_secret):
    path = Path(path)
    if path.is_symlink() or not path.is_file():
        raise ValueError("Existing configuration must be a regular file.")
    if not re.fullmatch(r"[0-9]{17,20}", client_id) or not re.fullmatch(r"[A-Za-z0-9._-]{1,256}", client_secret):
        raise ValueError("Application ID or client secret has an invalid format.")
    previous = path.stat()
    with path.open("rb") as source:
        raw = source.read(16385)
    if len(raw) > 16384:
        raise ValueError("Configuration is too large.")
    config = json.loads(raw.decode("utf-8"))
    if not isinstance(config, dict):
        raise ValueError("Invalid existing configuration.")
    config.update(clientId=client_id, clientSecret=client_secret)
    # Validate everything before replacing the real root-managed file.
    temporary = path.with_name(".oauth-check-" + os.urandom(8).hex() + ".json")
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
        print("请在 VPS 的 root 终端运行此工具。", file=sys.stderr)
        return 1
    try:
        client_id = input("Discord Application ID: ").strip()
        client_secret = getpass.getpass("Discord Client Secret（隐藏输入）: ").strip()
        configure(args.config, client_id, client_secret)
    except (OSError, ValueError, EOFError, KeyboardInterrupt):
        print("配置未完成，请检查输入格式、现有配置与权限；密钥不会打印。", file=sys.stderr)
        return 1
    print("OAuth 配置已保存，角色与地址设置已保留。请执行：systemctl restart answer-qr")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
