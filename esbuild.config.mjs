import * as esbuild from 'esbuild';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf8'));

function pad2(n) {
    return String(n).padStart(2, '0');
}

const d = new Date();
const buildTime = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
const versionLine = `// bbk - v${pkg.version} - ${buildTime}`;

await esbuild.build({
    entryPoints: [join(__dirname, 'src/bbk.ts')],
    outfile: join(__dirname, 'bin/bbk.js'),
    bundle: true,
    platform: 'node',
    target: 'node16',
    format: 'cjs',
    minify: false,
    legalComments: 'none',
    banner: { js: `#!/usr/bin/env node\n${versionLine}` },
    external: ['bufferutil', 'utf-8-validate', 'debug'],
});

// 确保产物可执行
import { chmodSync } from 'fs';
chmodSync(join(__dirname, 'bin/bbk.js'), 0o755);

console.log(`Build complete: bin/bbk.js (v${pkg.version} - ${buildTime})`);
