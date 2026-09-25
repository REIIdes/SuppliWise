/**
 * Device attribution for the "Signed-in devices" view.
 *
 * SECURITY NOTE — this module is PRESENTATION ONLY.
 * Everything it returns is derived from request headers, which the caller
 * controls. None of it may ever gate an authorisation decision: not for
 * step-up checks, not for revoking a session, not for trusting a device. Its
 * whole job is to help a person recognise a session as "my laptop" versus
 * "not me" in a list they can then revoke.
 *
 * That is why trusted-device identity is anchored to the stored credential
 * hash (see attachRememberToken) rather than to anything parsed here.
 */

const UA_PATTERNS = [
  // Order matters: Edge and Opera both claim to be Chrome, Chrome claims
  // Safari, Safari claims Mozilla. Most-specific first.
  { re: /Edg(?:e|A|iOS)?\/([\d.]+)/i, name: 'Edge' },
  { re: /OPR\/([\d.]+)/i, name: 'Opera' },
  { re: /Firefox\/([\d.]+)/i, name: 'Firefox' },
  { re: /Chrome\/([\d.]+)/i, name: 'Chrome' },
  { re: /Version\/([\d.]+).*Safari/i, name: 'Safari' },
  { re: /SamsungBrowser\/([\d.]+)/i, name: 'Samsung Internet' },
  { re: /curl\/([\d.]+)/i, name: 'curl' },
  { re: /node/i, name: 'Node' },
  { re: /PostmanRuntime/i, name: 'Postman' },
];

const PLATFORM_PATTERNS = [
  { re: /Windows NT 10/i, name: 'Windows' },
  { re: /Windows NT/i, name: 'Windows' },
  { re: /iPhone|iPad|iPod/i, name: 'iOS' },
  { re: /Android/i, name: 'Android' },
  { re: /Mac OS X|Macintosh/i, name: 'macOS' },
  { re: /CrOS/i, name: 'ChromeOS' },
  { re: /Linux/i, name: 'Linux' },
];

function browserOf(userAgent) {
  const ua = String(userAgent || '');
  for (const { re, name } of UA_PATTERNS) {
    if (re.test(ua)) return name;
  }
  return ua ? 'Unknown browser' : 'Unknown device';
}

function platformOf(userAgent) {
  const ua = String(userAgent || '');
  for (const { re, name } of PLATFORM_PATTERNS) {
    if (re.test(ua)) return name;
  }
  return ua ? 'Unknown OS' : 'Unknown OS';
}

/** "Chrome on Windows" — the friendly name shown in the device list. */
function deviceLabelOf(userAgent) {
  const platform = platformOf(userAgent);
  const browser = browserOf(userAgent);
  if (browser === 'Unknown device') return 'Unknown device';
  return platform === 'Unknown OS' ? browser : `${browser} on ${platform}`;
}

/**
 * Build the attribution fields for a Session document.
 * `location` is the caller's already-resolved, coarse description.
 */
function describeDevice({ userAgent, ip, location } = {}) {
  const ua = String(userAgent || '').slice(0, 300);
  return {
    deviceLabel: deviceLabelOf(ua).slice(0, 120),
    platform: platformOf(ua).slice(0, 80),
    ip: String(ip || '').slice(0, 64),
    location: String(location || '').slice(0, 120),
  };
}

module.exports = {
  browserOf,
  platformOf,
  deviceLabelOf,
  describeDevice,
};
