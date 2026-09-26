require('dotenv').config();

const assert = require('assert/strict');
const { spawn } = require('child_process');
const crypto = require('crypto');
const net = require('net');
const path = require('path');
const { Client } = require('pg');
const { io } = require('socket.io-client');
const { hashSessionToken } = require('../auth/crypto');

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
  throw new Error(
    `Test server did not become healthy within 15 seconds: ${lastError?.message || 'unknown failure'}`
  );
}

function connectSocket(baseUrl, cookie) {
  return new Promise((resolve, reject) => {
    const socket = io(baseUrl, {
      transports: ['websocket'],
      reconnection: false,
      timeout: 5000,
      ...(cookie ? { extraHeaders: { Cookie: cookie } } : {})
    });
    const timeout = setTimeout(() => {
      socket.disconnect();
      reject(new Error('Socket.IO connection timed out'));
    }, 6000);
    socket.once('connect', () => {
      clearTimeout(timeout);
      resolve(socket);
    });
    socket.once('connect_error', error => {
      clearTimeout(timeout);
      socket.disconnect();
      reject(error);
    });
  });
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

function jsonHeaders(cookie) {
  return {
    'Content-Type': 'application/json',
    ...(cookie ? { Cookie: cookie } : {})
  };
}

async function postJson(url, body, cookie) {
  return fetch(url, {
    method: 'POST',
    headers: jsonHeaders(cookie),
    body: JSON.stringify(body)
  });
}

function createMobile() {
  const prefix = String(crypto.randomInt(100000000, 1000000000));
  return `9${prefix}`;
}

function sessionCookie(response) {
  const value = response.headers.get('set-cookie');
  assert(value, 'Successful authentication must set a session cookie');
  assert.match(value, /HttpOnly/i);
  assert.match(value, /SameSite=Lax/i);
  return value.split(';', 1)[0];
}

async function authenticate(baseUrl, mobile, role, fullName) {
  const requested = await postJson(`${baseUrl}/api/auth/request-otp`, { mobile, role });
  assert.equal(requested.status, 202);
  const requestData = await requested.json();
  assert.match(requestData.developmentOtp, /^\d{6}$/);

  const verified = await postJson(`${baseUrl}/api/auth/verify-otp`, {
    mobile,
    role,
    fullName,
    otp: requestData.developmentOtp
  });
  assert.equal(verified.status, 200);
  return {
    data: await verified.json(),
    cookie: sessionCookie(verified),
    otp: requestData.developmentOtp
  };
}

async function main() {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const sessionSecret = crypto.randomBytes(48).toString('hex');
  const child = spawn(process.execPath, [appPath], {
    cwd: root,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      PORT: String(port),
      NODE_ENV: 'test',
      APP_BASE_URL: baseUrl,
      SESSION_SECRET: sessionSecret,
      OTP_PROVIDER: 'development',
      DEV_OTP_ENABLED: 'true'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let serverOutput = '';
  child.stdout.on('data', chunk => { serverOutput += chunk.toString(); });
  child.stderr.on('data', chunk => { serverOutput += chunk.toString(); });
  const db = new Client({ connectionString: databaseUrl });
  const sockets = [];
  const testMobiles = new Set();
  const userIds = new Set();
  let connected = false;

  try {
    await db.connect();
    connected = true;
    await waitForServer(baseUrl, child);
    assert.equal(
      (await fetch(`${baseUrl}/api/auth/status`).then(response => response.json()))
        .authenticationEnabled,
      true
    );
    assert.equal((await fetch(`${baseUrl}/api/auth/me`)).status, 401);
    assert.equal((await postJson(`${baseUrl}/api/messages/conversations`, {})).status, 401);

    const providerMobile = createMobile();
    testMobiles.add(providerMobile);
    const providerResponse = await postJson(`${baseUrl}/api/providers/register`, {
      name: 'Phase Two Provider Private Name',
      mobile: providerMobile,
      service: 'Phase2 Test',
      experience: 3,
      address: 'Private test address',
      area: 'Integration Test Area',
      pincode: '411057'
    });
    assert.equal(providerResponse.status, 201);
    const providerData = await providerResponse.json();
    const providerPublicId = providerData.provider.id;
    assert.match(providerPublicId, /^QF-PROV-\d{6,}$/);
    assert(!JSON.stringify(providerData).includes(providerMobile));
    assert(!JSON.stringify(providerData).includes('Private test address'));
    assert.equal(providerData.provider.name, 'Phase');
    const providerUserId = (
      await db.query('SELECT user_id FROM provider_profiles WHERE public_id = $1', [providerPublicId])
    ).rows[0].user_id;
    userIds.add(providerUserId);

    const suspendedMobile = createMobile();
    testMobiles.add(suspendedMobile);
    const suspendedRegistration = await postJson(`${baseUrl}/api/providers/register`, {
      name: 'Suspended Provider',
      mobile: suspendedMobile,
      service: 'Phase2 Suspended Test',
      experience: 2,
      address: 'Private suspended provider test address',
      area: 'Integration Test Area',
      pincode: '411057'
    });
    assert.equal(suspendedRegistration.status, 201);
    const suspendedProviderId = (await suspendedRegistration.json()).provider.id;
    const suspendedUserId = (
      await db.query('SELECT user_id FROM provider_profiles WHERE public_id = $1', [
        suspendedProviderId
      ])
    ).rows[0].user_id;
    userIds.add(suspendedUserId);
    await db.query(
      `UPDATE provider_profiles SET verification_status = 'SUSPENDED'
       WHERE user_id = $1`,
      [suspendedUserId]
    );
    const suspendedRequest = await postJson(`${baseUrl}/api/auth/request-otp`, {
      mobile: suspendedMobile,
      role: 'provider'
    });
    assert.equal(suspendedRequest.status, 202);
    assert(!('developmentOtp' in await suspendedRequest.json()));
    assert.equal(
      (await postJson(`${baseUrl}/api/auth/verify-otp`, {
        mobile: suspendedMobile,
        role: 'provider',
        otp: '123456'
      })).status,
      400
    );

    const providerAuth = await authenticate(
      baseUrl,
      providerMobile,
      'provider',
      'Phase Two Provider Private Name'
    );
    const providerCookie = providerAuth.cookie;
    assert.equal(providerAuth.data.user.id, providerPublicId);
    assert.equal(providerAuth.data.user.verification_status, 'PENDING');
    assert(!JSON.stringify(providerAuth.data).includes(providerUserId));
    assert(!JSON.stringify(providerAuth.data).includes(providerMobile));

    const pendingAccess = await fetch(
      `${baseUrl}/api/providers/${providerPublicId}/dashboard`,
      { headers: { Cookie: providerCookie } }
    );
    assert.equal(pendingAccess.status, 403);
    assert.equal(
      (await pendingAccess.json()).code,
      'PROVIDER_NOT_VERIFIED'
    );
    await db.query(
      `UPDATE provider_profiles SET verification_status = 'VERIFIED'
       WHERE user_id = $1`,
      [providerUserId]
    );

    const customerMobile = createMobile();
    testMobiles.add(customerMobile);
    const customerOtpResponse = await postJson(`${baseUrl}/api/auth/request-otp`, {
      mobile: customerMobile,
      role: 'customer'
    });
    assert.equal(customerOtpResponse.status, 202);
    const customerOtp = await customerOtpResponse.json();
    assert.match(customerOtp.developmentOtp, /^\d{6}$/);
    assert.equal(
      (await db.query('SELECT count(*)::int AS count FROM users WHERE mobile_e164 = $1', [
        `+91${customerMobile}`
      ])).rows[0].count,
      0
    );
    const customerVerifyResponse = await postJson(`${baseUrl}/api/auth/verify-otp`, {
      mobile: customerMobile,
      role: 'customer',
      fullName: 'Phase Two Customer Private Name',
      otp: customerOtp.developmentOtp
    });
    assert.equal(customerVerifyResponse.status, 200);
    const customerAuth = {
      data: await customerVerifyResponse.json(),
      cookie: sessionCookie(customerVerifyResponse),
      otp: customerOtp.developmentOtp
    };
    const customerCookie = customerAuth.cookie;
    const customerPublicId = customerAuth.data.user.id;
    assert.match(customerPublicId, /^QF-CUST-\d{6,}$/);
    assert.equal(customerAuth.data.user.name, 'Phase');
    const customerUserId = (
      await db.query('SELECT user_id FROM customer_profiles WHERE public_id = $1', [customerPublicId])
    ).rows[0].user_id;
    userIds.add(customerUserId);
    assert(!JSON.stringify(customerAuth.data).includes(customerUserId));

    const customerMe = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Cookie: customerCookie }
    }).then(response => response.json());
    assert.equal(customerMe.user.public_id, customerPublicId);
    assert(!JSON.stringify(customerMe).includes(customerUserId));
    assert(!JSON.stringify(customerMe).includes(customerMobile));

    const customerCreationDisabled = await postJson(
      `${baseUrl}/api/customers/register`,
      { name: 'Bypass OTP', mobile: createMobile() }
    );
    assert.equal(customerCreationDisabled.status, 410);

    const customerCount = await db.query(
      'SELECT count(*)::int AS count FROM users WHERE mobile_e164 = $1',
      [`+91${customerMobile}`]
    );
    assert.equal(customerCount.rows[0].count, 1);

    await db.query(
      `UPDATE otp_challenges
       SET created_at = now() - interval '2 minutes'
       WHERE mobile_e164 = $1 AND role = 'CUSTOMER'`,
      [`+91${customerMobile}`]
    );
    const returningCustomerAuth = await authenticate(
      baseUrl,
      customerMobile,
      'customer',
      'A Name That Must Not Replace The Existing Name'
    );
    assert.equal(returningCustomerAuth.data.user.id, customerPublicId);
    assert.equal(returningCustomerAuth.data.user.name, 'Phase');
    assert.equal(
      (await postJson(`${baseUrl}/api/auth/verify-otp`, {
        mobile: customerMobile,
        role: 'customer',
        otp: returningCustomerAuth.otp
      })).status,
      400
    );
    const duplicateCount = await db.query(
      'SELECT count(*)::int AS count FROM users WHERE mobile_e164 = $1',
      [`+91${customerMobile}`]
    );
    assert.equal(duplicateCount.rows[0].count, 1);

    const searchResponse = await fetch(
      `${baseUrl}/api/providers?service=Phase2%20Test&pincode=411057`
    );
    const searchData = await searchResponse.json();
    assert.equal(searchResponse.status, 200);
    assert(searchData.providers.some(item => item.id === providerPublicId));
    assert(!JSON.stringify(searchData).includes(providerMobile));
    assert(!JSON.stringify(searchData).includes(providerUserId));

    const detailResponse = await fetch(`${baseUrl}/api/providers/${providerPublicId}`);
    const detailData = await detailResponse.json();
    assert.equal(detailResponse.status, 200);
    assert(!('mobile' in detailData.provider));
    assert(!('address' in detailData.provider));
    assert.equal(detailData.provider.name, 'Phase');

    const conversationResponse = await postJson(
      `${baseUrl}/api/messages/conversations`,
      {
        customerId: providerPublicId,
        providerId: providerPublicId,
        service: 'Phase2 Test',
        initialMessage: 'PostgreSQL authentication integration request',
        preferredVisitTime: 'Tomorrow'
      },
      customerCookie
    );
    assert.equal(conversationResponse.status, 201);
    const conversationData = await conversationResponse.json();
    const conversationId = conversationData.conversation.id;
    assert.match(conversationId, /^QF-CONV-/);
    assert(!JSON.stringify(conversationData).includes(customerUserId));
    assert(!JSON.stringify(conversationData).includes(providerUserId));
    assert(!JSON.stringify(conversationData).includes(customerMobile));
    assert(!JSON.stringify(conversationData).includes(providerMobile));
    const savedConversation = await db.query(
      'SELECT customer_id FROM conversations WHERE public_id = $1',
      [conversationId]
    );
    assert.equal(savedConversation.rows[0].customer_id, customerUserId);

    const outsiderMobile = createMobile();
    testMobiles.add(outsiderMobile);
    const outsiderAuth = await authenticate(
      baseUrl,
      outsiderMobile,
      'customer',
      'Unrelated Customer'
    );
    const outsiderUserId = (
      await db.query(
        'SELECT user_id FROM customer_profiles WHERE public_id = $1',
        [outsiderAuth.data.user.id]
      )
    ).rows[0].user_id;
    userIds.add(outsiderUserId);

    const outsiderMessages = await fetch(
      `${baseUrl}/api/messages/conversations/${conversationId}/messages`,
      { headers: { Cookie: outsiderAuth.cookie } }
    );
    assert.equal(outsiderMessages.status, 403);
    const forgedRoleAvailability = await fetch(
      `${baseUrl}/api/providers/${providerPublicId}/availability`,
      {
        method: 'PATCH',
        headers: jsonHeaders(customerCookie),
        body: JSON.stringify({ availability: 'BUSY' })
      }
    );
    assert.equal(forgedRoleAvailability.status, 403);
    const crossOriginAvailability = await fetch(
      `${baseUrl}/api/providers/${providerPublicId}/availability`,
      {
        method: 'PATCH',
        headers: {
          ...jsonHeaders(providerCookie),
          Origin: 'https://attacker.invalid'
        },
        body: JSON.stringify({ availability: 'BUSY' })
      }
    );
    assert.equal(crossOriginAvailability.status, 403);

    const customerSocket = await connectSocket(baseUrl, customerCookie);
    sockets.push(customerSocket);
    const providerSocket = await connectSocket(baseUrl, providerCookie);
    sockets.push(providerSocket);
    await assert.rejects(connectSocket(baseUrl), /Authentication required/);

    const customerJoined = waitForSocketEvent(customerSocket, 'conversation_joined');
    const providerJoined = waitForSocketEvent(providerSocket, 'conversation_joined');
    customerSocket.emit('join_conversation', {
      conversationId,
      userType: 'PROVIDER',
      userId: providerPublicId
    });
    providerSocket.emit('join_conversation', {
      conversationId,
      userType: 'CUSTOMER',
      userId: customerPublicId
    });
    await Promise.all([customerJoined, providerJoined]);

    const outsiderSocket = await connectSocket(baseUrl, outsiderAuth.cookie);
    sockets.push(outsiderSocket);
    const unauthorizedJoin = waitForSocketEvent(outsiderSocket, 'message_error');
    outsiderSocket.emit('join_conversation', {
      conversationId,
      userType: 'PROVIDER',
      userId: providerPublicId
    });
    assert.match((await unauthorizedJoin).message, /not a participant/);

    const providerReceivesMessage = waitForSocketEvent(providerSocket, 'new_message');
    customerSocket.emit('send_message', {
      conversationId,
      senderType: 'PROVIDER',
      senderId: providerPublicId,
      message: 'Customer realtime message'
    });
    const customerMessage = await providerReceivesMessage;
    assert.equal(customerMessage.sender_type, 'CUSTOMER');
    assert.equal(customerMessage.sender_id, customerPublicId);
    const persistedCustomerMessage = await db.query(
      `SELECT count(*)::int AS count
       FROM messages m JOIN conversations c ON c.id = m.conversation_id
       WHERE c.public_id = $1 AND m.public_id = $2`,
      [conversationId, customerMessage.id]
    );
    assert.equal(persistedCustomerMessage.rows[0].count, 1);

    const customerReceivesMessage = waitForSocketEvent(customerSocket, 'new_message');
    providerSocket.emit('send_message', {
      conversationId,
      senderType: 'CUSTOMER',
      senderId: customerPublicId,
      message: 'Provider realtime message'
    });
    const providerMessage = await customerReceivesMessage;
    assert.equal(providerMessage.sender_type, 'PROVIDER');
    assert.equal(providerMessage.sender_id, providerPublicId);

    customerSocket.disconnect();
    sockets.splice(sockets.indexOf(customerSocket), 1);
    const reconnectSocket = await connectSocket(baseUrl, customerCookie);
    sockets.push(reconnectSocket);
    const rejoined = waitForSocketEvent(reconnectSocket, 'conversation_joined');
    reconnectSocket.emit('join_conversation', { conversationId });
    await rejoined;

    const messagesBeforeReadResponse = await fetch(
      `${baseUrl}/api/messages/conversations/${conversationId}/messages?userType=PROVIDER&userId=${providerPublicId}`,
      { headers: { Cookie: customerCookie } }
    );
    assert.equal(messagesBeforeReadResponse.status, 200);
    const messagesBeforeRead = await messagesBeforeReadResponse.json();
    assert.equal(messagesBeforeRead.messages.length, 3);
    assert(!JSON.stringify(messagesBeforeRead).includes(customerUserId));
    assert(!JSON.stringify(messagesBeforeRead).includes(providerUserId));

    const customerReadResponse = await fetch(
      `${baseUrl}/api/messages/conversations/${conversationId}/read`,
      {
        method: 'POST',
        headers: jsonHeaders(customerCookie),
        body: JSON.stringify({ userType: 'CUSTOMER', userId: customerPublicId })
      }
    );
    assert.equal(customerReadResponse.status, 200);
    const messagesAfterRead = await fetch(
      `${baseUrl}/api/messages/conversations/${conversationId}/messages`,
      { headers: { Cookie: customerCookie } }
    ).then(response => response.json());
    assert(messagesAfterRead.messages
      .filter(message => message.sender_type === 'PROVIDER')
      .every(message => message.read));

    const sentResponse = await fetch(
      `${baseUrl}/api/messages/conversations/${conversationId}/messages`,
      {
        method: 'POST',
        headers: jsonHeaders(providerCookie),
        body: JSON.stringify({
          senderType: 'CUSTOMER',
          senderId: customerPublicId,
          message: 'Provider API reply'
        })
      }
    );
    assert.equal(sentResponse.status, 201);
    assert.equal((await sentResponse.json()).message.sender_type, 'PROVIDER');

    const unreadListResponse = await fetch(
      `${baseUrl}/api/messages/conversations/customer/${customerPublicId}`,
      { headers: { Cookie: customerCookie } }
    );
    const unreadList = await unreadListResponse.json();
    assert.equal(unreadListResponse.status, 200);
    assert.equal(unreadList.conversations[0].unread_count, 1);

    const providerDashboard = await fetch(
      `${baseUrl}/api/providers/${providerPublicId}/dashboard`,
      { headers: { Cookie: providerCookie } }
    );
    assert.equal(providerDashboard.status, 200);
    assert.equal(
      (await fetch(`${baseUrl}/api/providers/QF-PROV-999999/dashboard`, {
        headers: { Cookie: providerCookie }
      })).status,
      403
    );
    const availabilityResponse = await fetch(
      `${baseUrl}/api/providers/${providerPublicId}/availability`,
      {
        method: 'PATCH',
        headers: jsonHeaders(providerCookie),
        body: JSON.stringify({ availability: 'BUSY' })
      }
    );
    assert.equal(availabilityResponse.status, 200);
    assert.equal((await availabilityResponse.json()).provider.availability, 'BUSY');

    await db.query(
      `UPDATE provider_profiles SET verification_status = 'SUSPENDED'
       WHERE user_id = $1`,
      [providerUserId]
    );
    assert.equal(
      (await fetch(
        `${baseUrl}/api/providers/${providerPublicId}/dashboard`,
        { headers: { Cookie: providerCookie } }
      )).status,
      401
    );
    await db.query(
      `UPDATE provider_profiles SET verification_status = 'VERIFIED'
       WHERE user_id = $1`,
      [providerUserId]
    );

    const invalidOtpMobile = createMobile();
    testMobiles.add(invalidOtpMobile);
    const invalidRequest = await postJson(`${baseUrl}/api/auth/request-otp`, {
      mobile: invalidOtpMobile,
      role: 'customer'
    });
    const invalidRequestData = await invalidRequest.json();
    assert.equal(invalidRequest.status, 202);
    assert.match(invalidRequestData.developmentOtp, /^\d{6}$/);
    const invalidCode = invalidRequestData.developmentOtp === '000000' ? '999999' : '000000';
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const invalid = await postJson(`${baseUrl}/api/auth/verify-otp`, {
        mobile: invalidOtpMobile,
        role: 'customer',
        fullName: 'Invalid OTP Test',
        otp: invalidCode
      });
      assert([400, 429].includes(invalid.status));
      if (attempt < 4) assert.equal(invalid.status, 400);
      else assert.equal(invalid.status, 429);
    }
    const challengeAfterLimit = await db.query(
      `SELECT consumed_at, attempts FROM otp_challenges
       WHERE mobile_e164 = $1 AND role = 'CUSTOMER'
       ORDER BY created_at DESC LIMIT 1`,
      [`+91${invalidOtpMobile}`]
    );
    assert.equal(challengeAfterLimit.rows[0].attempts, 5);
    assert(challengeAfterLimit.rows[0].consumed_at);

    const expiredMobile = createMobile();
    testMobiles.add(expiredMobile);
    assert.equal(
      (await postJson(`${baseUrl}/api/auth/request-otp`, {
        mobile: expiredMobile,
        role: 'customer'
      })).status,
      202
    );
    await db.query(
      `UPDATE otp_challenges SET expires_at = now() - interval '1 minute'
       WHERE mobile_e164 = $1 AND role = 'CUSTOMER' AND consumed_at IS NULL`,
      [`+91${expiredMobile}`]
    );
    assert.equal(
      (await postJson(`${baseUrl}/api/auth/verify-otp`, {
        mobile: expiredMobile,
        role: 'customer',
        fullName: 'Expired OTP Test',
        otp: '123456'
      })).status,
      400
    );

    const cooldownMobile = createMobile();
    testMobiles.add(cooldownMobile);
    assert.equal(
      (await postJson(`${baseUrl}/api/auth/request-otp`, {
        mobile: cooldownMobile,
        role: 'customer'
      })).status,
      202
    );
    const cooldown = await postJson(`${baseUrl}/api/auth/request-otp`, {
      mobile: cooldownMobile,
      role: 'customer'
    });
    assert.equal(cooldown.status, 429);
    assert(Number(cooldown.headers.get('retry-after')) > 0);

    const invalidSession = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Cookie: 'qf_session=not-a-valid-random-session-token-value' }
    });
    assert.equal(invalidSession.status, 401);
    const expiredSessionToken = crypto.randomBytes(32).toString('base64url');
    await db.query(
      `INSERT INTO auth_sessions (id, user_id, token_hash, role, expires_at)
       VALUES ($1, $2, $3, 'CUSTOMER', now() - interval '1 minute')`,
      [crypto.randomUUID(), customerUserId, hashSessionToken(expiredSessionToken)]
    );
    assert.equal(
      (await fetch(`${baseUrl}/api/auth/me`, {
        headers: { Cookie: `qf_session=${expiredSessionToken}` }
      })).status,
      401
    );

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

    await assert.rejects(
      db.query('INSERT INTO customer_profiles (user_id) VALUES ($1)', [crypto.randomUUID()]),
      error => error.code === '23503'
    );
    await assert.rejects(
      db.query(
        'INSERT INTO users (id, mobile_e164, full_name) VALUES ($1, $2, $3)',
        [crypto.randomUUID(), `+91${customerMobile}`, 'Duplicate']
      ),
      error => error.code === '23505'
    );

    const customerSocketDisconnect = waitForSocketEvent(reconnectSocket, 'disconnect');
    const logout = await fetch(`${baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: jsonHeaders(customerCookie)
    });
    assert.equal(logout.status, 200);
    await customerSocketDisconnect;
    assert.equal(
      (await fetch(`${baseUrl}/api/auth/me`, {
        headers: { Cookie: customerCookie }
      })).status,
      401
    );
    console.log('PostgreSQL authentication, API, Socket.IO and constraint checks passed.');
  } catch (error) {
    console.error(error.stack || error);
    if (serverOutput) console.error(serverOutput);
    process.exitCode = 1;
  } finally {
    sockets.forEach(socket => socket.disconnect());
    try {
      for (const mobile of testMobiles) {
        await db.query('DELETE FROM otp_challenges WHERE mobile_e164 = $1', [`+91${mobile}`]);
      }
      for (const userId of userIds) {
        await db.query('DELETE FROM bookings WHERE customer_id = $1 OR provider_id = $1', [userId]);
        await db.query(
          'DELETE FROM conversations WHERE customer_id = $1 OR provider_id = $1',
          [userId]
        );
        await db.query('DELETE FROM users WHERE id = $1', [userId]);
      }
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
