require('dotenv').config();

const express = require('express');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = Number(process.env.PORT) || 3000;
const postgresEnabled = Boolean(process.env.DATABASE_URL);

if (!postgresEnabled) {
  require('./database');
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  const start = Date.now();

  res.on('finish', () => {
    console.log(
      `[API] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - start}ms)`
    );
  });

  next();
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
    return res.json({ success: true, message: 'QuickFix Pune backend is running' });
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
    console.error('[API] Request failed:', error.message);
  }
  res.status(status).json({ success: false, message });
});

async function start() {
  if (postgresEnabled) {
    const { pool } = require('./db/pool');
    const schema = await pool.query(
      `SELECT to_regclass('public.users') AS users,
              to_regclass('public.messages') AS messages`
    );
    if (!schema.rows[0].users || !schema.rows[0].messages) {
      throw new Error('PostgreSQL schema is not initialized; run npm run db:migrate first');
    }
  }
  const host = process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1';
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
