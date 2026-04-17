// esbuild bundler for the mcp-inbox binary.
// Produces a single-file ESM bundle at dist/index.js with a Node shebang.
// Type declarations are emitted separately via `tsc -p tsconfig.build.json`.

import { build } from 'esbuild';
import { rm, chmod } from 'node:fs/promises';

const OUTFILE = 'dist/index.js';

await rm('dist', { recursive: true, force: true });

await build({
  entryPoints: ['src/index.ts'],
  outfile: OUTFILE,
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  minify: false,
  sourcemap: true,
  banner: {
    js: '#!/usr/bin/env node',
  },
  // Node built-ins are resolved by Node itself. Native modules must stay
  // external so they resolve against the consumer's installed binary,
  // not the bundler's host machine.
  external: ['better-sqlite3'],
  logLevel: 'info',
});

// Make the binary executable on POSIX. No-op on Windows.
try {
  await chmod(OUTFILE, 0o755);
} catch {
  // chmod is best-effort; Windows rejects it but the shebang is still correct.
}
