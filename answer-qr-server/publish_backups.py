"""Keep recent publish snapshots and an independently retained UTC daily baseline."""

from datetime import datetime, timedelta, timezone
from pathlib import Path
import re
import stat


MAX_BACKUP_BYTES = 256 * 1024 * 1024
_NAME = re.compile(r"([0-9]{13})-[0-9a-f]{32}\.json")


def prune_publish_backups(directory, *, now=None, max_bytes=MAX_BACKUP_BYTES):
    """Return deleted snapshots; never delete the newest snapshot.

    Count rotation keeps the newest ten and the first snapshot of each of the
    last thirty UTC calendar days. The byte cap takes precedence when these
    exceed it: non-daily snapshots are removed first, then oldest daily ones.
    A single newest snapshot is retained even when it alone exceeds the cap.
    Unknown files and symlinks are never considered or removed.
    """
    directory = Path(directory)
    current = now or datetime.now(timezone.utc)
    if current.tzinfo is None:
        raise ValueError("The backup clock must have a timezone.")
    if type(max_bytes) is not int or max_bytes < 0:
        raise ValueError("The backup byte limit must be non-negative.")
    current = current.astimezone(timezone.utc)
    oldest_day = current.date() - timedelta(days=29)
    snapshots = []
    write_times = {}
    for path in directory.iterdir():
        match = _NAME.fullmatch(path.name)
        if match is None:
            continue
        metadata = path.lstat()
        if not stat.S_ISREG(metadata.st_mode):
            continue
        timestamp = int(match.group(1))
        day = datetime.fromtimestamp(timestamp / 1000, timezone.utc).date()
        snapshots.append((timestamp, path.name, path, metadata.st_size, day))
        write_times[path] = metadata.st_mtime_ns
    # Several snapshots can be written in one clock millisecond. UUID lexical
    # order does not identify the daily first; use immutable snapshot write time
    # as the tie-breaker, keeping the calendar date derived from the filename.
    snapshots.sort(key=lambda item: (item[0], write_times[item[2]], item[1]))
    if not snapshots:
        return []
    daily = {}
    for snapshot in snapshots:
        if oldest_day <= snapshot[4] <= current.date():
            daily.setdefault(snapshot[4], snapshot[2])
    protected = set(daily.values())
    newest = snapshots[-1][2]
    keep = protected | {item[2] for item in snapshots[-10:]}
    total = sum(item[3] for item in snapshots if item[2] in keep)
    removed = []
    for item in snapshots:
        if item[2] not in keep:
            item[2].unlink()
            removed.append(item[2])
    # Daily baselines outlive a burst of publishes, unless the byte cap forces
    # their removal. Every non-daily candidate is considered before any daily.
    candidates = sorted((item for item in snapshots if item[2] in keep and item[2] != newest),
                        key=lambda item: (item[2] in protected, item[0], write_times[item[2]], item[1]))
    for item in candidates:
        if total <= max_bytes:
            break
        item[2].unlink()
        total -= item[3]
        removed.append(item[2])
    return removed
