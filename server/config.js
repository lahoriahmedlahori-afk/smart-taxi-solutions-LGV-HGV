import 'dotenv/config';

const isProduction = process.env.NODE_ENV === 'production';
const databaseProvider = process.env.DATABASE_PROVIDER || (isProduction ? 'postgresql' : 'sqlite');

if (!['postgresql', 'sqlite'].includes(databaseProvider)) {
  throw new Error('DATABASE_PROVIDER must be postgresql or sqlite');
}
if (isProduction && databaseProvider !== 'postgresql') {
  throw new Error('Production deployments must use PostgreSQL');
}
if (isProduction && !process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required in production');
}

export const config = Object.freeze({
  nodeEnv: process.env.NODE_ENV || 'development',
  isProduction,
  port: Number(process.env.PORT || 3001),
  appOrigin: process.env.APP_ORIGIN || 'http://localhost:4173',
  databaseProvider,
  databaseUrl: process.env.DATABASE_URL || 'file:./dev.db',
  cookieName: process.env.SESSION_COOKIE_NAME || 'sts_session',
  sessionTtlMs: Number(process.env.SESSION_TTL_HOURS || 8) * 60 * 60 * 1000,
  loginMaxAttempts: Number(process.env.LOGIN_MAX_ATTEMPTS || 5),
  loginLockMs: Number(process.env.LOGIN_LOCK_MINUTES || 15) * 60 * 1000,
  ai: Object.freeze({
    enabled: process.env.AI_ENABLED !== 'false',
    provider: process.env.AI_PROVIDER || 'ollama',
    apiKey: process.env.AI_API_KEY || '',
    baseUrl: process.env.AI_BASE_URL || '',
    model: process.env.AI_MODEL || 'llama3.2:3b',
    ollamaBaseUrl: process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434',
  }),
  appEncryptionKey: process.env.APP_ENCRYPTION_KEY || '',
});
