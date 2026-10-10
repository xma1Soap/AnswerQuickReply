#!/usr/bin/env python3
"""Validate a local export, back up the previous file, then atomically replace it."""

import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import os
from pathlib import Path
import sys
import tempfile
import uuid

from archive import ArchiveError, parse_archive, read_bounded


@contextmanager
def update_lock(destination):
    # Kernel locks release even if an updater crashes. The harmless lock file stays.
    with destination.with_name(destination.name + ".lock").open("a+b") as lock:
        if os.name == "nt":
            import msvcrt
            lock.seek(0)
            if not lock.read(1):
                lock.write(b"0")
                lock.flush()
            lock.seek(0)
            msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            yield
        finally:
            if os.name == "nt":
                lock.seek(0)
                msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(lock, fcntl.LOCK_UN)


def _sync_directory(path):
    if os.name == "posix":
        descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)


def atomic_write(destination, raw, owner=None, mode=None):
    descriptor, temporary = tempfile.mkstemp(prefix="." + destination.name + ".", suffix=".tmp", dir=destination.parent)
    try:
        with os.fdopen(descriptor, "wb") as output:
            output.write(raw)
            output.flush()
            if owner is not None and os.name == "posix":
                os.fchown(output.fileno(), owner.st_uid, owner.st_gid)
            if mode is not None:
                os.chmod(temporary, mode)
            os.fsync(output.fileno())
        os.replace(temporary, destination)
        _sync_directory(destination.parent)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def update_library(source, destination, backup_dir=None, initial_only=False):
    source, destination = Path(source), Path(destination)
    if source.resolve() == destination.resolve():
        raise ValueError("Source and destination must differ.")
    raw = read_bounded(source)
    parse_archive(raw)  # No destination, lock or backup is touched before validation.
    if destination.is_symlink():
        raise ValueError("Destination must be a regular file, not a symlink.")
    backup = None
    with update_lock(destination):
        exists = destination.exists()
        if initial_only and exists:
            raise ValueError("Initial library already exists; it was not changed.")
        owner = destination.stat() if exists else None
        if exists:
            previous = read_bounded(destination)
            directory = Path(backup_dir) if backup_dir else destination.parent / "backups"
            directory.mkdir(mode=0o700, parents=True, exist_ok=True)
            stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
            backup = directory / (stamp + "-" + uuid.uuid4().hex[:8] + ".json")
            atomic_write(backup, previous)
        atomic_write(destination, raw, owner)
    return backup


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="Plugin-exported ArchiveV1 JSON; local file only.")
    parser.add_argument("--destination", type=Path, required=True)
    parser.add_argument("--backup-dir", type=Path)
    parser.add_argument("--initial-only", action="store_true", help="Fail if a destination already exists.")
    args = parser.parse_args()
    try:
        backup = update_library(args.source, args.destination, args.backup_dir, args.initial_only)
    except (OSError, ValueError, ArchiveError) as exc:
        print(str(exc) if isinstance(exc, ValueError) else "Update failed; check paths, permissions, free space and other updaters.", file=sys.stderr)
        return 1
    print("Library updated atomically." + (" Previous library backed up." if backup else " Initial empty or supplied library installed."))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
