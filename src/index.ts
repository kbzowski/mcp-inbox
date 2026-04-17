// Tiny ESM entry point. The only thing it does synchronously is install
// the warning filter so node:sqlite's ExperimentalWarning is swallowed
// before anything else loads it. Then it dynamically imports the app,
// which is what pulls in drizzle-orm/node-sqlite (and therefore
// node:sqlite itself).
//
// Static ESM imports are hoisted above top-level statements, so the
// override cannot go here as a normal import statement - the sqlite
// module would load first. A dynamic import() runs after the preamble.

// Must run before anything that imports node:sqlite (drizzle-orm/node-sqlite
// calls StatementSync.setReturnArrays which only exists in Node 24+).
const [nodeMajor] = process.versions.node.split('.').map(Number);
if ((nodeMajor as number) < 24) {
  process.stderr.write(
    `mcp-inbox requires Node.js 24 or later (running ${process.version}).\n` +
      `  • npx users: npx is usually fine — check 'node --version' first.\n` +
      `  • proto users: run 'proto pin node 24 --global' once to set the global default.\n` +
      `  • pnpm dlx / pnpx: if proto shims resolve to an older version outside your\n` +
      `    project directory, set a global default or use 'npx -y @kbzowski/mcp-inbox'.\n`,
  );
  process.exit(1);
}

import './utils/suppress-sqlite-warning';

// The `.js` extension is required at runtime (esbuild emits dist/app.js).
// TS `moduleResolution: Bundler` lets us write it this way in source.
await import('./app.js');
