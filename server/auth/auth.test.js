const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createOtp,
  hashOtp,
  verifyOtpHash,
  hashSessionToken,
  createSessionToken,
  getSessionSecret
} = require('./crypto');
const { readCookie, sessionCookie } = require('./cookie');
const { consumeRateLimit, pruneRateLimits } = require('./rate-limit');
const { getOtpProvider, validateProductionAuthConfig } = require('../services/otp');

test('OTP hashes are challenge-bound and verify without storing a plaintext code', () => {
  const secret = 'test-only-session-secret-that-is-long-enough';
  const otp = createOtp();
  const digest = hashOtp('challenge-1', otp, secret);

  assert.match(otp, /^\d{6}$/);
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert(verifyOtpHash('challenge-1', otp, digest, secret));
  assert.equal(verifyOtpHash('challenge-2', otp, digest, secret), false);
  assert.equal(verifyOtpHash('challenge-1', 'not-an-otp', digest, secret), false);
});

test('session tokens are random opaque values and database hashes are one-way', () => {
  const first = createSessionToken();
  const second = createSessionToken();

  assert.match(first, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first, second);
  assert.match(hashSessionToken(first), /^[a-f0-9]{64}$/);
  assert.notEqual(hashSessionToken(first), first);
});

test('session cookies are HttpOnly, same-site and secure only in production', () => {
  const productionCookie = sessionCookie('opaque-token', 604800, true);
  const localCookie = sessionCookie('opaque-token', 604800, false);
  assert.match(productionCookie, /HttpOnly/);
  assert.match(productionCookie, /Secure/);
  assert.match(productionCookie, /SameSite=Lax/);
  assert.match(productionCookie, /Path=\//);
  assert.match(productionCookie, /Max-Age=604800/);
  assert.doesNotMatch(localCookie, /Secure/);
  assert.equal(
    readCookie(`other=x; qf_session=${encodeURIComponent('opaque-token')}`, 'qf_session'),
    'opaque-token'
  );
  assert.equal(readCookie('qf_session=%ZZ', 'qf_session'), null);
});

test('session secret must have sufficient entropy length', () => {
  assert.equal(
    getSessionSecret({ SESSION_SECRET: 'x'.repeat(32) }),
    'x'.repeat(32)
  );
  assert.throws(
    () => getSessionSecret({ SESSION_SECRET: 'short' }),
    /at least 32 bytes/
  );
});

test('OTP development provider requires explicit non-production opt-in', async () => {
  assert.throws(
    () => getOtpProvider({ OTP_PROVIDER: 'development', NODE_ENV: 'development' }),
    /supported OTP_PROVIDER/
  );
  assert.throws(
    () => getOtpProvider({
      OTP_PROVIDER: 'development',
      NODE_ENV: 'production',
      DEV_OTP_ENABLED: 'true'
    }),
    /supported OTP_PROVIDER/
  );
  const provider = getOtpProvider({
    OTP_PROVIDER: 'development',
    NODE_ENV: 'test',
    DEV_OTP_ENABLED: 'true'
  });
  assert.equal(provider.name, 'development');
  assert.equal(provider.providerManaged, false);
  assert.equal(await provider.sendOtp('+919876543210', '123456'), '');
});

test('production configuration requires PostgreSQL, HTTPS, a real provider and strong secret', () => {
  assert.throws(
    () => validateProductionAuthConfig({
      NODE_ENV: 'production',
      OTP_PROVIDER: 'development',
      DATABASE_URL: 'postgresql://placeholder',
      APP_BASE_URL: 'https://quickfix.example',
      SESSION_SECRET: 'x'.repeat(48)
    }),
    /OTP_PROVIDER must be msg91 or fast2sms/
  );
  assert.throws(
    () => validateProductionAuthConfig({
      NODE_ENV: 'production',
      OTP_PROVIDER: 'msg91',
      DATABASE_URL: 'postgresql://placeholder',
      APP_BASE_URL: 'http://localhost:3000',
      SESSION_SECRET: 'x'.repeat(48),
      MSG91_AUTH_KEY: 'placeholder',
      MSG91_TEMPLATE_ID: 'placeholder'
    }),
    /HTTPS origin/
  );
  assert.throws(
    () => validateProductionAuthConfig({
      NODE_ENV: 'production',
      OTP_PROVIDER: 'msg91',
      DATABASE_URL: 'postgresql://placeholder',
      APP_BASE_URL: 'https://quickfix.example',
      SESSION_SECRET: 'too-short'
    }),
    /SESSION_SECRET/
  );
  assert.doesNotThrow(() => validateProductionAuthConfig({ NODE_ENV: 'test' }));
});

test('Fast2SMS sends the generated OTP through its configured template', async () => {
  const originalFetch = global.fetch;
  let request;
  global.fetch = async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ return: true, request_id: 'request-123' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };
  try {
    const provider = require('../services/otp/fast2sms');
    const requestId = await provider.sendOtp('+919876543210', '123456', {
      FAST2SMS_API_KEY: 'test-provider-key',
      FAST2SMS_OTP_ID: 'test-template'
    });
    assert.equal(requestId, 'request-123');
    assert.equal(request.url, 'https://www.fast2sms.com/dev/otp/send');
    assert.equal(request.options.headers.Authorization, 'test-provider-key');
    assert.equal(JSON.parse(request.options.body).mobile, '9876543210');
    assert.equal(JSON.parse(request.options.body).otp, '123456');
  } finally {
    global.fetch = originalFetch;
  }
});

test('MSG91 uses its OTP template send and verify endpoints', async () => {
  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    return new Response(JSON.stringify({ type: 'success', request_id: 'msg91-123' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };
  try {
    const provider = require('../services/otp/msg91');
    const env = {
      MSG91_AUTH_KEY: 'test-provider-key',
      MSG91_TEMPLATE_ID: 'test-template'
    };
    assert.equal(await provider.sendOtp('+919876543210', null, env), 'msg91-123');
    assert.equal(await provider.verifyOtp('+919876543210', '123456', env), true);
    assert(requests[0].url.startsWith('https://control.msg91.com/api/v5/otp?'));
    assert(requests[0].url.includes('mobile=919876543210'));
    assert(requests[1].url.startsWith('https://control.msg91.com/api/v5/otp/verify?'));
    assert.equal(requests[0].options.headers.authkey, 'test-provider-key');
  } finally {
    global.fetch = originalFetch;
  }
});

test('OTP verification limiter rejects excess attempts and expires old buckets', () => {
  const key = `auth-limit-test-${Date.now()}`;
  assert.deepEqual(
    consumeRateLimit(key, { limit: 2, windowMs: 1000, now: 1000 }),
    { allowed: true, retryAfterSeconds: 0 }
  );
  assert.equal(consumeRateLimit(key, { limit: 2, windowMs: 1000, now: 1001 }).allowed, true);
  assert.deepEqual(
    consumeRateLimit(key, { limit: 2, windowMs: 1000, now: 1002 }),
    { allowed: false, retryAfterSeconds: 1 }
  );
  assert.equal(consumeRateLimit(key, { limit: 2, windowMs: 1000, now: 2000 }).allowed, true);
  pruneRateLimits(100000);
});
