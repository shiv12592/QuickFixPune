require('dotenv').config();

const express = require('express');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
const helmet = require('helmet');

const app = express();
const server = http.createServer(app);
const PORT = Number(process.env.PORT) || 3000;
const postgresEnabled = Boolean(process.env.DATABASE_URL);
const production = process.env.NODE_ENV === 'production';
const configuredOrigin = process.env.APP_BASE_URL
  ? new URL(process.env.APP_BASE_URL).origin
  : null;

if (!postgresEnabled && production) {
  throw new Error('DATABASE_URL is required in production; JSON persistence is development-only');
}

if (postgresEnabled && production) {
  require('./services/otp').validateProductionAuthConfig(process.env);
}

if (!postgresEnabled) {
  require('./database');
}

function isAllowedOrigin(origin, requestHost, requestProtocol) {
  if (!origin) return true;
  let receivedOrigin;
  try {
    receivedOrigin = new URL(origin).origin;
  } catch {
    return false;
  }
  if (configuredOrigin) return receivedOrigin === configuredOrigin;
  return receivedOrigin === `${requestProtocol || 'http'}://${requestHost}`;
}

const io = new Server(server, {
  ...(configuredOrigin
    ? { cors: { origin: configuredOrigin, credentials: true } }
    : {}),
  allowRequest: (request, callback) => {
    const origin = request.headers.origin;
    const allowed = !origin || isAllowedOrigin(
        origin,
        request.headers.host,
        request.headers['x-forwarded-proto'] || 'http'
      );
    callback(allowed ? null : 'Origin not allowed', allowed);
  }
});
app.locals.io = io;
if (production) app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      connectSrc: ["'self'", 'ws:', 'wss:'],
      fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com'],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      objectSrc: ["'none'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com']
    }
  }
}));
app.use(express.json({ limit: '32kb' }));
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    const origin = req.get('origin');
    const requestProtocol = req.get('x-forwarded-proto') || req.protocol;
    if (origin && !isAllowedOrigin(origin, req.get('host'), requestProtocol)) {
      return res.status(403).json({ success: false, message: 'Request origin is not allowed' });
    }
  }
  const start = Date.now();

  res.on('finish', () => {
    console.log(
      `[API] ${req.method} ${req.path} -> ${res.statusCode} (${Date.now() - start}ms)`
    );
  });

  return next();
});

app.get('/providers.html', (req, res) => {
  res.redirect('/customer');
});

app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/customer', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.get('/provider', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'provider.html'));
});

app.get(['/login', '/customer-login', '/provider-login'], (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'login.html'));
});

app.get('/api/auth/status', (_req, res) => {
  res.json({ success: true, authenticationEnabled: postgresEnabled });
});

if (postgresEnabled) {
  app.use('/api/auth', require('./routes/postgres/auth').router);
}

const providerRoutes = postgresEnabled
  ? require('./routes/postgres/providers')
  : require('./routes/providers');
const customerRoutes = postgresEnabled
  ? require('./routes/postgres/customers')
  : require('./routes/customers');
const messageModule = postgresEnabled
  ? require('./routes/postgres/messages')
  : { router: require('./routes/messages') };

app.use('/api/providers', providerRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/messages', messageModule.router);

if (postgresEnabled) {
  require('./realtime-postgres').setupRealtimePostgres(io);
} else {
  app.use('/api/unlock', require('./routes/unlocks'));
  require('./realtime').setupRealtime(io);
}

app.get('/api/health', (req, res) => {
  if (!postgresEnabled) {
    return res.json({
      success: true,
      message: 'QuickFix Pune backend is running',
      mode: 'json-development'
    });
  }
  require('./db/pool').pool.query('SELECT 1')
    .then(() => res.json({ success: true, database: 'connected' }))
    .catch(() => res.status(503).json({ success: false, database: 'unavailable' }));
});

app.get('/api/test', (req, res) => {
  res.json({
    success: true,
    message: 'API test successful'
  });
});

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const status = Number(error.status || error.statusCode) || 500;
  const message = status < 500
    ? error.message
    : 'The request could not be completed';
  if (status >= 500) {
    console.error('[API] Request failed');
  }
  res.status(status).json({ success: false, message });
});

async function start() {
  if (postgresEnabled) {
    const { pool } = require('./db/pool');
    const schema = await pool.query(
      `SELECT to_regclass('public.users') AS users,
              to_regclass('public.messages') AS messages,
              EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name = 'auth_sessions'
                  AND column_name = 'role'
              ) AS auth_migration_applied`
    );
    if (!schema.rows[0].users || !schema.rows[0].messages) {
      throw new Error('PostgreSQL schema is not initialized; run npm run db:migrate first');
    }
    if (!schema.rows[0].auth_migration_applied) {
      throw new Error('Phase 2 authentication migration is not applied; run npm run db:migrate');
    }
  }
  const host = production ? '0.0.0.0' : '127.0.0.1';
  server.listen(PORT, host, () => {
    console.log('======================================');
    console.log('QuickFix Pune Backend Started');
    console.log(`URL: http://localhost:${PORT}`);
    console.log(`Persistence: ${postgresEnabled ? 'PostgreSQL' : 'local JSON (development)'}`);
    console.log('======================================');
  });
}

start().catch(error => {
  console.error('[Startup] Unable to start QuickFix Pune:', error.message);
  process.exitCode = 1;
});
