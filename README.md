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
and profile responses omit mobile numbers and full addresses. Phase 2 adds
production cookie sessions and OTP sign-in for PostgreSQL mode; see the setup
section below. The legacy JSON mode remains a local-only prototype.

`npm run db:rollback` drops the latest schema migration; do not run it against
data that must be retained.

In the JSON development fallback, the existing local test identities remain in
`localStorage`. Production mode requires PostgreSQL and uses server-side
sessions; it does not accept browser-stored IDs as authentication.

Payments and contact unlocking remain backend-only and are not part of the
customer or provider screens.

## Phase 2 — OTP Authentication and Render Readiness

Phase 2 uses the existing `otp_challenges` and `auth_sessions` tables. It adds
one versioned migration for authentication metadata and session roles. Apply
all migrations before starting PostgreSQL mode:

```sh
npm run db:migrate
npm test
npm run test:postgres
```

`npm run test:postgres` requires a disposable PostgreSQL database configured in
the local, ignored root `.env`. It creates and removes uniquely numbered test
records; do not point it at a database where test writes are prohibited.

### Local OTP configuration

1. Copy `.env.example` to `.env` and set `DATABASE_URL` to the PostgreSQL URI
   from the existing Supabase project's **Connect** panel.
2. Set `APP_BASE_URL=http://localhost:3000`.
3. Generate a session secret locally and copy its output to `SESSION_SECRET`:

   ```sh
   node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
   ```

4. For local-only OTP testing, explicitly set:

   ```env
   OTP_PROVIDER=development
   DEV_OTP_ENABLED=true
   ```

   This mode returns a test OTP in the development API response. It is rejected
   whenever `NODE_ENV=production`. Never use it to authenticate real users.
5. To exercise a real SMS provider locally, select `msg91` or `fast2sms` and
   configure only that provider's credentials. No API key belongs in browser
   code or source control.

### OTP provider setup

Choose one provider and create/approve the corresponding Indian transactional
OTP template before enabling production sign-in:

- **MSG91:** create an OTP template in the MSG91 OTP section, complete the
  applicable sender/DLT steps, then configure `MSG91_AUTH_KEY` and
  `MSG91_TEMPLATE_ID`. The backend calls MSG91's OTP send and verify endpoints.
  See the [MSG91 OTP API](https://docs.msg91.com/otp/sendotp) and
  [verification API](https://docs.msg91.com/otp/verify-otp).
- **Fast2SMS:** create and approve an OTP template with the provider, complete
  applicable DLT requirements, then configure `FAST2SMS_API_KEY` and
  `FAST2SMS_OTP_ID`. The application generates a one-time code, stores only a
  keyed hash, and asks Fast2SMS to deliver it using that template. See
  [Fast2SMS Send OTP](https://docs.fast2sms.com/reference/send-otp.md).

The API applies a five-minute expiry, single-use verification, a five-attempt
challenge limit, a 60-second resend cooldown, and database-backed per-mobile
and per-IP OTP-request limits. Verification attempts are also limited per IP in
the running Node process. Keep the Render service at one instance unless this
last limiter is moved to shared storage (for example, Redis); challenge-level
attempt limits remain database-enforced across instances.

The provider login requires an existing provider account. Providers with
`PENDING` verification may sign in to see their status but cannot access
provider operations; `SUSPENDED` providers are denied operational access.
Customers can create a permanent account after successfully verifying their
mobile number. Existing account names are not overwritten by a subsequent login.

### Legacy provider correction

The imported legacy provider has no usable mobile number, so it cannot use OTP
until an operator supplies the real number. Do not invent one. After verifying
the public ID and receiving the provider's information, replace the placeholders
below in the Supabase SQL editor and run the statements in a transaction:

```sql
BEGIN;
UPDATE users
SET mobile_e164 = '<REAL +91 MOBILE NUMBER>'
WHERE id = (
  SELECT user_id FROM provider_profiles WHERE public_id = 'QF-PROV-000001'
);
UPDATE provider_profiles
SET private_address = '<REAL PRIVATE ADDRESS>'
WHERE public_id = 'QF-PROV-000001';
COMMIT;
```

Replace both values with verified data before executing. `mobile_e164` must use
E.164 format and must not already belong to another user. If the actual provider
public ID differs, use the ID shown by the database. The phone and full address
remain private and are not returned by public provider APIs.

### Render setup

Create a Render **Web Service** connected to the desired GitHub branch. Use:

- Build command: `npm ci`
- Start command: `npm start`
- Health check path: `/api/health`
- Node version: `.node-version` (22.12.0; `package.json` limits Node to 22.x)

The server binds to `0.0.0.0:$PORT` in production and uses the existing
Supabase PostgreSQL session-pooler URI. Set the following in Render's
environment dashboard; never commit them:

- `NODE_ENV=production`
- `DATABASE_URL` (Supabase PostgreSQL URI)
- `APP_BASE_URL` (the exact HTTPS origin serving this application)
- `SESSION_SECRET` (at least 32 bytes; generate a distinct production value)
- `OTP_PROVIDER=msg91` **or** `OTP_PROVIDER=fast2sms`
- Only the selected provider's key/template variables listed above

Production startup fails closed if PostgreSQL, HTTPS origin, a strong session
secret, or the selected real SMS provider configuration is missing. Apply
database migrations before deployment; startup does not automatically mutate
the production schema. Render provides HTTPS and WebSocket support for Socket.IO
once the service and domain are configured. Confirm current plan/price and
regional availability in Render's dashboard; no pricing is guaranteed here.
No Render deployment or custom domain has been configured by this repository
change.

`.env` must never be committed. `DATABASE_URL`, SMS credentials, and
`SESSION_SECRET` must never be placed in source code or frontend assets.
Supabase service-role keys are not used by this server and must never be
exposed to the browser.