#!/usr/bin/env python3
"""Loopback-only ArchiveV1 service. TLS belongs to the existing proxy.

Library access modes: Discord role gating (default with --contributions-config),
a static bearer read token, or an explicit --public opt-in.
"""

import argparse
import hmac
import json
import os
from pathlib import Path
import stat
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from archive import ArchiveError, parse_archive, read_bounded
from contributions import Contributions

ALLOWED_ORIGINS = frozenset(("https://discord.com", "https://canary.discord.com", "https://ptb.discord.com"))
ROUTES = frozenset(("/library.json", "/readyz"))


def read_token(token_file=None, public=False, environ=None, optional=False):
    environment = os.environ if environ is None else environ
    value = environment.get("QR_READ_TOKEN")
    if optional and not token_file and not value and not public:
        return None
    if public:
        if token_file or value:
            raise ValueError("Choose public access or a read token, not both.")
        return None
    if token_file:
        if value:
            raise ValueError("Configure only one read token source.")
        path = Path(token_file)
        if os.name == "posix" and stat.S_IMODE(path.stat().st_mode) & 0o077:
            raise ValueError("Read token file must have mode 0600 or stricter.")
        with path.open("rb") as source:
            raw = source.read(514)
        try:
            value = raw.decode("ascii").rstrip("\r\n")
        except UnicodeError as exc:
            raise ValueError("Invalid read token format.") from exc
    if not value or not 32 <= len(value) <= 512 or any(ord(char) < 33 or ord(char) > 126 for char in value):
        raise ValueError("Configure a 32-512 character ASCII read token, or explicitly use --public.")
    return value.encode("ascii")


class Library:
    def __init__(self, path):
        self.path = Path(path)
        self.lock = threading.Lock()
        self.fingerprint = None
        self.data = None
        self.archive = None

    def read(self):
        with self.lock:
            status = self.path.stat()
            fingerprint = (status.st_dev, status.st_ino, status.st_size, status.st_mtime_ns, status.st_ctime_ns)
            if fingerprint != self.fingerprint:
                # Updater uses rename, so opening the path yields one complete snapshot.
                raw = read_bounded(self.path)
                archive = parse_archive(raw)
                self.data = raw
                self.archive = archive
                self.fingerprint = fingerprint
            return self.data

    def entry(self, entry_id):
        self.read()
        with self.lock:
            return next((entry for entry in self.archive["entries"] if entry["id"] == entry_id), None)


class QRServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, handler, max_workers=8):
        self.slots = threading.BoundedSemaphore(max_workers)
        super().__init__(address, handler)

    def get_request(self):
        connection, address = super().get_request()
        connection.settimeout(10)
        return connection, address

    def process_request(self, request, client_address):
        if not self.slots.acquire(blocking=False):
            try:
                # A tiny bounded drain avoids a TCP reset swallowing the 503
                # when a normal client is still writing its request headers.
                # Never wait for an unbounded body or spawn an extra worker.
                request.settimeout(0.1)
                try:
                    request.recv(8192)
                except OSError:
                    pass
                request.sendall(b"HTTP/1.0 503 Service Unavailable\r\nContent-Length: 0\r\nCache-Control: private, no-store\r\nConnection: close\r\n\r\n")
            except OSError:
                pass
            finally:
                self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self.slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.slots.release()

    def handle_error(self, request, client_address):
        # Do not log request URLs, headers, QR content, tokens or tracebacks.
        print("answer-qr: request failed", file=sys.stderr)


class Handler(BaseHTTPRequestHandler):
    server_version = "AnswerQR"
    sys_version = ""

    def log_message(self, _format, *_args):
        pass

    def respond(self, status, payload=None, headers=None, cors=True, content_type="application/json; charset=utf-8"):
        body = b"" if payload is None else payload if isinstance(payload, bytes) else json.dumps(payload, separators=(",", ":")).encode()
        self.close_connection = True
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "private, no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Connection", "close")
        self.send_header("Vary", "Origin")
        origin = self.headers.get("Origin") if hasattr(self, "headers") else None
        if cors and origin in self.server.allowed_origins:
            self.send_header("Access-Control-Allow-Origin", origin)
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if self.command != "HEAD" and body:
            self.wfile.write(body)

    def send_error(self, code, message=None, explain=None):
        # BaseHTTPRequestHandler errors normally echo parts of malformed requests.
        self.respond(code, {"error": "request_rejected"}, cors=False)

    def check_origin(self):
        values = self.headers.get_all("Origin", [])
        if values and (len(values) != 1 or values[0] not in self.server.allowed_origins):
            self.respond(403, {"error": "origin_forbidden", "message": "此来源不允许访问。"}, cors=False)
            return False
        return True

    def check_route(self):
        if self.path not in ROUTES:
            self.respond(404, {"error": "not_found"})
            return False
        return True

    def authorized(self):
        expected = self.server.read_token
        if expected is None:
            return True
        headers = self.headers.get_all("Authorization", [])
        candidate = b""
        if len(headers) == 1 and len(headers[0]) <= 520:
            scheme, separator, value = headers[0].partition(" ")
            if separator and scheme.lower() == "bearer":
                try:
                    candidate = value.encode("ascii")
                except UnicodeError:
                    pass
        return hmac.compare_digest(candidate, expected)

    def do_GET(self):
        if not self.check_origin():
            return
        if self.server.contributions.handle(self) or not self.check_route():
            return
        if self.path == "/library.json":
            if self.server.read_token is not None:
                if not self.authorized():
                    self.respond(401, {"error": "unauthorized"}, {"WWW-Authenticate": 'Bearer realm="answer-qr"'})
                    return
            elif not self.server.public and not self.server.contributions.library_access(self):
                return
        try:
            data = self.server.library.read()
        except (OSError, ArchiveError):
            self.respond(503, {"error": "library_unavailable"})
            return
        self.respond(200, {"ready": True} if self.path == "/readyz" else data)

    def do_OPTIONS(self):
        if not self.check_origin():
            return
        methods = self.server.contributions.methods(self.path)
        contribution_route = bool(methods)
        if not contribution_route and not self.check_route():
            return
        methods = methods or {"GET"}
        method = self.headers.get("Access-Control-Request-Method", "GET")
        requested = self.headers.get("Access-Control-Request-Headers", "")
        names = {part.strip().lower() for part in requested.split(",") if part.strip()}
        allowed_headers = {"authorization", "accept", "content-type"} if contribution_route else {"authorization", "accept"}
        if method not in methods or names - allowed_headers:
            self.respond(403, {"error": "preflight_forbidden"})
            return
        self.respond(204, headers={
            "Allow": ", ".join(sorted(methods | {"OPTIONS"})),
            "Access-Control-Allow-Methods": ", ".join(sorted(methods)),
            "Access-Control-Allow-Headers": "Authorization, Accept, Content-Type" if contribution_route else "Authorization, Accept",
        })

    def do_POST(self):
        if self.check_origin() and not self.server.contributions.handle(self):
            self.respond(405, {"error": "read_only"}, {"Allow": "GET, OPTIONS"})

    def reject_method(self):
        if self.check_origin():
            self.respond(405, {"error": "read_only"}, {"Allow": "GET, OPTIONS"})

    do_PUT = do_PATCH = do_DELETE = do_HEAD = do_TRACE = do_CONNECT = reject_method


def create_server(library_path, token=None, public=False, port=8765, max_workers=8, contributions_config=None, identity=None, clock=None):
    if token is not None and public:
        raise ValueError("Choose public access or a read token, not both.")
    if not 1 <= max_workers <= 8:
        raise ValueError("Worker limit must be between 1 and 8.")
    library = Library(library_path)
    contributions = Contributions(library_path, contributions_config, identity, clock, library.entry)
    if contributions.gated and (token is not None or public):
        # Refuse an ambiguous deployment instead of silently leaving the library open.
        raise ValueError("Role gating is configured; remove --public and any read token.")
    if token is None and not public and not (contributions.gated and contributions.enabled):
        raise ValueError("Configure library access: Discord role gating (guildId, libraryRoleIds and OAuth credentials), a read token, or explicit --public.")
    server = QRServer(("127.0.0.1", port), Handler, max_workers)
    server.library = library
    server.contributions = contributions
    server.allowed_origins = ALLOWED_ORIGINS | {contributions.origin}
    server.read_token = token
    server.public = public
    return server


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--library", required=True, type=Path)
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--token-file", type=Path)
    parser.add_argument("--public", action="store_true", help="Explicitly allow reading without a key.")
    parser.add_argument("--contributions-config", type=Path, help="Optional root-managed Discord OAuth/role configuration.")
    args = parser.parse_args()
    try:
        token = read_token(args.token_file, args.public, optional=args.contributions_config is not None)
        parse_archive(read_bounded(args.library))
        server = create_server(args.library, token, args.public, args.port, contributions_config=args.contributions_config)
    except (ValueError, OSError) as exc:
        # OSError text may include a sensitive configured pathname.
        print(str(exc) if isinstance(exc, ValueError) else "Service configuration or library cannot be opened.", file=sys.stderr)
        return 1
    mode = "public" if args.public else "bearer" if token is not None else "discord-role"
    print("answer-qr: listening on loopback; access mode=" + mode, flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
