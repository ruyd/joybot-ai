// Runs the API and the worker side by side in one container (deploy/render/Dockerfile). Signals go to
// both; when either exits, the other is stopped and the container exits with that code, so the host
// restarts it. The API listens on PORT (Render sets it).
import { spawn } from 'node:child_process';

const apps = [
  { name: 'api', cwd: '/app/api' },
  { name: 'worker', cwd: '/app/worker' },
];

let exiting = false;
let exitCode = 0;
const children = apps.map(({ name, cwd }) => {
  const child = spawn(process.execPath, ['dist/main.js'], { cwd, stdio: 'inherit', env: process.env });
  child.on('exit', (code, signal) => {
    if (exiting) return;
    exiting = true;
    exitCode = code || 1;
    console.error(JSON.stringify({ event: 'process_exited', name, code, signal }));
    for (const other of children) if (other !== child) other.kill('SIGTERM');
    setTimeout(() => process.exit(exitCode), 10_000).unref();
  });
  return child;
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    exiting = true;
    for (const child of children) child.kill(signal);
  });
}

let left = children.length;
for (const child of children) child.on('exit', () => --left === 0 && process.exit(exitCode));
