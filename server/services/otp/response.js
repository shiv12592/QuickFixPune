async function readJsonResponse(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('OTP provider returned an invalid response');
  }
}

function assertProviderAccepted(response, body) {
  if (!response.ok || body.return === false || body.type === 'error') {
    throw new Error('OTP provider could not send the code');
  }
}

module.exports = { readJsonResponse, assertProviderAccepted };
