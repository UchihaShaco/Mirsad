import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isEntryPoint, loadDotEnvIfPresent } from '../../scripts/entry-point.ts';

/** A variable no environment sets, so seeing it proves the file was loaded. */
const PROBE_VARIABLE = 'MIRSAD_ENTRY_POINT_TEST_PROBE';

describe('script entry-point helpers', () => {
  let dir: string;
  let script: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirsad-entry-point-'));
    script = path.join(dir, 'script.ts');
    fs.writeFileSync(script, 'export {};\n');
  });

  afterEach(() => {
    delete process.env[PROBE_VARIABLE];
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('isEntryPoint is true when the process was started with the module file, by any path to it', () => {
    const moduleUrl = pathToFileURL(script).href;

    expect(isEntryPoint(moduleUrl, ['node', script])).toBe(true);
    expect(isEntryPoint(moduleUrl, ['node', path.relative(process.cwd(), script)])).toBe(true);
  });

  it('isEntryPoint is false for another file, no entry, a missing file and a module the test runner imported', () => {
    const other = path.join(dir, 'other.ts');
    fs.writeFileSync(other, 'export {};\n');
    const missing = path.join(dir, 'missing.ts');
    const moduleUrl = pathToFileURL(script).href;

    expect(isEntryPoint(moduleUrl, ['node', other])).toBe(false);
    expect(isEntryPoint(moduleUrl, ['node'])).toBe(false);
    expect(isEntryPoint(moduleUrl, ['node', missing])).toBe(false);
    expect(isEntryPoint(pathToFileURL(missing).href, ['node', missing])).toBe(false);
    // Under Vitest the process entry is the runner, so importing a script never runs its main block.
    expect(isEntryPoint(import.meta.url)).toBe(false);
  });

  it('loadDotEnvIfPresent loads an existing file into process.env and ignores a missing one', () => {
    const envFile = path.join(dir, '.env');

    loadDotEnvIfPresent(envFile);
    expect(process.env[PROBE_VARIABLE]).toBeUndefined();

    fs.writeFileSync(envFile, `${PROBE_VARIABLE}=loaded\n`);
    loadDotEnvIfPresent(envFile);
    expect(process.env[PROBE_VARIABLE]).toBe('loaded');
  });
});
