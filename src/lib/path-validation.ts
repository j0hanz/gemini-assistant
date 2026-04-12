import { realpath } from 'node:fs/promises';
import { isAbsolute, normalize, resolve } from 'node:path';

const ALLOWED_ROOTS: string[] = process.env.ALLOWED_FILE_ROOTS
  ? process.env.ALLOWED_FILE_ROOTS.split(',').map((r) => normalize(r.trim()))
  : [normalize(process.cwd())];

export async function resolveAndValidatePath(filePath: string): Promise<string> {
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

  const isUnderAllowedRoot = ALLOWED_ROOTS.some((root) =>
    resolved.toLowerCase().startsWith(root.toLowerCase()),
  );

  if (!isUnderAllowedRoot) {
    throw new Error(
      `Path '${filePath}' is outside allowed directories. Set ALLOWED_FILE_ROOTS to expand access.`,
    );
  }

  return resolved;
}
