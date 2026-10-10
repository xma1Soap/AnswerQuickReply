"""HTTP and database regressions for cloud authentication security fixes.

The only identity service is a fake provider, and every file is temporary.
"""
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from html.parser import HTMLParser
import json
from pathlib import Path
import secrets
import sqlite3
import sys
import unittest
from unittest.mock import patch
import uuid
from urllib.parse import parse_qs, urlencode, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import contributions
from contributions import digest, SESSION_MS, STATE_MS
import test_role_gating as roles
from test_server import entry, request

HOUR = 60 * 60 * 1000
DAY = 24 * HOUR


class Inputs(HTMLParser):
    def __init__(self, html):
        super().__init__()
        self.inputs = {}
        self.anchors = {}
        self.feed(html.decode('utf-8'))

    def handle_starttag(self, tag, attributes):
        values = dict(attributes)
        if tag == 'input' and 'name' in values:
            self.inputs[values['name']] = values.get('value', '')
        if tag == 'a' and 'id' in values:
            self.anchors[values['id']] = values.get('href', '')


class SecurityFixTests(unittest.TestCase):
    setUp = roles.RoleGatingTests.setUp
    write_config = roles.RoleGatingTests.write_config
    running = roles.RoleGatingTests.running
    api = roles.RoleGatingTests.api
    callback = roles.RoleGatingTests.callback
    login = roles.RoleGatingTests.login
    read = roles.RoleGatingTests.read

    def seed(self, *entries):
        self.library.write_text(json.dumps({'version': 1, 'entries': list(entries)}), encoding='utf-8')

    def start(self, server, user=roles.MEMBER):
        verifier = secrets.token_urlsafe(32)
        status, attempt = self.api(server, '/auth/auto/start', 'POST',
                                   {'challenge': digest(verifier), 'userId': user, 'pairing': 1})
        self.assertEqual(status, 200, attempt)
        self.assertRegex(attempt['pairCode'], r'^\d{4}$')
        return verifier, attempt

    def page(self, server, attempt):
        path = urlsplit(attempt['loginUrl']).path.removeprefix('/answer-qr')
        status, headers, html = request(server, path=path)
        self.assertEqual(status, 200, html)
        self.assertNotIn('Location', headers)
        inputs = Inputs(html).inputs
        self.assertIn('nonce', inputs)
        self.assertTrue(inputs['nonce'])
        return path, inputs['nonce'], headers['Set-Cookie'].split(';')[0], headers, html

    def confirm(self, server, page, code, nonce=None, cookie=None):
        path, saved_nonce, saved_cookie, _, _ = page
        headers = {'Content-Type': 'application/x-www-form-urlencoded'}
        if cookie is not False:
            headers['Cookie'] = saved_cookie if cookie is None else cookie
        return request(server, 'POST', path+'/confirm', headers,
                       urlencode({'nonce': saved_nonce if nonce is None else nonce, 'code': code}).encode())

    def poll(self, server, attempt, proof):
        return self.api(server, '/auth/auto/poll', 'POST', {'id': attempt['id']},
                        extra={'Authorization': 'LoginVerifier '+proof})

    def oauth_url(self, confirmation):
        self.assertEqual(confirmation[0], 200, confirmation[2])
        target = Inputs(confirmation[2]).anchors.get('oauth-continue', '')
        parts = urlsplit(target)
        self.assertEqual((parts.scheme, parts.netloc, parts.path), ('https', 'discord.com', '/oauth2/authorize'))
        return target

    def auto_callback(self, server, confirmation, user='member'):
        values = parse_qs(urlsplit(self.oauth_url(confirmation)).query)
        self.assertEqual(values['scope'], ['identify guilds.members.read'])
        state = values['state'][0]
        cookie = confirmation[1]['Set-Cookie'].split(';')[0]
        return request(server, path='/auth/callback?'+urlencode({'state': state, 'code': user}),
                       headers={'Cookie': cookie, 'Accept': 'text/html'})

    def submit(self, server, token, item=None):
        body = {'entry': item or entry(), 'requestId': str(uuid.uuid4())}
        return self.api(server, '/contributions', 'POST', body, token=token), body

    def review(self, server, token, submission):
        return self.api(server, '/contributions/'+submission['id']+'/review', 'POST',
                        {'decision': 'approve'}, token=token)

    def assert_revoked(self, server, token, submission_id):
        self.assertEqual(self.read(server, token)[0], 401)
        self.assertEqual(self.api(server, '/contributions', 'POST',
                                 {'entry': entry(), 'requestId': str(uuid.uuid4())}, token=token)[0], 401)
        self.assertEqual(self.api(server, '/contributions/'+submission_id, token=token)[0], 401)

    def test_pairing_wrong_code_once_fails_attempt_and_rejects_correct_retry(self):
        with self.running() as server:
            proof, attempt = self.start(server)
            page = self.page(server, attempt)
            wrong = '%04d' % ((int(attempt['pairCode'])+1) % 10000)
            self.assertEqual(self.confirm(server, page, wrong)[0], 400)
            self.assertEqual(self.poll(server, attempt, proof)[1]['status'], 'failed')
            self.assertEqual(self.confirm(server, page, attempt['pairCode'])[0], 400)
            with server.contributions._db() as db:
                self.assertEqual(db.execute('SELECT count(*) FROM states').fetchone()[0], 0)
                self.assertEqual(db.execute('SELECT count(*) FROM sessions').fetchone()[0], 0)

    def test_pairing_nonce_is_consumed_and_cannot_be_replayed(self):
        with self.running() as server:
            proof, attempt = self.start(server)
            page = self.page(server, attempt)
            first = self.confirm(server, page, attempt['pairCode'])
            self.assertEqual(first[0], 200)
            self.assertEqual(self.confirm(server, page, attempt['pairCode'])[0], 400)
            self.assertEqual(self.auto_callback(server, first)[0], 200)
            self.assertEqual(self.poll(server, attempt, proof)[1]['status'], 'complete')
            with server.contributions._db() as db:
                self.assertEqual(db.execute('SELECT count(*) FROM sessions').fetchone()[0], 1)

    def test_pairing_nonce_from_another_browser_cannot_confirm(self):
        for cookie_mode in ('missing', 'different_attempt'):
            with self.subTest(cookie=cookie_mode), self.running() as server:
                proof, attempt = self.start(server)
                page = self.page(server, attempt)
                _, other = self.start(server)
                other_cookie = self.page(server, other)[2]
                cookie = False if cookie_mode == 'missing' else other_cookie
                self.assertEqual(self.confirm(server, page, attempt['pairCode'], cookie=cookie)[0], 400)
                self.assertNotEqual(self.poll(server, attempt, proof)[1]['status'], 'complete')
                with server.contributions._db() as db:
                    self.assertEqual(db.execute('SELECT count(*) FROM states').fetchone()[0], 0)

    def test_pairing_field_is_required_and_strictly_versioned(self):
        with self.running() as server:
            for pairing in (None, 0, 2, True, '1'):
                body = {'challenge': digest(secrets.token_urlsafe(32)), 'userId': roles.MEMBER}
                if pairing is not None:
                    body['pairing'] = pairing
                with self.subTest(pairing=pairing):
                    status, result = self.api(server, '/auth/auto/start', 'POST', body)
                    self.assertEqual((status, result['error']), (400, 'client_outdated'))
            status, result = self.api(server, '/contributions/status')
            self.assertEqual(status, 200)
            self.assertIs(result['pairing'], True)

    def test_pairing_html_never_reveals_code_and_cookie_is_hardened(self):
        with self.running() as server:
            proof, attempt = self.start(server)
            page = self.page(server, attempt)
            self.assertNotIn(attempt['pairCode'].encode(), page[4])
            self.assertEqual(Inputs(page[4]).inputs.get('code'), '')
            self.assertIn("form-action 'self'", page[3]['Content-Security-Policy'])
            self.assertIn("default-src 'none'", page[3]['Content-Security-Policy'])
            # Chromium emits Origin:null for form POST from no-referrer pages.
            # Keep the origin for same-origin confirmation without sending an
            # external Referer to Discord from the continuation or callback.
            self.assertEqual(page[3]['Referrer-Policy'], 'same-origin')
            self.assertTrue(page[2].startswith('__Host-'))
            for flag in ('Secure', 'HttpOnly', 'SameSite=Lax', 'Path=/'):
                self.assertIn(flag, page[3]['Set-Cookie'])
            confirmed = self.confirm(server, page, attempt['pairCode'])
            self.assertEqual(confirmed[0], 200)
            self.assertNotIn('Location', confirmed[1])
            self.assertNotIn(attempt['pairCode'].encode(), confirmed[2])
            self.assertNotIn(page[1].encode(), confirmed[2])
            self.assertIn("form-action 'self'", confirmed[1]['Content-Security-Policy'])
            self.assertEqual(confirmed[1]['Referrer-Policy'], 'no-referrer')
            status, callback_headers, html = self.auto_callback(server, confirmed)
            self.assertEqual(status, 200)
            self.assertEqual(callback_headers['Referrer-Policy'], 'no-referrer')
            self.assertNotIn(attempt['pairCode'].encode(), html)
            self.assertNotIn(proof.encode(), html)
            self.assertNotIn(b'<code>', html)

    def test_pairing_queries_cannot_supply_code_or_nonce(self):
        with self.running() as server:
            proof, attempt = self.start(server)
            page = self.page(server, attempt)
            query = urlencode({'code': attempt['pairCode'], 'nonce': page[1]})
            for path in (page[0]+'?'+query, page[0]+'/confirm?'+query):
                self.assertEqual(request(server, path=path, headers={'Cookie': page[2]})[0], 404)
            self.assertEqual(request(server, 'POST', page[0]+'/confirm?'+query,
                {'Cookie': page[2], 'Content-Type': 'application/x-www-form-urlencoded'},
                urlencode({'code': attempt['pairCode'], 'nonce': page[1]}).encode())[0], 404)
            self.assertNotEqual(self.poll(server, attempt, proof)[1]['status'], 'complete')
            with server.contributions._db() as db:
                self.assertEqual(db.execute('SELECT count(*) FROM states').fetchone()[0], 0)

    def test_pairing_concurrent_confirmation_creates_only_one_oauth_state(self):
        with self.running() as server:
            _, attempt = self.start(server)
            page = self.page(server, attempt)
            with ThreadPoolExecutor(max_workers=2) as pool:
                responses = list(pool.map(lambda _: self.confirm(server, page, attempt['pairCode']), range(2)))
            self.assertEqual(sorted(result[0] for result in responses), [200, 400])
            with server.contributions._db() as db:
                self.assertEqual(db.execute('SELECT count(*) FROM states').fetchone()[0], 1)
                self.assertEqual(db.execute('SELECT count(*) FROM sessions').fetchone()[0], 0)

    def test_pairing_real_browser_origin_is_allowed_but_foreign_origin_is_rejected(self):
        with self.running() as server:
            proof, attempt = self.start(server)
            page = self.page(server, attempt)
            body = urlencode({'nonce': page[1], 'code': attempt['pairCode']}).encode()
            headers = {'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': page[2],
                       'Origin': 'https://qr.example.org'}
            for origin in ('https://foreign.example', 'null'):
                rejected = request(server, 'POST', page[0]+'/confirm', {**headers, 'Origin': origin}, body)
                self.assertEqual(rejected[0], 403)
            self.assertEqual(self.poll(server, attempt, proof)[1]['status'], 'pending')
            accepted = request(server, 'POST', page[0]+'/confirm', headers, body)
            self.assertEqual(accepted[0], 200)
            self.assertEqual(self.auto_callback(server, accepted)[0], 200)

    def test_browser_cookie_jar_keeps_two_login_tabs_isolated(self):
        with self.running() as server:
            proof_a, first = self.start(server, roles.MEMBER)
            proof_b, second = self.start(server, roles.ADMIN)
            page_a, page_b = self.page(server, first), self.page(server, second)
            jar = 'other_app=unrelated value; '+page_a[2]+'; '+page_b[2]
            redirect_a = self.confirm(server, page_a, first['pairCode'], cookie=jar)
            redirect_b = self.confirm(server, page_b, second['pairCode'], cookie=jar)
            self.assertEqual((redirect_a[0], redirect_b[0]), (200, 200))
            oauth_a = redirect_a[1]['Set-Cookie'].split(';')[0]
            oauth_b = redirect_b[1]['Set-Cookie'].split(';')[0]
            self.assertNotEqual(oauth_a.partition('=')[0], oauth_b.partition('=')[0])
            jar += '; '+oauth_a+'; '+oauth_b
            for redirect, user in ((redirect_b, 'admin'), (redirect_a, 'member')):
                state = parse_qs(urlsplit(self.oauth_url(redirect)).query)['state'][0]
                status, _, _ = request(server, path='/auth/callback?'+urlencode({'state': state, 'code': user}),
                                       headers={'Cookie': jar})
                self.assertEqual(status, 200)
            self.assertEqual(self.poll(server, first, proof_a)[1]['user']['id'], roles.MEMBER)
            self.assertEqual(self.poll(server, second, proof_b)[1]['user']['id'], roles.ADMIN)

    def test_additive_migration_rejects_old_auto_flow_without_manual_fallback(self):
        with self.running() as server:
            proof, attempt = self.start(server)
            redirect = self.confirm(server, self.page(server, attempt), attempt['pairCode'])
            self.assertEqual(redirect[0], 200)
            # Keep an independent pre-upgrade manual tab, using the old fixed
            # cookie name to exercise the compatibility path as well.
            status, manual_headers, _ = request(server, path='/auth/login')
            self.assertEqual(status, 302)
            manual_state = parse_qs(urlsplit(manual_headers['Location']).query)['state'][0]
            cookie_value = manual_headers['Set-Cookie'].split(';')[0].partition('=')[2]
        with closing(sqlite3.connect(self.config['databasePath'])) as db, db:
            for column in ('pair_code', 'pair_nonce_hash', 'pair_cookie_hash'):
                db.execute('ALTER TABLE auto_logins DROP COLUMN '+column)
        with self.running() as server:
            status, _, html = self.auto_callback(server, redirect)
            self.assertEqual(status, 400)
            self.assertNotIn(b'<code>', html)
            self.assertEqual(self.poll(server, attempt, proof)[1]['status'], 'failed')
            with server.contributions._db() as db:
                self.assertEqual(db.execute('SELECT count(*) FROM codes').fetchone()[0], 0)
                self.assertEqual(db.execute('SELECT count(*) FROM sessions').fetchone()[0], 0)
            status, _, html = request(server, path='/auth/callback?'+urlencode({'state': manual_state, 'code': 'member'}),
                headers={'Cookie': contributions.COOKIE_NAME+'='+cookie_value})
            self.assertEqual(status, 200)
            self.assertIn(b'<code>', html)

    def test_privileged_legacy_sessions_expire_by_created_at_for_both_lists(self):
        self.config['autoPublishIds'] = [roles.MEMBER]
        self.write_config()
        with self.running() as server:
            for user in ('admin', 'member'):
                with self.subTest(user=user):
                    token, profile = self.login(server, user)
                    self.assertEqual(profile['expiresAt'], self.now+DAY)
                    with server.contributions._db() as db:
                        db.execute('UPDATE sessions SET created_at=?,expires=? WHERE key=?',
                                   (self.now-DAY+1, self.now+SESSION_MS, digest(token)))
                    self.assertEqual(self.read(server, token)[0], 200)
                    with server.contributions._db() as db:
                        db.execute('UPDATE sessions SET created_at=? WHERE key=?', (self.now-DAY, digest(token)))
                    self.assertEqual(self.read(server, token)[0], 401)

    def test_publish_quota_is_shared_between_auto_publish_and_review_and_retries(self):
        self.config.update(autoPublishIds=[roles.ADMIN], publishesPerHour=2)
        self.write_config()
        with self.running() as server:
            admin, _ = self.login(server, 'admin')
            member, _ = self.login(server)
            (status, automatic), first_body = self.submit(server, admin)
            self.assertEqual((status, automatic['status']), (200, 'published'))
            (status, pending), _ = self.submit(server, member)
            self.assertEqual((status, pending['status']), (200, 'pending'))
            approved = self.review(server, admin, pending)
            self.assertEqual((approved[0], approved[1]['status']), (200, 'published'))
            self.assertEqual(self.api(server, '/contributions', 'POST', first_body, token=admin), (200, automatic))
            self.assertEqual(self.review(server, admin, pending)[0], 200)
            before = self.library.read_bytes()
            self.assertEqual(self.submit(server, admin)[0][0], 429)
            (_, second_pending), _ = self.submit(server, member)
            self.assertEqual(self.review(server, admin, second_pending)[0], 429)
            self.assertEqual(self.library.read_bytes(), before)
            self.now += HOUR+1
            self.assertEqual(self.review(server, admin, second_pending)[0], 200)

    def test_publish_quota_concurrent_writes_do_not_exceed_limit(self):
        self.config.update(autoPublishIds=[roles.ADMIN], publishesPerHour=1)
        self.write_config()
        with self.running() as server:
            token, _ = self.login(server, 'admin')
            with ThreadPoolExecutor(max_workers=2) as pool:
                responses = list(pool.map(lambda _: self.submit(server, token)[0], range(2)))
            self.assertEqual(sorted(result[0] for result in responses), [200, 429])
            self.assertEqual(len(json.loads(self.library.read_bytes())['entries']), 1)

    def test_concurrent_review_approvals_share_one_remaining_publish_slot(self):
        self.config['publishesPerHour'] = 1
        self.write_config()
        with self.running() as server:
            member, _ = self.login(server)
            admin, _ = self.login(server, 'admin')
            pending = [self.submit(server, member)[0][1] for _ in range(2)]
            self.assertEqual([item['status'] for item in pending], ['pending', 'pending'])
            # Review requests do not use the image-body semaphore, so this
            # checks the quota transaction itself rather than body contention.
            with ThreadPoolExecutor(max_workers=2) as pool:
                responses = list(pool.map(lambda item: self.review(server, admin, item), pending))
            self.assertEqual(sorted(result[0] for result in responses), [200, 429])
            rejected = next(result[1] for result in responses if result[0] == 429)
            self.assertEqual(rejected['error'], 'publish_rate_limited')
            self.assertEqual(len(json.loads(self.library.read_bytes())['entries']), 1)
            with server.contributions._db() as db:
                self.assertEqual(db.execute('SELECT count(*) FROM publication_limits WHERE user_id=?',
                    (roles.ADMIN,)).fetchone()[0], 1)
                self.assertEqual(db.execute("SELECT count(*) FROM submissions WHERE status='pending'").fetchone()[0], 1)

    def test_publish_quota_is_reserved_once_across_crash_recovery_and_retry(self):
        self.config.update(autoPublishIds=[roles.ADMIN], publishesPerHour=1)
        self.write_config()
        for after_replace in (False, True):
            self.now += HOUR+1
            with self.subTest(after_replace=after_replace), self.running() as server:
                token, _ = self.login(server, 'admin')
                original_write = contributions.atomic_write
                def interrupted(destination, raw, owner=None):
                    if destination == self.library and not after_replace:
                        raise OSError('test failure before replace')
                    original_write(destination, raw, owner)
                    if destination == self.library:
                        raise OSError('test failure after replace')
                with patch('contributions.atomic_write', side_effect=interrupted):
                    (status, _), body = self.submit(server, token)
                    self.assertEqual(status, 503)
                with server.contributions._db() as db:
                    row = db.execute('SELECT id,status FROM submissions WHERE request_id=?', (body['requestId'],)).fetchone()
                    submission_id = row['id']
                    self.assertEqual(row['status'], 'publishing')
                    self.assertEqual(db.execute('SELECT count(*) FROM publication_limits WHERE submission_id=?',
                        (submission_id,)).fetchone()[0], 1)
                server.contributions.recover()
                status, result = self.api(server, '/contributions', 'POST', body, token=token)
                self.assertEqual((status, result['status']), (200, 'published'))
                self.assertEqual(self.submit(server, token)[0][0], 429)
                with server.contributions._db() as db:
                    self.assertEqual(db.execute('SELECT count(*) FROM publication_limits WHERE submission_id=?',
                        (submission_id,)).fetchone()[0], 1)

    def test_logout_all_invalidates_every_user_session_but_preserves_other_users(self):
        with self.running() as server:
            first, _ = self.login(server)
            second, _ = self.login(server)
            admin, _ = self.login(server, 'admin')
            (_, submission), _ = self.submit(server, first)
            status, _ = self.api(server, '/auth/logout-all', 'POST', {}, token=first)
            self.assertEqual(status, 200)
            for token in (first, second):
                self.assert_revoked(server, token, submission['id'])
            self.assertEqual(self.read(server, admin)[0], 200)
            self.assertEqual(self.api(server, '/auth/logout-all', 'POST', {}, token=first)[0], 401)

    def test_logout_all_rejects_unauthenticated_and_identity_fields(self):
        with self.running() as server:
            token, _ = self.login(server)
            self.assertEqual(self.api(server, '/auth/logout-all', 'POST', {})[0], 401)
            self.assertEqual(self.api(server, '/auth/logout-all', 'POST', {'userId': roles.ADMIN}, token=token)[0], 400)
            self.assertEqual(self.read(server, token)[0], 200)

    def test_denied_relogin_revokes_all_old_sessions_for_only_that_user(self):
        with self.running() as server:
            first, _ = self.login(server)
            second, _ = self.login(server)
            admin, _ = self.login(server, 'admin')
            (_, submission), _ = self.submit(server, first)
            self.identity.roles[roles.MEMBER] = []
            self.assertEqual(self.callback(server, 'member')[0], 403)
            for token in (first, second):
                self.assert_revoked(server, token, submission['id'])
            with server.contributions._db() as db:
                self.assertEqual(db.execute('SELECT allowed FROM access WHERE user_id=?', (roles.MEMBER,)).fetchone()[0], 0)
                self.assertEqual(db.execute('SELECT count(*) FROM sessions WHERE user_id=?', (roles.MEMBER,)).fetchone()[0], 0)
            self.assertEqual(self.read(server, admin)[0], 200)

    def test_detail_checks_denied_access_before_cached_or_live_entry_bodies(self):
        with self.running() as server:
            token, _ = self.login(server)
            admin, _ = self.login(server, 'admin')
            (_, submission), _ = self.submit(server, token, {**entry(), 'content': 'cloud secret'})
            self.assertEqual(submission['status'], 'pending')
            with server.contributions._db() as db:
                server.contributions._record_access(db, roles.MEMBER, [])
            status, result = self.api(server, '/contributions/'+submission['id'], token=token)
            self.assertEqual(status, 403)
            self.assertNotIn('cloud secret', json.dumps(result))
            self.assertEqual(self.review(server, admin, submission)[0], 200)
            status, result = self.api(server, '/contributions/'+submission['id'], token=token)
            self.assertEqual(status, 403)
            self.assertNotIn('cloud secret', json.dumps(result))
            mine = self.api(server, '/contributions/mine', token=token)
            self.assertEqual(mine[0], 200)
            self.assertNotIn('cloud secret', json.dumps(mine[1]))

    def test_detail_expired_role_proof_revokes_session_before_body(self):
        with self.running() as server:
            token, _ = self.login(server)
            (_, submission), _ = self.submit(server, token)
            self.now += DAY+1
            status, result = self.api(server, '/contributions/'+submission['id'], token=token)
            self.assertEqual((status, result['error']), (401, 'access_recheck_required'))
            self.assert_revoked(server, token, submission['id'])

    def test_role_proof_hours_one_expires_at_one_hour_and_requires_new_login(self):
        self.config['roleProofHours'] = 1
        self.write_config()
        with self.running() as server:
            token, _ = self.login(server)
            self.now += HOUR-1
            self.assertEqual(self.read(server, token)[0], 200)
            self.now += 2
            self.assertEqual(self.read(server, token)[0], 401)
            fresh, _ = self.login(server)
            self.assertEqual(self.read(server, fresh)[0], 200)

    def test_security_configuration_bounds_reject_unsafe_values(self):
        for field, values in (('roleProofHours', (0, 25, True, '1')),
                              ('publishesPerHour', (0, 10001, True, '30'))):
            for value in values:
                with self.subTest(field=field, value=value):
                    self.config[field] = value
                    self.write_config()
                    with self.assertRaises(ValueError):
                        with self.running():
                            pass
            del self.config[field]

    def test_update_detail_current_is_reviewer_only_and_tracks_live_target(self):
        original = {**entry(), 'id': 'shared_other', 'content': 'existing body', 'updatedAt': 5}
        self.seed(original)
        with self.running() as server:
            member, _ = self.login(server)
            admin, _ = self.login(server, 'admin')
            body = {'entry': {**original, 'content': 'proposed body'}, 'requestId': str(uuid.uuid4()),
                    'update': {'targetId': original['id'], 'baseUpdatedAt': original['updatedAt']}}
            status, submission = self.api(server, '/contributions', 'POST', body, token=member)
            self.assertEqual(status, 200)
            path = '/contributions/'+submission['id']
            detail = self.api(server, path, token=admin)[1]['submission']
            self.assertEqual(detail['current'], original)
            self.assertEqual(detail['entry']['content'], 'proposed body')
            self.assertNotIn('current', self.api(server, path, token=member)[1]['submission'])
            changed = {**original, 'content': 'later cloud version', 'updatedAt': 6}
            self.seed(changed)
            self.assertEqual(self.api(server, path, token=admin)[1]['submission']['current'], changed)
            self.assertNotIn('current', self.api(server, path, token=member)[1]['submission'])

    def test_add_detail_does_not_return_current_for_reviewer(self):
        with self.running() as server:
            member, _ = self.login(server)
            admin, _ = self.login(server, 'admin')
            (_, submission), _ = self.submit(server, member)
            detail = self.api(server, '/contributions/'+submission['id'], token=admin)[1]['submission']
            self.assertNotIn('current', detail)

    def test_auto_capacity_accepts_5000_and_never_evicts_pending_attempts(self):
        with self.running() as server:
            proof, attempt = self.start(server)
            with server.contributions._db() as db:
                db.executemany("INSERT INTO auto_logins(id,challenge,expected_user,expires,status) VALUES(?,?,?,?,'pending')",
                    [('seed_%d'%n, '0'*64, roles.MEMBER, self.now+STATE_MS) for n in range(4998)])
            self.assertEqual(len(self.start(server)[1]['pairCode']), 4)
            status, _ = self.api(server, '/auth/auto/start', 'POST',
                {'challenge': digest(secrets.token_urlsafe(32)), 'userId': roles.MEMBER, 'pairing': 1})
            self.assertEqual(status, 429)
            self.assertEqual(self.poll(server, attempt, proof)[1]['status'], 'pending')
            with server.contributions._db() as db:
                self.assertEqual(db.execute('SELECT count(*) FROM auto_logins').fetchone()[0], 5000)
                self.assertIn(db.execute('SELECT status FROM auto_logins WHERE id=?', (attempt['id'],)).fetchone()[0], ('pairing', 'pending'))

    def test_state_capacity_accepts_5000_and_preserves_pending_manual_login(self):
        with self.running() as server:
            status, headers, _ = request(server, path='/auth/login')
            self.assertEqual(status, 302)
            state = parse_qs(urlsplit(headers['Location']).query)['state'][0]
            cookie = headers['Set-Cookie'].split(';')[0]
            with server.contributions._db() as db:
                db.executemany('INSERT INTO states(key,cookie_hash,expires) VALUES(?,?,?)',
                    [('seed_%d'%n, 'c'*64, self.now+STATE_MS) for n in range(4998)])
            self.assertEqual(request(server, path='/auth/login')[0], 302)
            self.assertEqual(request(server, path='/auth/login')[0], 429)
            with server.contributions._db() as db:
                self.assertEqual(db.execute('SELECT count(*) FROM states').fetchone()[0], 5000)
            status, _, html = request(server, path='/auth/callback?'+urlencode({'state': state, 'code': 'member'}),
                                      headers={'Cookie': cookie})
            self.assertEqual(status, 200)
            self.assertIn(b'<code>', html)

    def test_full_state_table_fails_confirmed_attempt_instead_of_waiting_forever(self):
        with self.running() as server:
            proof, attempt = self.start(server)
            page = self.page(server, attempt)
            with server.contributions._db() as db:
                db.executemany('INSERT INTO states(key,cookie_hash,expires) VALUES(?,?,?)',
                    [('seed_%d'%n, 'c'*64, self.now+STATE_MS) for n in range(5000)])
            self.assertEqual(self.confirm(server, page, attempt['pairCode'])[0], 429)
            self.assertEqual(self.poll(server, attempt, proof)[1]['status'], 'failed')
            with server.contributions._db() as db:
                self.assertEqual(db.execute('SELECT count(*) FROM states').fetchone()[0], 5000)
                self.assertEqual(db.execute('SELECT count(*) FROM sessions').fetchone()[0], 0)


if __name__ == '__main__':
    unittest.main(verbosity=2)
