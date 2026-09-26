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

For local MVP testing, the customer and provider browser identities are kept in
`localStorage`. These are not production authentication; replace them with
server-authenticated sessions before exposing the service publicly. Conversation
and Socket.IO handlers check that the supplied identity is a conversation
participant.

Payments and contact unlocking remain backend-only and are not part of the
customer or provider screens.