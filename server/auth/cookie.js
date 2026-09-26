function readCookie(header, name) {
  for (const item of String(header || '').split(';')) {
    const separator = item.indexOf('=');
    if (separator < 0 || item.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(item.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

function sessionCookie(token, maxAgeSeconds, production) {
  const parts = [
    `qf_session=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`
  ];
  if (production) parts.push('Secure');
  return parts.join('; ');
}

module.exports = { readCookie, sessionCookie };
