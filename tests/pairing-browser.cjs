// Usage: node tests/pairing-browser.cjs /path/to/Vencord python3 /path/to/chrome
// Runs the actual Python HTTP service and a real isolated browser. Every Discord request is intercepted and faked.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes, createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const puppeteer = createRequire(path.resolve(process.argv[2] || '.', 'package.json'))('puppeteer-core');
const BASE = 'https://qr-review.test/answer-qr';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aqr-browser-'));
const child = spawn(process.argv[3] || 'python3', ['-X', 'utf8', '-B', path.join(__dirname, '../answer-qr-server/tests/browser_fixture.py'), temp], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
let browser;
(async () => {
    const start = await new Promise((resolve, reject) => {
        let value = ''; const timeout = setTimeout(() => reject(Error('Fixture startup timeout')), 15000);
        child.stdout.on('data', chunk => { value += chunk; if (value.includes('\n')) { clearTimeout(timeout); try { resolve(JSON.parse(value.split('\n')[0])); } catch (error) { reject(error); } } });
        child.once('error', reject); child.once('exit', code => reject(Error('Fixture exited ' + code)));
    });
    const local = 'http://127.0.0.1:' + start.port;
    async function api(endpoint, body, proof) {
        return fetch(local + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(proof ? { Authorization: 'LoginVerifier ' + proof } : {}) }, body: JSON.stringify(body) });
    }
    async function attempt() {
        const proof = randomBytes(32).toString('base64url');
        const response = await api('/auth/auto/start', { challenge: createHash('sha256').update(proof).digest('hex'), userId: start.userId, pairing: 1 });
        assert.equal(response.status, 200); return { ...await response.json(), proof };
    }
    browser = await puppeteer.launch({ headless: true, args: process.getuid?.() === 0 ? ['--no-sandbox'] : [],
        ...(process.argv[4] ? { executablePath: process.argv[4] } : {}) });
    const page = await browser.newPage();
    const violations = [], unexpected = []; let discordVisits = 0;
    page.on('console', event => { if (/violates.*Content Security Policy|form-action/.test(event.text())) violations.push(event.text()); });
    await page.setRequestInterception(true);
    page.on('request', async request => {
        try {
            if (request.url().startsWith(BASE + '/')) {
                const headers = { ...request.headers() }; delete headers.host; delete headers['content-length']; delete headers.connection;
                const response = await fetch(local + request.url().slice(BASE.length), { method: request.method(), headers,
                    body: request.method() === 'POST' ? request.postData() : undefined, redirect: 'manual' });
                await request.respond({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
            } else if (request.url().startsWith('https://discord.com/oauth2/authorize?')) {
                discordVisits++;
                const state = new URL(request.url()).searchParams.get('state');
                await request.respond({ status: 200, contentType: 'text/html', body: '<a id="grant" href="' + BASE + '/auth/callback?code=member&amp;state=' + encodeURIComponent(state) + '">Fake Discord consent</a>' });
            } else if (request.url() === 'https://discord.com/favicon.ico') {
                await request.respond({ status: 204 });
            } else { unexpected.push(request.url()); await request.abort(); }
        } catch (error) { await request.abort().catch(() => {}); unexpected.push(error.message); }
    });
    const valid = await attempt();
    await page.goto(valid.loginUrl);
    assert.equal(await page.$eval('input[name=code]', input => input.value), '');
    assert(!await page.content().then(html => html.includes(valid.pairCode)), 'browser never receives the plugin pairing code in HTML');
    await page.type('input[name=code]', valid.pairCode);
    await Promise.all([page.waitForNavigation(), page.click('button')]);
    assert(await page.$('#oauth-continue'), 'Pairing response: ' + (await page.$eval('body', body => body.textContent)).slice(0, 400));
    await Promise.all([page.waitForNavigation(), page.click('#oauth-continue')]);
    assert.equal(discordVisits, 1);
    await Promise.all([page.waitForNavigation(), page.click('#grant')]);
    assert((await page.content()).includes('授权完成'), 'Callback response: ' + (await page.$eval('body', body => body.textContent)).slice(0, 400));
    const completed = await (await api('/auth/auto/poll', { id: valid.id }, valid.proof)).json();
    assert.equal(completed.status, 'complete'); assert.equal(completed.user.id, start.userId);
    const wrong = await attempt();
    await page.goto(wrong.loginUrl);
    await page.type('input[name=code]', wrong.pairCode === '0000' ? '0001' : '0000');
    await Promise.all([page.waitForNavigation(), page.click('button')]);
    assert.equal(discordVisits, 1, 'wrong pairing never reaches Discord');
    const failed = await (await api('/auth/auto/poll', { id: wrong.id }, wrong.proof)).json();
    assert.equal(failed.status, 'failed'); assert.equal(failed.token, undefined);
    assert.deepEqual(violations, []); assert.deepEqual(unexpected, []);
    console.log(JSON.stringify({ passed: true, browser: await browser.version(), actualServer: true, realCookiesAndCSP: true,
        cases: ['correct_pairing_oauth_callback_private_poll', 'wrong_code_once_prevents_oauth'], liveDiscordRequests: 0 }));
})().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(async () => {
    if (browser) await browser.close();
    if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    // Only the exact temporary fixture directory created above can be cleaned.
    if (path.dirname(path.resolve(temp)) !== path.resolve(os.tmpdir()) || !path.basename(temp).startsWith('aqr-browser-')) throw Error('Unsafe fixture cleanup target');
    fs.rmSync(temp, { recursive: true, force: true });
});
