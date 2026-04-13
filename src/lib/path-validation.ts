import { realpath } from 'node:fs/promises';
import { isAbsolute, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type RootsFetcher = () => Promise<string[]>;

const ENV_ROOTS: string[] = process.env.ALLOWED_FILE_ROOTS
  ? process.env.ALLOWED_FILE_ROOTS.split(',').map((r) => normalize(r.trim()))
  : [normalize(process.cwd())];

function parseRootUri(uri: string): string | undefined {
  try {
    return normalize(fileURLToPath(uri));
  } catch {
    return undefined;
  }
}

async function getAllowedRoots(rootsFetcher?: RootsFetcher): Promise<string[]> {
  if (!rootsFetcher) return ENV_ROOTS;
  try {
    const clientRoots = await rootsFetcher();
    return clientRoots.length > 0 ? clientRoots : ENV_ROOTS;
  } catch {
    return ENV_ROOTS;
  }
}

export function buildRootsFetcher(
  getClientCapabilities: () =>
    | { roots?: { listChanged?: boolean | undefined } | undefined }
    | undefined,
  listRoots: () => Promise<{ roots: { uri: string; name?: string | undefined }[] }>,
): RootsFetcher {
  return async () => {
    if (!getClientCapabilities()?.roots) return [];
    const { roots } = await listRoots();
    return roots.map((r) => parseRootUri(r.uri)).filter((p): p is string => p !== undefined);
  };
}

export async function resolveAndValidatePath(
  filePath: string,
  rootsFetcher?: RootsFetcher,
): Promise<string> {
  if (!isAbsolute(filePath)) {
    throw new Error(`Path must be absolute: ${filePath}`);
  }

  const normalized = normalize(filePath);

  // Resolve symlinks to get the real path
  let resolved: string;
  try {
    resolved = await realpath(normalized);
  } catch {
    // File may not exist yet — use normalized path for the check
    resolved = resolve(normalized);
  }

  const allowedRoots = await getAllowedRoots(rootsFetcher);

  const isUnderAllowedRoot = allowedRoots.some((root) =>
    resolved.toLowerCase().startsWith(root.toLowerCase()),
  );

  if (!isUnderAllowedRoot) {
    throw new Error(
      `Path '${filePath}' is outside allowed directories. Set ALLOWED_FILE_ROOTS to expand access.`,
    );
  }

  return resolved;
}
