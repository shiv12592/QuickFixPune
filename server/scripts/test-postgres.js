require('dotenv').config();

const assert = require('assert/strict');
const { spawn } = require('child_process');
const crypto = require('crypto');
const net = require('net');
const path = require('path');
const { Client } = require('pg');
const { io } = require('socket.io-client');

const root = path.resolve(__dirname, '..', '..');
const appPath = path.join(root, 'server', 'server.js');
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error('Set DATABASE_URL to a disposable PostgreSQL database before running this test.');
  process.exit(1);
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function waitForServer(baseUrl, child) {
  const deadline = Date.now() + 15000;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Test server exited with code ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
      lastError = new Error(`Health check returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`Test server did not become healthy within 15 seconds: ${lastError?.message || 'unknown failure'}`);
}

function waitForSocketEvent(socket, eventName, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(eventName, onEvent);
      reject(new Error(`Timed out waiting for Socket.IO event "${eventName}"`));
    }, timeout);
    const onEvent = value => {
      clearTimeout(timer);
      resolve(value);
    };
    socket.once(eventName, onEvent);
  });
}

async function connectSocket(baseUrl) {
  const socket = io(baseUrl, {
    transports: ['websocket'],
    reconnection: false,
    timeout: 5000
  });
  await waitForSocketEvent(socket, 'connect');
  return socket;
}

async function main() {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [appPath], {
    cwd: root,
    env: { ...process.env, DATABASE_URL: databaseUrl, PORT: String(port), NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let serverOutput = '';
  child.stdout.on('data', chunk => { serverOutput += chunk.toString(); });
  child.stderr.on('data', chunk => { serverOutput += chunk.toString(); });
  const db = new Client({ connectionString: databaseUrl });
  let connected = false;
  let customerUserId;
  let providerUserId;
  let testMobile;
  let customerPublicId;
  let providerPublicId;
  const sockets = [];

  try {
    await db.connect();
    connected = true;
    await waitForServer(baseUrl, child);

    const suffix = `${Date.now()}`.slice(-9);
    testMobile = `9${suffix}`;
    const customerMobile = `8${suffix}`;

    const providerResponse = await fetch(`${baseUrl}/api/providers/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Phase One Provider Private Name',
        mobile: testMobile,
        service: 'Phase1 Test',
        experience: 3,
        address: 'Private test address',
        area: 'Integration Test Area',
        pincode: '411057'
      })
    });
    assert.equal(providerResponse.status, 201);
    const providerData = await providerResponse.json();
    providerPublicId = providerData.provider.id;
    assert.match(providerPublicId, /^QF-PROV-\d{6,}$/);
    assert.equal(providerData.provider.name, 'Phase');

    const providerUser = await db.query(
      `SELECT user_id FROM provider_profiles WHERE public_id = $1`,
      [providerPublicId]
    );
    providerUserId = providerUser.rows[0].user_id;
    await db.query(
      `UPDATE provider_profiles SET verification_status = 'VERIFIED'
       WHERE user_id = $1`,
      [providerUserId]
    );

    const customerResponse = await fetch(`${baseUrl}/api/customers/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Integration Customer Private', mobile: customerMobile })
    });
    assert.equal(customerResponse.status, 201);
    const customerData = await customerResponse.json();
    customerPublicId = customerData.customer.id;
    assert.match(customerPublicId, /^QF-CUST-\d{6,}$/);
    assert.equal(customerData.customer.name, 'Integration');

    const duplicateCustomerResponse = await fetch(`${baseUrl}/api/customers/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Different Name', mobile: customerMobile })
    });
    assert.equal(duplicateCustomerResponse.status, 200);
    assert.equal((await duplicateCustomerResponse.json()).customer.id, customerPublicId);
    const customerUser = await db.query(
      `SELECT user_id FROM customer_profiles WHERE public_id = $1`,
      [customerPublicId]
    );
    customerUserId = customerUser.rows[0].user_id;
    assert.equal((await db.query(
      'SELECT count(*)::int AS count FROM users WHERE mobile_e164 = $1',
      [`+91${customerMobile}`]
    )).rows[0].count, 1);

    const searchResponse = await fetch(
      `${baseUrl}/api/providers?service=Phase1%20Test&pincode=411057`
    );
    const searchData = await searchResponse.json();
    assert.equal(searchResponse.status, 200);
    assert(searchData.providers.some(item => item.id === providerPublicId));
    assert(!JSON.stringify(searchData).includes(testMobile));
    assert(!JSON.stringify(searchData).includes(providerUserId));

    const detailResponse = await fetch(`${baseUrl}/api/providers/${providerPublicId}`);
    const detailData = await detailResponse.json();
    assert.equal(detailResponse.status, 200);
    assert(!('mobile' in detailData.provider));
    assert(!('address' in detailData.provider));
    assert.equal(detailData.provider.name, 'Phase');

    const conversationResponse = await fetch(`${baseUrl}/api/messages/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customerId: customerPublicId,
        providerId: providerPublicId,
        service: 'Phase1 Test',
        initialMessage: 'PostgreSQL integration request',
        preferredVisitTime: 'Tomorrow'
      })
    });
    assert.equal(conversationResponse.status, 201);
    const conversationData = await conversationResponse.json();
    const conversationId = conversationData.conversation.id;
    assert.match(conversationId, /^QF-CONV-/);
    assert(!conversationId.includes('-00000000-'));
    assert(!JSON.stringify(conversationData).includes(customerUserId));
    assert(!JSON.stringify(conversationData).includes(providerUserId));
    assert(!JSON.stringify(conversationData).includes(customerMobile));
    assert(!JSON.stringify(conversationData).includes(testMobile));

    const customerSocket = await connectSocket(baseUrl);
    sockets.push(customerSocket);
    const providerSocket = await connectSocket(baseUrl);
    sockets.push(providerSocket);
    const customerJoined = waitForSocketEvent(customerSocket, 'conversation_joined');
    const providerJoined = waitForSocketEvent(providerSocket, 'conversation_joined');
    customerSocket.emit('join_conversation', {
      conversationId,
      userType: 'CUSTOMER',
      userId: customerPublicId
    });
    providerSocket.emit('join_conversation', {
      conversationId,
      userType: 'PROVIDER',
      userId: providerPublicId
    });
    await Promise.all([customerJoined, providerJoined]);

    const unauthorizedSocket = await connectSocket(baseUrl);
    sockets.push(unauthorizedSocket);
    const unauthorizedError = waitForSocketEvent(unauthorizedSocket, 'message_error');
    unauthorizedSocket.emit('join_conversation', {
      conversationId,
      userType: 'CUSTOMER',
      userId: 'QF-CUST-999999'
    });
    assert.match((await unauthorizedError).message, /not a participant/);

    const customerToProvider = waitForSocketEvent(providerSocket, 'new_message');
    customerSocket.emit('send_message', {
      conversationId,
      message: 'Customer realtime message'
    });
    const customerSocketMessage = await customerToProvider;
    assert.equal(customerSocketMessage.message, 'Customer realtime message');
    assert.equal(customerSocketMessage.sender_id, customerPublicId);

    const providerToCustomer = waitForSocketEvent(customerSocket, 'new_message');
    providerSocket.emit('send_message', {
      conversationId,
      message: 'Provider realtime message'
    });
    const providerSocketMessage = await providerToCustomer;
    assert.equal(providerSocketMessage.message, 'Provider realtime message');
    assert.equal(providerSocketMessage.sender_id, providerPublicId);

    customerSocket.disconnect();
    sockets.splice(sockets.indexOf(customerSocket), 1);
    const reconnectSocket = await connectSocket(baseUrl);
    sockets.push(reconnectSocket);
    const rejoined = waitForSocketEvent(reconnectSocket, 'conversation_joined');
    reconnectSocket.emit('join_conversation', {
      conversationId,
      userType: 'CUSTOMER',
      userId: customerPublicId
    });
    await rejoined;

    const initialMessagesResponse = await fetch(
      `${baseUrl}/api/messages/conversations/${conversationId}/messages?userType=CUSTOMER&userId=${customerPublicId}`
    );
    const initialMessages = await initialMessagesResponse.json();
    assert.equal(initialMessagesResponse.status, 200);
    assert.equal(initialMessages.messages.length, 3);
    assert(initialMessages.messages.some(message => message.message === 'PostgreSQL integration request'));
    assert.equal(initialMessages.messages[0].conversation_id, conversationId);
    assert.match(initialMessages.messages[0].id, /^QF-MSG-/);
    assert(!JSON.stringify(initialMessages).includes(customerUserId));
    assert(!JSON.stringify(initialMessages).includes(providerUserId));
    assert(!JSON.stringify(initialMessages).includes(customerMobile));
    assert(!JSON.stringify(initialMessages).includes(testMobile));

    const sentResponse = await fetch(
      `${baseUrl}/api/messages/conversations/${conversationId}/messages`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          senderType: 'PROVIDER',
          senderId: providerPublicId,
          message: 'Provider reply'
        })
      }
    );
    assert.equal(sentResponse.status, 201);
    assert.match((await sentResponse.json()).message.id, /^QF-MSG-/);

    const persistedSocketMessages = await db.query(
      `SELECT count(*)::int AS count
       FROM messages m JOIN conversations c ON c.id = m.conversation_id
       WHERE c.public_id = $1`,
      [conversationId]
    );
    assert.equal(persistedSocketMessages.rows[0].count, 4);

    const unreadList = await fetch(
      `${baseUrl}/api/messages/conversations/customer/${customerPublicId}`
    ).then(response => response.json());
    assert.equal(unreadList.conversations[0].unread_count, 2);
    const readResponse = await fetch(
      `${baseUrl}/api/messages/conversations/${conversationId}/read`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userType: 'CUSTOMER', userId: customerPublicId })
      }
    );
    assert.equal(readResponse.status, 200);
    const retrieved = await fetch(
      `${baseUrl}/api/messages/conversations/${conversationId}/messages?userType=CUSTOMER&userId=${customerPublicId}`
    ).then(response => response.json());
    assert.equal(retrieved.messages.length, 4);
    assert(retrieved.messages
      .filter(message => message.sender_type === 'PROVIDER')
      .every(message => message.read));
    assert(retrieved.messages
      .filter(message => message.sender_type === 'CUSTOMER')
      .every(message => !message.read));

    const startsAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    startsAt.setUTCSeconds(0, 0);
    const endsAt = new Date(startsAt.getTime() + 60 * 60 * 1000);
    const overlapStartsAt = new Date(startsAt.getTime() + 30 * 60 * 1000);
    const overlapEndsAt = new Date(overlapStartsAt.getTime() + 60 * 60 * 1000);
    const bookingValues = (id, start, end) => [
      id,
      `QF-BOOK-${id.replace(/-/g, '')}`,
      customerUserId,
      providerUserId,
      start.toISOString(),
      end.toISOString()
    ];
    await db.query(
      `INSERT INTO bookings
         (id, public_id, customer_id, provider_id, starts_at, ends_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      bookingValues(crypto.randomUUID(), startsAt, endsAt)
    );
    await assert.rejects(
      db.query(
        `INSERT INTO bookings
           (id, public_id, customer_id, provider_id, starts_at, ends_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        bookingValues(crypto.randomUUID(), overlapStartsAt, overlapEndsAt)
      ),
      error => error.code === '23P01'
    );

    const availabilityResponse = await fetch(
      `${baseUrl}/api/providers/${providerPublicId}/availability`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ availability: 'BUSY' })
      }
    );
    assert.equal(availabilityResponse.status, 200);
    assert.equal((await availabilityResponse.json()).provider.availability, 'BUSY');

    await assert.rejects(
      db.query(
        'INSERT INTO customer_profiles (user_id) VALUES ($1)',
        [crypto.randomUUID()]
      ),
      error => error.code === '23503'
    );
    await assert.rejects(
      db.query(
        'INSERT INTO users (id, mobile_e164, full_name) VALUES ($1, $2, $3)',
        [crypto.randomUUID(), `+91${customerMobile}`, 'Duplicate']
      ),
      error => error.code === '23505'
    );

    console.log('PostgreSQL API and constraint integration checks passed.');
  } catch (error) {
    console.error(error.stack || error);
    if (serverOutput) console.error(serverOutput);
    process.exitCode = 1;
  } finally {
    sockets.forEach(socket => socket.disconnect());
    try {
      if (customerUserId && providerUserId) {
        await db.query(
          'DELETE FROM bookings WHERE customer_id = $1 OR provider_id = $2',
          [customerUserId, providerUserId]
        );
        await db.query(
          `DELETE FROM conversations
           WHERE customer_id = $1 AND provider_id = $2`,
          [customerUserId, providerUserId]
        );
      }
      if (customerUserId) await db.query('DELETE FROM users WHERE id = $1', [customerUserId]);
      if (providerUserId) await db.query('DELETE FROM users WHERE id = $1', [providerUserId]);
    } finally {
      child.kill();
      if (connected) await db.end();
    }
  }
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
