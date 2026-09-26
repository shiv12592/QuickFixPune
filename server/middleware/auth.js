const { hashSessionToken } = require('../auth/crypto');
const { pool } = require('../db/pool');
const { readCookie } = require('../auth/cookie');

function publicIdentity(row) {
  const publicId = row.role === 'CUSTOMER' ? row.customer_public_id : row.provider_public_id;
  if (!publicId) return null;
  return {
    id: publicId,
    public_id: publicId,
    role: row.role,
    name: String(row.full_name || '').trim().split(/\s+/)[0] || '',
    ...(row.role === 'PROVIDER'
      ? { verification_status: row.verification_status }
      : {})
  };
}

async function findActiveSession(database, token) {
  if (!token || !/^[A-Za-z0-9_-]{40,50}$/.test(token)) return null;
  const result = await database.query(
    `SELECT s.id AS session_id, s.user_id, s.role, s.expires_at,
       u.full_name, cp.public_id AS customer_public_id,
       pp.public_id AS provider_public_id,
       pp.verification_status
     FROM auth_sessions s
     JOIN users u ON u.id = s.user_id
     LEFT JOIN customer_profiles cp ON cp.user_id = s.user_id
     LEFT JOIN provider_profiles pp ON pp.user_id = s.user_id
     WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
       AND (s.role <> 'PROVIDER' OR pp.verification_status <> 'SUSPENDED')`,
    [hashSessionToken(token)]
  );
  const row = result.rows[0];
  const identity = row && publicIdentity(row);
  if (!row || !identity) return null;
  return {
    sessionId: row.session_id,
    userId: row.user_id,
    role: row.role,
    publicId: identity.id,
    fullName: row.full_name,
    displayName: identity.name,
    verificationStatus: row.verification_status || null,
    expiresAt: row.expires_at,
    identity
  };
}

function createAuthMiddleware(database = pool) {
  async function requireAuth(req, res, next) {
    res.set('Cache-Control', 'no-store');
    try {
      const token = readCookie(req.headers.cookie, 'qf_session');
      const session = await findActiveSession(database, token);
      if (!session) {
        return res.status(401).json({
          success: false,
          code: 'AUTH_REQUIRED',
          message: 'Sign in to continue'
        });
      }
      req.auth = session;
      return next();
    } catch (error) {
      return next(error);
    }
  }

  function requireOperationalAuth(req, res, next) {
    if (
      req.auth.role === 'PROVIDER' &&
      req.auth.verificationStatus !== 'VERIFIED'
    ) {
      return res.status(403).json({
        success: false,
        code: 'PROVIDER_NOT_VERIFIED',
        message: 'Provider access is unavailable until verification is complete'
      });
    }
    return next();
  }

  function requireRole(role) {
    return (req, res, next) => {
      if (!req.auth || req.auth.role !== role) {
        return res.status(403).json({
          success: false,
          code: 'ROLE_REQUIRED',
          message: 'This account cannot access this feature'
        });
      }
      if (role === 'PROVIDER' && req.auth.verificationStatus !== 'VERIFIED') {
        return res.status(403).json({
          success: false,
          code: 'PROVIDER_NOT_VERIFIED',
          message: 'Provider access is unavailable until verification is complete'
        });
      }
      return next();
    };
  }

  return {
    requireAuth,
    requireOperationalAuth,
    requireCustomer: [requireAuth, requireRole('CUSTOMER')],
    requireProvider: [requireAuth, requireRole('PROVIDER')]
  };
}

const middleware = createAuthMiddleware();

module.exports = {
  readCookie,
  publicIdentity,
  findActiveSession,
  createAuthMiddleware,
  requireOperationalAuth: middleware.requireOperationalAuth,
  ...middleware
};
