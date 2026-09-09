import { PUBLIC_SITE_ORIGIN, PUBLIC_WORKSPACE_ORIGIN } from 'astro:env/client';
import { publicOrigin } from '../../workspace/scripts/origins.mjs';
export const SITE_ORIGIN = publicOrigin(PUBLIC_SITE_ORIGIN, import.meta.env.DEV);
export const WORKSPACE_ORIGIN = publicOrigin(PUBLIC_WORKSPACE_ORIGIN, import.meta.env.DEV);
// No publisher IDs, third-party resources, or consent claims ship in this release.
export const SPONSORSHIP = Object.freeze({ enabled: false, showReservedSlot: false });
