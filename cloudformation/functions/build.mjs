// Bundles each Lambda into dist/<name>.zip (Node.js 22, CommonJS). db-bootstrap also ships the
// SQL migrations. Run: pnpm --filter @joybot/functions build
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, 'dist');
const functions = ['db-bootstrap', 'customer-post-confirmation', 'employee-post-authentication', 'whatsapp-sender', 'web-assets'];

rmSync(dist, { recursive: true, force: true });
for (const name of functions) {
  const out = path.join(dist, name);
  mkdirSync(out, { recursive: true });
  await build({
    entryPoints: [path.join(root, 'src', name, 'index.ts')],
    outfile: path.join(out, 'index.js'),
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    sourcemap: 'inline',
    minify: false,
    // pg's optional native binding is never used.
    external: ['pg-native'],
    logLevel: 'warning',
  });
  if (name === 'db-bootstrap') {
    cpSync(path.join(root, '../../packages/db/migrations'), path.join(out, 'migrations'), { recursive: true });
  }
  execFileSync('zip', ['-qr', path.join(dist, `${name}.zip`), '.'], { cwd: out });
  console.log(`built dist/${name}.zip`);
}
