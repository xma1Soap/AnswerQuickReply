// Real TSX comparison/login panel with isolated Discord hooks, plus the real bounded line-diff module.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const esbuild = createRequire(path.resolve(process.argv[2] || '.', 'package.json'))('esbuild');
const root = path.join(__dirname, '../answerQuickReply');
const diffModule = { exports: {} };
vm.runInNewContext(esbuild.transformSync(fs.readFileSync(path.join(root, 'reviewDiff.ts'), 'utf8'), { loader: 'ts', format: 'cjs' }).code,
    { module: diffModule, exports: diffModule.exports, Uint16Array });
const diffLines = diffModule.exports.diffLines;
const clone = value => JSON.parse(JSON.stringify(value));
const qr = { id: 'shared_1', title: 'Old title', content: 'same\nold\nend', keywords: ['524'], weakKeywords: ['cf'], images: [], sourceUrl: 'https://example.com/old', updatedAt: 1 };
const proposed = { ...qr, title: 'New title', content: 'same\nnew\nend', keywords: ['502'], weakKeywords: [], images: [{ id: 'img', dataUrl: 'data:image/png;base64,eA==', name: 'image.png' }], sourceUrl: 'https://example.com/new' };
const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === 'object' ? [tree, ...nodes(tree.props?.children)] : [];
const text = tree => Array.isArray(tree) ? tree.map(text).join('') : tree && typeof tree === 'object' ? text(tree.props?.children) : tree ?? '';
const jsx = (type, props, ...children) => typeof type === 'function' ? type({ ...props, children }) : ({ type, props: { ...props, children } });
function screen(service, detail) {
    let index = 0, globalLogouts = 0;
    const states = [], m = { exports: {} };
    if (detail) states[7] = detail;
    vm.runInNewContext(esbuild.transformSync(fs.readFileSync(path.join(root, 'contributeUi.tsx'), 'utf8') + '\nexport { ContributionPanel, ContributionComparison };',
        { loader: 'tsx', format: 'cjs', jsxFactory: '__jsx', jsxFragment: '__Fragment' }).code, {
        module: m, exports: m.exports, __jsx: jsx, __Fragment: 'Fragment', Date,
        require(name) {
            if (name === './reviewDiff') return { diffLines };
            if (name === './model') return {};
            if (name === '@webpack/common') return { Modal: 'Modal', UserStore: { getCurrentUser: () => ({ id: '123456789012345678' }) }, useEffect() {},
                useState(initial) { const i = index++; if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial;
                    return [states[i], value => { states[i] = typeof value === 'function' ? value(states[i]) : value; }]; },
                useRef(value) { const i = index++; return states[i] ??= { current: value }; } };
            if (name === './contribute') return { getContributionState: () => service, logoutAllContributions: async () => { globalLogouts++; }, snapshotContribution: clone };
            throw Error(name);
        }
    });
    return { render() { index = 0; return m.exports.ContributionPanel({ modalProps: { onClose() {} } }); },
        comparison: m.exports.ContributionComparison, logouts: () => globalLogouts };
}
(async () => {
    assert.deepEqual(clone(diffLines(qr.content, proposed.content)), [
        { kind: 'same', text: 'same' }, { kind: 'removed', text: 'old' }, { kind: 'added', text: 'new' }, { kind: 'same', text: 'end' }
    ]);
    for (const [before, after] of [['', 'added'], ['removed', ''], ['a\nb\na', 'b\na\nb'], ['x\n'.repeat(600), 'y\n'.repeat(600)]]) {
        const diff = diffLines(before, after);
        assert.equal(diff.filter(line => line.kind !== 'added').map(line => line.text).join('\n'), before);
        assert.equal(diff.filter(line => line.kind !== 'removed').map(line => line.text).join('\n'), after);
    }
    const service = { ready: true, enabled: true, automaticLogin: true, autoLoginUrl: 'https://example.com/login', loginUrl: 'https://example.com/manual', pairCode: '0042', user: null };
    const login = screen(service); const tree = login.render();
    assert(text(tree).includes('0042')); assert(text(tree).includes('配对码'));
    assert(text(tree).includes('请勿打开别人发来的登录链接'));
    assert(!nodes(tree).some(n => n.type === 'a' && n.props.href.includes('0042')));
    const detail = { id: 'test', status: 'pending', update: { targetId: qr.id, baseUpdatedAt: 1 }, entry: proposed, current: qr };
    const review = screen({ ...service, user: { username: 'reviewer' }, canReview: true }, detail);
    const view = review.render();
    assert(text(view).includes('修改前后对比')); assert(text(view).includes('当前云端'));
    for (const value of [qr.title, proposed.title, qr.sourceUrl, proposed.sourceUrl, '图片数量']) assert(text(view).includes(value));
    assert(nodes(view).some(n => n.props?.className === 'aqr-diff-line is-removed' && text(n).includes('old')));
    assert(nodes(view).some(n => n.props?.className === 'aqr-diff-line is-added' && text(n).includes('new')));
    const author = screen({ ...service, user: { username: 'author' }, canReview: false }, detail);
    assert(!text(author.render()).includes('修改前后对比'));
    assert(text(review.comparison({ current: null, entry: proposed })).includes('已不存在'));
    assert(text(review.comparison({ current: { ...qr, content: '<script>alert(1)</script>' }, entry: proposed })).includes('<script>'));
    assert(!nodes(review.comparison({ current: qr, entry: proposed })).some(n => n.props?.dangerouslySetInnerHTML));
    await nodes(view).find(n => n.type === 'button' && text(n) === '退出所有设备').props.onClick();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(review.logouts(), 1); assert(text(review.render()).includes('其他设备需要重新登录'));
    console.log('PASS: pairing panel, global logout button, reviewer-only field/line comparison, HTML text escaping and bounded diff reconstruction.');
})().catch(error => { console.error(error); process.exitCode = 1; });
