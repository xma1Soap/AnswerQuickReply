// Uses the real plugin modules with simulated Discord/React and HTTP responses.
// VENCORD_DIR must point to a Vencord checkout with dependencies installed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { createRequire } = require('node:module');
const esbuild = createRequire(path.resolve(process.env.VENCORD_DIR || '.', 'package.json'))('esbuild');
const root = path.resolve(__dirname, '..');
const base = 'https://api.starmint.cc.cd/answer-qr';
const token = 'test-qr-session-only';
const id = '11111111-2222-4333-8444-555555555555';
const qr = { id: 'shared_test', title: 'Cloud QR', content: 'Old reply', keywords: ['524'], weakKeywords: [], images: [], favorite: false, updatedAt: 42 };
const update = { targetId: qr.id, baseUpdatedAt: qr.updatedAt };
function compile(name, extra = '') {
    return esbuild.transformSync(fs.readFileSync(path.join(root, name), 'utf8') + extra, { loader: name.endsWith('tsx') ? 'tsx' : 'ts', format: 'cjs', jsxFactory: '__jsx', jsxFragment: '__Fragment' }).code;
}
function client(data = new Map()) {
    const modules = {}, calls = [];
    let fail = false, supports = true, url = base + '/library.json', refreshes = 0, clears = 0;
    const profile = { user: { id: '123456789012345678', username: 'tester' }, canReview: true, canAutoPublish: true, libraryAccess: 'ok', expiresAt: Date.now() + 3600000 };
    data.set('AnswerQuickReply_contribution_session_v1', { ...profile, token });
    const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    function load(name) {
        if (modules[name]) return modules[name];
        const module = { exports: {} };
        vm.runInNewContext(compile(name + '.ts'), {
            module, exports: module.exports, crypto: webcrypto, URL, TextEncoder, TextDecoder, Uint8Array, AbortController, Date, atob, setTimeout, clearTimeout,
            fetch: async (target, options) => {
                calls.push({ target, options });
                if (target.endsWith('/status')) return response({ enabled: true, loginUrl: base + '/auth/login', cloudEditing: supports });
                if (target.endsWith('/me')) return response(profile);
                if (target.endsWith('/mine')) return response({ submissions: [{ id, title: qr.title, status: 'pending', createdAt: 1, updatedAt: 1, update }] });
                if (fail) throw Error('connection lost after POST');
                if (target.endsWith('/' + id)) return response({ submission: { id, title: qr.title, status: 'pending', createdAt: 1, updatedAt: 1, update, entry: { ...qr, content: 'Proposed reply' }, current: qr } });
                if (target.endsWith('/logout-all')) return response({ revoked: 2 });
                return response({ id, status: 'published' });
            },
            require: name => name === '@api/DataStore' ? { get: async key => structuredClone(data.get(key)), set: async (key, value) => data.set(key, structuredClone(value)) }
                : name === './model' ? load('model') : name === './remote' ? { DEFAULT_REMOTE_URL: base + '/library.json', getRemoteState: () => ({ config: { url } }), clearRemoteCache: () => { clears++; }, refreshRemoteLibrary: async () => { assert.equal(clears, refreshes + 1); refreshes++; } } : (() => { throw Error(name); })()
        });
        return modules[name] = module.exports;
    }
    const api = load('contribute'); api.startContributions();
    return { api, data, calls, fail: v => { fail = v; }, reviewer: v => { profile.canReview = v; }, supports: v => { supports = v; }, url: v => { url = v; }, refreshes: () => refreshes };
}
const jsx = (type, props, ...children) => ({ type, props: { ...props, children } });
const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === 'object' ? [tree, ...nodes(tree.props?.children)] : [];
const text = tree => Array.isArray(tree) ? tree.map(text).join('') : tree && typeof tree === 'object' ? text(tree.props?.children) : tree ?? '';
function ui() {
    let hook = 0, closed = 0, fail = false;
    const state = [], submitted = [], local = [], notices = [];
    const common = {
        Modal: 'Modal', useMemo: fn => fn(), useEffect() {},
        useState(initial) { const index = hook++; if (!(index in state)) state[index] = typeof initial === 'function' ? initial() : initial; return [state[index], value => { state[index] = typeof value === 'function' ? value(state[index]) : value; }]; },
        useRef(initial) { const index = hook++; return state[index] ??= { current: initial }; }
    };
    const module = { exports: {} };
    vm.runInNewContext(compile('ui.tsx', '\nexport { Editor, Detail };'), {
        module, exports: module.exports, __jsx: jsx, __Fragment: 'Fragment', crypto: webcrypto, Date, setTimeout, clearTimeout,
        require(name) {
            if (name === '@webpack/common') return common;
            if (name === './model') return { QR_LIMITS: { title: 120, content: 4000, imagesPerEntry: 10 }, normalizeText: s => s.toLowerCase().trim() };
            if (name === './store') return { getEntries: () => [qr], saveEntry: async entry => { local.push(entry); } };
            if (name === './bridge') return { errorText: e => e.message };
            if (name === './notify') return { showQrToast: (...args) => notices.push(args) };
            if (name === './contribute') return { submitContribution: async (...args) => { submitted.push(structuredClone(args)); if (fail) throw Error('offline'); return { id, status: 'pending' }; } };
            return {};
        }
    });
    const props = { modalProps: { onClose() { closed++; } }, entry: structuredClone(qr), cloudUpdate: update };
    return { render: () => { hook = 0; return module.exports.Editor(props); }, detail: module.exports.Detail, fail: v => { fail = v; }, submitted, local, notices, closed: () => closed };
}
(async () => {
    const f = client(); await f.api.loadContributionPanel();
    f.fail(true);
    const draft = { ...qr, content: 'New reply' }, target = { ...update };
    const attempted = f.api.submitContribution(draft, target);
    draft.content = 'mutated after click'; target.targetId = 'wrong';
    await assert.rejects(attempted, /connection lost/);
    const first = JSON.parse(f.calls.at(-1).options.body);
    assert.equal(first.entry.content, 'New reply'); assert.deepEqual(first.update, update);
    f.api.stopContributions();
    const reopened = client(f.data); await reopened.api.loadContributionPanel();
    await reopened.api.submitContribution({ ...qr, content: 'New reply' }, update);
    const second = JSON.parse(reopened.calls.at(-1).options.body);
    assert.deepEqual(second, first, 'same edit reuses request ID after restart');
    assert.equal(reopened.refreshes(), 1);
    const record = (await reopened.api.listSubmissions())[0];
    assert.equal(record.update.targetId, qr.id);
    const reviewed = await reopened.api.readSubmission(id);
    assert.equal(reviewed.current.content, 'Old reply');
    assert.equal(reviewed.entry.content, 'Proposed reply');
    assert(Object.isFrozen(reviewed.current), 'review current snapshot is immutable');
    reopened.reviewer(false); await reopened.api.loadContributionPanel();
    assert.equal((await reopened.api.readSubmission(id)).current, undefined, 'client never exposes reviewer comparison to an author');
    reopened.reviewer(true); await reopened.api.loadContributionPanel();
    const before = reopened.calls.length;
    reopened.url('https://custom.example/library.json');
    await assert.rejects(reopened.api.submitContribution(qr, update), /当前云端服务/);
    assert.equal(reopened.calls.length, before);
    reopened.url(base + '/library.json'); reopened.supports(false); await reopened.api.loadContributionPanel();
    await assert.rejects(reopened.api.submitContribution(qr, update), /当前云端服务/);
    await assert.rejects(reopened.api.submitContribution(qr, { ...update, targetId: 'other' }), /ID 不匹配/);
    // Create-only legacy behavior is still supported.
    await reopened.api.submitContribution(qr);
    assert.equal(JSON.parse(reopened.calls.at(-1).options.body).update, undefined);
    reopened.api.stopContributions();
    const screen = ui(); let tree = screen.render();
    assert.equal(tree.props.title, '编辑云端 QR');
    nodes(tree).find(n => n.type === 'textarea').props.onChange({ currentTarget: { value: 'Edited in modal' } });
    tree = screen.render(); screen.fail(true);
    await tree.props.actions.find(a => a.text === '保存到云端').onClick();
    assert.equal(screen.closed(), 0); assert.equal(screen.local.length, 0);
    tree = screen.render(); assert(text(tree).includes('offline'));
    screen.fail(false); await tree.props.actions.find(a => a.text === '保存到云端').onClick();
    assert.deepEqual(screen.submitted[0], screen.submitted[1], 'UI retries keep the same edit timestamp and target');
    assert.equal(screen.submitted[1][0].content, 'Edited in modal');
    assert.equal(screen.submitted[1][0].updatedAt, qr.updatedAt);
    assert.deepEqual(screen.submitted[1][1], update);
    assert.equal(screen.closed(), 1); assert.equal(screen.local.length, 0);
    assert(screen.notices.some(n => n[0].includes('审核')));
    assert(!nodes(tree).some(n => n.type?.name === 'Button' && text(n) === '删除'), 'cloud editor never deletes local entry with same ID');
    const detail = canEditCloud => screen.detail({ entry: qr, readOnly: true, canEditCloud, onEdit() {} });
    assert(text(detail(true)).includes('编辑云端')); assert(!text(detail(false)).includes('编辑云端'));
    const logout = client(); await logout.api.loadContributionPanel(); logout.fail(true);
    await assert.rejects(logout.api.logoutAllContributions(), /connection lost/);
    assert.equal(logout.data.get('AnswerQuickReply_contribution_session_v1').token, token, 'global logout can be retried when revocation is unconfirmed');
    logout.fail(false); await logout.api.logoutAllContributions();
    const request = logout.calls.at(-1);
    assert(request.target.endsWith('/auth/logout-all'));
    assert.equal(request.options.headers.Authorization, 'Bearer ' + token);
    assert.equal(request.options.body, '{}');
    assert.equal(logout.api.getContributionState().user, null);
    assert.equal(logout.data.get('AnswerQuickReply_contribution_session_v1'), null);
    logout.api.stopContributions();
    console.log('PASS: cloud edit API + actual editor regression (auth capability, exact target, idempotent retries, source isolation, pending notice, local data untouched).');
})().catch(error => { console.error(error); process.exitCode = 1; });
