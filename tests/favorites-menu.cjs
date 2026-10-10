// Actual client modules; isolated storage, HTTP, Discord REST, hooks and menus.
// Usage: node tests/favorites-menu.cjs /path/to/Vencord-or-esbuild-dependencies
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { webcrypto } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const esbuild = createRequire(path.resolve(process.argv[2] || process.env.VENCORD_DIR || '.', 'package.json'))('esbuild');
const root = path.resolve(__dirname, '../answerQuickReply');
const BASE = 'https://api.starmint.cc.cd/answer-qr';
const URL_A = BASE + '/library.json';
const URL_B = 'https://qr.example.test/library.json';
const SESSION = 'AnswerQuickReply_contribution_session_v1';
const FAVORITES = 'AnswerQuickReply_remote_favorites_v1';
const USER_A = '123456789012345678', USER_B = '987654321098765432';
const qr = (id = 'collision', overrides = {}) => ({ id, title: 'Cloud QR', content: 'Original cloud reply', keywords: ['524'], weakKeywords: [], images: [], favorite: true, updatedAt: 42, ...overrides });
const question = () => ({ id: 'original-message', channel_id: 'original-channel', content: 'unrelated question', author: { id: 'asker', username: 'Original asker' }, attachments: [] });
const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === 'object' ? [tree, ...nodes(tree.props?.children)] : [];
const text = tree => Array.isArray(tree) ? tree.map(text).join('') : tree && typeof tree === 'object' ? text(tree.props?.children) : tree ?? '';
const element = (type, props, ...children) => ({ type, props: { ...props, children } });
const tick = async () => { for (let n = 0; n < 8; n++) await new Promise(done => setImmediate(done)); };
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
const codes = new Map();
function compiled(name) {
    if (!codes.has(name)) {
        const file = name + (['index', 'ui', 'icons'].includes(name) ? '.tsx' : '.ts');
        const extra = name === 'ui' ? '\nexport { Library, Row, Detail };' : '';
        codes.set(name, esbuild.transformSync(fs.readFileSync(path.join(root, file), 'utf8') + extra,
            { loader: file.endsWith('tsx') ? 'tsx' : 'ts', format: 'cjs', jsxFactory: '__jsx', jsxFragment: '__Fragment' }).code);
    }
    return codes.get(name);
}

function fixture({ duration = 3600000 } = {}) {
    let now = Date.now(), user = USER_A, libraryStatus = 200, libraryGate;
    let remoteRows = [qr()], selectedHooks, hookIndex = 0;
    const sessions = () => ({ token: 'test-' + user + '-session-xxxxxxxxxxxx',
        expiresAt: now + duration, user: { id: user, username: 'cloud-' + user },
        canReview: false, canAutoPublish: false, libraryAccess: 'ok' });
    const local = qr('collision', { title: 'Local QR', content: 'Local private reply', keywords: [], favorite: true, updatedAt: 5 });
    const data = new Map([[SESSION, sessions()], ['AnswerQuickReply_library_v1', { version: 1, entries: [local] }], ['AnswerQuickReply_builtin_cleanup_v1', true]]);
    const modules = new Map(), hookStores = new Map(), effects = [], http = [], rest = [], menus = [], modals = [], notices = [], timers = new Map(), writes = [], stateUpdates = [];
    let timerId = 0;
    const timer = (fn, ms) => { const id = ++timerId; timers.set(id, { fn, at: now + ms, ms }); return id; };
    const clear = id => { timers.delete(id); };
    function hooks(key, fn) { selectedHooks = hookStores.get(key) || []; hookStores.set(key, selectedHooks); hookIndex = 0; return fn(); }
    const common = {
        Menu: Object.fromEntries(['Menu', 'MenuGroup', 'MenuItem', 'MenuControlItem', 'MenuSearchControl', 'MenuSeparator'].map(name => [name, name])),
        Modal: 'Modal', ConfirmModal: 'ConfirmModal', Parser: {},
        useState(initial) { const values = selectedHooks, i = hookIndex++; if (!(i in values)) values[i] = typeof initial === 'function' ? initial() : initial;
            return [values[i], value => { values[i] = typeof value === 'function' ? value(values[i]) : value; stateUpdates.push(i); }]; },
        useRef(initial) { const values = selectedHooks, i = hookIndex++; return values[i] ??= { current: initial }; },
        useEffect(fn, dependencies = []) { const values = selectedHooks, i = hookIndex++, old = values[i];
            if (!old || dependencies.some((value, n) => value !== old.dependencies[n])) {
                const slot = { effect: true, dependencies }; values[i] = slot;
                effects.push(() => { old?.cleanup?.(); slot.cleanup = fn(); });
            } },
        useLayoutEffect() { hookIndex++; }, useMemo(fn) { hookIndex++; return fn(); }, useCallback(fn) { hookIndex++; return fn; },
        openModal(render) { modals.push(render); }, closeAllModals() {},
        ContextMenuApi: { openContextMenu(event, render) { menus.push(render()); }, closeContextMenu() {} },
        SelectedChannelStore: { getChannelId: () => 'newly-selected-channel' },
        MessageActions: {}, NavigationRouter: {},
        ChannelStore: { getChannel(id) { return { id, guild_id: 'guild', isThread: () => false }; } },
        PermissionsBits: { SEND_MESSAGES: 'send', SEND_MESSAGES_IN_THREADS: 'thread', ATTACH_FILES: 'attach', READ_MESSAGE_HISTORY: 'history' },
        PermissionStore: { can: () => true }, UserStore: { getCurrentUser: () => ({ id: user, premiumType: 0 }) },
        RestAPI: { async post(value) { rest.push(value); return { body: { id: 'sent-' + rest.length } }; } }
    };
    class UnusedUpload extends EventEmitter { constructor() { super(); throw Error('This text-only fixture must never upload'); } }
    async function fakeFetch(url, options) {
        http.push({ url, options });
        const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
        if (url === URL_A || url === URL_B) {
            const captured = remoteRows.map(item => structuredClone(item)), status = libraryStatus;
            if (libraryGate) await libraryGate.promise;
            return response(status === 200 ? { version: 1, entries: captured } : { error: status === 401 ? 'session_expired' : 'library_forbidden' }, status);
        }
        if (url === BASE + '/contributions/status') return response({ enabled: true, loginUrl: BASE + '/auth/login', automaticLogin: true, pairing: true, cloudEditing: true });
        if (url === BASE + '/contributions/me') { const { token, ...profile } = sessions(); return response(profile); }
        if (url === BASE + '/auth/logout' || url === BASE + '/auth/logout-all') return response({ revoked: 1 });
        if (url === BASE + '/contributions') return response({ id: '11111111-2222-4333-8444-555555555555', status: 'pending' });
        throw Error('Unexpected HTTP endpoint ' + url);
    }
    function load(name) {
        if (modules.has(name)) return modules.get(name).exports;
        const module = { exports: {} }; modules.set(name, module);
        vm.runInNewContext(compiled(name), {
            module, exports: module.exports, __jsx: element, __Fragment: 'Fragment', crypto: webcrypto,
            URL, Response, TextEncoder, TextDecoder, Uint8Array, AbortController, File, atob, btoa,
            Date: class extends Date { static now() { return now; } }, setTimeout: timer, clearTimeout: clear,
            fetch: fakeFetch, console: { error() {}, log() {}, warn() {} },
            document: { documentElement: { classList: { contains: () => true } }, getElementById: () => undefined },
            matchMedia: () => ({ matches: true }),
            require(id) {
                if (id === '@api/DataStore') return { get: async key => structuredClone(data.get(key)), set: async (key, value) => { data.set(key, structuredClone(value)); writes.push({ key, value: structuredClone(value) }); } };
                if (id === '@api/ContextMenu') return { openContextMenu(event, render) { menus.push(render()); }, closeContextMenu() {} };
                if (id === '@webpack/common') return common;
                if (id === '@utils/types') return value => value;
                if (id === '@webpack') return { findLazy: () => UnusedUpload };
                if (id === '@vencord/discord-types/enums') return { CloudUploadPlatform: { WEB: 1 } };
                if (id === './notify') return { showQrToast: (...args) => notices.push(args), startQrNotifications() {}, stopQrNotifications() {} };
                if (id === './settings') return { settings: { store: { mentionReply: false } } };
                if (id === './bridge') return { errorText: value => value.message, imageAttachments: value => value.attachments || [], stopImageTools() {}, clearRecognitionCache() {}, imageTools: () => ({ supported: false }) };
                if (id === './contributeUi') return { openContributions() {} };
                if (id === './styles.css') return {};
                if (id.startsWith('./')) return load(id.slice(2));
                throw Error('Unexpected dependency ' + id);
            }
        }, { filename: name });
        return module.exports;
    }
    const plugin = load('index').default, remote = load('remote'), favorites = load('favorites'), contribute = load('contribute'), store = load('store'), ui = load('ui');
    const renderMenu = (message = question(), key = 'menu') => hooks(key, () => { const children = []; plugin.contextMenus.message(children, { message }); return nodes(children); });
    const renderLibrary = (message = question(), key = 'library') => hooks(key, () => ui.Library({ modalProps: { onClose() {} }, message: load('target').snapshotReplyTarget(message), startOcr: false, initialSource: 'remote' }));
    return { plugin, remote, favorites, contribute, store, ui, data, http, rest, menus, modals, notices, writes, local,
        async warm() { await plugin.start(); await contribute.loadContributionPanel(); await favorites.loadRemoteFavorites(); await remote.ensureRemoteLibrary(); },
        async effects() { for (const effect of effects.splice(0)) effect(); await tick(); },
        renderMenu, renderLibrary, row: props => ui.Row(props), detail: props => ui.Detail(props),
        rows(value) { remoteRows = value; }, status(value) { libraryStatus = value; }, gate(value) { libraryGate = value; },
        advance(ms) { now += ms; },
        fireTimers() { for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); } },
        timers, stateUpdates,
        unmount(key) { const values = hookStores.get(key) || []; for (const value of values) if (value?.effect) value.cleanup?.(); hookStores.delete(key); },
        renderEditor(component) { return hooks('editor', () => component.type(component.props)); },
        async account(value) { remote.stopRemoteLibrary(); contribute.stopContributions(); user = value; data.set(SESSION, sessions()); remote.startRemoteLibrary(); contribute.startContributions(); await contribute.loadContributionPanel(); await remote.ensureRemoteLibrary(); },
        close() { for (const values of hookStores.values()) for (const value of values) if (value?.effect) value.cleanup?.(); plugin.stop(); timers.clear(); }
    };
}

test('personal cloud favorites override server stars without editing source or local collision', async () => {
    const f = fixture(); try {
        await f.warm(); const raw = f.remote.getRemoteState().entries[0], before = JSON.stringify(raw), local = f.store.exportLibrary();
        assert.equal(f.remote.getPersonalRemoteEntries()[0].favorite, false, 'server star is not a personal favorite');
        const scope = f.remote.getRemoteFavoriteScope(); await f.remote.saveRemoteFavorite(scope, raw.id, true);
        assert.equal(f.remote.getPersonalRemoteEntries()[0].favorite, true);
        assert.equal(JSON.stringify(raw), before); assert.equal(raw.updatedAt, 42); assert(Object.isFrozen(raw));
        assert.equal(f.store.exportLibrary(), local);
        const favoriteWrites = f.writes.filter(value => value.key === FAVORITES);
        assert.equal(favoriteWrites.length, 1); assert.deepEqual(Object.keys(favoriteWrites[0].value.entries[0]).sort(), ['entryId', 'libraryUrl', 'userId']);
        assert(f.http.filter(value => value.url === URL_A).every(value => value.options.headers.Authorization.startsWith('Bearer test-')));
        assert(!f.http.some(value => value.options.method === 'POST'), 'bookmarking does not upload or submit');
    } finally { f.close(); }
});

test('cloud update preserves bookmark ID and resolves newest body; deletion rejects old reference', async () => {
    const f = fixture(); try {
        await f.warm(); const scope = f.remote.getRemoteFavoriteScope(); await f.remote.saveRemoteFavorite(scope, 'collision', true);
        f.rows([qr('collision', { title: 'Renamed QR', content: 'Replacement body', updatedAt: 43, favorite: false })]);
        await f.remote.refreshRemoteLibrary();
        const latest = await f.remote.resolveRemoteEntry(scope, 'collision');
        assert.equal(latest.favorite, true); assert.equal(latest.content, 'Replacement body'); assert.equal(latest.updatedAt, 43);
        f.rows([]); await f.remote.refreshRemoteLibrary();
        assert.equal(f.remote.getPersonalRemoteEntries().length, 0);
        await assert.rejects(f.remote.resolveRemoteEntry(scope, 'collision'), /不可用/);
        await assert.rejects(f.remote.saveRemoteFavorite(scope, 'collision', false), /改变/);
    } finally { f.close(); }
});

test('logout clears real remote cache and old cloud menu action cannot send', async () => {
    const f = fixture(); try {
        await f.warm(); await f.remote.saveRemoteFavorite(f.remote.getRemoteFavoriteScope(), 'collision', true);
        f.plugin.flux.CONTEXT_MENU_OPEN(); const opened = f.renderMenu();
        const action = opened.find(node => node.props?.id?.endsWith('-cloud-fav-collision')).props.action;
        await f.contribute.logoutContributions();
        assert.equal(f.remote.getRemoteState().entries.length, 0); assert.equal(f.remote.getPersonalRemoteEntries().length, 0);
        action(); await tick(); assert.equal(f.rest.length, 0);
        assert(!f.renderMenu().some(node => node.props?.id?.endsWith('-cloud-fav-collision')));
        assert(f.store.getEntries()[0].favorite, 'local favorite remains usable');
    } finally { f.close(); }
});

test('expired session refuses an already-open cloud action, including cached entries', async () => {
    const f = fixture(); try {
        await f.warm(); await f.remote.saveRemoteFavorite(f.remote.getRemoteFavoriteScope(), 'collision', true);
        f.plugin.flux.CONTEXT_MENU_OPEN(); const opened = f.renderMenu();
        const action = opened.find(node => node.props?.id?.endsWith('-cloud-fav-collision')).props.action;
        f.advance(3600001); action(); await tick();
        assert.equal(f.rest.length, 0); assert.equal(f.remote.getPersonalRemoteEntries().length, 0);
        assert(!f.renderMenu().some(node => node.props?.id?.endsWith('-cloud-fav-collision')));
    } finally { f.close(); }
});

for (const status of [401, 403]) test('HTTP ' + status + ' clears cloud visibility and prevents stale menu sends', async () => {
    const f = fixture(); try {
        await f.warm(); await f.remote.saveRemoteFavorite(f.remote.getRemoteFavoriteScope(), 'collision', true);
        const action = f.renderMenu().find(node => node.props?.id?.endsWith('-cloud-fav-collision')).props.action;
        f.status(status); await assert.rejects(f.remote.refreshRemoteLibrary());
        action(); await tick(); assert.equal(f.rest.length, 0); assert.equal(f.remote.getPersonalRemoteEntries().length, 0);
        if (status === 401) assert.equal(f.contribute.getContributionState().user, null);
    } finally { f.close(); }
});

test('authenticated account switch isolates saved IDs and invalidates old action scope', async () => {
    const f = fixture(); try {
        await f.warm(); const scopeA = f.remote.getRemoteFavoriteScope(); await f.remote.saveRemoteFavorite(scopeA, 'collision', true);
        const actionA = f.renderMenu().find(node => node.props?.id?.endsWith('-cloud-fav-collision')).props.action;
        await f.account(USER_B);
        assert.equal(f.remote.getRemoteFavoriteScope().userId, USER_B); assert.equal(f.remote.getPersonalRemoteEntries()[0].favorite, false);
        actionA(); await tick(); assert.equal(f.rest.length, 0);
        await assert.rejects(f.remote.saveRemoteFavorite(scopeA, 'collision', false), /改变/);
        await f.account(USER_A); assert.equal(f.remote.getPersonalRemoteEntries()[0].favorite, true);
    } finally { f.close(); }
});

test('library URL switch isolates custom bookmarks and old community action', async () => {
    const f = fixture(); try {
        await f.warm(); const community = f.remote.getRemoteFavoriteScope(); await f.remote.saveRemoteFavorite(community, 'collision', true);
        await f.remote.saveRemoteConfig({ url: URL_B, accessKey: 'custom-read-key' }); await f.remote.ensureRemoteLibrary();
        const custom = f.remote.getRemoteFavoriteScope(); assert.equal(custom.userId, 'custom');
        assert.equal(f.remote.getPersonalRemoteEntries()[0].favorite, false);
        await assert.rejects(f.remote.resolveRemoteEntry(community, 'collision'), /改变/);
        await f.remote.saveRemoteFavorite(custom, 'collision', true);
        assert.equal(f.remote.getPersonalRemoteEntries()[0].favorite, true);
        await f.remote.saveRemoteConfig({ url: URL_A, accessKey: '' }); await f.remote.ensureRemoteLibrary();
        assert.equal(f.remote.getPersonalRemoteEntries()[0].favorite, true);
    } finally { f.close(); }
});

test('late cloud response after logout cannot recreate cached QR or menu favorites', async () => {
    const f = fixture(); try {
        await f.warm(); const gate = deferred(); f.gate(gate);
        const read = f.remote.refreshRemoteLibrary(); const rejected = assert.rejects(read, /取消/);
        await tick(); await f.contribute.logoutContributions(); gate.resolve(); await rejected; await tick();
        assert.equal(f.remote.getRemoteState().entries.length, 0); assert.equal(f.remote.getPersonalRemoteEntries().length, 0);
        assert.equal(f.rest.length, 0);
    } finally { f.close(); }
});

test('cloud and local same-ID actions remain distinct and original reply target survives movement', async () => {
    const f = fixture(); try {
        await f.warm(); await f.remote.saveRemoteFavorite(f.remote.getRemoteFavoriteScope(), 'collision', true);
        const original = question(); f.plugin.flux.CONTEXT_MENU_OPEN(); let menu = f.renderMenu(original);
        const local = menu.find(node => node.props?.id?.endsWith('-fav-collision') && !node.props.id.endsWith('-cloud-fav-collision'));
        const cloud = menu.find(node => node.props?.id?.endsWith('-cloud-fav-collision'));
        assert(local && cloud); assert.notEqual(local.props.id, cloud.props.id); assert.notEqual(local.props.key, cloud.props.key);
        original.id = 'moved-message'; original.channel_id = 'moved-channel'; original.author.id = 'other-asker';
        f.renderMenu(original); f.plugin.flux.CONTEXT_MENU_CLOSE(); cloud.props.action(); await tick();
        assert.equal(f.rest.length, 1); assert.equal(f.rest[0].body.content, 'Original cloud reply');
        assert.equal(f.rest[0].body.message_reference.message_id, 'original-message');
        assert.equal(f.rest[0].body.message_reference.channel_id, 'original-channel');
        assert.equal(f.rest[0].body.allowed_mentions.replied_user, false);
    } finally { f.close(); }
});

test('Row right-click exposes only favorite and cannot select, delete or send', async () => {
    const f = fixture(); try {
        await f.warm(); let selected = 0, deleted = 0, toggled = 0, prevented = 0, stopped = 0;
        for (const favorite of [false, true]) {
            const row = f.row({ entry: qr('row', { favorite }), index: 0, selected: false, leaving: false, disabled: false,
                onSelect() { selected++; }, onDelete() { deleted++; }, onFavorite() { toggled++; } });
            row.props.onContextMenu({ preventDefault() { prevented++; }, stopPropagation() { stopped++; } });
            const commands = nodes(f.menus.at(-1)).filter(node => node.type === 'MenuItem');
            assert.equal(commands.length, 1); assert.equal(commands[0].props.label, favorite ? '取消收藏' : '收藏');
            assert.equal(selected, 0); assert.equal(deleted, 0); assert.equal(f.rest.length, 0);
            commands[0].props.action();
        }
        assert.equal(toggled, 2); assert.equal(prevented, 2); assert.equal(stopped, 2);
        for (const changed of [{ disabled: true }, { leaving: true }]) {
            const before = f.menus.length;
            f.row({ entry: qr(), index: 0, selected: false, leaving: false, disabled: false, onFavorite() {}, ...changed })
                .props.onContextMenu({ preventDefault() {}, stopPropagation() {} });
            assert.equal(f.menus.length, before);
        }
    } finally { f.close(); }
});

test('actual Library labels cloud favorites as 收藏 and native row toggle updates only cloud references', async () => {
    const f = fixture(); try {
        await f.warm(); let tree = f.renderLibrary(); await f.effects(); tree = f.renderLibrary();
        const tabs = nodes(tree).find(node => node.type?.name === 'Segmented' && node.props.options.some(option => option.value === 'fav'));
        assert.equal(tabs.props.options.find(option => option.value === 'fav').label, '收藏');
        assert(!text(tree).includes('库中标星'));
        const rowComponent = nodes(tree).find(node => node.type?.name === 'Row');
        const before = f.store.exportLibrary(), version = f.remote.getRemoteState().entries[0].updatedAt;
        f.row(rowComponent.props).props.onContextMenu({ preventDefault() {}, stopPropagation() {} });
        nodes(f.menus.at(-1)).find(node => node.type === 'MenuItem').props.action(); await tick();
        assert.equal(f.remote.getPersonalRemoteEntries()[0].favorite, true);
        assert.equal(f.store.exportLibrary(), before); assert.equal(f.remote.getRemoteState().entries[0].updatedAt, version);
        assert.equal(f.rest.length, 0);
        const detail = nodes(f.renderLibrary()).find(node => node.type?.name === 'Detail');
        assert(nodes(f.detail(detail.props)).some(node => node.props?.['aria-label'] === '取消收藏'));
    } finally { f.close(); }
});

test('actual Library local row toggle changes only its local favorite despite same cloud ID', async () => {
    const f = fixture(); try {
        await f.warm(); let tree = f.renderLibrary(); await f.effects(); tree = f.renderLibrary();
        const sources = nodes(tree).find(node => node.type?.name === 'Segmented' && node.props.options.some(option => option.value === 'remote'));
        sources.props.onChange('local'); tree = f.renderLibrary();
        const row = nodes(tree).find(node => node.type?.name === 'Row');
        const raw = JSON.stringify(f.remote.getRemoteState().entries[0]);
        f.row(row.props).props.onContextMenu({ preventDefault() {}, stopPropagation() {} });
        nodes(f.menus.at(-1)).find(node => node.type === 'MenuItem').props.action(); await tick();
        assert.equal(f.store.getEntries()[0].favorite, false);
        assert.equal(JSON.stringify(f.remote.getRemoteState().entries[0]), raw);
        assert.equal(f.data.get(FAVORITES), undefined); assert.equal(f.rest.length, 0);
    } finally { f.close(); }
});

test('stale local row favorite preserves edits and cannot resurrect a deleted entry', async () => {
    const f = fixture(); try {
        await f.warm(); let tree = f.renderLibrary(); await f.effects(); tree = f.renderLibrary();
        const sources = nodes(tree).find(node => node.type?.name === 'Segmented' && node.props.options.some(option => option.value === 'remote'));
        sources.props.onChange('local'); tree = f.renderLibrary();
        const oldRow = nodes(tree).find(node => node.type?.name === 'Row');
        await f.store.saveEntry({ ...f.store.getEntries()[0], title: 'Newly edited title', content: 'Newly edited body', keywords: ['changed'], updatedAt: 55 });
        oldRow.props.onFavorite(); await tick();
        assert.equal(f.store.getEntries()[0].favorite, false);
        assert.equal(f.store.getEntries()[0].content, 'Newly edited body');
        assert.equal(f.store.getEntries()[0].title, 'Newly edited title');
        assert.deepEqual(Array.from(f.store.getEntries()[0].keywords), ['changed']);
        await f.store.deleteEntry('collision'); oldRow.props.onFavorite(); await tick();
        assert.equal(f.store.getEntries().length, 0, 'old favorite callback cannot restore deleted QR');
        assert.equal(f.rest.length, 0);
    } finally { f.close(); }
});

test('cloud row menu captured before logout rejects its favorite action', async () => {
    const f = fixture(); try {
        await f.warm(); let tree = f.renderLibrary(); await f.effects(); tree = f.renderLibrary();
        const row = nodes(tree).find(node => node.type?.name === 'Row');
        f.row(row.props).props.onContextMenu({ preventDefault() {}, stopPropagation() {} });
        const favoriteAction = nodes(f.menus.at(-1)).find(node => node.type === 'MenuItem').props.action;
        await f.contribute.logoutContributions(); favoriteAction(); await tick();
        assert.equal(f.data.get(FAVORITES), undefined); assert.equal(f.rest.length, 0);
        assert.equal(f.remote.getPersonalRemoteEntries().length, 0);
    } finally { f.close(); }
});

test('personal cloud favorite never contaminates the raw server favorite in a submitted edit', async () => {
    const f = fixture(); try {
        f.rows([qr('collision', { favorite: false })]); await f.warm();
        await f.remote.saveRemoteFavorite(f.remote.getRemoteFavoriteScope(), 'collision', true);
        let tree = f.renderLibrary(); await f.effects(); tree = f.renderLibrary();
        const detail = nodes(tree).find(node => node.type?.name === 'Detail');
        assert.equal(detail.props.entry.favorite, true);
        detail.props.onEdit(); await tick();
        assert.equal(f.modals.length, 1);
        const editor = f.modals[0]({ onClose() {} });
        assert.equal(editor.props.entry.favorite, false, 'editor restores the raw shared star');
        const view = f.renderEditor(editor);
        await view.props.actions.find(action => action.text === '保存到云端').onClick();
        const submitted = f.http.find(value => value.url === BASE + '/contributions');
        assert(submitted, 'real contribution API submits the actual editor snapshot');
        const payload = JSON.parse(submitted.options.body);
        assert.equal(payload.entry.favorite, false); assert.equal(payload.entry.updatedAt, 42);
        assert.equal(payload.update.targetId, 'collision'); assert.equal(payload.update.baseUpdatedAt, 42);
        assert.equal(f.remote.getPersonalRemoteEntries()[0].favorite, true);
        assert.equal(f.remote.getRemoteState().entries[0].favorite, false);
    } finally { f.close(); }
});

test('idle expiry schedules view changes without polling and hides both menu and panel cloud content', async () => {
    const f = fixture(); try {
        await f.warm(); await f.remote.saveRemoteFavorite(f.remote.getRemoteFavoriteScope(), 'collision', true);
        f.renderMenu(); f.renderLibrary(); await f.effects();
        const calls = f.http.length, changes = f.stateUpdates.length;
        assert.equal([...f.timers.values()].filter(timer => timer.ms === 3600000).length, 2);
        f.advance(3600001); f.fireTimers(); await tick();
        assert(f.stateUpdates.length >= changes + 2, 'both actual timer callbacks request a rerender');
        assert(!f.renderMenu().some(node => node.props?.id?.endsWith('-cloud-fav-collision')));
        assert(!nodes(f.renderLibrary()).some(node => node.type?.name === 'Row'));
        assert.equal(f.http.length, calls, 'expiry does not initiate network polling');
    } finally { f.close(); }
});

test('expiry timer cleanup on unmount and long-delay chunking remain bounded', async () => {
    const f = fixture({ duration: 3000000000 }); try {
        await f.warm(); f.renderMenu(); f.renderLibrary(); await f.effects();
        assert.equal([...f.timers.values()].filter(timer => timer.ms === 2147483647).length, 2);
        f.unmount('library');
        assert.equal([...f.timers.values()].filter(timer => timer.ms === 2147483647).length, 1);
        const calls = f.http.length, changes = f.stateUpdates.length;
        f.advance(2147483648); f.fireTimers();
        assert.equal(f.stateUpdates.length, changes, 'early timer chunk cannot expire a valid session');
        assert.equal(f.timers.size, 1); assert([...f.timers.values()].every(timer => timer.ms <= 2147483647));
        f.advance(852516353); f.fireTimers();
        assert.equal(f.stateUpdates.length, changes + 1); assert.equal(f.remote.getRemoteFavoriteScope(), undefined);
        f.unmount('menu'); assert.equal(f.timers.size, 0); assert.equal(f.http.length, calls);
    } finally { f.close(); }
});
