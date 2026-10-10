"""Discord OAuth sessions, role-gated library access, and authenticated QR contributions."""

from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import hmac
import html
import json
import os
from pathlib import Path
import re
import secrets
import sqlite3
import stat
import threading
import time
from urllib import error, parse, request
import uuid

from archive import ArchiveError, MAX_ARCHIVE_BYTES, parse_archive, read_bounded, validate_archive
from update_library import atomic_write, update_lock
from publish_backups import prune_publish_backups

DEFAULT_BASE = "https://api.starmint.cc.cd/answer-qr"
MAX_PAYLOAD_BYTES = 64 * 1024 * 1024
MAX_PENDING = 100
MAX_USER_PENDING = 10
MAX_SUBMISSIONS = 5000
SESSION_MS = 7 * 24 * 60 * 60 * 1000
PRIVILEGED_SESSION_MS = 24 * 60 * 60 * 1000
CODE_MS = 5 * 60 * 1000
STATE_MS = 10 * 60 * 1000
REJECTED_PAYLOAD_MS = 7 * 24 * 60 * 60 * 1000
# Role gating. With a bot token the server re-reads guild roles on this cadence, so a
# removed role stops library access within minutes. Without one, a login proves the
# roles only for LOGIN_ACCESS_MS and the user must log in again afterwards.
ACCESS_RECHECK_MS = 15 * 60 * 1000
ACCESS_DENIED_RECHECK_MS = 5 * 60 * 1000
LOGIN_ACCESS_MS = 24 * 60 * 60 * 1000
AUDIT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
HOUR_MS = 60 * 60 * 1000
MEMBER_SCOPE = "guilds.members.read"
COOKIE_NAME = "__Host-answer_qr_oauth"
MAX_COOKIE_HEADER = 16 * 1024
MAX_CALLBACK_QUERY = 8 * 1024
MAX_CALLBACK_FIELDS = 32
UUID_PATTERN = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
SUBMISSION_PATH = re.compile(r"^/contributions/(" + UUID_PATTERN + r")(/review)?$")
AUTO_LOGIN_PATH = re.compile(r"^/auth/auto/login/([A-Za-z0-9_-]{43})$")
AUTO_CONFIRM_PATH = re.compile(r"^/auth/auto/login/([A-Za-z0-9_-]{43})/confirm$")
AUTO_POLL_MS = 5000
MAX_LOGIN_ATTEMPTS = 5000
PAIR_COOKIE_NAME = "__Host-answer_qr_pair"


class ApiError(Exception):
    def __init__(self, status, code, message):
        self.status, self.code, self.message = status, code, message
        super().__init__(code)


def digest(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def json_bytes(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")


def strict_object(value, required, optional=()):
    if not isinstance(value, dict) or set(required) - set(value) or set(value) - set(required) - set(optional):
        raise ApiError(400, "invalid_request", "请求字段不正确。")
    return value


def strict_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON field")
        result[key] = value
    return result


def invalid_constant(_value):
    raise ValueError("non-finite JSON number")


def read_json(handler, limit=4096):
    lengths = handler.headers.get_all("Content-Length", [])
    if len(lengths) != 1 or not re.fullmatch(r"[0-9]{1,9}", lengths[0]) or handler.headers.get("Transfer-Encoding"):
        raise ApiError(400, "invalid_request", "请求必须提供唯一的内容长度。")
    size = int(lengths[0])
    if size >= limit:
        raise ApiError(413, "request_too_large", "提交内容过大，请精简图片和文字。")
    if handler.headers.get("Content-Type", "").split(";")[0].strip().lower() != "application/json":
        raise ApiError(415, "invalid_content_type", "请求必须使用 JSON。")
    try:
        raw = handler.rfile.read(size)
        if len(raw) != size:
            raise ValueError("incomplete request")
        return json.loads(raw.decode("utf-8"), object_pairs_hook=strict_pairs, parse_constant=invalid_constant)
    except (ValueError, RecursionError, OSError) as exc:
        raise ApiError(400, "invalid_json", "请求不是完整的有效 JSON。") from exc


def read_pairing_form(handler):
    lengths = handler.headers.get_all("Content-Length", [])
    if len(lengths) != 1 or not re.fullmatch(r"[0-9]{1,4}", lengths[0]) or handler.headers.get("Transfer-Encoding"):
        raise ApiError(400, "invalid_request", "配对确认请求无效。")
    size = int(lengths[0])
    if size > 4096:
        raise ApiError(413, "request_too_large", "配对确认请求过大。")
    if handler.headers.get("Content-Type", "").split(";")[0].strip().lower() != "application/x-www-form-urlencoded":
        raise ApiError(415, "invalid_content_type", "请在浏览器配对页面提交。")
    try:
        raw = handler.rfile.read(size)
        if len(raw) != size:
            raise ValueError()
        text = raw.decode("ascii")
        if re.search(r"%(?![0-9a-fA-F]{2})", text):
            raise ValueError()
        body = strict_pairs(parse.parse_qsl(text, keep_blank_values=True, strict_parsing=True, max_num_fields=2))
        return strict_object(body, ("nonce", "code"))
    except (ValueError, UnicodeError) as exc:
        raise ApiError(400, "invalid_request", "配对确认请求无效。") from exc


def header_token(handler, scheme):
    values = handler.headers.get_all("Authorization", [])
    if len(values) != 1:
        raise ApiError(401, "login_required", "请先使用 Discord 登录。")
    kind, separator, value = values[0].partition(" ")
    if kind != scheme or not separator or not re.fullmatch(r"[A-Za-z0-9_-]{43}", value):
        raise ApiError(401, "login_required", "登录凭据无效，请重新登录。")
    return value


class NoRedirect(request.HTTPRedirectHandler):
    def redirect_request(self, _request, _fp, _code, _message, _headers, _newurl):
        return None


class DiscordIdentity:
    """Only the official code exchange and identify endpoint; no client tokens."""
    def __init__(self):
        self.opener = request.build_opener(NoRedirect())

    def _json(self, url, data=None, headers=None, missing_ok=False):
        outbound = request.Request(url, data=data, headers={"User-Agent": "AnswerQuickReply/1.0", **(headers or {})})
        try:
            with self.opener.open(outbound, timeout=10) as response:
                if response.status != 200 or response.geturl() != url:
                    raise ValueError("unexpected OAuth response")
                raw = response.read(65537)
                if len(raw) > 65536:
                    raise ValueError("OAuth response too large")
                return json.loads(raw.decode("utf-8"))
        except error.HTTPError as exc:
            exc.close()
            if missing_ok and exc.code == 404:
                return None
            raise ApiError(502, "discord_unavailable", "Discord 身份验证暂时失败，请重新登录。") from exc
        except (OSError, ValueError, error.URLError) as exc:
            raise ApiError(502, "discord_unavailable", "Discord 身份验证暂时失败，请重新登录。") from exc

    def verify(self, code, config):
        data = parse.urlencode({"client_id": config["clientId"], "client_secret": config["clientSecret"],
                                "grant_type": "authorization_code", "code": code,
                                "redirect_uri": config["publicBaseUrl"] + "/auth/callback"}).encode("ascii")
        tokens = self._json("https://discord.com/api/oauth2/token", data, {"Content-Type": "application/x-www-form-urlencoded"})
        gated = bool(config.get("guildId") and config.get("libraryRoleIds"))
        expected_scope = {"identify", MEMBER_SCOPE} if gated else {"identify"}
        scope = tokens.get("scope") if isinstance(tokens, dict) else None
        if not isinstance(tokens, dict) or not isinstance(tokens.get("token_type"), str) or tokens["token_type"].lower() != "bearer" or not isinstance(scope, str) or set(scope.split()) != expected_scope:
            raise ApiError(502, "identity_unverified", "Discord 身份验证未完成，请重新登录。")
        access = tokens.get("access_token")
        if not isinstance(access, str) or not re.fullmatch(r"[A-Za-z0-9._-]{1,2048}", access):
            raise ApiError(502, "identity_unverified", "Discord 身份验证未完成，请重新登录。")
        user = self._json("https://discord.com/api/v10/users/@me", headers={"Authorization": "Bearer " + access})
        # Neither the access token nor refresh token is returned or persisted.
        if not isinstance(user, dict) or not isinstance(user.get("id"), str) or not re.fullmatch(r"[0-9]{17,20}", user["id"]) or not isinstance(user.get("username"), str) or not 1 <= len(user["username"]) <= 100:
            raise ApiError(502, "identity_unverified", "Discord 未返回有效用户身份。")
        result = {"id": user["id"], "username": user["username"]}
        if gated:
            # Roles come from Discord, never from the client. 404 = not in the guild.
            result["roles"] = self._roles(self._json("https://discord.com/api/v10/users/@me/guilds/" + config["guildId"] + "/member",
                                                     headers={"Authorization": "Bearer " + access}, missing_ok=True))
        return result

    def member_roles(self, user_id, config):
        """Re-read a member's roles with the bot token; [] when they left the guild."""
        return self._roles(self._json("https://discord.com/api/v10/guilds/" + config["guildId"] + "/members/" + user_id,
                                      headers={"Authorization": "Bot " + config["botToken"]}, missing_ok=True))

    @staticmethod
    def _roles(member):
        if member is None:
            return []
        roles = member.get("roles") if isinstance(member, dict) else None
        if not isinstance(roles, list) or len(roles) > 500 or any(not isinstance(role, str) or not re.fullmatch(r"[0-9]{17,20}", role) for role in roles):
            raise ApiError(502, "identity_unverified", "Discord 未返回有效的身份组信息，请重新登录。")
        return roles


def load_config(path, library_path):
    config = {"publicBaseUrl": DEFAULT_BASE, "clientId": "", "clientSecret": "", "reviewerIds": [],
              "autoPublishIds": [], "databasePath": str(Path(library_path).parent / "contributions.sqlite3"),
              "guildId": "", "libraryRoleIds": [], "botToken": "", "libraryReadsPerHour": 60,
              "publishesPerHour": 30, "roleProofHours": 24}
    if path is None:
        return config
    with Path(path).open("rb") as source:
        raw = source.read(16385)
    if len(raw) > 16384:
        raise ValueError("Contribution configuration is too large.")
    supplied = json.loads(raw.decode("utf-8"), object_pairs_hook=strict_pairs)
    if not isinstance(supplied, dict) or set(supplied) - set(config):
        raise ValueError("Invalid contribution configuration fields.")
    config.update(supplied)
    base = config["publicBaseUrl"]
    url = parse.urlsplit(base) if isinstance(base, str) else None
    if not url or url.scheme != "https" or not url.hostname or "@" in url.netloc or url.query or url.fragment or base.endswith("/") or re.search(r"[\\\x00-\x20\x7f]", base):
        raise ValueError("Contribution publicBaseUrl must be a fixed HTTPS URL.")
    for field in ("reviewerIds", "autoPublishIds", "libraryRoleIds"):
        if not isinstance(config[field], list) or len(config[field]) > 100 or any(not isinstance(value, str) or not re.fullmatch(r"[0-9]{17,20}", value) for value in config[field]):
            raise ValueError("Invalid Discord ID list in " + field + ".")
    if not isinstance(config["guildId"], str) or (config["guildId"] and not re.fullmatch(r"[0-9]{17,20}", config["guildId"])):
        raise ValueError("Invalid Discord guildId.")
    if bool(config["guildId"]) != bool(config["libraryRoleIds"]):
        raise ValueError("Role gating needs both guildId and libraryRoleIds.")
    if not isinstance(config["botToken"], str) or (config["botToken"] and not re.fullmatch(r"[A-Za-z0-9._-]{30,256}", config["botToken"])):
        raise ValueError("Invalid Discord bot token format.")
    if config["botToken"] and not config["guildId"]:
        raise ValueError("botToken is only used for role gating; set guildId and libraryRoleIds.")
    if type(config["libraryReadsPerHour"]) is not int or not 1 <= config["libraryReadsPerHour"] <= 10000:
        raise ValueError("libraryReadsPerHour must be an integer between 1 and 10000.")
    if type(config["publishesPerHour"]) is not int or not 1 <= config["publishesPerHour"] <= 10000:
        raise ValueError("publishesPerHour must be an integer between 1 and 10000.")
    if type(config["roleProofHours"]) is not int or not 1 <= config["roleProofHours"] <= 24:
        raise ValueError("roleProofHours must be an integer between 1 and 24.")
    if not isinstance(config["clientId"], str) or (config["clientId"] and not re.fullmatch(r"[0-9]{17,20}", config["clientId"])):
        raise ValueError("Invalid Discord OAuth client ID.")
    secret = config["clientSecret"]
    if not isinstance(secret, str) or (secret and not re.fullmatch(r"[A-Za-z0-9._-]{1,256}", secret)):
        raise ValueError("Invalid Discord OAuth client secret format.")
    if (secret or config["botToken"]) and os.name == "posix" and stat.S_IMODE(Path(path).stat().st_mode) & 0o027:
        raise ValueError("OAuth configuration must not be group-writable or accessible to others.")
    database = Path(config["databasePath"])
    if not database.is_absolute() or not database.resolve().is_relative_to(Path(library_path).resolve().parent):
        raise ValueError("Contribution database must be inside the library data directory.")
    return config


class Contributions:
    def __init__(self, library_path, config_path=None, identity=None, clock=None, published_entry=None):
        self.library_path = Path(library_path)
        self.config = load_config(config_path, library_path)
        self.enabled = bool(self.config["clientId"] and self.config["clientSecret"])
        # The library is role-gated only when OAuth is usable; otherwise reads fail closed.
        self.gated = bool(self.config["guildId"] and self.config["libraryRoleIds"])
        self.identity = identity or DiscordIdentity()
        self.clock = clock or (lambda: int(time.time() * 1000))
        self.lock = threading.RLock()
        self.body_slot = threading.BoundedSemaphore(1)
        self.database = Path(self.config["databasePath"])
        self.published_entry = published_entry
        self.origin = parse.urlsplit(self.config["publicBaseUrl"])
        self.origin = self.origin.scheme + "://" + self.origin.netloc
        if self.enabled:
            with self._db() as db:
                db.executescript("""
                    CREATE TABLE IF NOT EXISTS states (key TEXT PRIMARY KEY, cookie_hash TEXT NOT NULL, expires INTEGER NOT NULL);
                    CREATE TABLE IF NOT EXISTS codes (key TEXT PRIMARY KEY, user_id TEXT NOT NULL, username TEXT NOT NULL, expires INTEGER NOT NULL);
                    CREATE TABLE IF NOT EXISTS sessions (key TEXT PRIMARY KEY, user_id TEXT NOT NULL, username TEXT NOT NULL, expires INTEGER NOT NULL, created_at INTEGER NOT NULL);
                    CREATE TABLE IF NOT EXISTS submissions (
                        id TEXT PRIMARY KEY, submitter_id TEXT NOT NULL, username TEXT NOT NULL, request_id TEXT NOT NULL,
                        request_hash TEXT NOT NULL, entry_id TEXT NOT NULL, entry_json TEXT, payload_bytes INTEGER NOT NULL,
                        title TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','publishing','published','rejected')),
                        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, reason TEXT,
                        UNIQUE(submitter_id, request_id));
                    CREATE TABLE IF NOT EXISTS reviews (submission_id TEXT PRIMARY KEY, reviewer_id TEXT NOT NULL, decision TEXT NOT NULL, reason TEXT NOT NULL, created_at INTEGER NOT NULL);
                    CREATE INDEX IF NOT EXISTS submissions_status ON submissions(status, created_at);
                    CREATE INDEX IF NOT EXISTS submissions_owner ON submissions(submitter_id, created_at);
                    CREATE TABLE IF NOT EXISTS access (user_id TEXT PRIMARY KEY, allowed INTEGER NOT NULL, checked_at INTEGER NOT NULL);
                    CREATE TABLE IF NOT EXISTS library_reads (user_id TEXT NOT NULL, at INTEGER NOT NULL);
                    CREATE INDEX IF NOT EXISTS library_reads_user ON library_reads(user_id, at);
                    CREATE TABLE IF NOT EXISTS publication_limits (user_id TEXT NOT NULL, at INTEGER NOT NULL, submission_id TEXT PRIMARY KEY);
                    CREATE INDEX IF NOT EXISTS publication_limits_user ON publication_limits(user_id, at);
                    CREATE TABLE IF NOT EXISTS auto_logins (
                        id TEXT PRIMARY KEY, challenge TEXT NOT NULL, expected_user TEXT NOT NULL,
                        expires INTEGER NOT NULL, status TEXT NOT NULL, user_id TEXT, username TEXT,
                        message TEXT, last_poll INTEGER NOT NULL DEFAULT 0);
                    CREATE TABLE IF NOT EXISTS auto_states (state_key TEXT PRIMARY KEY, login_id TEXT NOT NULL);
                """)
                # Additive migration: existing submissions remain ordinary creates.
                columns = {row[1] for row in db.execute("PRAGMA table_info(submissions)")}
                for name, kind in (("target_id", "TEXT"), ("base_updated_at", "INTEGER")):
                    if name not in columns:
                        db.execute("ALTER TABLE submissions ADD COLUMN " + name + " " + kind)
                columns = {row[1] for row in db.execute("PRAGMA table_info(auto_logins)")}
                for name in ("pair_code", "pair_nonce_hash", "pair_cookie_hash"):
                    if name not in columns:
                        db.execute("ALTER TABLE auto_logins ADD COLUMN " + name + " TEXT")
                # Pre-pairing attempts cannot be carried forward into the new flow.
                db.execute("UPDATE auto_logins SET status='failed',message=? WHERE pair_code IS NULL AND status!='failed'",
                           ("请更新插件，或使用一次性登录码。",))
                self._cleanup(db)
            self.recover()

    @contextmanager
    def _db(self):
        db = sqlite3.connect(self.database, timeout=5)
        db.row_factory = sqlite3.Row
        try:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("PRAGMA synchronous=FULL")
            page_size = db.execute("PRAGMA page_size").fetchone()[0]
            db.execute("PRAGMA max_page_count=" + str(128 * 1024 * 1024 // page_size))
            db.execute("PRAGMA journal_size_limit=8388608")
            db.execute("PRAGMA wal_autocheckpoint=256")
            with db:
                yield db
        finally:
            db.close()

    def _cleanup(self, db):
        now = self.clock()
        for table in ("states", "codes", "sessions"):
            db.execute("DELETE FROM " + table + " WHERE expires <= ?", (now,))
        db.execute("DELETE FROM auto_logins WHERE expires <= ?", (now,))
        # Keep cancelled attempt bindings until their OAuth state expires; an
        # in-flight callback must not silently fall back to manual code login.
        db.execute("DELETE FROM auto_states WHERE state_key NOT IN (SELECT key FROM states)")
        db.execute("UPDATE submissions SET entry_json=NULL,payload_bytes=0 WHERE status='rejected' AND entry_json IS NOT NULL AND updated_at <= ?", (now - REJECTED_PAYLOAD_MS,))
        db.execute("DELETE FROM library_reads WHERE at <= ?", (now - AUDIT_RETENTION_MS,))
        db.execute("DELETE FROM publication_limits WHERE at <= ?", (now - AUDIT_RETENTION_MS,))

    def recover(self):
        with self.lock:
            with self._db() as db:
                rows = db.execute("SELECT id FROM submissions WHERE status='publishing' ORDER BY created_at").fetchall()
            for row in rows:
                try:
                    self._publish(row["id"])
                except (OSError, sqlite3.Error, ArchiveError, ApiError):
                    # Keep the durable intent. A retry must not be mislabelled rejected.
                    pass

    @staticmethod
    def owns(path):
        return path == "/contributions" or path.startswith("/contributions/") or path.startswith("/auth/")

    def methods(self, path):
        if AUTO_CONFIRM_PATH.fullmatch(path):
            return {"POST"}
        if AUTO_LOGIN_PATH.fullmatch(path):
            return {"GET"}
        if path in ("/auth/auto/start", "/auth/auto/poll", "/auth/auto/cancel"):
            return {"POST"}
        if path in ("/contributions/status", "/contributions/me", "/contributions/mine", "/contributions/pending", "/auth/login", "/auth/callback"):
            return {"GET"}
        if path in ("/auth/exchange", "/auth/logout", "/auth/logout-all", "/contributions"):
            return {"POST"}
        match = SUBMISSION_PATH.fullmatch(path)
        return {"POST" if match[2] else "GET"} if match else set()

    def _session(self, handler):
        token = header_token(handler, "Bearer")
        with self.lock, self._db() as db:
            self._cleanup(db)
            row = db.execute("SELECT * FROM sessions WHERE key=? AND expires>?", (digest(token), self.clock())).fetchone()
            if row is not None and self._privileged(row["user_id"]) and self.clock() >= row["created_at"] + PRIVILEGED_SESSION_MS:
                db.execute("DELETE FROM sessions WHERE key=?", (row["key"],))
                row = None
        if row is None:
            raise ApiError(401, "session_expired", "登录已过期，请重新登录。")
        return row

    def _record_access(self, db, user_id, roles):
        allowed = bool(set(roles) & set(self.config["libraryRoleIds"]))
        db.execute("INSERT OR REPLACE INTO access(user_id,allowed,checked_at) VALUES(?,?,?)", (user_id, int(allowed), self.clock()))
        return allowed

    def library_verdict(self, user_id, refresh=True):
        """'open' (not gated), 'ok', 'denied', or 'recheck' (must log in again)."""
        if not self.gated:
            return "open"
        if user_id in self.config["reviewerIds"]:
            return "ok"
        bot = bool(self.config["botToken"])
        with self.lock, self._db() as db:
            row = db.execute("SELECT allowed,checked_at FROM access WHERE user_id=?", (user_id,)).fetchone()
        if row is not None:
            window = (ACCESS_RECHECK_MS if row["allowed"] else ACCESS_DENIED_RECHECK_MS) if bot else self.config["roleProofHours"] * HOUR_MS
            if self.clock() - row["checked_at"] < window:
                return "ok" if row["allowed"] else "denied"
        if not bot or not refresh:
            return "recheck" if not bot else ("ok" if row is not None and row["allowed"] else "denied")
        roles = self.identity.member_roles(user_id, self.config)  # network call outside the lock
        with self.lock, self._db() as db:
            return "ok" if self._record_access(db, user_id, roles) else "denied"

    def library_access(self, handler):
        """Authorize one /library.json download. Responds and returns False when refused."""
        try:
            if not self.enabled or not self.gated:
                raise ApiError(503, "library_auth_unavailable", "云端库鉴权尚未配置，暂不可读取。")
            session = self._session(handler)
            verdict = self.library_verdict(session["user_id"])
            if verdict == "recheck":
                with self.lock, self._db() as db:
                    db.execute("DELETE FROM sessions WHERE key=?", (session["key"],))
                raise ApiError(401, "access_recheck_required", "需要重新使用 Discord 登录，以复查答疑身份组。")
            if verdict != "ok":
                raise ApiError(403, "library_forbidden", "云端答疑库仅对指定服务器中拥有答疑身份组的成员开放。")
            now = self.clock()
            with self.lock, self._db() as db:
                recent = db.execute("SELECT count(*) FROM library_reads WHERE user_id=? AND at>?", (session["user_id"], now - HOUR_MS)).fetchone()[0]
                if recent >= self.config["libraryReadsPerHour"]:
                    raise ApiError(429, "library_rate_limited", "云端库下载过于频繁，请稍后再试。")
                # Audit trail: who downloaded the full library and when (kept 30 days).
                db.execute("INSERT INTO library_reads VALUES(?,?)", (session["user_id"], now))
            return True
        except ApiError as exc:
            headers = {"WWW-Authenticate": 'Bearer realm="answer-qr"'} if exc.status == 401 else None
            handler.respond(exc.status, {"error": exc.code, "message": exc.message}, headers)
        except (OSError, sqlite3.Error, ValueError):
            handler.respond(503, {"error": "library_auth_unavailable", "message": "云端库鉴权暂时不可用，请稍后重试。"})
        return False

    def _privileged(self, user_id):
        return user_id in self.config["reviewerIds"] or user_id in self.config["autoPublishIds"]

    def _profile(self, session):
        expires = session["expires"]
        if self._privileged(session["user_id"]) and "created_at" in session.keys():
            expires = min(expires, session["created_at"] + PRIVILEGED_SESSION_MS)
        return {"expiresAt": expires, "user": {"id": session["user_id"], "username": session["username"]},
                "canReview": session["user_id"] in self.config["reviewerIds"],
                "canAutoPublish": session["user_id"] in self.config["autoPublishIds"]}

    def _cookie(self, value="", age=0, name=COOKIE_NAME):
        return name + "=" + value + "; Path=/; Max-Age=" + str(age) + "; Secure; HttpOnly; SameSite=Lax"

    def _flow_cookie(self, handler, state):
        # Each login tab owns a cookie. Only inspect the requested cookie, since
        # unrelated applications on this host can set nonstandard cookie values.
        name = COOKIE_NAME + "_" + state
        headers = handler.headers.get_all("Cookie", [])
        if len(headers) > 8 or sum(map(len, headers)) > MAX_COOKIE_HEADER:
            raise ApiError(400, "invalid_oauth_state", "浏览器发送的 Cookie 过多，请清理此站点的旧 Cookie 后重新登录。")
        found = {name: [], COOKIE_NAME: []}
        for header in headers:
            for part in header.split(";"):
                key, separator, value = part.strip().partition("=")
                if key in found:
                    found[key].append(value.strip() if separator else "")
        # Accept a still-pending pre-upgrade flow without weakening its database
        # hash check. New cookies always take precedence over the legacy name.
        selected = name if found[name] else COOKIE_NAME
        values = found[selected]
        if not values:
            raise ApiError(400, "invalid_oauth_state", "浏览器未带回本次登录的校验 Cookie。请在同一浏览器中从插件重新打开登录，并允许此站点 Cookie。")
        if len(values) != 1 or not re.fullmatch(r"[A-Za-z0-9_-]{43}", values[0]):
            raise ApiError(400, "invalid_oauth_state", "浏览器发送的登录校验 Cookie 无效或重复，请从插件重新打开登录。")
        return values[0], selected

    def _auto_start(self, handler):
        body = read_json(handler)
        if not isinstance(body, dict) or type(body.get("pairing")) is not int or body["pairing"] != 1:
            raise ApiError(400, "client_outdated", "请更新插件，或使用一次性登录码。")
        body = strict_object(body, ("challenge", "userId", "pairing"))
        if not isinstance(body["challenge"], str) or not re.fullmatch(r"[a-f0-9]{64}", body["challenge"]) or not isinstance(body["userId"], str) or not re.fullmatch(r"[0-9]{17,20}", body["userId"]):
            raise ApiError(400, "invalid_request", "自动登录请求无效，请从插件重新发起。")
        login_id, expires = secrets.token_urlsafe(32), self.clock() + STATE_MS
        pair_code = f"{secrets.randbelow(10000):04d}"
        with self.lock, self._db() as db:
            self._cleanup(db)
            if db.execute("SELECT count(*) FROM auto_logins").fetchone()[0] >= MAX_LOGIN_ATTEMPTS:
                raise ApiError(429, "login_busy", "登录请求过多，请稍后再试。")
            db.execute("INSERT INTO auto_logins(id,challenge,expected_user,expires,status,pair_code) VALUES(?,?,?,?,'pairing',?)", (login_id, body["challenge"], body["userId"], expires, pair_code))
        handler.respond(200, {"id": login_id, "loginUrl": self.config["publicBaseUrl"] + "/auth/auto/login/" + login_id, "expiresAt": expires, "intervalMs": AUTO_POLL_MS, "pairCode": pair_code})

    def _pair_page(self, handler, automatic_id):
        nonce, cookie = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
        with self.lock, self._db() as db:
            self._cleanup(db)
            row = db.execute("SELECT status,pair_code FROM auto_logins WHERE id=?", (automatic_id,)).fetchone()
            if row is None or row["status"] != "pairing" or row["pair_code"] is None:
                raise ApiError(400, "auto_login_expired", "这次登录已过期或已完成，请回到插件重新发起。")
            db.execute("UPDATE auto_logins SET pair_nonce_hash=?,pair_cookie_hash=? WHERE id=?", (digest(nonce), digest(cookie), automatic_id))
        action = self.config["publicBaseUrl"] + "/auth/auto/login/" + automatic_id + "/confirm"
        page = ('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>答疑库登录配对</title>'
                '<style>body{font:18px system-ui;max-width:46em;margin:3em auto;padding:1em}input,button{font:inherit;padding:.5em}</style>'
                '<h1>确认插件登录</h1><p>请输入答疑插件登录面板上显示的 4 位配对码。如果你没有在自己的插件里点击登录，请关闭本页。</p>'
                '<form method="post" action="' + html.escape(action, quote=True) + '"><input type="hidden" name="nonce" value="' + nonce + '">'
                '<label>配对码 <input name="code" inputmode="numeric" pattern="[0-9]{4}" minlength="4" maxlength="4" required autocomplete="off"></label>'
                '<button type="submit">确认并前往 Discord</button></form>').encode("utf-8")
        handler.respond(200, page, {"Set-Cookie": self._cookie(cookie, STATE_MS // 1000, PAIR_COOKIE_NAME + "_" + automatic_id),
            # Chromium uses this policy when deriving the form POST's Origin.
            # Keep our own origin while withholding referrers to other hosts.
            "Referrer-Policy": "same-origin", "X-Frame-Options": "DENY",
            "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"}, content_type="text/html; charset=utf-8")

    def _pair_confirm(self, handler, automatic_id):
        body = read_pairing_form(handler)
        cookie_name = PAIR_COOKIE_NAME + "_" + automatic_id
        cookies = []
        headers = handler.headers.get_all("Cookie", [])
        if len(headers) <= 8 and sum(map(len, headers)) <= MAX_COOKIE_HEADER:
            for header in headers:
                for part in header.split(";"):
                    name, separator, value = part.strip().partition("=")
                    if name == cookie_name:
                        cookies.append(value.strip() if separator else "")
        valid = False
        with self.lock:
            with self._db() as db:
                self._cleanup(db)
                row = db.execute("SELECT * FROM auto_logins WHERE id=?", (automatic_id,)).fetchone()
                if row is None or row["status"] != "pairing":
                    raise ApiError(400, "auto_login_expired", "这次配对已使用或失效，请回到插件重新发起。")
                valid = (len(cookies) == 1 and re.fullmatch(r"[A-Za-z0-9_-]{43}", cookies[0]) is not None
                         and re.fullmatch(r"[A-Za-z0-9_-]{43}", body["nonce"]) is not None
                         and re.fullmatch(r"[0-9]{4}", body["code"]) is not None
                         and row["pair_nonce_hash"] is not None and row["pair_cookie_hash"] is not None
                         and hmac.compare_digest(row["pair_nonce_hash"], digest(body["nonce"]))
                         and hmac.compare_digest(row["pair_cookie_hash"], digest(cookies[0]))
                         and hmac.compare_digest(row["pair_code"], body["code"]))
                # Commit failure before raising: there is exactly one guessing attempt.
                db.execute("UPDATE auto_logins SET status=?,message=?,pair_nonce_hash=NULL,pair_cookie_hash=NULL WHERE id=?",
                           ("confirmed" if valid else "failed", None if valid else "配对校验失败，这次登录已作废，请重新发起。", automatic_id))
            if not valid:
                raise ApiError(400, "pairing_failed", "配对校验失败，这次登录已作废，请重新发起。")
            try:
                self._login(handler, automatic_id)
            except ApiError as exc:
                with self._db() as db:
                    db.execute("UPDATE auto_logins SET status='failed',message=? WHERE id=? AND status='confirmed'", (exc.message, automatic_id))
                raise

    def _issue_session(self, db, user_id, username):
        if db.execute("SELECT count(*) FROM sessions").fetchone()[0] >= 2000:
            raise ApiError(429, "login_busy", "登录会话过多，请稍后再试。")
        token, now = secrets.token_urlsafe(32), self.clock()
        db.execute("DELETE FROM sessions WHERE key IN (SELECT key FROM sessions WHERE user_id=? ORDER BY created_at DESC LIMIT -1 OFFSET 19)", (user_id,))
        expires = now + (PRIVILEGED_SESSION_MS if self._privileged(user_id) else SESSION_MS)
        db.execute("INSERT INTO sessions VALUES(?,?,?,?,?)", (digest(token), user_id, username, expires, now))
        return {"token": token, **self._profile({"expires": expires, "created_at": now, "user_id": user_id, "username": username})}

    def _auto_poll(self, handler, cancel=False):
        verifier = header_token(handler, "LoginVerifier")
        body = strict_object(read_json(handler), ("id",))
        if not isinstance(body["id"], str) or not re.fullmatch(r"[A-Za-z0-9_-]{43}", body["id"]):
            raise ApiError(400, "invalid_request", "自动登录请求无效。")
        with self.lock, self._db() as db:
            self._cleanup(db)
            row = db.execute("SELECT * FROM auto_logins WHERE id=?", (body["id"],)).fetchone()
            if row is None or not hmac.compare_digest(row["challenge"], digest(verifier)):
                raise ApiError(401, "auto_login_expired", "这次自动登录已过期或已完成，请重新发起。")
            if cancel:
                db.execute("DELETE FROM auto_logins WHERE id=?", (row["id"],))
                result = {"status": "cancelled"}
            elif row["status"] == "failed":
                db.execute("DELETE FROM auto_logins WHERE id=?", (row["id"],))
                result = {"status": "failed", "message": row["message"]}
            elif row["last_poll"] and self.clock() - row["last_poll"] < AUTO_POLL_MS:
                result = {"status": "pending", "intervalMs": AUTO_POLL_MS}
            elif row["status"] in ("pairing", "confirmed", "pending"):
                db.execute("UPDATE auto_logins SET last_poll=? WHERE id=?", (self.clock(), row["id"]))
                result = {"status": "pending", "intervalMs": AUTO_POLL_MS}
            else:
                # Recheck the callback's role proof; a public login URL alone
                # can never collect a session. Consumption and issuance are atomic.
                verdict = self.library_verdict(row["user_id"], refresh=False)
                if verdict not in ("ok", "open"):
                    result = {"status": "failed", "message": "答疑身份组校验已失效，请重新登录。"}
                else:
                    result = {"status": "complete", **self._issue_session(db, row["user_id"], row["username"]), "libraryAccess": verdict}
                db.execute("DELETE FROM auto_logins WHERE id=?", (row["id"],))
        handler.respond(200, result)

    def _login(self, handler, automatic_id=None):
        state, cookie = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
        with self.lock, self._db() as db:
            self._cleanup(db)
            if automatic_id:
                attempt = db.execute("SELECT status FROM auto_logins WHERE id=?", (automatic_id,)).fetchone()
                if attempt is None or attempt["status"] != "confirmed":
                    raise ApiError(400, "auto_login_expired", "这次登录已过期或已完成，请回到插件重新发起。")
            if db.execute("SELECT count(*) FROM states").fetchone()[0] >= MAX_LOGIN_ATTEMPTS:
                raise ApiError(429, "login_busy", "登录请求过多，请稍后再试。")
            db.execute("INSERT INTO states VALUES(?,?,?)", (digest(state), digest(cookie), self.clock() + STATE_MS))
            if automatic_id:
                db.execute("INSERT INTO auto_states VALUES(?,?)", (digest(state), automatic_id))
                db.execute("UPDATE auto_logins SET status='pending' WHERE id=?", (automatic_id,))
        location = "https://discord.com/oauth2/authorize?" + parse.urlencode({"response_type": "code", "client_id": self.config["clientId"],
            "scope": "identify " + MEMBER_SCOPE if self.gated else "identify", "state": state, "redirect_uri": self.config["publicBaseUrl"] + "/auth/callback", "prompt": "consent"})
        headers = {"Set-Cookie": self._cookie(cookie, STATE_MS // 1000, COOKIE_NAME + "_" + state), "Referrer-Policy": "no-referrer"}
        if automatic_id:
            # Chromium applies the pairing page's form-action to redirect chains.
            # Finish the same-origin POST, then navigate using a regular link.
            page = ('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>答疑库登录配对完成</title>'
                    '<style>body{font:18px system-ui;max-width:46em;margin:3em auto;padding:1em}a{display:inline-block;padding:.7em;background:#5865f2;color:white}</style>'
                    '<h1>配对已确认</h1><p>只有你刚刚在自己的答疑插件中发起了登录，才继续授权。请勿转发登录链接。</p>'
                    '<a id="oauth-continue" href="' + html.escape(location, quote=True) + '" rel="noreferrer">继续 Discord 身份授权</a>').encode("utf-8")
            headers.update({"X-Frame-Options": "DENY", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"})
            handler.respond(200, page, headers, content_type="text/html; charset=utf-8")
        else:
            handler.respond(302, headers={"Location": location, **headers})

    def _callback(self, handler, query):
        try:
            if len(query.encode("utf-8")) > MAX_CALLBACK_QUERY or re.search(r"%(?![0-9a-fA-F]{2})", query):
                raise ValueError()
            pairs = parse.parse_qsl(query, keep_blank_values=True, max_num_fields=MAX_CALLBACK_FIELDS,
                                   strict_parsing=False, encoding="utf-8", errors="strict")
            fields, seen = {}, set()
            for key, value in pairs:
                if key in seen:
                    raise ValueError()
                seen.add(key)
                # RFC 6749 section 4.1.2 requires unknown response parameters
                # to be ignored. They never affect identity, roles or redirects.
                if key in ("state", "code", "error"):
                    fields[key] = value
            if ("code" in fields) == ("error" in fields) or any(not fields[key] for key in ("code", "error") if key in fields):
                raise ValueError()
        except ValueError as exc:
            raise ApiError(400, "invalid_oauth_state", "登录回调参数无效，请从插件重新打开登录。") from exc
        state = fields.get("state", "")
        if not re.fullmatch(r"[A-Za-z0-9_-]{43}", state):
            raise ApiError(400, "invalid_oauth_state", "登录链接缺少有效校验信息，请从答疑插件点击 Discord 登录，不要直接使用开发者页面的授权链接。")
        cookie, cookie_name = self._flow_cookie(handler, state)
        with self.lock, self._db() as db:
            self._cleanup(db)
            row = db.execute("SELECT * FROM states WHERE key=?", (digest(state),)).fetchone()
            if row is None:
                raise ApiError(400, "invalid_oauth_state", "这次登录已过期或已经使用，请从插件重新打开登录。")
            if not hmac.compare_digest(row["cookie_hash"], digest(cookie)):
                raise ApiError(400, "invalid_oauth_state", "当前浏览器与发起登录的浏览器不一致，或登录状态已变化，请在同一浏览器中重新打开登录。")
            automatic = db.execute("SELECT login_id FROM auto_states WHERE state_key=?", (digest(state),)).fetchone()
            automatic_id = automatic["login_id"] if automatic else None
            db.execute("DELETE FROM states WHERE key=?", (digest(state),))
            db.execute("DELETE FROM auto_states WHERE state_key=?", (digest(state),))
        try:
            self._finish_callback(handler, fields, cookie_name, automatic_id)
        except ApiError as exc:
            if automatic_id:
                with self.lock, self._db() as db:
                    db.execute("UPDATE auto_logins SET status='failed',message=? WHERE id=? AND status='pending'", (exc.message, automatic_id))
            raise

    def _finish_callback(self, handler, fields, cookie_name, automatic_id):
        if "error" in fields:
            raise ApiError(400, "oauth_declined", "Discord 授权已取消。")
        code = fields.get("code", "")
        if not re.fullmatch(r"[A-Za-z0-9._-]{1,2048}", code):
            raise ApiError(400, "invalid_oauth_code", "Discord 登录代码无效，请重新登录。")
        user = self.identity.verify(code, self.config)
        if self.gated and not isinstance(user.get("roles"), list):
            raise ApiError(502, "identity_unverified", "Discord 未返回身份组信息，请重新登录。")
        login_code = secrets.token_urlsafe(32)
        with self.lock:
            with self._db() as db:
                self._cleanup(db)
                if automatic_id:
                    attempt = db.execute("SELECT * FROM auto_logins WHERE id=?", (automatic_id,)).fetchone()
                    if attempt is None or attempt["status"] != "pending":
                        raise ApiError(400, "auto_login_expired", "这次登录已取消、过期或已完成，请回到插件重新发起。")
                    if user["id"] != attempt["expected_user"]:
                        raise ApiError(403, "account_mismatch", "浏览器授权的 Discord 账号与插件当前账号不同，请切换到同一账号后重试。")
            # A denied role proof is security state, not an unsuccessful login
            # transaction. Commit it and revoke existing credentials before raising.
            denied = False
            if self.gated:
                with self._db() as db:
                    denied = not self._record_access(db, user["id"], user["roles"]) and user["id"] not in self.config["reviewerIds"]
                    if denied:
                        db.execute("DELETE FROM sessions WHERE user_id=?", (user["id"],))
                        db.execute("DELETE FROM codes WHERE user_id=?", (user["id"],))
            if denied:
                raise ApiError(403, "library_forbidden", "此 Discord 账号不在指定服务器，或没有答疑身份组。云端库与投稿仅对答疑成员开放，本地 QR 功能不受影响。")
            with self._db() as db:
                if automatic_id:
                    db.execute("UPDATE auto_logins SET status='authorized',user_id=?,username=? WHERE id=?", (user["id"], user["username"], automatic_id))
                elif db.execute("SELECT count(*) FROM codes").fetchone()[0] >= 1000:
                    raise ApiError(429, "login_busy", "登录请求过多，请稍后再试。")
                else:
                    db.execute("INSERT INTO codes VALUES(?,?,?,?)", (digest(login_code), user["id"], user["username"], self.clock() + CODE_MS))
        page = ('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>答疑库登录</title>'
                '<style>body{font:18px system-ui;max-width:46em;margin:3em auto;padding:1em}code{display:block;word-break:break-all;padding:1em;background:#eee;color:#111;user-select:all}</style>'
                '<h1>Discord 身份已验证</h1><p>将下面的一次性登录码复制回答疑插件。5 分钟内有效，只能使用一次。请勿转发给他人。</p><code>'
                + html.escape(login_code) + '</code><p>已验证的 Discord ID：' + html.escape(user["id"]) + '</p>').encode("utf-8")
        if automatic_id:
            page = ('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>答疑库授权完成</title>'
                    '<style>body{font:18px system-ui;max-width:46em;margin:3em auto;padding:1em}</style>'
                    '<h1>授权完成</h1><p>请返回 Discord，发起登录的答疑插件会自动完成登录，无需复制登录码。可以关闭本页。</p>'
                    '<p>请勿转发登录链接、配对码或登录凭据。</p><p>已验证账号：' + html.escape(user["username"]) + '</p>').encode("utf-8")
        handler.respond(200, page, {"Set-Cookie": self._cookie(name=cookie_name), "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY",
            "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"}, content_type="text/html; charset=utf-8")

    def _exchange(self, handler):
        code = header_token(handler, "LoginCode")
        strict_object(read_json(handler), ())
        with self.lock, self._db() as db:
            self._cleanup(db)
            row = db.execute("SELECT * FROM codes WHERE key=?", (digest(code),)).fetchone()
            if row is None:
                raise ApiError(401, "login_code_expired", "登录码已过期或已使用，请重新登录。")
            db.execute("DELETE FROM codes WHERE key=?", (digest(code),))
            profile = self._issue_session(db, row["user_id"], row["username"])
        profile["libraryAccess"] = self.library_verdict(profile["user"]["id"], refresh=False)
        handler.respond(200, profile)

    def _summary(self, row):
        result = {"id": row["id"], "title": row["title"], "status": "pending" if row["status"] == "publishing" else row["status"],
                  "createdAt": row["created_at"], "updatedAt": row["updated_at"], "submitterId": row["submitter_id"]}
        if row["target_id"] is not None:
            result["update"] = {"targetId": row["target_id"], "baseUpdatedAt": row["base_updated_at"]}
        if row["status"] == "publishing":
            result["reason"] = "发布正在恢复，暂不能驳回。"
        elif row["reason"]:
            result["reason"] = row["reason"]
        return result

    def _list(self, session, pending):
        if pending and not self._profile(session)["canReview"]:
            raise ApiError(403, "review_forbidden", "此 Discord 账号没有审核权限。")
        fields = "id,title,status,created_at,updated_at,reason,submitter_id,target_id,base_updated_at"
        with self.lock, self._db() as db:
            if pending:
                rows = db.execute("SELECT " + fields + " FROM submissions WHERE status IN ('pending','publishing') ORDER BY created_at LIMIT 100").fetchall()
            else:
                rows = db.execute("SELECT " + fields + " FROM submissions WHERE submitter_id=? ORDER BY created_at DESC LIMIT 100", (session["user_id"],)).fetchall()
        return {"submissions": [self._summary(row) for row in rows]}

    def _detail(self, session, submission_id):
        reviewer = self._profile(session)["canReview"]
        with self.lock, self._db() as db:
            row = db.execute("SELECT * FROM submissions WHERE id=?", (submission_id,)).fetchone()
            if row is None or (row["submitter_id"] != session["user_id"] and not reviewer):
                raise ApiError(404, "submission_not_found", "找不到这条提交，或你无权查看。")
        if not reviewer:
            verdict = self.library_verdict(session["user_id"])
            if verdict == "recheck":
                with self.lock, self._db() as db:
                    db.execute("DELETE FROM sessions WHERE key=?", (session["key"],))
                raise ApiError(401, "access_recheck_required", "需要重新使用 Discord 登录，以复查答疑身份组。")
            if verdict not in ("open", "ok"):
                raise ApiError(403, "library_forbidden", "云端答疑库仅对拥有答疑身份组的成员开放。")
        with self.lock:
            if row["entry_json"] is not None:
                entry = json.loads(row["entry_json"])
            elif row["status"] == "published":
                if self.published_entry:
                    entry = self.published_entry(row["entry_id"])
                else:
                    archive = parse_archive(read_bounded(self.library_path))
                    entry = next((entry for entry in archive["entries"] if entry["id"] == row["entry_id"]), None)
            else:
                entry = None
            if entry is None:
                raise ApiError(410, "submission_archived", "这条提交的详细内容已归档或从共享库移除；摘要仍保留。")
            result = {**self._summary(row), "entry": entry}
            if reviewer and row["target_id"] is not None:
                archive = parse_archive(read_bounded(self.library_path))
                result["current"] = next((item for item in archive["entries"] if item["id"] == row["target_id"]), None)
            return {"submission": result}

    def _submit(self, session, body):
        if self.library_verdict(session["user_id"]) not in ("open", "ok"):
            raise ApiError(403, "library_forbidden", "投稿仅对拥有答疑身份组的成员开放；如刚获得身份组，请重新登录。")
        strict_object(body, ("entry", "requestId"), ("update",))
        update = body.get("update")
        if "update" in body:
            strict_object(update, ("targetId", "baseUpdatedAt"))
            if (not isinstance(update["targetId"], str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", update["targetId"])
                    or type(update["baseUpdatedAt"]) is not int or not 0 <= update["baseUpdatedAt"] < 9007199254740991):
                raise ApiError(400, "invalid_update", "云端编辑目标或版本无效。")
        request_id = body["requestId"]
        if not isinstance(request_id, str) or not re.fullmatch(UUID_PATTERN, request_id):
            raise ApiError(400, "invalid_request_id", "提交编号必须是 UUID。")
        try:
            validate_archive({"version": 1, "entries": [body["entry"]]})
            if update and body["entry"]["id"] != update["targetId"]:
                raise ApiError(400, "invalid_update", "编辑内容与云端条目 ID 不匹配。")
            fingerprint = digest(json_bytes({"entry": body["entry"], "update": update} if update else body["entry"]).decode("utf-8"))
        except (ArchiveError, ValueError) as exc:
            raise ApiError(400, "invalid_entry", "QR 格式、文字或图片不符合共享库限制。") from exc
        now = self.clock()
        with self.lock:
            self.recover()
            with self._db() as db:
                self._cleanup(db)
                existing = db.execute("SELECT id,status,request_hash FROM submissions WHERE submitter_id=? AND request_id=?", (session["user_id"], request_id)).fetchone()
                if existing:
                    if not hmac.compare_digest(existing["request_hash"], fingerprint):
                        raise ApiError(409, "request_id_reused", "同一提交编号不能用于不同内容。")
                    submission_id, status = existing["id"], existing["status"]
                else:
                    if update:
                        archive = parse_archive(read_bounded(self.library_path))
                        current = next((item for item in archive["entries"] if item["id"] == update["targetId"]), None)
                        self._check_update(current, update["baseUpdatedAt"])
                    counts = db.execute("SELECT count(*),coalesce(sum(payload_bytes),0),sum(status IN ('pending','publishing')) FROM submissions").fetchone()
                    user_pending = db.execute("SELECT count(*) FROM submissions WHERE submitter_id=? AND status IN ('pending','publishing')", (session["user_id"],)).fetchone()[0]
                    submission_id = str(uuid.uuid4())
                    entry = {**body["entry"], "id": update["targetId"] if update else "shared_" + uuid.uuid4().hex,
                             "updatedAt": max(now, update["baseUpdatedAt"] + 1) if update else now,
                             "images": [{**image, "id": "image_" + uuid.uuid4().hex} for image in body["entry"]["images"]]}
                    payload = json_bytes(entry)
                    if counts[0] >= MAX_SUBMISSIONS or counts[1] + len(payload) > MAX_PAYLOAD_BYTES or (counts[2] or 0) >= MAX_PENDING or user_pending >= MAX_USER_PENDING:
                        raise ApiError(429, "submission_limit", "待审数量或保存空间已达上限，请等待审核或联系管理员。")
                    db.execute("INSERT INTO submissions(id,submitter_id,username,request_id,request_hash,entry_id,entry_json,payload_bytes,title,status,created_at,updated_at,target_id,base_updated_at) VALUES(?,?,?,?,?,?,?,?,?,'pending',?,?,?,?)",
                               (submission_id, session["user_id"], session["username"], request_id, fingerprint, entry["id"], payload.decode("utf-8"), len(payload), entry["title"], now, now,
                                update["targetId"] if update else None, update["baseUpdatedAt"] if update else None))
                    status = "pending"
            if status == "publishing" or (status == "pending" and self._profile(session)["canAutoPublish"]):
                self._publish(submission_id, session["user_id"], "auto_publish")
                status = "published"
            if status == "rejected":
                raise ApiError(409, "submission_rejected", "这条提交已驳回；修改后请使用新的提交编号。")
            return {"id": submission_id, "status": status}

    @staticmethod
    def _check_update(current, base_updated_at):
        if current is None:
            raise ApiError(409, "update_target_missing", "原云端 QR 已移除，不能替换；请刷新云端库。")
        if current["updatedAt"] != base_updated_at:
            raise ApiError(409, "update_conflict", "云端 QR 已被更新，本次修改未覆盖它。请保留草稿，刷新后基于最新版重新编辑；待审旧版本请驳回后重新提交。")

    def _publish(self, submission_id, reviewer_id=None, decision="approve", reason=""):
        with self.lock:
            with self._db() as db:
                row = db.execute("SELECT * FROM submissions WHERE id=?", (submission_id,)).fetchone()
            if row is None:
                raise ApiError(404, "submission_not_found", "找不到这条提交。")
            if row["status"] == "published":
                return
            if row["status"] == "rejected":
                raise ApiError(409, "already_reviewed", "这条提交已驳回，不能直接发布。")
            entry = json.loads(row["entry_json"])
            with self._db() as db:
                if db.execute("SELECT 1 FROM submissions WHERE entry_id=? AND status='publishing' AND id!=?", (row["entry_id"], submission_id)).fetchone():
                    raise ApiError(503, "publish_recovering", "同一条 QR 的上次发布正在恢复，请稍后重试。")
            if self.library_path.is_symlink():
                raise ApiError(503, "publish_unavailable", "共享库路径需要管理员检查。")
            with update_lock(self.library_path):
                previous = read_bounded(self.library_path)
                archive = parse_archive(previous)
                present = next((item for item in archive["entries"] if item["id"] == row["entry_id"]), None)
                # A committed publishing intent may already have replaced the file.
                already_written = present == entry and row["status"] == "publishing"
                if row["target_id"] is not None and not already_written:
                    self._check_update(present, row["base_updated_at"])
                elif row["target_id"] is None and present is not None and present != entry:
                    raise ApiError(503, "publish_conflict", "共享库条目发生冲突，需要管理员检查。")
                needs_write = present != entry
                if needs_write:
                    entries = [entry if item["id"] == row["target_id"] else item for item in archive["entries"]] if row["target_id"] is not None else [*archive["entries"], entry]
                    combined = {"version": 1, "entries": entries}
                    raw = json_bytes(combined)
                    try:
                        parse_archive(raw)
                    except ArchiveError as exc:
                        raise ApiError(409, "library_limit", "共享库已达到大小或条目上限，请联系管理员精简后重试。") from exc
                with self._db() as db:
                    if row["status"] != "publishing":
                        actor = reviewer_id or row["submitter_id"]
                        recent = db.execute("SELECT count(*) FROM publication_limits WHERE user_id=? AND at>?", (actor, self.clock() - HOUR_MS)).fetchone()[0]
                        if recent >= self.config["publishesPerHour"]:
                            raise ApiError(429, "publish_rate_limited", "此账号每小时的发布次数已达上限，请稍后再试。")
                        db.execute("INSERT INTO publication_limits VALUES(?,?,?)", (actor, self.clock(), submission_id))
                        db.execute("UPDATE submissions SET status='publishing',updated_at=? WHERE id=?", (self.clock(), submission_id))
                        db.execute("INSERT OR IGNORE INTO reviews VALUES(?,?,?,?,?)", (submission_id, reviewer_id or row["submitter_id"], decision, reason, self.clock()))
                # Crash after this commit is recovered using the stable generated entry ID.
                if needs_write:
                    directory = self.library_path.parent / "publish-backups"
                    directory.mkdir(mode=0o700, exist_ok=True)
                    backup = directory / (str(self.clock()) + "-" + uuid.uuid4().hex + ".json")
                    atomic_write(backup, previous)
                    prune_publish_backups(directory, now=datetime.fromtimestamp(self.clock() / 1000, timezone.utc))
                    atomic_write(self.library_path, raw, self.library_path.stat())
                with self._db() as db:
                    db.execute("UPDATE submissions SET status='published',entry_json=NULL,payload_bytes=0,updated_at=? WHERE id=?", (self.clock(), submission_id))

    def _review(self, session, submission_id, body):
        if not self._profile(session)["canReview"]:
            raise ApiError(403, "review_forbidden", "此 Discord 账号没有审核权限。")
        strict_object(body, ("decision",), ("reason",))
        decision, reason = body["decision"], body.get("reason", "")
        valid_reason = False
        if isinstance(reason, str):
            try:
                valid_reason = len(reason.encode("utf-16-le")) // 2 <= 500
            except UnicodeEncodeError:
                pass
        if decision not in ("approve", "reject") or not valid_reason:
            raise ApiError(400, "invalid_review", "审核操作无效，原因最多 500 个字符。")
        with self.lock:
            if decision == "approve":
                self._publish(submission_id, session["user_id"], reason=reason)
                return {"id": submission_id, "status": "published"}
            with self._db() as db:
                row = db.execute("SELECT status FROM submissions WHERE id=?", (submission_id,)).fetchone()
                if row is None:
                    raise ApiError(404, "submission_not_found", "找不到这条提交。")
                if row["status"] in ("publishing", "published"):
                    raise ApiError(409, "already_publishing", "已发布或正在恢复发布的条目不能驳回。")
                if row["status"] == "pending":
                    db.execute("UPDATE submissions SET status='rejected',reason=?,updated_at=? WHERE id=?", (reason, self.clock(), submission_id))
                    db.execute("INSERT INTO reviews VALUES(?,?,?,?,?)", (submission_id, session["user_id"], decision, reason, self.clock()))
            return {"id": submission_id, "status": "rejected"}

    def handle(self, handler):
        parsed = parse.urlsplit(handler.path)
        path = parsed.path
        if not self.owns(path):
            return False
        try:
            if path == "/contributions/status" and handler.command == "GET" and not parsed.query:
                handler.respond(200, {"enabled": self.enabled, "loginUrl": self.config["publicBaseUrl"] + "/auth/login", "automaticLogin": True, "pairing": True, "cloudEditing": True})
                return True
            if not self.enabled:
                raise ApiError(503, "contributions_disabled", "管理员尚未配置 Discord 登录，提交与审核暂未开放；共享库仍可读取。")
            if (parsed.query and path != "/auth/callback") or handler.command not in self.methods(path):
                raise ApiError(404, "not_found", "没有这个接口。")
            if path == "/auth/auto/start":
                self._auto_start(handler)
            elif path in ("/auth/auto/poll", "/auth/auto/cancel"):
                self._auto_poll(handler, cancel=path.endswith("/cancel"))
            elif AUTO_LOGIN_PATH.fullmatch(path):
                self._pair_page(handler, AUTO_LOGIN_PATH.fullmatch(path)[1])
            elif AUTO_CONFIRM_PATH.fullmatch(path):
                self._pair_confirm(handler, AUTO_CONFIRM_PATH.fullmatch(path)[1])
            elif path == "/auth/login":
                self._login(handler)
            elif path == "/auth/callback":
                self._callback(handler, parsed.query)
            elif path == "/auth/exchange":
                self._exchange(handler)
            else:
                session = self._session(handler)
                if path == "/contributions/me":
                    handler.respond(200, {**self._profile(session), "libraryAccess": self.library_verdict(session["user_id"])})
                elif path in ("/auth/logout", "/auth/logout-all"):
                    strict_object(read_json(handler), ())
                    with self.lock, self._db() as db:
                        if path == "/auth/logout-all":
                            db.execute("DELETE FROM sessions WHERE user_id=?", (session["user_id"],))
                        else:
                            db.execute("DELETE FROM sessions WHERE key=?", (session["key"],))
                    handler.respond(200, {"ok": True})
                elif path == "/contributions":
                    if not self.body_slot.acquire(blocking=False):
                        raise ApiError(429, "submission_busy", "正在处理另一份图片提交，请稍后再试。")
                    try:
                        handler.respond(200, self._submit(session, read_json(handler, MAX_ARCHIVE_BYTES)))
                    finally:
                        self.body_slot.release()
                elif path in ("/contributions/mine", "/contributions/pending"):
                    handler.respond(200, self._list(session, path.endswith("/pending")))
                else:
                    match = SUBMISSION_PATH.fullmatch(path)
                    if match[2]:
                        handler.respond(200, self._review(session, match[1], read_json(handler)))
                    else:
                        if not self.body_slot.acquire(blocking=False):
                            raise ApiError(429, "submission_busy", "正在处理另一份图片数据，请稍后再试。")
                        try:
                            handler.respond(200, self._detail(session, match[1]))
                        finally:
                            self.body_slot.release()
        except ApiError as exc:
            if (path in ("/auth/login", "/auth/callback") or AUTO_LOGIN_PATH.fullmatch(path) or AUTO_CONFIRM_PATH.fullmatch(path)) and "text/html" in handler.headers.get("Accept", ""):
                # These are opened in a browser tab; show readable text, never JSON escapes.
                page = ('<!doctype html><meta charset="utf-8"><title>答疑库登录</title><style>body{font:18px system-ui;max-width:46em;margin:3em auto;padding:1em}</style>'
                        '<h1>登录未完成</h1><p>' + html.escape(exc.message) + '</p>').encode("utf-8")
                handler.respond(exc.status, page, {"Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY",
                    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"},
                    content_type="text/html; charset=utf-8")
            else:
                handler.respond(exc.status, {"error": exc.code, "message": exc.message})
        except (OSError, sqlite3.Error, ArchiveError, ValueError):
            handler.respond(503, {"error": "contributions_unavailable", "message": "提交服务暂时不可用。已发起的发布会安全恢复，请稍后用相同提交编号重试。"})
        return True
