/**
 * Start-up helpers shared by the scripts run with tsx. tsx leaves `import.meta.main` undefined, so a script finds out
 * whether it was run directly, rather than imported by a test, by comparing real paths. Make any change to that rule
 * here, once, for every script.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ENV_FILE = '.env';

/**
 * True when the process was started with the module at `moduleUrl` (pass `import.meta.url`). Both sides are resolved
 * to real paths, so relative paths, symlinks and Windows path casing still match. No entry, a missing file or a URL
 * that is not a file URL is never the entry point.
 */
export function isEntryPoint(moduleUrl: string, argv: readonly string[] = process.argv): boolean {
  const entry = argv[1];
  if (!entry) return false;
  try {
    return fs.realpathSync.native(entry) === fs.realpathSync.native(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

/** Loads `file` (default `.env` in the working directory) into process.env when it exists; set variables are kept. */
export function loadDotEnvIfPresent(file: string = ENV_FILE): void {
  if (fs.existsSync(file)) process.loadEnvFile(file);
}
