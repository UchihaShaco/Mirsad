// Stub until Task 11. The signature is final; the route answers 501 until then.
import type { Config } from '../config.ts';
import { AppError } from '../contract/errors.ts';
import type { Status } from '../contract/schemas.ts';
import type { Reviewer } from '../ports/reviewer.ts';
import type { Db } from '../storage/db.ts';

export interface StatusDeps {
  config: Config;
  db: Db;
  reviewer: Reviewer;
  startedAt: string;
}

export async function readStatus(_deps: StatusDeps): Promise<Status> {
  throw AppError.of('not_implemented', 'Status is not implemented yet.');
}
