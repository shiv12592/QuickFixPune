# QuickFix Architecture

QuickFix is intended to serve multiple cities. Pune is only the initial/test
service area, not the permanent product identity. This is an architecture
description, not a claim that multi-city support is implemented.

## Current architecture

- **Frontend:** Static HTML, CSS, and browser JavaScript served by Express.
  Existing customer, provider, login, request, and chat routes remain unchanged.
- **Express API:** REST endpoints serve provider/customer operations and
  authentication. PostgreSQL handlers are selected when `DATABASE_URL` is set;
  the legacy JSON implementation remains a local development fallback.
- **PostgreSQL/Supabase:** PostgreSQL stores users, customer/provider profiles,
  service categories, saved locations, availability, requests, bookings,
  conversations, messages, OTP challenges, and sessions. Supabase is the
  configured production database target; a live connection is owner-configured.
- **Customer/provider model:** A `users` row owns a customer or provider profile.
  Providers include verification status and availability; their mobile and
  private address are not part of public provider responses.
- **Public/private identity:** Internal UUIDs are database references. Customers
  and providers have separate public record IDs and display names; full names,
  mobile numbers, and private addresses are retained as private data.
- **Authentication and OTP:** Customer/provider sign-in uses OTP. An OTP service
  abstraction selects the configured provider (MSG91 or Fast2SMS); provider
  credentials stay server-side. Production rejects development OTP.
- **Sessions:** Opaque session tokens are sent in HttpOnly cookies, stored in
  PostgreSQL as hashes, expire, and can be revoked at logout. API and Socket.IO
  authorization use the server-side session rather than trusting client identity.
- **Socket.IO:** Authenticated conversation participants exchange messages.
  Messages are persisted before broadcast; conversation access is checked.
- **Deployment:** The documented target is a Node.js Express/Socket.IO service
  on Render, connected to Supabase PostgreSQL and served over HTTPS/WSS. Render
  deployment and live provider/database checks remain manual.
- **Payments:** Payment and wallet functionality are intentionally paused.
  PostgreSQL mode does not mount the legacy unlock/payment routes.

## City model and expansion

There is currently no city table, city identifier, or selected-city configuration
in the database/API. Provider and saved-location records contain area and
pincode; existing seed data is from Pune. Provider search uses these locality
fields rather than a city boundary.

Pune-specific labels remain in existing UI pages and server/package naming.
These are presentation or compatibility strings, not a configurable city model;
they have deliberately not been globally renamed because routes, package
metadata, and persisted data must remain compatible.

For multi-city support, introduce an explicit city/catalog and service-area
model, associate provider service areas and customer/request locations with
those records, and scope search and operations by selected city. Make city
labels and any city-specific configuration data-driven. Migrate existing Pune
records explicitly before enabling additional cities; do not infer a city solely
from UI text or silently reinterpret existing area/pincode data.
