import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = resolve(projectRoot, 'prisma/schema.prisma');
const sqlitePath = resolve(projectRoot, 'prisma/schema.dev.prisma');
const source = await readFile(sourcePath, 'utf8');
const sqlite = source
  .replace('output   = "../server/generated/postgres"', 'output   = "../server/generated/sqlite"')
  .replace('provider = "postgresql"', 'provider = "sqlite"');

if (sqlite === source) {
  throw new Error('Could not derive the SQLite schema from prisma/schema.prisma');
}

await writeFile(sqlitePath, sqlite, 'utf8');
console.log(`Generated ${sqlitePath}`);
