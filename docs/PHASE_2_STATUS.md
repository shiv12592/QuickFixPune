# Phase 2 Authentication Status

## COMPLETED

- Added a versioned Phase 2 migration extending the existing OTP and session
  tables with account roles, provider metadata, request-IP hashes, and active
  challenge protection. Internal account/session references remain UUIDs.
- Added shared customer/provider mobile OTP sign-in. Customer account creation
  occurs only after OTP verification; repeated mobile sign-ins reuse the same
  user and profile.
- Added MSG91 OTP send/verify and Fast2SMS template delivery adapters. Both use
  HTTPS APIs and server-side environment variables; the application never logs
  OTPs or provider credentials.
- Added five-minute OTP expiry, single use, a five-attempt challenge limit,
  resend cooldown, per-mobile/IP request limits, and an in-process IP
  verification limiter.
- Added opaque random session cookies (`HttpOnly`, `SameSite=Lax`, `Secure` in
  production) with only SHA-256 token hashes in `auth_sessions`, seven-day
  expiry, server-side `/api/auth/me`, and revocation on logout.
- Added role and ownership checks to PostgreSQL conversation/message/read and
  provider dashboard/availability operations. Client-supplied IDs and roles
  are not authorization authority in PostgreSQL mode.
- Added authenticated Socket.IO handshakes, participant-only conversation
  rooms, authenticated sender identity, session-expiry/logout handling, and
  message persistence before broadcast.
- Kept public provider search/details public and excluded provider phone/full
  address. Legacy localStorage identities remain only for the JSON development
  fallback; production startup refuses JSON persistence.
- Added Helmet headers, bounded JSON requests, origin validation, restricted
  same-origin Socket.IO access, and path-only request logs.
- Added Node 22.12.0 pin, production environment validation, and Render
  instructions. No service was deployed.
- Added authentication unit tests and extended `test:postgres` to exercise OTP,
  sessions, ownership, sockets, privacy, read/unread, and schema constraints.
- No Phase 3 features were added. Payments and wallet remain paused.

## PENDING MANUAL

### 1. Apply the Phase 2 database migration

**Why:** The Agent environment has no Supabase connection string or local
PostgreSQL executable. The migration cannot be applied or inspected remotely
from this worktree.

**Action:** In the local project, put the existing Supabase PostgreSQL URI in
the ignored root `.env`, set a local `SESSION_SECRET`, then run:

```sh
npm run db:migrate
```

**Expected result:** Both the initial Phase 1 schema and the Phase 2
authentication migration are reported as applied; `auth_sessions.role` and
the new OTP challenge metadata columns exist.

**If it fails:** Send the migration error and PostgreSQL server version with
passwords/URIs redacted. Do not send `.env`.

### 2. Choose and configure a real OTP provider

**Why:** Provider accounts, DLT templates, sender registration, and API
credentials belong to the application's owner. They cannot be created or
verified without access to the vendor accounts.

**Action:** Complete the provider's India transactional SMS/DLT setup. Set
`OTP_PROVIDER=msg91` with `MSG91_AUTH_KEY` and `MSG91_TEMPLATE_ID`, or set
`OTP_PROVIDER=fast2sms` with `FAST2SMS_API_KEY` and `FAST2SMS_OTP_ID`. Store
values only in local `.env` or the hosting provider's secret environment.
Never paste keys into chat or source control.

**Expected result:** A real test handset receives an OTP, the correct code
creates a session, and incorrect/expired/reused codes are rejected.

**If it fails:** Share the provider name, timestamp, sanitized API status/body,
and relevant application error. Redact OTPs, keys, phone numbers, and
connection strings.

### 3. Correct the legacy provider's real mobile/address data

**Why:** The imported provider has no usable mobile number, and must prove
ownership of a number before that account can use OTP. Its address is also
incomplete. No value is fabricated by the importer or this phase.

**Action:** Obtain the actual provider details and update the existing
`users.mobile_e164` and `provider_profiles.private_address` rows in a
transaction. Use the SQL example in the README after confirming the provider's
actual public ID. A duplicate mobile will correctly fail the unique constraint.

**Expected result:** The verified number is stored in E.164 form and is unique;
the address remains private. The provider can request OTP only after
verification status is eligible.

**If it fails:** Provide the redacted constraint error and confirm whether the
number already belongs to another account. Do not send the full phone/address.

### 4. Configure and validate Render

**Why:** Render account/repository access, production secret values, and a
public service URL are owner-controlled.

**Action:** Create a Render Web Service for the chosen GitHub branch. Use
`npm ci`, `npm start`, and `/api/health`. Set production `DATABASE_URL`,
`APP_BASE_URL` (exact HTTPS origin), a distinct strong `SESSION_SECRET`,
`OTP_PROVIDER`, and only the selected provider credentials in Render's
environment dashboard. Confirm a successful deployment and health check.

**Expected result:** The service starts on Render's `$PORT` bound to
`0.0.0.0`, reports database health, serves the site over HTTPS, and maintains
Socket.IO over WSS.

**If it fails:** Send the Render deploy/build log with all environment values
redacted. Do not send secrets.

### 5. Verify the provider identity and domain

**Why:** Production OTP is tied to an owner-verified phone; DNS/domain settings
and certificate issuance require control of the domain.

**Action:** Complete provider verification and attach the production domain in
Render. Set `APP_BASE_URL` to that exact HTTPS origin after the domain is
active.

**Expected result:** HTTPS and secure cookies work on the custom domain; OTP
login and authenticated WebSocket reconnect work there.

**If it fails:** Send the public URL and sanitized browser/network or Render
logs.

## VERIFIED

Record only checks actually run in this worktree:

- `npm test`: all 9 authentication cryptography, provider adapter contract,
  production configuration, and rate-limiter unit tests passed.
- `npm run test:json`: legacy JSON API/Socket.IO regression coverage and
  original source-file integrity.
- JavaScript syntax checks, `npm ls --depth=0`, and `git diff --check`.
- JSON-mode smoke check: `/api/health`, `/api/auth/status`, and `/login` returned
  the expected development-mode responses; the login page served CSP and
  `X-Content-Type-Options` headers.

The PostgreSQL integration script includes customer/provider authentication,
OTP expiry/attempt limits/reuse, duplicate mobile prevention, private/public
data checks, conversation ownership, Socket.IO session/room authorization,
read state, provider availability, foreign keys, and booking overlap coverage.
It is not described as passed unless it runs against PostgreSQL.

## BLOCKED

- `npm run db:migrate` and `npm run test:postgres` against Supabase: blocked
  until `DATABASE_URL` is configured in the local ignored `.env`.
- Live MSG91/Fast2SMS delivery and DLT template verification: blocked until an
  owner configures an approved provider template and credentials.
- Render deploy, HTTPS, and production WSS smoke tests: not run; no Render
  service or production credentials are available to this worktree.

## Security validation

- Production mode fails startup without PostgreSQL, a valid HTTPS
  `APP_BASE_URL`, a 32-byte-or-longer `SESSION_SECRET`, and real provider
  credentials. Development OTP is explicitly opt-in and production rejects it.
- Raw session tokens are returned only as `HttpOnly` cookies; database rows
  store only token hashes. OTPs are never logged or returned outside explicit
  non-production development mode.
- PostgreSQL API ownership is derived from the session; Socket.IO ignores
  client-supplied user IDs/roles and checks the session and conversation
  participant.
- Provider suspension/unverified status blocks operational API access and
  authenticated chat. Public provider APIs omit phone numbers and private
  addresses.
- Unsafe requests with a cross-origin `Origin` are rejected; credentialed
  Socket.IO is restricted to the configured application origin. Helmet headers
  are enabled.
- `.env` remains ignored and `.env.example` contains no credentials. The real
  SMS provider, production origin, live cookies, and Supabase permissions still
  require manual deployment verification.

## Render Deployment Checklist

- [ ] Set the correct GitHub branch and enable auto-deploy only after selecting
      the intended branch.
- [ ] Apply migrations to the existing Supabase database before starting the
      service.
- [ ] Set the production environment variables in Render; never commit them.
- [ ] Select one real OTP provider and confirm its approved DLT template.
- [ ] Use Node 22.12.0, build `npm ci`, start `npm start`, health `/api/health`.
- [ ] Confirm HTTPS, secure cookies, origin restrictions, WSS, and provider SMS
      from a real test device.
- [ ] Confirm backup and rollback procedures before processing real accounts.
- [ ] Keep one Render instance while the per-IP verification limiter is
      process-local; use shared storage before scaling.

## NEXT PHASE

- Supabase Phase 2 migration and the full PostgreSQL integration suite pass.
- Real OTP send/verify has been tested with the selected provider and an
  approved template.
- The legacy provider mobile/address correction is complete and verified.
- Customer/provider account recovery, logout, expiry, and Socket.IO session
  invalidation have been tested on the intended production origin.
- Render health checks, HTTPS, WSS, database backups, and restore/rollback
  procedures have been verified.
- Phase 3 remains unstarted. Payments/wallet, voice messages, booking slots,
  scheduling, reviews, and an admin portal are not included in Phase 2.
- City selection and multi-city service-area modeling are not implemented;
  Pune remains the initial/test data area and must not be treated as the
  permanent product boundary.
