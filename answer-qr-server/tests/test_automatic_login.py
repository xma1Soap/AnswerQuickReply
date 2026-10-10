"""Automatic browser-to-plugin handoff; isolated identity and in-memory clock."""
from concurrent.futures import ThreadPoolExecutor
import json
import secrets
import unittest
from urllib.parse import parse_qs, urlencode, urlsplit

from contributions import digest, STATE_MS, AUTO_POLL_MS
import test_role_gating as roles
from test_server import request


class AutomaticLoginTests(unittest.TestCase):
    setUp = roles.RoleGatingTests.setUp
    write_config = roles.RoleGatingTests.write_config
    running = roles.RoleGatingTests.running

    def api(self, server, path, body, verifier=None):
        headers = {"Content-Type": "application/json"}
        if verifier:
            headers["Authorization"] = "LoginVerifier " + verifier
        status, response_headers, raw = request(server, "POST", path, headers, json.dumps(body).encode())
        return status, json.loads(raw), response_headers

    def start(self, server, user=roles.MEMBER):
        verifier = secrets.token_urlsafe(32)
        status, result, _ = self.api(server, "/auth/auto/start", {"challenge": digest(verifier), "userId": user})
        self.assertEqual(status, 200)
        self.assertNotIn(verifier, json.dumps(result))
        self.assertEqual(result["intervalMs"], AUTO_POLL_MS)
        return verifier, result

    def browser_start(self, server, attempt):
        status, headers, _ = request(server, path=urlsplit(attempt["loginUrl"]).path.removeprefix('/answer-qr'))
        self.assertEqual(status, 302)
        query = parse_qs(urlsplit(headers["Location"]).query)
        self.assertEqual(query['scope'], ['identify guilds.members.read'])
        return query['state'][0], headers['Set-Cookie'].split(';')[0]

    def callback(self, server, flow, user='member', error=None):
        state, cookie = flow
        values = {'state': state, **({'error': error} if error else {'code': user})}
        return request(server, path='/auth/callback?' + urlencode(values), headers={'Cookie': cookie, 'Accept': 'text/html'})

    def poll(self, server, attempt, verifier, cancel=False):
        return self.api(server, '/auth/auto/cancel' if cancel else '/auth/auto/poll', {'id': attempt['id']}, verifier)

    def test_complete_flow_has_no_code_in_browser_and_requires_private_proof(self):
        with self.running() as server:
            verifier, attempt = self.start(server)
            self.assertEqual(self.poll(server, attempt, verifier)[1]['status'], 'pending')
            flow = self.browser_start(server, attempt)
            status, headers, html = self.callback(server, flow)
            self.assertEqual(status, 200)
            self.assertIn('授权完成'.encode(), html)
            self.assertNotIn(b'<code>', html)
            self.assertNotIn(verifier.encode(), html)
            self.assertIn("default-src 'none'", headers['Content-Security-Policy'])
            self.assertEqual(self.poll(server, attempt, secrets.token_urlsafe(32))[0], 401)
            self.assertEqual(self.poll(server, attempt, attempt['id'])[0], 401)
            self.now += AUTO_POLL_MS
            status, result, _ = self.poll(server, attempt, verifier)
            self.assertEqual((status, result['status'], result['user']['id'], result['libraryAccess']), (200, 'complete', roles.MEMBER, 'ok'))
            status, _, _ = request(server, headers={'Authorization': 'Bearer '+result['token']})
            self.assertEqual(status, 200)
            self.assertEqual(self.poll(server, attempt, verifier)[0], 401)

    def test_concurrent_poll_issues_exactly_one_session(self):
        with self.running() as server:
            verifier, attempt = self.start(server)
            self.callback(server, self.browser_start(server, attempt))
            with ThreadPoolExecutor(max_workers=2) as executor:
                results = list(executor.map(lambda _: self.poll(server, attempt, verifier), range(2)))
            self.assertEqual(sorted(x[0] for x in results), [200, 401])
            with server.contributions._db() as db:
                self.assertEqual(db.execute('SELECT count(*) FROM sessions').fetchone()[0], 1)

    def test_wrong_browser_account_fails_without_session(self):
        with self.running() as server:
            verifier, attempt = self.start(server)
            status, _, _ = self.callback(server, self.browser_start(server, attempt), 'admin')
            self.assertEqual(status, 403)
            self.assertEqual(self.poll(server, attempt, verifier)[1]['status'], 'failed')
            with server.contributions._db() as db:
                self.assertEqual(db.execute('SELECT count(*) FROM sessions').fetchone()[0], 0)

    def test_missing_role_and_denied_consent_reach_plugin(self):
        for user, user_id, error in [('outsider', roles.OUTSIDER, None), ('member', roles.MEMBER, 'access_denied')]:
            with self.subTest(user=user), self.running() as server:
                verifier, attempt = self.start(server, user_id)
                status, _, html = self.callback(server, self.browser_start(server, attempt), user, error)
                self.assertIn(status, (400, 403))
                self.assertNotIn(b'<code>', html)
                self.assertEqual(self.poll(server, attempt, verifier)[1]['status'], 'failed')

    def test_cancelled_flow_cannot_fall_back_to_manual_code(self):
        with self.running() as server:
            verifier, attempt = self.start(server)
            flow = self.browser_start(server, attempt)
            self.assertEqual(self.poll(server, attempt, secrets.token_urlsafe(32), True)[0], 401)
            self.assertEqual(self.poll(server, attempt, verifier, True)[1]['status'], 'cancelled')
            self.start(server)  # Trigger cleanup before the old browser returns.
            status, _, html = self.callback(server, flow)
            self.assertEqual(status, 400)
            self.assertNotIn(b'<code>', html)
            with server.contributions._db() as db:
                self.assertEqual(db.execute('SELECT count(*) FROM codes').fetchone()[0], 0)

    def test_expired_attempt_and_cookie_mismatch(self):
        with self.running() as server:
            verifier, attempt = self.start(server)
            flow = self.browser_start(server, attempt)
            status, _, _ = self.callback(server, (flow[0], flow[1][:-1]+'!'))
            self.assertEqual(status, 400)
            self.assertEqual(self.poll(server, attempt, verifier)[1]['status'], 'pending')
            self.now += STATE_MS + 1
            self.assertEqual(self.poll(server, attempt, verifier)[0], 401)
            self.assertEqual(self.callback(server, flow)[0], 400)

    def test_two_clients_are_isolated_and_callback_is_not_replayable(self):
        with self.running() as server:
            proof1, first = self.start(server)
            proof2, second = self.start(server)
            flow = self.browser_start(server, first)
            self.assertEqual(self.callback(server, flow)[0], 200)
            self.assertEqual(self.callback(server, flow)[0], 400)
            self.assertEqual(self.poll(server, first, proof2)[0], 401)
            self.assertEqual(self.poll(server, second, proof2)[1]['status'], 'pending')
            self.assertEqual(self.poll(server, first, proof1)[1]['status'], 'complete')

    def test_role_removed_before_collection_is_rejected(self):
        with self.running() as server:
            verifier, attempt = self.start(server)
            self.callback(server, self.browser_start(server, attempt))
            with server.contributions._db() as db:
                db.execute('UPDATE access SET allowed=0 WHERE user_id=?', (roles.MEMBER,))
            self.assertEqual(self.poll(server, attempt, verifier)[1]['status'], 'failed')

    def test_capacity_schema_cors_and_secrets_are_bounded(self):
        with self.running() as server:
            self.assertEqual(self.api(server, '/auth/auto/start', {'challenge': 'bad', 'userId': roles.MEMBER})[0], 400)
            status, headers, _ = request(server, 'OPTIONS', '/auth/auto/poll', {'Origin':'https://discord.com', 'Access-Control-Request-Method':'POST', 'Access-Control-Request-Headers':'authorization,content-type'})
            self.assertEqual(status, 204)
            with server.contributions._db() as db:
                for i in range(1000):
                    db.execute("INSERT INTO auto_logins(id,challenge,expected_user,expires,status) VALUES(?,?,?,?,'pending')", (str(i), '0'*64, roles.MEMBER, self.now+STATE_MS))
            self.assertEqual(self.api(server, '/auth/auto/start', {'challenge':'0'*64,'userId':roles.MEMBER})[0], 429)
