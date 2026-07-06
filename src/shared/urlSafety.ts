import net from 'net';

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

function normalizedHostname(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
}

function isDomainOrSubdomain(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

function isBlockedHostname(hostname: string): boolean {
  return (
    hostname === '' ||
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '0.0.0.0'
  );
}

function isBlockedIpv4(hostname: string): boolean {
  const parts = hostname.split('.').map(part => Number(part));
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }

  const [a, b] = parts;

  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isBlockedIpv6(hostname: string): boolean {
  const value = hostname.toLowerCase();
  if (value === '::' || value === '::1') return true;

  if (/^fe[89ab][0-9a-f]?:/.test(value)) return true;
  if (value.startsWith('fc') || value.startsWith('fd')) return true;

  const mappedIpv4 = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mappedIpv4) return isBlockedIpv4(mappedIpv4[1]);

  return false;
}

export function parseSafeMediaUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('Invalid URL');
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new Error('URL protocol must be http or https');
  }

  const hostname = normalizedHostname(parsed);
  if (isBlockedHostname(hostname)) {
    throw new Error('URL host is not allowed');
  }

  const ipVersion = net.isIP(hostname);
  if (ipVersion === 4 && isBlockedIpv4(hostname)) {
    throw new Error('URL IP address is not allowed');
  }
  if (ipVersion === 6 && isBlockedIpv6(hostname)) {
    throw new Error('URL IP address is not allowed');
  }

  return parsed;
}

export function isSafeMediaUrl(rawUrl: string): boolean {
  try {
    parseSafeMediaUrl(rawUrl);
    return true;
  } catch {
    return false;
  }
}

export function isYoutubeUrl(rawUrl: string): boolean {
  try {
    const hostname = normalizedHostname(parseSafeMediaUrl(rawUrl));
    return (
      isDomainOrSubdomain(hostname, 'youtube.com') ||
      hostname === 'youtu.be' ||
      isDomainOrSubdomain(hostname, 'youtube-nocookie.com')
    );
  } catch {
    return false;
  }
}

export function isMegaUrl(rawUrl: string): boolean {
  try {
    const hostname = normalizedHostname(parseSafeMediaUrl(rawUrl));
    return (
      isDomainOrSubdomain(hostname, 'mega.nz') ||
      isDomainOrSubdomain(hostname, 'mega.co.nz')
    );
  } catch {
    return false;
  }
}
