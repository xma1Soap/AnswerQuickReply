import base64
from contextlib import contextmanager, redirect_stderr
import http.client
import io
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from archive import ArchiveError, EMPTY_ARCHIVE, MAX_ARCHIVE_BYTES, parse_archive, read_bounded
from server import ALLOWED_ORIGINS, create_server, read_token
from update_library import update_library

TOKEN = b"test-only-read-key-0123456789-abcdef"
AUTH = {"Authorization": "Bearer " + TOKEN.decode()}


def entry():
    return {"id": "example", "title": "Test QR", "content": "Only a test fixture", "keywords": ["524"],
            "weakKeywords": [], "images": [], "favorite": False, "updatedAt": 1}


def raw_archive(entries=None):
    return json.dumps({"version": 1, "entries": entries or []}, ensure_ascii=False).encode()


def image(mime="png", raw=b"\x89PNG\r\n\x1a\n"):
    return {"id": "image", "name": "image." + mime, "dataUrl": "data:image/" + mime + ";base64," + base64.b64encode(raw).decode()}


@contextmanager
def running(path, public=False, max_workers=8):
    server = create_server(path, None if public else TOKEN, public=public, port=0, max_workers=max_workers)
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
    thread.start()
    try:
        yield server
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def request(server, method="GET", path="/library.json", headers=None, body=None):
    connection = http.client.HTTPConnection(*server.server_address, timeout=3)
    try:
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        return response.status, dict(response.getheaders()), response.read()
    finally:
        connection.close()


class ArchiveTests(unittest.TestCase):
    def test_empty_and_full_archive(self):
        self.assertEqual(parse_archive(EMPTY_ARCHIVE), {"version": 1, "entries": []})
        item = entry()
        item["images"] = [image()]
        item["sourceUrl"] = "https://discord.com/channels/1/2/3"
        self.assertEqual(parse_archive(raw_archive([item]))["entries"], [item])

    def test_shape_limits_and_nonstandard_json(self):
        bad = [b"null", b"[]", b'{}', b'{"version":true,"entries":[]}', b'{"version":1,"entries":[],"extra":1}',
               b'{"version":1,"version":1,"entries":[]}', b'{"version":NaN,"entries":[]}', b'\xff', b'{']
        for raw in bad:
            with self.subTest(raw=raw), self.assertRaises(ArchiveError):
                parse_archive(raw)
        for field, value in (("id", "../bad"), ("title", ""), ("content", "x" * 4001), ("updatedAt", True),
                             ("updatedAt", 1.1), ("updatedAt", 9007199254740992), ("favorite", 1),
                             ("keywords", [""]), ("keywords", ["k"] * 101), ("weakKeywords", "word"),
                             ("images", [image()] * 11), ("sourceUrl", "https://user:pass@example.com/")):
            item = entry()
            item[field] = value
            with self.subTest(field=field), self.assertRaises(ArchiveError):
                parse_archive(raw_archive([item]))
        with self.assertRaises(ArchiveError):
            parse_archive(raw_archive([entry(), entry()]))
        with self.assertRaises(ArchiveError):
            parse_archive(raw_archive([{**entry(), "id": str(n)} for n in range(301)]))

    def test_base64_mime_canonical_padding_and_duplicate_images(self):
        for data in ("https://example.com/image.png", "data:image/svg+xml;base64,PHN2Zz4=", "data:image/png;base64,!!!!",
                     "data:image/png;base64,R0lGODlh", "data:image/png;base64,iVBORw0KGgo", "data:image/png;base64,iVBORw0KGgp="):
            item = entry()
            item["images"] = [{**image(), "dataUrl": data}]
            with self.subTest(data=data), self.assertRaises(ArchiveError):
                parse_archive(raw_archive([item]))
        item = entry()
        item["images"] = [image(), image()]
        with self.assertRaises(ArchiveError):
            parse_archive(raw_archive([item]))
        for mime, data in (("jpeg", b"\xff\xd8\xff"), ("gif", b"GIF89a"), ("webp", b"RIFF\x00\x00\x00\x00WEBP")):
            parse_archive(raw_archive([{**entry(), "images": [image(mime, data)]}]))

    def test_common_phone_image_and_metadata_limits(self):
        with patch("archive.MAX_IMAGE_BYTES", 7), self.assertRaises(ArchiveError):
            parse_archive(raw_archive([{**entry(), "images": [image()]}]))
        with patch("archive.MAX_TOTAL_IMAGE_BYTES", 15), self.assertRaises(ArchiveError):
            parse_archive(raw_archive([{**entry(), "images": [image(), {**image(), "id": "second"}]}]))
        # Emoji must count as two JavaScript UTF-16 units.
        item = {**entry(), "title": "🧠" * 61}
        with self.assertRaises(ArchiveError):
            parse_archive(raw_archive([item]))
        metadata = json.dumps({"version": 1, "entries": [entry()]}, ensure_ascii=False, separators=(",", ":"))
        with patch("archive.MAX_METADATA_CHARACTERS", len(metadata) - 1), self.assertRaises(ArchiveError):
            parse_archive(raw_archive([entry()]))

    def test_byte_limit_and_bounded_file_read(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "oversized.json"
            with path.open("wb") as output:
                output.truncate(MAX_ARCHIVE_BYTES)
            with self.assertRaises(ArchiveError):
                read_bounded(path)
        with patch("archive.MAX_ARCHIVE_BYTES", len(EMPTY_ARCHIVE)), self.assertRaises(ArchiveError):
            parse_archive(EMPTY_ARCHIVE)
        with patch("archive.MAX_ARCHIVE_BYTES", len(EMPTY_ARCHIVE) + 1):
            parse_archive(EMPTY_ARCHIVE)


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "library.json"
        self.path.write_bytes(EMPTY_ARCHIVE)

    def test_ready_auth_and_public_opt_in(self):
        with running(self.path) as server:
            status, headers, body = request(server, path="/readyz")
            self.assertEqual((status, json.loads(body)), (200, {"ready": True}))
            self.assertEqual(headers["Cache-Control"], "private, no-store")
            for auth in ({}, {"Authorization": "Bearer wrong"}, {"Cookie": "token=" + TOKEN.decode()}, {"Authorization": "Basic " + TOKEN.decode()}):
                status, headers, body = request(server, headers=auth)
                self.assertEqual(status, 401)
                self.assertNotIn(TOKEN, body)
                self.assertIn("WWW-Authenticate", headers)
            status, headers, body = request(server, headers=AUTH)
            self.assertEqual((status, body), (200, EMPTY_ARCHIVE))
            self.assertEqual(headers["Cache-Control"], "private, no-store")
            self.assertNotIn("Set-Cookie", headers)
        with self.assertRaises(ValueError):
            create_server(self.path, port=0)
        with running(self.path, public=True) as server:
            self.assertEqual(request(server)[0], 200)

    def test_cors_and_preflight(self):
        with running(self.path) as server:
            for origin in ALLOWED_ORIGINS:
                status, headers, _ = request(server, headers={**AUTH, "Origin": origin})
                self.assertEqual(status, 200)
                self.assertEqual(headers["Access-Control-Allow-Origin"], origin)
                self.assertNotIn("Access-Control-Allow-Credentials", headers)
                status, headers, _ = request(server, "OPTIONS", headers={"Origin": origin,
                    "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "authorization, ACCEPT"})
                self.assertEqual(status, 204)
                self.assertIn("Authorization", headers["Access-Control-Allow-Headers"])
            for origin in ("null", "https://evil.example", "https://discord.com.evil.example", "http://discord.com", "https://discord.com/"):
                status, headers, body = request(server, headers={**AUTH, "Origin": origin})
                self.assertEqual(status, 403)
                self.assertNotIn("Access-Control-Allow-Origin", headers)
                self.assertNotIn(origin.encode(), body)
            self.assertEqual(request(server, "OPTIONS", headers={"Origin": "https://discord.com", "Access-Control-Request-Method": "POST"})[0], 403)
            self.assertEqual(request(server, "OPTIONS", headers={"Origin": "https://discord.com", "Access-Control-Request-Headers": "x-secret"})[0], 403)

    def test_public_mode_keeps_validation_cors_and_read_only_routes(self):
        before = self.path.read_bytes()
        files_before = set(self.path.parent.iterdir())
        with running(self.path, public=True) as server:
            for headers in ({}, {"Origin": "https://discord.com"}, {"Authorization": "Bearer unused"}, {"Cookie": "admin=true"}):
                status, response_headers, body = request(server, headers=headers)
                self.assertEqual((status, body), (200, before))
                self.assertNotIn("WWW-Authenticate", response_headers)
                self.assertNotIn("Set-Cookie", response_headers)
            self.assertEqual(request(server, headers={"Origin": "https://evil.example"})[0], 403)
            for method in ("POST", "PUT", "PATCH", "DELETE", "HEAD", "TRACE", "CONNECT"):
                self.assertEqual(request(server, method, body=b"replace the QR library")[0], 405)
            for path in ("/upload", "/update_library.py", "/library.json?write=true", "/../library.json"):
                self.assertEqual(request(server, path=path)[0], 404)
            self.assertEqual(self.path.read_bytes(), before)
            self.assertEqual(set(self.path.parent.iterdir()), files_before)
            self.path.write_bytes(b'{"version":2,"entries":[]}')
            self.assertEqual(request(server)[0], 503)

    def test_no_writes_and_fixed_routes(self):
        with running(self.path) as server:
            for method in ("POST", "PUT", "PATCH", "DELETE", "HEAD", "TRACE", "CONNECT"):
                status, headers, _ = request(server, method, headers=AUTH, body=b"overwrite library")
                self.assertEqual(status, 405)
                self.assertEqual(headers["Allow"], "GET, OPTIONS")
            for path in ("/", "/library.json/", "/library.json?token=secret", "/../library.json", "/%2e%2e/library.json", "/read-token", "/manifest.json", "/index.js"):
                status, _, body = request(server, path=path, headers=AUTH)
                self.assertEqual(status, 404)
                self.assertNotIn(b"secret", body)
            self.assertEqual(self.path.read_bytes(), EMPTY_ARCHIVE)

    def test_reload_and_corruption_fail_closed(self):
        with running(self.path) as server:
            self.assertEqual(request(server, headers=AUTH)[2], EMPTY_ARCHIVE)
            new = Path(self.temp.name) / "new.json"
            new.write_bytes(raw_archive([entry()]))
            update_library(new, self.path)
            self.assertEqual(request(server, headers=AUTH)[2], new.read_bytes())
            self.path.write_bytes(b'{"secret":"do-not-echo"}')
            for path in ("/library.json", "/readyz"):
                status, _, body = request(server, path=path, headers=AUTH)
                self.assertEqual(status, 503)
                self.assertNotIn(b"do-not-echo", body)
            self.path.unlink()
            self.assertEqual(request(server, path="/readyz")[0], 503)

    def test_access_logs_do_not_expose_credentials_or_urls(self):
        output = io.StringIO()
        with redirect_stderr(output), running(self.path) as server:
            request(server, path="/library.json?token=never-log-this", headers={"Authorization": "Bearer never-log-this"})
        self.assertNotIn("never-log-this", output.getvalue())

    def test_bounded_workers_reject_overload_and_recover(self):
        with running(self.path, max_workers=1) as server:
            held = socket.create_connection(server.server_address, timeout=2)
            try:
                held.sendall(b"GET /readyz HTTP/1.0\r\n")  # Keep its only worker reading headers.
                deadline = time.monotonic() + 2
                while time.monotonic() < deadline:
                    if not server.slots.acquire(blocking=False):
                        break
                    server.slots.release()
                    time.sleep(0.005)
                else:
                    self.fail("The held request did not consume its worker slot.")
                self.assertEqual(request(server, path="/readyz")[0], 503)
                held.sendall(b"\r\n")
                while held.recv(8192):
                    pass
            finally:
                held.close()
            deadline = time.monotonic() + 2
            while time.monotonic() < deadline:
                if request(server, path="/readyz")[0] == 200:
                    break
                time.sleep(0.005)
            else:
                self.fail("A completed request did not release its worker slot.")


class TokenTests(unittest.TestCase):
    def test_default_requires_private_key_and_public_is_explicit(self):
        with self.assertRaises(ValueError):
            read_token(environ={})
        self.assertIsNone(read_token(public=True, environ={}))
        self.assertEqual(read_token(environ={"QR_READ_TOKEN": TOKEN.decode()}), TOKEN)
        for value in ("short", "x" * 513, "x" * 32 + "\n", "中" * 32):
            with self.assertRaises(ValueError):
                read_token(environ={"QR_READ_TOKEN": value})
        with self.assertRaises(ValueError):
            read_token(public=True, environ={"QR_READ_TOKEN": TOKEN.decode()})

    def test_token_file(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "read-token"
            path.write_bytes(TOKEN + b"\n")
            path.chmod(0o600)
            self.assertEqual(read_token(path, environ={}), TOKEN)
            with self.assertRaises(ValueError):
                read_token(path, environ={"QR_READ_TOKEN": TOKEN.decode()})
            if os.name == "posix":
                path.chmod(0o644)
                with self.assertRaises(ValueError):
                    read_token(path, environ={})


class UpdateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.destination = self.root / "library.json"
        self.source = self.root / "upload.json"
        self.source.write_bytes(EMPTY_ARCHIVE)

    def test_initial_empty_never_overwrites_existing(self):
        self.assertIsNone(update_library(self.source, self.destination, initial_only=True))
        before = self.destination.read_bytes()
        with self.assertRaises(ValueError):
            update_library(self.source, self.destination, initial_only=True)
        self.assertEqual(self.destination.read_bytes(), before)

    def test_invalid_source_does_not_touch_destination_or_create_backups(self):
        self.destination.write_bytes(EMPTY_ARCHIVE)
        self.source.write_bytes(b'{"version":2,"entries":[]}')
        with self.assertRaises(ArchiveError):
            update_library(self.source, self.destination)
        self.assertEqual(self.destination.read_bytes(), EMPTY_ARCHIVE)
        self.assertFalse((self.root / "backups").exists())
        self.assertFalse((self.root / "library.json.lock").exists())

    def test_backup_and_rollback(self):
        self.destination.write_bytes(EMPTY_ARCHIVE)
        changed = raw_archive([entry()])
        self.source.write_bytes(changed)
        backup = update_library(self.source, self.destination)
        self.assertEqual(backup.read_bytes(), EMPTY_ARCHIVE)
        self.assertEqual(self.destination.read_bytes(), changed)
        rollback_backup = update_library(backup, self.destination)
        self.assertEqual(self.destination.read_bytes(), EMPTY_ARCHIVE)
        self.assertEqual(rollback_backup.read_bytes(), changed)
        self.assertEqual(list(self.root.glob(".*.tmp")), [])

    def test_failed_replace_keeps_previous_library_and_cleans_temp(self):
        self.destination.write_bytes(EMPTY_ARCHIVE)
        self.source.write_bytes(raw_archive([entry()]))
        original = os.replace
        def fail_destination(source, destination, **kwargs):
            if Path(destination) == self.destination:
                raise OSError("simulated filesystem failure")
            return original(source, destination, **kwargs)
        with patch("update_library.os.replace", side_effect=fail_destination), self.assertRaises(OSError):
            update_library(self.source, self.destination)
        self.assertEqual(self.destination.read_bytes(), EMPTY_ARCHIVE)
        self.assertEqual(list(self.root.glob(".*.tmp")), [])
        backups = list((self.root / "backups").glob("*.json"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_bytes(), EMPTY_ARCHIVE)

    @unittest.skipUnless(os.name == "posix", "POSIX deployment: Windows readers can prevent rename with sharing violations.")
    def test_atomic_readers_observe_only_complete_snapshots(self):
        self.destination.write_bytes(EMPTY_ARCHIVE)
        changed = raw_archive([entry()])
        self.source.write_bytes(changed)
        seen, errors, stopped = set(), [], threading.Event()
        def reader():
            while not stopped.is_set():
                try:
                    data = self.destination.read_bytes()
                    parse_archive(data)
                    seen.add(data)
                except Exception as error:
                    errors.append(error)
        thread = threading.Thread(target=reader)
        thread.start()
        try:
            for _ in range(8):
                update_library(self.source, self.destination)
        finally:
            stopped.set()
            thread.join(timeout=2)
        self.assertFalse(errors)
        self.assertTrue(seen)
        self.assertTrue(seen <= {EMPTY_ARCHIVE, changed})


if __name__ == "__main__":
    unittest.main()
