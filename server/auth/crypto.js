const crypto = require('crypto');

function createOtp() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

function hashOtp(challengeId, otp, secret) {
  return crypto.createHmac('sha256', secret)
    .update(`${challengeId}:${otp}`)
    .digest('hex');
}

function verifyOtpHash(challengeId, otp, expectedHash, secret) {
  if (!expectedHash || !/^\d{6}$/.test(String(otp || ''))) return false;
  const expected = Buffer.from(expectedHash, 'hex');
  const actual = Buffer.from(hashOtp(challengeId, otp, secret), 'hex');
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function hashSessionToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function hashRateLimitKey(value, secret) {
  return crypto.createHmac('sha256', secret)
    .update(`rate-limit:${value}`)
    .digest('hex');
}

function createSessionToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function getSessionSecret(env = process.env) {
  const secret = env.SESSION_SECRET;
  if (typeof secret !== 'string' || Buffer.byteLength(secret) < 32) {
    throw new Error('SESSION_SECRET must be at least 32 bytes');
  }
  return secret;
}

module.exports = {
  createOtp,
  hashOtp,
  verifyOtpHash,
  hashSessionToken,
  hashRateLimitKey,
  createSessionToken,
  getSessionSecret
};
