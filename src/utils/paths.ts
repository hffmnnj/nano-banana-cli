import { homedir } from "os";
import { join, parse, format } from "path";
import { mkdir } from "fs/promises";

/** Absolute path to the .nban/profile/ directory under the user's home. */
export function getProfilePath(): string {
  return join(homedir(), ".nban", "profile");
}

/** Default output path: {cwd}/nban-{timestamp}[-{index}].png */
export function getDefaultOutputPath(
  timestamp: number,
  index?: number,
): string {
  const suffix = index !== undefined ? `-${index}` : "";
  return join(process.cwd(), `nban-${timestamp}${suffix}.png`);
}

/**
 * Multi-image output path. Returns basePath unchanged when total === 1.
 * Otherwise inserts index before extension: art.png -> art-2.png
 */
export function getMultiOutputPath(
  basePath: string,
  index: number,
  total: number,
): string {
  if (total === 1) return basePath;
  const parsed = parse(basePath);
  if (!parsed.ext) return `${basePath}-${index}`;
  return format({ ...parsed, base: undefined, name: `${parsed.name}-${index}` });
}

/** Creates directory recursively if it doesn't exist. */
export async function ensureDir(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true });
}
