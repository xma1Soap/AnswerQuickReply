"""Maintenance hardening and backup retention; only temporary data is used."""

from contextlib import closing, redirect_stderr
from datetime import datetime, timedelta, timezone
import io
import json
import os
from pathlib import Path
import sqlite3
import stat
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from archive import EMPTY_ARCHIVE
import configure_bot
from publish_backups import prune_publish_backups
import revoke_sessions
import update_library as updater
import test_role_gating as roles
from test_server import entry


class OperationsSecurityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.library = self.root / "library.json"
        self.library.write_bytes(EMPTY_ARCHIVE)
        self.source = self.root / "new.json"
        self.source.write_text(json.dumps({"version": 1, "entries": [entry()]}), encoding="utf-8")
        self.now = datetime(2026, 10, 11, 12, tzinfo=timezone.utc)

    def snapshot(self, directory, at, raw=b"snapshot"):
        directory.mkdir(exist_ok=True)
        path = directory / (str(int(at.timestamp() * 1000)) + "-" + uuid.uuid4().hex + ".json")
        path.write_bytes(raw)
        return path

    def symlink(self, target, link, directory=False):
        try:
            link.symlink_to(target, target_is_directory=directory)
        except OSError:
            if os.name == "nt":
                self.skipTest("Windows process lacks symbolic-link creation rights; Linux must run this test.")
            raise

    def test_publish_burst_retains_first_clean_backup_of_utc_day(self):
        directory = self.root / "publish-backups"
        paths = [self.snapshot(directory, self.now + timedelta(seconds=i)) for i in range(21)]
        prune_publish_backups(directory, now=self.now + timedelta(minutes=1))
        self.assertTrue(paths[0].exists())
        self.assertEqual(set(directory.iterdir()), {paths[0], *paths[-10:]})

    def test_same_millisecond_publish_order_uses_snapshot_write_time(self):
        directory = self.root / "publish-backups"
        paths = [self.snapshot(directory, self.now, b"clean" if i == 0 else b"changed") for i in range(21)]
        for i, path in enumerate(paths):
            os.utime(path, ns=(1_700_000_000_000_000_000 + i * 1_000_000, 1_700_000_000_000_000_000 + i * 1_000_000))
        prune_publish_backups(directory, now=self.now)
        self.assertEqual(set(directory.iterdir()), {paths[0], *paths[-10:]})
        self.assertEqual(paths[0].read_bytes(), b"clean")

    def test_publish_cross_day_rotation_keeps_30_daily_firsts_and_newest_10(self):
        directory = self.root / "publish-backups"
        daily = []
        latest = []
        for days_ago in range(39, -1, -1):
            at = self.now - timedelta(days=days_ago)
            paths = [self.snapshot(directory, at + timedelta(seconds=i)) for i in range(12)]
            daily.append(paths[0])
            latest = paths
        prune_publish_backups(directory, now=self.now + timedelta(minutes=1))
        self.assertEqual(set(directory.iterdir()), {*daily[-30:], *latest[-10:]})
        self.assertFalse(any(path.exists() for path in daily[:-30]))

    def test_publish_daily_retention_uses_utc_not_local_timezone(self):
        directory = self.root / "publish-backups"
        early = self.snapshot(directory, datetime(2026, 10, 10, 0, tzinfo=timezone.utc))
        for i in range(12):
            self.snapshot(directory, datetime(2026, 10, 10, 12, tzinfo=timezone.utc) + timedelta(seconds=i))
        prune_publish_backups(directory, now=datetime(2026, 10, 11, 1, tzinfo=timezone(timedelta(hours=8))))
        self.assertTrue(early.exists())

    def test_publish_size_cap_removes_non_daily_before_daily_and_keeps_newest(self):
        directory = self.root / "publish-backups"
        first = self.snapshot(directory, self.now, b"123456")
        middle = self.snapshot(directory, self.now + timedelta(seconds=1), b"123456")
        newest = self.snapshot(directory, self.now + timedelta(seconds=2), b"123456")
        prune_publish_backups(directory, now=self.now, max_bytes=12)
        self.assertEqual(set(directory.iterdir()), {first, newest})
        self.assertFalse(middle.exists())
        older = self.snapshot(directory, self.now - timedelta(days=1), b"123456")
        prune_publish_backups(directory, now=self.now, max_bytes=6)
        self.assertEqual(set(directory.iterdir()), {newest})
        self.assertFalse(older.exists())
        prune_publish_backups(directory, now=self.now, max_bytes=0)
        self.assertTrue(newest.exists())

    def test_publish_rotation_does_not_touch_unknown_files_or_symlinks(self):
        directory = self.root / "publish-backups"
        newest = self.snapshot(directory, self.now)
        unknown = directory / "operator-backup.json"
        unknown.write_bytes(b"manual")
        target = self.root / "outside.json"
        target.write_bytes(b"outside")
        link = directory / (str(int((self.now - timedelta(days=40)).timestamp() * 1000)) + "-" + "a" * 32 + ".json")
        self.symlink(target, link)
        prune_publish_backups(directory, now=self.now, max_bytes=0)
        self.assertTrue(newest.exists())
        self.assertTrue(link.is_symlink())
        self.assertEqual((unknown.read_bytes(), target.read_bytes()), (b"manual", b"outside"))

    def test_update_refuses_symlink_lock_without_writing_any_file(self):
        target = self.root / "untouched"
        target.write_bytes(b"outside")
        self.symlink(target, self.root / "library.json.lock")
        before = {path.name for path in self.root.iterdir()}
        with self.assertRaises((OSError, ValueError)):
            updater.update_library(self.source, self.library)
        self.assertEqual(self.library.read_bytes(), EMPTY_ARCHIVE)
        self.assertEqual(target.read_bytes(), b"outside")
        self.assertEqual({path.name for path in self.root.iterdir()}, before)

    def test_update_refuses_symlink_backup_directory_before_creating_lock(self):
        external = self.root / "external"
        external.mkdir()
        self.symlink(external, self.root / "backups", directory=True)
        before = {path.name for path in self.root.iterdir()}
        with self.assertRaises(ValueError):
            updater.update_library(self.source, self.library)
        self.assertEqual(list(external.iterdir()), [])
        self.assertEqual(self.library.read_bytes(), EMPTY_ARCHIVE)
        self.assertEqual({path.name for path in self.root.iterdir()}, before)

    def test_update_refuses_regular_file_in_place_of_backup_directory(self):
        (self.root / "backups").write_bytes(b"untouched")
        with self.assertRaises(ValueError):
            updater.update_library(self.source, self.library)
        self.assertFalse((self.root / "library.json.lock").exists())
        self.assertEqual((self.root / "backups").read_bytes(), b"untouched")

    def test_backup_directory_swap_cannot_redirect_a_posix_write(self):
        if os.name != "posix":
            self.skipTest("Pinned-directory descriptor support is a POSIX deployment guarantee.")
        directory, external = self.root / "backups", self.root / "external"
        directory.mkdir()
        external.mkdir()
        real_open = os.open
        def swap(path, flags, *args, **kwargs):
            if Path(path) == directory:
                directory.rename(self.root / "old-backups")
                directory.symlink_to(external, target_is_directory=True)
            return real_open(path, flags, *args, **kwargs)
        with patch.object(updater.os, "open", side_effect=swap), self.assertRaises(OSError):
            updater.update_library(self.source, self.library)
        self.assertEqual(list(external.iterdir()), [])
        self.assertEqual(self.library.read_bytes(), EMPTY_ARCHIVE)

    def test_root_update_prints_service_account_warning(self):
        if os.name != "posix":
            self.skipTest("The root warning is Linux/POSIX-specific.")
        output = io.StringIO()
        argv = ["update_library.py", str(self.source), "--destination", str(self.library)]
        with patch.object(sys, "argv", argv), patch.object(updater.os, "geteuid", return_value=0), redirect_stderr(output):
            self.assertEqual(updater.main(), 0)
        self.assertIn("sudo -u answerqr", output.getvalue())

    def config(self):
        return {"publicBaseUrl": "https://qr.example.org/answer-qr", "clientId": "333456789012345678",
                "clientSecret": "dummy-existing-secret", "guildId": roles.GUILD, "libraryRoleIds": [roles.ROLE],
                "reviewerIds": [roles.ADMIN], "autoPublishIds": [roles.MEMBER],
                "databasePath": str(self.root / "contributions.sqlite3"), "roleProofHours": 24, "publishesPerHour": 30}

    def test_hidden_bot_configuration_preserves_all_other_fields_and_owner(self):
        path = self.root / "contributions.json"
        original = self.config()
        path.write_text(json.dumps(original), encoding="utf-8")
        path.chmod(0o600)
        previous = path.stat()
        configure_bot.configure(path, "dummy-bot-token-" + "x" * 40)
        configured = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(configured, {**original, "botToken": "dummy-bot-token-" + "x" * 40})
        if os.name == "posix":
            self.assertEqual((path.stat().st_uid, path.stat().st_gid), (previous.st_uid, previous.st_gid))
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o640)
        self.assertEqual(list(self.root.glob(".bot-check-*")), [])

    def test_invalid_bot_configuration_never_replaces_existing_file(self):
        path = self.root / "contributions.json"
        original = self.config()
        path.write_text(json.dumps(original), encoding="utf-8")
        before = path.read_bytes()
        with self.assertRaises(ValueError):
            configure_bot.configure(path, "not a token")
        self.assertEqual(path.read_bytes(), before)
        original["guildId"] = ""
        original["libraryRoleIds"] = []
        path.write_text(json.dumps(original), encoding="utf-8")
        before = path.read_bytes()
        with self.assertRaises(ValueError):
            configure_bot.configure(path, "x" * 60)
        self.assertEqual(path.read_bytes(), before)
        self.assertEqual(list(self.root.glob(".bot-check-*")), [])

    def test_revocation_rejects_non_service_account_before_database_access(self):
        missing = self.root / "never-create.sqlite3"
        with patch.object(revoke_sessions, "require_service_account", side_effect=ValueError("service account only")):
            with self.assertRaises(ValueError):
                revoke_sessions.revoke_sessions(missing, all_sessions=True)
        self.assertFalse(missing.exists())

    def test_service_account_guard_rejects_root_and_other_uids(self):
        for account_uid, current_uid, allowed in ((1001, 0, False), (1001, 1002, False), (0, 0, False), (1001, 1001, True)):
            with self.subTest(account_uid=account_uid, current_uid=current_uid):
                fake_pwd = SimpleNamespace(getpwnam=lambda name: SimpleNamespace(pw_uid=account_uid))
                fake_os = SimpleNamespace(name="posix", geteuid=lambda: current_uid)
                with patch.dict(sys.modules, {"pwd": fake_pwd}), patch.object(revoke_sessions, "os", fake_os):
                    if allowed:
                        self.assertEqual(revoke_sessions.require_service_account(), account_uid)
                    else:
                        with self.assertRaises(ValueError):
                            revoke_sessions.require_service_account()

    def test_revocation_refuses_missing_database_and_symlink(self):
        missing = self.root / "missing.sqlite3"
        uid = self.library.stat().st_uid
        with patch.object(revoke_sessions, "require_service_account", return_value=uid):
            with self.assertRaises(FileNotFoundError):
                revoke_sessions.revoke_sessions(missing, all_sessions=True)
            self.assertFalse(missing.exists())
            link = self.root / "linked.sqlite3"
            self.symlink(self.library, link)
            with self.assertRaises(ValueError):
                revoke_sessions.revoke_sessions(link, all_sessions=True)
            self.assertEqual(self.library.read_bytes(), EMPTY_ARCHIVE)

    def test_revocation_bound_user_id_and_all_counts(self):
        database = self.root / "sessions.sqlite3"
        with closing(sqlite3.connect(database)) as db, db:
            db.execute("CREATE TABLE sessions (key TEXT, user_id TEXT)")
            db.executemany("INSERT INTO sessions VALUES (?,?)", [("a", roles.MEMBER), ("b", roles.MEMBER), ("c", roles.ADMIN)])
        uid = database.stat().st_uid
        with patch.object(revoke_sessions, "require_service_account", return_value=uid):
            with self.assertRaises(ValueError):
                revoke_sessions.revoke_sessions(database, user="1' OR 1=1 --")
            self.assertEqual(revoke_sessions.revoke_sessions(database, user=roles.MEMBER), 2)
            self.assertEqual(revoke_sessions.revoke_sessions(database, user=roles.MEMBER), 0)
            self.assertEqual(revoke_sessions.revoke_sessions(database, all_sessions=True), 1)


class SessionRevocationEndpointTests(unittest.TestCase):
    setUp = roles.RoleGatingTests.setUp
    write_config = roles.RoleGatingTests.write_config
    running = roles.RoleGatingTests.running
    api = roles.RoleGatingTests.api
    callback = roles.RoleGatingTests.callback
    login = roles.RoleGatingTests.login
    read = roles.RoleGatingTests.read

    def test_admin_tool_revokes_every_device_and_all_protected_endpoints(self):
        with self.running() as server:
            first, _ = self.login(server)
            second, _ = self.login(server)
            other, _ = self.login(server, "admin")
            status, submission = self.api(server, "/contributions", "POST",
                                          {"entry": entry(), "requestId": str(uuid.uuid4())}, token=first)
            self.assertEqual(status, 200)
            database = server.contributions.database
            with patch.object(revoke_sessions, "require_service_account", return_value=database.stat().st_uid):
                self.assertEqual(revoke_sessions.revoke_sessions(database, user=roles.MEMBER), 2)
                for token in (first, second):
                    self.assertEqual(self.read(server, token)[0], 401)
                    self.assertEqual(self.api(server, "/contributions", "POST",
                        {"entry": entry(), "requestId": str(uuid.uuid4())}, token=token)[0], 401)
                    self.assertEqual(self.api(server, "/contributions/" + submission["id"], token=token)[0], 401)
                self.assertEqual(self.read(server, other)[0], 200)
                self.assertEqual(revoke_sessions.revoke_sessions(database, all_sessions=True), 1)
                self.assertEqual(self.read(server, other)[0], 401)


if __name__ == "__main__":
    unittest.main()
