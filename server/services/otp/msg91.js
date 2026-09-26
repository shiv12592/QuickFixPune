const { readJsonResponse, assertProviderAccepted } = require('./response');

async function sendOtp(mobile, _otp, env = process.env) {
  if (!env.MSG91_AUTH_KEY || !env.MSG91_TEMPLATE_ID) {
    throw new Error('MSG91 OTP configuration is incomplete');
  }
  const query = new URLSearchParams({
    template_id: env.MSG91_TEMPLATE_ID,
    mobile: mobile.slice(1),
    otp_length: '6',
    otp_expiry: '5'
  });
  const response = await fetch(`https://control.msg91.com/api/v5/otp?${query}`, {
    method: 'POST',
    headers: {
      authkey: env.MSG91_AUTH_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({}),
    signal: AbortSignal.timeout(10000)
  });
  const body = await readJsonResponse(response);
  assertProviderAccepted(response, body);
  return String(body.request_id || '');
}

async function verifyOtp(mobile, otp, env = process.env) {
  if (!env.MSG91_AUTH_KEY) throw new Error('MSG91 OTP configuration is incomplete');
  const query = new URLSearchParams({ otp, mobile: mobile.slice(1) });
  const response = await fetch(
    `https://control.msg91.com/api/v5/otp/verify?${query}`,
    {
      method: 'GET',
      headers: { authkey: env.MSG91_AUTH_KEY },
      signal: AbortSignal.timeout(10000)
    }
  );
  const body = await readJsonResponse(response);
  if (!response.ok && response.status !== 400) {
    throw new Error('MSG91 OTP verification is unavailable');
  }
  return response.ok && body.type === 'success';
}

module.exports = { sendOtp, verifyOtp };
