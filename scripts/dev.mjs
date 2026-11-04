import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const processes = [
  spawn(process.execPath, ['--watch', 'server/index.js'], { cwd: root, stdio: 'inherit', env: process.env }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js'], { cwd: root, stdio: 'inherit', env: process.env }),
];
let stopping = false;

function stop(signal = 'SIGTERM') {
  if (stopping) return;
  stopping = true;
  for (const child of processes) if (!child.killed) child.kill(signal);
}

for (const child of processes) {
  child.once('error', error => {
    console.error('Development process could not start', error.name);
    stop();
    process.exitCode = 1;
  });
  child.once('exit', code => {
    if (!stopping) {
      process.exitCode = code || 0;
      stop();
    }
  });
}

process.once('SIGINT', () => stop('SIGINT'));
process.once('SIGTERM', () => stop('SIGTERM'));
