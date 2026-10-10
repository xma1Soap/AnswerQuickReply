// Real favorites.ts with in-memory DataStore; no Discord, filesystem writes or network.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { test } = require('node:test');
// Usage: node tests/favorites.cjs /path/to/Vencord-or-esbuild-dependencies
const esbuild = createRequire(path.resolve(process.argv[2] || process.env.VENCORD_DIR || '.', 'package.json'))('esbuild');
const root = path.resolve(__dirname, '../answerQuickReply');
const compiled = esbuild.transformSync(fs.readFileSync(path.join(root, 'favorites.ts'), 'utf8'), { loader: 'ts', format: 'cjs' }).code;
const KEY = 'AnswerQuickReply_remote_favorites_v1';
const A = { libraryUrl: 'https://api.starmint.cc.cd/answer-qr/library.json', userId: '123456789012345678' };
const B = { ...A, userId: '987654321098765432' };
const CUSTOM = { libraryUrl: 'https://qr.example.test/library.json', userId: 'custom' };
const tick = async () => { for (let n = 0; n < 4; n++) await new Promise(done => setImmediate(done)); };
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function fixture(data = new Map()) {
    const writes = [], listeners = [];
    let getHandler, setHandler;
    const module = { exports: {} };
    vm.runInNewContext(compiled, { module, exports: module.exports, URL, Set, Map, Object, Error,
        console, require(name) {
            if (name !== '@api/DataStore') throw Error('Unexpected dependency ' + name);
            return { get: async key => { if (getHandler) await getHandler(key); return structuredClone(data.get(key)); },
                set: async (key, value) => { if (setHandler) await setHandler(key, value); data.set(key, structuredClone(value)); writes.push({ key, value: structuredClone(value) }); } };
        } });
    const api = module.exports;
    api.startRemoteFavorites();
    return { api, data, writes, getWith(fn) { getHandler = fn; }, setWith(fn) { setHandler = fn; } };
}

test('favorites survive fresh module reload as references only, not QR bodies or tokens', async () => {
    const f = fixture(); await f.api.loadRemoteFavorites();
    await f.api.setRemoteFavorite(A, 'shared_1', true);
    assert.equal(f.api.isRemoteFavorite(A, 'shared_1'), true);
    assert.deepEqual(f.data.get(KEY), { version: 1, entries: [{ ...A, entryId: 'shared_1' }] });
    const reopened = fixture(f.data); await reopened.api.loadRemoteFavorites();
    assert.equal(reopened.api.isRemoteFavorite(A, 'shared_1'), true);
    const saved = JSON.stringify(f.data.get(KEY));
    for (const field of ['content', 'images', 'token', 'accessKey', 'updatedAt', 'favorite']) assert(!saved.includes('"' + field + '"'));
});

test('the same entry ID is isolated across authenticated accounts and libraries', async () => {
    const f = fixture(); await f.api.loadRemoteFavorites();
    await f.api.setRemoteFavorite(A, 'collision', true);
    assert.equal(f.api.isRemoteFavorite(B, 'collision'), false);
    assert.equal(f.api.isRemoteFavorite(CUSTOM, 'collision'), false);
    await f.api.setRemoteFavorite(B, 'collision', true);
    await f.api.setRemoteFavorite(CUSTOM, 'collision', true);
    await f.api.setRemoteFavorite(A, 'collision', false);
    assert.equal(f.api.isRemoteFavorite(A, 'collision'), false);
    assert.equal(f.api.isRemoteFavorite(B, 'collision'), true);
    assert.equal(f.api.isRemoteFavorite(CUSTOM, 'collision'), true);
    assert.equal(f.api.isRemoteFavorite({ ...CUSTOM, libraryUrl: 'https://other.example.test/library.json' }, 'collision'), false);
});

test('concurrent additions and removals serialize without losing other favorites', async () => {
    const f = fixture(); await f.api.loadRemoteFavorites();
    await Promise.all([f.api.setRemoteFavorite(A, 'first', true), f.api.setRemoteFavorite(A, 'second', true)]);
    assert.equal(f.api.isRemoteFavorite(A, 'first'), true);
    assert.equal(f.api.isRemoteFavorite(A, 'second'), true);
    await Promise.all([f.api.setRemoteFavorite(A, 'first', false), f.api.setRemoteFavorite(A, 'third', true)]);
    const reopened = fixture(f.data); await reopened.api.loadRemoteFavorites();
    assert.equal(reopened.api.isRemoteFavorite(A, 'first'), false);
    assert.equal(reopened.api.isRemoteFavorite(A, 'second'), true);
    assert.equal(reopened.api.isRemoteFavorite(A, 'third'), true);
});

test('failed persistence never publishes an uncommitted favorite and later writes recover', async () => {
    const f = fixture(); await f.api.loadRemoteFavorites();
    await f.api.setRemoteFavorite(A, 'kept', true);
    const before = structuredClone(f.data.get(KEY));
    let fail = true;
    f.setWith(async () => { if (fail) { fail = false; throw Error('disk full'); } });
    await assert.rejects(f.api.setRemoteFavorite(A, 'failed', true), /disk full/);
    assert.equal(f.api.isRemoteFavorite(A, 'failed'), false);
    assert.deepEqual(f.data.get(KEY), before);
    await f.api.setRemoteFavorite(A, 'recovered', true);
    assert.equal(f.api.isRemoteFavorite(A, 'kept'), true);
    assert.equal(f.api.isRemoteFavorite(A, 'recovered'), true);
});

test('load deduplication and unsubscribe do not produce extra writes or stale notifications', async () => {
    const f = fixture(); const gate = deferred(); let gets = 0, notifications = 0;
    f.getWith(async () => { gets++; await gate.promise; });
    const first = f.api.loadRemoteFavorites(), second = f.api.loadRemoteFavorites();
    await tick(); assert.equal(gets, 1); gate.resolve(); await Promise.all([first, second]);
    const stop = f.api.subscribeRemoteFavorites(() => { notifications++; });
    await f.api.setRemoteFavorite(A, 'first', true); assert(notifications >= 1);
    const before = notifications; stop();
    await f.api.setRemoteFavorite(A, 'second', true); assert.equal(notifications, before);
    assert.equal(f.writes.length, 2);
});

test('scope and ID are captured before a deferred write', async () => {
    const f = fixture(); await f.api.loadRemoteFavorites();
    const gate = deferred(); f.setWith(() => gate.promise);
    const mutable = { ...A };
    const saved = f.api.setRemoteFavorite(mutable, 'fixed', true);
    await tick(); mutable.userId = B.userId; mutable.libraryUrl = CUSTOM.libraryUrl;
    gate.resolve(); await saved;
    assert.equal(f.api.isRemoteFavorite(A, 'fixed'), true);
    assert.equal(f.api.isRemoteFavorite(mutable, 'fixed'), false);
});

test('stopping the plugin invalidates a pending load and queued write', async () => {
    const f = fixture(); const gate = deferred(); f.getWith(() => gate.promise);
    const loading = f.api.loadRemoteFavorites();
    const write = f.api.setRemoteFavorite(A, 'stale', true);
    const settled = Promise.allSettled([loading, write]);
    await tick(); f.api.stopRemoteFavorites(); gate.resolve(); await settled;
    assert.equal(f.api.isRemoteFavorite(A, 'stale'), false);
    assert.equal(f.writes.length, 0);
    f.getWith(undefined); f.api.startRemoteFavorites(); await f.api.loadRemoteFavorites();
    assert.equal(f.api.isRemoteFavorite(A, 'stale'), false);
});

test('3000 stored references enforce a capacity bound without discarding prior favorites', async () => {
    const refs = Array.from({ length: 3000 }, (_, n) => ({ ...A, entryId: 'qr-' + n }));
    const f = fixture(new Map([[KEY, { version: 1, entries: refs }]]));
    await f.api.loadRemoteFavorites();
    await assert.rejects(f.api.setRemoteFavorite(A, 'overflow', true));
    assert.equal(f.api.isRemoteFavorite(A, 'qr-0'), true);
    assert.equal(f.api.isRemoteFavorite(A, 'qr-2999'), true);
    assert.equal(f.data.get(KEY).entries.length, 3000);
    await f.api.setRemoteFavorite(A, 'qr-0', false);
    await f.api.setRemoteFavorite(A, 'replacement', true);
    assert.equal(f.api.isRemoteFavorite(A, 'replacement'), true);
    assert.equal(f.data.get(KEY).entries.length, 3000);
});
