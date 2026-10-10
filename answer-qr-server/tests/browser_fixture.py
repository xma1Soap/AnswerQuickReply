"""Temporary HTTP fixture for browser CSP/cookie testing; fake Discord only."""
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_role_gating import FakeGuildIdentity, GUILD, ROLE, MEMBER
from archive import EMPTY_ARCHIVE
from server import create_server

root = Path(sys.argv[1])
library = root / 'library.json'
library.write_bytes(EMPTY_ARCHIVE)
config = root / 'contributions.json'
config.write_text(json.dumps({
    'publicBaseUrl': 'https://qr-review.test/answer-qr', 'clientId': '333456789012345678',
    'clientSecret': 'test-only-client-secret', 'guildId': GUILD, 'libraryRoleIds': [ROLE],
    'databasePath': str(root / 'contributions.sqlite3'), 'reviewerIds': [], 'autoPublishIds': []
}), encoding='utf-8')
config.chmod(0o600)
with create_server(library, port=0, contributions_config=config, identity=FakeGuildIdentity()) as service:
    print(json.dumps({'port': service.server_address[1], 'userId': MEMBER}), flush=True)
    service.serve_forever(poll_interval=0.02)
