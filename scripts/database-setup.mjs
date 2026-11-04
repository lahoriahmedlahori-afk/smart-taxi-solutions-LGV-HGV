import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const prismaCli = resolve(root, 'node_modules/prisma/build/index.js');
const env = {
  ...process.env,
  DATABASE_PROVIDER: 'sqlite',
  DATABASE_URL: process.env.SQLITE_DATABASE_URL || 'file:./dev.db',
};

function run(args) {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

run([resolve(root, 'scripts/configure-prisma-provider.mjs'), 'sqlite']);
run([prismaCli, 'generate', '--schema', 'prisma/schema.dev.prisma']);
run([prismaCli, 'db', 'push', '--schema', 'prisma/schema.dev.prisma']);
