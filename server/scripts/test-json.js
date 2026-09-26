const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const net = require('net');
const { io } = require('socket.io-client');

const root = path.resolve(__dirname, '..', '..');
const sourceDatabase = path.join(root, 'database', 'quickfix.json');
const sourceHash = crypto.createHash('sha256').update(fs.readFileSync(sourceDatabase)).digest('hex');
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'quickfix-phase1-json-'));
const temporaryDatabase = path.join(temporaryDirectory, 'quickfix.json');
fs.copyFileSync(sourceDatabase, temporaryDatabase);
const appPath = path.join(root, 'server', 'server.js');

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) =>
    server.close(error => error ? reject(error) : resolve())
  );
  return port;
}

function waitForEvent(socket, eventName, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(eventName, onEvent);
      reject(new Error(`Timed out waiting for "${eventName}"`));
    }, timeout);
    const onEvent = value => {
      clearTimeout(timer);
      resolve(value);
    };
    socket.once(eventName, onEvent);
  });
}

async function waitForServer(url, child) {
  const deadline = Date.now() + 15000;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited with code ${child.exitCode}`);
    try {
      const response = await fetch(`${url}/api/health`);
      if (response.ok) return;
      lastError = new Error(`Health endpoint returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`Server failed to start: ${lastError?.message || 'unknown error'}`);
}

async function connectSocket(url) {
  const socket = io(url, {
    transports: ['websocket'],
    reconnection: false,
    timeout: 5000
  });
  await waitForEvent(socket, 'connect');
  return socket;
}

async function main() {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [appPath], {
    cwd: root,
    env: {
      ...process.env,
      DATABASE_URL: '',
      QUICKFIX_DATABASE_FILE: temporaryDatabase,
      PORT: String(port),
      NODE_ENV: 'test'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const sockets = [];
  let output = '';
  child.stdout.on('data', chunk => { output += chunk.toString(); });
  child.stderr.on('data', chunk => { output += chunk.toString(); });

  try {
    await waitForServer(url, child);
    const health = await fetch(`${url}/api/health`).then(response => response.json());
    assert.equal(health.success, true);

    const searchResponse = await fetch(
      `${url}/api/providers?service=Plumber&pincode=411057`
    );
    const searchData = await searchResponse.json();
    assert.equal(searchResponse.status, 200);
    assert.equal(searchData.providers.length, 1);
    assert(!('mobile' in searchData.providers[0]));
    assert(!('address' in searchData.providers[0]));

    const providerId = String(searchData.providers[0].id);
    const details = await fetch(`${url}/api/providers/${providerId}`).then(r => r.json());
    assert.equal(details.success, true);
    assert(!('mobile' in details.provider));
    assert(!('address' in details.provider));

    const mobile = `9${String(Date.now()).slice(-9)}`;
    const customerResponse = await fetch(`${url}/api/customers/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Offline Test Customer', mobile })
    });
    assert.equal(customerResponse.status, 201);
    const customer = (await customerResponse.json()).customer;

    const requestResponse = await fetch(`${url}/api/messages/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customerId: customer.id,
        providerId,
        service: 'Plumber',
        initialMessage: 'Offline Socket.IO test request',
        preferredVisitTime: 'Tomorrow'
      })
    });
    assert.equal(requestResponse.status, 201);
    const conversation = (await requestResponse.json()).conversation;

    const customerSocket = await connectSocket(url);
    sockets.push(customerSocket);
    const providerSocket = await connectSocket(url);
    sockets.push(providerSocket);
    const customerJoined = waitForEvent(customerSocket, 'conversation_joined');
    const providerJoined = waitForEvent(providerSocket, 'conversation_joined');
    customerSocket.emit('join_conversation', {
      conversationId: conversation.id,
      userType: 'CUSTOMER',
      userId: customer.id
    });
    providerSocket.emit('join_conversation', {
      conversationId: conversation.id,
      userType: 'PROVIDER',
      userId: providerId
    });
    await Promise.all([customerJoined, providerJoined]);

    const unauthorizedSocket = await connectSocket(url);
    sockets.push(unauthorizedSocket);
    const unauthorized = waitForEvent(unauthorizedSocket, 'message_error');
    unauthorizedSocket.emit('join_conversation', {
      conversationId: conversation.id,
      userType: 'CUSTOMER',
      userId: 'not-a-participant'
    });
    assert.match((await unauthorized).message, /not a participant/);

    const customerMessagePromise = waitForEvent(providerSocket, 'new_message');
    customerSocket.emit('send_message', {
      conversationId: conversation.id,
      message: 'Customer live message'
    });
    const customerMessage = await customerMessagePromise;
    assert.equal(customerMessage.sender_type, 'CUSTOMER');
    assert.equal(customerMessage.message, 'Customer live message');

    const providerMessagePromise = waitForEvent(customerSocket, 'new_message');
    providerSocket.emit('send_message', {
      conversationId: conversation.id,
      message: 'Provider live message'
    });
    const providerMessage = await providerMessagePromise;
    assert.equal(providerMessage.sender_type, 'PROVIDER');
    assert.equal(providerMessage.message, 'Provider live message');

    const unread = await fetch(
      `${url}/api/messages/conversations/customer/${customer.id}`
    ).then(response => response.json());
    const listedConversation = unread.conversations.find(
      item => String(item.id) === String(conversation.id)
    );
    assert.equal(listedConversation.unread_count, 1);

    const messagesBeforeRead = await fetch(
      `${url}/api/messages/conversations/${conversation.id}/messages?userType=CUSTOMER&userId=${customer.id}`
    ).then(response => response.json());
    assert.equal(messagesBeforeRead.messages.length, 3);
    assert(!messagesBeforeRead.messages.find(message =>
      message.message === 'Provider live message'
    ).read);

    const read = await fetch(
      `${url}/api/messages/conversations/${conversation.id}/read`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userType: 'CUSTOMER', userId: customer.id })
      }
    );
    assert.equal(read.status, 200);
    const messagesAfterRead = await fetch(
      `${url}/api/messages/conversations/${conversation.id}/messages?userType=CUSTOMER&userId=${customer.id}`
    ).then(response => response.json());
    assert(messagesAfterRead.messages.find(message =>
      message.message === 'Provider live message'
    ).read);

    const availability = await fetch(
      `${url}/api/providers/${providerId}/availability`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ availability: 'BUSY' })
      }
    );
    assert.equal(availability.status, 200);
    assert.equal((await availability.json()).provider.availability, 'BUSY');

    assert.equal(
      crypto.createHash('sha256').update(fs.readFileSync(sourceDatabase)).digest('hex'),
      sourceHash,
      'Original JSON database must remain unchanged'
    );
    console.log('JSON fallback API, privacy, availability, chat authorization, live messages, read state, and source integrity passed.');
  } catch (error) {
    console.error(error.stack || error);
    if (output) console.error(output);
    process.exitCode = 1;
  } finally {
    sockets.forEach(socket => socket.disconnect());
    child.kill();
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error.stack || error);
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  process.exitCode = 1;
});
