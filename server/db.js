import { config } from './config.js';

const generatedClient = config.databaseProvider === 'postgresql'
  ? await import('./generated/postgres/index.js')
  : await import('./generated/sqlite/index.js');

export const prisma = new generatedClient.PrismaClient({
  datasources: { db: { url: config.databaseUrl } },
  log: config.isProduction ? ['error'] : ['warn', 'error'],
});
