import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
await build({
  entryPoints: [fileURLToPath(new URL('../src/server.ts', import.meta.url))],
  outfile: fileURLToPath(new URL('../dist/server.mjs', import.meta.url)),
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  external: Object.keys(manifest.dependencies).filter((name) => !name.startsWith('@domos/')),
  sourcemap: false,
  legalComments: 'linked',
});
