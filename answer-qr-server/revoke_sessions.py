#!/usr/bin/env python3
"""Revoke QR-service sessions as answerqr; no token or database rows are printed."""

import argparse
from contextlib import closing
import os
from pathlib import Path
import re
import sqlite3
import stat
import sys


def require_service_account():
    if os.name != "posix":
        raise ValueError("Run this tool on the VPS as the answerqr service account.")
    import pwd
    try:
        account = pwd.getpwnam("answerqr")
    except KeyError as exc:
        raise ValueError("The answerqr service account does not exist.") from exc
    if account.pw_uid == 0 or os.geteuid() != account.pw_uid:
        raise ValueError("Run as answerqr: sudo -u answerqr python3 -B revoke_sessions.py …")
    return account.pw_uid


def revoke_sessions(database, *, user=None, all_sessions=False):
    uid = require_service_account()
    if (user is None) == (not all_sessions):
        raise ValueError("Choose exactly one of --user or --all.")
    if user is not None and (not isinstance(user, str) or not re.fullmatch(r"[0-9]{17,20}", user)):
        raise ValueError("Discord user ID must contain 17–20 digits.")
    database = Path(database)
    metadata = database.lstat()
    if not stat.S_ISREG(metadata.st_mode):
        raise ValueError("The database must be an existing regular file, not a symlink.")
    if os.name == "posix" and metadata.st_uid != uid:
        raise ValueError("The database must be owned by answerqr; do not fix this by running as root.")
    # mode=rw prevents an accidental new database on a mistyped path. Values
    # are bound, including the administrator-supplied Discord user ID.
    with closing(sqlite3.connect(database.resolve().as_uri() + "?mode=rw", uri=True, timeout=5)) as db:
        with db:
            cursor = db.execute("DELETE FROM sessions") if all_sessions else db.execute(
                "DELETE FROM sessions WHERE user_id=?", (user,))
            return cursor.rowcount


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument("--user", help="Discord numeric user ID; revoke this user's every device.")
    target.add_argument("--all", action="store_true", dest="all_sessions", help="Revoke all sessions; everyone must log in again.")
    parser.add_argument("--database", type=Path, default=Path("/var/lib/answer-qr/contributions.sqlite3"))
    args = parser.parse_args()
    try:
        count = revoke_sessions(args.database, user=args.user, all_sessions=args.all_sessions)
    except (OSError, ValueError, sqlite3.Error) as exc:
        print(str(exc) if isinstance(exc, ValueError) else "Revocation failed; check the database path, ownership and service state.", file=sys.stderr)
        return 1
    print("Revoked sessions: " + str(count))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
