# QuickFix Pune

QuickFix Pune is a lightweight Express, HTML, CSS, JavaScript and Socket.IO
prototype for connecting Pune customers with local service providers.

## Run locally

```sh
npm ci
npm start
```

The server listens on `http://localhost:3000` by default. Set `PORT` to use a
different local port.

- Customer marketplace: `http://localhost:3000/customer`
- Provider dashboard: `http://localhost:3000/provider`
- Provider registration: `http://localhost:3000/provider-register.html`

The local JSON store is created at `database/quickfix.json` and is intentionally
ignored by Git. It holds providers, customers, conversations, messages and
service requests. Existing verified providers without an availability value
default to `AVAILABLE`.

## Phase 1 — PostgreSQL / Supabase Setup

The JSON implementation remains available for local development when
`DATABASE_URL` is not set. PostgreSQL mode is selected when `DATABASE_URL` is
present and uses PostgreSQL-backed provider, customer, messaging, and realtime
handlers. The original `database/quickfix.json` remains untouched as the source
backup. Payment/unlock routes are not mounted in PostgreSQL mode while payment
is paused.

1. Copy `.env.example` to `.env` in the repository root:

   ```sh
   # PowerShell
   Copy-Item .env.example .env

   # macOS/Linux
   cp .env.example .env
   ```

2. In the existing Supabase project, open **Connect** and obtain its PostgreSQL
   connection URI. Set `DATABASE_URL` in `.env` to that URI. Use the connection
   mode Supabase recommends for your local network; direct connections may
   require IPv6. Do not use a Supabase API/service-role key as `DATABASE_URL`.

3. Install dependencies and apply the versioned schema:

   ```sh
   npm ci
   npm run db:migrate
   ```

4. Run the read-only JSON import preview:

   ```sh
   npm run db:import-json:dry-run
   ```

5. Review the newest report in `database/migration-reports/`. Resolve any
   `unmigrated` records before continuing. The importer aborts and rolls back
   rather than silently skipping records. The existing provider is missing a
   valid mobile and full address; neither value is fabricated. Its profile can
   be imported with a null phone and an empty private address, but the phone
   must be corrected before OTP authentication.

6. After review, take a database backup and import:

   ```sh
   npm run db:import-json
   ```

7. Run PostgreSQL API, Socket.IO, and constraint integration tests against the
   database:

   ```sh
   npm run test:postgres
   ```

Import reports and legacy-ID-to-UUID/public-ID mappings are written under
`database/migration-reports/`, ignored by Git. Imports are idempotent by source
collection and legacy ID. The importer reads but never deletes or modifies
`database/quickfix.json`. OTP challenges and payment leads are intentionally
not imported.

Supabase connection strings contain a database password. Keep `.env` local and
verify it remains ignored with `git check-ignore .env`. `.env` must never be
committed; `DATABASE_URL` must never be placed in source code. Never include
credentials in logs, screenshots, source control, or support messages. Supabase
service-role keys must never be exposed to frontend code.

For local JSON-mode API and Socket.IO regression coverage, use an isolated
temporary copy of the ignored JSON database:

```sh
npm run test:json
```

The PostgreSQL schema uses UUID primary keys internally and separate public
IDs for customer/provider records and conversations/messages. Provider search
and profile responses omit mobile numbers and full addresses. This phase does
not implement production authentication: the current identity-in-request
behavior remains a prototype limitation, and OTP endpoints in PostgreSQL mode
return `501` rather than pretending to authenticate.

`npm run db:rollback` drops the latest schema migration; do not run it against
data that must be retained.

For local MVP testing, the customer and provider browser identities are kept in
`localStorage`. These are not production authentication; replace them with
server-authenticated sessions before exposing the service publicly. Conversation
and Socket.IO handlers check that the supplied identity is a conversation
participant.

Payments and contact unlocking remain backend-only and are not part of the
customer or provider screens.