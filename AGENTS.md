# AGENTS.md

The canonical, in-depth project documentation lives in [`AGENT.md`](./AGENT.md)
(architecture, domain decisions, changelog). This file only holds
environment/startup guidance for automated agents.

## Cursor Cloud specific instructions

This repo is the **CRM EduIT backend** — a Next.js 15 (App Router) API-only
server. There are no UI pages here; the web UI lives in a separate repo. It
requires **PostgreSQL 16 (+ pgvector)** and **Redis 7**. Standard
lint/test/build/run commands are in `package.json#scripts`; the notes below only
cover the non-obvious cloud caveats.

### Starting services (no systemd on the VM)

Postgres and Redis are installed in the VM snapshot but do **not** auto-start.
At the beginning of a session, start them manually (idempotent):

```bash
sudo pg_ctlcluster 16 main start          # PostgreSQL on :5432
sudo redis-server /etc/redis/redis.conf --daemonize yes   # Redis on :6379
redis-cli ping                             # -> PONG
```

Then run the dev server (Turbopack, port **3001** — not 3000):

```bash
npm run dev
```

Verify everything is wired up: `curl http://localhost:3001/api/health` must
return `{"status":"ok", ...}` with both `db.ok` and `redis.ok` true (it returns
HTTP 503 if either dependency is down).

### Database: use `prisma db push`, NOT `migrate deploy` on a fresh DB

The dev database is managed in **`db push` style** (see `AGENT.md`). The
`prisma/migrations/` history contains orphan/duplicate migrations, so
`prisma migrate deploy` from an empty database fails (e.g. `column
"lastInboundAt" ... already exists`). For a fresh local DB:

```bash
sudo -u postgres psql -c "CREATE ROLE crm LOGIN PASSWORD 'crm' SUPERUSER;"   # once
sudo -u postgres createdb -O crm db_crm                                       # once
sudo -u postgres psql -d db_crm -c "CREATE EXTENSION IF NOT EXISTS vector;"   # once
npx prisma db push        # builds the full schema from prisma/schema.prisma
```

The `ai_agent_knowledge_chunks.embedding vector(1536)` column is intentionally
**not** in the Prisma model (managed via raw SQL), so `db push` omits it. If AI
knowledge features are needed, add it manually (idempotent):

```bash
sudo -u postgres psql -d db_crm -c 'ALTER TABLE "ai_agent_knowledge_chunks" ADD COLUMN IF NOT EXISTS "embedding" vector(1536);'
```

Seed org + super-admin + default pipeline: `npm run db:seed`. With
`SEED_ADMIN_PASSWORD` set in `.env`, the seed also resets the admin password so
you can log in deterministically.

### Environment file

`.env` is gitignored (persisted in the VM snapshot, not in git). A working local
`.env` needs at minimum: `DATABASE_URL=postgresql://crm:crm@localhost:5432/db_crm`,
`REDIS_URL=redis://localhost:6379`, `NEXTAUTH_URL=http://localhost:3001`,
matching `NEXTAUTH_SECRET`/`AUTH_SECRET`, `ALLOWED_ORIGINS=http://localhost:3000`,
and `SEED_ADMIN_EMAIL`/`SEED_ADMIN_PASSWORD`. See `.env.example` for the full
list (most other keys — Meta/WhatsApp, AI, Stripe, telephony — are optional and
degrade gracefully when absent).

### Testing this API (no GUI)

Because there are no UI pages, exercise the API over HTTP. Auth is either a
NextAuth session cookie (credentials login via `/api/auth/csrf` +
`/api/auth/callback/credentials`) or a `Bearer` API token. Example smoke test:
log in as the seeded admin, then `POST /api/leads` to create a contact+deal.

`npm test` (Vitest) passes all suites but exits non-zero due to one unhandled
async rejection from an auto-started background sweeper (`stale-outbound-sweeper`)
that fires during the run without a DB password in the test env. This is a
harness side-effect, not a real test failure — check the "Tests X passed" line.
