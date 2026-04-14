const LOCALHOST_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
const BROAD_BIND_ADDRESSES = new Set(['0.0.0.0', '::', '']);

function isBroadBind(host: string): boolean {
  return BROAD_BIND_ADDRESSES.has(host);
}

export function parseAllowedHosts(): string[] | undefined {
  const raw = process.env.MCP_ALLOWED_HOSTS;
  if (!raw) return undefined;
  const hosts = raw
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);
  return hosts.length > 0 ? hosts : undefined;
}

/**
 * Returns the allowed-host list for a given bind address.
 *
 * - Explicit `MCP_ALLOWED_HOSTS` always wins.
 * - Localhost binds auto-resolve to `['localhost','127.0.0.1','[::1]']`.
 * - Broad binds (`0.0.0.0`, `::`) without an explicit list return `undefined`
 *   (caller should log a warning but must not block for backward compat).
 */
export function resolveAllowedHosts(bindHost: string): string[] | undefined {
  const explicit = parseAllowedHosts();
  if (explicit) return explicit;
  if (!isBroadBind(bindHost)) return LOCALHOST_HOSTS;
  return undefined;
}

/**
 * Validates a request `Host` header against an allow-list.
 * Strips the port before comparing (case-insensitive).
 */
export function validateHostHeader(hostHeader: string | null, allowedHosts: string[]): boolean {
  if (!hostHeader) return false;

  let hostname: string;

  if (hostHeader.startsWith('[')) {
    // IPv6 with brackets — e.g. [::1]:3000 or [::1]
    const bracketEnd = hostHeader.indexOf(']');
    hostname = bracketEnd === -1 ? hostHeader : hostHeader.slice(0, bracketEnd + 1);
  } else {
    // IPv4 / hostname — strip port after last colon
    const colonIdx = hostHeader.lastIndexOf(':');
    hostname = colonIdx === -1 ? hostHeader : hostHeader.slice(0, colonIdx);
  }

  const lower = hostname.toLowerCase();
  return allowedHosts.some((h) => h.toLowerCase() === lower);
}
