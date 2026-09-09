import { defineConfig, envField } from 'astro/config';
import react from '@astrojs/react';
import { buildOrigins } from '../workspace/scripts/origins.mjs';

const origins = buildOrigins(process.env);

export default defineConfig({
  site: origins.site,
  output: 'static',
  trailingSlash: 'always',
  integrations: [react()],
  env: {
    schema: {
      PUBLIC_SITE_ORIGIN: envField.string({ context: 'client', access: 'public', url: true, default: origins.site }),
      PUBLIC_WORKSPACE_ORIGIN: envField.string({ context: 'client', access: 'public', url: true, default: origins.workspace }),
    },
  },
});
