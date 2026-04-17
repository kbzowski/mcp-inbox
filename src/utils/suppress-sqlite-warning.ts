// Side-effect-only module. Must be imported before anything that touches
// `node:sqlite` (directly or via drizzle-orm/node-sqlite). ESM evaluates
// imports depth-first, so importing this first guarantees process.emitWarning
// is patched before the sqlite module loads and emits its
// ExperimentalWarning at init time.

const originalEmitWarning = process.emitWarning.bind(process);

type EmitWarningArgs = Parameters<typeof process.emitWarning>;

process.emitWarning = ((...args: EmitWarningArgs) => {
  const [warning, typeOrOpts] = args;
  const name =
    typeof typeOrOpts === 'string'
      ? typeOrOpts
      : (typeOrOpts as { type?: string } | undefined)?.type;
  const text =
    typeof warning === 'string' ? warning : ((warning as Error | undefined)?.message ?? '');
  if (name === 'ExperimentalWarning' && /SQLite is an experimental feature/i.test(text)) {
    return;
  }
  return originalEmitWarning(...args);
}) as typeof process.emitWarning;

// Also drop any listener Node's bootstrap installed before us.
for (const listener of process.listeners('warning')) {
  process.removeListener('warning', listener);
}
process.on('warning', (w) => {
  if (w.name === 'ExperimentalWarning' && /SQLite is an experimental feature/i.test(w.message)) {
    return;
  }
  process.stderr.write(`${w.stack ?? w.message}\n`);
});
