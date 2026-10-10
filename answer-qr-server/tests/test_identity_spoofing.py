"""Security regressions converted from the frozen identity-spoofing probes.

Fake Discord identities and temporary files only; never touches production.
"""
import json
from pathlib import Path
import re
import sys
import unittest
import uuid
from urllib.parse import urlencode, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import test_role_gating as roles
import test_automatic_login as automatic
from test_server import request, entry


class IdentitySpoofingTests(unittest.TestCase):
    setUp = roles.RoleGatingTests.setUp
    write_config = roles.RoleGatingTests.write_config
    running = roles.RoleGatingTests.running
    api = roles.RoleGatingTests.api
    callback = roles.RoleGatingTests.callback
    login = roles.RoleGatingTests.login
    read = roles.RoleGatingTests.read

    def test_user_headers_and_id_as_bearer_cannot_authorize(self):
        with self.running() as server:
            for headers in ({'X-User-ID': roles.ADMIN, 'X-Discord-ID': roles.ADMIN},
                            {'Authorization': 'Bearer '+roles.ADMIN},
                            {'Authorization': 'Bearer '+'A'*43}):
                self.assertEqual(request(server, headers=headers)[0], 401)

    def test_claimed_admin_id_cannot_replace_the_oauth_user(self):
        harness = automatic.AutomaticLoginTests()
        with self.running() as server:
            verifier, attempt = harness.start(server, roles.ADMIN)
            flow = harness.browser_start(server, attempt)
            self.assertEqual(harness.callback(server, flow, 'outsider')[0], 403)
            self.assertEqual(harness.poll(server, attempt, verifier)[1]['status'], 'failed')
            with server.contributions._db() as db:
                self.assertEqual(db.execute('SELECT count(*) FROM sessions').fetchone()[0], 0)

    def test_callback_user_and_role_parameters_are_ignored(self):
        harness = automatic.AutomaticLoginTests()
        with self.running() as server:
            _, attempt = harness.start(server, roles.OUTSIDER)
            state, cookie = harness.browser_start(server, attempt)
            query = urlencode({'state': state, 'code': 'outsider', 'userId': roles.ADMIN,
                               'roles': roles.ROLE, 'canReview': 'true'})
            status, _, _ = request(server, path='/auth/callback?'+query, headers={'Cookie':cookie})
            self.assertEqual(status, 403)
            with server.contributions._db() as db:
                self.assertEqual(db.execute('SELECT count(*) FROM sessions').fetchone()[0], 0)

    def test_manual_exchange_rejects_client_identity_fields(self):
        with self.running() as server:
            status, _, raw = self.callback(server, 'member')
            self.assertEqual(status, 200)
            code = re.search(rb'<code>([A-Za-z0-9_-]{43})</code>',raw)[1].decode()
            status, _ = self.api(server,'/auth/exchange','POST',{'userId':roles.ADMIN},extra={'Authorization':'LoginCode '+code})
            self.assertEqual(status, 400)
            status, profile = self.api(server,'/auth/exchange','POST',{},extra={'Authorization':'LoginCode '+code})
            self.assertEqual((status,profile['user']['id'],profile['canReview']), (200,roles.MEMBER,False))

    def test_valid_denied_session_cannot_gain_access_via_user_headers(self):
        with self.running() as server:
            with server.contributions.lock, server.contributions._db() as db:
                server.contributions._record_access(db,roles.OUTSIDER,[])
                profile = server.contributions._issue_session(db,roles.OUTSIDER,'outsider')
            headers = {'Authorization':'Bearer '+profile['token'],'X-User-ID':roles.ADMIN,'X-Discord-ID':roles.ADMIN}
            self.assertEqual(request(server,headers=headers)[0],403)
            status, _, raw = request(server,path='/contributions/me',headers=headers)
            self.assertEqual((status,json.loads(raw)['user']['id'],json.loads(raw)['canReview']), (200,roles.OUTSIDER,False))
            self.assertEqual(request(server,path='/contributions/pending',headers=headers)[0],403)

    def test_forwarded_login_link_cannot_issue_session_without_the_plugin_pairing_code(self):
        # The attacker owns a verifier and forwards only the browser URL. The
        # eligible victim has no matching plugin login and therefore no code.
        harness = automatic.AutomaticLoginTests()
        with self.running() as server:
            attacker_proof, attempt = harness.start(server,roles.MEMBER)
            status, headers, html = request(server, path=urlsplit(attempt['loginUrl']).path.removeprefix('/answer-qr'))
            self.assertEqual(status, 200)
            self.assertNotIn('Location', headers)
            self.assertNotIn(attempt['pairCode'].encode(), html)
            self.assertIn('配对码'.encode(), html)
            status, result, _ = harness.poll(server,attempt,attacker_proof)
            self.assertEqual((status,result['status']), (200,'pending'))
            self.assertNotIn('token', result)
            self.assertEqual(self.read(server)[0],401)
            with server.contributions._db() as db:
                self.assertEqual(db.execute('SELECT count(*) FROM sessions').fetchone()[0],0)
                self.assertEqual(db.execute('SELECT count(*) FROM states').fetchone()[0],0)

    def test_denied_former_member_cannot_read_updated_own_published_submission(self):
        self.config['autoPublishIds']=[roles.MEMBER]
        self.write_config()
        with self.running() as server:
            token,_=self.login(server)
            status,submission=self.api(server,'/contributions','POST',{'entry':entry(),'requestId':str(uuid.uuid4())},token=token)
            self.assertEqual((status,submission['status']), (200,'published'))
            current=json.loads(self.library.read_bytes())
            current['entries'][0]['content']='New cloud-only body after role removal.'
            self.library.write_text(json.dumps(current),encoding='utf-8')
            with server.contributions.lock,server.contributions._db() as db:
                server.contributions._record_access(db,roles.MEMBER,[])
            self.assertEqual(self.read(server,token)[0],403)
            status,result=self.api(server,'/contributions/'+submission['id'],token=token)
            self.assertEqual((status,result['error']), (403,'library_forbidden'))
            self.assertNotIn('New cloud-only body',json.dumps(result))


if __name__=='__main__':
    unittest.main(verbosity=2)
