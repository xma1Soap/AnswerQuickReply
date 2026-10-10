"""Safe-result regressions converted from Claude's frozen independent probes.

Fake Discord provider and temporary files only; never touches production.
"""
import json
from pathlib import Path
import sys
import unittest
import uuid
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import test_role_gating as roles
import test_automatic_login as automatic
from contributions import LOGIN_ACCESS_MS, SESSION_MS
from test_server import entry, request

DAY = 24 * 60 * 60 * 1000


class ClaudeReviewProbes(unittest.TestCase):
    setUp = roles.RoleGatingTests.setUp
    write_config = roles.RoleGatingTests.write_config
    running = roles.RoleGatingTests.running
    api = roles.RoleGatingTests.api
    callback = roles.RoleGatingTests.callback
    login = roles.RoleGatingTests.login
    read = roles.RoleGatingTests.read

    def seed(self, *entries):
        self.library.write_text(json.dumps({'version':1,'entries':list(entries)}),encoding='utf-8')

    def test_phished_owner_cannot_publish_and_clean_first_daily_backup_survives(self):
        # A reviewer who is also exempt from review remains protected by pairing.
        self.config['autoPublishIds']=[roles.ADMIN]
        self.write_config()
        self.seed({**entry(),'id':'shared_victim','content':'ORIGINAL BODY','updatedAt':5})
        with self.running() as server:
            harness=automatic.AutomaticLoginTests()
            proof,attempt=harness.start(server,roles.ADMIN)
            status,headers,html=request(server,path=urlsplit(attempt['loginUrl']).path.removeprefix('/answer-qr'))
            self.assertEqual(status,200)
            self.assertNotIn('Location',headers)
            self.assertNotIn(attempt['pairCode'].encode(),html)
            status,profile,_=harness.poll(server,attempt,proof)
            self.assertEqual((status,profile['status']),(200,'pending'))
            self.assertNotIn('token',profile)
            body={'entry':entry(),'requestId':str(uuid.uuid4())}
            self.assertEqual(self.api(server,'/contributions','POST',body,token=proof)[0],401)
            self.assertEqual(json.loads(self.library.read_bytes())['entries'][0]['content'],'ORIGINAL BODY')
            # Exercise retention independently with a genuine owner's login.
            token,_=self.login(server,'admin')
            current=json.loads(self.read(server,token)[1])['entries'][0]
            body={'entry':{**current,'content':'LEGITIMATE REVISION'},'requestId':str(uuid.uuid4()),
                  'update':{'targetId':current['id'],'baseUpdatedAt':current['updatedAt']}}
            self.assertEqual(self.api(server,'/contributions','POST',body,token=token)[0],200)
            for number in range(10):
                self.now+=1
                body={'entry':{**entry(),'title':'legitimate %d'%number},'requestId':str(uuid.uuid4())}
                self.assertEqual(self.api(server,'/contributions','POST',body,token=token)[0],200)
            backups=list((self.library.parent/'publish-backups').glob('*.json'))
            self.assertTrue(any(b'ORIGINAL BODY' in path.read_bytes() and b'LEGITIMATE REVISION' not in path.read_bytes() for path in backups))

    def test_reviewer_session_expires_after_24h_even_with_legacy_7day_expiry(self):
        with self.running() as server:
            admin_token,_=self.login(server,'admin')
            member_token,_=self.login(server,'member')
            with server.contributions._db() as db:
                db.execute('UPDATE sessions SET expires=? WHERE user_id=?',(self.now+SESSION_MS,roles.ADMIN))
            self.now+=LOGIN_ACCESS_MS+1
            self.assertEqual(self.read(server,member_token)[0],401)
            self.assertEqual(self.read(server,admin_token)[0],401)

    def test_denied_relogin_commits_revocation_and_invalidates_old_session(self):
        with self.running() as server:
            token,_=self.login(server)
            self.identity.roles[roles.MEMBER]=[]
            self.now+=60*60*1000
            self.assertEqual(self.callback(server,'member')[0],403)
            with server.contributions._db() as db:
                allowed=db.execute('SELECT allowed FROM access WHERE user_id=?',(roles.MEMBER,)).fetchone()[0]
            self.assertEqual(allowed,0)
            self.assertEqual(self.read(server,token)[0],401)

    def test_former_member_cannot_read_current_body_of_entry_they_once_edited(self):
        self.seed({**entry(),'id':'shared_other','content':'v1','updatedAt':5})
        with self.running() as server:
            member,_=self.login(server)
            admin,_=self.login(server,'admin')
            body={'entry':{**entry(),'id':'shared_other','content':'member edit'},'requestId':str(uuid.uuid4()),
                  'update':{'targetId':'shared_other','baseUpdatedAt':5}}
            status,sub=self.api(server,'/contributions','POST',body,token=member)
            self.assertEqual(status,200)
            self.assertEqual(self.api(server,'/contributions/%s/review'%sub['id'],'POST',{'decision':'approve'},token=admin)[0],200)
            current=json.loads(self.library.read_bytes())
            current['entries'][0]['content']='admin-only later text'
            self.library.write_text(json.dumps(current),encoding='utf-8')
            with server.contributions.lock,server.contributions._db() as db:
                server.contributions._record_access(db,roles.MEMBER,[])
            self.assertEqual(self.read(server,member)[0],403)
            status,detail=self.api(server,'/contributions/'+sub['id'],token=member)
            self.assertEqual((status,detail['error']),(403,'library_forbidden'))
            self.assertNotIn('admin-only later text',json.dumps(detail))


if __name__=='__main__':
    unittest.main(verbosity=2)
