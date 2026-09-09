import { buildApp } from './app.js';
import { loadConfig } from './config.js';

try {
  const { host, port } = loadConfig();
  const app = buildApp();
  await app.listen({ host, port });
  console.info('Domos diagnostics ready.');
  const shutdown = async () => {
    await app.close();
  };
  process.once('SIGTERM', () => { void shutdown(); });
  process.once('SIGINT', () => { void shutdown(); });
} catch {
  // Startup diagnostics are deliberately fixed; configuration and network error
  // objects can contain hostnames, paths, or credentials.
  console.error('Domos diagnostics startup failed.');
  process.exitCode = 1;
}
