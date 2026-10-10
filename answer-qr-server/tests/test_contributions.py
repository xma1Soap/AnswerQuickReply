from contextlib import closing, contextmanager
from concurrent.futures import ThreadPoolExecutor
import copy
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlencode, urlsplit
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from archive import EMPTY_ARCHIVE, parse_archive
from configure_oauth import configure
from contributions import Contributions, CODE_MS, COOKIE_NAME, MAX_CALLBACK_FIELDS, MAX_CALLBACK_QUERY, MAX_COOKIE_HEADER, REJECTED_PAYLOAD_MS, SESSION_MS, STATE_MS, digest, DiscordIdentity
from server import create_server
from test_server import entry, image, request

ADMIN = "100000000000000009"
MEMBER = "123456789012345678"
OTHER = "223456789012345678"


class FakeIdentity:
    """Test provider only. No real OAuth login or outbound requests are performed."""
    def __init__(self):
        self.calls = []

    def verify(self, code, config):
        self.calls.append(code)
        return {"id": {"admin": ADMIN, "member": MEMBER, "other": OTHER}[code], "username": code}


class ContributionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.library = self.root / "library.json"
        self.library.write_bytes(EMPTY_ARCHIVE)
        self.config_path = self.root / "contributions.json"
        self.database = self.root / "contributions.sqlite3"
        self.config = {"publicBaseUrl": "https://api.starmint.cc.cd/answer-qr", "clientId": "333456789012345678",
                       "clientSecret": "test-only-client-secret", "reviewerIds": [ADMIN], "autoPublishIds": [ADMIN],
                       "databasePath": str(self.database)}
        self.write_config()
        self.now = 1791561600000
        self.identity = FakeIdentity()

    def write_config(self):
        self.config_path.write_text(json.dumps(self.config), encoding="utf-8")
        self.config_path.chmod(0o600)

    @contextmanager
    def running(self, configured=True):
        server = create_server(self.library, public=True, port=0, contributions_config=self.config_path if configured else None,
                               identity=self.identity, clock=lambda: self.now)
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
        body = json.dumps(data).encode() if data is not None else None
        status, headers, raw = request(server, method, path, headers, body)
        return status, headers, json.loads(raw) if raw else None

    def start_login(self, server):
        status, headers, _ = request(server, path="/auth/login")
        self.assertEqual(status, 302)
        self.assertTrue(headers["Location"].startswith("https://discord.com/oauth2/authorize?"))
        params = parse_qs(urlsplit(headers["Location"]).query)
        self.assertEqual(params["scope"], ["identify"])
        self.assertEqual(params["redirect_uri"], [self.config["publicBaseUrl"] + "/auth/callback"])
        for flag in ("Secure", "HttpOnly", "SameSite=Lax", "Path=/"):
            self.assertIn(flag, headers["Set-Cookie"])
        return params["state"][0], headers["Set-Cookie"].split(";")[0]

    def login_code(self, server, user="member"):
        state, cookie = self.start_login(server)
        status, headers, body = request(server, path="/auth/callback?" + urlencode({"code": user, "state": state}), headers={"Cookie": cookie})
        self.assertEqual(status, 200)
        self.assertIn("text/html", headers["Content-Type"])
        self.assertEqual(headers["Referrer-Policy"], "no-referrer")
        self.assertIn("frame-ancestors 'none'", headers["Content-Security-Policy"])
        self.assertIn("Max-Age=0", headers["Set-Cookie"])
        return re.search(rb"<code>([A-Za-z0-9_-]{43})</code>", body)[1].decode()

    def login(self, server, user="member"):
        code = self.login_code(server, user)
        status, _, profile = self.api(server, "/auth/exchange", "POST", {}, extra={"Authorization": "LoginCode " + code})
        self.assertEqual(status, 200)
        self.assertEqual(profile["user"]["id"], {"admin": ADMIN, "member": MEMBER, "other": OTHER}[user])
        return profile["token"], profile

    def submit(self, server, token, item=None, request_id=None):
        payload = {"entry": item or entry(), "requestId": request_id or str(uuid.uuid4())}
        return self.api(server, "/contributions", "POST", payload, token=token), payload

    def test_missing_credentials_disable_all_auth_and_writes_without_touching_db(self):
        self.config["clientId"] = self.config["clientSecret"] = ""
        self.write_config()
        with self.running() as server:
            status, _, body = self.api(server, "/contributions/status")
            self.assertEqual((status, body), (200, {"enabled": False, "loginUrl": self.config["publicBaseUrl"] + "/auth/login"}))
            self.assertEqual(request(server)[0], 200)
            for path, method in (("/auth/login", "GET"), ("/auth/callback?code=anything&state=anything", "GET"),
                                 ("/auth/exchange", "POST"), ("/auth/logout", "POST"), ("/contributions", "POST"),
                                 ("/contributions/me", "GET"), ("/contributions/" + str(uuid.uuid4()) + "/review", "POST")):
                status, _, body = self.api(server, path, method, {} if method == "POST" else None)
                self.assertEqual(status, 503)
                self.assertEqual(body["error"], "contributions_disabled")
            self.assertEqual(server.contributions.config["reviewerIds"], [ADMIN])
        self.assertFalse(self.database.exists())
        self.assertEqual(self.library.read_bytes(), EMPTY_ARCHIVE)
        self.assertFalse(self.identity.calls)

    def test_no_configuration_keeps_public_library_available(self):
        with self.running(configured=False) as server:
            self.assertEqual(self.api(server, "/contributions/status")[2]["enabled"], False)
            self.assertEqual(request(server)[0], 200)

    def test_state_cookie_binding_replay_and_one_time_header_exchange(self):
        with self.running() as server:
            state, cookie = self.start_login(server)
            path = "/auth/callback?" + urlencode({"code": "member", "state": state})
            self.assertEqual(request(server, path=path)[0], 400)
            status, _, body = request(server, path=path, headers={"Cookie": cookie})
            self.assertEqual(status, 200)
            code = re.search(rb"<code>([A-Za-z0-9_-]{43})</code>", body)[1].decode()
            self.assertEqual(request(server, path=path, headers={"Cookie": cookie})[0], 400)
            self.assertEqual(self.api(server, "/auth/exchange", "POST", {"code": code})[0], 401)
            self.assertEqual(self.api(server, "/auth/exchange", "POST", {"code": code}, extra={"Authorization": "LoginCode " + code})[0], 400)
            status, _, result = self.api(server, "/auth/exchange", "POST", {}, extra={"Authorization": "LoginCode " + code})
            self.assertEqual(status, 200)
            self.assertFalse(result["canReview"])
            self.assertFalse(result["canAutoPublish"])
            self.assertEqual(result["expiresAt"], self.now + SESSION_MS)
            self.assertEqual(self.api(server, "/auth/exchange", "POST", {}, extra={"Authorization": "LoginCode " + code})[0], 401)
            with closing(sqlite3.connect(self.database)) as db:
                stored = db.execute("SELECT key FROM sessions").fetchone()[0]
                self.assertEqual(stored, digest(result["token"]))
                self.assertEqual(db.execute("SELECT count(*) FROM codes").fetchone()[0], 0)
            self.assertNotIn(result["token"].encode(), self.database.read_bytes())
            self.assertNotIn(self.config["clientSecret"].encode(), self.database.read_bytes())

    def test_two_login_tabs_finish_in_either_order_without_overwriting_cookies(self):
        with self.running() as server:
            for order in ((0, 1), (1, 0)):
                flows = [self.start_login(server), self.start_login(server)]
                jar = dict(cookie.split("=", 1) for _, cookie in flows)
                self.assertEqual(len(jar), 2)
                for index in order:
                    state, own_cookie = flows[index]
                    path = "/auth/callback?" + urlencode({"code": "member", "state": state})
                    status, headers, _ = request(server, path=path, headers={"Cookie": "; ".join(name + "=" + value for name, value in jar.items())})
                    self.assertEqual(status, 200)
                    removed = headers["Set-Cookie"].split("=", 1)[0]
                    self.assertEqual(removed, own_cookie.split("=", 1)[0])
                    self.assertIn("Max-Age=0", headers["Set-Cookie"])
                    del jar[removed]
                self.assertEqual(jar, {})

    def test_target_cookie_is_strict_while_unrelated_site_cookies_are_ignored(self):
        with self.running() as server:
            state, cookie = self.start_login(server)
            name, secret = cookie.split("=", 1)
            path = "/auth/callback?" + urlencode({"code": "member", "state": state})
            invalid = [cookie + "; " + cookie, name + "=invalid", name, "large=" + "x" * MAX_COOKIE_HEADER + "; " + cookie]
            for value in invalid:
                status, _, raw = request(server, path=path, headers={"Cookie": value})
                self.assertEqual(status, 400)
                response = json.loads(raw)
                self.assertEqual(response["error"], "invalid_oauth_state")
                self.assertIn("Cookie", response["message"])
                self.assertNotIn(secret.encode(), raw)
                self.assertNotIn(state.encode(), raw)
            # A cookie belonging to another application can be large or use a
            # value SimpleCookie cannot parse. It must not break this login.
            unrelated = 'unrelated="unterminated; spare=value with spaces; long=' + "x" * 5000
            self.assertEqual(request(server, path=path, headers={"Cookie": unrelated + "; " + cookie})[0], 200)

    def test_legacy_flow_cookie_remains_valid_during_upgrade(self):
        with self.running() as server:
            state, cookie = self.start_login(server)
            # The persisted row/hash is identical to a login begun by the old
            # release; only its browser cookie name differs.
            legacy_cookie = COOKIE_NAME + "=" + cookie.split("=", 1)[1]
            path = "/auth/callback?" + urlencode({"code": "member", "state": state})
            status, headers, _ = request(server, path=path, headers={"Cookie": legacy_cookie})
            self.assertEqual(status, 200)
            self.assertTrue(headers["Set-Cookie"].startswith(COOKIE_NAME + "="))
            self.assertEqual(request(server, path=path, headers={"Cookie": legacy_cookie})[0], 400)

    def test_state_failures_explain_category_without_echoing_login_values(self):
        with self.running() as server:
            state, cookie = self.start_login(server)
            path = "/auth/callback?" + urlencode({"code": "member", "state": state})
            status, _, raw = request(server, path=path)
            self.assertEqual(status, 400)
            self.assertIn("未带回", json.loads(raw)["message"])
            wrong_cookie = cookie.split("=", 1)[0] + "=" + "x" * 43
            status, _, raw = request(server, path=path, headers={"Cookie": wrong_cookie})
            self.assertEqual(status, 400)
            self.assertIn("不一致", json.loads(raw)["message"])
            status, _, raw = request(server, path="/auth/callback?code=member", headers={"Cookie": cookie})
            self.assertEqual(status, 400)
            self.assertIn("缺少", json.loads(raw)["message"])
            status, _, raw = request(server, path=path + "&code=member", headers={"Cookie": cookie})
            self.assertEqual(status, 400)
            self.assertIn("参数无效", json.loads(raw)["message"])
            self.now += STATE_MS
            status, _, raw = request(server, path=path, headers={"Cookie": cookie})
            self.assertEqual(status, 400)
            self.assertIn("过期", json.loads(raw)["message"])
            self.assertNotIn(state.encode(), raw)
            self.assertNotIn(cookie.split("=", 1)[1].encode(), raw)
            self.assertFalse(self.identity.calls)

    def test_callback_ignores_bounded_extension_parameters_and_empty_separators(self):
        with self.running() as server:
            extensions = (
                "&integration_type=0&guild_id=example&permissions=0&response_extension=new",
                "&unknown_flag&empty_extension=&another=%E6%B5%8B%E8%AF%95",
                "&&&&",
                "&error_description=unused&error_uri=https%3A%2F%2Fexample.com%2Finfo",
            )
            for suffix in extensions:
                state, cookie = self.start_login(server)
                query = urlencode({"code": "member", "state": state}) + suffix
                status, _, body = request(server, path="/auth/callback?" + query, headers={"Cookie": cookie})
                self.assertEqual(status, 200)
                self.assertIn(b"<code>", body)
            state, cookie = self.start_login(server)
            query = urlencode({"error": "access_denied", "state": state}) + "&error_uri=https%3A%2F%2Fexample.com&vendor=extension&flag&"
            status, _, body = request(server, path="/auth/callback?" + query, headers={"Cookie": cookie})
            self.assertEqual(status, 400)
            self.assertEqual(json.loads(body)["error"], "oauth_declined")
            self.assertEqual(len(self.identity.calls), len(extensions))

    def test_callback_rejects_ambiguous_invalid_or_unbounded_queries(self):
        with self.running() as server:
            state, cookie = self.start_login(server)
            base = urlencode({"code": "member", "state": state})
            invalid = (
                base + "&code=member", base + "&%63ode=member", base + "&state=" + state,
                base + "&error=access_denied", base + "&extra=1&extra=2",
                urlencode({"error": "access_denied", "state": state}) + "&error=access_denied",
                urlencode({"state": state}), urlencode({"code": "", "state": state}),
                urlencode({"error": "", "state": state}), "code&state=" + state,
                base + "&broken=%", base + "&broken=%ZZ", base + "&broken=%FF",
                base + "&broken=%C0%AF", base + "&broken=%ED%A0%80",
                base + "&large=" + "x" * MAX_CALLBACK_QUERY,
                base + "&" + "&".join("field" + str(index) + "=x" for index in range(MAX_CALLBACK_FIELDS)),
            )
            for query in invalid:
                with self.subTest(shape=query[:4], length=len(query)):
                    status, _, body = request(server, path="/auth/callback?" + query, headers={"Cookie": cookie})
                    self.assertEqual(status, 400)
                    result = json.loads(body)
                    self.assertEqual(result["error"], "invalid_oauth_state")
                    self.assertNotIn(state, result["message"])
                    self.assertFalse(self.identity.calls)
            # Rejected parsing did not consume the valid state or cookie.
            self.assertEqual(request(server, path="/auth/callback?" + base, headers={"Cookie": cookie})[0], 200)

    def test_expiry_logout_and_roles_come_from_verified_user(self):
        with self.running() as server:
            code = self.login_code(server)
            self.now += CODE_MS
            self.assertEqual(self.api(server, "/auth/exchange", "POST", {}, extra={"Authorization": "LoginCode " + code})[0], 401)
            token, profile = self.login(server, "admin")
            self.assertTrue(profile["canReview"])
            self.assertTrue(profile["canAutoPublish"])
            status, _, me = self.api(server, "/contributions/me", token=token)
            self.assertEqual(status, 200)
            self.assertNotIn("token", me)
            self.assertEqual(self.api(server, "/auth/logout", "POST", {}, token)[0], 200)
            self.assertEqual(self.api(server, "/contributions/me", token=token)[0], 401)
            token, _ = self.login(server)
            self.now += SESSION_MS
            self.assertEqual(self.api(server, "/contributions/me", token=token)[0], 401)

    def test_submit_idempotency_ownership_and_reviewer_approval(self):
        original = entry()
        self.library.write_text(json.dumps({"version": 1, "entries": [original]}), encoding="utf-8")
        with self.running() as server:
            member, _ = self.login(server)
            outsider, _ = self.login(server, "other")
            admin, _ = self.login(server, "admin")
            (status, _, submitted), payload = self.submit(server, member)
            self.assertEqual((status, submitted["status"]), (200, "pending"))
            self.assertEqual(self.api(server, "/contributions", "POST", payload, member)[2], submitted)
            changed = copy.deepcopy(payload)
            changed["entry"]["content"] = "different"
            self.assertEqual(self.api(server, "/contributions", "POST", changed, member)[0], 409)
            spoofed = {**payload, "submitterId": ADMIN}
            self.assertEqual(self.api(server, "/contributions", "POST", spoofed, member)[0], 400)
            path = "/contributions/" + submitted["id"]
            self.assertEqual(self.api(server, path, token=outsider)[0], 404)
            self.assertEqual(self.api(server, "/contributions/pending", token=member)[0], 403)
            detail = self.api(server, path, token=member)[2]["submission"]
            self.assertEqual(detail["submitterId"], MEMBER)
            self.assertNotEqual(detail["entry"]["id"], original["id"])
            self.assertEqual(len(self.api(server, "/contributions/pending", token=admin)[2]["submissions"]), 1)
            self.assertEqual(self.api(server, path + "/review", "POST", {"decision": "approve"}, member)[0], 403)
            approved = self.api(server, path + "/review", "POST", {"decision": "approve"}, admin)
            self.assertEqual((approved[0], approved[2]["status"]), (200, "published"))
            self.assertEqual(self.api(server, path + "/review", "POST", {"decision": "approve"}, admin)[0], 200)
            self.assertEqual(self.api(server, path + "/review", "POST", {"decision": "reject"}, admin)[0], 409)
            saved = parse_archive(self.library.read_bytes())["entries"]
            self.assertEqual(len(saved), 2)
            self.assertEqual(saved[0], original)
            self.assertEqual(self.api(server, path, token=member)[2]["submission"]["entry"], saved[1])
            with closing(sqlite3.connect(self.database)) as db:
                self.assertEqual(db.execute("SELECT entry_json,payload_bytes FROM submissions").fetchone(), (None, 0))
                self.assertEqual(db.execute("SELECT reviewer_id,decision FROM reviews").fetchone(), (ADMIN, "approve"))

    def test_whitelisted_user_auto_publishes_but_does_not_replace_existing_ids(self):
        with self.running() as server:
            token, _ = self.login(server, "admin")
            item = {**entry(), "images": [image()]}
            (status, _, submitted), payload = self.submit(server, token, item)
            self.assertEqual((status, submitted["status"]), (200, "published"))
            self.assertEqual(self.api(server, "/contributions", "POST", payload, token)[2], submitted)
            saved = parse_archive(self.library.read_bytes())["entries"]
            self.assertEqual(len(saved), 1)
            self.assertNotEqual(saved[0]["id"], item["id"])
            self.assertNotEqual(saved[0]["images"][0]["id"], item["images"][0]["id"])

    def test_concurrent_approvals_publish_once(self):
        with self.running() as server:
            member, _ = self.login(server)
            admin, _ = self.login(server, "admin")
            (status, _, submitted), _ = self.submit(server, member)
            self.assertEqual(status, 200)
            path = "/contributions/" + submitted["id"] + "/review"
            with ThreadPoolExecutor(max_workers=2) as pool:
                results = list(pool.map(lambda _: self.api(server, path, "POST", {"decision": "approve"}, admin), range(2)))
            self.assertEqual([result[0] for result in results], [200, 200])
            self.assertEqual(len(parse_archive(self.library.read_bytes())["entries"]), 1)
            with closing(sqlite3.connect(self.database)) as db:
                self.assertEqual(db.execute("SELECT count(*) FROM reviews").fetchone()[0], 1)

    def test_invalid_entries_body_limit_and_cors(self):
        with self.running() as server:
            token, _ = self.login(server)
            self.assertEqual(self.submit(server, token, {**entry(), "content": "x" * 4001})[0][0], 400)
            self.assertEqual(self.submit(server, token, {**entry(), "images": [{**image(), "dataUrl": "https://example.com/image"}]})[0][0], 400)
            self.assertEqual(self.submit(server, token, request_id="not-a-uuid")[0][0], 400)
            for origin in ("https://discord.com", "https://api.starmint.cc.cd"):
                status, headers, _ = request(server, "OPTIONS", "/contributions", {"Origin": origin,
                    "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "Authorization, Content-Type"})
                self.assertEqual(status, 204)
                self.assertEqual(headers["Access-Control-Allow-Origin"], origin)
            self.assertEqual(self.api(server, "/contributions", "POST", {}, token, {"Origin": "https://evil.example"})[0], 403)
            with patch("contributions.MAX_ARCHIVE_BYTES", 50):
                self.assertEqual(self.submit(server, token)[0][0], 413)
            self.assertEqual(parse_archive(self.library.read_bytes())["entries"], [])

    def test_rejection_retention_and_capacity_bounds(self):
        with self.running() as server:
            member, _ = self.login(server)
            admin, _ = self.login(server, "admin")
            with patch("contributions.MAX_USER_PENDING", 1):
                (status, _, submitted), payload = self.submit(server, member)
                self.assertEqual(status, 200)
                self.assertEqual(self.submit(server, member)[0][0], 429)
                self.assertEqual(self.api(server, "/contributions", "POST", payload, member)[0], 200)
            path = "/contributions/" + submitted["id"]
            self.assertEqual(self.api(server, path + "/review", "POST", {"decision": "reject", "reason": "\ud800"}, admin)[0], 400)
            rejected = self.api(server, path + "/review", "POST", {"decision": "reject", "reason": "请补充说明"}, admin)
            self.assertEqual(rejected[2]["status"], "rejected")
            self.assertEqual(self.api(server, path, token=member)[2]["submission"]["reason"], "请补充说明")
            self.now += REJECTED_PAYLOAD_MS + 1
            member, _ = self.login(server)
            self.assertEqual(self.api(server, path, token=member)[0], 410)
            self.assertEqual(self.api(server, "/contributions/mine", token=member)[2]["submissions"][0]["status"], "rejected")
            for field, maximum in (("MAX_PAYLOAD_BYTES", 0), ("MAX_SUBMISSIONS", 1), ("MAX_PENDING", 0)):
                with patch("contributions." + field, maximum):
                    self.assertEqual(self.submit(server, member)[0][0], 429)

    def test_crash_after_library_replace_recovers_without_duplicate_or_rejection(self):
        import contributions
        with self.running() as server:
            admin, _ = self.login(server, "admin")
            original_write = contributions.atomic_write
            def crash_after_replace(destination, raw, owner=None):
                original_write(destination, raw, owner)
                if destination == self.library:
                    raise OSError("simulated crash after replace")
            with patch("contributions.atomic_write", side_effect=crash_after_replace):
                response, payload = self.submit(server, admin)
                self.assertEqual(response[0], 503)
            with closing(sqlite3.connect(self.database)) as db:
                submission_id, status = db.execute("SELECT id,status FROM submissions").fetchone()
                self.assertEqual(status, "publishing")
            self.assertEqual(len(parse_archive(self.library.read_bytes())["entries"]), 1)
            self.assertEqual(self.api(server, "/contributions/" + submission_id + "/review", "POST", {"decision": "reject"}, admin)[0], 409)
            Contributions(self.library, self.config_path, self.identity, lambda: self.now)
            self.assertEqual(self.api(server, "/contributions", "POST", payload, admin)[2]["status"], "published")
            self.assertEqual(len(parse_archive(self.library.read_bytes())["entries"]), 1)
            with closing(sqlite3.connect(self.database)) as db:
                self.assertEqual(db.execute("SELECT status FROM submissions").fetchone()[0], "published")

    def test_crash_before_replace_and_bounded_publish_backups(self):
        import contributions
        with self.running() as server:
            admin, _ = self.login(server, "admin")
            original_write = contributions.atomic_write
            def crash_before_replace(destination, raw, owner=None):
                if destination == self.library:
                    raise OSError("simulated crash before replace")
                original_write(destination, raw, owner)
            with patch("contributions.atomic_write", side_effect=crash_before_replace):
                response, _ = self.submit(server, admin)
                self.assertEqual(response[0], 503)
            self.assertEqual(self.library.read_bytes(), EMPTY_ARCHIVE)
            Contributions(self.library, self.config_path, self.identity, lambda: self.now)
            self.assertEqual(len(parse_archive(self.library.read_bytes())["entries"]), 1)
            manual = self.root / "backups"
            manual.mkdir()
            (manual / "manual.json").write_bytes(EMPTY_ARCHIVE)
            for _ in range(11):
                self.now += 1
                self.assertEqual(self.submit(server, admin)[0][0], 200)
            self.assertEqual(len(list((self.root / "publish-backups").glob("*.json"))), 10)
            self.assertEqual((manual / "manual.json").read_bytes(), EMPTY_ARCHIVE)

    def test_configure_oauth_preserves_roles_and_does_not_overwrite_invalid_input(self):
        self.config["clientId"] = self.config["clientSecret"] = ""
        self.write_config()
        before = self.config_path.read_bytes()
        with self.assertRaises(ValueError):
            configure(self.config_path, "bad", "wrong format with spaces")
        self.assertEqual(self.config_path.read_bytes(), before)
        configure(self.config_path, "333456789012345678", "new-test-only-secret")
        result = json.loads(self.config_path.read_text(encoding="utf-8"))
        self.assertEqual(result["reviewerIds"], [ADMIN])
        self.assertEqual(result["autoPublishIds"], [ADMIN])
        self.assertEqual(result["publicBaseUrl"], self.config["publicBaseUrl"])
        self.assertEqual(result["clientSecret"], "new-test-only-secret")
        if os.name == "posix":
            self.assertEqual(self.config_path.stat().st_mode & 0o777, 0o640)

    def test_real_identity_adapter_uses_fixed_discord_endpoints_only(self):
        adapter = DiscordIdentity()
        with patch.object(adapter, "_json", side_effect=[{"token_type": "Bearer", "scope": "identify", "access_token": "test-only-access", "refresh_token": "never-persist"},
                                                        {"id": MEMBER, "username": "member"}]) as remote:
            user = adapter.verify("oauth-code", self.config)
            self.assertEqual(user, {"id": MEMBER, "username": "member"})
            self.assertEqual(remote.call_args_list[0].args[0], "https://discord.com/api/oauth2/token")
            self.assertEqual(remote.call_args_list[1].args[0], "https://discord.com/api/v10/users/@me")
            self.assertEqual(remote.call_args_list[1].kwargs["headers"], {"Authorization": "Bearer test-only-access"})
            self.assertNotIn("access_token", user)


if __name__ == "__main__":
    unittest.main()
