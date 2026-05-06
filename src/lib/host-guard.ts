import {
  localhostAllowedHostnames,
  validateHostHeader as sdkValidateHostHeader,
} from '@modelcontextprotocol/server';

import { isIP } from 'node:net';

import { getAllowedHostsEnv } from '../config.js';

const LOCALHOST_BIND_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const BROAD_BIND_ADDRESSES = new Set(['0.0.0.0', '::', '']);

function normalizeAllowedHost(host: string): string {
  const cleanHost = host.replace(/^\[(.*)\]$/, '$1').toLowerCase();
  return isIP(cleanHost) === 6 ? `[${cleanHost}]` : cleanHost;
}

function stripHostPort(host: string): string {
  const trimmed = host.trim().toLowerCase();
  if (trimmed.startsWith('[')) {
    const bracketEnd = trimmed.indexOf(']');
    return bracketEnd === -1 ? trimmed : trimmed.slice(0, bracketEnd + 1);
  }
  if (isIP(trimmed) === 6) return trimmed;
  const colonIdx = trimmed.lastIndexOf(':');
  return colonIdx === -1 ? trimmed : trimmed.slice(0, colonIdx);
}

function normalizeAllowedHostEntry(host: string): string {
  return normalizeAllowedHost(stripHostPort(host));
}

function dedupeAllowedHosts(hosts: string[]): string[] {
  return [...new Set(hosts)];
}

function parseAllowedHosts(): string[] | undefined {
  const raw = getAllowedHostsEnv();
  if (!raw) return undefined;
  const hosts = raw.split(',').map(normalizeAllowedHostEntry).filter(Boolean);
  const deduped = dedupeAllowedHosts(hosts);
  return deduped.length > 0 ? deduped : undefined;
}

export function resolveAllowedHosts(bindHost: string): string[] | undefined {
  const explicit = parseAllowedHosts();
  if (explicit) return explicit;
  if (BROAD_BIND_ADDRESSES.has(bindHost)) return undefined;
  if (LOCALHOST_BIND_HOSTS.has(bindHost)) return localhostAllowedHostnames();
  return [normalizeAllowedHost(bindHost)];
}

export function validateHostHeader(hostHeader: string | null, allowedHosts: string[]): boolean {
  if (!hostHeader) return false;
  const normalizedHeader = normalizeAllowedHostEntry(hostHeader);
  const normalizedAllowed = allowedHosts.map(normalizeAllowedHostEntry);
  return sdkValidateHostHeader(normalizedHeader, normalizedAllowed).ok;
}
