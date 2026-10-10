"""Role-gated library access. Fake identity only; no real Discord requests."""

from contextlib import closing, contextmanager
import json
from pathlib import Path
import re
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlencode, urlsplit
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from archive import EMPTY_ARCHIVE
from contributions import ACCESS_RECHECK_MS, ApiError, DiscordIdentity, LOGIN_ACCESS_MS
from server import create_server
from test_server import entry, request

GUILD = "400000000000000001"
ROLE = "500000000000000001"
OTHER_ROLE = "500000000000000002"
ADMIN = "100000000000000001"
MEMBER = "100000000000000002"
OUTSIDER = "100000000000000003"
USERS = {"admin": ADMIN, "member": MEMBER, "outsider": OUTSIDER}


class FakeGuildIdentity:
    def __init__(self):
        self.roles = {ADMIN: [], MEMBER: [ROLE], OUTSIDER: [OTHER_ROLE]}
        self.bot_calls = 0

    def verify(self, code, config):
        user_id = USERS[code]
        return {"id": user_id, "username": code, "roles": list(self.roles[user_id])}

    def member_roles(self, user_id, config):
        self.bot_calls += 1
        return list(self.roles[user_id])


class RoleGatingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.library = root / "library.json"
        self.library.write_bytes(EMPTY_ARCHIVE)
        self.config_path = root / "contributions.json"
        self.config = {"publicBaseUrl": "https://qr.example.org/answer-qr", "clientId": "333456789012345678",
                       "clientSecret": "test-only-client-secret", "reviewerIds": [ADMIN], "autoPublishIds": [],
                       "databasePath": str(root / "contributions.sqlite3"), "guildId": GUILD, "libraryRoleIds": [ROLE]}
        self.write_config()
        self.now = 1791561600000
        self.identity = FakeGuildIdentity()

    def write_config(self):
        self.config_path.write_text(json.dumps(self.config), encoding="utf-8")
        self.config_path.chmod(0o600)

    @contextmanager
    def running(self, **options):
        server = create_server(self.library, port=0, contributions_config=self.config_path, identity=self.identity, clock=lambda: self.now, **options)
        thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        thread.start()
        try:
            yield server
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    def api(self, server, path, method="GET", data=None, token=None, extra=None):
        headers = {"Content-Type": "application/json", **(extra or {})}
        if token:
            headers["Authorization"] = "Bearer " + token
        status, _, raw = request(server, method, path, headers, json.dumps(data).encode() if data is not None else None)
        return status, json.loads(raw) if raw else None

    def callback(self, server, user):
        status, headers, _ = request(server, path="/auth/login")
        self.assertEqual(status, 302)
        params = parse_qs(urlsplit(headers["Location"]).query)
        self.assertEqual(params["scope"], ["identify guilds.members.read"])
        state, cookie = params["state"][0], headers["Set-Cookie"].split(";")[0]
        return request(server, path="/auth/callback?" + urlencode({"code": user, "state": state}), headers={"Cookie": cookie})

    def login(self, server, user="member"):
        status, _, body = self.callback(server, user)
        self.assertEqual(status, 200, body)
        code = re.search(rb"<code>([A-Za-z0-9_-]{43})</code>", body)[1].decode()
        status, profile = self.api(server, "/auth/exchange", "POST", {}, extra={"Authorization": "LoginCode " + code})
        self.assertEqual(status, 200)
        return profile["token"], profile

    def read(self, server, token=None):
        headers = {"Authorization": "Bearer " + token} if token else {}
        status, _, raw = request(server, headers=headers)
        return status, raw

    def test_library_requires_a_session_with_the_role(self):
        with self.running() as server:
            self.assertEqual(self.read(server)[0], 401)
            self.assertEqual(self.read(server, "x" * 43)[0], 401)
            token, profile = self.login(server)
            self.assertEqual(profile["libraryAccess"], "ok")
            status, raw = self.read(server, token)
            self.assertEqual((status, raw), (200, EMPTY_ARCHIVE))
            self.assertEqual(self.api(server, "/contributions/me", token=token)[1]["libraryAccess"], "ok")

    def test_users_without_the_role_get_no_login_code(self):
        with self.running() as server:
            status, _, body = self.callback(server, "outsider")
            self.assertEqual(status, 403)
            self.assertEqual(json.loads(body)["error"], "library_forbidden")
            status, headers, body = self.callback(server, "outsider")
            self.assertNotIn(b"<code>", body)

    def test_browser_callback_errors_are_readable_html(self):
        with self.running() as server:
            status, headers, _ = request(server, path="/auth/login")
            params = parse_qs(urlsplit(headers["Location"]).query)
            status, headers, body = request(server, path="/auth/callback?" + urlencode({"code": "outsider", "state": params["state"][0]}),
                                            headers={"Cookie": headers["Set-Cookie"].split(";")[0], "Accept": "text/html"})
            self.assertEqual(status, 403)
            self.assertIn("text/html", headers["Content-Type"])
            self.assertIn("答疑身份组".encode(), body)
            self.assertIn("default-src 'none'", headers["Content-Security-Policy"])

    def test_reviewers_are_allowed_without_the_role(self):
        with self.running() as server:
            token, profile = self.login(server, "admin")
            self.assertEqual(profile["libraryAccess"], "ok")
            self.assertEqual(self.read(server, token)[0], 200)

    def test_without_bot_token_login_proof_expires_and_session_is_revoked(self):
        with self.running() as server:
            token, _ = self.login(server)
            self.now += LOGIN_ACCESS_MS - 1
            self.assertEqual(self.read(server, token)[0], 200)
            self.now += 2
            status, raw = self.read(server, token)
            self.assertEqual((status, json.loads(raw)["error"]), (401, "access_recheck_required"))
            self.assertEqual(self.api(server, "/contributions/me", token=token)[0], 401)
            token, _ = self.login(server)
            self.assertEqual(self.read(server, token)[0], 200)
            self.assertEqual(self.identity.bot_calls, 0)

    def test_bot_token_rechecks_roles_and_revokes_removed_members(self):
        self.config["botToken"] = "b" * 70
        self.write_config()
        with self.running() as server:
            token, _ = self.login(server)
            self.identity.roles[MEMBER] = []
            self.assertEqual(self.read(server, token)[0], 200)  # cached proof still fresh
            self.now += ACCESS_RECHECK_MS
            status, raw = self.read(server, token)
            self.assertEqual((status, json.loads(raw)["error"]), (403, "library_forbidden"))
            status, body = self.api(server, "/contributions", "POST", {"entry": entry(), "requestId": str(uuid.uuid4())}, token=token)
            self.assertEqual((status, body["error"]), (403, "library_forbidden"))
            self.identity.roles[MEMBER] = [ROLE]
            self.now += ACCESS_RECHECK_MS
            self.assertEqual(self.read(server, token)[0], 200)
            self.assertGreaterEqual(self.identity.bot_calls, 2)

    def test_downloads_are_rate_limited_and_audited(self):
        self.config["libraryReadsPerHour"] = 2
        self.write_config()
        with self.running() as server:
            token, _ = self.login(server)
            self.assertEqual([self.read(server, token)[0] for _ in range(3)], [200, 200, 429])
            self.now += 60 * 60 * 1000 + 1
            self.assertEqual(self.read(server, token)[0], 200)
            import sqlite3
            with closing(sqlite3.connect(self.config["databasePath"])) as db:
                self.assertEqual(db.execute("SELECT count(*) FROM library_reads WHERE user_id=?", (MEMBER,)).fetchone()[0], 3)

    def test_ambiguous_or_open_configurations_refuse_to_start(self):
        with self.assertRaises(ValueError):
            create_server(self.library, public=True, port=0, contributions_config=self.config_path, identity=self.identity)
        with self.assertRaises(ValueError):
            create_server(self.library, token=b"t" * 32, port=0, contributions_config=self.config_path, identity=self.identity)
        self.config["clientSecret"] = ""
        self.write_config()
        with self.assertRaises(ValueError):
            create_server(self.library, port=0, contributions_config=self.config_path, identity=self.identity)
        with self.assertRaises(ValueError):
            create_server(self.library, port=0)
        for bad in ({"guildId": ""}, {"libraryRoleIds": []}, {"botToken": "short"}, {"libraryReadsPerHour": 0}, {"libraryRoleIds": ["abc"]}):
            config = {**self.config, "clientSecret": "test-only-client-secret", **bad}
            self.config_path.write_text(json.dumps(config), encoding="utf-8")
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                create_server(self.library, port=0, contributions_config=self.config_path, identity=self.identity)

    def test_real_identity_requires_member_scope_and_reads_roles(self):
        identity = DiscordIdentity()
        config = {**self.config, "botToken": ""}
        responses = [{"token_type": "Bearer", "scope": "identify", "access_token": "a"}]
        with patch.object(DiscordIdentity, "_json", side_effect=lambda *a, **k: responses.pop(0)):
            with self.assertRaises(ApiError):
                identity.verify("code", config)
        responses = [{"token_type": "Bearer", "scope": "guilds.members.read identify", "access_token": "a"},
                     {"id": MEMBER, "username": "member"}, {"roles": [ROLE]}]
        with patch.object(DiscordIdentity, "_json", side_effect=lambda *a, **k: responses.pop(0)):
            self.assertEqual(identity.verify("code", config)["roles"], [ROLE])
        responses = [{"token_type": "Bearer", "scope": "identify guilds.members.read", "access_token": "a"},
                     {"id": MEMBER, "username": "member"}, None]
        with patch.object(DiscordIdentity, "_json", side_effect=lambda *a, **k: responses.pop(0)):
            self.assertEqual(identity.verify("code", config)["roles"], [])
        with patch.object(DiscordIdentity, "_json", return_value={"roles": ["not-a-snowflake"]}):
            with self.assertRaises(ApiError):
                identity.member_roles(MEMBER, {**config, "botToken": "b" * 70})


if __name__ == "__main__":
    unittest.main()
