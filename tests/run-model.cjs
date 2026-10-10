// Usage: node tests/run-model.cjs /path/to/Vencord-or-esbuild-dependencies
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');
const esbuild = createRequire(path.resolve(process.argv[2] || '.', 'package.json'))('esbuild');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aqr-model-test-'));
try {
    const output = path.join(temp, 'model.cjs');
    esbuild.buildSync({ entryPoints: [path.join(__dirname, '../answerQuickReply/model.test.ts')], outfile: output,
        bundle: true, platform: 'node', format: 'cjs', target: 'node18', logLevel: 'error' });
    const result = spawnSync(process.execPath, ['--test', output], { stdio: 'inherit' });
    process.exitCode = result.status ?? 1;
} finally {
    if (path.dirname(path.resolve(temp)) !== path.resolve(os.tmpdir()) || !path.basename(temp).startsWith('aqr-model-test-')) throw Error('Unsafe model-test cleanup target');
    fs.rmSync(temp, { recursive: true, force: true });
}
