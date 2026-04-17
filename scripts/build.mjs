// esbuild bundler for the mcp-inbox binary. Produces two bundles:
//   dist/index.js  (tiny entry: installs warning filter, then imports app)
//   dist/app.js    (the real application)
//
// Why two files: the entry file must install a warning filter BEFORE any
// module that loads node:sqlite is resolved. In ESM, static `import`
// statements hoist above top-level code, so mixing the filter and the app
// imports in one bundle defeats the ordering. Dynamic `await import()`
// does not hoist - keeping app as a separate file on disk preserves the
// deferred-load boundary that lets the filter install first.
//
// Type declarations are emitted separately via `tsc -p tsconfig.build.json`.

import { build } from 'esbuild';
import { rm, chmod, cp } from 'node:fs/promises';

const ENTRY = 'dist/index.js';

await rm('dist', { recursive: true, force: true });

await build({
  entryPoints: ['src/app.ts'],
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  minify: false,
  sourcemap: true,
  banner: {
    js: `import { createRequire as __mcpCreateRequire } from 'node:module';
globalThis.require = globalThis.require ?? __mcpCreateRequire(import.meta.url);`,
  },
  packages: 'external',
  logLevel: 'info',
});

await build({
  entryPoints: ['src/index.ts'],
  outdir: 'dist',
  bundle: true,
  external: ['./app.js'],
  platform: 'node',
  target: 'node24',
  format: 'esm',
  minify: false,
  sourcemap: true,
  banner: {
    // Shebang at the top of each bundle. Paired with a createRequire shim
    // so the ESM output can require() CommonJS deps (nodemailer, imapflow,
    // mailparser) without esbuild's fallback throwing "Dynamic require of
    // ... is not supported" at runtime.
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
  await chmod(ENTRY, 0o755);
} catch {
  // chmod is best-effort; Windows rejects it but the shebang is still correct.
}
