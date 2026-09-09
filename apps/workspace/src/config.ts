import { PUBLIC_API_ORIGIN, PUBLIC_SITE_ORIGIN } from 'astro:env/client';
import { apiOriginSchema } from '@domos/contracts/api';
import { publicOrigin } from '../scripts/origins.mjs';

export const API_ORIGIN = apiOriginSchema.parse(PUBLIC_API_ORIGIN);
export const SITE_ORIGIN = publicOrigin(PUBLIC_SITE_ORIGIN, import.meta.env.DEV);
