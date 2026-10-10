// Run with: node tests/automatic-login.cjs /path/to/Vencord
// Uses the real TypeScript module; Discord, storage, clock and HTTP are isolated.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { webcrypto, createHash } = require('node:crypto');
const esbuild = createRequire(path.resolve(process.argv[2] || '.', 'package.json'))('esbuild');
const source = fs.readFileSync(path.join(__dirname, '../answerQuickReply/contribute.ts'), 'utf8');
const compiled = esbuild.transformSync(source, { loader: 'ts', format: 'cjs' }).code;
const USER = '123456789012345678';
const SESSION = 'AnswerQuickReply_contribution_session_v1';
const BASE = 'https://api.starmint.cc.cd/answer-qr';
const tick = async () => { for (let i = 0; i < 8; ++i) await new Promise(resolve => setImmediate(resolve)); };
const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
function fixture() {
    let now = Date.now(), timerId = 0, user = USER, refreshes = 0;
    const store = new Map(), timers = new Map(), requests = [], writes = [];
    const result = { status: 'pending' };
    const m = { exports: {} };
    const handlers = {};
    const complete = () => ({ status: 'complete', token: 'x'.repeat(43), expiresAt: now + 3600000, user: { id: USER, username: 'tester' }, canReview: false, canAutoPublish: false, libraryAccess: 'ok' });
    const defaultHandler = (url, options) => {
        if (url.endsWith('/status')) return response({ enabled: true, loginUrl: BASE + '/auth/login', automaticLogin: true, pairing: true });
        if (url.endsWith('/auto/start')) return response({ id: 'a'.repeat(43), loginUrl: BASE + '/auth/auto/login/' + 'a'.repeat(43), pairCode: '0042', expiresAt: now + 600000, intervalMs: 5000 });
        if (url.endsWith('/auto/cancel')) return response({ status: 'cancelled' });
        if (url.endsWith('/auto/poll')) return response(result);
        throw Error('Unexpected network request: ' + url);
    };
    vm.runInNewContext(compiled, {
        module: m, exports: m.exports, console, TextEncoder, TextDecoder, Uint8Array, AbortController, Date: class extends Date { static now() { return now; } }, btoa,
        crypto: webcrypto, setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, at: now + ms, ms }); return id; }, clearTimeout(id) { timers.delete(id); },
        fetch: async (url, options) => { requests.push({ url, options }); return (handlers[url.split('/').at(-1)] || defaultHandler)(url, options); },
        require(name) {
            if (name === '@api/DataStore') return { get: async key => store.get(key), set: async (key, value) => { if (handlers.write) await handlers.write(key, value); writes.push({ key, value }); store.set(key, value); } };
            if (name === './remote') return { DEFAULT_REMOTE_URL: BASE + '/library.json', clearRemoteCache() {}, getRemoteState: () => ({ config: { url: BASE + '/library.json' } }), refreshRemoteLibrary: async () => { refreshes++; } };
            if (name === './model') return {};
            throw Error('Unexpected import '+name);
        }
    });
    const api = m.exports; api.startContributions();
    return { api, requests, store, handlers, complete, result, writes, refreshes: () => refreshes,
        user: () => user, switchUser: () => { user = '987654321098765432'; },
        async advance(ms = 5000) { now += ms; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); } await tick(); },
        async prepare() { await api.loadContributionPanel(); await api.prepareAutomaticLogin(USER); },
        wait() { return api.waitForAutomaticLogin(() => user); }
    };
}
(async () => {
    {
        const f = fixture(); await f.prepare();
        const start = f.requests.find(r => r.url.endsWith('/start'));
        const challenge = JSON.parse(start.options.body).challenge;
        assert.equal(JSON.parse(start.options.body).pairing, 1);
        assert.equal(f.api.getContributionState().pairCode, '0042', 'leading zero pairing code is shown in the plugin');
        assert(!f.api.getContributionState().autoLoginUrl.includes('0042'), 'pair code is never put into the browser URL');
        assert.equal(f.store.size, 0, 'login proof is never persisted');
        const first = f.wait(), second = f.wait();
        await f.advance();
        assert.equal(f.requests.filter(r => r.url.endsWith('/poll')).length, 1, 'double click shares one polling loop');
        const poll = f.requests.find(r => r.url.endsWith('/poll'));
        const proof = poll.options.headers.Authorization.slice('LoginVerifier '.length);
        assert.equal(createHash('sha256').update(proof).digest('hex'), challenge);
        assert(!f.api.getContributionState().autoLoginUrl.includes(proof));
        assert.equal(poll.options.credentials, 'omit'); assert.equal(poll.options.redirect, 'error');
        Object.assign(f.result, f.complete()); await f.advance(); await Promise.all([first, second]);
        assert.equal(f.api.getContributionState().user.id, USER);
        assert.equal(f.store.get(SESSION).token, 'x'.repeat(43)); assert.equal(f.refreshes(), 1);
        assert.equal(f.api.getContributionState().loginWaiting, false);
        assert.equal(f.api.getContributionState().pairCode, '');
    }
    {
        const f = fixture(); await f.prepare(); const p = assert.rejects(f.wait(), /取消/);
        f.api.cancelAutomaticLogin(); await p;
        assert.equal(f.store.size, 0); assert(f.requests.some(r => r.url.endsWith('/cancel')));
        assert.equal(f.api.getContributionState().pairCode, '');
    }
    {
        const f = fixture(); await f.prepare(); const p = assert.rejects(f.wait(), /超时/);
        await f.advance(600001); await p; assert.equal(f.store.size, 0);
    }
    {
        const f = fixture(); await f.prepare(); const p = assert.rejects(f.wait(), /账号已切换/);
        f.switchUser(); await f.advance(); await p; assert.equal(f.store.size, 0);
    }
    {
        const f = fixture(); await f.prepare(); let resolve;
        f.handlers.poll = () => new Promise(done => { resolve = done; });
        const p = assert.rejects(f.wait(), /取消/); await f.advance();
        f.api.stopContributions(); resolve(response(f.complete())); await p;
        assert.equal(f.store.get(SESSION), undefined, 'late responses cannot resurrect stopped plugin sessions');
    }
    {
        const f = fixture(); await f.prepare(); Object.assign(f.result, f.complete());
        let resolve; f.handlers.write = () => new Promise(done => { resolve = done; });
        const p = assert.rejects(f.wait(), /取消/); await f.advance();
        f.api.stopContributions(); delete f.handlers.write; resolve(); await p;
        assert.equal(f.store.get(SESSION), null, 'stop during storage write clears stale credentials');
    }
    {
        const f = fixture(); await f.prepare(); Object.assign(f.result, f.complete(), { user: { id: '987654321098765432', username: 'other' } });
        const p = assert.rejects(f.wait(), /账号或答疑权限/); await f.advance(); await p; assert.equal(f.store.size, 0);
    }
    {
        const f = fixture(); await f.prepare(); Object.assign(f.result, { status: 'failed', message: '没有答疑身份组' });
        const p = assert.rejects(f.wait(), /没有答疑身份组/); await f.advance(); await p; assert.equal(f.store.size, 0);
    }
    {
        const f = fixture(); await f.prepare(); f.handlers.poll = () => { throw Error('network failed'); };
        const p = assert.rejects(f.wait(), /network failed/);
        await f.advance(); await f.advance(10000); await f.advance(15000); await p;
        assert.equal(f.requests.filter(r => r.url.endsWith('/poll')).length, 3);
    }
    {
        const f = fixture(); await f.api.loadContributionPanel();
        f.handlers.start = () => response({ id: 'a'.repeat(43), loginUrl: 'https://evil.example/', expiresAt: Date.now()+600000, intervalMs: 5000 });
        await assert.rejects(f.api.prepareAutomaticLogin(USER), /无效信息/);
        assert.equal(f.api.getContributionState().autoLoginUrl, '');
    }
    {
        const f = fixture(); f.handlers.status = () => response({ enabled: true, loginUrl: BASE + '/auth/login', automaticLogin: true });
        await f.prepare();
        assert.equal(f.api.getContributionState().automaticLogin, false, 'old server cannot silently bypass pairing');
        assert(!f.requests.some(r => r.url.endsWith('/start')));
    }
    {
        const f = fixture(); await f.api.loadContributionPanel();
        f.handlers.start = () => response({ id: 'a'.repeat(43), loginUrl: BASE + '/auth/auto/login/' + 'a'.repeat(43), pairCode: 42, expiresAt: Date.now() + 600000, intervalMs: 5000 });
        await assert.rejects(f.api.prepareAutomaticLogin(USER), /无效信息/);
        assert.equal(f.api.getContributionState().pairCode, '');
    }
    console.log('PASS: 12 automatic-login scenarios (pairing/proof binding, leading zeros, duplicate clicks, cancellation, timeout, account switch, late responses, stop during persistence, role/account refusal, retry bounds, URL validation and old-server fallback).');
})().catch(error => { console.error(error); process.exitCode = 1; });
