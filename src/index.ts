// Tiny ESM entry point. The only thing it does synchronously is install
// the warning filter so node:sqlite's ExperimentalWarning is swallowed
// before anything else loads it. Then it dynamically imports the app,
// which is what pulls in drizzle-orm/node-sqlite (and therefore
// node:sqlite itself).
//
// Static ESM imports are hoisted above top-level statements, so the
// override cannot go here as a normal import statement - the sqlite
// module would load first. A dynamic import() runs after the preamble.

import './utils/suppress-sqlite-warning';

// The `.js` extension is required at runtime (esbuild emits dist/app.js).
// TS `moduleResolution: Bundler` lets us write it this way in source.
await import('./app.js');
