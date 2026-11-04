import app from './app.js';
import { config } from './config.js';
import { prisma } from './db.js';
import { seedRoles } from './services/roles.js';

let server;

try {
  await prisma.$connect();
  await seedRoles();
  server = app.listen(config.port, '0.0.0.0', () => {
    console.info(`Smart Taxi Solutions API listening on port ${config.port} (${config.nodeEnv})`);
  });
} catch (error) {
  console.error('Application startup failed', error?.name || 'Error');
  await prisma.$disconnect();
  process.exitCode = 1;
}

async function shutdown(signal) {
  console.info(`Received ${signal}; shutting down.`);
  if (server) await new Promise(resolve => server.close(resolve));
  await prisma.$disconnect();
  process.exit(0);
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
