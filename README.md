# Smart Taxi Solutions Adviser

An internal UK LGV/HGV consultation and CRM application. The original Vite consultation UI is retained and now uses a versioned Express API with Prisma persistence.

## Local Development

Requirements: Node.js 20.19+ (or 22.12+) and npm. From this project directory:

```powershell
npm install
npm run db:dev
```

Create the first administrator. Supply the password through your local shell environment; do not put real credentials in source control or chat:

```powershell
$env:ADMIN_EMAIL = 'admin@example.co.uk'
$env:ADMIN_NAME = 'STS Administrator'
$env:ADMIN_PASSWORD = '<unique password of at least 14 characters>'
npm run admin:create
Remove-Item Env:ADMIN_PASSWORD
```

Start the API and existing UI together:

```powershell
npm run dev
```

Open http://localhost:4173/. The API is served through the same origin at `/api/v1`; its health endpoint is `/api/v1/health`. The local fallback database is SQLite at `prisma/dev.db`. `npm run db:dev` derives the SQLite schema from the canonical production schema, generates its client, and creates the local database.

Run the rule-engine tests with `node --test tests/rule-engine.test.js`. The API integration test requires `npm run dev` to be running and can be run with `node --test tests/api.integration.test.js`.

## Production Database

Production is PostgreSQL only. Configure `.env` from `.env.example` with a managed PostgreSQL URL, `NODE_ENV=production`, `DATABASE_PROVIDER=postgresql`, the public `APP_ORIGIN`, and a fresh base64-encoded 32-byte `APP_ENCRYPTION_KEY`.

```powershell
npm run db:generate:postgres
npm run db:migrate:deploy
npm run build
npm start
```

The initial PostgreSQL migration is under `prisma/migrations/`. Do not use SQLite in production. Keep database credentials, AI keys, and encryption keys in the deployment secret manager.

## Authentication & Roles

Passwords are bcrypt-hashed. Sessions use random opaque tokens stored as hashes and sent only in HttpOnly, SameSite cookies. Failed sign-ins are rate-limited and accounts are temporarily locked after repeated failures. Admins create and deactivate staff accounts from Settings.

- **Admin:** all access, including staff, AI settings, provider costs and margins.
- **Manager:** sales operations, providers, bookings, follow-ups, reports, and customer-facing pricing; no provider cost/margin access.
- **Sales Adviser:** assigned/created customers, leads, consultations, quotes and follow-ups.
- **Viewer:** read-only permitted customer, lead, quote, booking, follow-up, provider, pricing and knowledge areas.

Authorization is enforced by API middleware. Sales Adviser row access is scoped to assigned or created records. Browser UI state is not an authorization boundary.

## AI Configuration

Ollama is the default zero-API-cost provider (`http://127.0.0.1:11434`, model `llama3.2:3b`). Install/start Ollama and pull the model locally to enable AI. The consultation rule engine remains authoritative; AI may help extract explicitly stated facts, reword the selected next question, coach, and summarize. Extraction results are shown for adviser review before confirmation, and changing confirmed answers requires explicit replacement approval.

External OpenAI-compatible, Groq-compatible, OpenRouter-compatible, and Gemini providers are disabled until an Admin enables them. Provider keys are encrypted at rest using `APP_ENCRYPTION_KEY` and never returned to the browser. If AI is unavailable, rule-based route selection and next-question guidance continue to work.

## Legacy Demo Import

On sign-in, a development-only prompt can import the old `sts-adviser-v1` browser demo leads. The import is deduplicated and disabled in production. After successful import, the old browser copy is removed. New records are read from and written to the server database; local storage is not the CRM source of truth.

## API Areas

Versioned routes cover authentication/password reset, users, customers, leads, consultations/answers/next-question, quotes, follow-ups, providers/training centres/courses, pricing, bookings/payments, knowledge articles, AI extraction/coaching/settings, application settings, and audit events. Request data is validated with Zod; monetary values are integer pence and quote totals are calculated server-side.

## Production Readiness

This is a functioning full-stack foundation, not a fully deployment-certified CRM. Before live customer use, configure and test managed PostgreSQL, HTTPS/TLS, backups and restore procedures, monitoring, email delivery for password resets, data-retention workflows, and privacy/legal review. Document upload endpoints and object storage are not enabled; do not store identity or medical documents until encrypted access-controlled storage, malware scanning, retention and deletion controls are implemented. The local demo importer must remain disabled in production.
