import type { Context, ErrorHandler, NotFoundHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { AppError, fail } from '../../contract/errors.ts';
import type { Logger } from '../../ports/logger.ts';
import type { AppEnv } from '../context.ts';

const SERVER_ERROR = 500;

/** Maps errors to the failure envelope. Unknown errors are logged by class only and answered as 500. */
export function errorHandler(logger: Logger): ErrorHandler<AppEnv> {
  return (error, c) => {
    if (error instanceof AppError) {
      if (error.status >= SERVER_ERROR) logger.error('http_error', { code: error.code, method: c.req.method });
      return c.json(
        fail({ code: error.code, message: error.message, details: error.details }),
        error.status as ContentfulStatusCode,
      );
    }
    logger.error('http_unhandled_error', { errorClass: error.name, method: c.req.method });
    return c.json(fail({ code: 'internal_error', message: 'An internal error occurred.' }), SERVER_ERROR);
  };
}

export const notFoundHandler: NotFoundHandler<AppEnv> = (c: Context<AppEnv>) =>
  c.json(fail({ code: 'not_found', message: 'No such route.' }), 404);
