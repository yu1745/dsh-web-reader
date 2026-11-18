import { build } from 'esbuild';
import { copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

await build({
  absWorkingDir: fileURLToPath(new URL('../', import.meta.url)),
  entryPoints: ['src/web-reader.ts'],
  outdir: 'lib',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  sourcemap: true,
});

await copyFile(new URL('../src/vendor/web-reader/LICENSE', import.meta.url), new URL('../lib/WEB-READER-LICENSE', import.meta.url));
