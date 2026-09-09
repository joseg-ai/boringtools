import { fileURLToPath } from 'node:url';
import { secureBuild } from '../../workspace/scripts/security-lib.mjs';
await secureBuild(fileURLToPath(new URL('..', import.meta.url)), false);
