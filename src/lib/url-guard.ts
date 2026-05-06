import {
  localhostAllowedHostnames,
  validateHostHeader as sdkValidateHostHeader,
} from '@modelcontextprotocol/server';
import type { CallToolResult } from '@modelcontextprotocol/server';

import { isIP } from 'node:net';
import { domainToUnicode } from 'node:url';

import { getAllowedHostsEnv } from '../config.js';

// ── Private IP detection ──────────────────────────────────────────────

function normalizeIpv4Hostname(hostname: string): string | undefined {
  if (/^\d+$/.test(hostname)) {
    const value = Number(hostname);
    if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
      return undefined;
    }

    return [24, 16, 8, 0].map((shift) => String((value >>> shift) & 0xff)).join('.');
  }

  const parts = hostname.split('.');
  if (parts.length < 2 || parts.length > 4) {
    return undefined;
  }

  const values = parts.map((part) => Number(part));
  if (values.some((part) => !Number.isInteger(part) || part < 0)) {
    return undefined;
  }

  const limits = [255, 255, 255, 255];
  if (parts.length === 2) {
    limits[1] = 0xff_ff_ff;
  } else if (parts.length === 3) {
    limits[2] = 0xff_ff;
  }

  if (values.some((part, index) => part > (limits[index] ?? 255))) {
    return undefined;
  }

  if (parts.length === 4) {
    return hostname;
  }

  const numericValue =
    parts.length === 2
      ? ((values[0] ?? 0) << 24) | ((values[1] ?? 0) & 0xff_ff_ff)
      : ((values[0] ?? 0) << 24) | ((values[1] ?? 0) << 16) | ((values[2] ?? 0) & 0xff_ff);

  return [24, 16, 8, 0].map((shift) => String((numericValue >>> shift) & 0xff)).join('.');
}

function expandIpv6Groups(hostname: string): string[] | undefined {
  const normalized = hostname.toLowerCase();
  if (normalized.includes('.')) {
    return undefined;
  }

  const [left, right] = normalized.split('::');
  if (normalized.includes('::') && right === undefined) {
    return undefined;
  }

  const parseSide = (value: string): string[] =>
    value === '' ? [] : value.split(':').map((part) => part.padStart(4, '0'));
  const leftGroups = parseSide(left ?? normalized);
  const rightGroups = parseSide(right ?? '');
  const hasCompression = normalized.includes('::');
  const totalGroups = leftGroups.length + rightGroups.length;

  if ((!hasCompression && totalGroups !== 8) || totalGroups > 8) {
    return undefined;
  }

  const allGroups = hasCompression
    ? [...leftGroups, ...Array.from({ length: 8 - totalGroups }, () => '0000'), ...rightGroups]
    : leftGroups;

  if (allGroups.length !== 8 || allGroups.some((part) => !/^[0-9a-f]{4}$/u.test(part))) {
    return undefined;
  }

  return allGroups;
}

function isIpv6LoopbackOrUnspecified(hostname: string): boolean {
  const groups = expandIpv6Groups(hostname);
  if (!groups) {
    return false;
  }

  const isUnspecified = groups.every((group) => group === '0000');
  if (isUnspecified) {
    return true;
  }

  return groups.slice(0, -1).every((group) => group === '0000') && groups.at(-1) === '0001';
}

function getIpv6MappedIpv4(hostname: string): string | undefined {
  const groups = expandIpv6Groups(hostname);
  if (!groups) {
    return undefined;
  }

  const isMapped = groups.slice(0, 5).every((group) => group === '0000') && groups[5] === 'ffff';
  if (!isMapped) {
    return undefined;
  }

  const high = Number.parseInt(groups[6] ?? '0', 16);
  const low = Number.parseInt(groups[7] ?? '0', 16);
  return [high >>> 8, high & 0xff, low >>> 8, low & 0xff].join('.');
}

function isPrivateIpv4(hostname: string): boolean {
  const normalizedHostname = normalizeIpv4Hostname(hostname);
  if (!normalizedHostname) {
    return false;
  }

  const parts = normalizedHostname.split('.').map((part) => Number(part));
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }

  const [a, b, c] = parts as [number, number, number, number];

  if (a === 0 || a === 10 || a === 127 || a >= 224) {
    return true;
  }

  if (a === 100) {
    return b >= 64 && b <= 127;
  }

  if (a === 169) {
    return b === 254;
  }

  if (a === 172) {
    return b >= 16 && b <= 31;
  }

  if (a === 192) {
    if (b === 168) {
      return true;
    }

    return b === 0 && c <= 2;
  }

  if (a === 198) {
    if (b === 18 || b === 19) {
      return true;
    }

    return b === 51 && c === 100;
  }

  return a === 203 && b === 0 && c === 113;
}

const PRIVATE_IPV6_PREFIXES = ['fc', 'fd', 'fe8', 'fe9', 'fea', 'feb', 'ff', '::ffff:'];

function isPrivateIpv6(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (isIpv6LoopbackOrUnspecified(normalized)) return true;
  const mappedIpv4 = getIpv6MappedIpv4(normalized);
  if (mappedIpv4) {
    return isPrivateIpv4(mappedIpv4);
  }
  return PRIVATE_IPV6_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function isUnicodeLocalhostLookalike(hostname: string): boolean {
  if (!hostname.includes('xn--')) {
    return false;
  }

  const unicodeHost = domainToUnicode(hostname);
  if (!unicodeHost || unicodeHost === hostname) {
    return false;
  }

  const normalizedUnicode = unicodeHost.normalize('NFKD').replace(/[̀-ͯ]/gu, '').toLowerCase();

  const labels = normalizedUnicode.split('.');
  const distanceToLocalhost = (value: string): number => {
    const target = 'localhost';
    const rows = Array.from({ length: value.length + 1 }, (_, index) => index);

    for (let targetIndex = 1; targetIndex <= target.length; targetIndex += 1) {
      let previous = rows[0] ?? 0;
      rows[0] = targetIndex;
      for (let valueIndex = 1; valueIndex <= value.length; valueIndex += 1) {
        const current = rows[valueIndex] ?? valueIndex;
        const substitutionCost = value[valueIndex - 1] === target[targetIndex - 1] ? 0 : 1;
        rows[valueIndex] = Math.min(
          (rows[valueIndex] ?? valueIndex) + 1,
          (rows[valueIndex - 1] ?? valueIndex - 1) + 1,
          previous + substitutionCost,
        );
        previous = current;
      }
    }

    return rows[value.length] ?? target.length;
  };

  return labels.some((label) => label.includes('localhost') || distanceToLocalhost(label) <= 2);
}

function isRejectedHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized === '[::1]' ||
    normalized === '0.0.0.0'
  ) {
    return true;
  }

  if (isUnicodeLocalhostLookalike(normalized)) {
    return true;
  }

  const cleanHost = normalized.replace(/^\[(.*)\]$/, '$1');
  const normalizedIpv4 = normalizeIpv4Hostname(cleanHost);
  if (normalizedIpv4) {
    return isPrivateIpv4(normalizedIpv4);
  }

  const ipVersion = isIP(cleanHost);
  if (ipVersion === 4) return isPrivateIpv4(cleanHost);
  if (ipVersion === 6) return isPrivateIpv6(cleanHost);

  return false;
}

function tryParseUrl(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

function classifyHttpUrl(url: string): string | undefined {
  const parsed = tryParseUrl(url);
  if (!parsed) {
    return `Invalid URL provided: ${url}`;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `Only http:// and https:// URLs are allowed: ${url}`;
  }

  if (isRejectedHost(parsed.hostname)) {
    return `Private, loopback, and localhost URLs are not allowed: ${url}`;
  }

  return undefined;
}

export function isPublicHttpUrl(url: string): boolean {
  return classifyHttpUrl(url) === undefined;
}

export function validateUrls(urls: readonly string[] | undefined): CallToolResult | undefined {
  if (!urls) return undefined;

  for (const url of urls) {
    const msg = classifyHttpUrl(url);
    if (msg) {
      return {
        content: [{ type: 'text', text: msg }],
        isError: true,
      };
    }
  }

  return undefined;
}

// ── Host header / allowed hosts (HTTP transport) ─────────────────────────

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

function parseAllowedHosts(): string[] | undefined {
  const raw = getAllowedHostsEnv();
  if (!raw) return undefined;
  const hosts = [...new Set(raw.split(',').map(normalizeAllowedHostEntry).filter(Boolean))];
  return hosts.length > 0 ? hosts : undefined;
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
