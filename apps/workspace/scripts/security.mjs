import { fileURLToPath } from 'node:url';
import { secureBuild } from './security-lib.mjs';
await secureBuild(fileURLToPath(new URL('..', import.meta.url)), true);
