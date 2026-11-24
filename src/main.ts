/** Process entry: load .env and config, create the app, listen on loopback, stop cleanly on signals. */
import fs from 'node:fs';
import { createApp } from './app.ts';
import { ConfigError, loadConfig } from './config.ts';
import { createJsonLogger } from './logging/json-logger.ts';

const ENV_FILE = '.env';
const logger = createJsonLogger();

function loadEnvFile(): void {
  if (!fs.existsSync(ENV_FILE)) return;
  try {
    process.loadEnvFile(ENV_FILE);
  } catch (error) {
    logger.error('env_file_unreadable', { errorClass: error instanceof Error ? error.name : 'unknown' });
    process.exitCode = 1;
    throw error;
  }
}

async function main(): Promise<void> {
  const wordingUntil = process.env.MIRSAD_TEST_WORDING_UNTIL;
  loadEnvFile();
  const config = loadConfig({ ...process.env, MIRSAD_TEST_WORDING_UNTIL: wordingUntil });
  const app = await createApp({ config, logger });
  const { url } = await app.listen();
  logger.info('mirsad_started', { url });

  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info('mirsad_stopping', { signal });
    app
      .close()
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        logger.error('mirsad_stop_failed', { errorClass: error instanceof Error ? error.name : 'unknown' });
        process.exit(1);
      });
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    logger.error('config_invalid', { variable: error.variable, problem: error.message });
  } else {
    logger.error('mirsad_start_failed', { errorClass: error instanceof Error ? error.name : 'unknown' });
  }
  process.exit(1);
});
