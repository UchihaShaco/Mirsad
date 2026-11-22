/** `npm run openapi:generate`: writes openapi.yaml at the project root from the zod schemas and the route table. */
import fs from 'node:fs';
import path from 'node:path';
import { stringify } from 'yaml';
import { buildOpenApiDocument } from '../src/contract/openapi.ts';

const OUTPUT = path.resolve(import.meta.dirname, '../openapi.yaml');

fs.writeFileSync(OUTPUT, stringify(buildOpenApiDocument(), { lineWidth: 0 }));
process.stdout.write(`wrote ${path.relative(process.cwd(), OUTPUT) || OUTPUT}\n`);
