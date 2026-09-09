import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

assert.equal(Number(process.versions.node.split('.')[0]), 24, 'Container must run Node 24.');
assert.ok(process.getuid && process.getuid() > 0, 'Container must run as non-root.');
const server = spawn(process.execPath, ['apps/diagnostics/dist/server.mjs'], {
  env: { ...process.env, NODE_ENV: 'production', HOST: '127.0.0.1', PORT: '8787' },
  stdio: ['ignore', 'ignore', 'inherit'],
});
const stopped = new Promise((resolve, reject) => {
  server.once('error', reject);
  server.once('exit', (code, signal) => resolve({ code, signal }));
});

try {
  let healthy = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    assert.equal(server.exitCode, null, 'Server exited before readiness.');
    try {
      const response = await fetch('http://127.0.0.1:8787/healthz', { signal: AbortSignal.timeout(1000) });
      const body = await response.json();
      assert.equal(response.status, 200);
      assert.equal(body.service, 'domos-diagnostics');
      assert.equal(body.status, 'ok');
      healthy = true;
      break;
    } catch (error) {
      if (error.cause?.code !== 'ECONNREFUSED' && error.name !== 'TimeoutError') throw error;
      await delay(100);
    }
  }
  assert.ok(healthy, 'Container did not become healthy.');
  server.kill('SIGTERM');
  const result = await Promise.race([
    stopped,
    delay(10_000).then(() => { throw new Error('Container did not drain after SIGTERM.'); }),
  ]);
  assert.equal(result.code, 0, 'Container must exit cleanly.');
  console.log(`Node ${process.versions.node}: non-root image health and SIGTERM passed.`);
} finally {
  if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL');
}
