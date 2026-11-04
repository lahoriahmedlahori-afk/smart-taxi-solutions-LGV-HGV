import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { attachUser } from './middleware/auth.js';
import { errorHandler, notFound } from './middleware/errors.js';
import { sameOriginForMutations } from './middleware/origin.js';
import authRoutes from './routes/auth.js';
import bookingRoutes from './routes/bookings.js';
import customerRoutes from './routes/customers.js';
import consultationRoutes from './routes/consultations.js';
import followUpRoutes from './routes/followups.js';
import knowledgeRoutes from './routes/knowledge.js';
import leadRoutes from './routes/leads.js';
import migrationRoutes from './routes/migration.js';
import providerRoutes from './routes/providers.js';
import pricingRoutes from './routes/pricing.js';
import quoteRoutes from './routes/quotes.js';
import settingsRoutes from './routes/settings.js';
import userRoutes from './routes/users.js';
import auditRoutes from './routes/audit.js';
import aiRoutes from './routes/ai.js';
import { prisma } from './db.js';

const app = express();
const api = express.Router();
const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

app.disable('x-powered-by');
if (config.isProduction && process.env.TRUST_PROXY === 'true') app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"],
    },
  },
}));
app.use(cors({ origin: config.appOrigin, credentials: true, methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'], allowedHeaders: ['Content-Type', 'X-Request-Id'] }));
app.use(express.json({ limit: '128kb', strict: true }));
app.use(cookieParser());
app.use(sameOriginForMutations);
app.use('/api', attachUser);

api.get('/health', async (_req, res, next) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return res.json({ status: 'ok', database: 'connected', environment: config.nodeEnv });
  } catch (error) { return next(error); }
});
api.use('/auth', authRoutes);
api.use('/customers', customerRoutes);
api.use('/leads', leadRoutes);
api.use('/migration', migrationRoutes);
api.use('/consultations', consultationRoutes);
api.use('/quotes', quoteRoutes);
api.use('/follow-ups', followUpRoutes);
api.use('/providers', providerRoutes);
api.use('/pricing', pricingRoutes);
api.use('/bookings', bookingRoutes);
api.use('/knowledge', knowledgeRoutes);
api.use('/ai', aiRoutes);
api.use('/settings', settingsRoutes);
api.use('/users', userRoutes);
api.use('/audit', auditRoutes);
app.use('/api/v1', api);
app.use('/api', (_req, res) => res.status(404).json({ error: { code: 'API_ROUTE_NOT_FOUND', message: 'API route not found.' } }));

if (config.isProduction) {
  const distPath = resolve(projectRoot, 'dist');
  if (existsSync(distPath)) {
    app.use(express.static(distPath, { index: false, maxAge: '1h' }));
    app.get('/{*path}', (_req, res, next) => {
      if (!existsSync(resolve(distPath, 'index.html'))) return next();
      return res.sendFile(resolve(distPath, 'index.html'));
    });
  }
}

app.use(notFound);
app.use(errorHandler);

export default app;
