// Post-build step: stamp the service worker's cache name with a per-build
// version (replaces every __BUILD_VERSION__ in public/sw.js). Runs after
// `vite build` because Vite copies public/ into dist/ late in the build —
// an in-process plugin hook gets its edit overwritten by that copy.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const swPath = resolve(dirname(fileURLToPath(import.meta.url)), '../dist/sw.js');
const version = Date.now().toString(36);
const src = readFileSync(swPath, 'utf8');
if (!src.includes('__BUILD_VERSION__')) {
  console.error('stamp-sw: __BUILD_VERSION__ placeholder not found in dist/sw.js');
  process.exit(1);
}
writeFileSync(swPath, src.replaceAll('__BUILD_VERSION__', version));
console.log(`stamp-sw: cache version cairn-${version}`);
