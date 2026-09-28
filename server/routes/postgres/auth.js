const express = require('express');
const crypto = require('crypto');
const { pool, normalizeMobile, withTransaction } = require('../../db/pool');
const {
  createOtp,
  hashOtp,
  hashRateLimitKey,
  hashSessionToken,
  createSessionToken,
  getSessionSecret,
  verifyOtpHash
} = require('../../auth/crypto');
const { consumeRateLimit } = require('../../auth/rate-limit');
const { getOtpProvider } = require('../../services/otp');
const msg91 = require('../../services/otp/msg91');
const { readCookie, findActiveSession, publicIdentity } = require('../../middleware/auth');
const { sessionCookie } = require('../../auth/cookie');

const router = express.Router();
const OTP_TTL_MINUTES = 5;
const OTP_RESEND_COOLDOWN_SECONDS = 60;
const OTP_MAX_ATTEMPTS = 5;
const SESSION_TTL_DAYS = 7;

router.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

function validRole(value) {
  const role = String(value || '').toUpperCase();
  return role === 'CUSTOMER' || role === 'PROVIDER' ? role : null;
}

function genericOtpResponse(res, developmentOtp) {
  const response = {
    success: true,
    message: 'If the account is eligible, an OTP has been sent.',
    expiresInSeconds: OTP_TTL_MINUTES * 60,
    resendAfterSeconds: OTP_RESEND_COOLDOWN_SECONDS
  };
  if (developmentOtp !== undefined && developmentOtp !== null) {
    response.developmentOtp = developmentOtp;
  }
  return res.status(202).json(response);
}

async function canSendToAccount(client, mobile, role) {
  const result = await client.query(
    `SELECT pp.verification_status
     FROM users u
     LEFT JOIN provider_profiles pp ON pp.user_id = u.id
     WHERE u.mobile_e164 = $1`,
    [mobile]
  );
  if (role === 'CUSTOMER') return { allowed: true };
  const verificationStatus = result.rows[0]?.verification_status;
  return {
    allowed: Boolean(verificationStatus && verificationStatus !== 'SUSPENDED')
  };
}

router.post('/request-otp', async (req, res, next) => {
  const mobile = normalizeMobile(req.body.mobile);
  const role = validRole(req.body.role);
  if (!mobile || !/^\+91[6-9]\d{9}$/.test(mobile) || !role) {
    return res.status(400).json({
      success: false,
      message: 'Enter a valid Indian mobile number and account type'
    });
  }

  let secret;
  let provider;
  try {
    secret = getSessionSecret();
    provider = getOtpProvider();
  } catch (error) {
    return res.status(503).json({ success: false, message: error.message });
  }

  const ipHash = hashRateLimitKey(req.ip || 'unknown', secret);
  const challengeId = crypto.randomUUID();
  const otp = provider.providerManaged ? null : createOtp();
  let challenge;

  try {
    challenge = await withTransaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [ipHash]);
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [
        mobile,
        role
      ]);

      const counts = await client.query(
        `SELECT
           count(*) FILTER (
             WHERE mobile_e164 = $1 AND created_at > now() - interval '1 hour'
           )::int AS mobile_count,
           count(*) FILTER (
             WHERE request_ip_hash = $2 AND created_at > now() - interval '1 hour'
           )::int AS ip_count,
           max(created_at) FILTER (WHERE mobile_e164 = $1) AS last_mobile_request
         FROM otp_challenges
         WHERE (mobile_e164 = $1 OR request_ip_hash = $2)
           AND created_at > now() - interval '1 hour'`,
        [mobile, ipHash]
      );
      const { mobile_count: mobileCount, ip_count: ipCount, last_mobile_request: lastRequest } =
        counts.rows[0];
      const retryAfter = lastRequest
        ? Math.ceil(
          (new Date(lastRequest).getTime() + OTP_RESEND_COOLDOWN_SECONDS * 1000 - Date.now()) / 1000
        )
        : 0;
      if (retryAfter > 0 || mobileCount >= 5 || ipCount >= 20) {
        const error = new Error('Too many OTP requests. Please wait before trying again.');
        error.status = 429;
        error.retryAfter = Math.max(retryAfter, mobileCount >= 5 || ipCount >= 20 ? 3600 : 1);
        throw error;
      }

      const account = await canSendToAccount(client, mobile, role);
      await client.query(
        `UPDATE otp_challenges
         SET consumed_at = now(), updated_at = now()
         WHERE mobile_e164 = $1 AND role = $2 AND consumed_at IS NULL`,
        [mobile, role]
      );
      if (!account.allowed) {
        await client.query(
          `INSERT INTO otp_challenges
             (id, mobile_e164, otp_hash, expires_at, role, provider, request_ip_hash, consumed_at)
           VALUES ($1, $2, NULL, now() + interval '5 minutes', $3, $4, $5, now())`,
          [challengeId, mobile, role, provider.name, ipHash]
        );
        return { eligible: false };
      }

      const result = await client.query(
        `INSERT INTO otp_challenges
           (id, mobile_e164, otp_hash, expires_at, role, provider, request_ip_hash)
         VALUES ($1, $2, $3, now() + interval '5 minutes', $4, $5, $6)
         RETURNING id`,
        [
          challengeId,
          mobile,
          otp ? hashOtp(challengeId, otp, secret) : null,
          role,
          provider.name,
          ipHash
        ]
      );
      return { eligible: true, id: result.rows[0].id };
    });

    if (!challenge.eligible) return genericOtpResponse(res);
    let providerRequestId;
    try {
      providerRequestId = await provider.sendOtp(mobile, otp);
    } catch {
      await pool.query(
        'UPDATE otp_challenges SET consumed_at = now(), updated_at = now() WHERE id = $1',
        [challenge.id]
      );
      console.error('[Auth] OTP provider delivery failed');
      return res.status(502).json({
        success: false,
        message: 'OTP delivery is temporarily unavailable'
      });
    }
    if (providerRequestId) {
      await pool.query(
        'UPDATE otp_challenges SET provider_request_id = $2 WHERE id = $1',
        [challenge.id, providerRequestId]
      );
    }
    return genericOtpResponse(
      res,
      provider.name === 'development' ? otp : undefined
    );
  } catch (error) {
    if (error.status === 429) res.set('Retry-After', String(error.retryAfter || 60));
    return next(error);
  }
});

router.post('/verify-otp', async (req, res, next) => {
  const mobile = normalizeMobile(req.body.mobile);
  const role = validRole(req.body.role);
  const otp = String(req.body.otp || '');
  const fullName = String(req.body.fullName || '').trim();
  if (!mobile || !/^\+91[6-9]\d{9}$/.test(mobile) || !role || !/^\d{6}$/.test(otp)) {
    return res.status(400).json({
      success: false,
      message: 'Enter a valid mobile number, account type and 6-digit code'
    });
  }
  if (fullName.length > 100) {
    return res.status(400).json({ success: false, message: 'Name cannot exceed 100 characters' });
  }

  try {
    const secret = getSessionSecret();
    const ipKey = hashRateLimitKey(req.ip || 'unknown', secret);
    const ipLimit = consumeRateLimit(ipKey, { limit: 20, windowMs: 15 * 60 * 1000 });
    if (!ipLimit.allowed) {
      res.set('Retry-After', String(ipLimit.retryAfterSeconds));
      return res.status(429).json({ success: false, message: 'Too many verification attempts' });
    }

    const result = await withTransaction(async client => {
      const challengeResult = await client.query(
        `SELECT id, otp_hash, expires_at, attempts, provider
         FROM otp_challenges
         WHERE mobile_e164 = $1 AND role = $2 AND consumed_at IS NULL
         ORDER BY created_at DESC
         LIMIT 1
         FOR UPDATE`,
        [mobile, role]
      );
      const current = challengeResult.rows[0];
      if (!current) {
        return { error: 'No active OTP was found. Request a new code.', status: 400 };
      }
      if (new Date(current.expires_at).getTime() <= Date.now()) {
        await client.query(
          'UPDATE otp_challenges SET consumed_at = now(), updated_at = now() WHERE id = $1',
          [current.id]
        );
        return { error: 'This OTP has expired. Request a new code.', status: 400 };
      }
      if (current.attempts >= OTP_MAX_ATTEMPTS) {
        await client.query(
          'UPDATE otp_challenges SET consumed_at = now(), updated_at = now() WHERE id = $1',
          [current.id]
        );
        return { error: 'Too many incorrect attempts. Request a new code.', status: 429 };
      }
      if (current.provider !== process.env.OTP_PROVIDER) {
        await client.query(
          'UPDATE otp_challenges SET consumed_at = now(), updated_at = now() WHERE id = $1',
          [current.id]
        );
        return { error: 'OTP configuration changed. Request a new code.', status: 503 };
      }
      const isDevelopment = current.provider === 'development';
      if (
        !isDevelopment &&
        !['msg91', 'fast2sms'].includes(current.provider)
      ) {
        return { error: 'OTP configuration changed. Request a new code.', status: 503 };
      }
      if (
        isDevelopment &&
        (process.env.NODE_ENV === 'production' || process.env.DEV_OTP_ENABLED !== 'true')
      ) {
        return { error: 'Development OTP is disabled. Request a new code.', status: 503 };
      }

      const accountResult = await client.query(
        `SELECT u.id, u.full_name, pp.verification_status
         FROM users u
         LEFT JOIN provider_profiles pp ON pp.user_id = u.id
         WHERE u.mobile_e164 = $1
         FOR UPDATE OF u`,
        [mobile]
      );
      let account = accountResult.rows[0] || null;
      if (role === 'PROVIDER' && (!account || !account.verification_status)) {
        await client.query(
          'UPDATE otp_challenges SET consumed_at = now(), updated_at = now() WHERE id = $1',
          [current.id]
        );
        return { error: 'This provider account is not available for sign-in.', status: 403 };
      }
      if (role === 'PROVIDER' && account.verification_status === 'SUSPENDED') {
        await client.query(
          'UPDATE otp_challenges SET consumed_at = now(), updated_at = now() WHERE id = $1',
          [current.id]
        );
        return { error: 'This provider account is not available for sign-in.', status: 403 };
      }
      const valid = current.provider === 'msg91'
        ? await msg91.verifyOtp(mobile, otp)
        : verifyOtpHash(current.id, otp, current.otp_hash, secret);
      if (!valid) {
        const attempts = current.attempts + 1;
        await client.query(
          `UPDATE otp_challenges
           SET attempts = $2::smallint, consumed_at = CASE WHEN $2::smallint >= $3::smallint THEN now() ELSE consumed_at END,
               updated_at = now()
           WHERE id = $1`,
          [current.id, attempts, OTP_MAX_ATTEMPTS]
        );
        return {
          error: attempts >= OTP_MAX_ATTEMPTS
            ? 'Too many incorrect attempts. Request a new code.'
            : 'The OTP is incorrect.',
          status: attempts >= OTP_MAX_ATTEMPTS ? 429 : 400
        };
      }

      if (role === 'CUSTOMER' && !account && !fullName) {
        return {
          error: 'Enter your full name to finish creating your customer account.',
          status: 400
        };
      }

      if (!account) {
        const inserted = await client.query(
          `INSERT INTO users (id, mobile_e164, full_name)
           VALUES ($1, $2, $3)
           RETURNING id, full_name`,
          [crypto.randomUUID(), mobile, fullName]
        );
        account = inserted.rows[0];
      }
      if (role === 'CUSTOMER') {
        await client.query(
          'INSERT INTO customer_profiles (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING',
          [account.id]
        );
      }

      const identityResult = await client.query(
        `SELECT u.id, u.full_name, cp.public_id AS customer_public_id,
           pp.public_id AS provider_public_id, pp.verification_status
         FROM users u
         LEFT JOIN customer_profiles cp ON cp.user_id = u.id
         LEFT JOIN provider_profiles pp ON pp.user_id = u.id
         WHERE u.id = $1`,
        [account.id]
      );
      const identityRow = { ...identityResult.rows[0], role };
      const identity = publicIdentity(identityRow);
      if (!identity) {
        return { error: 'The requested account profile is unavailable.', status: 403 };
      }

      const sessionToken = createSessionToken();
      const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
      await client.query(
        `INSERT INTO auth_sessions (id, user_id, token_hash, role, expires_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          crypto.randomUUID(),
          account.id,
          hashSessionToken(sessionToken),
          role,
          expiresAt
        ]
      );
      await client.query(
        'UPDATE otp_challenges SET consumed_at = now(), updated_at = now() WHERE id = $1',
        [current.id]
      );
      return {
        identity,
        sessionToken,
        expiresAt,
        sessionTtlSeconds: SESSION_TTL_DAYS * 24 * 60 * 60
      };
    });

    if (result.error) {
      return res.status(result.status || 400).json({
        success: false,
        message: result.error
      });
    }
    res.set(
      'Set-Cookie',
      sessionCookie(
        result.sessionToken,
        result.sessionTtlSeconds,
        process.env.NODE_ENV === 'production'
      )
    );
    return res.json({
      success: true,
      user: result.identity,
      expiresAt: result.expiresAt
    });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ success: false, message: 'Unable to complete sign-in' });
    }
    return next(error);
  }
});

router.get('/me', async (req, res, next) => {
  try {
    const session = await findActiveSession(pool, readCookie(req.headers.cookie, 'qf_session'));
    if (!session) {
      return res.status(401).json({
        success: false,
        code: 'AUTH_REQUIRED',
        message: 'Sign in to continue'
      });
    }
    return res.json({ success: true, user: session.identity, expiresAt: session.expiresAt });
  } catch (error) {
    return next(error);
  }
});

router.post('/logout', async (req, res, next) => {
  const token = readCookie(req.headers.cookie, 'qf_session');
  try {
    if (token) {
      const hash = hashSessionToken(token);
      const revoked = await pool.query(
        `UPDATE auth_sessions SET revoked_at = now(), updated_at = now()
         WHERE token_hash = $1 AND revoked_at IS NULL
         RETURNING id`,
        [hash]
      );
      if (req.app.locals.io && revoked.rowCount) {
        req.app.locals.io.in(`session:${revoked.rows[0].id}`).disconnectSockets(true);
      }
    }
    res.set('Set-Cookie', sessionCookie('', 0, process.env.NODE_ENV === 'production'));
    return res.json({ success: true, message: 'Signed out' });
  } catch (error) {
    return next(error);
  }
});

module.exports = {
  router,
  OTP_TTL_MINUTES,
  OTP_RESEND_COOLDOWN_SECONDS,
  OTP_MAX_ATTEMPTS,
  SESSION_TTL_DAYS,
  validRole
};
