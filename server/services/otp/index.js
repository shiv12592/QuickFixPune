const fast2sms = require('./fast2sms');
const msg91 = require('./msg91');
const { getSessionSecret } = require('../../auth/crypto');

function getOtpProvider(env = process.env) {
  if (env.OTP_PROVIDER === 'msg91') {
    return {
      name: 'msg91',
      providerManaged: true,
      sendOtp: msg91.sendOtp,
      verifyOtp: msg91.verifyOtp
    };
  }
  if (env.OTP_PROVIDER === 'fast2sms') {
    return {
      name: 'fast2sms',
      providerManaged: false,
      sendOtp: fast2sms.sendOtp,
      verifyOtp: null
    };
  }
  if (
    env.OTP_PROVIDER === 'development' &&
    env.NODE_ENV !== 'production' &&
    env.DEV_OTP_ENABLED === 'true'
  ) {
    return {
      name: 'development',
      providerManaged: false,
      sendOtp: async () => '',
      verifyOtp: null
    };
  }
  throw new Error('Configure a supported OTP_PROVIDER before requesting OTP');
}

function validateProductionAuthConfig(env = process.env) {
  if (env.NODE_ENV !== 'production') return;
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required in production');
  const baseUrl = env.APP_BASE_URL ? new URL(env.APP_BASE_URL) : null;
  if (
    !baseUrl ||
    baseUrl.protocol !== 'https:' ||
    baseUrl.pathname !== '/' ||
    baseUrl.search ||
    baseUrl.hash
  ) {
    throw new Error('APP_BASE_URL must be a valid HTTPS origin in production');
  }
  getSessionSecret(env);
  if (!['msg91', 'fast2sms'].includes(env.OTP_PROVIDER)) {
    throw new Error('OTP_PROVIDER must be msg91 or fast2sms in production');
  }
  if (env.OTP_PROVIDER === 'msg91' && (!env.MSG91_AUTH_KEY || !env.MSG91_TEMPLATE_ID)) {
    throw new Error('MSG91_AUTH_KEY and MSG91_TEMPLATE_ID are required');
  }
  if (
    env.OTP_PROVIDER === 'fast2sms' &&
    (!env.FAST2SMS_API_KEY || !env.FAST2SMS_OTP_ID)
  ) {
    throw new Error('FAST2SMS_API_KEY and FAST2SMS_OTP_ID are required');
  }
}

module.exports = { getOtpProvider, validateProductionAuthConfig };
