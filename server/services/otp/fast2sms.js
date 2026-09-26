const { readJsonResponse, assertProviderAccepted } = require('./response');

async function sendOtp(mobile, otp, env = process.env) {
  if (!env.FAST2SMS_API_KEY || !env.FAST2SMS_OTP_ID) {
    throw new Error('Fast2SMS OTP configuration is incomplete');
  }

  const response = await fetch('https://www.fast2sms.com/dev/otp/send', {
    method: 'POST',
    headers: {
      Authorization: env.FAST2SMS_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      mobile: mobile.slice(-10),
      otp_id: env.FAST2SMS_OTP_ID,
      otp_expiry: 5,
      otp_length: 6,
      otp
    }),
    signal: AbortSignal.timeout(10000)
  });
  const body = await readJsonResponse(response);
  assertProviderAccepted(response, body);
  return String(body.request_id || '');
}

module.exports = { sendOtp };
