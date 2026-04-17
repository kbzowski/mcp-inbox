// esbuild bundler for the mcp-inbox binary.
// Produces a single-file ESM bundle at dist/index.js with a Node shebang.
// Type declarations are emitted separately via `tsc -p tsconfig.build.json`.

import { build } from 'esbuild';
import { rm, chmod, cp } from 'node:fs/promises';

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
    // Shebang at the top of the bundle so `npx mcp-inbox` runs it.
    // Paired with a second import() shim that teaches the ESM bundle
    // how to require() the CommonJS deps (nodemailer, better-sqlite3,
    // imapflow, mailparser) - without this shim esbuild's own fallback
    // throws "Dynamic require of ... is not supported" at runtime.
    js: `#!/usr/bin/env node
import { createRequire as __mcpCreateRequire } from 'node:module';
globalThis.require = globalThis.require ?? __mcpCreateRequire(import.meta.url);`,
  },
  // Keep every node_module external. Our own code bundles to a small file
  // (<100KB) and the deps resolve normally via the consumer's install.
  // This avoids every variety of CJS-in-ESM / native-module bundling pain.
  packages: 'external',
  logLevel: 'info',
});

// Copy drizzle-generated migrations so the runtime migrator can find them
// next to the bundled binary. src/cache/db.ts resolves the folder relative
// to `import.meta.url`, which is `dist/index.js` at runtime.
await cp('src/cache/migrations', 'dist/migrations', { recursive: true });

// Make the binary executable on POSIX. No-op on Windows.
try {
  await chmod(OUTFILE, 0o755);
} catch {
  // chmod is best-effort; Windows rejects it but the shebang is still correct.
}
