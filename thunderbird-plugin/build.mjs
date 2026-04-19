import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync, createWriteStream } from 'node:fs';
import { argv } from 'node:process';
import archiver from 'archiver';

const watch = argv.includes('--watch');

const sharedOptions = {
  bundle: true,
  minify: false,
  sourcemap: false,
  target: 'es2022',
};

// Extension scripts (browser environment)
const extensionEntries = [
  { in: 'src/background.ts', out: 'dist/background.js' },
  { in: 'src/sidebar/sidebar.ts', out: 'dist/sidebar/sidebar.js' },
  { in: 'src/options/options.ts', out: 'dist/options/options.js' },
];

// Native host (Node.js environment)
const hostEntry = { in: 'src/native-host/host.ts', out: 'dist/native-host/host.cjs' };

// Static assets to copy: [src, dest]
const staticAssets = [
  ['src/sidebar/sidebar.html', 'dist/sidebar/sidebar.html'],
  ['src/sidebar/sidebar.css', 'dist/sidebar/sidebar.css'],
  ['src/options/options.html', 'dist/options/options.html'],
];

function copyStatic() {
  for (const [src, dest] of staticAssets) {
    mkdirSync(dest.split('/').slice(0, -1).join('/'), { recursive: true });
    copyFileSync(src, dest);
  }
}

async function build() {
  for (const { in: entryPoint, out: outfile } of extensionEntries) {
    await esbuild.build({
      ...sharedOptions,
      entryPoints: [entryPoint],
      outfile,
      platform: 'browser',
      format: 'iife',
    });
  }

  await esbuild.build({
    ...sharedOptions,
    entryPoints: [hostEntry.in],
    outfile: hostEntry.out,
    platform: 'node',
    format: 'cjs',
    external: ['node:*'],
  });

  copyStatic();
  console.log('Build complete.');
}

async function pack() {
  await build();

  const outFile = 'claude-email-search.xpi';
  const output = createWriteStream(outFile);
  const archive = archiver('zip', { zlib: { level: 9 } });

  await new Promise((resolve, reject) => {
    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);

    archive.file('manifest.json', { name: 'manifest.json' });
    archive.file('dist/background.js', { name: 'dist/background.js' });
    archive.directory('dist/sidebar/', 'dist/sidebar/');
    archive.directory('dist/options/', 'dist/options/');

    void archive.finalize();
  });

  console.log(`Packaged → ${outFile} (${output.bytesWritten} bytes)`);
}

const pack_ = argv.includes('--pack');
if (pack_) {
  await pack();
} else if (watch) {
  const ctxs = await Promise.all([
    ...extensionEntries.map(({ in: entryPoint, out: outfile }) =>
      esbuild.context({
        ...sharedOptions,
        entryPoints: [entryPoint],
        outfile,
        platform: 'browser',
        format: 'iife',
        plugins: [
          {
            name: 'copy-static',
            setup(build) {
              build.onEnd(copyStatic);
            },
          },
        ],
      }),
    ),
    esbuild.context({
      ...sharedOptions,
      entryPoints: [hostEntry.in],
      outfile: hostEntry.out,
      platform: 'node',
      format: 'cjs',
      external: ['node:*'],
    }),
  ]);
  await Promise.all(ctxs.map((ctx) => ctx.watch()));
  console.log('Watching for changes…');
} else {
  await build();
}
