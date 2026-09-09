import { TOOL_CATALOG } from '@domos/catalog';
import { SITE_ORIGIN } from '../config';
export function GET() {
  const paths = ['/', '/tools/', '/guides/', '/privacy/', '/about/', ...TOOL_CATALOG.map((tool) => tool.guidePath)];
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${paths.map((path) => `<url><loc>${SITE_ORIGIN}${path}</loc></url>`).join('')}</urlset>`, { headers: { 'Content-Type': 'application/xml' } });
}
