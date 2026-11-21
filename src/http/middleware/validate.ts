/** Request validation helpers: zod at the boundary, failures as 400 validation_failed with field details. */
import type { Context } from 'hono';
import type { z } from 'zod';
import { AppError } from '../../contract/errors.ts';

function validationError(issues: readonly z.core.$ZodIssue[]): AppError {
  const fields = issues.map((issue) => ({ path: issue.path.map(String).join('.'), message: issue.message }));
  return AppError.of('validation_failed', 'The request is not valid.', { fields });
}

export function parseWith<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) throw validationError(result.error.issues);
  return result.data;
}

/** Parses the JSON body; a missing or malformed body is a validation failure. */
export async function parseJsonBody<S extends z.ZodType>(c: Context, schema: S): Promise<z.output<S>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw AppError.of('validation_failed', 'The request body must be JSON.', {
      fields: [{ path: '', message: 'Invalid or missing JSON body' }],
    });
  }
  return parseWith(schema, body);
}

export function parseQuery<S extends z.ZodType>(c: Context, schema: S): z.output<S> {
  return parseWith(schema, c.req.query());
}
