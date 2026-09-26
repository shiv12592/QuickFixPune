const express = require('express');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = 3000;

require('./database');

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

app.use(express.static(path.join(__dirname, '..', 'public')));

const providerRoutes = require('./routes/providers');
const customerRoutes = require('./routes/customers');
const unlockRoutes = require('./routes/unlocks');
const messageRoutes = require('./routes/messages');
const { setupRealtime } = require('./realtime');

app.use('/api/providers', providerRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/unlock', unlockRoutes);
app.use('/api/messages', messageRoutes);

setupRealtime(io);

app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    message: 'QuickFix Pune backend is running'
  });
});

app.get('/api/test', (req, res) => {
  res.json({
    success: true,
    message: 'API test successful'
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('======================================');
  console.log('QuickFix Pune Backend Started');
  console.log(`URL: http://localhost:${PORT}`);
  console.log('======================================');
});
