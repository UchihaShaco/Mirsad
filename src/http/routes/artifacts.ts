/** GET /v1/artifacts/{artifactId}: the binary exception to the JSON envelope (design sections 5 and 6). */
import { readArtifact, readVerifiedArtifactBytes } from '../../services/artifacts.ts';
import { principalOf, type RouteModule } from '../context.ts';

const OK = 200;

export const routes: RouteModule = {
  'GET /v1/artifacts/{artifactId}': async (c, deps) => {
    const officer = principalOf(c);
    const artifactId = c.req.param('artifactId') ?? '';
    const artifact = deps.db.transaction((tx) => readArtifact(tx, officer, artifactId));
    const bytes = await readVerifiedArtifactBytes(deps.evidenceStore, artifact);
    // Hono takes a Uint8Array over a plain ArrayBuffer; the copy gives it one without a type cast.
    return c.body(new Uint8Array(bytes), OK, {
      'Content-Type': artifact.media_type,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': `inline; filename="${artifact.id}.png"`,
      'X-Mirsad-SHA256': artifact.sha256,
    });
  },
};
